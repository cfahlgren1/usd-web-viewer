// The element module must import where there is no DOM (server rendering).
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('importing the element without a DOM neither throws nor defines it', async () => {
  assert.equal(globalThis.HTMLElement, undefined);
  const { UsdViewerElement } = await import('../src/element.js');
  assert.equal(typeof UsdViewerElement, 'function');
  assert.equal(globalThis.customElements, undefined);
});

test('hubUrl validates the repo type and trims the endpoint', async () => {
  const { hubUrl } = await import('../src/hub.js');
  assert.equal(hubUrl('a/b', 'x y.usd', { revision: 'abc123', endpoint: 'https://hf.example/' }), 'https://hf.example/datasets/a/b/resolve/abc123/x%20y.usd');
  assert.equal(hubUrl('a/b', 'm.usd', { repoType: 'model' }), 'https://huggingface.co/a/b/resolve/main/m.usd');
  assert.throws(() => hubUrl('a/b', 'm.usd', { repoType: 'datasets' }), TypeError);
});

test('loadUsd without Web Workers rejects with a worker UsdLoadError', async () => {
  const { loadUsd } = await import('../src/index.js');
  await assert.rejects(loadUsd('https://example.test/a.usda'), { name: 'UsdLoadError', code: 'worker' });
});

test('the textures property reads only texture modes', async () => {
  const { UsdViewerElement } = await import('../src/element.js');
  const textures = Object.getOwnPropertyDescriptor(UsdViewerElement.prototype, 'textures').get;
  const as = (value) => textures.call({ getAttribute: () => value });
  assert.deepEqual([as(null), as('full'), as('bogus')], ['preview', 'full', 'preview']);
});
