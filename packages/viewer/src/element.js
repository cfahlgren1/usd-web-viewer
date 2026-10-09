// <usd-viewer src="…"> — the viewer as a custom element.
//
//   <script type="module">import 'usd-web-viewer/element';</script>
//   <usd-viewer src="https://huggingface.co/datasets/…/resolve/main/model.usd"></usd-viewer>
//
// Attributes: src, max-texture-size, background, normal-maps.
// Events: progress (detail: progress), load (detail: LoadResult), error (detail: Error).
import { createViewer } from './index.js';

export class UsdViewerElement extends HTMLElement {
  static observedAttributes = ['src', 'max-texture-size', 'background', 'normal-maps'];

  #viewer = null;
  #ready = null;
  #abort = null;

  connectedCallback() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host{display:block;position:relative;width:100%;height:100%;min-height:200px}div{position:absolute;inset:0}</style><div></div>';
    this.#ready = createViewer(root.querySelector('div'), { background: this.getAttribute('background') || undefined });
    this.#ready.then((viewer) => {
      this.#viewer = viewer;
      this.#load();
    });
  }

  disconnectedCallback() {
    this.#abort?.abort();
    this.#ready?.then((viewer) => viewer.dispose());
    this.#viewer = null;
    this.#ready = null;
  }

  attributeChangedCallback(name, previous, value) {
    if (!this.#viewer || previous === value) return;
    if (name !== 'background') return this.#load();
    this.#viewer.scene.background.set(value || 0xf2f2f2);
    this.#viewer.requestRender();
  }

  /** The underlying viewer (renderer, scene, camera, controls), once created. */
  get viewer() {
    return this.#viewer;
  }

  async #load() {
    const src = this.getAttribute('src');
    this.#abort?.abort();
    if (!src) return;
    const abort = (this.#abort = new AbortController());
    try {
      const result = await this.#viewer.load(src, {
        maxTextureSize: Number(this.getAttribute('max-texture-size')) || 1024,
        normalMaps: this.hasAttribute('normal-maps'),
        signal: abort.signal,
        onProgress: (detail) => this.dispatchEvent(new CustomEvent('progress', { detail })),
      });
      this.dispatchEvent(new CustomEvent('load', { detail: result }));
    } catch (error) {
      if (error?.name !== 'AbortError') this.dispatchEvent(new CustomEvent('error', { detail: error }));
    }
  }
}

if (!customElements.get('usd-viewer')) customElements.define('usd-viewer', UsdViewerElement);
