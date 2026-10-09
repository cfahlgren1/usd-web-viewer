import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { UsdLoadError } from './errors.js';
import { sameOrigin } from './load-core.js';
import { applyFallback, attachTexture, configureTexture, createMaterial, variant } from './materials.js';

export { UsdLoadError };

let wasmModule = null;

/** Compiles the WASM module once per page; workers instantiate it without refetching. */
function compileWasm(url) {
  // Written inline so bundlers (Vite, webpack) emit the asset and rewrite the URL.
  url ??= new URL('../wasm/usd_wasm_bg.wasm', import.meta.url);
  wasmModule ||= compile(url).catch((error) => {
    wasmModule = null;
    throw new UsdLoadError('worker', `could not load the WASM module from ${url}: ${error.message}`, { url: String(url), cause: error });
  });
  return wasmModule;
}

async function compile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Servers that do not send `application/wasm` break streaming compilation.
  if (response.headers.get('content-type')?.startsWith('application/wasm')) return WebAssembly.compileStreaming(response);
  return WebAssembly.compile(await response.arrayBuffer());
}

/**
 * Loads a USD stage into a three.js group. Resolves once geometry is ready;
 * `complete` settles when every texture has streamed in.
 *
 * @param {string} url  root layer URL (relative URLs resolve against the page)
 * @param {import('./index.js').LoadOptions} [options]
 * @returns {Promise<import('./index.js').LoadResult>}
 */
export async function loadUsd(url, options = {}) {
  const { maxTextureSize = 1024, textures: textureMode = 'preview', maxConcurrentFetches, maxLayerBytes } = options;
  const { onProgress, signal, headers } = options;
  if (maxConcurrentFetches !== undefined && !(Number.isInteger(maxConcurrentFetches) && maxConcurrentFetches > 0)) {
    throw new RangeError(`maxConcurrentFetches must be a positive integer, got ${maxConcurrentFetches}`);
  }
  const aborted = () => new UsdLoadError('aborted', 'the load was aborted', { url, cause: signal?.reason });
  if (signal?.aborted) throw aborted();
  const absoluteUrl = new URL(url, location.href).href;
  const module = await compileWasm(options.wasmUrl);
  if (signal?.aborted) throw aborted();
  let worker;
  try {
    // Inline `new Worker(new URL(...))` is the pattern bundlers recognise and bundle.
    worker = options.workerUrl
      ? new Worker(options.workerUrl, { type: 'module' })
      : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (error) {
    throw new UsdLoadError('worker', `could not start the worker: ${error.message}`, { url: options.workerUrl && String(options.workerUrl), cause: error });
  }
  // Ends the caller's fetches (custom `fetch` requests) when the load stops.
  const requests = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
  // Bodies of custom-fetch responses the worker is reading, by request id.
  const bodies = new Map();

  let resolveScene, rejectScene, resolveComplete, rejectComplete;
  const scenePromise = new Promise((resolve, reject) => ((resolveScene = resolve), (rejectScene = reject)));
  const complete = new Promise((resolve, reject) => ((resolveComplete = resolve), (rejectComplete = reject)));
  // A rejection nobody awaits (e.g. after dispose) must not surface as unhandled.
  complete.catch(() => {});
  const counts = { textures: 0, failed: 0 };
  let built = null;
  let delivered = false;
  let stopped = false;
  // The one way out (done, error, dispose, abort): stop the worker, which
  // frees its WASM memory, and settle both promises (a no-op if settled).
  const stop = (error) => {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    requests.abort();
    signal?.removeEventListener('abort', abort);
    rejectScene(error);
    if (error) rejectComplete(error);
    else resolveComplete({ ...counts });
  };
  function abort() {
    // Before geometry resolves nothing has reached the caller: free it here.
    if (built && !delivered) built.dispose();
    stop(aborted());
  }
  signal?.addEventListener('abort', abort, { once: true });

  worker.onmessage = ({ data }) => {
    // Messages already queued when the load was stopped (disposed or aborted).
    if (stopped) {
      data.bitmap?.close();
      return;
    }
    switch (data.type) {
      case 'fetch':
        proxyFetch(data);
        break;
      case 'pull':
        pullChunk(data.id);
        break;
      case 'cancel':
        bodies.get(data.id)?.cancel();
        bodies.delete(data.id);
        break;
      case 'progress':
        onProgress?.(data.progress);
        break;
      case 'scene':
        if (signal?.aborted) return abort();
        built = buildScene(data.meta, data.geometries);
        built.info.stats = data.stats;
        built.info.warnings.push(...data.meta.warnings, ...data.stats.warnings);
        delivered = true;
        resolveScene(built);
        break;
      case 'texture':
        if (data.bitmap) {
          built.applyTexture(data.path, data.bitmap);
          counts.textures++;
        } else {
          built.textureFailed(data.path);
          counts.failed++;
          built.info.warnings.push({ code: 'texture-failed', message: data.error, path: data.path });
        }
        break;
      case 'done':
        stop();
        break;
      case 'error':
        stop(new UsdLoadError(data.code, data.message, { url: data.url, status: data.status }));
        break;
    }
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    stop(new UsdLoadError('worker', event.message || 'the worker failed', { url: absoluteUrl }));
  };
  worker.postMessage({ url: absoluteUrl, wasmModule: module, maxTextureSize, textures: textureMode, maxConcurrentFetches, maxLayerBytes, headers, proxyFetch: !!options.fetch });

  /** Runs one worker request through the caller's `fetch`; the body follows chunk by chunk. */
  async function proxyFetch({ id, url: target }) {
    try {
      const init = sameOrigin(target, absoluteUrl) && headers ? { headers, signal: requestSignal } : { signal: requestSignal };
      const response = await options.fetch(target, init);
      if (response.ok) bodies.set(id, (response.body ?? new Blob().stream()).getReader());
      else response.body?.cancel();
      worker.postMessage({ type: 'fetched', id, ok: response.ok, status: response.status });
    } catch (error) {
      worker.postMessage({ type: 'fetched', id, error: String(error) });
    }
  }

  /** Reads the next chunk of a custom-fetch body for the worker, which asks once per chunk. */
  async function pullChunk(id) {
    try {
      const { done, value } = await bodies.get(id).read();
      if (done) {
        bodies.delete(id);
        return worker.postMessage({ type: 'chunk', id, done });
      }
      const chunk = value.byteLength === value.buffer.byteLength ? value : value.slice();
      worker.postMessage({ type: 'chunk', id, chunk }, [chunk.buffer]);
    } catch (error) {
      bodies.delete(id);
      worker.postMessage({ type: 'chunk', id, error: String(error) });
    }
  }

  const scene = await scenePromise;
  return {
    root: scene.root,
    info: scene.info,
    complete,
    dispose() {
      stop(aborted());
      scene.dispose();
    },
  };
}

function buildScene(meta, arrays) {
  const root = new THREE.Group();
  root.name = 'usd';
  // three.js is Y-up in meters.
  if (meta.upAxis === 'Z') root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(meta.metersPerUnit || 1);

  const materials = meta.materials.map((m) => createMaterial(m));
  const variants = new Map();
  const materialFor = (index, doubleSided, vertexColors, uvChannels) => {
    const routed = Object.keys(uvChannels).length > 0;
    if (!doubleSided && !vertexColors && !routed) return materials[index];
    const key = `${index}|${doubleSided}|${vertexColors}|${JSON.stringify(uvChannels)}`;
    if (!variants.has(key)) variants.set(key, variant(materials[index], { doubleSided, vertexColors, uvChannels }));
    return variants.get(key);
  };

  const geometries = meta.geometries.map((g, i) => {
    const a = arrays[i];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3));
    // UV set k is three.js attribute `uv`, `uv1`, `uv2`, ... (a texture's `channel`).
    a.uvs.forEach((uv, k) => geometry.setAttribute(k ? `uv${k}` : 'uv', new THREE.BufferAttribute(uv, 2)));
    if (a.colors) geometry.setAttribute('color', new THREE.BufferAttribute(a.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(a.indices, 1));
    // Bounds come from the worker, so framing and culling never rescan positions.
    geometry.boundingBox = new THREE.Box3().setFromArray(g.bounds);
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    if (g.groups.length > 1) g.groups.forEach(([start, count], j) => geometry.addGroup(start, count, j));
    return geometry;
  });

  for (const inst of meta.instances) {
    const g = meta.geometries[inst.geometry];
    const mats = inst.materials.map((m) => {
      const usd = materials[m].userData.usd;
      // Route each named UV set to its attribute on this geometry; meshes that
      // lay their UV sets out differently get their own copy of the material.
      const uvChannels = {};
      for (const ref of Object.values(usd.maps)) {
        const k = g.uvSets.indexOf(ref.uvSet);
        if (k > 0) uvChannels[ref.uvSet] = k;
      }
      return materialFor(m, inst.doubleSided, g.hasColors && !!usd.colorPrimvar, uvChannels);
    });
    const mesh = new THREE.Mesh(geometries[inst.geometry], mats.length > 1 ? mats : mats[0]);
    mesh.name = inst.path;
    // USD stores row-vector matrices row-major: the same numbers column-major for three.js.
    // Set whole rather than decomposed, which would lose shear.
    mesh.matrix.fromArray(inst.matrix);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    root.add(mesh);
  }

  const allMaterials = () => [...materials, ...variants.values()];
  const textures = new Map();
  const applyTexture = (path, bitmap) => {
    const base = new THREE.Texture(bitmap);
    base.flipY = false;
    base.anisotropy = 4;
    textures.set(path, base);
    const textureFor = (ref, colorSpace, uvChannel) => configureTexture(base, ref, colorSpace, uvChannel);
    for (const material of allMaterials()) attachTexture(material, path, textureFor);
  };
  const textureFailed = (path) => allMaterials().forEach((material) => applyFallback(material, path));

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
    for (const m of allMaterials()) {
      for (const key of ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'normalMap']) m[key]?.dispose();
      m.dispose();
    }
    for (const t of textures.values()) {
      t.image?.close?.();
      t.dispose();
    }
  };

  const info = {
    upAxis: meta.upAxis,
    metersPerUnit: meta.metersPerUnit,
    meshes: meta.instances.length,
    geometries: meta.geometries.length,
    triangles: meta.stats.triangles,
    materials: meta.materials.length,
    materialKinds: countBy(meta.materials, (m) => m.kind),
    warnings: [],
  };
  return { root, info, applyTexture, textureFailed, dispose };
}

function countBy(list, key) {
  const out = {};
  for (const item of list) out[key(item)] = (out[key(item)] || 0) + 1;
  return out;
}

/**
 * A ready-made viewer: renderer, studio lighting, orbit controls and
 * on-demand rendering around {@link loadUsd}. The canvas is transparent unless
 * a `background` is given. Throws a `webgl` UsdLoadError without WebGL.
 *
 * @param {HTMLElement | HTMLCanvasElement} target  a canvas, or a container to append one to
 * @param {import('./index.js').ViewerOptions} [options]
 * @returns {import('./index.js').Viewer}
 */
export function createViewer(target, options = {}) {
  const ownsCanvas = !(target instanceof HTMLCanvasElement);
  const canvas = ownsCanvas ? target.appendChild(document.createElement('canvas')) : target;
  const container = ownsCanvas ? target : canvas.parentElement;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (error) {
    if (ownsCanvas) canvas.remove();
    throw new UsdLoadError('webgl', `WebGL is not available: ${error.message}`, { cause: error });
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  scene.background = options.background == null ? null : new THREE.Color(options.background);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  camera.position.set(2, 1.5, 2);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // Focusable, with arrow keys panning the camera.
  canvas.tabIndex = 0;
  controls.listenToKeyEvents(canvas);

  let frameRequested = false;
  let disposed = false;
  const render = () => {
    frameRequested = false;
    if (disposed) return;
    if (controls.update()) requestRender();
    renderer.render(scene, camera);
  };
  const requestRender = () => {
    if (frameRequested || disposed) return;
    frameRequested = true;
    requestAnimationFrame(render);
  };
  controls.addEventListener('change', requestRender);

  const resize = () => {
    const width = container?.clientWidth || canvas.clientWidth || 800;
    const height = container?.clientHeight || canvas.clientHeight || 600;
    renderer.setSize(width, height, ownsCanvas);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    requestRender();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container || canvas);
  resize();

  let current = null;
  // The load in flight; a newer load or dispose aborts it.
  let pending = null;
  const clear = () => {
    if (!current) return;
    scene.remove(current.root);
    current.dispose();
    current = null;
    requestRender();
  };
  const viewer = {
    renderer,
    scene,
    camera,
    controls,
    requestRender,
    /** Loads a stage, replacing the current one once its geometry shows. A newer load aborts this one. */
    async load(url, loadOptions = {}) {
      if (disposed) throw new UsdLoadError('aborted', 'the viewer was disposed', { url });
      pending?.abort();
      const controller = (pending = new AbortController());
      const signal = loadOptions.signal ? AbortSignal.any([loadOptions.signal, controller.signal]) : controller.signal;
      const onProgress = (progress) => {
        if (progress.stage === 'textures') requestRender();
        loadOptions.onProgress?.(progress);
      };
      try {
        const result = await loadUsd(url, { ...loadOptions, signal, onProgress });
        // Superseded (or the viewer disposed) as geometry arrived: drop it.
        if (controller.signal.aborted || disposed) {
          result.dispose();
          throw new UsdLoadError('aborted', 'superseded by a newer load', { url });
        }
        clear();
        current = result;
        scene.add(result.root);
        frame(camera, controls, result.root);
        requestRender();
        result.complete.then(requestRender, () => {});
        return result;
      } finally {
        if (pending === controller) pending = null;
      }
    },
    /** Removes and frees the current stage. */
    clear,
    /** Points the camera at `object`, by default the current stage. */
    frame(object = current?.root) {
      if (object) frame(camera, controls, object);
      requestRender();
    },
    /** Frees the renderer, the GPU context, the current stage and any load in flight. Safe to call twice. */
    dispose() {
      if (disposed) return;
      disposed = true;
      pending?.abort();
      if (current) current.dispose();
      current = null;
      observer.disconnect();
      controls.dispose();
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (ownsCanvas) canvas.remove();
    },
  };
  return viewer;
}

/** Points the camera at the visible bounds of `object`. */
export function frame(camera, controls, object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const distance = (radius / Math.sin(((camera.fov * Math.PI) / 180) / 2)) * 1.05;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.6, 1).normalize(), distance);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls?.target.copy(center);
  controls?.update();
}
