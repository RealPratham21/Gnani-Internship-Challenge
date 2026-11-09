import * as THREE from 'three';

const MIN_DISTANCE = 0.3;
const MAX_DISTANCE = 8;
const MIN_HEIGHT = -2;
const MAX_HEIGHT = 3;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value) => Number(value.toFixed(2));

function assertFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

function copyPreviewMaterials(root, opacity) {
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    child.material = Array.isArray(child.material)
      ? child.material.map((material) => material.clone())
      : child.material.clone();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      material.transparent = true;
      material.opacity = opacity;
      material.depthWrite = false;
      material.needsUpdate = true;
    }
  });
}

/**
 * Resolves an aim pose from camera/surface matrices and owns only the transient
 * preview. It has no dependency on XRFrame, hit-test sources, or session setup.
 */
export class AimPlacementController {
  constructor({
    scene,
    distance = 2,
    height = 0,
    floorSnap = false,
    previewOpacity = 0.36,
  } = {}) {
    if (!scene?.isScene) throw new TypeError('AimPlacementController requires a THREE.Scene.');
    assertFinite(distance, 'distance');
    assertFinite(height, 'height');

    this.scene = scene;
    this.distance = clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
    this.height = clamp(height, MIN_HEIGHT, MAX_HEIGHT);
    this.floorSnap = Boolean(floorSnap);
    this.previewOpacity = clamp(previewOpacity, 0.05, 0.9);
    this.active = false;
    this.tracking = false;
    this.mode = 'inactive';
    this.floorAvailable = false;
    this.preview = null;
    this.currentPosition = null;
  }

  setPreview(object) {
    if (!object?.isObject3D) throw new TypeError('Preview must be a THREE.Object3D.');
    this.clearPreview();
    this.preview = object;
    this.preview.name = 'aim-placement-preview';
    this.preview.visible = false;
    this.preview.userData.isPlacementPreview = true;
    copyPreviewMaterials(this.preview, this.previewOpacity);
    this.scene.add(this.preview);
  }

  clearPreview() {
    this.preview?.removeFromParent();
    this.preview = null;
  }

  setActive(active) {
    this.active = Boolean(active);
    if (!this.active) this.reset('inactive');
  }

  setDistance(value) {
    assertFinite(value, 'distance');
    this.distance = clamp(value, MIN_DISTANCE, MAX_DISTANCE);
    return this.distance;
  }

  adjustDistance(delta) {
    assertFinite(delta, 'distance adjustment');
    return this.setDistance(this.distance + delta);
  }

  setHeight(value) {
    assertFinite(value, 'height');
    this.height = clamp(value, MIN_HEIGHT, MAX_HEIGHT);
    return this.height;
  }

  adjustHeight(delta) {
    assertFinite(delta, 'height adjustment');
    return this.setHeight(this.height + delta);
  }

  setFloorSnap(enabled) {
    this.floorSnap = Boolean(enabled);
    return this.floorSnap;
  }

  update({ cameraMatrix, surfaceMatrix = null, floorY = null } = {}) {
    this.floorAvailable = typeof floorY === 'number' && Number.isFinite(floorY);

    if (!this.active || !cameraMatrix?.isMatrix4) {
      this.reset(this.active ? 'tracking-lost' : 'inactive');
      return this.getState();
    }

    const cameraPosition = new THREE.Vector3();
    const cameraQuaternion = new THREE.Quaternion();
    cameraMatrix.decompose(cameraPosition, cameraQuaternion, new THREE.Vector3());

    let position;
    if (surfaceMatrix?.isMatrix4) {
      position = new THREE.Vector3().setFromMatrixPosition(surfaceMatrix);
      position.y += this.height;
      this.mode = 'surface';
    } else {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuaternion).normalize();
      position = cameraPosition.addScaledVector(forward, this.distance);
      position.y += this.height;
      if (this.floorSnap && this.floorAvailable) position.y = floorY + this.height;
      this.mode = 'estimated';
    }

    this.tracking = true;
    this.currentPosition = position;
    if (this.preview) {
      this.preview.position.copy(position);
      this.preview.quaternion.identity();
      this.preview.visible = true;
    }
    return this.getState();
  }

  reset(mode = 'tracking-lost') {
    this.tracking = false;
    this.mode = mode;
    this.currentPosition = null;
    if (this.preview) this.preview.visible = false;
  }

  getPlacement() {
    if (!this.active || !this.tracking || !this.currentPosition) return null;
    return {
      position: this.currentPosition.clone(),
      quaternion: new THREE.Quaternion(),
      metadata: {
        mode: this.mode,
        confidence: this.mode === 'surface' ? 'confirmed' : 'estimated',
        distance: round(this.distance),
        height: round(this.height),
        floorSnapped: this.mode === 'estimated' && this.floorSnap && this.floorAvailable,
      },
    };
  }

  getState() {
    return {
      active: this.active,
      tracking: this.tracking,
      mode: this.mode,
      distance: round(this.distance),
      height: round(this.height),
      floorSnap: this.floorSnap,
      floorAvailable: this.floorAvailable,
      canPlace: Boolean(this.getPlacement()),
    };
  }
}

