// Static server for the examples and the browser tests (scripts/api-test.mjs starts its own).
// - Serves the repo, local SimReady data under /data/ (USD_DATA) and a usd-wg/assets checkout under /usdwg/ (USDWG_DIR).
// - No COOP/COEP, like a normal page on the Hub.
// - Code (JS/WASM) is brotli-compressed when accepted, as a CDN would serve it.
// - Counts requests and bytes per run (/__stats/reset, /__stats/get).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_DATA = process.env.USD_DATA || path.join(ROOT, '..', 'usd-viewer-bench-data');
// A checkout of https://github.com/usd-wg/assets.
const USDWG_DIR = process.env.USDWG_DIR || path.join(ROOT, '..', 'usd-wg-assets', 'repo');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.usdz': 'model/vnd.usdz+zip',
  '.usda': 'text/plain; charset=utf-8',
};

let stats = { requests: [] };
const brCache = new Map();

function send(req, res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
  stats.requests.push({ url: req.url, status, bytes: body ? body.length : 0, t: Date.now(), auth: req.headers.authorization || null });
}

function sendFile(req, res, file, headers, isCode) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(req, res, 404, { 'content-type': 'text/plain', ...headers }, Buffer.from('not found'));
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const base = { 'content-type': type, 'cache-control': 'no-store', ...headers };
    if (isCode && /\bbr\b/.test(req.headers['accept-encoding'] || '')) {
      let body = brCache.get(file);
      if (!body || body.source !== buf.length) {
        body = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
        body.source = buf.length;
        brCache.set(file, body);
      }
      return send(req, res, 200, { ...base, 'content-encoding': 'br', 'content-length': body.length }, body);
    }
    send(req, res, 200, { ...base, 'content-length': buf.length }, buf);
  });
}

function under(base, rel) {
  const file = path.normalize(path.join(base, rel));
  return file.startsWith(base) ? file : null;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization' };
    if (url.pathname === '/__stats/reset') {
      stats = { requests: [] };
      return send(req, res, 200, { 'content-type': 'application/json', ...headers }, Buffer.from('{}'));
    }
    if (url.pathname === '/__stats/get') {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      return res.end(JSON.stringify(stats));
    }
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/examples/index.html' });
      return res.end();
    }
    const rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/data/')) {
      const file = under(LOCAL_DATA, rel.slice('/data/'.length));
      return file ? sendFile(req, res, file, headers, false) : send(req, res, 400, headers, Buffer.from('bad path'));
    }
    if (rel.startsWith('/usdwg/')) {
      const file = under(USDWG_DIR, rel.slice('/usdwg/'.length));
      return file ? sendFile(req, res, file, headers, false) : send(req, res, 400, headers, Buffer.from('bad path'));
    }
    const file = under(ROOT, rel);
    if (!file) return send(req, res, 400, headers, Buffer.from('bad path'));
    sendFile(req, res, file, headers, /\.(m?js|wasm)$/.test(file));
  })
  .listen(Number(process.env.PORT || 8811), '127.0.0.1', function () {
    console.log(`http://127.0.0.1:${this.address().port}`);
  });
