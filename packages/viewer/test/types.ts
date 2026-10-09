// Type-level checks of the public typings.
// usage: tsc --noEmit --strict --exactOptionalPropertyTypes --skipLibCheck --module nodenext --target es2022 packages/viewer/test/types.ts
import { UsdLoadError, loadUsd } from '../src/index.js';
import type { UsdViewerElement } from '../src/element.js';

const error = new UsdLoadError('fetch', 'missing', { url: 'https://example.test/root.usda', status: 404 });
const code: 'aborted' | 'fetch' | 'compose' | 'worker' | 'webgl' = error.code;

const result = await loadUsd('https://example.test/root.usda', {
  headers: { Authorization: 'Bearer token' },
  fetch: (url, init) => fetch(url, init),
  maxConcurrentFetches: 4,
  maxLayers: 64,
  maxTextureBytes: 64 * 2 ** 20,
  allowedOrigins: ['https://cdn.example.test'],
});
const upAxis: string = result.info.upAxis;

declare const element: UsdViewerElement;
const textures: 'none' | 'preview' | 'full' = element.textures;
void code;
void upAxis;
void textures;
