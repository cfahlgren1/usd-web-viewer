// Loads, composes and extracts a USD stage off the main thread, then streams
// textures as downscaled ImageBitmaps. One worker per load: the page
// terminates it when done (or aborted), which releases all WASM memory.
import init, { UsdLoader } from '../wasm/usd_wasm.js';
import { composeStage, pathToUrl, takeGeometries, takePackagedTextures, texturePaths } from './load-core.js';

// Fetches proxied through the page, for a caller-supplied `fetch`.
const proxied = new Map();
let nextId = 0;

self.onmessage = async ({ data }) => {
  if (data.type === 'fetched') {
    proxied.get(data.id)?.(data);
    proxied.delete(data.id);
    return;
  }
  const { url, wasmModule, maxTextureSize = 1024, normalMaps = false, prefetchVariants = false, headers, proxyFetch } = data;
  // Every request goes through here: the caller's headers, or the page's fetch.
  const request = (target) => {
    if (!proxyFetch) {
      return fetch(target, { headers }).then(async (r) => ({ ok: r.ok, status: r.status, buffer: r.ok ? await r.arrayBuffer() : null }));
    }
    const id = nextId++;
    self.postMessage({ type: 'fetch', id, url: target });
    return new Promise((resolve) => proxied.set(id, resolve));
  };
  const progress = (p) => self.postMessage({ type: 'progress', progress: p });

  try {
    const t0 = performance.now();
    const wasm = await init({ module_or_path: wasmModule });
    const tInit = performance.now();

    const fetchBytes = async (target) => {
      const r = await request(target);
      return r.ok ? new Uint8Array(r.buffer) : null;
    };
    const { scene, meta, stats, protocols } = await composeStage({ UsdLoader, fetchBytes, rootUrl: url, prefetchVariants, onProgress: progress });
    const geometries = takeGeometries(scene, meta);
    const packaged = takePackagedTextures(scene, meta);
    scene.free();
    stats.initMs = tInit - t0;
    stats.totalMs = performance.now() - t0;
    stats.wasmMemoryBytes = wasm.memory.buffer.byteLength;

    const transfer = [];
    for (const g of geometries) for (const a of [g.positions, g.normals, g.uvs, g.indices]) if (a) transfer.push(a.buffer);
    self.postMessage({ type: 'scene', meta, geometries, stats }, transfer);

    const paths = texturePaths(meta, { normalMaps });
    let loaded = 0;
    let bytes = 0;
    progress({ stage: 'textures', loaded, total: paths.length, bytes });
    await Promise.all(
      paths.map(async (path) => {
        try {
          let blob;
          if (packaged.has(path)) {
            blob = new Blob([packaged.get(path)]);
          } else {
            const r = await request(pathToUrl(path, protocols));
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            blob = new Blob([r.buffer]);
          }
          bytes += blob.size;
          const bitmap = await decodeTexture(blob, maxTextureSize);
          self.postMessage({ type: 'texture', path, bitmap }, [bitmap]);
        } catch (error) {
          self.postMessage({ type: 'texture', path, error: String(error?.message || error) });
        }
        progress({ stage: 'textures', loaded: ++loaded, total: paths.length, bytes });
      }),
    );
    self.postMessage({ type: 'done' });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.stack || error?.message || error) });
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
