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
    await result.textures;
    result.dispose();
    return seen;
  }, LAPTOP);
  const stages = [...new Set(progress.map((p) => p.stage))];
  assert.deepEqual(stages, ['layers', 'compose', 'textures']);
  const last = progress.at(-1);
  assert.equal(last.loaded, last.total);
  assert.ok(progress.find((p) => p.stage === 'layers').bytes > 1e6);
});

test('abort rejects with AbortError and stops the worker', async () => {
  const outcome = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const controller = new AbortController();
    const pending = loadUsd(url, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    try {
      await pending;
      return 'resolved';
    } catch (error) {
      return error.name;
    }
  }, THOR);
  assert.equal(outcome, 'AbortError');
  const already = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    return loadUsd(url, { signal: AbortSignal.abort() }).then(() => 'resolved', (e) => e.name);
  }, LAPTOP);
  assert.equal(already, 'AbortError');
});

test('headers reach layer and texture requests', async () => {
  await fetch(`${BASE}/__stats/reset`);
  await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const result = await loadUsd(url, { headers: { Authorization: 'Bearer test-token' } });
    await result.textures;
    result.dispose();
  }, LAPTOP);
  const data = (await stats()).filter((r) => r.url.startsWith('/data/'));
  assert.ok(data.some((r) => r.url.endsWith('.usd')) && data.some((r) => r.url.endsWith('.jpg')));
  assert.ok(data.every((r) => r.auth === 'Bearer test-token'), JSON.stringify(data.map((r) => [r.url, r.auth])));
});

test('a custom fetch serves every request', async () => {
  const urls = await page.evaluate(async (url) => {
    const { loadUsd } = await import('/packages/viewer/src/index.js');
    const seen = [];
    const result = await loadUsd(url, { fetch: (u, init) => (seen.push(u), fetch(u, init)) });
    await result.textures;
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
  assert.ok(warnings.some((w) => w.includes('show as grey')), JSON.stringify(warnings));
  assert.ok(warnings.some((w) => w.startsWith('composition: unresolved')), JSON.stringify(warnings));
});

test('<usd-viewer> loads src and dispatches progress and load', async () => {
  await page.goto(`${BASE}/examples/element.html?src=${encodeURIComponent(process.argv.includes('--hub') ? HUB_LAPTOP : LAPTOP)}`);
  await page.waitForFunction(() => window.loaded, null, { timeout: 60000 });
  const { info, events } = await page.evaluate(() => ({ info: window.loaded, events: window.events }));
  assert.equal(info.triangles, 134228);
  assert.ok(events.length > 0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/usd-viewer-element.png' });
  // Removing the element disposes the viewer.
  const removed = await page.evaluate(() => {
    const el = document.getElementById('viewer');
    el.remove();
    return el.viewer === null;
  });
  assert.ok(removed);
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
