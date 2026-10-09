import type * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** `preview` (default): base color up to `maxTextureSize`, roughness / metallic / occlusion / opacity / emissive maps up to 512 px, no normal maps. `full`: every map, normals included, up to `maxTextureSize`. `none`: no textures. */
export type TextureMode = 'none' | 'preview' | 'full';

export type LoadProgress =
  | { readonly stage: 'layers'; readonly loaded: number; /** Grows while layer dependencies are discovered. */ readonly total: number; readonly bytes: number }
  | { readonly stage: 'compose'; readonly round: number }
  | { readonly stage: 'textures'; readonly loaded: number; readonly total: number; readonly bytes: number };

export interface LoadOptions {
  /** Default `preview`. */
  textures?: TextureMode | undefined;
  /** Long-side cap for decoded textures, in pixels. Default 1024. */
  maxTextureSize?: number | undefined;
  /** Aborts fetches and the worker; the load rejects with a UsdLoadError of code `aborted`. */
  signal?: AbortSignal | undefined;
  /** Sent with layer and texture requests to the root URL's origin only. For embedding on another site, e.g. `{ Authorization: 'Bearer hf_…' }`. */
  headers?: Record<string, string> | undefined;
  /** Your own fetch for every request, run on the page (requests are proxied from the worker). `init.headers` is `headers` for the root URL's origin and absent elsewhere; `init.signal` aborts when the load stops. */
  fetch?: ((url: string, init: { headers?: Record<string, string>; signal: AbortSignal }) => Promise<Response>) | undefined;
  onProgress?: ((progress: LoadProgress) => void) | undefined;
  /** Where the `.wasm` binary is served from. Defaults to the copy next to the package. */
  wasmUrl?: string | URL | undefined;
  /** Where the worker script is served from. Defaults to the copy next to the package. */
  workerUrl?: string | URL | undefined;
  /** Requests in flight at once, a positive integer (anything else throws a RangeError). Default 16 (textures: at most 4 fetched and decoded at once). */
  maxConcurrentFetches?: number | undefined;
  /** Total bytes of USD layers to fetch before failing with a `fetch` error. Default 1 GiB. */
  maxLayerBytes?: number | undefined;
}

export type WarningCode = 'layer-missing' | 'layer-unreadable' | 'prim-unsupported' | 'material-fallback' | 'texture-failed' | 'composition';

export interface LoadWarning {
  readonly code: WarningCode;
  readonly message: string;
  /** The layer URL, texture path or an example prim / material path. */
  readonly path?: string | undefined;
}

export type MaterialKind = 'preview' | 'omnipbr' | 'gltf-pbr' | 'displayColor' | 'fallback';

export interface LoadStats {
  readonly layers: number;
  readonly layerBytes: number;
  readonly missing: number;
  readonly rounds: number;
  readonly fetchMs: number;
  readonly parseMs: number;
  readonly composeMs: number;
  readonly initMs: number;
  readonly totalMs: number;
  readonly wasmMemoryBytes: number;
}

export interface LoadInfo {
  readonly upAxis: 'Y' | 'Z';
  readonly metersPerUnit: number;
  readonly meshes: number;
  readonly geometries: number;
  readonly triangles: number;
  readonly materials: number;
  readonly materialKinds: Readonly<Partial<Record<MaterialKind, number>>>;
  readonly stats: LoadStats;
  /** What could not be shown faithfully. Grows (texture failures) until `complete` settles. */
  readonly warnings: readonly LoadWarning[];
}

export interface LoadResult {
  /** Y-up, in meters. */
  readonly root: THREE.Group;
  readonly info: LoadInfo;
  /** Settles when textures have streamed in; rejects with a UsdLoadError if the load is aborted, disposed or the worker dies. */
  readonly complete: Promise<{ textures: number; failed: number }>;
  /** Frees geometries, materials and textures and stops any textures still streaming. */
  dispose(): void;
}

export type UsdLoadErrorCode = 'aborted' | 'fetch' | 'compose' | 'worker' | 'webgl';

export class UsdLoadError extends Error {
  constructor(code: UsdLoadErrorCode, message: string, details?: { url?: string | undefined; status?: number | undefined; cause?: unknown });
  readonly name: 'UsdLoadError';
  readonly code: UsdLoadErrorCode;
  /** The URL that failed, when there is one. */
  readonly url?: string | undefined;
  /** HTTP status of a failed root layer fetch: 401 / 403 for gated or private repos, 404 when missing. */
  readonly status?: number | undefined;
}

export function loadUsd(url: string, options?: LoadOptions): Promise<LoadResult>;

export interface ViewerOptions {
  /** Canvas background. Default: transparent. */
  background?: THREE.ColorRepresentation | undefined;
}

export interface Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Loads a stage, replacing the current one once its geometry shows. A newer load aborts this one. */
  load(url: string, options?: LoadOptions): Promise<LoadResult>;
  /** Removes and frees the current stage. */
  clear(): void;
  /** Points the camera at `object`, by default the current stage. */
  frame(object?: THREE.Object3D): void;
  requestRender(): void;
  /** Frees the renderer, the GPU context, the current stage and any load in flight. Safe to call twice. */
  dispose(): void;
}

/** Throws a UsdLoadError of code `webgl` when WebGL is unavailable. */
export function createViewer(target: HTMLElement | HTMLCanvasElement, options?: ViewerOptions): Viewer;

/** Points the camera at the visible bounds of `object`. */
export function frame(camera: THREE.PerspectiveCamera, controls: OrbitControls | undefined, object: THREE.Object3D): void;
