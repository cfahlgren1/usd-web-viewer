// Loads, composes and extracts a USD stage off the main thread, then streams
// base-color textures as downscaled ImageBitmaps. One worker per load: the
// page terminates it when done, which releases all WASM memory at once.
import init, { UsdLoader } from '../wasm/usd_wasm.js';
import { composeStage, fetchLimited, limiter, takeGeometries, takePackagedTextures, texturePaths } from './load-core.js';

self.onmessage = async (event) => {
  const { url, wasmModule, maxTextureSize = 1024, normalMaps = false, prefetchVariants = false, maxConcurrentFetches = 16, maxLayerBytes } = event.data;
  try {
    const t0 = performance.now();
    const wasm = await init({ module_or_path: wasmModule });
    const tInit = performance.now();

    const { scene, meta, stats } = await composeStage({
      UsdLoader,
      fetchBytes: fetchLimited,
      rootUrl: url,
      prefetchVariants,
      maxConcurrentFetches,
      maxLayerBytes,
    });
    const geometries = takeGeometries(scene, meta);
    const packaged = takePackagedTextures(scene, meta);
    scene.free();
    stats.initMs = tInit - t0;
    stats.totalMs = performance.now() - t0;
    stats.wasmMemoryBytes = wasm.memory.buffer.byteLength;

    const transfer = [];
    for (const g of geometries) for (const a of [g.positions, g.normals, g.uvs, g.indices]) if (a) transfer.push(a.buffer);
    self.postMessage({ type: 'scene', meta, geometries, stats }, transfer);

    const throttle = limiter(maxConcurrentFetches);
    await Promise.all(
      texturePaths(meta, { normalMaps }).map(async (path) => {
        try {
          const blob = packaged.has(path) ? new Blob([packaged.get(path)]) : await throttle(() => fetchBlob(path));
          const bitmap = await decodeTexture(blob, maxTextureSize);
          self.postMessage({ type: 'texture', path, bitmap }, [bitmap]);
        } catch (error) {
          self.postMessage({ type: 'texture', path, error: String(error?.message || error) });
        }
      }),
    );
    self.postMessage({ type: 'done' });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.stack || error?.message || error) });
  }
};

async function fetchBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.blob();
}

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
