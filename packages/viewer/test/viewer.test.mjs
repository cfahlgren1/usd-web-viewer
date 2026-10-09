// Drives loadUsd with a controlled fake Worker standing in for the WASM worker.
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

class FakeWorker {
  static last = null;
  /** Thrown by the next construction, as a browser does for a cross-origin script. */
  static failNext = null;
  terminated = false;
  received = [];
  constructor() {
    if (FakeWorker.failNext) {
      const error = FakeWorker.failNext;
      FakeWorker.failNext = null;
      throw error;
    }
    FakeWorker.last = this;
  }
  postMessage(request) {
    this.request ??= request;
    this.received.push(request);
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
WebAssembly.compile = async () => ({});
const { loadUsd } = await import('../src/index.js');

const TEXTURE = { path: 'https://example.test/t.png', channel: 'rgb', scale: [1, 1, 1, 1], bias: [0, 0, 0, 0], uvScale: [1, 1], uvRotation: 0, uvTranslation: [0, 0] };

/** The worker's messages for one triangle drawn once with `matrix`, using a material with a color map. */
function sceneMessages(matrix) {
  return [
    {
      type: 'meta',
      meta: {
        upAxis: 'Y',
        metersPerUnit: 1,
        warnings: [],
        geometryCount: 1,
        instances: [{ path: '/M', geometry: 0, material: 0, subsets: {}, doubleSided: false, matrix }],
        materials: [{ path: '/Mat', kind: 'preview', color: [1, 1, 1], emissive: [0, 0, 0], roughness: 0.5, metallic: 0, opacity: 1, opacityThreshold: 0, maps: { diffuseColor: TEXTURE } }],
      },
    },
    {
      type: 'geometry',
      index: 0,
      meta: { groups: [[0, 3]], bounds: [0, 0, 0, 1, 1, 0], uvSets: [], hasColors: false },
      arrays: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: [],
        colors: null,
        indices: new Uint16Array([0, 1, 2]),
      },
    },
    { type: 'scene', stats: { warnings: [] } },
  ];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function load(matrix = IDENTITY) {
  let textures = 0;
  const loading = loadUsd('scene.usda', { onProgress: (p) => p.stage === 'textures' && textures++ });
  await new Promise((resolve) => setTimeout(resolve));
  const worker = FakeWorker.last;
  sceneMessages(matrix).forEach((m) => worker.send(m));
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

test('dispose stops the worker and settles the complete promise', async () => {
  const { worker, complete, dispose } = await load();
  dispose();
  assert.equal(worker.terminated, true);
  const settled = await Promise.race([complete.then(() => true, (e) => e.code === 'aborted'), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);
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

test('abort before geometry rejects with an aborted UsdLoadError and stops the worker', async () => {
  const controller = new AbortController();
  const loading = loadUsd('scene.usda', { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve));
  const worker = FakeWorker.last;
  controller.abort();
  await assert.rejects(loading, { name: 'UsdLoadError', code: 'aborted' });
  assert.equal(worker.terminated, true);
  // A scene that was already on its way is dropped.
  sceneMessages(IDENTITY).forEach((m) => worker.send(m));
});

test('abort after geometry stops textures but leaves the model to its owner', async () => {
  const controller = new AbortController();
  const loading = loadUsd('scene.usda', { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve));
  const worker = FakeWorker.last;
  sceneMessages(IDENTITY).forEach((m) => worker.send(m));
  const { root, complete } = await loading;
  controller.abort();
  assert.equal(worker.terminated, true);
  await assert.rejects(complete, { code: 'aborted' });
  assert.equal(root.children.length, 1);
});

test('a worker error after geometry rejects complete instead of vanishing', async () => {
  const { complete, worker } = await load();
  worker.send({ type: 'error', code: 'compose', message: 'boom' });
  await assert.rejects(complete, { name: 'UsdLoadError', code: 'compose', message: 'boom' });
});

test('complete reports texture counts and failures become warnings', async () => {
  const { complete, worker, info } = await load();
  worker.send({ type: 'texture', path: 'https://example.test/t.png', bitmap: fakeBitmap() });
  worker.send({ type: 'texture', path: 'https://example.test/u.png', error: 'HTTP 404' });
  worker.send({ type: 'done' });
  assert.deepEqual(await complete, { textures: 1, failed: 1 });
  assert.deepEqual(info.warnings, [{ code: 'texture-failed', message: 'HTTP 404', path: 'https://example.test/u.png' }]);
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a load with a custom fetch; the fake worker then asks the page for requests. */
async function proxiedLoad(fetch, options = {}) {
  const controller = new AbortController();
  const loading = loadUsd('https://example.test/scene.usda', { fetch, signal: controller.signal, ...options });
  loading.catch(() => {});
  await tick();
  return { worker: FakeWorker.last, loading, stop: () => controller.abort() };
}

test('caller headers go only to requests on the root origin', { timeout: 3000 }, async () => {
  const seen = [];
  const { worker, stop } = await proxiedLoad(async (url, init) => (seen.push([url, init.headers]), new Response('x')), { headers: { Authorization: 'Bearer t' } });
  worker.send({ type: 'fetch', id: 1, url: 'https://example.test/a.usda' });
  worker.send({ type: 'fetch', id: 2, url: 'https://cdn.other.test/t.png' });
  await tick();
  assert.deepEqual(seen, [
    ['https://example.test/a.usda', { Authorization: 'Bearer t' }],
    ['https://cdn.other.test/t.png', undefined],
  ]);
  stop();
});

test('a proxied body streams to the worker chunk by chunk and stops when it cancels', { timeout: 3000 }, async () => {
  let pulls = 0;
  let cancelled = false;
  const endless = () =>
    new Response(
      new ReadableStream({
        async pull(controller) {
          pulls++;
          await tick();
          controller.enqueue(new Uint8Array(4096));
        },
        cancel: () => void (cancelled = true),
      }),
    );
  const { worker, stop } = await proxiedLoad(async () => endless());
  worker.send({ type: 'fetch', id: 1, url: 'https://example.test/a.usda' });
  await tick(20);
  worker.send({ type: 'pull', id: 1 });
  await tick(20);
  const chunks = worker.received.filter((m) => m.type === 'chunk' && m.id === 1);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk.byteLength, 4096);
  worker.send({ type: 'cancel', id: 1 });
  await tick(20);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3, `read only what the worker asked for (${pulls} pulls)`);
  stop();
});

test('dispose aborts requests still running in the caller fetch', { timeout: 3000 }, async () => {
  let signal;
  const loading = loadUsd('https://example.test/scene.usda', { fetch: (url, init) => ((signal = init.signal), new Promise(() => {})) });
  await tick();
  const worker = FakeWorker.last;
  sceneMessages(IDENTITY).forEach((m) => worker.send(m));
  const result = await loading;
  worker.send({ type: 'fetch', id: 1, url: 'https://example.test/t.png' });
  await tick();
  assert.equal(signal.aborted, false);
  result.dispose();
  assert.equal(signal.aborted, true);
});

test('a worker that cannot be constructed fails with a worker UsdLoadError', { timeout: 3000 }, async () => {
  FakeWorker.failNext = Object.assign(new Error('cross-origin worker script'), { name: 'SecurityError', code: 18 });
  await assert.rejects(loadUsd('scene.usda', { workerUrl: 'https://cdn.other.test/worker.js' }), { name: 'UsdLoadError', code: 'worker' });
});

test('maxConcurrentFetches must be a finite positive integer', { timeout: 3000 }, async () => {
  for (const value of [0, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(loadUsd('scene.usda', { maxConcurrentFetches: value }), RangeError, String(value));
  }
});

test('a material shared by meshes with different UV sets reads the named set on each', async () => {
  const emissive = { ...TEXTURE, uvSet: 'custom' };
  const [meta, geometry, done] = sceneMessages(IDENTITY);
  const uv = () => new Float32Array(6);
  meta.meta.materials[0].maps = { emissiveColor: emissive };
  meta.meta.geometryCount = 2;
  meta.meta.instances = [
    { path: '/WithSt', geometry: 0, material: 0, subsets: {}, doubleSided: false, matrix: IDENTITY },
    { path: '/OnlyCustom', geometry: 1, material: 0, subsets: {}, doubleSided: false, matrix: IDENTITY },
  ];
  const geometryWithSt = { ...geometry, meta: { ...geometry.meta, uvSets: ['st', 'custom'] }, arrays: { ...geometry.arrays, uvs: [uv(), uv()] } };
  const geometryOnlyCustom = { ...geometry, index: 1, meta: { ...geometry.meta, uvSets: ['custom'] }, arrays: { ...geometry.arrays, uvs: [uv()] } };
  const loading = loadUsd('scene.usda');
  await tick();
  const worker = FakeWorker.last;
  [meta, geometryWithSt, geometryOnlyCustom, done].forEach((m) => worker.send(m));
  const { root } = await loading;
  worker.send({ type: 'texture', path: TEXTURE.path, bitmap: fakeBitmap() });
  const [withSt, onlyCustom] = root.children;
  assert.equal(withSt.material.emissiveMap.channel, 1);
  assert.equal(onlyCustom.material.emissiveMap.channel, 0);
});

test('geometry arrays are released once three.js has uploaded them', async () => {
  const { root } = await load();
  const { geometry } = root.children[0];
  const attributes = [geometry.index, ...Object.values(geometry.attributes)];
  // three.js calls this right after copying an attribute to the GPU.
  for (const attribute of attributes) attribute.onUploadCallback();
  assert.ok(attributes.every((attribute) => attribute.array === null));
  // Framing still works from the precomputed bounds.
  assert.ok(!new THREE.Box3().setFromObject(root).isEmpty());
});

test('geometry streams in; the load resolves once every geometry has arrived', async () => {
  const loading = loadUsd('scene.usda');
  await new Promise((resolve) => setTimeout(resolve));
  const worker = FakeWorker.last;
  const [meta, geometry, done] = sceneMessages(IDENTITY);
  worker.send(meta);
  worker.send(geometry);
  const early = await Promise.race([loading.then(() => 'resolved'), new Promise((resolve) => setTimeout(() => resolve('pending'), 20))]);
  assert.equal(early, 'pending');
  worker.send(done);
  const { info, root } = await loading;
  assert.deepEqual([info.meshes, info.geometries, info.triangles, root.children.length], [1, 1, 1, 1]);
});
