// Loads, composes and extracts a USD stage off the main thread, then streams
// textures as downscaled ImageBitmaps. One worker per load: the page
// terminates it when done, disposed or aborted, which releases all WASM memory.
import init, { lastPanic, UsdLoader } from '../wasm/usd_wasm.js';
import { hubPackageLayers } from './hub-prefetch.js';
import { canonicalUrl, composeStage, fetchLimited, fetchWithPolicy, imageInfo, limiter, loadFailure, readGeometries, requestPolicy, takePackagedTextures, textureJobs } from './load-core.js';

// Textures in flight at once (fetch and decode): decoding a large image
// briefly holds it at full size, so wide parallelism spikes memory.
const TEXTURE_CONCURRENCY = 4;
// Longest side of an image read at all: larger ones are refused from their
// header, before decoding (WebGL's own limit is commonly 16384 too).
const MAX_IMAGE_SIZE = 16384;

// Requests answered by the page, for a caller-supplied `fetch`. The page sends
// the body one chunk per pull, so byte budgets apply as it arrives and
// cancelling the body stops the caller's read.
const replies = new Map();
const pulls = new Map();
let nextId = 0;

/** A fetch that asks the page (which runs the caller's `fetch`) and streams its reply. */
function proxiedFetch(url) {
  const id = nextId++;
  self.postMessage({ type: 'fetch', id, url });
  return new Promise((resolve) => replies.set(id, resolve)).then(({ ok, status, error }) => {
    // A network failure in the caller's fetch reads like one from fetch itself.
    if (error) throw new TypeError(error);
    if (!ok) return new Response(null, { status: status || 500 });
    const body = new ReadableStream(
      {
        pull: (controller) =>
          new Promise((resolve) => {
            pulls.set(id, { controller, resolve });
            self.postMessage({ type: 'pull', id });
          }),
        cancel: () => self.postMessage({ type: 'cancel', id }),
      },
      { highWaterMark: 0 },
    );
    return new Response(body);
  });
}

/** Delivers one chunk (or the end, or a failure) of a proxied body. */
function receiveChunk({ id, chunk, done, error }) {
  const { controller, resolve } = pulls.get(id);
  pulls.delete(id);
  if (error) controller.error(new TypeError(error));
  else if (done) controller.close();
  else controller.enqueue(new Uint8Array(chunk));
  resolve();
}

self.onmessage = async ({ data }) => {
  if (data.type === 'fetched') {
    replies.get(data.id)?.(data);
    replies.delete(data.id);
    return;
  }
  if (data.type === 'chunk') return receiveChunk(data);
  const { url, wasmModule, maxTextureSize = 1024, textures = 'preview', maxConcurrentFetches = 16, maxLayerBytes, maxTextureBytes = 512 * 2 ** 20, maxLayers, maxInstances, maxTriangles, allowedOrigins, headers, proxyFetch } = data;
  // Every request (layer, texture, Hub listing) goes through here, and
  // through the request policy first. The caller's headers go only where
  // cookies may, and never through a redirect off the Hub; a custom fetch on
  // the page applies the same policy.
  const request = async (target) => {
    target = canonicalUrl(target);
    const policy = requestPolicy(target, url, allowedOrigins);
    // Reads like a network failure: a missing layer or a failed texture.
    if (policy.refused) throw new TypeError(`request refused: ${policy.refused}`);
    if (proxyFetch) return proxiedFetch(target);
    return fetchWithPolicy(fetch, target, policy, headers);
  };
  const fetchBytes = (target, budget) => fetchLimited(target, budget, { fetchFn: request });
  // One budget for every texture, packaged ones first, then each fetched
  // body as its bytes arrive. Bytes of a body cut short stay charged: they
  // were downloaded.
  let textureBytes = 0;
  const chargeTexture = (bytes) => {
    textureBytes += bytes;
    if (textureBytes > maxTextureBytes) throw new Error(`textures exceed maxTextureBytes (${maxTextureBytes} bytes)`);
  };
  const progress = (p) => self.postMessage({ type: 'progress', progress: p });

  let wasmMemory;
  try {
    const t0 = performance.now();
    const preload = hubPackageLayers(url, request);
    const wasm = await init({ module_or_path: wasmModule });
    wasmMemory = wasm.memory;
    const tInit = performance.now();

    const { scene, meta, stats } = await composeStage({
      UsdLoader,
      fetchBytes,
      rootUrl: url,
      maxConcurrentFetches,
      maxLayerBytes,
      maxLayers,
      maxInstances,
      allowedOrigins,
      preload,
      onProgress: progress,
    });
    stats.initMs = tInit - t0;
    self.postMessage({ type: 'meta', meta });
    // One mesh at a time: each is transferred (not copied) as soon as it is read.
    const onGeometry = (index, g, arrays) => {
      const transfer = arrays ? [arrays.positions, arrays.normals, arrays.colors, arrays.indices, ...arrays.uvs].filter(Boolean).map((a) => a.buffer) : [];
      self.postMessage({ type: 'geometry', index, meta: g, arrays }, transfer);
      progress({ stage: 'geometry', loaded: index + 1, total: meta.geometryCount });
    };
    const warnings = readGeometries(scene, meta, onGeometry, { maxTriangles });
    const jobs = textureJobs(meta, { textures, maxSize: maxTextureSize });
    const packaged = takePackagedTextures(scene, jobs, { maxBytes: maxTextureBytes });
    for (const entry of packaged.values()) if (!(entry instanceof Error)) textureBytes += entry.byteLength;
    scene.free();
    stats.warnings.push(...warnings);
    stats.totalMs = performance.now() - t0;
    stats.wasmMemoryBytes = wasm.memory.buffer.byteLength;
    self.postMessage({ type: 'scene', stats });

    let loaded = 0;
    let bytes = 0;
    progress({ stage: 'textures', loaded, total: jobs.length, bytes });
    // The limiter runs jobs in order, so base colors come first.
    const throttle = limiter(Math.min(maxConcurrentFetches, TEXTURE_CONCURRENCY));
    await Promise.all(
      jobs.map(({ path, size }) =>
        throttle(async () => {
          try {
            const entry = packaged.get(path);
            if (entry instanceof Error) throw entry;
            // A packaged path is never a URL to fetch.
            if (!entry && path.includes('[')) throw new Error(`not found in its package: ${path}`);
            const image = entry ?? (await fetchBytes(path, chargeTexture));
            bytes += image.byteLength;
            const { bitmap, color } = await decodeTexture(image, size);
            self.postMessage({ type: 'texture', path, bitmap, color }, [bitmap]);
          } catch (error) {
            self.postMessage({ type: 'texture', path, error: String(error?.message || error) });
          }
          progress({ stage: 'textures', loaded: ++loaded, total: jobs.length, bytes });
        }),
      ),
    );
    self.postMessage({ type: 'done' });
  } catch (error) {
    self.postMessage({ type: 'error', ...loadFailure(error, wasmMemory?.buffer.byteLength ?? 0, lastPanic) });
  }
};

/**
 * Decodes a PNG, JPEG or WebP straight to at most `maxSize` px on its long
 * side, and tells whether it holds color (what `sourceColorSpace = "auto"`
 * decodes as sRGB). Images whose size the header does not give, or that are
 * too large, are refused before decoding.
 */
async function decodeTexture(bytes, maxSize) {
  const info = imageInfo(bytes);
  if (!info) throw new Error('unsupported image format: only PNG, JPEG and WebP are read');
  if (Math.max(info.width, info.height) > MAX_IMAGE_SIZE) throw new Error(`image too large: ${info.width}x${info.height} (at most ${MAX_IMAGE_SIZE} px a side)`);
  // USD texture coordinates put (0,0) at the bottom-left, three.js's default.
  const options = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  const scale = Math.min(1, maxSize / Math.max(info.width, info.height));
  if (scale < 1) {
    options.resizeWidth = Math.max(1, Math.round(info.width * scale));
    options.resizeHeight = Math.max(1, Math.round(info.height * scale));
    options.resizeQuality = 'high';
  }
  return { bitmap: await createImageBitmap(new Blob([bytes]), options), color: info.color };
}
