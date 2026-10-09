// Prefetch-then-compose loading, shared by the Web Worker and the Node test.
//
// Layers are identified by absolute URL without a query, exactly as requested
// or as the Rust side resolved them from authored paths, and fetched by that
// URL. Only the root keeps its query (a signed URL, say) for fetching:
// relative references do not inherit it.
import { UsdLoadError } from './errors.js';

/**
 * Loads and composes the stage at `rootUrl`.
 *
 * @param {object} o
 * @param {typeof import('../wasm/usd_wasm.js').UsdLoader} o.UsdLoader
 * @param {(url: string, budget: (bytes: number) => void) => Promise<Uint8Array | null>} o.fetchBytes  null
 *   or a `fetch` UsdLoadError when missing. Calling `budget` with each chunk's size as it
 *   arrives throws once all layers together pass `maxLayerBytes`; a body never passed
 *   through it is charged whole when it returns.
 * @param {string} o.rootUrl  absolute
 * @param {boolean} [o.prefetchVariants]  also fetch layers named only inside variants
 * @param {number} [o.maxConcurrentFetches=16]  layer requests in flight at once
 * @param {number} [o.maxLayerBytes=1 GiB]  total size of the distinct layers held for composition
 * @param {(progress: { stage: 'layers', loaded: number, total: number, bytes: number } | { stage: 'compose', round: number }) => void} [o.onProgress]
 * @returns {Promise<{ scene: import('../wasm/usd_wasm.js').UsdScene, meta: object, stats: object }>}
 */
export async function composeStage({
  UsdLoader,
  fetchBytes,
  rootUrl,
  prefetchVariants = false,
  maxConcurrentFetches = 16,
  maxLayerBytes = 2 ** 30,
  onProgress = () => {},
}) {
  const root = rootUrl.split(/[?#]/)[0];
  const urlOf = (path) => (path === root ? rootUrl : path);
  const loader = new UsdLoader();
  const stats = { layers: 0, layerBytes: 0, missing: 0, rounds: 0, fetchMs: 0, parseMs: 0, composeMs: 0, warnings: [] };
  const started = new Map();
  const progress = () => onProgress({ stage: 'layers', loaded: stats.layers + stats.missing, total: started.size, bytes: stats.layerBytes });
  const throttle = limiter(maxConcurrentFetches);
  // One budget for every layer body, charged as its bytes arrive, so fetches
  // in parallel cannot each count on the whole remainder.
  let heldBytes = 0;
  const charge = (bytes, path) => {
    heldBytes += bytes;
    if (heldBytes > maxLayerBytes) throw resourceLimit(`layers exceed maxLayerBytes (${maxLayerBytes} bytes) at ${path}`);
  };
  // Re-fetched layers replace their earlier bytes, so count each path once.
  const layerSizes = new Map();

  const fetchLayer = (path) => {
    if (loader.has(path) || started.has(path)) return started.get(path);
    const job = (async () => {
      const t0 = performance.now();
      heldBytes -= layerSizes.get(path) ?? 0;
      layerSizes.delete(path);
      let charged = 0;
      const budget = (bytes) => {
        charged += bytes;
        charge(bytes, path);
      };
      // Any fetch failure, HTTP or network: the root fails the load, any
      // other layer is left out with a warning.
      let bytes = null;
      let failure = null;
      try {
        bytes = await throttle(() => fetchBytes(urlOf(path), budget));
      } catch (error) {
        heldBytes -= charged;
        // HTTP errors carry a status; network errors are TypeErrors (as from fetch).
        if (error?.status === undefined && !(error instanceof TypeError)) throw error;
        failure = error;
      }
      stats.fetchMs = Math.max(stats.fetchMs, performance.now() - t0);
      if (!bytes) {
        if (path === root) {
          const status = failure?.status ?? (failure ? undefined : 404);
          throw new UsdLoadError('fetch', `could not fetch ${rootUrl}${status ? ` (HTTP ${status})` : ''}`, { url: rootUrl, status, cause: failure ?? undefined });
        }
        stats.missing++;
        stats.warnings.push({ code: 'layer-missing', message: `layer not found: ${failure?.message ?? urlOf(path)}`, path: urlOf(path) });
        loader.markUnavailable(path);
        progress();
        return;
      }
      charge(bytes.byteLength - charged, path);
      layerSizes.set(path, bytes.byteLength);
      stats.layers++;
      stats.layerBytes += bytes.byteLength;
      const t1 = performance.now();
      let deps;
      try {
        deps = loader.addLayer(path, bytes);
      } catch (error) {
        // An unreadable layer is left out; composition carries on without it.
        stats.warnings.push({ code: 'layer-unreadable', message: String(error.message || error), path: urlOf(path) });
        loader.markUnavailable(path);
        progress();
        return;
      } finally {
        stats.parseMs += performance.now() - t1;
      }
      progress();
      await Promise.all(
        deps
          .filter((d) => d[0] === 'L' || (prefetchVariants && d[0] === 'V'))
          .map((d) => fetchLayer(d.slice(1))),
      );
    })();
    started.set(path, job);
    return job;
  };

  await fetchLayer(root);
  if (!loader.has(root)) throw new UsdLoadError('compose', `could not read ${rootUrl}`, { url: rootUrl });

  for (;;) {
    stats.rounds++;
    onProgress({ stage: 'compose', round: stats.rounds });
    const t0 = performance.now();
    const missing = loader.compose(root);
    stats.composeMs += performance.now() - t0;
    if (!missing.length) break;
    if (stats.rounds > 16) throw new UsdLoadError('compose', `composition still missing layers: ${missing.join(', ')}`);
    // The list also names layers the failed attempt consumed; fetch them again.
    for (const path of missing) started.delete(path);
    await Promise.all(missing.map(fetchLayer));
  }
  const scene = loader.takeScene();
  loader.free();
  const meta = JSON.parse(scene.meta());
  return { scene, meta, stats };
}

function resourceLimit(detail) {
  return new UsdLoadError('fetch', `resource limit exceeded: ${detail}`);
}

/** Runs at most `max` of the given tasks at once. */
export function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

/**
 * Fetches a body, passing each chunk's size to `budget` as it arrives and
 * giving up (cancelling the body) when `budget` throws. An HTTP error throws a
 * `fetch` UsdLoadError carrying the status. `fetchFn` is the global fetch or a
 * stand-in with the same contract.
 */
export async function fetchLimited(url, budget, { fetchFn = fetch } = {}) {
  const response = await fetchFn(url);
  if (!response.ok) throw new UsdLoadError('fetch', `HTTP ${response.status} for ${url}`, { url, status: response.status });
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    try {
      budget(value.byteLength);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    size += value.byteLength;
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Whether `url` has the origin of `root`: only those requests carry the caller's headers. */
export function sameOrigin(url, root) {
  const origin = new URL(url).origin;
  return origin !== 'null' && origin === new URL(root).origin;
}

/** Moves every geometry's arrays out of WASM into JS typed arrays. */
export function takeGeometries(scene, meta) {
  return meta.geometries.map((g, i) => ({
    positions: scene.positions(i),
    normals: scene.normals(i),
    uvs: g.uvSets.map((_, k) => scene.uvs(i, k)),
    colors: g.hasColors ? scene.colors(i) : null,
    indices: g.vertices < 65536 ? scene.indices16(i) : scene.indices(i),
  }));
}

/** Textures stored inside a USDZ package, by path: they cannot be fetched by URL. */
export function takePackagedTextures(scene, meta) {
  const out = new Map();
  for (const { path } of textureJobs(meta, { textures: 'full' })) {
    if (!path.includes('[')) continue;
    const bytes = scene.packagedFile(path);
    if (bytes) out.set(path, bytes);
  }
  return out;
}

/** Long-side cap for data maps (roughness, metallic, occlusion, ...) in `preview` mode. */
const PREVIEW_DATA_SIZE = 512;

/**
 * The texture files to load and the size to decode each to, base colors first.
 * `preview`: base color up to `maxSize`, other maps up to 512 px, no normal
 * maps. `full`: every map, including normals, up to `maxSize`. `none`: nothing.
 */
export function textureJobs(meta, { textures = 'preview', maxSize = 1024 } = {}) {
  if (textures === 'none') return [];
  const full = textures === 'full';
  const dataSize = full ? maxSize : Math.min(maxSize, PREVIEW_DATA_SIZE);
  const tiers = [
    [['diffuseColor'], maxSize],
    [['opacity', 'emissiveColor', 'roughness', 'metallic', 'occlusion'], dataSize],
    [full ? ['normal'] : [], maxSize],
  ];
  const jobs = new Map();
  for (const [inputs, size] of tiers) {
    for (const m of meta.materials) {
      for (const input of inputs) {
        const path = m.maps[input]?.path;
        // A file shared by several inputs is decoded once, at the largest size asked.
        if (path) jobs.set(path, Math.max(jobs.get(path) ?? 0, size));
      }
    }
  }
  return [...jobs].map(([path, size]) => ({ path, size }));
}
