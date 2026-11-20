// Capture the first seconds of the demo's launch chapter (and optionally others) at full quality, paused, from several angles.
//   node tests/e2e/preview_demo_launch.mjs [chapter] [WxH]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';
const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
const id = process.argv[2] || 'launch';
const FROM = process.env.FROM || id;
const [W, H] = (process.argv[3] || '1440x900').split('x').map(Number);
const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', e => console.log('page error: ' + e.message));
await page.goto(server.url + `index.html?demo=1&chapter=${FROM}&clean=1&hq=1${process.env.FAST ? '&fast=1' : ''}`, { timeout: 180000 });
await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app.demo && window.__sw.app.demo.running, null, { timeout: 180000 });
await page.waitForFunction(cid => { const a = window.__sw.app; return a.demo.state().chapter === cid && a.flight && a.flight.scene && a.world && a.world.active; }, id, { timeout: 600000, polling: 100 });
for (let i = 0; i < (process.env.N || 9); i++) {
  await page.waitForTimeout(2500);
  console.log(JSON.stringify(await page.evaluate(() => { const a = window.__sw.app, v = a.world.active; return { alt: v.altitude, radar: v.radarAlt, landed: v.landed, clock: a.demo.state().clock }; })));
  await page.screenshot({ path: path.join(OUT, `demolaunch-${id}-${i}-${W}x${H}.png`), timeout: 300000 });
}
console.log(JSON.stringify(await page.evaluate(() => { const s = window.__sw.app.demo.state(); return { ch: s.chapters.slice(0,6), log: s.log }; }), null, 1));
await browser.close(); await server.close();
