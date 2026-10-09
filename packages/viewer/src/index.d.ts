import type * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** `preview` (default): base color up to `maxTextureSize`, roughness / metallic / occlusion / opacity / emissive maps up to 512 px, no normal maps. `full`: every map, normals included, up to `maxTextureSize`. `none`: no textures. */
export type TextureMode = 'none' | 'preview' | 'full';

export type LoadProgress = (
  | { readonly stage: 'layers'; readonly loaded: number; /** Grows while layer dependencies are discovered. */ readonly total: number; readonly bytes: number }
  | { readonly stage: 'compose'; readonly round: number }
  /** Meshes streaming out of the worker; the load resolves once `loaded === total`. */
  | { readonly stage: 'geometry'; readonly loaded: number; readonly total: number }
  | { readonly stage: 'textures'; readonly loaded: number; readonly total: number; readonly bytes: number }
) & {
  /**
   * The whole load, 0 to 1, for a progress bar; it never decreases. Each stage spans a share: `layers` 0–0.4 (`loaded / (total + 1)`,
   * as more layers may yet be found), `compose` 0.45, `geometry` 0.5–0.8 and `textures` 0.8–1 (`loaded / total`). It reaches 1 when the
   * last texture settles, or with the `textures` stage when there are none.
   */
  readonly fraction: number;
};

export interface LoadOptions {
  /** Default `preview`. */
  textures?: TextureMode | undefined;
  /** Long-side cap for decoded textures, in pixels. Default 1024. */
  maxTextureSize?: number | undefined;
  /** Aborts fetches and the worker; the load rejects with a UsdLoadError of code `aborted`. */
  signal?: AbortSignal | undefined;
  /** Sent only with the requests that carry credentials: those to the root URL's origin or, for a root on the Hugging Face Hub, to the root's own repo. For embedding on another site, e.g. `{ Authorization: 'Bearer hf_…' }`. */
  headers?: Record<string, string> | undefined;
  /** Your own fetch for every request the request policy allows (see `allowedOrigins`), run on the page (requests are proxied from the worker). `init.headers` is `headers` where credentials may go and absent elsewhere; `init.credentials` and `init.referrerPolicy` are what the built-in fetch would use; `init.signal` aborts when the load stops. */
  fetch?: ((url: string, init: { headers?: Record<string, string>; credentials: 'same-origin' | 'omit'; referrerPolicy: 'no-referrer'; signal: AbortSignal }) => Promise<Response>) | undefined;
  onProgress?: ((progress: LoadProgress) => void) | undefined;
  /** Where the `.wasm` binary is served from. Defaults to the copy next to the package. */
  wasmUrl?: string | URL | undefined;
  /** Where the worker script is served from. Defaults to the copy next to the package. */
  workerUrl?: string | URL | undefined;
  /** Requests in flight at once, a positive integer (anything else throws a RangeError). Default 16 (textures: at most 4 fetched and decoded at once). */
  maxConcurrentFetches?: number | undefined;
  /** Total bytes of USD layers to fetch before failing with a `fetch` error. Default 768 MiB. */
  maxLayerBytes?: number | undefined;
  /** Layer files to request before failing with a `fetch` error. Default 1024. */
  maxLayers?: number | undefined;
  /**
   * Origins, besides the root URL's, that layers and textures may be fetched from, e.g. `['https://cdn.example.com']`; `['*']` allows any.
   * A root on the Hugging Face Hub also allows the Hub's hosts and CDNs. Every request, a custom `fetch`'s too, also follows these rules:
   * only http(s) URLs without user names; on huggingface.co and hf.co, only repo files (`…/resolve/…`) and tree listings; cookies and
   * `headers` only for the root's origin or, for a Hub root, the root's own repo; no referrer. Only the requested URL is checked, not
   * where it redirects. Anything refused is skipped with a `layer-missing` or `texture-failed` warning.
   */
  allowedOrigins?: readonly string[] | undefined;
  /** Triangles read across all meshes, each geometry counted once however often it is instanced; meshes past it are left out unread with a `triangle-limit` warning. Default 20 million. */
  maxTriangles?: number | undefined;
  /** Total bytes of texture files, read from packages or fetched (counted as they download); textures past it fail with a `texture-failed` warning. Default 512 MiB. Only PNG, JPEG and WebP up to 16384 px a side are decoded; others are refused from their header. */
  maxTextureBytes?: number | undefined;
}

/**
 * - `prim-unsupported`: visible geometry other than meshes and the implicit `Cube` / `Sphere` / `Cylinder` / `Cone` / `Capsule` / `Plane` (e.g. `BasisCurves`, `Points`, `Volume`, Gaussian splats) left out.
 * - `nothing-drawable`: no visible mesh had anything to draw.
 * - `layer-missing`: a layer could not be fetched, or the request policy refused it (see `allowedOrigins`).
 * - `texture-failed`: an image could not be fetched or read, or was refused (by the request policy, past `maxTextureBytes`, larger than 16384 px a side, or not PNG, JPEG or WebP); its inputs show their own (authored or default) values.
 * - `triangle-limit`: meshes left out past `maxTriangles`.
 */
export type WarningCode = 'layer-missing' | 'layer-unreadable' | 'prim-unsupported' | 'nothing-drawable' | 'material-fallback' | 'texture-failed' | 'triangle-limit' | 'composition';

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
  /** As authored, like Pixar's `UsdGeomGetStageUpAxis`: `Y` (default) or `Z`; anything else is drawn as `Y`. */
  readonly upAxis: string;
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

/** A `compose` error whose message starts with `scene too large to load` ran out of WebAssembly memory (4 GiB at most). */
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

/** Rejects with a UsdLoadError of code `worker` where there are no Web Workers (e.g. on a server). */
export function loadUsd(url: string, options?: LoadOptions): Promise<LoadResult>;

export interface ViewerOptions {
  /** Canvas background. Default: transparent. */
  background?: THREE.ColorRepresentation | undefined;
  /** The WebGL context was lost: the stage is gone (its geometry lived only on the GPU) and any load in flight aborted. */
  onContextLost?: (() => void) | undefined;
  /** The context is back: `reload` loads the latest URL again with the same options (null if nothing was loaded). */
  onContextRestored?: ((reload: Promise<LoadResult> | null) => void) | undefined;
}

export interface ToBlobOptions {
  type?: 'image/png' | 'image/webp' | undefined;
  quality?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export interface Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Loads a stage, replacing the current one once its geometry shows. A newer load aborts this one. */
  load(url: string, options?: LoadOptions): Promise<LoadResult>;
  /**
   * Renders a fresh frame and encodes it, e.g. for a thumbnail: `type` `image/png` (default) or `image/webp` (PNG where the browser
   * cannot encode WebP, as Safari), `quality` 0–1 for WebP, and an optional size in pixels (giving one keeps the aspect ratio;
   * default: the canvas's). Rejects when the viewer is disposed or its WebGL context is lost.
   */
  toBlob(options?: ToBlobOptions): Promise<Blob>;
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
