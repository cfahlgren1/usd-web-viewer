// Drives the real WASM build through load-core with in-memory files.
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { initSync, UsdLoader } from '../wasm/usd_wasm.js';
import { composeStage, fetchLimited } from '../src/load-core.js';

initSync({ module: readFileSync(new URL('../wasm/usd_wasm_bg.wasm', import.meta.url)) });

const QUAD = `def Mesh "M" {
  int[] faceVertexCounts = [4]
  int[] faceVertexIndices = [0, 1, 2, 3]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
}`;

/** Serves `files` (URL -> string | Uint8Array); counts fetches in flight. */
function server(files, { delayMs = 0 } = {}) {
  const s = { inFlight: 0, maxInFlight: 0, requested: [] };
  s.fetchBytes = async (url) => {
    s.requested.push(url);
    s.inFlight++;
    s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    s.inFlight--;
    const body = files[url];
    if (body === undefined) return null;
    return typeof body === 'string' ? new TextEncoder().encode(body) : body;
  };
  return s;
}

/** A one-entry zip with stored (uncompressed) data and a chosen declared size. */
function storedZip(name, data, declaredSize = data.length) {
  const nameBytes = Buffer.from(name);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return new Uint8Array(Buffer.concat([local, nameBytes, data, central, nameBytes, end]));
}

test('a package entry that lies about its size is read without trusting the header', async () => {
  const s = server({
    'https://h/root.usda': '#usda 1.0\ndef "A" (references = @./p.usdz[m.usda]@) {}',
    'https://h/p.usdz': storedZip('m.usda', Buffer.from(`#usda 1.0\n(defaultPrim = "M")\n${QUAD}`), 0xfffffff0),
  });
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  scene.free();
  assert.equal(meta.stats.triangles, 2);
});

const manyLayers = (n) => {
  const files = { 'https://h/root.usda': `#usda 1.0\n(subLayers = [${Array.from({ length: n }, (_, i) => `@./l${i}.usda@`).join(', ')}])` };
  for (let i = 0; i < n; i++) files[`https://h/l${i}.usda`] = `#usda 1.0\ndef Xform "X${i}" {}`;
  return files;
};

test('layer fetches are capped at maxConcurrentFetches', async () => {
  const s = server(manyLayers(40), { delayMs: 5 });
  const { scene } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda', maxConcurrentFetches: 4 });
  scene.free();
  assert.equal(s.requested.length, 41);
  assert.equal(s.maxInFlight, 4);
});

test('layers past maxLayerBytes fail with a resource limit error', async () => {
  const s = server(manyLayers(40));
  await assert.rejects(
    composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda', maxLayerBytes: 600 }),
    /resource limit exceeded/,
  );
});

test('fetchLimited stops reading a streamed body past maxBytes', async (t) => {
  const chunk = Buffer.alloc(64 * 1024);
  let sent = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/small') return res.end('hello');
    // Chunked, no content-length: only counting the stream can catch it.
    const timer = setInterval(() => {
      sent += chunk.length;
      res.write(chunk);
    }, 1);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.equal(new TextDecoder().decode(await fetchLimited(`${base}/small`, 5)), 'hello');
  await assert.rejects(fetchLimited(`${base}/endless`, 256 * 1024), /resource limit exceeded/);
  assert.ok(sent < 4 * 1024 * 1024, `stopped early (${sent} bytes sent)`);
});
