// Prefetch-then-compose loading, shared by the Web Worker and the Node test.
//
// URLs are mapped to "virtual paths" (`/<host>/<path>`) that the Rust side
// anchors relative asset paths against; they are mapped back here to fetch.

export function urlToPath(url) {
  const u = new URL(url);
  return `/${u.host}${decodeURIComponent(u.pathname)}`;
}

export function pathToUrl(path, protocols) {
  const [, host, ...rest] = path.split('/');
  const protocol = protocols.get(host) || 'https:';
  return `${protocol}//${host}/${rest.map(encodeURIComponent).join('/')}`;
}

/**
 * Loads and composes the stage at `rootUrl`.
 *
 * @param {object} o
 * @param {typeof import('../wasm/usd_wasm.js').UsdLoader} o.UsdLoader
 * @param {(url: string) => Promise<Uint8Array | null>} o.fetchBytes  null when missing
 * @param {string} o.rootUrl
 * @param {boolean} [o.prefetchVariants]  also fetch layers named only inside variants
 * @param {(stage: string, detail?: object) => void} [o.onProgress]
 * @returns {Promise<{ scene: import('../wasm/usd_wasm.js').UsdScene, meta: object, stats: object, protocols: Map<string,string> }>}
 */
export async function composeStage({ UsdLoader, fetchBytes, rootUrl, prefetchVariants = false, onProgress = () => {} }) {
  const protocols = new Map([[new URL(rootUrl).host, new URL(rootUrl).protocol]]);
  const root = urlToPath(rootUrl);
  const loader = new UsdLoader();
  const stats = { layers: 0, layerBytes: 0, missing: 0, rounds: 0, fetchMs: 0, parseMs: 0, composeMs: 0, warnings: [] };
  const started = new Map();

  const fetchLayer = (path) => {
    if (loader.has(path) || started.has(path)) return started.get(path);
    const job = (async () => {
      const t0 = performance.now();
      const bytes = await fetchBytes(pathToUrl(path, protocols));
      stats.fetchMs = Math.max(stats.fetchMs, performance.now() - t0);
      if (!bytes) {
        stats.missing++;
        loader.markUnavailable(path);
        return;
      }
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
  return { scene, meta, stats, protocols };
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
 * maps. `full`: every map, including normals, up to `maxSize`.
 */
export function textureJobs(meta, { textures = 'preview', maxSize = 1024 } = {}) {
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
