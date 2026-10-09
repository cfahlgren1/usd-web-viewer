// The defaults table in SECURITY.md matches the defaults in the code.
// usage: node --test packages/viewer/test/security-doc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '../src/load-core.js';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const bytes = (text) => {
  const [n, unit] = text.split(' ');
  return Number(n) * { MiB: 2 ** 20, GiB: 2 ** 30 }[unit];
};

test('SECURITY.md defaults match the code', () => {
  const rows = new Map([...read('SECURITY.md').matchAll(/^\s*\|(.+)\|$/gm)].map((m) => m[1].split('|').map((cell) => cell.trim().replaceAll('`', ''))));
  const documented = {
    maxLayerBytes: bytes(rows.get('maxLayerBytes')),
    maxLayers: Number(rows.get('maxLayers')),
    maxTextureBytes: bytes(rows.get('maxTextureBytes')),
    maxTriangles: Number(rows.get('maxTriangles').replace(/M$/, '')) * 1e6,
    maxInstances: Number(rows.get('maxInstances').replaceAll(',', '')),
    maxImageSize: Number(rows.get('Image size').replace(/ px per side$/, '')),
  };
  assert.deepEqual(documented, Object.fromEntries(Object.keys(documented).map((key) => [key, DEFAULTS[key]])));

  // The package limits are the Rust side's.
  const [, perFile, perPackage] = rows.get('Packaged zip entries').match(/^(.+) per file, (.+) per package$/);
  const resolver = read('crates/usd-wasm/src/resolver.rs');
  const shifted = (name) => {
    const [, n, shift] = resolver.match(new RegExp(`${name}: u64 = (\\d+) << (\\d+);`));
    return n * 2 ** shift;
  };
  assert.deepEqual([bytes(perFile), bytes(perPackage)], [shifted('MAX_PACKAGED_FILE_BYTES'), shifted('MAX_PACKAGED_TOTAL_BYTES')]);
});
