// Browser checks for the public API: progress, abort, headers, custom fetch,
// warnings and the <usd-viewer> element. Needs the server (node bench/server.mjs).
// usage: BASE_URL=http://127.0.0.1:8811 node scripts/api-test.mjs [--hub]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8811';
const LAPTOP = '/data/LGElectronics/simready-assets/laptop_17z90ur/simready_usd/laptop_17z90ur.usd';
const THOR = '/data/standardbots/simready-thor/standardbots_thor/thor/standardbots_thor.usd';
// usd-wg/assets OpenChessSet (needs USDWG_DIR on the server): MaterialX-only materials referenced from .mtlx files.
const CHESS = '/usdwg/full_assets/OpenChessSet/chess_set.usda';
const HUB_LAPTOP = 'https://huggingface.co/datasets/LGElectronics/simready-assets/resolve/main/laptop_17z90ur/simready_usd/laptop_17z90ur.usd';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const stats = async () => (await (await fetch(`${BASE}/__stats/get`)).json()).requests;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A page with the library imported, for loadUsd calls through page.evaluate.
await page.goto(`${BASE}/examples/element.html`);

test('progress reports layers, compose and textures', async () => {
  const progress = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const seen = [];
    const result = await loadUsd(url, { onProgress: (p) => seen.push(p) });
    await result.complete;
    result.dispose();
    return seen;
  }, LAPTOP);
  const stages = [...new Set(progress.map((p) => p.stage))];
  assert.deepEqual(stages, ['layers', 'compose', 'geometry', 'textures']);
  const last = progress.at(-1);
  assert.equal(last.loaded, last.total);
  assert.ok(progress.find((p) => p.stage === 'layers').bytes > 1e6);
});

test('abort rejects with an aborted UsdLoadError and stops the worker', async () => {
  const outcome = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const controller = new AbortController();
    const pending = loadUsd(url, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    try {
      await pending;
      return 'resolved';
    } catch (error) {
      return `${error.name}:${error.code}`;
    }
  }, THOR);
  assert.equal(outcome, 'UsdLoadError:aborted');
  const already = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    return loadUsd(url, { signal: AbortSignal.abort() }).then(() => 'resolved', (e) => e.code);
  }, LAPTOP);
  assert.equal(already, 'aborted');
});

test('headers reach layer and texture requests', async () => {
  await fetch(`${BASE}/__stats/reset`);
  await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const result = await loadUsd(url, { headers: { Authorization: 'Bearer test-token' } });
    await result.complete;
    result.dispose();
  }, LAPTOP);
  // Only this load's requests (an earlier aborted load can still be draining).
  const data = (await stats()).filter((r) => r.url.startsWith('/data/LGElectronics/'));
  assert.ok(data.some((r) => r.url.endsWith('.usd')) && data.some((r) => r.url.endsWith('.jpg')));
  assert.ok(data.every((r) => r.auth === 'Bearer test-token'), JSON.stringify(data.map((r) => [r.url, r.auth])));
});

test('headers stay on the root origin: a cross-origin texture gets none', async () => {
  // The root (served through a route) authors its texture on another origin of the same server.
  const root = `${BASE}/__fixture/cross-origin.usda`;
  const texture = `http://localhost:${new URL(BASE).port}/conformance/fixtures/quadrants.png`;
  const usda = (await (await fetch(`${BASE}/conformance/fixtures/uv_set.usda`)).text()).replace('@quadrants.png@', `@${texture}@`);
  await page.context().route(root, (route) => route.fulfill({ body: usda, contentType: 'text/plain' }));
  await fetch(`${BASE}/__stats/reset`);
  const counts = await page.evaluate(async ([url, origin]) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const result = await loadUsd(url, { headers: { Authorization: 'Bearer round2-dummy' }, allowedOrigins: [origin] });
    const done = await result.complete;
    result.dispose();
    return done;
  }, [root, new URL(texture).origin]);
  const requests = (await stats()).filter((r) => r.url.endsWith('quadrants.png'));
  assert.deepEqual(counts, { textures: 1, failed: 0 });
  assert.ok(requests.length > 0 && requests.every((r) => r.auth === null), JSON.stringify(requests));
});

test('a texture outside allowedOrigins is never requested, through fetch or a custom fetch', async () => {
  const root = `${BASE}/__fixture/other-origin.usda`;
  const texture = `http://localhost:${new URL(BASE).port}/conformance/fixtures/quadrants.png`;
  const usda = (await (await fetch(`${BASE}/conformance/fixtures/uv_set.usda`)).text()).replace('@quadrants.png@', `@${texture}@`);
  await page.context().route(root, (route) => route.fulfill({ body: usda, contentType: 'text/plain' }));
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
  assert.deepEqual((await stats()).filter((r) => r.url.endsWith('quadrants.png')), []);
  assert.deepEqual(out.seen, [root]);
  for (const { counts, warning } of out.outcomes) {
    assert.deepEqual(counts, { textures: 0, failed: 1 });
    assert.match(warning, /not in allowedOrigins/);
  }
});

test('a custom fetch body is read only as far as the layer budget allows', async () => {
  const out = await page.evaluate(async () => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    let chunks = 0;
    const endless = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(4096).fill(32));
          },
        }),
      );
    const error = await loadUsd('/endless.usda', { maxLayerBytes: 1024, fetch: async () => endless() }).then(() => null, (e) => e);
    return { code: error?.code, message: error?.message, chunks };
  });
  assert.equal(out.code, 'fetch');
  assert.match(out.message, /resource limit exceeded/);
  assert.ok(out.chunks <= 3, `${out.chunks} chunks read`);
});

test('dispose aborts textures still pending in a custom fetch', async () => {
  const aborted = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const signals = [];
    const result = await loadUsd(url, {
      fetch: (u, init) => {
        if (!u.endsWith('.jpg')) return fetch(u, init);
        signals.push(init.signal);
        return new Promise(() => {});
      },
    });
    while (!signals.length) await new Promise((resolve) => setTimeout(resolve, 10));
    result.dispose();
    return signals.every((s) => s.aborted);
  }, LAPTOP);
  assert.equal(aborted, true);
});

test('a custom fetch serves every request', async () => {
  const urls = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const seen = [];
    const result = await loadUsd(url, { fetch: (u, init) => (seen.push(u), fetch(u, init)) });
    await result.complete;
    result.dispose();
    return seen;
  }, LAPTOP);
  assert.ok(urls.some((u) => u.endsWith('.usd')), 'layer through custom fetch');
  assert.ok(urls.filter((u) => u.endsWith('.jpg')).length >= 3, 'textures through custom fetch');
});

// A fake Hub package: the root uses a.usda, the listing also names unused.usda.
const HUB_PKG = 'https://huggingface.co/datasets/o/r/resolve/main/pkg/';
const HUB_TREE = 'https://huggingface.co/api/datasets/o/r/tree/main/pkg?recursive=true';
const HUB_FILES = {
  'root.usda': '#usda 1.0\n(subLayers = [@./a.usda@])',
  'a.usda': '#usda 1.0\ndef Mesh "M" {\n  int[] faceVertexCounts = [3]\n  int[] faceVertexIndices = [0, 1, 2]\n  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n}',
  'unused.usda': '#usda 1.0\ndef Xform "Unused" {}',
};

test('a Hub package is fetched ahead with the load headers, used only where composition asks', async () => {
  const seen = [];
  await page.context().route('https://huggingface.co/**', async (route) => {
    const url = route.request().url();
    seen.push([url, (await route.request().allHeaders()).authorization ?? null]);
    if (url === HUB_TREE) return route.fulfill({ json: Object.entries(HUB_FILES).map(([name, body]) => ({ type: 'file', path: `pkg/${name}`, size: body.length })), headers: { 'access-control-allow-origin': '*' } });
    const body = HUB_FILES[url.slice(HUB_PKG.length)];
    return body ? route.fulfill({ body, headers: { 'access-control-allow-origin': '*' } }) : route.fulfill({ status: 404 });
  });
  const meshes = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const result = await loadUsd(url, { headers: { Authorization: 'Bearer hub-dummy' } });
    result.dispose();
    return result.info.meshes;
  }, HUB_PKG + 'root.usda');
  await page.context().unroute('https://huggingface.co/**');
  assert.equal(meshes, 1);
  assert.deepEqual(seen.map(([url]) => url).sort(), [HUB_TREE, ...['a.usda', 'root.usda', 'unused.usda'].map((name) => HUB_PKG + name)].sort());
  assert.ok(seen.every(([, auth]) => auth === 'Bearer hub-dummy'), JSON.stringify(seen));
});

test('a custom fetch serves the Hub listing and its prefetches, and abort cancels them', async () => {
  const out = await page.evaluate(
    async ({ pkg, tree, files }) => {
      const { loadUsd } = await import('/packages/viewer/src/index.js');
      const held = {};
      const controller = new AbortController();
      const fetchFn = (url, init) => {
        if (url === tree) return Promise.resolve(Response.json(Object.entries(files).map(([name, body]) => ({ type: 'file', path: `pkg/${name}`, size: body.length }))));
        const name = url.slice(pkg.length);
        if (name === 'root.usda') return Promise.resolve(new Response(files[name]));
        held[name] = init.signal;
        return new Promise(() => {});
      };
      const pending = loadUsd(pkg + 'root.usda', { fetch: fetchFn, signal: controller.signal }).then(() => 'resolved', (e) => e.code);
      const deadline = performance.now() + 5000;
      while (!(held['a.usda'] && held['unused.usda']) && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      return { outcome: await pending, held: Object.keys(held).sort(), aborted: Object.values(held).every((signal) => signal.aborted) };
    },
    { pkg: HUB_PKG, tree: HUB_TREE, files: HUB_FILES },
  );
  assert.deepEqual(out, { outcome: 'aborted', held: ['a.usda', 'unused.usda'], aborted: true });
});

test('textures past maxTextureBytes, over 16384 px a side or of unchecked formats fail as warnings, not the load', async () => {
  const out = await page.evaluate(async () => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    // A PNG header claiming 20000 x 20000 px.
    const huge = new Uint8Array(33);
    huge.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(huge.buffer).setUint32(16, 20000);
    new DataView(huge.buffer).setUint32(20, 20000);
    huge.set([8, 6], 24);
    const gif = new TextEncoder().encode('GIF89a\x10\x00\x10\x00\x00\x00\x00');
    const outcomes = [];
    for (const [options, png] of [[{ maxTextureBytes: 100 }, null], [{}, huge], [{}, gif]]) {
      const fetchFn = (u, init) => (png && u.endsWith('.png') ? Promise.resolve(new Response(png)) : fetch(u, init));
      const result = await loadUsd('/conformance/fixtures/uv_set.usda', { ...options, fetch: fetchFn });
      outcomes.push({ counts: await result.complete, messages: result.info.warnings.filter((w) => w.code === 'texture-failed').map((w) => w.message) });
      result.dispose();
    }
    return outcomes;
  });
  assert.deepEqual(out.map((o) => o.counts), [{ textures: 0, failed: 1 }, { textures: 0, failed: 1 }, { textures: 0, failed: 1 }]);
  assert.match(out[0].messages[0], /maxTextureBytes/);
  assert.match(out[1].messages[0], /image too large: 20000x20000/);
  assert.match(out[2].messages[0], /unsupported image format/);
});

test('a file cannot make a Hub load request API endpoints, other hosts or credentials outside its repo', async () => {
  const root = 'https://huggingface.co/datasets/o/r/resolve/main/pkg/ssrf.usda';
  const usda = `#usda 1.0
(subLayers = [@../../../../../../api/whoami-v2.usda@, @/victim/private/resolve/main/secret.usda@, @@@https://huggingface.co@attacker.example/a.usda@@@, @http://127.0.0.1:9/admin.usda@])
def Mesh "M" {
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0, 1, 2]
  point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
}`;
  const seen = [];
  const record = async (route) => {
    const request = route.request();
    seen.push([request.url(), (await request.allHeaders()).authorization ?? null]);
    if (request.url() === root) return route.fulfill({ body: usda, headers: { 'access-control-allow-origin': '*' } });
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
  };
  await page.context().route('https://huggingface.co/**', record);
  await page.context().route('https://attacker.example/**', record);
  const warnings = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const result = await loadUsd(url, { headers: { Authorization: 'Bearer hub-dummy' } });
    result.dispose();
    return result.info.warnings.filter((w) => w.code === 'layer-missing').length;
  }, root);
  await page.context().unroute('https://huggingface.co/**');
  await page.context().unroute('https://attacker.example/**');
  const files = seen.filter(([url]) => !url.includes('/api/datasets/o/r/tree/'));
  assert.equal(warnings, 4);
  assert.deepEqual(files, [
    [root, 'Bearer hub-dummy'],
    ['https://huggingface.co/victim/private/resolve/main/secret.usda', null],
  ]);
});

test('warnings name grey fallback materials and unresolved layers', async () => {
  const warnings = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const result = await loadUsd(url);
    result.dispose();
    return result.info.warnings;
  }, CHESS);
  assert.ok(warnings.some((w) => w.code === 'material-fallback' && w.path), JSON.stringify(warnings));
  assert.ok(warnings.some((w) => w.code === 'composition' && w.message.startsWith('unresolved')), JSON.stringify(warnings));
});

test('a missing root layer fails with a fetch error carrying the HTTP status', async () => {
  const error = await page.evaluate(async () => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    return loadUsd('/data/nope/missing.usda').then(
      () => null,
      (e) => ({ name: e.name, code: e.code, status: e.status, url: e.url, hasStack: e.message.includes('\n    at ') }),
    );
  });
  assert.deepEqual({ ...error, url: undefined }, { name: 'UsdLoadError', code: 'fetch', status: 404, url: undefined, hasStack: false });
  assert.ok(error.url.endsWith('/data/nope/missing.usda'));
});

test('layers nested too deeply fail with a compose error that says so', async () => {
  const error = await page.evaluate(async () => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const usda = '#usda 1.0\n' + 'def Xform "A" {\n'.repeat(100000) + '}\n'.repeat(100000);
    return loadUsd('/deep.usda', { fetch: async () => new Response(usda) }).then(() => null, (e) => ({ code: e.code, message: e.message }));
  });
  assert.equal(error?.code, 'compose');
  assert.match(error.message, /^stack overflow: the layers nest too deeply to read/);
});

test('a missing sublayer is a warning, through fetch and a custom fetch alike', async () => {
  const out = await page.evaluate(async (root) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const plain = await loadUsd(root);
    const custom = await loadUsd(root, { fetch: (u, init) => fetch(u, init) });
    plain.dispose();
    custom.dispose();
    return [plain.info.warnings.map((w) => w.code), custom.info.warnings.map((w) => w.code)];
  }, '/conformance/fixtures/missing_sublayer.usda');
  assert.deepEqual(out[0], out[1], 'same warnings either way');
  assert.ok(out[0].includes('layer-missing'), JSON.stringify(out));
});

test('overlapping viewer.load calls: the newer one wins and the older is discarded', async () => {
  const out = await page.evaluate(async ([a, b]) => {
    const { createViewer } = await import('/packages/viewer/src/index.js');
    const host = document.body.appendChild(document.createElement('div'));
    host.style.cssText = 'width:200px;height:150px';
    const viewer = createViewer(host);
    const first = viewer.load(a).then(() => 'resolved', (e) => e.code);
    const second = await viewer.load(b);
    const firstOutcome = await first;
    const shown = viewer.scene.children.filter((c) => c.name === 'usd').length;
    const secondStillShown = viewer.scene.children.includes(second.root);
    viewer.dispose();
    viewer.dispose();
    return { firstOutcome, shown, secondStillShown, canvasRemoved: !host.querySelector('canvas') };
  }, [THOR, LAPTOP]);
  assert.deepEqual(out, { firstOutcome: 'aborted', shown: 1, secondStillShown: true, canvasRemoved: true });
});

test('textures none loads no textures; complete reports counts', async () => {
  const counts = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const none = await loadUsd(url, { textures: 'none' });
    const preview = await loadUsd(url);
    const result = [await none.complete, await preview.complete];
    none.dispose();
    preview.dispose();
    return result;
  }, LAPTOP);
  assert.deepEqual(counts, [{ textures: 0, failed: 0 }, { textures: 3, failed: 0 }]);
});

test('<usd-viewer> reports a missing src as an ErrorEvent with a UsdLoadError', async () => {
  await page.goto(`${BASE}/examples/element.html?src=${encodeURIComponent('/data/nope/missing.usd')}`);
  await page.waitForFunction(() => window.loadError, null, { timeout: 30000 });
  const error = await page.evaluate(() => ({ name: window.loadError.name, code: window.loadError.code, status: window.loadError.status }));
  assert.deepEqual(error, { name: 'UsdLoadError', code: 'fetch', status: 404 });
});

test('<usd-viewer> loads src and dispatches progress and load', async () => {
  await page.goto(`${BASE}/examples/element.html?src=${encodeURIComponent(process.argv.includes('--hub') ? HUB_LAPTOP : LAPTOP)}`);
  await page.waitForFunction(() => window.loaded, null, { timeout: 60000 });
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
  assert.equal(info.triangles, 134228);
  assert.ok(events.length > 0, 'progress events');
  assert.deepEqual(props, { role: 'img', label: 'USD model', busy: null, texturesAttr: 'none', touch: 'none', tabIndex: 0, hasResult: true, transparent: true });
  assert.ok(events.some((e) => e.busy === 'true'), 'aria-busy while loading');
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
  await page.waitForTimeout(1500);
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

/** element.html without a src: the element module is loaded, nothing else. */
async function emptyElementPage() {
  await page.goto(`${BASE}/examples/element.html?src=`);
  await page.evaluate(() => document.getElementById('viewer').remove());
}

/** Appends a <usd-viewer> with `attributes` after `spacer` of page height; resolves its events into window.events[id]. */
const addViewer = (id, attributes, spacer = '0') =>
  page.evaluate(
    ([id, attributes, spacer]) => {
      const gap = document.body.appendChild(document.createElement('div'));
      gap.style.height = spacer;
      const el = document.createElement('usd-viewer');
      el.id = id;
      el.style.height = '300px';
      (window.seen ??= {})[id] = [];
      for (const type of ['load', 'error', 'context-lost']) el.addEventListener(type, (e) => window.seen[id].push(type === 'error' ? `error:${e.error.message}` : type));
      for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
      document.body.append(el);
    },
    [id, attributes, spacer],
  );
const seenBy = (id) => page.evaluate((id) => window.seen[id], id);
const waitFor = (id, type) => page.waitForFunction(([id, type]) => window.seen[id].includes(type), [id, type], { timeout: 60000 });

test('<usd-viewer> lazy: nothing is created until it nears the viewport; eager starts at once', async () => {
  await emptyElementPage();
  await fetch(`${BASE}/__stats/reset`);
  await addViewer('far', { src: LAPTOP, alt: 'laptop' }, '300vh');
  await page.waitForTimeout(1000);
  const before = await page.evaluate(() => ({ viewer: document.getElementById('far').viewer, canvases: document.getElementById('far').shadowRoot.querySelectorAll('canvas').length }));
  assert.deepEqual(before, { viewer: null, canvases: 0 });
  assert.deepEqual((await stats()).filter((r) => /\.wasm$|worker\.js$|\.usd$/.test(r.url)), [], 'no WASM, worker or layer requested');
  await page.evaluate(() => document.getElementById('far').scrollIntoView());
  await waitFor('far', 'load');
  await addViewer('eager', { src: LAPTOP, loading: 'eager', textures: 'none' }, '300vh');
  await waitFor('eager', 'load');
  assert.deepEqual(await page.evaluate(() => ['far', 'eager'].map((id) => !!document.getElementById(id).viewer)), [true, true]);
});

test('<usd-viewer> poster: shown until the first geometry is drawn, then faded out', async () => {
  await emptyElementPage();
  await addViewer('p', { src: LAPTOP, poster: '/conformance/fixtures/quadrants.png', alt: 'laptop', textures: 'none' });
  const poster = () => page.evaluate(() => {
    const img = document.getElementById('p').shadowRoot.querySelector('img');
    return { hidden: img.hidden, faded: img.classList.contains('hidden'), alt: img.alt, src: img.getAttribute('src') };
  });
  assert.deepEqual(await poster(), { hidden: false, faded: false, alt: 'laptop', src: '/conformance/fixtures/quadrants.png' });
  await waitFor('p', 'load');
  await page.waitForTimeout(100);
  assert.deepEqual(await poster(), { hidden: false, faded: true, alt: '', src: '/conformance/fixtures/quadrants.png' });
});

test('<usd-viewer reveal="interaction">: loads only once its button is activated, from the keyboard too', async () => {
  await emptyElementPage();
  await addViewer('r', { src: LAPTOP, reveal: 'interaction', alt: 'laptop', textures: 'none' });
  await page.waitForTimeout(500);
  const state = () => page.evaluate(() => {
    const el = document.getElementById('r');
    const button = el.shadowRoot.querySelector('button');
    return { viewer: !!el.viewer, button: !button.hidden, label: button.getAttribute('aria-label') };
  });
  assert.deepEqual(await state(), { viewer: false, button: true, label: 'View in 3D: laptop' });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await waitFor('r', 'load');
  assert.deepEqual(await state(), { viewer: true, button: false, label: 'View in 3D: laptop' });
  assert.equal(await page.evaluate(() => document.getElementById('r').shadowRoot.activeElement?.tagName), 'CANVAS');
});

test('<usd-viewer> context loss: context-lost, the poster, then the model loads again on restore', async () => {
  await emptyElementPage();
  await addViewer('c', { src: LAPTOP, poster: '/conformance/fixtures/quadrants.png', textures: 'none' });
  await waitFor('c', 'load');
  await page.evaluate(() => (window.lose = document.getElementById('c').viewer.renderer.getContext().getExtension('WEBGL_lose_context')).loseContext());
  await waitFor('c', 'context-lost');
  const lost = await page.evaluate(() => {
    const el = document.getElementById('c');
    return { result: el.result, faded: el.shadowRoot.querySelector('img').classList.contains('hidden'), meshes: el.viewer.scene.getObjectByName('usd') ? 1 : 0 };
  });
  assert.deepEqual(lost, { result: null, faded: false, meshes: 0 });
  await page.evaluate(() => window.lose.restoreContext());
  await page.waitForFunction(() => window.seen.c.filter((t) => t === 'load').length === 2, null, { timeout: 60000 });
  const restored = await page.evaluate(() => {
    const el = document.getElementById('c');
    return { triangles: el.result.info.triangles, shown: el.viewer.scene.children.includes(el.result.root) };
  });
  assert.deepEqual(restored, { triangles: 134228, shown: true });
});

test('<usd-viewer> lazy elements scrolled far away release their viewer and load again on return', async () => {
  await emptyElementPage();
  await addViewer('top', { src: LAPTOP, textures: 'none' });
  await waitFor('top', 'load');
  await addViewer('bottom', { src: LAPTOP, textures: 'none' }, '600vh');
  await page.evaluate(() => document.getElementById('bottom').scrollIntoView());
  await waitFor('bottom', 'load');
  await page.waitForFunction(() => !document.getElementById('top').viewer, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.getElementById('top').shadowRoot.querySelectorAll('canvas').length), 0);
  await page.evaluate(() => document.getElementById('top').scrollIntoView());
  await page.waitForFunction(() => window.seen.top.filter((t) => t === 'load').length === 2, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.getElementById('bottom').viewer, null, { timeout: 10000 });
});

test('toBlob captures a freshly rendered frame, as PNG or WebP, at the canvas size or a given one', async () => {
  await emptyElementPage();
  await addViewer('s', { src: LAPTOP, textures: 'none' });
  await waitFor('s', 'load');
  const shots = await page.evaluate(async () => {
    const el = document.getElementById('s');
    const canvas = el.viewer.renderer.domElement;
    const describe = async (blob) => {
      const bitmap = await createImageBitmap(blob);
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let drawn = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]) drawn++;
      return { type: blob.type, width: bitmap.width, height: bitmap.height, drawn: drawn > 100 };
    };
    // Long after the last frame: only a fresh render has pixels to read.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const full = await describe(await el.toBlob());
    const thumb = await describe(await el.toBlob({ type: 'image/webp', width: 64, height: 48 }));
    const wide = await describe(await el.viewer.toBlob({ width: 100 }));
    return { full, thumb, wide, canvas: [canvas.width, canvas.height], restored: [canvas.width, canvas.height].join() === [el.viewer.renderer.domElement.width, el.viewer.renderer.domElement.height].join() };
  });
  assert.deepEqual(shots.full, { type: 'image/png', width: shots.canvas[0], height: shots.canvas[1], drawn: true });
  assert.deepEqual(shots.thumb, { type: 'image/webp', width: 64, height: 48, drawn: true });
  assert.deepEqual(shots.wide, { type: 'image/png', width: 100, height: Math.round((100 * shots.canvas[1]) / shots.canvas[0]), drawn: true });
  const idle = await page.evaluate(() => {
    const el = document.createElement('usd-viewer');
    return el.toBlob().then(() => 'resolved', (e) => e.message);
  });
  assert.match(idle, /no viewer to capture/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message.split('\n')[0]}`);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
