// The shipped license notices must follow Cargo.lock.
import { test } from 'vitest';
import { execFileSync } from 'node:child_process';

test('THIRD_PARTY_LICENSES covers every crate linked into the WASM module', () => {
  execFileSync('node', [new URL('../scripts/third-party-licenses.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' });
});
