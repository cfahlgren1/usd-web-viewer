// Type-level checks of the public typings.
// usage: tsc --noEmit --strict --exactOptionalPropertyTypes --skipLibCheck --module nodenext --target es2022 packages/viewer/test/types.ts
import { UsdLoadError, loadUsd } from '../src/index.js';

const error = new UsdLoadError('fetch', 'missing', { url: 'https://example.test/root.usda', status: 404 });
const code: 'aborted' | 'fetch' | 'compose' | 'worker' | 'webgl' = error.code;

await loadUsd('https://example.test/root.usda', {
  headers: { Authorization: 'Bearer token' },
  fetch: (url, init) => fetch(url, init),
  maxConcurrentFetches: 4,
});
void code;
