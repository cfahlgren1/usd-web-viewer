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
  assert.equal(new TextDecoder().decode(await fetchLimited(`${base}/small`, cap(5))), 'hello');
  await assert.rejects(fetchLimited(`${base}/endless`, cap(256 * 1024)), /over the cap/);
  assert.ok(sent < 4 * 1024 * 1024, `stopped early (${sent} bytes sent)`);
});

/** A byte budget for fetchLimited: charges each chunk and throws past `max`. */
function cap(max) {
  let used = 0;
  return (bytes) => {
    used += bytes;
    if (used > max) throw new Error('over the cap');
  };
}

test('parallel layers share one byte budget as their bodies stream in', async () => {
  const CHUNK = 64 * 1024;
  const BUDGET = 1024 * 1024;
  let streamed = 0;
  const endless = () =>
    new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve));
          streamed += CHUNK;
          controller.enqueue(new Uint8Array(CHUNK).fill(32));
        },
      }),
    );
  const root = sublayers('./a.usda', './b.usda', './c.usda', './d.usda');
  const fetchBytes = (url, budget) => fetchLimited(url, budget, { fetchFn: async (u) => (u.endsWith('root.usda') ? new Response(root) : endless()) });
  await assert.rejects(
    composeStage({ UsdLoader, fetchBytes, rootUrl: 'https://h/root.usda', maxLayerBytes: BUDGET, maxConcurrentFetches: 4 }),
    /resource limit exceeded/,
  );
  // Each stream may have one chunk read ahead when the shared budget runs out.
  assert.ok(streamed <= BUDGET + 5 * CHUNK, `${streamed} bytes streamed for a ${BUDGET}-byte budget`);
});

/** The URLs `fetch` would request for what composeStage asked for. */
const fetched = (s) => s.requested.map((u) => new URL(u).href);
const sublayers = (...paths) => `#usda 1.0\n(subLayers = [${paths.map((p) => `@${p}@`).join(', ')}])`;

test('a signed root URL keeps its query; relative layers resolve against it', async () => {
  const s = server({ 'https://h/a/root.usda?sig=abc': sublayers('./sub.usda'), 'https://h/a/sub.usda': '#usda 1.0' });
  const { scene } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/a/root.usda?sig=abc' });
  scene.free();
  assert.deepEqual(fetched(s), ['https://h/a/root.usda?sig=abc', 'https://h/a/sub.usda']);
});

test('authored escapes and spaces are encoded once', async () => {
  const s = server({
    'https://h/a/root.usda': sublayers('./a%20b.usda', './c d.usda'),
    'https://h/a/a%20b.usda': '#usda 1.0',
    'https://h/a/c d.usda': '#usda 1.0',
  });
  const { scene } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/a/root.usda' });
  scene.free();
  assert.deepEqual(fetched(s).sort(), ['https://h/a/a%20b.usda', 'https://h/a/c%20d.usda', 'https://h/a/root.usda']);
});

test('absolute dependencies keep their scheme and host, and anchor their own relative paths', async () => {
  const s = server({
    'https://h/root.usda': sublayers('http://other.example/x/x.usda'),
    'http://other.example/x/x.usda': sublayers('./y.usda'),
    'http://other.example/x/y.usda': '#usda 1.0',
  });
  const { scene } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  scene.free();
  assert.deepEqual(fetched(s), ['https://h/root.usda', 'http://other.example/x/x.usda', 'http://other.example/x/y.usda']);
});

test('an encoded slash stays part of its path segment', async () => {
  const root = 'https://h/d/resolve/refs%2Fpr%2F1/root.usda';
  const s = server({ [root]: sublayers('./sub.usda'), 'https://h/d/resolve/refs%2Fpr%2F1/sub.usda': '#usda 1.0' });
  const { scene } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: root });
  scene.free();
  assert.deepEqual(fetched(s), [root, 'https://h/d/resolve/refs%2Fpr%2F1/sub.usda']);
});

test('relative layers resolve against the requested URL, not where it redirected', async (t) => {
  const requested = [];
  const srv = http.createServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/a/root.usda') return res.writeHead(302, { location: '/cdn/blob1' }).end();
    if (req.url === '/cdn/blob1') return res.end(sublayers('./sub.usda'));
    if (req.url === '/a/sub.usda') return res.end('#usda 1.0');
    res.writeHead(404).end();
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const { scene } = await composeStage({ UsdLoader, fetchBytes: fetchLimited, rootUrl: `${base}/a/root.usda` });
  scene.free();
  assert.deepEqual(requested, ['/a/root.usda', '/cdn/blob1', '/a/sub.usda']);
});
