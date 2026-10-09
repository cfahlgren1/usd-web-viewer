// Type-level checks of the public typings.
// usage: npm run check:types
import { UsdLoadError, loadUsd } from '../src/index.js';
import type { UsdViewerElement } from '../src/element.js';

const error = new UsdLoadError('fetch', 'missing', { url: 'https://example.test/root.usda', status: 404 });
const code: 'aborted' | 'fetch' | 'compose' | 'worker' | 'webgl' = error.code;

const result = await loadUsd('https://example.test/root.usda', {
  headers: { Authorization: 'Bearer token' },
  fetch: (url, init) => fetch(url, init),
  maxConcurrentFetches: 4,
  maxLayers: 64,
  maxTriangles: 1e6,
  maxInstances: 1000,
  maxTextureBytes: 64 * 2 ** 20,
  allowedOrigins: ['https://cdn.example.test'],
});
const upAxis: string = result.info.upAxis;

await loadUsd('https://example.test/root.usda', { onProgress: (p) => void (p.fraction + (p.stage === 'compose' ? p.round : p.loaded)) });

declare const element: UsdViewerElement;
const textures: 'none' | 'preview' | 'full' = element.textures;
const loading: 'lazy' | 'eager' = element.loading;
const thumbnail: Promise<Blob> = element.toBlob({ width: 128, height: 128 });
element.addEventListener('context-lost', (event: Event) => void event);
void loading;
void thumbnail;
void code;
void upAxis;
void textures;
