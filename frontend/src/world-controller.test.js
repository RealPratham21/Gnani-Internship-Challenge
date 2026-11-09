import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager } from './scene-manager.js';
import { WorldController } from './world-controller.js';

function createHarness({ resolveAsset, loadTemplate } = {}) {
  const scene = new THREE.Scene();
  const aimPlacement = {
    preview: null,
    setPreview(object) { this.preview = object; },
    clearPreview() { this.preview = null; },
  };
  const sceneManager = new SceneManager({
    scene,
    placementProvider: () => ({ position: new THREE.Vector3(0, 0, -2) }),
  });
  const templates = {
    table: (() => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 1), new THREE.MeshBasicMaterial());
      mesh.name = 'table-template';
      return mesh;
    })(),
    chair: (() => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.5), new THREE.MeshBasicMaterial());
      mesh.name = 'chair-template';
      return mesh;
    })(),
  };
  const assetLoader = {
    resolveAsset: resolveAsset ?? (async (query) => ({
      id: `asset_${query}`,
      name: query,
      query,
      provider: 'Poly Haven',
      license: 'CC0',
      source_url: `https://polyhaven.com/a/${query}`,
      model_url: `/api/assets/files/${query}/model.gltf`,
      format: 'gltf',
      dimensions_mm: [1000, 500, 1000],
      cache_hit: false,
      total_bytes: 1000,
    })),
    loadTemplate: loadTemplate ?? (async (asset) => (templates[asset.query] || templates.table).clone(true)),
  };
  const events = [];
  const world = new WorldController({
    sceneManager,
    aimPlacement,
    assetLoader,
    reportEvent: async (event) => { events.push(event); },
  });
  return { world, sceneManager, aimPlacement, events, templates };
}

test('multi-turn request then place keeps preview until placement', async () => {
  const { world, aimPlacement, sceneManager } = createHarness();
  const request = await world.executePlan(
    [{ action: 'request_asset', query: 'table', place: false }],
    { requestId: 'req-table' },
  );
  assert.equal(request.success, true);
  assert.equal(world.getWorldState().status, 'awaiting_placement');
  assert.ok(aimPlacement.preview);
  assert.equal(sceneManager.getSnapshot().objects.length, 0);

  const placed = await world.executePlan(
    [{ action: 'place_pending', at: 'aim' }],
    { requestId: 'req-place' },
  );
  assert.equal(placed.success, true);
  assert.equal(world.getWorldState().status, 'placed');
  assert.equal(aimPlacement.preview, null);
  assert.equal(sceneManager.getSnapshot().objects.length, 1);
});

test('one-shot place=true spawns immediately without lingering preview', async () => {
  const { world, aimPlacement, sceneManager } = createHarness();
  const execution = await world.executePlan(
    [{ action: 'request_asset', query: 'chair', place: true }],
    { requestId: 'req-chair' },
  );
  assert.equal(execution.success, true);
  assert.equal(world.getWorldState().status, 'placed');
  assert.equal(aimPlacement.preview, null);
  assert.equal(sceneManager.getSnapshot().objects[0].properties.assetName, 'chair');
});

test('changing pending selection replaces the preview', async () => {
  const { world, aimPlacement } = createHarness();
  await world.executePlan(
    [{ action: 'request_asset', query: 'table', place: false }],
    { requestId: 'req-1' },
  );
  const firstPreview = aimPlacement.preview;
  await world.executePlan(
    [{ action: 'request_asset', query: 'chair', place: false }],
    { requestId: 'req-2' },
  );
  assert.notEqual(aimPlacement.preview, firstPreview);
  assert.equal(world.getWorldState().pending.query, 'chair');
});

test('cancel clears pending preview and returns to idle', async () => {
  const { world, aimPlacement } = createHarness();
  await world.executePlan(
    [{ action: 'request_asset', query: 'table', place: false }],
    { requestId: 'req-1' },
  );
  const cancelled = await world.executePlan(
    [{ action: 'cancel_pending' }],
    { requestId: 'req-2' },
  );
  assert.equal(cancelled.success, true);
  assert.equal(world.getWorldState().status, 'idle');
  assert.equal(aimPlacement.preview, null);
});

test('failed asset resolve recovers into an error state without spawning', async () => {
  const { world, sceneManager } = createHarness({
    resolveAsset: async () => {
      throw new Error('Download exploded.');
    },
  });
  const execution = await world.executePlan(
    [{ action: 'request_asset', query: 'table', place: false }],
    { requestId: 'req-fail' },
  );
  assert.equal(execution.success, false);
  assert.equal(world.getWorldState().status, 'error');
  assert.equal(sceneManager.getSnapshot().objects.length, 0);
});

test('compound request_asset place + appearance runs against the placed object', async () => {
  const { world, sceneManager } = createHarness();
  const execution = await world.executePlan([
    { action: 'request_asset', query: 'table', place: true },
    { action: 'appearance', target: 'last', appearance: { color: 'blue' } },
  ], { requestId: 'req-compound' });
  assert.equal(execution.success, true);
  assert.equal(execution.succeeded, 2);
  assert.equal(sceneManager.getSnapshot().objects[0].properties.appearance.color, 'blue');
});
