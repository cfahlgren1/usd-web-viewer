// Builds this Vite app, serves the build and loads a Hub USD file in Chromium.
// usage: npm install && node test.mjs
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright';

execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
try {
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto('http://localhost:4173/');
  await page.waitForFunction(() => window.loaded || window.loadError, null, { timeout: 60000 });
  const { loaded, loadError } = await page.evaluate(() => ({ loaded: window.loaded, loadError: window.loadError }));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'vite-build.png' });
  await browser.close();
  if (loadError) throw new Error(loadError);
  console.log(`ok: ${loaded.meshes} meshes, ${loaded.triangles} triangles from the Hub in a Vite production build`);
} finally {
  server.kill();
}
