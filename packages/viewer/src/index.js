import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const WASM_URL = new URL('../wasm/usd_wasm_bg.wasm', import.meta.url);
const WORKER_URL = new URL('./worker.js', import.meta.url);

let wasmModule = null;

/** Compiles the WASM module once per page; workers instantiate it without refetching. */
function compileWasm(url = WASM_URL) {
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
 * @param {object} [options]
 * @param {number} [options.maxTextureSize=1024]  long-side cap for decoded textures
 * @param {boolean} [options.normalMaps=false]  also load normal maps
 * @param {boolean} [options.prefetchVariants=false]  fetch layers named inside variants before composing
 * @param {number} [options.maxConcurrentFetches=16]  requests in flight at once
 * @param {number} [options.maxLayerBytes=1 GiB]  total size of the distinct USD layers fetched before giving up
 * @param {() => void} [options.onTexture]  called after each texture is applied
 * @param {string | URL} [options.wasmUrl]  override where the WASM binary lives
 * @returns {Promise<{ root: THREE.Group, info: object, textures: Promise<void>, dispose: () => void }>}
 *   `dispose` also stops any textures still streaming and settles `textures`.
 */
export async function loadUsd(url, options = {}) {
  const { maxTextureSize = 1024, normalMaps = false, prefetchVariants = false, maxConcurrentFetches, maxLayerBytes, onTexture = () => {} } = options;
  const absoluteUrl = new URL(url, location.href).href;
  const module = await compileWasm(options.wasmUrl);
  const worker = new Worker(WORKER_URL, { type: 'module' });

  let resolveScene, rejectScene, resolveTextures;
  const scenePromise = new Promise((resolve, reject) => ((resolveScene = resolve), (rejectScene = reject)));
  const textures = new Promise((resolve) => (resolveTextures = resolve));
  let built = null;
  let disposed = false;
  const finish = () => {
    worker.terminate();
    resolveTextures();
  };

  worker.onmessage = ({ data }) => {
    // Messages already queued when the model was disposed.
    if (disposed) {
      data.bitmap?.close();
      return;
    }
    switch (data.type) {
      case 'scene':
        built = buildScene(data.meta, data.geometries, normalMaps);
        built.info.stats = data.stats;
        resolveScene(built);
        break;
      case 'texture':
        if (data.bitmap && built) {
          built.applyTexture(data.path, data.bitmap);
          onTexture();
        } else if (data.error && built) {
          built.info.textureErrors.push(`${data.path}: ${data.error}`);
        }
        break;
      case 'done':
        finish();
        break;
      case 'error':
        rejectScene(new Error(data.message));
        finish();
        break;
    }
  };
  worker.onerror = (event) => {
    rejectScene(new Error(event.message || 'worker failed to start'));
    finish();
  };
  worker.postMessage({ url: absoluteUrl, wasmModule: module, maxTextureSize, normalMaps, prefetchVariants, maxConcurrentFetches, maxLayerBytes });

  const scene = await scenePromise;
  const dispose = () => {
    disposed = true;
    finish();
    scene.dispose();
  };
  return { root: scene.root, info: scene.info, textures, dispose };
}

function buildScene(meta, arrays, normalMaps) {
  const root = new THREE.Group();
  root.name = 'usd';
  // three.js is Y-up in meters.
  if (meta.upAxis === 'Z') root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(meta.metersPerUnit || 1);

  const materials = meta.materials.map((m) => createMaterial(m));
  const doubleSided = new Map();
  const materialFor = (index, sided) => {
    if (!sided) return materials[index];
    if (!doubleSided.has(index)) {
      const copy = materials[index].clone();
      copy.side = THREE.DoubleSide;
      copy.userData = materials[index].userData;
      doubleSided.set(index, copy);
    }
    return doubleSided.get(index);
  };

  const geometries = meta.geometries.map((g, i) => {
    const a = arrays[i];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3));
    if (a.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(a.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(a.indices, 1));
    if (g.groups.length > 1) g.groups.forEach(([start, count], j) => geometry.addGroup(start, count, j));
    return geometry;
  });

  for (const inst of meta.instances) {
    const geometry = geometries[inst.geometry];
    const mats = inst.materials.map((m) => materialFor(m, inst.doubleSided));
    const mesh = new THREE.Mesh(geometry, mats.length > 1 ? mats : mats[0]);
    mesh.name = inst.path;
    // USD stores row-vector matrices row-major: the same numbers column-major for three.js.
    // Set whole rather than decomposed, which would lose shear.
    mesh.matrix.fromArray(inst.matrix);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    root.add(mesh);
  }

  const allMaterials = () => [...materials, ...doubleSided.values()];
  const textures = new Map();
  const applyTexture = (path, bitmap) => {
    const base = new THREE.Texture(bitmap);
    base.flipY = false;
    base.wrapS = base.wrapT = THREE.RepeatWrapping;
    base.anisotropy = 4;
    textures.set(path, base);
    for (const material of allMaterials()) {
      const { colorMap, normalMap } = material.userData.usd;
      if (colorMap?.path === path) {
        material.map = configure(base, colorMap, THREE.SRGBColorSpace);
        material.needsUpdate = true;
      }
      if (normalMaps && normalMap?.path === path) {
        material.normalMap = configure(base, normalMap, THREE.NoColorSpace);
        material.needsUpdate = true;
      }
    }
  };
  const configure = (base, ref, colorSpace) => {
    const [sx, sy] = ref.scale ?? [1, 1];
    const [tx, ty] = ref.translation ?? [0, 0];
    const angle = ((ref.rotation ?? 0) * Math.PI) / 180;
    const identity = sx === 1 && sy === 1 && tx === 0 && ty === 0 && angle === 0;
    const texture = identity && !ref.wrapS && !ref.wrapT && base.colorSpace === colorSpace ? base : base.clone();
    texture.colorSpace = colorSpace;
    // `black` has no three.js equivalent (no border color); clamp is closest.
    const wrap = (token) => ({ mirror: THREE.MirroredRepeatWrapping, clamp: THREE.ClampToEdgeWrapping, black: THREE.ClampToEdgeWrapping })[token] ?? THREE.RepeatWrapping;
    texture.wrapS = wrap(ref.wrapS);
    texture.wrapT = wrap(ref.wrapT);
    if (!identity) {
      // UsdTransform2d: st' = rotate(st * scale) + translation (counterclockwise degrees).
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      texture.matrixAutoUpdate = false;
      texture.matrix.set(c * sx, -s * sy, tx, s * sx, c * sy, ty, 0, 0, 1);
    }
    texture.needsUpdate = true;
    return texture;
  };

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
    for (const m of allMaterials()) {
      m.map?.dispose();
      m.normalMap?.dispose();
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
  return { root, info, applyTexture, dispose };
}

function createMaterial(m) {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(m.color[0], m.color[1], m.color[2], THREE.LinearSRGBColorSpace),
    roughness: m.roughness,
    metalness: m.metallic,
    emissive: new THREE.Color().setRGB(m.emissive[0], m.emissive[1], m.emissive[2], THREE.LinearSRGBColorSpace),
  });
  if (m.opacity < 1) {
    material.transparent = true;
    material.opacity = m.opacity;
    material.depthWrite = false;
  }
  material.name = m.path;
  material.userData.usd = { kind: m.kind, colorMap: m.colorMap, normalMap: m.normalMap };
  return material;
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
