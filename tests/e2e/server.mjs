// Tiny static file server for end-to-end tests.
//   const { url, port, close } = await startServer(rootDir)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
};

export function startServer(root, { port = 0, host = '127.0.0.1' } = {}) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); res.end('Bad request'); return; }
    let file = path.normalize(path.join(base, pathname));
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) file = path.join(file, 'index.html');
      fs.readFile(file, (err2, data) => {
        if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': data.length, 'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      resolve({
        url: `http://${host}:${p}/`, port: p, server,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

// Playwright may be installed locally or only globally (ESM `import` ignores NODE_PATH and global roots).
//   const { chromium } = await loadPlaywright()
export async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall through to the global install */ }
  const { createRequire } = await import('node:module');
  const { execSync } = await import('node:child_process');
  const roots = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* npm missing */ }
  roots.push(path.join(path.dirname(process.execPath), '../lib/node_modules'));
  for (const root of roots) {
    try { return createRequire(path.join(root, 'noop.js'))('playwright'); } catch { /* try the next root */ }
  }
  throw new Error('Playwright is not installed (looked locally and in: ' + roots.join(', ') + ')');
}

export const CHROMIUM_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
