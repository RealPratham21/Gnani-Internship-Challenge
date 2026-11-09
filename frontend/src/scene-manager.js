import * as THREE from 'three';

const COMMANDS = new Set(['spawn', 'move', 'scale', 'rotate', 'appearance', 'remove']);

class SceneCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SceneCommandError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SceneCommandError(code, message);
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('INVALID_VALUE', `${label} must be a finite number.`);
  }
  return value;
}

function vector3(value, label, { allowScalar = false } = {}) {
  if (allowScalar && typeof value === 'number') {
    const scalar = finiteNumber(value, label);
    return new THREE.Vector3(scalar, scalar, scalar);
  }
  if (Array.isArray(value) && value.length === 3) {
    return new THREE.Vector3(
      finiteNumber(value[0], `${label}[0]`),
      finiteNumber(value[1], `${label}[1]`),
      finiteNumber(value[2], `${label}[2]`),
    );
  }
  if (value && typeof value === 'object') {
    return new THREE.Vector3(
      finiteNumber(value.x, `${label}.x`),
      finiteNumber(value.y, `${label}.y`),
      finiteNumber(value.z, `${label}.z`),
    );
  }
  fail('INVALID_VALUE', `${label} must be a number, [x, y, z], or {x, y, z}.`);
}

const round = (value) => Number(value.toFixed(4));
const compactVector = (value) => [round(value.x), round(value.y), round(value.z)];

function jsonCopy(value) {
  if (value === undefined) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    fail('INVALID_PROPERTIES', 'Properties must be JSON-serializable.');
  }
}

function normalizeColor(value) {
  const validNumber = typeof value === 'number'
    && Number.isInteger(value) && value >= 0 && value <= 0xffffff;
  const validString = typeof value === 'string'
    && (/^#[\da-f]{3}([\da-f]{3})?$/i.test(value)
      || Object.hasOwn(THREE.Color.NAMES, value.toLowerCase()));
  if (!validNumber && !validString) {
    fail('INVALID_APPEARANCE', 'appearance.color must be a hex color or a named CSS color.');
  }
  return new THREE.Color(value);
}

/** Owns placed objects and commands, independent of WebXR session handling. */
export class SceneManager {
  constructor({ scene, placementProvider = null } = {}) {
    if (!scene?.isScene) throw new TypeError('SceneManager requires a THREE.Scene.');
    this.scene = scene;
    this.placementProvider = placementProvider;
    this.registry = new Map();
    this.factories = new Map();
    this.activeId = null;
    this.nextId = 1;
  }

  registerType(type, factory) {
    if (typeof type !== 'string' || !type.trim() || typeof factory !== 'function') {
      throw new TypeError('registerType requires a non-empty type and a factory function.');
    }
    this.factories.set(type, factory);
    return this;
  }

  setPlacementProvider(provider) {
    if (provider !== null && typeof provider !== 'function') {
      throw new TypeError('Placement provider must be a function or null.');
    }
    this.placementProvider = provider;
  }

  get activeObject() {
    return this.activeId ? this.registry.get(this.activeId)?.object ?? null : null;
  }

  getObject(id) {
    return this.registry.get(id)?.object ?? null;
  }

  select(id) {
    if (!this.registry.has(id)) return false;
    this.activeId = id;
    return true;
  }

  async executeCommands(commands) {
    if (!Array.isArray(commands)) {
      return {
        success: false, executed: 0, succeeded: 0, failed: 1,
        results: [{
          index: -1, action: null, success: false,
          error: { code: 'INVALID_COMMANDS', message: 'executeCommands expects an array of command objects.' },
        }],
        snapshot: this.getSnapshot(),
      };
    }

    const context = { lastId: null };
    const results = [];
    for (let index = 0; index < commands.length; index += 1) {
      // Sequential execution lets later commands target earlier results.
      results.push(await this.#executeCommand(commands[index], index, context));
    }
    const succeeded = results.filter((result) => result.success).length;
    return {
      success: succeeded === results.length,
      executed: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
      snapshot: this.getSnapshot(),
    };
  }

  getSnapshot() {
    return {
      version: '0.3',
      activeId: this.activeId,
      objects: [...this.registry.values()].map((entry) => this.#snapshotEntry(entry)),
    };
  }

  async #executeCommand(command, index, context) {
    const action = command?.action ?? command?.command ?? command?.op ?? null;
    try {
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        fail('INVALID_COMMAND', 'Each command must be an object.');
      }
      if (!COMMANDS.has(action)) fail('UNKNOWN_COMMAND', `Unsupported command: ${String(action)}.`);

      let entry;
      switch (action) {
        case 'spawn': entry = await this.#spawn(command); break;
        case 'move': entry = this.#move(command, context); break;
        case 'scale': entry = this.#scale(command, context); break;
        case 'rotate': entry = this.#rotate(command, context); break;
        case 'appearance': entry = this.#appearance(command, context); break;
        case 'remove': entry = this.#remove(command, context); break;
        default: fail('UNKNOWN_COMMAND', `Unsupported command: ${String(action)}.`);
      }
      context.lastId = entry.id;
      return {
        index, action, success: true, objectId: entry.id,
        object: action === 'remove' ? null : this.#snapshotEntry(entry),
      };
    } catch (error) {
      const known = error instanceof SceneCommandError;
      return {
        index, action, success: false,
        error: {
          code: known ? error.code : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown command failure.',
        },
      };
    }
  }

  async #spawn(command) {
    const { type } = command;
    if (typeof type !== 'string' || !this.factories.has(type)) {
      fail('UNKNOWN_TYPE', `No object factory is registered for type: ${String(type)}.`);
    }
    const id = command.id ?? `${type}-${this.nextId}`;
    if (typeof id !== 'string' || !id.trim()) fail('INVALID_ID', 'spawn.id must be a non-empty string.');
    if (this.registry.has(id)) fail('DUPLICATE_ID', `An object with id "${id}" already exists.`);

    const placement = this.#resolvePlacement(command.at ?? command.placement);
    const transform = command.transform ?? {};
    const scale = transform.scale === undefined
      ? new THREE.Vector3(1, 1, 1)
      : vector3(transform.scale, 'transform.scale', { allowScalar: true });
    if (scale.x <= 0 || scale.y <= 0 || scale.z <= 0) {
      fail('INVALID_VALUE', 'transform.scale components must be greater than zero.');
    }
    const rotation = transform.rotation === undefined
      ? new THREE.Vector3()
      : vector3(transform.rotation, 'transform.rotation');
    const position = transform.position === undefined
      ? null
      : vector3(transform.position, 'transform.position');
    if (command.properties !== undefined
      && (!command.properties || typeof command.properties !== 'object' || Array.isArray(command.properties))) {
      fail('INVALID_PROPERTIES', 'spawn.properties must be a JSON object.');
    }
    const properties = jsonCopy(command.properties);
    if (placement.metadata) properties.placement = jsonCopy(placement.metadata);

    let content;
    try {
      content = await this.factories.get(type)({ id, type, command });
    } catch (error) {
      fail('OBJECT_CREATE_FAILED', error instanceof Error ? error.message : `Could not create ${type}.`);
    }
    if (!content?.isObject3D) {
      fail('OBJECT_CREATE_FAILED', `Factory for ${type} did not return a THREE.Object3D.`);
    }

    const object = new THREE.Group();
    object.name = id;
    object.userData.sceneObjectId = id;
    object.userData.sceneObjectType = type;
    object.position.copy(placement.position);
    object.quaternion.copy(placement.quaternion);
    if (position) object.position.add(position);
    object.rotateX(this.#angle(rotation.x, command.unit ?? transform.unit));
    object.rotateY(this.#angle(rotation.y, command.unit ?? transform.unit));
    object.rotateZ(this.#angle(rotation.z, command.unit ?? transform.unit));
    object.scale.copy(scale);
    object.add(content);

    const entry = { id, type, object, properties };
    if (command.appearance) this.#applyAppearance(entry, command.appearance);
    this.scene.add(object);
    this.registry.set(id, entry);
    this.activeId = id;
    this.nextId += 1;
    return entry;
  }

  #move(command, context) {
    const entry = this.#resolveTarget(command.target, context);
    const hasRelativeValue = command.by !== undefined || command.delta !== undefined;
    const movement = vector3(command.by ?? command.delta ?? command.position ?? command.value, 'move position');
    const relative = command.relative ?? hasRelativeValue;
    if (typeof relative !== 'boolean') fail('INVALID_VALUE', 'move.relative must be a boolean.');
    if (relative) entry.object.position.add(movement);
    else entry.object.position.copy(movement);
    this.activeId = entry.id;
    return entry;
  }

  #scale(command, context) {
    const entry = this.#resolveTarget(command.target, context);
    const hasFactor = command.factor !== undefined;
    const scale = vector3(command.factor ?? command.scale ?? command.value, 'scale value', { allowScalar: true });
    const relative = command.relative ?? hasFactor;
    if (typeof relative !== 'boolean') fail('INVALID_VALUE', 'scale.relative must be a boolean.');
    if (scale.x <= 0 || scale.y <= 0 || scale.z <= 0) {
      fail('INVALID_VALUE', 'Scale components must be greater than zero.');
    }
    if (relative) entry.object.scale.multiply(scale);
    else entry.object.scale.copy(scale);
    this.activeId = entry.id;
    return entry;
  }

  #rotate(command, context) {
    const entry = this.#resolveTarget(command.target, context);
    const hasRelativeValue = command.by !== undefined || command.delta !== undefined;
    const rotation = vector3(command.by ?? command.delta ?? command.rotation ?? command.value, 'rotation');
    const relative = command.relative ?? hasRelativeValue;
    const unit = command.unit ?? 'degrees';
    const euler = new THREE.Euler(
      this.#angle(rotation.x, unit),
      this.#angle(rotation.y, unit),
      this.#angle(rotation.z, unit),
      'XYZ',
    );
    if (typeof relative !== 'boolean') fail('INVALID_VALUE', 'rotate.relative must be a boolean.');
    if (relative) entry.object.quaternion.multiply(new THREE.Quaternion().setFromEuler(euler));
    else entry.object.quaternion.setFromEuler(euler);
    this.activeId = entry.id;
    return entry;
  }

  #appearance(command, context) {
    const entry = this.#resolveTarget(command.target, context);
    this.#applyAppearance(entry, command.appearance ?? command.properties ?? command.value);
    this.activeId = entry.id;
    return entry;
  }

  #remove(command, context) {
    const entry = this.#resolveTarget(command.target, context);
    entry.object.removeFromParent();
    this.registry.delete(entry.id);
    if (this.activeId === entry.id) this.activeId = [...this.registry.keys()].at(-1) ?? null;
    return entry;
  }

  #resolveTarget(target = 'active', context = {}) {
    let id = target;
    if (target === 'active' || target === 'selected' || target == null) id = this.activeId;
    else if (target === 'last' || target === 'lastSpawned') id = context.lastId;
    else if (target === 'latest') id = [...this.registry.keys()].at(-1);
    else if (target && typeof target === 'object') {
      if (target.id) id = target.id;
      else if (target.context) return this.#resolveTarget(target.context, context);
      else if (target.type) {
        const matches = [...this.registry.values()].filter((entry) => entry.type === target.type);
        const match = target.occurrence === 'first' ? matches[0] : matches.at(-1);
        if (!match) fail('TARGET_NOT_FOUND', `Could not resolve target: ${JSON.stringify(target)}.`);
        return match;
      }
    }
    const entry = typeof id === 'string' ? this.registry.get(id) : null;
    if (!entry) fail('TARGET_NOT_FOUND', `Could not resolve target: ${JSON.stringify(target)}.`);
    return entry;
  }

  #resolvePlacement(at) {
    if (at === 'aim' || at === 'reticle') {
      const placement = this.placementProvider?.();
      if (!placement) {
        fail('PLACEMENT_UNAVAILABLE', 'A current tracked camera pose is not available.');
      }
      return this.#normalizePlacement(placement);
    }
    if (at === undefined || at === null || at === 'origin') {
      return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), metadata: null };
    }
    if (at?.isMatrix4) return this.#normalizePlacement(at);
    return {
      position: vector3(at.position ?? at, 'placement'),
      quaternion: new THREE.Quaternion(),
      metadata: at.metadata ? jsonCopy(at.metadata) : null,
    };
  }

  #normalizePlacement(placement) {
    if (placement?.isMatrix4) {
      const position = new THREE.Vector3();
      placement.decompose(position, new THREE.Quaternion(), new THREE.Vector3());
      // Preserve the original behavior: furniture stays upright on placement.
      return { position, quaternion: new THREE.Quaternion(), metadata: null };
    }
    const position = placement.position?.isVector3
      ? placement.position.clone()
      : vector3(placement.position ?? placement, 'placement.position');
    const quaternion = placement.quaternion?.isQuaternion
      ? placement.quaternion.clone()
      : new THREE.Quaternion();
    return {
      position,
      quaternion,
      metadata: placement.metadata ? jsonCopy(placement.metadata) : null,
    };
  }

  #applyAppearance(entry, appearance) {
    if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) {
      fail('INVALID_APPEARANCE', 'appearance must be an object.');
    }
    const allowed = new Set(['color', 'opacity', 'visible', 'wireframe']);
    const unknown = Object.keys(appearance).filter((key) => !allowed.has(key));
    if (unknown.length) {
      fail('INVALID_APPEARANCE', `Unsupported appearance properties: ${unknown.join(', ')}.`);
    }

    const color = appearance.color === undefined ? null : normalizeColor(appearance.color);
    const opacity = appearance.opacity === undefined
      ? null : finiteNumber(appearance.opacity, 'appearance.opacity');
    if (opacity !== null && (opacity < 0 || opacity > 1)) {
      fail('INVALID_APPEARANCE', 'appearance.opacity must be between 0 and 1.');
    }
    if (appearance.visible !== undefined && typeof appearance.visible !== 'boolean') {
      fail('INVALID_APPEARANCE', 'appearance.visible must be a boolean.');
    }
    if (appearance.wireframe !== undefined && typeof appearance.wireframe !== 'boolean') {
      fail('INVALID_APPEARANCE', 'appearance.wireframe must be a boolean.');
    }

    if (appearance.visible !== undefined) entry.object.visible = appearance.visible;
    entry.object.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      if (!child.userData.sceneManagerOwnMaterial) {
        child.material = Array.isArray(child.material)
          ? child.material.map((material) => material.clone())
          : child.material.clone();
        child.userData.sceneManagerOwnMaterial = true;
      }
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (color && material.color) material.color.copy(color);
        if (opacity !== null) {
          material.opacity = opacity;
          material.transparent = opacity < 1;
          material.depthWrite = opacity === 1;
        }
        if (appearance.wireframe !== undefined && 'wireframe' in material) {
          material.wireframe = appearance.wireframe;
        }
        material.needsUpdate = true;
      }
    });
    entry.properties.appearance = {
      ...(entry.properties.appearance ?? {}),
      ...jsonCopy(appearance),
    };
  }

  #angle(value, unit = 'degrees') {
    if (unit !== 'degrees' && unit !== 'radians') {
      fail('INVALID_VALUE', 'Rotation unit must be "degrees" or "radians".');
    }
    return unit === 'degrees' ? THREE.MathUtils.degToRad(value) : value;
  }

  #snapshotEntry(entry) {
    const rotation = new THREE.Euler().setFromQuaternion(entry.object.quaternion, 'XYZ');
    return {
      id: entry.id,
      type: entry.type,
      transform: {
        position: compactVector(entry.object.position),
        rotation: compactVector(rotation),
        scale: compactVector(entry.object.scale),
      },
      properties: jsonCopy(entry.properties),
    };
  }
}

