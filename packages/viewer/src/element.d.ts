import type { LoadInfo, LoadProgress, LoadResult, TextureMode, UsdLoadError, Viewer } from './index.js';

export interface UsdViewerErrorEvent extends ErrorEvent {
  readonly error: UsdLoadError;
}

export interface UsdViewerEventMap extends Omit<HTMLElementEventMap, 'progress' | 'load' | 'error'> {
  progress: CustomEvent<LoadProgress>;
  load: CustomEvent<LoadInfo>;
  error: UsdViewerErrorEvent;
  /** The WebGL context was lost: the poster shows, `result` is null, and once the context is restored the model loads again (another `load`). */
  'context-lost': Event;
}

/**
 * `<usd-viewer src textures max-texture-size alt touch-action loading poster reveal>`.
 * Before it is defined, give it a size: `usd-viewer:not(:defined) { display: block; min-height: 200px }`.
 * The shadow parts `viewer`, `poster` and `reveal` (the button) can be styled with `::part()`.
 */
export class UsdViewerElement extends HTMLElement {
  /** Nothing is created (no worker, WASM or WebGL context) without one. */
  src: string;
  /** Reads `preview` when the attribute is missing or not a TextureMode. */
  textures: TextureMode;
  maxTextureSize: number;
  /** Accessible description: the `aria-label` of the canvas (`role="img"`), `3D model` when absent. The element is `aria-busy` while loading; the focused canvas pans with the arrow keys and zooms with + / -. */
  alt: string;
  /** Applied to the canvas. Default `pan-y`, so the page scrolls on touch screens. */
  touchAction: string;
  /** `lazy` (default): the viewer (worker, WASM, WebGL context) starts once the element is within half a viewport of the screen, and is released (and loads again on return) once it is two viewports away. `eager`: starts right away and stays. */
  loading: 'lazy' | 'eager';
  /** An image shown until the model's first geometry is drawn, then cross-faded out; shown again while there is no viewer. */
  poster: string;
  /** `auto` (default). `interaction`: nothing loads until the reveal button over the poster is clicked, tapped or activated from the keyboard. */
  reveal: 'auto' | 'interaction';
  /** Null until a viewer starts (see `loading` and `reveal`). */
  readonly viewer: Viewer | null;
  readonly result: LoadResult | null;
  addEventListener<K extends keyof UsdViewerEventMap>(type: K, listener: (this: UsdViewerElement, event: UsdViewerEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'usd-viewer': UsdViewerElement;
  }
}
