import type * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface LoadProgress {
  /** `layers` while fetching layers, `compose` while composing, `textures` while textures stream in. */
  stage: 'layers' | 'compose' | 'textures';
  loaded: number;
  /** Known so far: grows while layer dependencies are discovered. */
  total: number;
  /** Bytes received in this stage. */
  bytes: number;
}

export interface LoadOptions {
  /** Long-side cap for decoded textures, in pixels. Default 1024. */
  maxTextureSize?: number;
  /** Also fetch and apply normal maps. Default false. */
  normalMaps?: boolean;
  /** Fetch layers named inside variants the layer itself doesn't select. Default false. */
  prefetchVariants?: boolean;
  /** Headers for every request (layers and textures), e.g. `{ Authorization: 'Bearer hf_…' }`. */
  headers?: Record<string, string>;
  /** Custom fetch for every request, run on the page (requests are proxied from the worker). */
  fetch?: (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  /** Aborts fetches and the worker; the load rejects with an `AbortError`. */
  signal?: AbortSignal;
  onProgress?: (progress: LoadProgress) => void;
  /** Called after each texture is applied. */
  onTexture?: () => void;
  /** Where the `.wasm` binary is served from. Defaults to the copy next to the package. */
  wasmUrl?: string | URL;
}

export interface LoadStats {
  layers: number;
  layerBytes: number;
  missing: number;
  rounds: number;
  fetchMs: number;
  parseMs: number;
  composeMs: number;
  initMs: number;
  totalMs: number;
  wasmMemoryBytes: number;
}

export interface LoadInfo {
  upAxis: 'Y' | 'Z';
  metersPerUnit: number;
  meshes: number;
  geometries: number;
  triangles: number;
  materials: number;
  materialKinds: Record<string, number>;
  stats: LoadStats;
  /** What could not be shown faithfully: missing layers, unsupported prims, grey fallback materials, failed textures. */
  warnings: string[];
  textureErrors: string[];
}

export interface LoadResult {
  /** Y-up, in meters. */
  root: THREE.Group;
  info: LoadInfo;
  /** Resolves when every texture has streamed in. */
  textures: Promise<void>;
  /** Frees geometries, materials and textures. */
  dispose(): void;
}

export function loadUsd(url: string, options?: LoadOptions): Promise<LoadResult>;

export interface ViewerOptions {
  background?: THREE.ColorRepresentation;
}

export interface Viewer {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  requestRender(): void;
  /** Loads a stage, replacing the current one. Resolves when geometry shows. */
  load(url: string, options?: Omit<LoadOptions, 'onTexture'>): Promise<LoadResult>;
  dispose(): void;
}

export function createViewer(target: HTMLElement | HTMLCanvasElement, options?: ViewerOptions): Promise<Viewer>;

/** Points the camera at the visible bounds of `object`. */
export function frame(camera: THREE.PerspectiveCamera, controls: OrbitControls | undefined, object: THREE.Object3D): void;

/** The URL serving `path` from a Hugging Face Hub repo. */
export function hubUrl(repo: string, path: string, options?: { revision?: string; repoType?: 'dataset' | 'model' | 'space'; endpoint?: string }): string;

/** The root layer of a SimReady package from its file listing and optional `root_usds.json`. */
export function findSimReadyRoot(files: string[], rootUsds?: { entries?: string[] }): string | null;
