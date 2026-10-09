import type { LoadInfo, LoadProgress, LoadResult, TextureMode, UsdLoadError, Viewer } from './index.js';

export interface UsdViewerErrorEvent extends ErrorEvent {
  readonly error: UsdLoadError;
}

export interface UsdViewerEventMap extends Omit<HTMLElementEventMap, 'progress' | 'load' | 'error'> {
  progress: CustomEvent<LoadProgress>;
  load: CustomEvent<LoadInfo>;
  error: UsdViewerErrorEvent;
}

/**
 * `<usd-viewer src textures max-texture-size alt touch-action>`.
 * Before it is defined, give it a size: `usd-viewer:not(:defined) { display: block; min-height: 200px }`.
 */
export class UsdViewerElement extends HTMLElement {
  src: string;
  textures: TextureMode;
  maxTextureSize: number;
  /** Accessible description: the `aria-label` of the canvas (`role="img"`), `3D model` when absent. The element is `aria-busy` while loading; the focused canvas pans with the arrow keys and zooms with + / -. */
  alt: string;
  /** Applied to the canvas. Default `pan-y`, so the page scrolls on touch screens. */
  touchAction: string;
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
