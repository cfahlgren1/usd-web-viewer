// Builds this Vite app, serves the build and loads a repo fixture in Chromium.
// usage: npm install && node test.mjs
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const FIXTURES = new URL('../../fixtures/', import.meta.url);

execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
try {
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  // The fixtures, as if the build's own server had them.
  await page.context().route(
    (url) => url.pathname.startsWith('/fixtures/'),
    (route) => route.fulfill({ body: readFileSync(new URL(new URL(route.request().url()).pathname.slice('/fixtures/'.length), FIXTURES)) }),
  );
  await page.goto('http://localhost:4173/?src=/fixtures/implicit_gprims.usda');
  await page.waitForFunction(() => window.loaded || window.loadError, null, { timeout: 30000 });
  const { loaded, loadError } = await page.evaluate(() => ({ loaded: window.loaded, loadError: window.loadError }));
  await browser.close();
  if (loadError) throw new Error(loadError);
  if (!loaded.meshes) throw new Error('nothing drawn');
  console.log(`ok: ${loaded.meshes} meshes, ${loaded.triangles} triangles in a Vite production build`);
} finally {
  server.kill();
}
