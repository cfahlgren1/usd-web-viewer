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
 * @param {number} [o.maxLayerBytes=768 MiB]  total size of the distinct layers held for composition
 * @param {number} [o.maxLayers=1024]  distinct layer files requested
 * @param {string[]} [o.allowedOrigins]  see {@link originAllowed}; layers elsewhere are left out with a warning
 * @param {Promise<{ layers: { url: string, size: number }[], eager: boolean }>} [o.preload]  layers likely
 *   to be needed: fetched ahead at lower priority, right away if `eager` or else once the root names a
 *   dependency, and used only if composition asks for them
 * @param {(progress: { stage: 'layers', loaded: number, total: number, bytes: number } | { stage: 'compose', round: number }) => void} [o.onProgress]
 * @returns {Promise<{ scene: import('../wasm/usd_wasm.js').UsdScene, meta: object, stats: object }>}
 */
export async function composeStage({
  UsdLoader,
  fetchBytes,
  rootUrl,
  prefetchVariants = false,
  maxConcurrentFetches = 16,
  maxLayerBytes = 768 * 2 ** 20,
  maxLayers = 1024,
  allowedOrigins,
  preload,
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
  // Speculative fetches by URL, dropped once composition is done. One that
  // has not started when its layer is asked for, or that failed, gives way to
  // the regular fetch, so the result is the same as without them.
  const preloaded = new Map();
  let composed = false;
  const startPreload = (layers) => {
    const requested = new Set([...started.keys()].map(urlKey));
    let bytes = 0;
    for (const { url, size } of layers) {
      const key = urlKey(url);
      bytes += size;
      if (composed || bytes > maxLayerBytes) break;
      if (requested.has(key) || preloaded.has(key)) continue;
      const entry = { started: false };
      preloaded.set(key, entry);
      entry.bytes = throttle(async () => {
        if (composed || preloaded.get(key) !== entry) return null;
        entry.started = true;
        return fetchBytes(url, () => {
          if (composed) throw new Error('composed without it');
        });
      }, { later: true }).catch(() => null);
    }
  };
  const takePreloaded = (path) => {
    const entry = preloaded.get(urlKey(path));
    preloaded.delete(urlKey(path));
    return entry?.started ? entry.bytes : null;
  };

  // Jobs in flight. A job queues its dependencies here rather than awaiting
  // them, so layers that reference each other cannot wait on each other.
  const pending = [];
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const requested = new Set();
  const fetchLayer = (path) => {
    if (loader.has(path) || started.has(path)) return;
    requested.add(path);
    if (requested.size > maxLayers) throw resourceLimit(`more than maxLayers (${maxLayers}) layer files at ${path}`);
    if (!originAllowed(urlOf(path), rootUrl, allowedOrigins)) {
      started.set(path, Promise.resolve());
      stats.missing++;
      stats.warnings.push({ code: 'layer-missing', message: `layer not fetched: its origin is not in allowedOrigins: ${path}`, path });
      loader.markUnavailable(path);
      progress();
      return;
    }
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
        const preloadedBytes = takePreloaded(path);
        bytes = (preloadedBytes && (await preloadedBytes)) ?? (await throttle(() => fetchBytes(urlOf(path), budget)));
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
        // After a trap the module is unusable: the load fails.
        if (isTrap(error)) throw error;
        // An unreadable layer is left out; composition carries on without it.
        stats.warnings.push({ code: 'layer-unreadable', message: String(error.message || error), path: urlOf(path) });
        loader.markUnavailable(path);
        progress();
        return;
      } finally {
        stats.parseMs += performance.now() - t1;
      }
      progress();
      for (const d of deps) if (d[0] === 'L' || (prefetchVariants && d[0] === 'V')) fetchLayer(d.slice(1));
    })();
    started.set(path, job);
    pending.push(job);
  };

  fetchLayer(root);
  // A root without dependencies needs nothing else from its directory.
  const rootHasDependencies = () => started.get(root).then(() => started.size > 1, () => false);
  preload?.then(async ({ layers, eager }) => (eager || (await rootHasDependencies())) && startPreload(layers));
  await drain();
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
    missing.forEach(fetchLayer);
    await drain();
  }
  composed = true;
  const scene = loader.takeScene();
  loader.free();
  const meta = JSON.parse(scene.meta());
  return { scene, meta, stats };
}

/**
 * What the page is told about a failed load. Fetch and resource-limit errors
 * keep their code, url and status; anything the WASM side throws is a
 * composition failure. Running out of WASM memory (4 GiB at most) reads as a
 * scene too large to load: an allocation that fails while reading a layer
 * reports "out of memory", one that aborts traps as `unreachable`. A Rust
 * panic, which also traps as `unreachable`, gives its message, read with
 * `lastPanic` (the module's export). Overflowing the stack, the WASM one (an
 * out-of-bounds access) or the engine's, means layers nested too deeply to read.
 */
export function loadFailure(error, wasmMemoryBytes, lastPanic) {
  const { code = 'compose', url, status } = error ?? {};
  const message = String(error?.message || error);
  const failure = (detail) => ({ code, message: detail, url, status });
  if (code !== 'compose') return failure(message);
  if (/out of memory|memory allocation/i.test(message) || (error instanceof WebAssembly.RuntimeError && wasmMemoryBytes > 3 * 2 ** 30)) {
    const gib = (wasmMemoryBytes / 2 ** 30).toFixed(1);
    return failure(`scene too large to load: ran out of memory (${gib} GiB of WebAssembly memory in use): ${message}`);
  }
  if (!isTrap(error)) return failure(message);
  const panic = readPanic(lastPanic);
  if (panic) return failure(`${message}: ${panic}`);
  if (/out of bounds|call stack|recursion/i.test(message)) return failure(`stack overflow: the layers nest too deeply to read (${message})`);
  return failure(message);
}

/** Reading the panic calls into the trapped module, which can trap again (an exhausted stack does). */
function readPanic(lastPanic) {
  try {
    return lastPanic?.();
  } catch {
    return undefined;
  }
}

/** A WebAssembly trap or an exhausted engine call stack: the module is no longer usable. */
function isTrap(error) {
  return error instanceof WebAssembly.RuntimeError || error instanceof RangeError || error?.name === 'InternalError';
}

function resourceLimit(detail) {
  return new UsdLoadError('fetch', `resource limit exceeded: ${detail}`);
}

/** Runs at most `max` of the given tasks at once; tasks marked `later` wait for the others. */
export function limiter(max) {
  let active = 0;
  const queue = [];
  const later = [];
  const next = () => {
    if (active >= max || !(queue.length || later.length)) return;
    active++;
    const { task, resolve, reject } = queue.shift() ?? later.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (task, { later: low = false } = {}) =>
    new Promise((resolve, reject) => {
      (low ? later : queue).push({ task, resolve, reject });
      next();
    });
}

/** A layer URL as fetch would spell it, so an authored `a b.usd` matches a listed `a%20b.usd`. */
function urlKey(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
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

/**
 * Size of a PNG or JPEG from its header, without decoding, and whether it is
 * color: 8-bit RGB(A) or palette, rather than greyscale or 16-bit data (the
 * images `sourceColorSpace = "auto"` decodes as sRGB). Null for other formats.
 */
export function imageInfo(b) {
  if (b.length > 25 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset);
    const [bitDepth, colorType] = [b[24], b[25]];
    const color = colorType === 3 || (bitDepth === 8 && (colorType === 2 || colorType === 6));
    return { width: v.getUint32(16), height: v.getUint32(20), color };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const length = (b[i + 2] << 8) | b[i + 3];
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], color: b[i + 4] === 8 && b[i + 9] >= 3 };
      i += 2 + length;
    }
  }
  return null;
}

const HUB_HOST = /(^|\.)(huggingface\.co|hf\.co)$/;
const isHub = ({ protocol, hostname }) => protocol === 'https:' && HUB_HOST.test(hostname);

/**
 * Whether a load rooted at `rootUrl` may fetch `url`: anything on the root's
 * origin or in `allowedOrigins` (`'*'` allows any), and for a root on the
 * Hugging Face Hub the Hub's hosts and their CDNs. Fetches follow redirects
 * without a check, so only the requested URL counts.
 */
export function originAllowed(url, rootUrl, allowedOrigins = []) {
  try {
    const target = new URL(url);
    const root = new URL(rootUrl);
    return target.origin === root.origin || allowedOrigins.includes('*') || allowedOrigins.includes(target.origin) || (isHub(root) && isHub(target));
  } catch {
    return false;
  }
}

/** Whether `url` has the origin of `root`: only those requests carry the caller's headers. */
export function sameOrigin(url, root) {
  const origin = new URL(url).origin;
  return origin !== 'null' && origin === new URL(root).origin;
}

/**
 * Reads each geometry out of WASM in turn, so only one mesh's arrays are in
 * WASM memory at a time, and calls `onGeometry(index, meta, arrays)` with
 * JS-owned typed arrays (`meta` and `arrays` are null for a mesh with nothing
 * drawable). Releases the stage afterwards. Returns warnings: a
 * `nothing-drawable` one when no mesh had anything to draw.
 */
export function readGeometries(scene, meta, onGeometry) {
  let drawn = 0;
  for (let i = 0; i < meta.geometryCount; i++) {
    const json = scene.read(i);
    if (!json) {
      onGeometry(i, null, null);
      continue;
    }
    drawn++;
    const g = JSON.parse(json);
    onGeometry(i, g, {
      positions: scene.positions(),
      normals: scene.normals(),
      uvs: g.uvSets.map((_, k) => scene.uvs(k)),
      colors: g.hasColors ? scene.colors() : null,
      indices: g.vertices < 65536 ? scene.indices16() : scene.indices(),
    });
  }
  scene.finish();
  if (drawn) return [];
  return [{ code: 'nothing-drawable', message: 'nothing to draw: the stage has no visible meshes with geometry' }];
}

/**
 * Images stored inside a USDZ package (they cannot be fetched by URL) that the
 * texture mode loads, each read once, by path. One that cannot be read maps
 * to its error, so it fails as that texture rather than the whole load.
 */
export function takePackagedTextures(scene, meta, { textures = 'preview' } = {}) {
  const out = new Map();
  for (const { path } of textureJobs(meta, { textures })) {
    if (!path.includes('[')) continue;
    try {
      const bytes = scene.packagedFile(path);
      if (bytes) out.set(path, bytes);
    } catch (error) {
      out.set(path, error);
    }
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
