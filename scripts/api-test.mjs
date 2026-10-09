// Browser checks for what only a browser shows: the real Worker and fetch
// (headers, redirects, abort), createImageBitmap limits, rendering and the
// <usd-viewer> element. Starts its own server over the repo's fixtures.
// usage: npm run test:browser
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const server = spawn(process.execPath, [new URL('./serve.mjs', import.meta.url).pathname], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const BASE = await new Promise((resolve, reject) => {
  server.stdout.once('data', (line) => resolve(String(line).trim()));
  server.once('exit', (code) => reject(new Error(`scripts/serve.mjs exited with ${code}`)));
});
// Several meshes and materials, one of them instanced: geometry streams in over several messages.
const SHAPES = '/fixtures/implicit_gprims.usda';
const SHAPES_TRIANGLES = 3304;
// A quad whose material samples /fixtures/quadrants.png.
const TEXTURED = '/fixtures/uv_set.usda';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const stats = async () => (await (await fetch(`${BASE}/__stats/get`)).json()).requests;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A page with the library imported, for loadUsd calls through page.evaluate.
await page.goto(`${BASE}/examples/element.html`);

/** A CORS server on a new local origin that logs each request's X-Key and Authorization headers. */
async function loggingServer(respond) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    log.push([req.url, req.headers['x-key'] ?? null, req.headers.authorization ?? null]);
    respond(req, res, cors);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { log, origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

/** The textured fixture with its texture moved to `texture`, served at `root` through a route. */
async function routeTextured(root, texture) {
  const usda = (await (await fetch(`${BASE}${TEXTURED}`)).text()).replace('@quadrants.png@', `@${texture}@`);
  await page.context().route(root, (route) => route.fulfill({ body: usda, contentType: 'text/plain' }));
}

/** Installs window.describeImage, which counts the drawn (non-transparent) pixels of an image blob. */
function installDescribeImage() {
  window.describeImage = async (blob) => {
    const bitmap = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let drawn = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) drawn++;
    return { type: blob.type, width: bitmap.width, height: bitmap.height, drawn: drawn > 100 };
  };
}

test('headers never follow a redirect to another origin', async () => {
  // Three origins, as when a page loads from a CDN: the page's, the root's, and another that a layer on the
  // root's origin redirects to. First, before any Playwright route: routing changes how redirects are followed.
  const quad =
    '#usda 1.0\ndef Mesh "M" {\n  int[] faceVertexCounts = [3]\n  int[] faceVertexIndices = [0, 1, 2]\n  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n}';
  const other = await loggingServer((req, res, cors) => res.writeHead(200, cors).end(quad));
  const site = await loggingServer((req, res, cors) => {
    if (req.url === '/root.usda') return res.writeHead(200, cors).end('#usda 1.0\n(subLayers = [@./a.usda@])');
    res.writeHead(302, { ...cors, location: `${other.origin}/a.usda` }).end();
  });
  const meshes = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const result = await loadUsd(url, { headers: { Authorization: 'Bearer SECRET', 'X-Key': 'SECRET2' }, textures: 'none' });
    result.dispose();
    return result.info.meshes;
  }, `${site.origin}/root.usda`);
  site.close();
  other.close();
  assert.ok(
    site.log.some(([url, key, auth]) => url === '/a.usda' && key === 'SECRET2' && auth === 'Bearer SECRET'),
    `headers reach the root origin: ${JSON.stringify(site.log)}`,
  );
  assert.ok(other.log.length > 0 && other.log.every(([, key, auth]) => key === null && auth === null), JSON.stringify(other.log));
  assert.equal(meshes, 1);
});

test('headers reach the layers and textures on the root origin, and no other origin', async () => {
  await fetch(`${BASE}/__stats/reset`);
  await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const result = await loadUsd(url, { headers: { Authorization: 'Bearer test-token' } });
    await result.complete;
    result.dispose();
  }, TEXTURED);
  const own = (await stats()).filter((r) => r.url.startsWith('/fixtures/'));
  assert.ok(own.some((r) => r.url.endsWith('.usda')) && own.some((r) => r.url.endsWith('.png')));
  assert.ok(
    own.every((r) => r.auth === 'Bearer test-token'),
    JSON.stringify(own.map((r) => [r.url, r.auth])),
  );

  // The root (served through a route) authors its texture on another origin of the same server.
  const root = `${BASE}/__fixture/cross-origin.usda`;
  const texture = `http://localhost:${new URL(BASE).port}/fixtures/quadrants.png`;
  await routeTextured(root, texture);
  await fetch(`${BASE}/__stats/reset`);
  const counts = await page.evaluate(
    async ([url, origin]) => {
      const { loadUsd } = await import('/packages/viewer/src/index.js');
      const result = await loadUsd(url, { headers: { Authorization: 'Bearer test-token' }, allowedOrigins: [origin] });
      const done = await result.complete;
      result.dispose();
      return done;
    },
    [root, new URL(texture).origin],
  );
  const requests = (await stats()).filter((r) => r.url.endsWith('quadrants.png'));
  assert.deepEqual(counts, { textures: 1, failed: 0 });
  assert.ok(requests.length > 0 && requests.every((r) => r.auth === null), JSON.stringify(requests));
});

test('a texture outside allowedOrigins is never requested, through fetch or a custom fetch', async () => {
  const root = `${BASE}/__fixture/other-origin.usda`;
  await routeTextured(root, `http://localhost:${new URL(BASE).port}/fixtures/quadrants.png`);
  await fetch(`${BASE}/__stats/reset`);
  const out = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const seen = [];
    const outcomes = [];
    for (const options of [{}, { fetch: (u, init) => (seen.push(u), fetch(u, init)) }]) {
      const result = await loadUsd(url, options);
      outcomes.push({ counts: await result.complete, warning: result.info.warnings.find((w) => w.code === 'texture-failed')?.message });
      result.dispose();
    }
    return { outcomes, seen };
  }, root);
  assert.deepEqual(
    (await stats()).filter((r) => r.url.endsWith('quadrants.png')),
    [],
  );
  assert.deepEqual(out.seen, [root]);
  for (const { counts, warning } of out.outcomes) {
    assert.deepEqual(counts, { textures: 0, failed: 1 });
    assert.match(warning, /not in allowedOrigins/);
  }
});

test('a custom fetch serves every layer and texture, and a missing sublayer warns as with fetch', async () => {
  const out = await page.evaluate(
    async ([textured, missing]) => {
      const { loadUsd } = await import('/packages/viewer/src/index.js');
      const seen = [];
      const custom = (u, init) => (seen.push(u), fetch(u, init));
      const result = await loadUsd(textured, { fetch: custom });
      const counts = await result.complete;
      result.dispose();
      const warnings = [];
      for (const options of [{}, { fetch: custom }]) {
        const loaded = await loadUsd(missing, options);
        loaded.dispose();
        warnings.push(loaded.info.warnings.map((w) => w.code));
      }
      return { seen, counts, warnings };
    },
    [TEXTURED, '/fixtures/missing_sublayer.usda'],
  );
  assert.ok(out.seen.some((u) => u.endsWith('uv_set.usda')) && out.seen.some((u) => u.endsWith('quadrants.png')), JSON.stringify(out.seen));
  assert.deepEqual(out.counts, { textures: 1, failed: 0 });
  assert.deepEqual(out.warnings[0], out.warnings[1], 'same warnings either way');
  assert.ok(out.warnings[0].includes('layer-missing'), JSON.stringify(out.warnings));
});

test('textures past maxTextureBytes, over 16384 px a side or of unchecked formats fail as warnings, not the load', async () => {
  const out = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    // A PNG header claiming 20000 x 20000 px.
    const huge = new Uint8Array(33);
    huge.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(huge.buffer).setUint32(16, 20000);
    new DataView(huge.buffer).setUint32(20, 20000);
    huge.set([8, 6], 24);
    const gif = new TextEncoder().encode('GIF89a\x10\x00\x10\x00\x00\x00\x00');
    const outcomes = [];
    for (const [options, png] of [
      [{ maxTextureBytes: 100 }, null],
      [{}, huge],
      [{}, gif],
    ]) {
      const fetchFn = (u, init) => (png && u.endsWith('.png') ? Promise.resolve(new Response(png)) : fetch(u, init));
      const result = await loadUsd(url, { ...options, fetch: fetchFn });
      outcomes.push({ counts: await result.complete, messages: result.info.warnings.filter((w) => w.code === 'texture-failed').map((w) => w.message) });
      result.dispose();
    }
    return outcomes;
  }, TEXTURED);
  assert.deepEqual(
    out.map((o) => o.counts),
    [
      { textures: 0, failed: 1 },
      { textures: 0, failed: 1 },
      { textures: 0, failed: 1 },
    ],
  );
  assert.match(out[0].messages[0], /maxTextureBytes/);
  assert.match(out[1].messages[0], /image too large: 20000x20000/);
  assert.match(out[2].messages[0], /unsupported image format/);
});

test('abort rejects with an aborted UsdLoadError, before or during the load', async () => {
  // The root never arrives: the load is still fetching when it is aborted.
  let held;
  await page.context().route('**/__pending.usda', (route) => (held = route));
  const outcomes = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const outcome = (promise) =>
      promise.then(
        () => 'resolved',
        (e) => `${e.name}:${e.code}`,
      );
    const controller = new AbortController();
    const pending = loadUsd('/__pending.usda', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    return [await outcome(pending), await outcome(loadUsd(url, { signal: AbortSignal.abort() }))];
  }, SHAPES);
  await held?.abort();
  await page.context().unroute('**/__pending.usda');
  assert.deepEqual(outcomes, ['UsdLoadError:aborted', 'UsdLoadError:aborted']);
});

test('lifecycle: a newer load wins; stopping a load stops all of it, while WASM compiles, as meshes stream in, and a custom fetch body', async () => {
  let held;
  await page.context().route('**/__hang.wasm', (route) => (held = route));
  const out = await page.evaluate(
    async ([shapes, textured]) => {
      const settle = (promise) =>
        Promise.race([
          promise.then(
            () => 'resolved',
            (e) => e.code,
          ),
          new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
        ]);
      // A fresh copy of the module, its WASM compile never finishing.
      const fresh = await import('/packages/viewer/src/index.js?compiling');
      const compiling = new AbortController();
      const whileCompiling = fresh.loadUsd(shapes, { signal: compiling.signal, wasmUrl: '/__hang.wasm' });
      setTimeout(() => compiling.abort(), 50);

      const { createViewer, loadUsd } = await import('/packages/viewer/src/index.js');
      const host = document.body.appendChild(document.createElement('div'));
      host.style.cssText = 'width:200px;height:150px';
      const viewer = createViewer(host);
      const shown = () => viewer.scene.children.filter((c) => c.name === 'usd').length;

      // Overlapping loads: the older is discarded.
      const first = viewer.load(shapes).then(
        () => 'resolved',
        (e) => e.code,
      );
      const second = await viewer.load(textured);
      const overlapping = { first: await first, shown: shown(), secondShown: viewer.scene.children.includes(second.root) };

      let streaming;
      const streamed = new Promise((resolve) => (streaming = resolve));
      const cleared = viewer.load(shapes, { textures: 'none', onProgress: (p) => p.stage === 'geometry' && streaming() });
      await streamed;
      const before = shown();
      viewer.clear();
      const afterClear = shown();

      // A custom fetch that ignores its signal: its body is cancelled anyway.
      let cancelled = false;
      const body = new ReadableStream({
        pull: (c) => new Promise((resolve) => setTimeout(() => resolve(c.enqueue(new Uint8Array(16))), 10)),
        cancel: () => void (cancelled = true),
      });
      const fetching = new AbortController();
      const fetched = loadUsd('/endless.usda', { fetch: async () => new Response(body), signal: fetching.signal });
      await new Promise((resolve) => setTimeout(resolve, 200));
      fetching.abort();
      const outcomes = { compiling: await settle(whileCompiling), cleared: await settle(cleared), fetched: await settle(fetched) };
      await new Promise((resolve) => setTimeout(resolve, 300));
      const later = shown();
      viewer.dispose();
      viewer.dispose();
      const canvasRemoved = !host.querySelector('canvas');
      host.remove();
      return { overlapping, outcomes, shown: [before, afterClear, later], cancelled, canvasRemoved };
    },
    [SHAPES, TEXTURED],
  );
  await held?.abort();
  await page.context().unroute('**/__hang.wasm');
  assert.deepEqual(
    out,
    {
      overlapping: { first: 'aborted', shown: 1, secondShown: true },
      outcomes: { compiling: 'aborted', cleared: 'aborted', fetched: 'aborted' },
      shown: [1, 0, 0],
      cancelled: true,
      canvasRemoved: true,
    },
    JSON.stringify(out),
  );
});

test('many instances of one mesh render as one InstancedMesh', async () => {
  await page.evaluate(installDescribeImage);
  const out = await page.evaluate(async (url) => {
    const { createViewer } = await import('/packages/viewer/src/index.js');
    const host = document.body.appendChild(document.createElement('div'));
    host.style.cssText = 'width:200px;height:150px';
    const viewer = createViewer(host);
    const result = await viewer.load(url);
    const meshes = result.root.children.map((m) => [m.isInstancedMesh ?? false, m.count ?? 1]);
    const image = await window.describeImage(await viewer.toBlob());
    viewer.dispose();
    host.remove();
    return { meshes, instances: result.info.meshes, drawn: image.drawn };
  }, '/fixtures/nested_instancers.usda');
  assert.deepEqual(out, { meshes: [[true, 6]], instances: 6, drawn: true });
});

/** element.html without a src: the element module is loaded, nothing else. */
async function emptyElementPage() {
  await page.goto(`${BASE}/examples/element.html?src=`);
  await page.evaluate(() => document.getElementById('viewer').remove());
}

/** Appends a <usd-viewer> with `attributes` after `spacer` of page height; resolves its events into window.seen[id]. */
const addViewer = (id, attributes, spacer = '0') =>
  page.evaluate(
    ([id, attributes, spacer]) => {
      const gap = document.body.appendChild(document.createElement('div'));
      gap.style.height = spacer;
      const el = document.createElement('usd-viewer');
      el.id = id;
      el.style.height = '300px';
      (window.seen ??= {})[id] = [];
      for (const type of ['load', 'error', 'context-lost'])
        el.addEventListener(type, (e) => window.seen[id].push(type === 'error' ? `error:${e.error.message}` : type));
      for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
      document.body.append(el);
    },
    [id, attributes, spacer],
  );
const waitFor = (id, type, count = 1) =>
  page.waitForFunction(([id, type, count]) => window.seen[id].filter((t) => t === type).length >= count, [id, type, count], { timeout: 10000 });

test('<usd-viewer> reports a missing src as an ErrorEvent with a fetch UsdLoadError carrying the HTTP status', async () => {
  await page.goto(`${BASE}/examples/element.html?src=${encodeURIComponent('/fixtures/nope.usda')}`);
  await page.waitForFunction(() => window.loadError, null, { timeout: 10000 });
  const error = await page.evaluate(() => {
    const e = window.loadError;
    return { name: e.name, code: e.code, status: e.status, url: e.url, hasStack: e.message.includes('\n    at ') };
  });
  assert.deepEqual({ ...error, url: undefined }, { name: 'UsdLoadError', code: 'fetch', status: 404, url: undefined, hasStack: false });
  assert.ok(error.url.endsWith('/fixtures/nope.usda'), error.url);
});

test('<usd-viewer> loads src and dispatches progress and load; it is labelled, zooms from the keyboard and survives a move', async () => {
  await page.goto(`${BASE}/examples/element.html?src=${encodeURIComponent(SHAPES)}`);
  await page.waitForFunction(() => window.loaded, null, { timeout: 10000 });
  const { info, events, props } = await page.evaluate(() => {
    const el = document.getElementById('viewer');
    const busy = el.getAttribute('aria-busy');
    el.textures = 'none';
    el.touchAction = 'none';
    return {
      info: window.loaded,
      events: window.events,
      props: {
        role: el.viewer.renderer.domElement.getAttribute('role'),
        label: el.viewer.renderer.domElement.getAttribute('aria-label'),
        busy,
        texturesAttr: el.getAttribute('textures'),
        touch: el.viewer.renderer.domElement.style.touchAction,
        tabIndex: el.viewer.renderer.domElement.tabIndex,
        hasResult: !!el.result?.root,
        transparent: el.viewer.scene.background === null,
      },
    };
  });
  assert.equal(info.triangles, SHAPES_TRIANGLES);
  assert.ok(events.length > 0, 'progress events');
  assert.deepEqual(props, {
    role: 'img',
    label: 'USD model',
    busy: null,
    texturesAttr: 'none',
    touch: 'none',
    tabIndex: 0,
    hasResult: true,
    transparent: true,
  });
  assert.ok(
    events.some((e) => e.busy === 'true'),
    'aria-busy while loading',
  );
  // Keyboard: + zooms in, - zooms out; focus from the keyboard shows a ring.
  await page.keyboard.press('Tab');
  const distance = () => page.evaluate(() => document.getElementById('viewer').viewer.controls.getDistance());
  const before = await distance();
  await page.keyboard.press('+');
  const closer = await distance();
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  const farther = await distance();
  assert.ok(closer < before && farther > before, `${before} -> ${closer} -> ${farther}`);
  const ring = await page.evaluate(() => {
    const canvas = document.getElementById('viewer').viewer.renderer.domElement;
    return { focused: canvas.matches(':focus-visible'), outline: getComputedStyle(canvas).outlineStyle };
  });
  assert.deepEqual(ring, { focused: true, outline: 'solid' });
  // Moving the element keeps its viewer; removing it disposes the viewer.
  const lifecycle = await page.evaluate(async () => {
    const el = document.getElementById('viewer');
    const viewer = el.viewer;
    document.body.append(el);
    await Promise.resolve();
    const kept = el.viewer === viewer;
    el.remove();
    await Promise.resolve();
    return { kept, disposed: el.viewer === null };
  });
  assert.deepEqual(lifecycle, { kept: true, disposed: true });
});

test('<usd-viewer> lazy: nothing until it nears the viewport, eager at once, and scrolled far away it releases its viewer until it returns', async () => {
  await emptyElementPage();
  await fetch(`${BASE}/__stats/reset`);
  await addViewer('far', { src: SHAPES, alt: 'shapes' }, '300vh');
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => ({
    viewer: document.getElementById('far').viewer,
    canvases: document.getElementById('far').shadowRoot.querySelectorAll('canvas').length,
  }));
  assert.deepEqual(before, { viewer: null, canvases: 0 });
  assert.deepEqual(
    (await stats()).filter((r) => /\.wasm$|worker\.js$|\.usda$/.test(r.url)),
    [],
    'no WASM, worker or layer requested',
  );
  await page.evaluate(() => document.getElementById('far').scrollIntoView());
  await waitFor('far', 'load');
  await addViewer('eager', { src: SHAPES, loading: 'eager', textures: 'none' }, '600vh');
  await waitFor('eager', 'load');
  assert.deepEqual(await page.evaluate(() => ['far', 'eager'].map((id) => !!document.getElementById(id).viewer)), [true, true]);
  // Scrolled to the eager one, far below: the lazy one lets its viewer go, and loads again on return.
  await page.evaluate(() => document.getElementById('eager').scrollIntoView());
  await page.waitForFunction(() => !document.getElementById('far').viewer, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.getElementById('far').shadowRoot.querySelectorAll('canvas').length), 0);
  await page.evaluate(() => document.getElementById('far').scrollIntoView());
  await waitFor('far', 'load', 2);
  assert.equal(await page.evaluate(() => !!document.getElementById('eager').viewer), true, 'an eager element keeps its viewer');
});

test('<usd-viewer> poster: shown until the first geometry is drawn, then faded out', async () => {
  await emptyElementPage();
  await addViewer('p', { src: SHAPES, poster: '/fixtures/quadrants.png', alt: 'shapes', textures: 'none' });
  const poster = () =>
    page.evaluate(() => {
      const img = document.getElementById('p').shadowRoot.querySelector('img');
      return { hidden: img.hidden, faded: img.classList.contains('hidden'), alt: img.alt, src: img.getAttribute('src') };
    });
  assert.deepEqual(await poster(), { hidden: false, faded: false, alt: 'shapes', src: '/fixtures/quadrants.png' });
  await waitFor('p', 'load');
  await page.waitForTimeout(100);
  assert.deepEqual(await poster(), { hidden: false, faded: true, alt: '', src: '/fixtures/quadrants.png' });
});

test('<usd-viewer reveal="interaction">: loads only once its button is activated, from the keyboard too', async () => {
  await emptyElementPage();
  await addViewer('r', { src: SHAPES, reveal: 'interaction', alt: 'shapes', textures: 'none' });
  await page.waitForTimeout(300);
  const state = () =>
    page.evaluate(() => {
      const el = document.getElementById('r');
      const button = el.shadowRoot.querySelector('button');
      return { viewer: !!el.viewer, button: !button.hidden, label: button.getAttribute('aria-label') };
    });
  assert.deepEqual(await state(), { viewer: false, button: true, label: 'View in 3D: shapes' });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await waitFor('r', 'load');
  assert.deepEqual(await state(), { viewer: true, button: false, label: 'View in 3D: shapes' });
  assert.equal(await page.evaluate(() => document.getElementById('r').shadowRoot.activeElement?.tagName), 'CANVAS');
});

test('<usd-viewer> context loss: context-lost, the poster, then the model loads again on restore', async () => {
  await emptyElementPage();
  await addViewer('c', { src: SHAPES, poster: '/fixtures/quadrants.png', textures: 'none' });
  await waitFor('c', 'load');
  await page.evaluate(() => (window.lose = document.getElementById('c').viewer.renderer.getContext().getExtension('WEBGL_lose_context')).loseContext());
  await waitFor('c', 'context-lost');
  const lost = await page.evaluate(() => {
    const el = document.getElementById('c');
    return {
      result: el.result,
      faded: el.shadowRoot.querySelector('img').classList.contains('hidden'),
      meshes: el.viewer.scene.getObjectByName('usd') ? 1 : 0,
    };
  });
  assert.deepEqual(lost, { result: null, faded: false, meshes: 0 });
  await page.evaluate(() => window.lose.restoreContext());
  await waitFor('c', 'load', 2);
  const restored = await page.evaluate(() => {
    const el = document.getElementById('c');
    return { triangles: el.result.info.triangles, shown: el.viewer.scene.children.includes(el.result.root) };
  });
  assert.deepEqual(restored, { triangles: SHAPES_TRIANGLES, shown: true });
});

test('toBlob captures a freshly rendered frame, as PNG or WebP, at the canvas size or a given one', async () => {
  await emptyElementPage();
  await addViewer('s', { src: SHAPES, textures: 'none' });
  await waitFor('s', 'load');
  await page.evaluate(installDescribeImage);
  const shots = await page.evaluate(async () => {
    const describe = window.describeImage;
    const el = document.getElementById('s');
    const canvas = el.viewer.renderer.domElement;
    // Long after the last frame: only a fresh render has pixels to read.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const full = await describe(await el.toBlob());
    const thumb = await describe(await el.toBlob({ type: 'image/webp', width: 64, height: 48 }));
    const wide = await describe(await el.viewer.toBlob({ width: 100 }));
    const idle = await document
      .createElement('usd-viewer')
      .toBlob()
      .then(
        () => 'resolved',
        (e) => e.message,
      );
    return { full, thumb, wide, idle, canvas: [canvas.width, canvas.height] };
  });
  assert.deepEqual(shots.full, { type: 'image/png', width: shots.canvas[0], height: shots.canvas[1], drawn: true });
  assert.deepEqual(shots.thumb, { type: 'image/webp', width: 64, height: 48, drawn: true });
  assert.deepEqual(shots.wide, { type: 'image/png', width: 100, height: Math.round((100 * shots.canvas[1]) / shots.canvas[0]), drawn: true });
  assert.match(shots.idle, /no viewer to capture/);
});

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}: ${error.message.split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
