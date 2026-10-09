import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyFallback, attachTexture, configureTexture, createMaterial, variant } from './materials.js';

export { findSimReadyRoot, hubUrl } from './hub.js';

let wasmModule = null;

/** Compiles the WASM module once per page; workers instantiate it without refetching. */
function compileWasm(url) {
  // Written inline so bundlers (Vite, webpack) emit the asset and rewrite the URL.
  url ??= new URL('../wasm/usd_wasm_bg.wasm', import.meta.url);
  wasmModule ||= WebAssembly.compileStreaming(fetch(url)).catch((error) => {
    wasmModule = null;
    throw error;
  });
  return wasmModule;
}

/**
 * Loads a USD stage into a three.js group. Resolves once geometry is ready;
 * `textures` resolves when every texture has streamed in.
 *
 * @param {string} url  root layer URL (relative URLs resolve against the page)
 * @param {import('./index.js').LoadOptions} [options]
 * @returns {Promise<import('./index.js').LoadResult>}
 *   `dispose` also stops any textures still streaming and settles `textures`.
 */
export async function loadUsd(url, options = {}) {
  const { maxTextureSize = 1024, textures: textureMode = 'preview', prefetchVariants = false, maxConcurrentFetches, maxLayerBytes } = options;
  const { onTexture, onProgress, signal, headers } = options;
  signal?.throwIfAborted();
  const absoluteUrl = new URL(url, location.href).href;
  const module = await compileWasm(options.wasmUrl);
  signal?.throwIfAborted();
  // Inline `new Worker(new URL(...))` is the pattern bundlers recognise and bundle.
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

  let resolveScene, rejectScene, resolveTextures;
  const scenePromise = new Promise((resolve, reject) => ((resolveScene = resolve), (rejectScene = reject)));
  const textures = new Promise((resolve) => (resolveTextures = resolve));
  let built = null;
  let delivered = false;
  let stopped = false;
  // One way out for done, error, dispose and abort: stop the worker (freeing
  // its WASM memory) and settle `textures`.
  const stop = () => {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    signal?.removeEventListener('abort', abort);
    resolveTextures();
  };
  function abort() {
    stop();
    // Before geometry resolves nothing has reached the caller: free it here.
    if (built && !delivered) built.dispose();
    rejectScene(signal.reason ?? new DOMException('Aborted', 'AbortError'));
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
        proxyFetch(options.fetch, data, headers, signal).then(({ message, transfer }) => worker.postMessage(message, transfer));
        break;
      case 'progress':
        onProgress?.(data.progress);
        break;
      case 'scene':
        built = buildScene(data.meta, data.geometries);
        built.info.stats = data.stats;
        built.info.warnings = [...data.meta.warnings, ...data.stats.warnings];
        delivered = true;
        resolveScene(built);
        break;
      case 'texture':
        if (data.bitmap && built) {
          built.applyTexture(data.path, data.bitmap);
          onTexture?.();
        } else if (data.error && built) {
          built.textureFailed(data.path);
          built.info.textureErrors.push(`${data.path}: ${data.error}`);
          built.info.warnings.push(`texture not loaded: ${data.path}: ${data.error}`);
        }
        break;
      case 'done':
        stop();
        break;
      case 'error':
        stop();
        rejectScene(new Error(data.message));
        break;
    }
  };
  worker.onerror = (event) => {
    stop();
    rejectScene(new Error(event.message || 'worker failed to start'));
  };
  worker.postMessage({ url: absoluteUrl, wasmModule: module, maxTextureSize, textures: textureMode, prefetchVariants, maxConcurrentFetches, maxLayerBytes, headers, proxyFetch: !!options.fetch });

  const scene = await scenePromise;
  const dispose = () => {
    stop();
    scene.dispose();
  };
  return { root: scene.root, info: scene.info, textures, dispose };
}

/** Runs one worker request through the caller's `fetch` and packages the reply. */
async function proxyFetch(fetchFn, { id, url }, headers, signal) {
  try {
    const response = await fetchFn(url, { headers, signal });
    const buffer = response.ok ? await response.arrayBuffer() : null;
    return { message: { type: 'fetched', id, ok: response.ok, status: response.status, buffer }, transfer: buffer ? [buffer] : [] };
  } catch (error) {
    return { message: { type: 'fetched', id, ok: false, status: 0, buffer: null, error: String(error) }, transfer: [] };
  }
}

function buildScene(meta, arrays) {
  const root = new THREE.Group();
  root.name = 'usd';
  // three.js is Y-up in meters.
  if (meta.upAxis === 'Z') root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(meta.metersPerUnit || 1);

  const materials = meta.materials.map((m) => createMaterial(m));
  const variants = new Map();
  const materialFor = (index, doubleSided, vertexColors) => {
    if (!doubleSided && !vertexColors) return materials[index];
    const key = `${index}|${doubleSided}|${vertexColors}`;
    if (!variants.has(key)) variants.set(key, variant(materials[index], { doubleSided, vertexColors }));
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
      // Route each named UV set to its attribute; the first mesh using a material decides.
      for (const ref of Object.values(usd.maps)) {
        const k = g.uvSets.indexOf(ref.uvSet);
        if (k > 0) usd.uvChannels[ref.uvSet] ??= k;
      }
      return materialFor(m, inst.doubleSided, g.hasColors && !!usd.colorPrimvar);
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
    textureErrors: [],
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
 * on-demand rendering around {@link loadUsd}.
 *
 * @param {HTMLElement | HTMLCanvasElement} target  a canvas, or a container to append one to
 * @param {object} [options]
 * @param {THREE.ColorRepresentation} [options.background=0xf2f2f2]
 */
export async function createViewer(target, options = {}) {
  const canvas = target instanceof HTMLCanvasElement ? target : target.appendChild(document.createElement('canvas'));
  const container = target instanceof HTMLCanvasElement ? canvas.parentElement : target;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? 0xf2f2f2);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  camera.position.set(2, 1.5, 2);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  let frameRequested = false;
  const render = () => {
    frameRequested = false;
    if (controls.update()) requestRender();
    renderer.render(scene, camera);
  };
  const requestRender = () => {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(render);
  };
  controls.addEventListener('change', requestRender);

  const resize = () => {
    const width = container?.clientWidth || canvas.clientWidth || 800;
    const height = container?.clientHeight || canvas.clientHeight || 600;
    renderer.setSize(width, height, !(target instanceof HTMLCanvasElement));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    requestRender();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container || canvas);
  resize();

  let current = null;
  const viewer = {
    renderer,
    scene,
    camera,
    controls,
    requestRender,
    /** Loads a stage, replacing the current one. Resolves when geometry shows. */
    async load(url, loadOptions = {}) {
      const result = await loadUsd(url, { ...loadOptions, onTexture: requestRender });
      if (current) {
        scene.remove(current.root);
        current.dispose();
      }
      current = result;
      scene.add(result.root);
      frame(camera, controls, result.root);
      requestRender();
      result.textures.then(requestRender);
      return result;
    },
    dispose() {
      observer.disconnect();
      controls.dispose();
      if (current) current.dispose();
      renderer.dispose();
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
