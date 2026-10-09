import type { LoadProgress, LoadResult, Viewer } from './index.js';

export interface UsdViewerEventMap extends HTMLElementEventMap {
  progress: CustomEvent<LoadProgress>;
  load: CustomEvent<LoadResult>;
  error: CustomEvent<Error>;
}

/**
 * `<usd-viewer src max-texture-size background normal-maps>`.
 * Events: `progress` (detail: LoadProgress), `load` (detail: LoadResult), `error` (detail: Error).
 */
export class UsdViewerElement extends HTMLElement {
  readonly viewer: Viewer | null;
  addEventListener<K extends keyof UsdViewerEventMap>(type: K, listener: (this: UsdViewerElement, event: UsdViewerEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'usd-viewer': UsdViewerElement;
  }
}
