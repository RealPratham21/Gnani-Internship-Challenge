import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DEFAULT_TARGET_METRES = 1.2;
const MAX_DIMENSION_METRES = 4;

/**
 * Loads GLB/GLTF models and normalizes scale/orientation so furniture sits
 * upright on the floor with a predictable real-world footprint.
 */
function boundFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('AssetLoader requires a fetch implementation.');
  }
  // Calling window.fetch as a method of another object throws Illegal invocation.
  return (...args) => fetchImpl(...args);
}

export class AssetLoader {
  constructor({ loader = new GLTFLoader(), fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.loader = loader;
    this.fetchImpl = boundFetch(fetchImpl);
    this.templates = new Map();
  }

  async resolveAsset(query, requestId) {
    const response = await this.fetchImpl('/api/assets/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, request_id: requestId }),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const detail = body?.detail;
      const message = detail?.message ?? (typeof detail === 'string' ? detail : null)
        ?? `Asset resolve failed (${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      error.stage = 'asset';
      throw error;
    }
    if (!body?.model_url || !body?.id) {
      throw new Error('Asset resolver returned an incomplete payload.');
    }
    return body;
  }

  async loadTemplate(asset) {
    const cacheKey = `${asset.id}:${asset.model_url}`;
    if (this.templates.has(cacheKey)) {
      return this.templates.get(cacheKey).clone(true);
    }

    const gltf = await this.loader.loadAsync(asset.model_url);
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) throw new Error(`Model "${asset.name}" did not contain a scene.`);

    const normalized = this.normalizeModel(root, asset.dimensions_mm);
    this.templates.set(cacheKey, normalized);
    return normalized.clone(true);
  }

  normalizeModel(object, dimensionsMm = null) {
    const model = object.clone(true);
    model.updateMatrixWorld(true);

    // Drop any authoring-time transforms before fitting.
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    model.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(model);
    if (bounds.isEmpty()) throw new Error('Model bounds are empty.');
    const size = bounds.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    if (!(longest > 0)) throw new Error('Model has zero size.');

    let target = DEFAULT_TARGET_METRES;
    if (Array.isArray(dimensionsMm) && dimensionsMm.length === 3) {
      const metres = dimensionsMm.map((value) => Number(value) / 1000);
      if (metres.every((value) => Number.isFinite(value) && value > 0)) {
        target = Math.min(MAX_DIMENSION_METRES, Math.max(...metres));
      }
    }

    const scale = Math.min(MAX_DIMENSION_METRES / longest, target / Math.max(size.x, size.z, 1e-6));
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);

    const fitted = new THREE.Box3().setFromObject(model);
    const center = fitted.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= fitted.min.y;
    model.updateMatrixWorld(true);
    return model;
  }

  clearCache() {
    this.templates.clear();
  }
}
