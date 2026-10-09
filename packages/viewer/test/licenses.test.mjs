// The shipped license notices must follow Cargo.lock.
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('THIRD_PARTY_LICENSES covers every crate linked into the WASM module', () => {
  execFileSync('node', [new URL('../../../scripts/third-party-licenses.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' });
});
