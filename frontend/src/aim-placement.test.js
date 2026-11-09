import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AimPlacementController } from './aim-placement.js';

function matrixAt(x, y, z) {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}

test('estimates placement in front of the tracked camera without a hit test', () => {
  const scene = new THREE.Scene();
  const controller = new AimPlacementController({ scene, distance: 2 });
  controller.setPreview(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  controller.setActive(true);
  const state = controller.update({ cameraMatrix: matrixAt(0, 1.6, 0) });

  assert.equal(state.mode, 'estimated');
  assert.equal(state.canPlace, true);
  assert.deepEqual(controller.getPlacement().position.toArray(), [0, 1.6, -2]);
  assert.equal(controller.preview.visible, true);
  assert.equal(controller.getPlacement().metadata.confidence, 'estimated');
});

test('prefers a confirmed surface pose and applies manual height', () => {
  const controller = new AimPlacementController({ scene: new THREE.Scene(), height: 0.2 });
  controller.setActive(true);
  controller.update({
    cameraMatrix: matrixAt(0, 1.6, 0),
    surfaceMatrix: matrixAt(1, 0, -1.5),
  });

  const placement = controller.getPlacement();
  assert.equal(placement.metadata.mode, 'surface');
  assert.equal(placement.metadata.confidence, 'confirmed');
  assert.deepEqual(placement.position.toArray(), [1, 0.2, -1.5]);
});

test('optionally snaps estimated placement to an available floor reference', () => {
  const controller = new AimPlacementController({
    scene: new THREE.Scene(), distance: 1.5, height: 0.1, floorSnap: true,
  });
  controller.setActive(true);
  controller.update({ cameraMatrix: matrixAt(0, 1.7, 0), floorY: -0.25 });

  const placement = controller.getPlacement();
  assert.equal(placement.position.y, -0.15);
  assert.equal(placement.metadata.floorSnapped, true);
});

test('hides the preview and prevents stale placement during tracking loss or reset', () => {
  const controller = new AimPlacementController({ scene: new THREE.Scene() });
  controller.setPreview(new THREE.Group());
  controller.setActive(true);
  controller.update({ cameraMatrix: matrixAt(0, 1, 0) });
  controller.update({ cameraMatrix: null });

  assert.equal(controller.getState().mode, 'tracking-lost');
  assert.equal(controller.getPlacement(), null);
  assert.equal(controller.preview.visible, false);

  controller.setActive(false);
  assert.equal(controller.getState().mode, 'inactive');
});

