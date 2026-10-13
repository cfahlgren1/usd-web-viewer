import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { UsdLoadError } from './errors.js';
import { OUT_OF_MEMORY, canonicalUrl, localKey, localUrl } from './load-core.js';
import { applyFallback, attachTexture, configureTexture, createMaterial, variant } from './materials.js';
import type { UsdMaterial } from './materials.js';
import type { GeometryArrays, GeometryMeta, InstanceMeta, LoadRequest, Mutable, SceneMeta, StageProgress, WorkerMessage } from './meta.js';
import type { LoadInfo, LoadOptions, LoadProgress, LoadResult, LoadStats, Viewer, ViewerOptions } from './types.js';

export type * from './types.js';
export { UsdLoadError };

// Lets the viewer show meshes as they stream in, before the load resolves.
const SHOW: unique symbol = Symbol('show');

type InternalOptions = LoadOptions & { [SHOW]?: (root: THREE.Group, meta: SceneMeta) => void };

// Instances of one geometry with the same materials drawn as one
// InstancedMesh past this many.
const INSTANCING_MIN = 4;

// The share of the overall `fraction` each stage spans (see LoadProgress).
const STAGES: Record<LoadProgress['stage'], [number, number]> = { layers: [0, 0.4], compose: [0.4, 0.5], geometry: [0.5, 0.8], textures: [0.8, 1] };

/** Where `progress` puts the load overall, before taking the maximum so far. */
function stageFraction(progress: StageProgress) {
  const [start, end] = STAGES[progress.stage];
  // More layers may yet be found; a compose round is halfway into its stage.
  const done =
    progress.stage === 'layers'
      ? progress.loaded / (progress.total + 1)
      : progress.stage === 'compose'
        ? 0.5
        : progress.total
          ? progress.loaded / progress.total
          : 1;
  return start + (end - start) * done;
}

let wasmModule: Promise<WebAssembly.Module> | null = null;

/** Compiles the WASM module once per page; workers instantiate it without refetching. */
function compileWasm(url?: string | URL) {
  // Written inline so bundlers (Vite, webpack) emit the asset and rewrite the URL.
  url ??= new URL('../wasm/usd_wasm_bg.wasm', import.meta.url);
  wasmModule ||= compile(url).catch((error) => {
    wasmModule = null;
    throw new UsdLoadError('worker', `could not load the WASM module from ${url}: ${(error as Error).message}`, { url: String(url), cause: error });
  });
  return wasmModule;
}

async function compile(url: string | URL) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  // Servers that do not send `application/wasm` break streaming compilation.
  if (response.headers.get('content-type')?.startsWith('application/wasm')) {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/**
 * Loads a USD stage into a three.js group. Resolves once geometry is ready;
 * `complete` settles when every texture has streamed in. Rejects with a
 * UsdLoadError of code `worker` where there are no Web Workers (e.g. on a server).
 *
 * @param url  root layer URL (relative URLs resolve against the page), or its key in `options.files`
 */
export async function loadUsd(url: string, options: LoadOptions = {}): Promise<LoadResult> {
  const { maxTextureSize, textures, maxConcurrentFetches, maxLayerBytes, maxTextureBytes, maxLayers, maxInstances, maxTriangles, allowedOrigins } = options;
  const { onProgress, signal, headers } = options;
  if (maxConcurrentFetches !== undefined && !(Number.isInteger(maxConcurrentFetches) && maxConcurrentFetches > 0)) {
    throw new RangeError(`maxConcurrentFetches must be a positive integer, got ${maxConcurrentFetches}`);
  }
  const aborted = () => new UsdLoadError('aborted', 'the load was aborted', { url, cause: signal?.reason });
  if (signal?.aborted) {
    throw aborted();
  }
  if (typeof Worker === 'undefined') {
    throw new UsdLoadError('worker', 'loading needs Web Workers: call loadUsd in a browser', { url });
  }
  const files = options.files && new Map([...options.files].map(([key, file]) => [localKey(key), file]));
  if (files && !files.has(localKey(url))) {
    throw new UsdLoadError('fetch', `the root layer ${url} is not in files`, { url, status: 404 });
  }
  const absoluteUrl = files ? localUrl(url) : canonicalUrl(new URL(url, location.href).href);
  // The compile is shared with other loads: aborting stops waiting for it, not it.
  const module = await new Promise<WebAssembly.Module>((resolve, reject) => {
    const abortWait = () => reject(aborted());
    signal?.addEventListener('abort', abortWait, { once: true });
    compileWasm(options.wasmUrl)
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', abortWait));
  });
  if (signal?.aborted) {
    throw aborted();
  }
  let worker: Worker;
  try {
    // Inline `new Worker(new URL(...))` is the pattern bundlers recognise and bundle.
    worker = options.workerUrl ? new Worker(options.workerUrl, { type: 'module' }) : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (error) {
    throw new UsdLoadError('worker', `could not start the worker: ${(error as Error).message}`, {
      url: options.workerUrl && String(options.workerUrl),
      cause: error,
    });
  }
  interface Counts {
    textures: number;
    failed: number;
  }
  let resolveScene!: (scene: BuiltScene) => void;
  let rejectScene!: (error?: UsdLoadError) => void;
  let resolveComplete!: (counts: Counts) => void;
  let rejectComplete!: (error: UsdLoadError) => void;
  const scenePromise = new Promise<BuiltScene>((resolve, reject) => ((resolveScene = resolve), (rejectScene = reject)));
  const complete = new Promise<Counts>((resolve, reject) => ((resolveComplete = resolve), (rejectComplete = reject)));
  // A rejection nobody awaits (e.g. after dispose) must not surface as unhandled.
  complete.catch(() => {});
  const counts = { textures: 0, failed: 0 };
  let fraction = 0;
  let built: BuiltScene | null = null;
  // Geometry, the scene and textures follow the `meta` that builds it.
  const builtScene = () => {
    if (!built) {
      throw new Error('the worker sent the scene before its metadata');
    }
    return built;
  };
  let delivered = false;
  let stopped = false;
  // The one way out (done, error, dispose, abort): stop the worker, which
  // frees its WASM memory, and settle both promises (a no-op if settled).
  const stop = (error?: UsdLoadError) => {
    if (stopped) {
      return;
    }
    stopped = true;
    worker.terminate();
    signal?.removeEventListener('abort', abort);
    rejectScene(error);
    if (error) {
      rejectComplete(error);
    } else {
      resolveComplete({ ...counts });
    }
  };
  function fail(error: UsdLoadError) {
    // Before geometry resolves nothing has reached the caller: free it here.
    if (built && !delivered) {
      built.dispose();
    }
    stop(error);
  }
  function abort() {
    fail(aborted());
  }
  signal?.addEventListener('abort', abort, { once: true });

  worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
    // Messages already queued when the load was stopped (disposed or aborted).
    if (stopped) {
      if (data.type === 'texture') {
        data.bitmap?.close();
      }
      return;
    }
    try {
      receive(data);
    } catch (error) {
      if (data.type === 'texture') {
        data.bitmap?.close();
      }
      fail(new UsdLoadError('worker', `could not build the scene: ${(error as Error)?.message || error}`, { url: absoluteUrl, cause: error }));
    }
  };
  function receive(data: WorkerMessage) {
    switch (data.type) {
      case 'progress':
        fraction = Math.max(fraction, stageFraction(data.progress));
        onProgress?.({ ...data.progress, fraction });
        break;
      case 'meta':
        if (signal?.aborted) {
          return abort();
        }
        built = buildScene(data.meta);
        (options as InternalOptions)[SHOW]?.(built.root, data.meta);
        break;
      case 'geometry':
        builtScene().addGeometry(data.index, data.meta, data.arrays);
        break;
      case 'scene': {
        const { warnings, ...stats } = data.stats;
        builtScene().info.stats = stats;
        builtScene().info.warnings.push(...warnings);
        delivered = true;
        resolveScene(builtScene());
        break;
      }
      case 'texture':
        if (data.bitmap) {
          builtScene().applyTexture(data.path, data.bitmap, data.color);
          counts.textures++;
        } else {
          builtScene().textureFailed(data.path);
          counts.failed++;
          builtScene().info.warnings.push({ code: 'texture-failed', message: data.error, path: data.path });
        }
        break;
      case 'done':
        stop();
        break;
      case 'error':
        fail(new UsdLoadError(data.code, data.message, { url: data.url, status: data.status }));
        break;
    }
  }
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault?.();
    const message = event.message || 'the worker failed';
    // The worker itself ran out of memory, outside the handler that reports it.
    if (OUT_OF_MEMORY.test(message)) {
      fail(new UsdLoadError('compose', `scene too large to load: ran out of memory: ${message}`, { url: absoluteUrl }));
    } else {
      fail(new UsdLoadError('worker', message, { url: absoluteUrl }));
    }
  };
  const request: LoadRequest = {
    url: absoluteUrl,
    wasmModule: module,
    maxTextureSize,
    textures,
    maxConcurrentFetches,
    maxLayerBytes,
    maxTextureBytes,
    maxLayers,
    maxInstances,
    maxTriangles,
    allowedOrigins,
    headers,
    files,
  };
  worker.postMessage(request);

  const scene = await scenePromise;
  return {
    root: scene.root,
    info: scene.info as LoadInfo,
    complete,
    dispose() {
      stop(aborted());
      scene.dispose();
    },
  };
}

type BuiltScene = ReturnType<typeof buildScene>;

function buildScene(meta: SceneMeta) {
  const info: Mutable<Omit<LoadInfo, 'stats'>> & { stats?: LoadStats; warnings: LoadInfo['warnings'][number][] } = {
    upAxis: meta.upAxis,
    metersPerUnit: meta.metersPerUnit,
    meshes: 0,
    geometries: 0,
    triangles: 0,
    materials: meta.materials.length,
    materialKinds: countBy(meta.materials, (m) => m.kind),
    warnings: [...meta.warnings],
  };
  const root = new THREE.Group();
  root.name = 'usd';
  // three.js is Y-up in meters.
  if (meta.upAxis === 'Z') {
    root.rotation.x = -Math.PI / 2;
  }
  root.scale.setScalar(meta.metersPerUnit || 1);

  const materials = meta.materials.map((m) => createMaterial(m));
  const variants = new Map<string, UsdMaterial>();
  const materialFor = (index: number, doubleSided: boolean, vertexColors: boolean, uvChannels: Record<string, number>) => {
    const routed = Object.keys(uvChannels).length > 0;
    if (!doubleSided && !vertexColors && !routed) {
      return materials[index];
    }
    const key = `${index}|${doubleSided}|${vertexColors}|${JSON.stringify(uvChannels)}`;
    let copy = variants.get(key);
    if (!copy) {
      copy = variant(materials[index], { doubleSided, vertexColors, uvChannels });
      variants.set(key, copy);
    }
    return copy;
  };

  // Geometries stream in one at a time; each brings in the meshes that draw it.
  const geometries: THREE.BufferGeometry[] = [];
  const instancesOf = new Map<number, InstanceMeta[]>();
  for (const inst of meta.instances) {
    const list = instancesOf.get(inst.geometry);
    if (list) {
      list.push(inst);
    } else {
      instancesOf.set(inst.geometry, [inst]);
    }
  }
  const instanced: THREE.InstancedMesh[] = [];
  const addGeometry = (index: number, g: GeometryMeta | null, a: GeometryArrays | null) => {
    if (!g) {
      return;
    }
    // A malformed message: throwing fails the load.
    if (!a) {
      throw new Error('a geometry without its arrays');
    }
    const geometry = createGeometry(g, a);
    geometries.push(geometry);
    info.geometries++;

    const triangles = g.groups.reduce((n, [, count]) => n + count / 3, 0);
    // Instances by the materials they draw with.
    const batches = new Map<string, { material: UsdMaterial | UsdMaterial[]; list: InstanceMeta[] }>();
    for (const inst of instancesOf.get(index) ?? []) {
      // A group takes its GeomSubset's material, else the mesh's.
      const mats = g.groups.map(([, , subset]) => {
        const m = subset !== undefined && Object.hasOwn(inst.subsets, subset) ? inst.subsets[subset] : inst.material;
        const usd = materials[m].userData.usd;
        // Route each named UV set to its attribute on this geometry; meshes that
        // lay their UV sets out differently get their own copy of the material.
        const uvChannels: Record<string, number> = Object.create(null);
        for (const ref of Object.values(usd.maps)) {
          if (ref.uvSet === undefined) {
            continue;
          }
          const k = g.uvSets.indexOf(ref.uvSet);
          if (k > 0) {
            uvChannels[ref.uvSet] = k;
          }
        }
        return materialFor(m, inst.doubleSided, g.hasColors && !!usd.colorPrimvar, uvChannels);
      });
      const key = mats.map((m) => m.uuid).join();
      const batch = batches.get(key);
      if (batch) {
        batch.list.push(inst);
      } else {
        batches.set(key, { material: mats.length > 1 ? mats : mats[0], list: [inst] });
      }
      info.meshes++;
      info.triangles += triangles;
    }
    // USD stores row-vector matrices row-major: the same numbers column-major for three.js.
    // Set whole rather than decomposed, which would lose shear.
    for (const { material, list } of batches.values()) {
      if (list.length > INSTANCING_MIN) {
        const mesh = new THREE.InstancedMesh(geometry, material, list.length);
        mesh.name = list[0].path;
        const matrix = new THREE.Matrix4();
        list.forEach((inst, k) => mesh.setMatrixAt(k, matrix.fromArray(inst.matrix)));
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        instanced.push(mesh);
        root.add(mesh);
        continue;
      }
      for (const inst of list) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = inst.path;
        mesh.matrix.fromArray(inst.matrix);
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorldNeedsUpdate = true;
        root.add(mesh);
      }
    }
  };

  const allMaterials = () => [...materials, ...variants.values()];
  const textures = new Map<string, THREE.Texture>();
  const applyTexture = (path: string, bitmap: ImageBitmap, isColor: boolean) => {
    const base = new THREE.Texture(bitmap);
    base.flipY = false;
    base.anisotropy = 4;
    textures.set(path, base);
    const textureFor: Parameters<typeof attachTexture>[3] = (ref, colorSpace, uvChannel) => configureTexture(base, ref, colorSpace, uvChannel);
    for (const material of allMaterials()) {
      attachTexture(material, path, isColor, textureFor);
    }
  };
  const textureFailed = (path: string) => allMaterials().forEach((material) => applyFallback(material, path));

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
    instanced.forEach((mesh) => mesh.dispose());
    for (const m of allMaterials()) {
      for (const key of ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'normalMap'] as const) {
        m[key]?.dispose();
      }
      m.dispose();
    }
    for (const t of textures.values()) {
      (t.image as ImageBitmap | undefined)?.close?.();
      t.dispose();
    }
  };

  return { root, info, addGeometry, applyTexture, textureFailed, dispose };
}

function createGeometry(g: GeometryMeta, a: GeometryArrays) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3));
  // UV set k is three.js attribute `uv`, `uv1`, `uv2`, ... (a texture's `channel`).
  a.uvs.forEach((uv, k) => geometry.setAttribute(k ? `uv${k}` : 'uv', new THREE.BufferAttribute(uv, 2)));
  if (a.colors) {
    geometry.setAttribute('color', new THREE.BufferAttribute(a.colors, 3));
  }
  const index = new THREE.BufferAttribute(a.indices, 1);
  geometry.setIndex(index);
  // Once on the GPU the arrays are dead weight: bounds are precomputed, so
  // framing and culling never read them. The cost: nothing to re-upload
  // after a lost WebGL context, and no CPU raycasting against the mesh.
  for (const attribute of [index, ...(Object.values(geometry.attributes) as THREE.BufferAttribute[])]) {
    attribute.onUpload(releaseArray);
  }
  // Bounds come from the worker, so framing and culling never rescan positions.
  geometry.boundingBox = new THREE.Box3().setFromArray(g.bounds);
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  if (g.groups.length > 1) {
    g.groups.forEach(([start, count], j) => geometry.addGroup(start, count, j));
  }
  return geometry;
}

/** `onUpload` callback: drops the CPU copy of an attribute three.js just uploaded. */
function releaseArray(this: { array: unknown }) {
  this.array = null;
}

function countBy<T>(list: T[], key: (item: T) => string) {
  const out: Record<string, number> = {};
  for (const item of list) {
    out[key(item)] = (out[key(item)] || 0) + 1;
  }
  return out;
}

/**
 * A ready-made viewer: renderer, studio lighting, orbit controls and
 * on-demand rendering around {@link loadUsd}. The canvas is transparent unless
 * a `background` is given. Throws a `webgl` UsdLoadError without WebGL.
 *
 * @param target  a canvas, or a container to append one to
 */
export function createViewer(target: HTMLElement | HTMLCanvasElement, options: ViewerOptions = {}): Viewer {
  const ownsCanvas = !(target instanceof HTMLCanvasElement);
  const canvas = ownsCanvas ? target.appendChild(document.createElement('canvas')) : (target as HTMLCanvasElement);
  const container = ownsCanvas ? target : canvas.parentElement;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (error) {
    if (ownsCanvas) {
      canvas.remove();
    }
    throw new UsdLoadError('webgl', `WebGL is not available: ${(error as Error).message}`, { cause: error });
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  scene.background = options.background == null ? null : new THREE.Color(options.background);
  // Rendered on the GPU, so rendered again after a lost context.
  const makeEnvironment = () => {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  };
  makeEnvironment();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  camera.position.set(2, 1.5, 2);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // Focusable, with arrow keys panning the camera and + / - zooming.
  canvas.tabIndex = 0;
  controls.listenToKeyEvents(canvas);
  const zoomKey = (event: KeyboardEvent) => {
    const scale = ({ '+': 0.8, '=': 0.8, '-': 1.25, _: 1.25 } as Record<string, number>)[event.key];
    if (!scale || !controls.enabled || !controls.enableZoom || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    event.preventDefault();
    camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
    controls.update();
  };
  canvas.addEventListener('keydown', zoomKey);

  let frameRequested = false;
  let disposed = false;
  const render = () => {
    frameRequested = false;
    if (disposed) {
      return;
    }
    if (controls.update()) {
      requestRender();
    }
    renderer.render(scene, camera);
  };
  const requestRender = () => {
    if (frameRequested || disposed) {
      return;
    }
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

  let current: LoadResult | null = null;
  // The load in flight; a newer load or dispose aborts it.
  let pending: AbortController | null = null;
  // The latest load's arguments, to load again after a lost context.
  let last: [string, LoadOptions] | null = null;
  const clear = () => {
    if (!current) {
      return;
    }
    scene.remove(current.root);
    current.dispose();
    current = null;
    requestRender();
  };
  // Geometry lives only on the GPU (its arrays are released once uploaded),
  // so a lost context loses the stage: it is loaded again once restored.
  const contextLost = (event: Event) => {
    event.preventDefault();
    pending?.abort();
    clear();
    options.onContextLost?.();
  };
  const contextRestored = () => {
    scene.environment?.dispose();
    makeEnvironment();
    const reload = last && viewer.load(...last);
    reload?.catch(() => {});
    options.onContextRestored?.(reload);
    requestRender();
  };
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);

  const viewer: Viewer = {
    renderer,
    scene,
    camera,
    controls,
    requestRender,
    /** Loads a stage, replacing the current one once its geometry shows. A newer load aborts this one. */
    async load(url, loadOptions = {}) {
      if (disposed) {
        throw new UsdLoadError('aborted', 'the viewer was disposed', { url });
      }
      last = [url, loadOptions];
      pending?.abort();
      const controller = (pending = new AbortController());
      const { signal: callerSignal } = loadOptions;
      if (callerSignal?.aborted) {
        controller.abort(callerSignal.reason);
      }
      callerSignal?.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true, signal: controller.signal });
      // Meshes show as they stream in: the new stage replaces the old one as
      // soon as it is composed. It is framed then on its authored extents when
      // every mesh has them, else once complete (and again if a mesh in those
      // extents was left out): framing the meshes streamed so far would zoom
      // in on the first and jump out again.
      let streaming: THREE.Group | null = null;
      let planned = 0;
      const show = (root: THREE.Group, meta: SceneMeta) => {
        if (controller.signal.aborted) {
          return;
        }
        clear();
        streaming = root;
        scene.add(root);
        if (!meta.bounds) {
          return;
        }
        root.updateMatrixWorld();
        frameBox(camera, controls, new THREE.Box3().setFromArray(meta.bounds).applyMatrix4(root.matrixWorld));
        planned = meta.instances.length;
      };
      // Aborted (superseded, cleared or disposed): what streamed in goes at once.
      const hide = () => {
        if (streaming && streaming !== current?.root) {
          scene.remove(streaming);
        }
        requestRender();
      };
      controller.signal.addEventListener('abort', hide, { once: true });
      const onProgress = (progress: LoadProgress) => {
        if (progress.stage === 'geometry' || progress.stage === 'textures') {
          requestRender();
        }
        loadOptions.onProgress?.(progress);
      };
      try {
        const internal: InternalOptions = { ...loadOptions, signal: controller.signal, onProgress, [SHOW]: show };
        const result = await loadUsd(url, internal);
        // Superseded (or the viewer disposed) as geometry arrived: drop it.
        if (controller.signal.aborted || disposed) {
          result.dispose();
          throw new UsdLoadError('aborted', 'superseded by a newer load', { url });
        }
        current = result;
        if (!streaming) {
          scene.add(result.root);
        }
        if (result.info.meshes < planned || !planned) {
          frame(camera, controls, result.root);
        }
        requestRender();
        result.complete.then(requestRender, () => {});
        return result;
      } catch (error) {
        hide();
        throw error;
      } finally {
        if (pending === controller) {
          pending = null;
        }
      }
    },
    /**
     * An image of a freshly rendered frame, PNG by default, at the canvas size
     * or `width` x `height` (one given keeps the aspect ratio). Rendered and
     * read in the same task, so it needs no `preserveDrawingBuffer`.
     */
    toBlob({ type = 'image/png', quality, width, height } = {}) {
      if (disposed || renderer.getContext().isContextLost()) {
        return Promise.reject(new Error('no frame to capture: the viewer is disposed or its WebGL context is lost'));
      }
      const size = renderer.getSize(new THREE.Vector2());
      const ratio = renderer.getPixelRatio();
      const setSize = (w: number, h: number, pixelRatio: number) => {
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const resized = width || height;
      // One of the two is given: the other keeps the aspect ratio.
      if (resized) {
        setSize(width || Math.round(((height ?? 0) * size.x) / size.y), height || Math.round(((width ?? 0) * size.y) / size.x), 1);
      }
      renderer.render(scene, camera);
      const blob = new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the canvas could not be encoded'))), type, quality),
      );
      if (resized) {
        setSize(size.x, size.y, ratio);
        renderer.render(scene, camera);
      }
      return blob;
    },
    /** Removes and frees the current stage, and aborts any load in flight. */
    clear() {
      last = null;
      pending?.abort();
      clear();
    },
    /** Points the camera at `object`, by default the current stage. */
    frame(object = current?.root) {
      if (object) {
        frame(camera, controls, object);
      }
      requestRender();
    },
    /** Frees the renderer, the GPU context, the current stage and any load in flight. Safe to call twice. */
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      pending?.abort();
      if (current) {
        current.dispose();
      }
      current = null;
      observer.disconnect();
      canvas.removeEventListener('keydown', zoomKey);
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      controls.dispose();
      scene.environment?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (ownsCanvas) {
        canvas.remove();
      }
    },
  };
  return viewer;
}

/** Points the camera at the visible bounds of `object`. */
export function frame(camera: THREE.PerspectiveCamera, controls: OrbitControls | undefined, object: THREE.Object3D): void {
  frameBox(camera, controls, new THREE.Box3().setFromObject(object));
}

function frameBox(camera: THREE.PerspectiveCamera, controls: OrbitControls | undefined, box: THREE.Box3) {
  if (box.isEmpty()) {
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  // `fov` is vertical: on a view narrower than it is tall, fit the horizontal angle.
  const vertical = (camera.fov * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
  const distance = (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.05;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.6, 1).normalize(), distance);
  camera.lookAt(center);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls?.target.copy(center);
  controls?.update();
}
