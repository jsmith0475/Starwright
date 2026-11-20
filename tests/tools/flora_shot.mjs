// Screenshot the flora preview page: node tests/tools/flora_shot.mjs name "view=row&tod=0.4" [WxH] [dpr]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from '../e2e/server.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [name = 'flora', query = 'view=row', size = '960x600', dpr = '1'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const { chromium } = await loadPlaywright();
const server = await startServer(ROOT), browser = await chromium.launch({ args: CHROMIUM_ARGS });
let bad = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: +dpr })).newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') { console.log('[' + m.type() + '] ' + m.text().slice(0, 1500)); if (m.type() === 'error') bad++; } });
  page.on('pageerror', e => { console.log('[pageerror] ' + (e.stack || e.message)); bad++; });
  await page.goto(server.url + 'tests/flora-preview.html?' + query);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 180000 });
  const info = await page.evaluate(() => { const f = window.__flora, r = f.renderer; r.info.autoReset = false; r.info.reset(); f.frame(); const o = { calls: r.info.render.calls, tris: r.info.render.triangles, trees: { ...f.flora.stats }, grass: { ...f.grass.stats } }; r.info.autoReset = true; return o; });
  console.log(JSON.stringify(info));
  await page.screenshot({ path: path.join(ROOT, 'tests/out', `flora-${name}.png`), timeout: 180000 });
} finally { await browser.close(); await server.close(); }
process.exitCode = bad ? 1 : 0;
