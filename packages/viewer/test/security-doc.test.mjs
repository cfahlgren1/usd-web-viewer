// The defaults table in SECURITY.md matches the defaults in the source.
// usage: node --test packages/viewer/test/security-doc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
/** The first capture of `pattern` in `source`, as a number. */
const number = (source, pattern) => {
  const match = source.match(pattern);
  assert.ok(match, `${pattern} not found`);
  return Number(match[1]);
};
const bytes = (text) => {
  const [n, unit] = text.split(' ');
  return Number(n) * { MiB: 2 ** 20, GiB: 2 ** 30 }[unit];
};

test('SECURITY.md defaults match the code', () => {
  const rows = new Map([...read('SECURITY.md').matchAll(/^\s*\| (.+?) \| (.+?) \|$/gm)].map((m) => [m[1].replaceAll('`', ''), m[2]]));
  const loadCore = read('packages/viewer/src/load-core.js');
  const worker = read('packages/viewer/src/worker.js');
  const resolver = read('crates/usd-wasm/src/resolver.rs');

  assert.equal(bytes(rows.get('maxLayerBytes')), number(loadCore, /maxLayerBytes = (\d+) \* 2 \*\* 20,/) * 2 ** 20);
  assert.equal(Number(rows.get('maxLayers')), number(loadCore, /maxLayers = (\d+),/));
  assert.equal(bytes(rows.get('maxTextureBytes')), number(worker, /maxTextureBytes = (\d+) \* 2 \*\* 20/) * 2 ** 20);
  assert.equal(rows.get('maxTriangles'), `${number(loadCore, /maxTriangles = (\d+)e6/)}M`);
  assert.equal(rows.get('Image size'), `${number(worker, /MAX_IMAGE_SIZE = (\d+);/)} px per side`);

  const [, perFile, perPackage] = rows.get('Packaged zip entries').match(/^(.+) per file, (.+) per package$/);
  const shifted = (name) => {
    const [, n, shift] = resolver.match(new RegExp(`${name}: u64 = (\\d+) << (\\d+);`));
    return n * 2 ** shift;
  };
  assert.equal(bytes(perFile), shifted('MAX_PACKAGED_FILE_BYTES'));
  assert.equal(bytes(perPackage), shifted('MAX_PACKAGED_TOTAL_BYTES'));
});
