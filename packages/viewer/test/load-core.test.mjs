// Drives the real WASM build through load-core with in-memory files.
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { initSync, UsdLoader } from '../wasm/usd_wasm.js';
import { composeStage, fetchLimited, limiter, loadFailure, readGeometries, takePackagedTextures, textureJobs } from '../src/load-core.js';
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

/** A zip of stored (uncompressed) entries, each optionally declaring a size it does not have. */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, declaredSize = data.length } of entries) {
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
    scene.packagedFile = (path) => (read.push(path), packagedFile(path));
    const packaged = takePackagedTextures(scene, meta, { textures });
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
  assert.throws(() => scene.read(7), { message: /no geometry 7: the scene has 1/ });
  assert.ok(scene.read(0));
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
  assert.deepEqual(loadFailure(new WebAssembly.RuntimeError('unreachable'), 0.1 * GiB), { code: 'compose', message: 'unreachable', url: undefined, status: undefined });
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
  const textures = takePackagedTextures(scene, meta, { textures: 'full' });
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
