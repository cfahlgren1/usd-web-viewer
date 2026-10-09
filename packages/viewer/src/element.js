// <usd-viewer src="…"> — the viewer as a custom element.
//
//   <script type="module">import 'usd-web-viewer/element';</script>
//   <usd-viewer src="https://huggingface.co/datasets/…/resolve/<sha>/model.usd" alt="A robot gripper"></usd-viewer>
//
// Attributes (and properties): src, textures (`none` | `preview` | `full`),
// max-texture-size (maxTextureSize), alt, touch-action (touchAction).
// Events: progress (detail: LoadProgress), load (detail: LoadInfo; the full
// result is `el.result`), error (an ErrorEvent whose `.error` is a UsdLoadError).
//
// Safe to import where there is no DOM (server rendering): the element is
// only defined in a browser.
import { createViewer, UsdLoadError } from './index.js';

const Base = globalThis.HTMLElement ?? class {};
const ATTRIBUTES = { src: 'src', textures: 'textures', maxTextureSize: 'max-texture-size', alt: 'alt', touchAction: 'touch-action' };

export class UsdViewerElement extends Base {
  static observedAttributes = Object.values(ATTRIBUTES);

  #viewer = null;
  #result = null;
  #abort = null;

  /** The underlying viewer (renderer, scene, camera, controls) while connected. */
  get viewer() {
    return this.#viewer;
  }

  /** The current load result (root, info, complete, dispose), once geometry shows. */
  get result() {
    return this.#result;
  }

  connectedCallback() {
    // Moved within the document: the viewer survived the brief disconnect.
    if (this.#viewer) return;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host{display:block;position:relative;width:100%;height:100%;min-height:200px}div{position:absolute;inset:0}canvas{outline:none}</style><div></div>';
    try {
      this.#viewer = createViewer(root.querySelector('div'));
    } catch (error) {
      this.#fail(error instanceof UsdLoadError ? error : new UsdLoadError('webgl', String(error?.message || error), { cause: error }));
      return;
    }
    this.#applyAccessibility();
    this.#load();
  }

  disconnectedCallback() {
    // Deferred so a move (disconnect then reconnect in one task) keeps the viewer.
    queueMicrotask(() => {
      if (this.isConnected || !this.#viewer) return;
      this.#abort?.abort();
      this.#viewer.dispose();
      this.#viewer = null;
      this.#result = null;
    });
  }

  attributeChangedCallback(name, previous, value) {
    if (!this.#viewer || previous === value) return;
    if (name === 'alt' || name === 'touch-action') this.#applyAccessibility();
    else this.#load();
  }

  #applyAccessibility() {
    const alt = this.getAttribute('alt');
    if (alt) {
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', alt);
    } else {
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
    }
    // OrbitControls sets `none`; `pan-y` lets the page scroll on touch screens.
    this.#viewer.renderer.domElement.style.touchAction = this.getAttribute('touch-action') || 'pan-y';
  }

  async #load() {
    const src = this.getAttribute('src');
    this.#abort?.abort();
    if (!src) {
      this.#result = null;
      this.#viewer.clear();
      return;
    }
    const abort = (this.#abort = new AbortController());
    try {
      const result = await this.#viewer.load(src, {
        textures: ['none', 'preview', 'full'].includes(this.getAttribute('textures')) ? this.getAttribute('textures') : 'preview',
        maxTextureSize: Number(this.getAttribute('max-texture-size')) || 1024,
        signal: abort.signal,
        onProgress: (detail) => this.dispatchEvent(new CustomEvent('progress', { detail })),
      });
      this.#result = result;
      this.dispatchEvent(new CustomEvent('load', { detail: result.info }));
    } catch (error) {
      if (error?.code !== 'aborted') this.#fail(error);
    }
  }

  #fail(error) {
    this.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
  }
}

// Properties reflecting their attributes.
for (const [property, attribute] of Object.entries(ATTRIBUTES)) {
  Object.defineProperty(UsdViewerElement.prototype, property, {
    get() {
      const value = this.getAttribute(attribute);
      return property === 'maxTextureSize' ? Number(value) || 1024 : value ?? (property === 'textures' ? 'preview' : '');
    },
    set(value) {
      if (value == null || value === '') this.removeAttribute(attribute);
      else this.setAttribute(attribute, String(value));
    },
  });
}

if (globalThis.customElements && !customElements.get('usd-viewer')) customElements.define('usd-viewer', UsdViewerElement);
