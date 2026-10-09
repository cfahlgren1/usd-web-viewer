// Prefetch-then-compose loading, shared by the Web Worker and the Node test.
//
// Layers are identified by absolute URL without a query, exactly as requested
// or as the Rust side resolved them from authored paths, and fetched by that
// URL. Only the root keeps its query (a signed URL, say) for fetching:
// relative references do not inherit it.

/**
 * Loads and composes the stage at `rootUrl`.
 *
 * @param {object} o
 * @param {typeof import('../wasm/usd_wasm.js').UsdLoader} o.UsdLoader
 * @param {(url: string, maxBytes: number) => Promise<Uint8Array | null>} o.fetchBytes  null when
 *   missing; may stop reading once a body passes `maxBytes`
 * @param {string} o.rootUrl  absolute
 * @param {boolean} [o.prefetchVariants]  also fetch layers named only inside variants
 * @param {number} [o.maxConcurrentFetches=16]  layer requests in flight at once
 * @param {number} [o.maxLayerBytes=1 GiB]  total size of the distinct layers held for composition
 * @param {(stage: string, detail?: object) => void} [o.onProgress]
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
  const throttle = limiter(maxConcurrentFetches);
  // Re-fetched layers replace their earlier bytes, so count each path once.
  const layerSizes = new Map();
  let heldBytes = 0;

  const fetchLayer = (path) => {
    if (loader.has(path) || started.has(path)) return started.get(path);
    const job = (async () => {
      const t0 = performance.now();
      const remaining = maxLayerBytes - heldBytes + (layerSizes.get(path) ?? 0);
      const bytes = await throttle(() => fetchBytes(urlOf(path), remaining));
      stats.fetchMs = Math.max(stats.fetchMs, performance.now() - t0);
      if (!bytes) {
        stats.missing++;
        loader.markUnavailable(path);
        return;
      }
      heldBytes += bytes.byteLength - (layerSizes.get(path) ?? 0);
      layerSizes.set(path, bytes.byteLength);
      if (heldBytes > maxLayerBytes) throw resourceLimit(`layers exceed maxLayerBytes (${maxLayerBytes} bytes) at ${path}`);
      stats.layers++;
      stats.layerBytes += bytes.byteLength;
      const t1 = performance.now();
      let deps;
      try {
        deps = loader.addLayer(path, bytes);
      } catch (error) {
        // An unreadable layer is left out; composition carries on without it.
        stats.warnings.push(`${path}: ${error.message || error}`);
        loader.markUnavailable(path);
        return;
      } finally {
        stats.parseMs += performance.now() - t1;
      }
      onProgress('layer', { path, bytes: bytes.byteLength });
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
  if (!loader.has(root)) throw new Error(`could not fetch ${rootUrl}`);

  for (;;) {
    stats.rounds++;
    const t0 = performance.now();
    const missing = loader.compose(root);
    stats.composeMs += performance.now() - t0;
    if (!missing.length) break;
    if (stats.rounds > 16) throw new Error(`composition still missing layers: ${missing.join(', ')}`);
    onProgress('missing', { missing });
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
  return new Error(`resource limit exceeded: ${detail}`);
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

/** Fetches a body, giving up once it passes `maxBytes`; null on an HTTP error. */
export async function fetchLimited(url, maxBytes) {
  const response = await fetch(url);
  if (!response.ok) return null;
  const tooBig = () => resourceLimit(`${url} is larger than ${maxBytes} bytes`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw tooBig();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooBig();
    }
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

/** Moves every geometry's arrays out of WASM into JS typed arrays. */
export function takeGeometries(scene, meta) {
  return meta.geometries.map((g, i) => ({
    positions: scene.positions(i),
    normals: scene.normals(i),
    uvs: g.hasUvs ? scene.uvs(i) : null,
    indices: g.vertices < 65536 ? scene.indices16(i) : scene.indices(i),
  }));
}

/** Textures stored inside a USDZ package, by path: they cannot be fetched by URL. */
export function takePackagedTextures(scene, meta) {
  const out = new Map();
  for (const path of texturePaths(meta, { normalMaps: true })) {
    if (!path.includes('[')) continue;
    const bytes = scene.packagedFile(path);
    if (bytes) out.set(path, bytes);
  }
  return out;
}

/** Distinct texture files the materials sample, base color first. */
export function texturePaths(meta, { normalMaps = false } = {}) {
  const paths = [];
  for (const m of meta.materials) if (m.colorMap && !paths.includes(m.colorMap.path)) paths.push(m.colorMap.path);
  if (normalMaps) for (const m of meta.materials) if (m.normalMap && !paths.includes(m.normalMap.path)) paths.push(m.normalMap.path);
  return paths;
}
