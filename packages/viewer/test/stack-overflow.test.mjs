// Its own file: a trap leaves the WASM instance unusable for later tests.
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, lastPanic, UsdLoader } from '../wasm/usd_wasm.js';
import { composeStage, loadFailure } from '../src/load-core.js';

const exports = initSync({ module: readFileSync(new URL('../wasm/usd_wasm_bg.wasm', import.meta.url)) });

test('layers nested too deeply fail as a compose error, not a bare trap', async () => {
  const depth = 100000;
  const usda = '#usda 1.0\n' + 'def Xform "A" {\n'.repeat(depth) + '}\n'.repeat(depth);
  const fetchBytes = async () => new TextEncoder().encode(usda);
  const error = await composeStage({ UsdLoader, fetchBytes, rootUrl: 'https://h/deep.usda' }).then(
    () => null,
    (e) => e,
  );
  assert.ok(error, 'the load fails');
  const failure = loadFailure(error, exports.memory.buffer.byteLength, lastPanic);
  assert.equal(failure.code, 'compose');
  assert.match(failure.message, /^stack overflow: the layers nest too deeply to read/);
});
