// <usd-viewer src="…"> — the viewer as a custom element.
//
//   <script type="module">import 'usd-web-viewer/element';</script>
//   <usd-viewer src="https://huggingface.co/datasets/…/resolve/<sha>/model.usd" alt="A robot gripper"></usd-viewer>
//
// Attributes (and properties): src, textures (`none` | `preview` | `full`),
// max-texture-size (maxTextureSize), alt, touch-action (touchAction),
// loading (`lazy` | `eager`), poster, reveal (`auto` | `interaction`).
// Events: progress (detail: LoadProgress), load (detail: LoadInfo; the full
// result is `el.result`), error (an ErrorEvent whose `.error` is a UsdLoadError).
//
// Safe to import where there is no DOM (server rendering): the element is
// only defined in a browser.
import { createViewer, UsdLoadError } from './index.js';

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
const textureMode = (value) => (['none', 'preview', 'full'].includes(value) ? value : 'preview');
// Property values of attributes that are missing or not one of their values.
const READ = {
  textures: textureMode,
  maxTextureSize: (value) => Number(value) || 1024,
  loading: (value) => (value === 'eager' ? 'eager' : 'lazy'),
  reveal: (value) => (value === 'interaction' ? 'interaction' : 'auto'),
};
// A lazy element starts once it is this close to the viewport.
const NEAR = '50%';

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

  connectedCallback() {
    if (!this.#parts) this.#render();
    UsdViewerElement.#nearObserver ??= new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && e.target.#approach()), { rootMargin: NEAR });
    UsdViewerElement.#nearObserver.observe(this);
    this.#update();
  }

  disconnectedCallback() {
    // Deferred so a move (disconnect then reconnect in one task) keeps the viewer.
    queueMicrotask(() => {
      if (this.isConnected) return;
      UsdViewerElement.#nearObserver.unobserve(this);
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

  #approach() {
    this.#near = true;
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
      this.#viewer = createViewer(this.#parts.viewer);
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

  async #load() {
    const src = this.getAttribute('src');
    this.#abort?.abort();
    const abort = (this.#abort = new AbortController());
    this.setAttribute('aria-busy', 'true');
    this.#showPoster(true);
    // Fades the poster out once the first geometry has been drawn.
    const reveal = () => requestAnimationFrame(() => abort.signal.aborted || this.#showPoster(false));
    try {
      const result = await this.#viewer.load(src, {
        textures: textureMode(this.getAttribute('textures')),
        maxTextureSize: Number(this.getAttribute('max-texture-size')) || 1024,
        signal: abort.signal,
        onProgress: (detail) => {
          if (detail.stage === 'geometry' && detail.loaded === 1) reveal();
          this.dispatchEvent(new CustomEvent('progress', { detail }));
        },
      });
      this.#result = result;
      this.removeAttribute('aria-busy');
      reveal();
      this.dispatchEvent(new CustomEvent('load', { detail: result.info }));
    } catch (error) {
      if (this.#abort === abort) this.removeAttribute('aria-busy');
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
      return READ[property] ? READ[property](value) : (value ?? '');
    },
    set(value) {
      if (value == null || value === '') this.removeAttribute(attribute);
      else this.setAttribute(attribute, String(value));
    },
  });
}

if (globalThis.customElements && !customElements.get('usd-viewer')) customElements.define('usd-viewer', UsdViewerElement);
