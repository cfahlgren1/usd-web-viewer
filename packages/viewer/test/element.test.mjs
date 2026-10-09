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
