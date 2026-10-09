// <usd-viewer src="…"> — the viewer as a custom element.
//
//   <script type="module">import 'usd-web-viewer/element';</script>
//   <usd-viewer src="https://huggingface.co/datasets/…/resolve/<sha>/model.usd" alt="A robot gripper"></usd-viewer>
//
// Attributes (and properties): src, textures (`none` | `preview` | `full`),
// max-texture-size (maxTextureSize), alt, touch-action (touchAction),
// loading (`lazy` | `eager`), poster, reveal (`auto` | `interaction`).
// Events: progress (detail: LoadProgress), load (detail: LoadInfo; the full
// result is `el.result`), error (an ErrorEvent whose `.error` is a UsdLoadError),
// context-lost (the model then loads again once the context is restored).
//
// Safe to import where there is no DOM (server rendering): the element is
// only defined in a browser.
import { createViewer, UsdLoadError } from './index.js';
import { DEFAULTS } from './load-core.js';

const Base = globalThis.HTMLElement ?? class {};
const ATTRIBUTES = {
  src: 'src',
  textures: 'textures',
  maxTextureSize: 'max-texture-size',
  alt: 'alt',
  touchAction: 'touch-action',
  loading: 'loading',
  poster: 'poster',
  reveal: 'reveal',
};
// Property values of attributes that are missing or not one of their values.
const READ = {
  textures: (value) => (['none', 'preview', 'full'].includes(value) ? value : DEFAULTS.textures),
  maxTextureSize: (value) => Number(value) || DEFAULTS.maxTextureSize,
  loading: (value) => (value === 'eager' ? 'eager' : 'lazy'),
  reveal: (value) => (value === 'interaction' ? 'interaction' : 'auto'),
};
// A lazy element starts once it is this close to the viewport, and releases
// its viewer (and WebGL context) once this far, so a long page of them keeps
// only those around the screen live.
const NEAR = '50%';
const FAR = '200%';

const STYLE = `
:host{display:block;position:relative;width:100%;height:100%;min-height:200px}
div,img,button{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box}
canvas{outline:none}
canvas:focus-visible,button:focus-visible{outline:2px solid;outline-offset:-2px}
img{object-fit:contain;pointer-events:none;transition:opacity .3s}
img.hidden{opacity:0}
button{border:0;padding:0;background:none;cursor:pointer;font:inherit;color:inherit}
span{display:inline-block;padding:.5em 1em;border-radius:2em;background:#000a;color:#fff}`;

export class UsdViewerElement extends Base {
  static observedAttributes = Object.values(ATTRIBUTES);
  static #nearObserver = null;
  static #farObserver = null;

  #viewer = null;
  #result = null;
  #abort = null;
  #parts = null;
  // Lazy: within NEAR of the viewport. Interaction: the reveal button was used.
  #near = false;
  #revealed = false;
  #broken = false;

  /** The underlying viewer (renderer, scene, camera, controls) while one is live. */
  get viewer() {
    return this.#viewer;
  }

  /** The current load result (root, info, complete, dispose), once geometry shows. */
  get result() {
    return this.#result;
  }

  /** A fresh frame as an image (see `Viewer.toBlob`); rejects while there is no viewer. */
  toBlob(options) {
    return this.#viewer ? this.#viewer.toBlob(options) : Promise.reject(new Error('no viewer to capture: the element has not started (see loading and reveal)'));
  }

  connectedCallback() {
    if (!this.#parts) this.#render();
    UsdViewerElement.#nearObserver ??= new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && e.target.#setNear(true)), { rootMargin: NEAR });
    UsdViewerElement.#farObserver ??= new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting || e.target.#setNear(false)), { rootMargin: FAR });
    UsdViewerElement.#nearObserver.observe(this);
    UsdViewerElement.#farObserver.observe(this);
    this.#update();
  }

  disconnectedCallback() {
    // Deferred so a move (disconnect then reconnect in one task) keeps the viewer.
    queueMicrotask(() => {
      if (this.isConnected) return;
      UsdViewerElement.#nearObserver.unobserve(this);
      UsdViewerElement.#farObserver.unobserve(this);
      this.#near = false;
      this.#broken = false;
      this.#update();
    });
  }

  attributeChangedCallback(name, previous, value) {
    if (!this.#parts || previous === value) return;
    if (name === 'alt' || name === 'touch-action' || name === 'poster') return this.#decorate();
    const live = !!this.#viewer;
    this.#update();
    if (live && this.#viewer && ['src', 'textures', 'max-texture-size'].includes(name)) this.#load();
  }

  #render() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style><div part="viewer"></div><img part="poster" alt=""><button part="reveal" type="button" hidden><span>View in 3D</span></button>`;
    const [viewer, poster, reveal] = root.querySelectorAll('div, img, button');
    this.#parts = { viewer, poster, reveal };
    reveal.addEventListener('click', () => {
      this.#revealed = true;
      this.#update();
      this.#viewer?.renderer.domElement.focus();
    });
    this.#decorate();
  }

  #setNear(near) {
    this.#near = near;
    this.#update();
  }

  /** Starts or releases the viewer, per the attributes and where the element is. */
  #update() {
    const interaction = this.reveal === 'interaction' && !this.#revealed;
    const live = this.isConnected && !!this.getAttribute('src') && (this.loading === 'eager' || this.#near) && !interaction;
    if (live && !this.#viewer && !this.#broken) this.#start();
    if (!live && this.#viewer) this.#release();
    this.#parts.reveal.hidden = !interaction;
  }

  #start() {
    try {
      this.#viewer = createViewer(this.#parts.viewer, {
        onContextLost: () => {
          this.#result = null;
          this.#showPoster(true);
          this.dispatchEvent(new Event('context-lost'));
        },
        onContextRestored: (reload) => reload && this.#track(reload, this.#abort),
      });
    } catch (error) {
      this.#broken = true;
      this.#fail(error instanceof UsdLoadError ? error : new UsdLoadError('webgl', String(error?.message || error), { cause: error }));
      return;
    }
    this.#decorate();
    this.#load();
  }

  #release() {
    this.#abort?.abort();
    this.removeAttribute('aria-busy');
    this.#viewer.dispose();
    this.#viewer = null;
    this.#result = null;
    this.#showPoster(true);
    this.#decorate();
  }

  #decorate() {
    const alt = this.getAttribute('alt') || '3D model';
    const { poster, reveal } = this.#parts;
    const src = this.getAttribute('poster');
    if (src) poster.src = src;
    poster.hidden = !src;
    // The poster speaks for the model only until there is a canvas to.
    poster.alt = this.#viewer ? '' : alt;
    reveal.setAttribute('aria-label', `View in 3D: ${alt}`);
    if (!this.#viewer) return;
    // On the canvas, which takes focus and the keys; not on the host, whose
    // children an `img` role would hide.
    const canvas = this.#viewer.renderer.domElement;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', alt);
    // OrbitControls sets `none`; `pan-y` lets the page scroll on touch screens.
    canvas.style.touchAction = this.getAttribute('touch-action') || 'pan-y';
  }

  #showPoster(shown) {
    this.#parts.poster.classList.toggle('hidden', !shown);
  }

  #load() {
    this.#abort?.abort();
    const abort = (this.#abort = new AbortController());
    const loading = this.#viewer.load(this.getAttribute('src'), {
      textures: this.textures,
      maxTextureSize: this.maxTextureSize,
      signal: abort.signal,
      onProgress: (detail) => {
        if (detail.stage === 'geometry' && detail.loaded === 1) this.#fadePoster(abort);
        this.dispatchEvent(new CustomEvent('progress', { detail }));
      },
    });
    this.#track(loading, abort);
  }

  /** Follows a load of the viewer's (the element's own, or one after a restored context). */
  async #track(loading, abort) {
    this.setAttribute('aria-busy', 'true');
    this.#showPoster(true);
    try {
      const result = await loading;
      this.#result = result;
      this.removeAttribute('aria-busy');
      this.#fadePoster(abort);
      this.dispatchEvent(new CustomEvent('load', { detail: result.info }));
    } catch (error) {
      if (this.#abort === abort) this.removeAttribute('aria-busy');
      if (error?.code !== 'aborted') this.#fail(error);
    }
  }

  /** Fades the poster out after the next frame, which draws the geometry. */
  #fadePoster(abort) {
    requestAnimationFrame(() => abort.signal.aborted || this.#showPoster(false));
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
      return READ[property] ? READ[property](value) : (value ?? '');
    },
    set(value) {
      if (value == null || value === '') this.removeAttribute(attribute);
      else this.setAttribute(attribute, String(value));
    },
  });
}

if (globalThis.customElements && !customElements.get('usd-viewer')) customElements.define('usd-viewer', UsdViewerElement);
