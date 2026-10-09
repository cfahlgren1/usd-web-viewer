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
  assert.deepEqual(stages, ['layers', 'compose', 'textures']);
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
    el.textures = 'none';
    el.touchAction = 'none';
    return {
      info: window.loaded,
      events: window.events,
      props: {
        role: el.getAttribute('role'),
        label: el.getAttribute('aria-label'),
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
  assert.deepEqual(props, { role: 'img', label: 'USD model', texturesAttr: 'none', touch: 'none', tabIndex: 0, hasResult: true, transparent: true });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/usd-viewer-element.png' });
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
