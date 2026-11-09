import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager } from './scene-manager.js';

function createManager() {
  const scene = new THREE.Scene();
  const manager = new SceneManager({
    scene,
    placementProvider: () => ({ position: new THREE.Vector3(1, 0, 2) }),
  });
  manager.registerType('sofa', () => new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  ));
  return { scene, manager };
}

test('executes a contextual command sequence and returns a compact snapshot', async () => {
  const { manager } = createManager();
  const execution = await manager.executeCommands([
    { action: 'spawn', type: 'sofa', id: 'sofa-main', at: 'reticle' },
    { action: 'scale', target: 'last', factor: 1.25 },
    { action: 'rotate', target: 'last', by: [0, 90, 0], unit: 'degrees' },
    { action: 'appearance', target: 'last', appearance: { color: '#336699' } },
    { action: 'move', target: 'last', by: [0.5, 0, -0.25] },
  ]);
  assert.equal(execution.success, true);
  assert.equal(execution.succeeded, 5);
  assert.equal(execution.snapshot.activeId, 'sofa-main');
  assert.deepEqual(execution.snapshot.objects[0].transform.position, [1.5, 0, 1.75]);
  assert.deepEqual(execution.snapshot.objects[0].transform.scale, [1.25, 1.25, 1.25]);
  assert.equal(execution.snapshot.objects[0].properties.appearance.color, '#336699');
  assert.doesNotThrow(() => JSON.stringify(execution.snapshot));
});

test('reports failures and continues with later commands', async () => {
  const { manager } = createManager();
  const execution = await manager.executeCommands([
    { action: 'spawn', type: 'unknown', at: 'reticle' },
    { action: 'spawn', type: 'sofa', id: 'recovered', at: 'origin' },
    { action: 'move', target: 'missing', by: [1, 0, 0] },
    { action: 'scale', target: 'active', scale: 2 },
  ]);
  assert.equal(execution.success, false);
  assert.equal(execution.succeeded, 2);
  assert.equal(execution.failed, 2);
  assert.equal(execution.results[0].error.code, 'UNKNOWN_TYPE');
  assert.equal(execution.results[2].error.code, 'TARGET_NOT_FOUND');
  assert.deepEqual(execution.snapshot.objects[0].transform.scale, [2, 2, 2]);
});

test('removes the active object from registry and scene', async () => {
  const { scene, manager } = createManager();
  await manager.executeCommands([{ action: 'spawn', type: 'sofa', id: 'temporary' }]);
  const object = manager.getObject('temporary');
  const execution = await manager.executeCommands([{ action: 'remove', target: 'active' }]);
  assert.equal(execution.success, true);
  assert.equal(manager.getObject('temporary'), null);
  assert.equal(scene.children.includes(object), false);
  assert.equal(execution.snapshot.activeId, null);
  assert.deepEqual(execution.snapshot.objects, []);
});

test('records aim-placement confidence in the scene snapshot', async () => {
  const scene = new THREE.Scene();
  const manager = new SceneManager({
    scene,
    placementProvider: () => ({
      position: new THREE.Vector3(0, 1, -2),
      metadata: { mode: 'estimated', confidence: 'estimated' },
    }),
  });
  manager.registerType('sofa', () => new THREE.Group());

  const execution = await manager.executeCommands([
    { action: 'spawn', type: 'sofa', at: 'aim' },
  ]);

  assert.equal(execution.success, true);
  assert.deepEqual(execution.snapshot.objects[0].properties.placement, {
    mode: 'estimated',
    confidence: 'estimated',
  });
});

