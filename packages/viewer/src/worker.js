// Loads, composes and extracts a USD stage off the main thread, then streams
// textures as downscaled ImageBitmaps. One worker per load: the page
// terminates it when done, disposed or aborted, which releases all WASM memory.
import init, { UsdLoader } from '../wasm/usd_wasm.js';
import { composeStage, fetchLimited, limiter, takeGeometries, takePackagedTextures, textureJobs } from './load-core.js';

// Textures in flight at once (fetch and decode): decoding a large image
// briefly holds it at full size, so wide parallelism spikes memory.
const TEXTURE_CONCURRENCY = 4;

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
  const { url, wasmModule, maxTextureSize = 1024, textures = 'preview', maxConcurrentFetches = 16, maxLayerBytes = 2 ** 30, headers, proxyFetch } = data;
  // Every request, layer or texture, goes through here.
  const request = proxyFetch ? proxiedFetch : (target) => fetch(target, { headers });
  const fetchBytes = (target, budget) => fetchLimited(target, budget, { fetchFn: request });
  // Images stay a Blob (the browser may keep it off the JS heap) until decoded.
  const fetchBlob = async (target) => {
    const response = await request(target);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${target}`);
    return response.blob();
  };
  const progress = (p) => self.postMessage({ type: 'progress', progress: p });

  try {
    const t0 = performance.now();
    const wasm = await init({ module_or_path: wasmModule });
    const tInit = performance.now();

    const { scene, meta, stats } = await composeStage({
      UsdLoader,
      fetchBytes,
      rootUrl: url,
      maxConcurrentFetches,
      maxLayerBytes,
      onProgress: progress,
    });
    const geometries = takeGeometries(scene, meta);
    const packaged = takePackagedTextures(scene, meta);
    scene.free();
    stats.initMs = tInit - t0;
    stats.totalMs = performance.now() - t0;
    stats.wasmMemoryBytes = wasm.memory.buffer.byteLength;

    const transfer = [];
    for (const g of geometries) for (const a of [g.positions, g.normals, g.colors, g.indices, ...g.uvs]) if (a) transfer.push(a.buffer);
    self.postMessage({ type: 'scene', meta, geometries, stats }, transfer);

    const jobs = textureJobs(meta, { textures, maxSize: maxTextureSize });
    let loaded = 0;
    let bytes = 0;
    progress({ stage: 'textures', loaded, total: jobs.length, bytes });
    // The limiter runs jobs in order, so base colors come first.
    const throttle = limiter(Math.min(maxConcurrentFetches, TEXTURE_CONCURRENCY));
    await Promise.all(
      jobs.map(({ path, size }) =>
        throttle(async () => {
          try {
            const blob = packaged.has(path) ? new Blob([packaged.get(path)]) : await fetchBlob(path);
            bytes += blob.size;
            const bitmap = await decodeTexture(blob, size);
            self.postMessage({ type: 'texture', path, bitmap }, [bitmap]);
          } catch (error) {
            self.postMessage({ type: 'texture', path, error: String(error?.message || error) });
          }
          progress({ stage: 'textures', loaded: ++loaded, total: jobs.length, bytes });
        }),
      ),
    );
    self.postMessage({ type: 'done' });
  } catch (error) {
    // Fetch and resource-limit errors keep their code, url and status; anything
    // the WASM side throws is a composition failure.
    const { code = 'compose', url: failedUrl, status } = error ?? {};
    self.postMessage({ type: 'error', code, message: String(error?.message || error), url: failedUrl, status });
  }
};

/** Decodes an image straight to at most `maxSize` px on its long side. */
async function decodeTexture(blob, maxSize) {
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const size = imageSize(head);
  // USD texture coordinates put (0,0) at the bottom-left, three.js's default.
  const options = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  if (size) {
    const scale = Math.min(1, maxSize / Math.max(size.width, size.height));
    if (scale < 1) {
      options.resizeWidth = Math.max(1, Math.round(size.width * scale));
      options.resizeHeight = Math.max(1, Math.round(size.height * scale));
      options.resizeQuality = 'high';
    }
    return createImageBitmap(blob, options);
  }
  const full = await createImageBitmap(blob, options);
  const scale = Math.min(1, maxSize / Math.max(full.width, full.height));
  if (scale === 1) return full;
  const small = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(full.width * scale)),
    resizeHeight: Math.max(1, Math.round(full.height * scale)),
    resizeQuality: 'high',
  });
  full.close();
  return small;
}

/** Width and height from a PNG or JPEG header, without decoding. */
function imageSize(b) {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const length = (b[i + 2] << 8) | b[i + 3];
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + length;
    }
  }
  return null;
}
