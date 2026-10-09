// Drives the real WASM build through load-core with in-memory files.
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { initSync, UsdLoader } from '../wasm/usd_wasm.js';
import { composeStage, fetchLimited, imageInfo, limiter, loadFailure, readGeometries, requestPolicy, takePackagedTextures, textureJobs } from '../src/load-core.js';
import { UsdLoadError } from '../src/errors.js';
import { hubPackageLayers } from '../src/hub-prefetch.js';

// Missing from the oldest supported browsers (Safari 16.4).
delete Map.groupBy;
delete AbortSignal.any;
delete URL.canParse;
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

/** A zip of stored (or, with `deflate`, deflated) entries, each optionally declaring a size it does not have. */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data: raw, declaredSize = raw.length, deflate = false } of entries) {
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

test('a package entry that lies about its size is read without trusting the header', async () => {
  const s = server({
    'https://h/root.usda': '#usda 1.0\ndef "A" (references = @./p.usdz[m.usda]@) {}',
    'https://h/p.usdz': storedZip([{ name: 'm.usda', data: Buffer.from(`#usda 1.0\n(defaultPrim = "M")\n${QUAD}`), declaredSize: 0xfffffff0 }]),
  });
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  let triangles = 0;
  readGeometries(scene, meta, (i, g) => (triangles += g ? g.groups.reduce((n, [, count]) => n + count / 3, 0) : 0));
  scene.free();
  assert.equal(triangles, 2);
});

test('a usdz layer whose files would expand too far is refused before openusd reads it', { timeout: 5000 }, async () => {
  // bomb.usdz, smaller: a deflated entry declaring 600 MiB, and one declaring less than it inflates to.
  const quad = Buffer.from(`#usda 1.0\n${QUAD}`);
  for (const entry of [
    { name: 'root.usda', data: quad, deflate: true, declaredSize: 600 * 2 ** 20 },
    { name: 'root.usda', data: Buffer.concat([quad, Buffer.alloc(1 << 20, 32)]), deflate: true, declaredSize: quad.length },
  ]) {
    const s = server({ 'https://h/bomb.usdz': storedZip([entry]) });
    const error = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/bomb.usdz' }).then(() => null, (e) => e);
    assert.equal(error?.code, 'compose');
  }
  // An honest deflated package still loads.
  const s = server({ 'https://h/ok.usdz': storedZip([{ name: 'root.usda', data: quad, deflate: true }]) });
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/ok.usdz' });
  scene.free();
  assert.equal(meta.geometryCount, 1);
});

test('packaged texture reads share one byte budget', async () => {
  // overlap.zip, smaller: three images in one package, read past the budget.
  const mesh = (n) => `def Mesh "M${n}" (prepend apiSchemas = ["MaterialBindingAPI"]) {
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0, 1, 2]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
  rel material:binding = </Mat${n}>
}
def Material "Mat${n}" {
  token outputs:surface.connect = </Mat${n}/P.outputs:surface>
  def Shader "P" {
    uniform token info:id = "UsdPreviewSurface"
    color3f inputs:diffuseColor.connect = </Mat${n}/T.outputs:rgb>
    token outputs:surface
  }
  def Shader "T" {
    uniform token info:id = "UsdUVTexture"
    asset inputs:file = @${n}.png@
    float3 outputs:rgb
  }
}`;
  const names = ['a', 'b', 'c'];
  const usdz = storedZip([{ name: 'root.usda', data: Buffer.from(`#usda 1.0\n${names.map(mesh).join('\n')}`) }, ...names.map((n) => ({ name: `${n}.png`, data: Buffer.alloc(1 << 20) }))]);
  const s = server({ 'https://h/p.usdz': usdz });
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/p.usdz' });
  const packaged = takePackagedTextures(scene, textureJobs(meta, { textures: 'preview', maxSize: 1024 }), { maxBytes: 2.5 * 2 ** 20 });
  scene.free();
  assert.deepEqual([...packaged.values()].map((v) => (v instanceof Error ? 'refused' : v.byteLength)), [1 << 20, 1 << 20, 'refused']);
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

test('layers past maxLayers fail with a resource limit error', async () => {
  const s = server(manyLayers(40));
  await assert.rejects(composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda', maxLayers: 20 }), /more than maxLayers \(20\)/);
  assert.ok(s.requested.length <= 20, `${s.requested.length} requests`);
  const { scene } = await composeStage({ UsdLoader, fetchBytes: server(manyLayers(40)).fetchBytes, rootUrl: 'https://h/root.usda', maxLayers: 41 });
  scene.free();
});

test('layers on origins outside allowedOrigins are left out with a warning, never requested', async () => {
  const files = { 'https://h/root.usda': sublayers('https://other.example/a.usda'), 'https://other.example/a.usda': `#usda 1.0\n${QUAD}` };
  const blocked = server(files);
  const { scene, meta, stats } = await composeStage({ UsdLoader, fetchBytes: blocked.fetchBytes, rootUrl: 'https://h/root.usda' });
  scene.free();
  assert.deepEqual(fetched(blocked), ['https://h/root.usda']);
  assert.equal(meta.geometryCount, 0);
  assert.deepEqual(stats.warnings.map((w) => [w.code, w.path]), [['layer-missing', 'https://other.example/a.usda']]);
  const allowed = server(files);
  const result = await composeStage({ UsdLoader, fetchBytes: allowed.fetchBytes, rootUrl: 'https://h/root.usda', allowedOrigins: ['https://other.example'] });
  result.scene.free();
  assert.equal(result.meta.geometryCount, 1);
});

test('requestPolicy: origins, schemes, Hub paths and where credentials go', () => {
  const root = 'https://huggingface.co/datasets/o/r/resolve/main/pkg/root.usda';
  const policy = (url, base = root, allowed) => requestPolicy(url, base, allowed);
  const refused = (url, base, allowed) => !!policy(url, base, allowed).refused;
  // The root itself, whatever its scheme: the caller chose it.
  assert.equal(policy('blob:https://page.example/1234', 'blob:https://page.example/1234').credentials, 'same-origin');
  // Own repo: credentials. Other repos and the CDN: allowed, no credentials.
  assert.deepEqual(policy('https://huggingface.co/datasets/o/r/resolve/main/pkg/a.usda'), { credentials: 'same-origin', referrerPolicy: 'no-referrer' });
  assert.equal(policy('https://huggingface.co/api/datasets/o/r/tree/main/pkg?recursive=true').credentials, 'same-origin');
  assert.equal(policy('https://huggingface.co/victim/private-repo/resolve/main/secret.usda').credentials, 'omit');
  // hf.co is checked as the huggingface.co URL it redirects to.
  assert.equal(policy('https://hf.co/datasets/o/r/resolve/main/b.usd').credentials, 'same-origin');
  assert.equal(policy('https://cdn-lfs.hf.co/x').credentials, 'omit');
  // What ssrf.usda authors, resolved against a Hub root.
  for (const url of [
    'https://huggingface.co/api/whoami-v2.usda',
    'https://huggingface.co/api/settings/tokens',
    'https://huggingface.co/logout',
    'https://attacker.example/beacon.usd?u=1',
    'https://attacker.example/x.usda',
    'http://127.0.0.1:8080/admin.usda',
    'https://huggingface.co@attacker.example/a.usda',
    'https://user:pw@huggingface.co/datasets/o/r/resolve/main/a.usda',
    'https://huggingface.co/datasets/o/r/resolve/main/..%2f..%2f..%2fapi%2fx.usda',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)//x.png',
    'file:///etc/passwd',
    'http://huggingface.co/datasets/o/r/resolve/main/a.usda',
    'https://huggingface.co.attacker.example/x',
    'omniverse://server/a.usd',
  ]) {
    assert.ok(refused(url), url);
  }
  // Other roots: the root's origin with credentials, listed origins without.
  assert.equal(policy('https://h/x/t.png', 'https://h/root.usda').credentials, 'same-origin');
  assert.ok(refused('https://evil.example/t.png', 'https://h/root.usda'));
  assert.equal(policy('https://cdn.example/t.png', 'https://h/root.usda', ['https://cdn.example']).credentials, 'omit');
  assert.ok(!refused('https://evil.example/t.png', 'https://h/root.usda', ['*']));
  assert.ok(refused('https://huggingface.co/datasets/o/r/resolve/main/a.usd', 'https://h/root.usda'));
  assert.ok(refused('https://huggingface.co/api/whoami-v2', 'https://h/root.usda', ['*']));
});

test('imageInfo reads PNG, JPEG and WebP sizes, nothing else', () => {
  const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
  const le16 = (n) => [n & 255, n >> 8];
  const le24 = (n) => [n & 255, (n >> 8) & 255, n >> 16];
  const riff = (chunk, data) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], data, new Array(16).fill(0));
  assert.deepEqual(imageInfo(riff('VP8 ', [0, 0, 0, 0x9d, 1, 0x2a, ...le16(640), ...le16(480)])), { width: 640, height: 480, color: true });
  const vp8l = (639 | (479 << 14)) >>> 0;
  assert.deepEqual(imageInfo(riff('VP8L', [0x2f, vp8l & 255, (vp8l >> 8) & 255, (vp8l >> 16) & 255, vp8l >>> 24])), { width: 640, height: 480, color: true });
  assert.deepEqual(imageInfo(riff('VP8X', [0, 0, 0, 0, ...le24(20000 - 1), ...le24(30 - 1)])), { width: 20000, height: 30, color: true });
  assert.equal(imageInfo(bytes('GIF89a', le16(20000), le16(20000), new Array(20).fill(0))), null);
  assert.equal(imageInfo(bytes('BM', new Array(40).fill(0))), null);
});

test('a mesh whose corners share one point welds in linear time', { timeout: 10000 }, async () => {
  // weld.usda, smaller: every corner on point 0, each with its own normal.
  const faces = 20000;
  const normals = Array.from({ length: faces * 3 }, (_, i) => `(${i}, 1, 0)`).join(', ');
  const usda = `#usda 1.0
def Mesh "M" {
  int[] faceVertexCounts = [${new Array(faces).fill(3).join(',')}]
  int[] faceVertexIndices = [${new Array(faces * 3).fill(0).join(',')}]
  point3f[] points = [(0, 0, 0)]
  normal3f[] normals = [${normals}] (interpolation = "faceVarying")
}`;
  const s = server({ 'https://h/root.usda': usda });
  const t0 = performance.now();
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  let vertices = 0;
  readGeometries(scene, meta, (i, g) => (vertices = g.vertices));
  scene.free();
  assert.equal(vertices, faces * 3);
  assert.ok(performance.now() - t0 < 3000, `${Math.round(performance.now() - t0)} ms`);
});

test('meshes past maxTriangles are left out unread with a warning', async () => {
  const tri = (name) => `def Mesh "${name}" {\n  int[] faceVertexCounts = [3, 3]\n  int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]\n  point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]\n}`;
  const s = server({ 'https://h/root.usda': `#usda 1.0\n${tri('A')}\n${tri('B')}\n${tri('C')}` });
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  const read = [];
  const warnings = readGeometries(scene, meta, (i, g) => read.push(!!g), { maxTriangles: 5 });
  scene.free();
  assert.deepEqual(read, [true, true, false]);
  assert.deepEqual(warnings.map((w) => [w.code, w.path]), [['triangle-limit', '/C']]);
});

test('16-bit indices are chosen from the largest index', async () => {
  const s = server({ 'https://h/root.usda': `#usda 1.0\n${QUAD}` });
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  let out;
  readGeometries(scene, meta, (i, g, a) => (out = [g.maxIndex, a.indices.constructor.name]));
  scene.free();
  assert.deepEqual(out, [3, 'Uint16Array']);
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
  const { scene } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda', allowedOrigins: ['http://other.example'] });
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

test('a packaged image shared by many materials is extracted once, and only when its texture mode loads it', async () => {
  // As in the review: 1,030 materials each sample one 1 MiB image twice.
  const materials = Array.from(
    { length: 1030 },
    (_, i) => `def Mesh "M${i}" (prepend apiSchemas = ["MaterialBindingAPI"]) {
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0, 1, 2]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
  rel material:binding = </Mat${i}>
}
def Material "Mat${i}" {
  token outputs:surface.connect = </Mat${i}/P.outputs:surface>
  def Shader "P" {
    uniform token info:id = "UsdPreviewSurface"
    color3f inputs:diffuseColor.connect = </Mat${i}/T.outputs:rgb>
    float inputs:roughness.connect = </Mat${i}/T.outputs:r>
    token outputs:surface
  }
  def Shader "T" {
    uniform token info:id = "UsdUVTexture"
    asset inputs:file = @tex.png@
    float3 outputs:rgb
    float outputs:r
  }
}`,
  );
  const usdz = storedZip([
    { name: 'root.usda', data: Buffer.from(`#usda 1.0\n${materials.join('\n')}`) },
    { name: 'tex.png', data: Buffer.alloc(1 << 20) },
  ]);
  for (const [textures, reads] of [['none', 0], ['preview', 1]]) {
    const s = server({ 'https://h/shared.usdz': usdz });
    const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/shared.usdz' });
    const read = [];
    const packagedFile = scene.packagedFile.bind(scene);
    scene.packagedFile = (path, limit) => (read.push(path), packagedFile(path, limit));
    const packaged = takePackagedTextures(scene, textureJobs(meta, { textures, maxSize: 1024 }));
    scene.free();
    assert.equal(read.length, reads, textures);
    if (reads) assert.equal(packaged.get('https://h/shared.usdz[tex.png]').byteLength, 1 << 20);
  }
});

test('layers that reference each other compose instead of waiting on each other forever', { timeout: 5000 }, async () => {
  const s = server({
    'https://h/root.usda': '#usda 1.0\ndef "A" (references = @./a.usda@) {}',
    'https://h/a.usda': `#usda 1.0\n(defaultPrim = "M")\n${QUAD}\ndef "Back" (references = @./b.usda@) {}`,
    'https://h/b.usda': '#usda 1.0\n(defaultPrim = "X")\ndef "X" (references = @./a.usda@) {}',
  });
  const { scene, stats } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  scene.free();
  assert.equal(stats.layers, 3);
  assert.deepEqual(s.requested.sort(), ['https://h/a.usda', 'https://h/b.usda', 'https://h/root.usda']);
});

test('a stage with nothing to draw says so, after naming what it could not draw', async () => {
  const read = async (usda) => {
    const s = server({ 'https://h/root.usda': `#usda 1.0\n${usda}` });
    const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
    const warnings = readGeometries(scene, meta, () => {});
    scene.free();
    return [...meta.warnings, ...warnings].map((w) => w.code);
  };
  assert.deepEqual(await read('def ParticleField3DGaussianSplat "Splat" {}'), ['prim-unsupported', 'nothing-drawable']);
  assert.deepEqual(await read('def Mesh "Empty" {}'), ['nothing-drawable']);
  assert.deepEqual(await read(QUAD), []);
});

test('reading geometry out of order or out of range throws instead of trapping', async () => {
  const s = server({ 'https://h/root.usda': `#usda 1.0\n${QUAD}` });
  const { scene } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  assert.throws(() => scene.positions(), { message: /call read\(\) first/ });
  assert.throws(() => scene.read(7, 100), { message: /no geometry 7: the scene has 1/ });
  assert.ok(scene.read(0, 100));
  assert.throws(() => scene.uvs(3), { message: /no UV set 3/ });
  // Still usable: none of these trapped.
  assert.equal(scene.positions().length, 12);
  scene.free();
});

test('running out of WASM memory fails as a scene too large to load; a panic gives its message', () => {
  const GiB = 2 ** 30;
  const oom = new Error('failed to decode field "default" at /W/body.normals: failed to read vec: out of memory');
  assert.match(loadFailure(oom, 1 * GiB).message, /^scene too large to load: ran out of memory.*body\.normals/);
  assert.equal(loadFailure(oom, 1 * GiB).code, 'compose');
  // An allocation that aborts traps; near the 4 GiB ceiling that is memory, not a bug.
  assert.match(loadFailure(new WebAssembly.RuntimeError('unreachable'), 3.9 * GiB).message, /^scene too large to load/);
  // Without a panic message, a bare `unreachable` is Rust aborting on a failed allocation.
  assert.match(loadFailure(new WebAssembly.RuntimeError('unreachable'), 0.1 * GiB).message, /^scene too large to load: ran out of memory/);
  assert.match(loadFailure(new RangeError('Array buffer allocation failed'), 0.1 * GiB).message, /^scene too large to load/);
  const panic = 'panicked at crates/usd-wasm/src/extract.rs:1:1:\nindex out of bounds';
  assert.equal(loadFailure(new WebAssembly.RuntimeError('unreachable'), 0.1 * GiB, () => panic).message, `unreachable: ${panic}`);
  const fetchError = loadFailure(new UsdLoadError('fetch', 'HTTP 404 for https://h/a.usd', { url: 'https://h/a.usd', status: 404 }), 4 * GiB);
  assert.deepEqual(fetchError, { code: 'fetch', message: 'HTTP 404 for https://h/a.usd', url: 'https://h/a.usd', status: 404 });
});

test('a UDIM texture loads its first tile, 1001', async () => {
  const s = server({
    'https://h/root.usda': `#usda 1.0
def Mesh "M" (prepend apiSchemas = ["MaterialBindingAPI"]) {
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0, 1, 2]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
  rel material:binding = </Mat>
}
def Material "Mat" {
  token outputs:surface.connect = </Mat/Surface.outputs:surface>
  def Shader "Surface" {
    uniform token info:id = "UsdPreviewSurface"
    color3f inputs:diffuseColor.connect = </Mat/Tex.outputs:rgb>
    token outputs:surface
  }
  def Shader "Tex" {
    uniform token info:id = "UsdUVTexture"
    asset inputs:file = @Textures/body_alb.<UDIM>.png@
    float3 outputs:rgb
  }
}`,
  });
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda' });
  scene.free();
  assert.deepEqual(
    textureJobs(meta, { textures: 'full' }).map((j) => j.path),
    ['https://h/Textures/body_alb.1001.png'],
  );
});

test('textures inside a package nested in packages are found where the nesting says', async () => {
  const material = `def Mesh "M" (prepend apiSchemas = ["MaterialBindingAPI"]) {
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0, 1, 2]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
  rel material:binding = </M/Mat>
  def Material "Mat" {
    token outputs:surface.connect = </M/Mat/Surface.outputs:surface>
    def Shader "Surface" {
      uniform token info:id = "UsdPreviewSurface"
      color3f inputs:diffuseColor.connect = </M/Mat/Tex.outputs:rgb>
      token outputs:surface
    }
    def Shader "Tex" {
      uniform token info:id = "UsdUVTexture"
      asset inputs:file = @0/t.png@
      float3 outputs:rgb
    }
  }
}`;
  const deep = storedZip([
    { name: 'deep.usda', data: Buffer.from(`#usda 1.0\n(defaultPrim = "M")\n${material}`) },
    { name: '0/t.png', data: Buffer.from('deep texture') },
  ]);
  const mid = storedZip([
    { name: 'mid.usda', data: Buffer.from('#usda 1.0\n(defaultPrim = "Mid")\ndef "Mid" (references = @0/deep.usdz@) {}') },
    { name: '0/deep.usdz', data: deep },
  ]);
  const outer = storedZip([
    { name: 'outer.usda', data: Buffer.from('#usda 1.0\ndef "Outer" (references = @0/mid.usdz@) {}') },
    { name: '0/mid.usdz', data: mid },
  ]);
  const s = server({ 'https://h/outer.usdz': outer });
  const { scene, meta } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/outer.usdz' });
  const textures = takePackagedTextures(scene, textureJobs(meta, { textures: 'full', maxSize: 1024 }));
  scene.free();
  const path = 'https://h/outer.usdz[0/mid.usdz[0/deep.usdz[0/t.png]]]';
  assert.deepEqual(textureJobs(meta, { textures: 'full' }).map((j) => j.path), [path]);
  assert.equal(new TextDecoder().decode(textures.get(path)), 'deep texture');
});

test('preloaded layers are used when composition asks for them, and change nothing else', async () => {
  const files = {
    'https://h/p/root.usda': `#usda 1.0\n(subLayers = [@./a b.usda@])\n${QUAD}`,
    'https://h/p/a b.usda': sublayers('./b.usda'),
    'https://h/p/b.usda': `#usda 1.0\ndef Mesh "B" {\n  int[] faceVertexCounts = [3]\n  int[] faceVertexIndices = [0, 1, 2]\n  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n}`,
    'https://h/p/unused.usda': `#usda 1.0\n${QUAD.replace('"M"', '"U"')}`,
  };
  const plain = server(files, { delayMs: 5 });
  const expected = await composeStage({ UsdLoader, fetchBytes: plain.fetchBytes, rootUrl: 'https://h/p/root.usda' });
  // As listed: spelled the way fetch spells it, root included.
  const listed = ['root.usda', 'a%20b.usda', 'b.usda', 'unused.usda'].map((name) => ({ url: `https://h/p/${name}`, size: 100 }));
  const s = server({ ...files, 'https://h/p/a%20b.usda': files['https://h/p/a b.usda'] }, { delayMs: 5 });
  const actual = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/p/root.usda', preload: Promise.resolve({ layers: listed, eager: true }) });
  assert.deepEqual(actual.meta, expected.meta);
  assert.equal(actual.stats.layers, 3);
  expected.scene.free();
  actual.scene.free();
  assert.deepEqual(fetched(s).sort(), ['https://h/p/a%20b.usda', 'https://h/p/b.usda', 'https://h/p/root.usda', 'https://h/p/unused.usda']);
});

test('a preload that fails gives way to the regular fetch, with its result', async () => {
  const files = { 'https://h/root.usda': sublayers('./a.usda', './gone.usda'), 'https://h/a.usda': sublayers('./b.usda'), 'https://h/b.usda': '#usda 1.0' };
  const s = server(files, { delayMs: 5 });
  const requested = [];
  const fetchBytes = (url, budget) => {
    requested.push(url);
    if (url === 'https://h/b.usda' && requested.filter((u) => u === url).length === 1) return Promise.reject(new TypeError('network'));
    return s.fetchBytes(url, budget);
  };
  const preload = Promise.resolve({ layers: ['b.usda', 'gone.usda'].map((name) => ({ url: `https://h/${name}`, size: 1 })), eager: false });
  const { scene, stats } = await composeStage({ UsdLoader, fetchBytes, rootUrl: 'https://h/root.usda', preload });
  scene.free();
  assert.equal(stats.layers, 3);
  assert.deepEqual(stats.warnings.map((w) => w.code), ['layer-missing']);
  assert.deepEqual(requested.filter((u) => u === 'https://h/b.usda').length, 2);
});

test('a root with no dependencies fetches nothing ahead unless its package is declared', async () => {
  for (const eager of [false, true]) {
    const s = server({ 'https://h/root.usda': `#usda 1.0\n${QUAD}`, 'https://h/other.usda': '#usda 1.0' }, { delayMs: 5 });
    const preload = Promise.resolve({ layers: [{ url: 'https://h/other.usda', size: 10 }], eager });
    const { scene } = await composeStage({ UsdLoader, fetchBytes: s.fetchBytes, rootUrl: 'https://h/root.usda', preload });
    scene.free();
    assert.deepEqual(s.requested, eager ? ['https://h/root.usda', 'https://h/other.usda'] : ['https://h/root.usda']);
  }
});

test('the limiter runs tasks marked later after the others', async () => {
  const throttle = limiter(1);
  const order = [];
  const run = (name, options) => throttle(async () => order.push(name), options);
  await Promise.all([run('first'), run('later', { later: true }), run('second')]);
  assert.deepEqual(order, ['first', 'second', 'later']);
});

test('hubPackageLayers lists the SimReady package of a Hub root, and nothing for other URLs', async () => {
  const requests = [];
  const tree = [
    { type: 'file', path: 'pkg/com.nvidia.simready.packaging.json', size: 10 },
    { type: 'directory', path: 'pkg/usd', size: 0 },
    { type: 'file', path: 'pkg/usd/root.usd', size: 10 },
    { type: 'file', path: 'pkg/usd/parts/a b.usdc', size: 10 },
    { type: 'file', path: 'pkg/materials/m.usda', size: 10 },
    { type: 'file', path: 'pkg/textures/t.png', size: 10 },
    { type: 'file', path: 'pkg/huge.usd', size: 2 ** 30 },
  ];
  const request = async (url) => (requests.push(url), Response.json(tree));
  const { layers, eager } = await hubPackageLayers('https://huggingface.co/datasets/o/r/resolve/main/pkg/usd/root.usd?download=true', request);
  assert.deepEqual(requests, ['https://huggingface.co/api/datasets/o/r/tree/main/pkg?recursive=true']);
  assert.equal(eager, true);
  assert.deepEqual(layers.map((l) => l.url), [
    'https://huggingface.co/datasets/o/r/resolve/main/pkg/usd/root.usd',
    'https://huggingface.co/datasets/o/r/resolve/main/pkg/usd/parts/a%20b.usdc',
    'https://huggingface.co/datasets/o/r/resolve/main/pkg/materials/m.usda',
  ]);
  // Without a manifest, only the root's own directory.
  const bare = await hubPackageLayers('https://huggingface.co/o/r/resolve/main/pkg/usd/root.usd', async (url) => (requests.push(url), Response.json(tree.slice(1))));
  assert.equal(requests.at(-1), 'https://huggingface.co/api/models/o/r/tree/main/pkg?recursive=true');
  assert.equal(bare.eager, false);
  assert.deepEqual(bare.layers.map((l) => l.url), ['https://huggingface.co/o/r/resolve/main/pkg/usd/root.usd', 'https://huggingface.co/o/r/resolve/main/pkg/usd/parts/a%20b.usdc']);
  const none = { layers: [], eager: false };
  assert.deepEqual(await hubPackageLayers('https://example.com/datasets/o/r/resolve/main/pkg/usd/root.usd', request), none);
  assert.deepEqual(await hubPackageLayers('https://huggingface.co/datasets/o/r/resolve/main/x.usd', async () => new Response(null, { status: 401 })), none);
  assert.equal(requests.length, 2);
});

test('caps: drawn triangles, instances and layer bytes', async () => {
  // subset-amp.usda, smaller: a 66-gon (64 triangles) its subset names 100 times.
  const n = 66;
  const points = Array.from({ length: n }, (_, i) => `(${Math.cos((i / n) * 6.283).toFixed(3)}, ${Math.sin((i / n) * 6.283).toFixed(3)}, 0)`);
  const amp = `def Mesh "Amp" {
  int[] faceVertexCounts = [${n}]
  int[] faceVertexIndices = [${points.map((_, i) => i)}]
  point3f[] points = [${points}]
  def GeomSubset "S" {
    uniform token elementType = "face"
    uniform token familyName = "materialBind"
    int[] indices = [${new Array(100).fill(0)}]
  }
}`;
  const instancer = (count) => `def PointInstancer "PI" {
  rel prototypes = [</PI/P/M>]
  int[] protoIndices = [${new Array(count).fill(0)}]
  point3f[] positions = [${Array.from({ length: count }, (_, i) => `(${i}, 0, 0)`)}]
  def Scope "P" {
    ${QUAD}
  }
}`;
  // [what, root layer, other layers, preloaded layers, options, triangles drawn, warnings, most bytes of unused.usda read]
  const cases = [
    ['a face a subset names again is drawn once; the budget stops at zero', `${amp}\n${QUAD}`, {}, [], { maxTriangles: 65 }, 64, [['triangle-limit', '/M']]],
    ['implicit shapes count', 'def Cube "C" {}\ndef Sphere "S" {}', {}, [], { maxTriangles: 20 }, 12, [['triangle-limit', '/S']]],
    ['placements past maxInstances', instancer(50), {}, [], { maxInstances: 10 }, 20, [['instance-limit', '/PI']]],
    ['triangles count once per instance', instancer(10), {}, [], { maxTriangles: 19 }, 0, [['triangle-limit', '/PI/P/M'], ['nothing-drawable', undefined]]],
    ['an unused preload is charged as it streams', '(subLayers = [@./a.usda@])', { 'a.usda': `#usda 1.0\n${QUAD}`, 'unused.usda': `#usda 1.0\n${' '.repeat(5000)}` }, ['a.usda', 'unused.usda'], { maxLayerBytes: 2000 }, 2, [], 2000],
  ];
  for (const [what, root, others, preloads, options, triangles, warnings, unusedRead = Infinity] of cases) {
    const files = { 'https://h/root.usda': `#usda 1.0\n${root}` };
    for (const [name, body] of Object.entries(others)) files[`https://h/${name}`] = body;
    let read = 0;
    // Streams each body in 100-byte chunks; the root arrives last, so preloads stream first.
    const fetchBytes = async (url, budget) => {
      if (url.endsWith('root.usda') && preloads.length) await new Promise((resolve) => setTimeout(resolve, 100));
      const body = new TextEncoder().encode(files[url]);
      for (let i = 0; i < body.length; i += 100) {
        budget(Math.min(100, body.length - i));
        if (url.endsWith('unused.usda')) read += Math.min(100, body.length - i);
        await new Promise((resolve) => setTimeout(resolve));
      }
      return body;
    };
    const preload = Promise.resolve({ layers: preloads.map((name) => ({ url: `https://h/${name}`, size: 10 })), eager: true });
    const { scene, meta } = await composeStage({ UsdLoader, fetchBytes, rootUrl: 'https://h/root.usda', preload, ...options });
    const counts = new Map();
    for (const { geometry } of meta.instances) counts.set(geometry, (counts.get(geometry) ?? 0) + 1);
    let drawn = 0;
    const limits = readGeometries(scene, meta, (i, g, a) => (drawn += a ? (counts.get(i) * a.indices.length) / 3 : 0), options);
    scene.free();
    assert.equal(drawn, triangles, what);
    assert.deepEqual([...meta.warnings, ...limits].map((w) => [w.code, w.path]), warnings, what);
    assert.ok(read <= unusedRead, `${what}: ${read} bytes read`);
  }
});
