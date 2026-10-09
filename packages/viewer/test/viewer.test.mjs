// Drives loadUsd with a controlled fake Worker standing in for the WASM worker.
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

class FakeWorker {
  static last = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(request) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  /** Delivers a message as if the worker posted it. */
  send(data) {
    this.onmessage({ data });
  }
}

globalThis.location = { href: 'https://example.test/' };
globalThis.Worker = FakeWorker;
globalThis.fetch = async () => new Response(new Uint8Array());
WebAssembly.compileStreaming = async () => ({});
const { loadUsd } = await import('../src/index.js');

/** One triangle drawn once with `matrix`, using a material with a color map. */
function sceneMessage(matrix) {
  return {
    type: 'scene',
    stats: {},
    meta: {
      upAxis: 'Y',
      metersPerUnit: 1,
      stats: { triangles: 1 },
      geometries: [{ groups: [[0, 3]], bounds: [0, 0, 0, 1, 1, 0] }],
      instances: [{ path: '/M', geometry: 0, materials: [0], doubleSided: false, matrix }],
      materials: [{ path: '/Mat', kind: 'preview', color: [1, 1, 1], emissive: [0, 0, 0], roughness: 0.5, metallic: 0, opacity: 1, colorMap: { path: 'https://example.test/t.png' } }],
    },
    geometries: [
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: null,
        indices: new Uint16Array([0, 1, 2]),
      },
    ],
  };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function load(matrix = IDENTITY) {
  let textures = 0;
  const loading = loadUsd('scene.usda', { onTexture: () => textures++ });
  await new Promise((resolve) => setTimeout(resolve));
  const worker = FakeWorker.last;
  worker.send(sceneMessage(matrix));
  const result = await loading;
  return { ...result, worker, textureCount: () => textures };
}

const fakeBitmap = () => ({ width: 4, height: 4, closed: false, close() { this.closed = true; } });

test('a rotated child under a non-uniformly scaled parent keeps its shear', async () => {
  // USD row vectors: rotate 45 degrees about Z, then scale x by 2.
  const c = Math.SQRT1_2;
  const matrix = [2 * c, c, 0, 0, -2 * c, c, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
  const { root } = await load(matrix);
  // Framing measures a freshly loaded root, before any render updates it.
  const box = new THREE.Box3().setFromObject(root);
  assert.ok(Math.abs(box.max.x - (1 + 2 * c)) < 1e-6, `bounds follow the drawn matrix (${box.max.x})`);
  root.updateMatrixWorld(true);
  const mesh = root.children[0];
  mesh.matrixWorld.elements.forEach((v, i) => assert.ok(Math.abs(v - matrix[i]) < 1e-9, `element ${i}: ${v} vs ${matrix[i]}`));
});

test('dispose stops the worker and settles the textures promise', async () => {
  const { worker, textures, dispose } = await load();
  dispose();
  assert.equal(worker.terminated, true);
  const settled = await Promise.race([textures.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);
  assert.equal(settled, true);
});

test('a texture arriving after dispose is closed, not applied', async () => {
  const { root, worker, dispose, textureCount } = await load();
  dispose();
  const bitmap = fakeBitmap();
  worker.send({ type: 'texture', path: 'https://example.test/t.png', bitmap });
  assert.equal(bitmap.closed, true);
  assert.equal(root.children[0].material.map, null);
  assert.equal(textureCount(), 0);
});

test('geometry bounds come from the worker, so framing does not rescan positions', async () => {
  const { root } = await load();
  const { geometry } = root.children[0];
  assert.deepEqual(geometry.boundingBox, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 0)));
  assert.deepEqual(geometry.boundingSphere.center, new THREE.Vector3(0.5, 0.5, 0));
  assert.ok(geometry.boundingSphere.radius >= Math.SQRT1_2);
});
