// Screenshots of the two assembly buildings for visual review.
//   node tests/e2e/preview_builder.mjs [quick | small] [low] [only=<name>[,<name>…]]      quick = 1440x900 only, small = 1024x768 only      → tests/out/bld-<width>-<name>.png
// Drives the real game (title → new sandbox game → builder), so the renderer settings are the shipped ones.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const quick = process.argv.includes('quick');
const only = (process.argv.find(a => a.startsWith('only=')) || '').slice(5);
// what a player with a GPU sees; pass `low` to review the software-rendering fallback instead
const quality = process.argv.includes('low') ? 'low' : 'high';

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const errors = [];
try {
  const sizes = process.argv.includes('small') ? [[1024, 768]] : quick ? [[1440, 900]] : [[1440, 900], [1024, 768]];
  for (const [w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(240000);
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e.stack || e)));
    console.log(`${w}x${h}: loading`);
    await page.goto(server.url);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    // DOM clicks: the title screen renders a heavy live scene, which can starve Playwright's actionability checks
    const tap = async sel => { await page.waitForSelector(sel, { timeout: 60000 }); await page.evaluate(q => document.querySelector(q).click(), sel); };
    await tap('[data-action="new"]');
    await tap('.sw-mode[data-mode="sandbox"]');
    await tap('.sw-modal .sw-btn.primary');
    await page.waitForFunction(() => window.__sw.app.currentName === 'hub' && window.__sw.app.current, null, { timeout: 60000 });

    console.log(`${w}x${h}: in the hub`);
    const enter = async params => {
      await page.evaluate(([p, q]) => window.__sw.app.goto('builder', { quality: q, ...p }), [params, quality]);
      await page.waitForFunction(() => window.__sw.app.currentName === 'builder' && window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
      await page.evaluate(() => { const b = document.querySelector('[data-action="hint-ok"]'); if (b) b.click(); });
    };
    const settle = () => page.waitForFunction(() => { const c = window.__sw.app.builder.camera; return Math.abs(c.dist - c.tdist) < 0.02 && Math.abs(c.ty - c.tty) < 0.02 && Math.abs(c.yaw - c.tyaw) < 0.005 && Math.abs(c.pitch - c.tpitch) < 0.005; }, null, { timeout: 120000 });
    const shot = async name => {
      if (only && !only.split(',').includes(name)) return;
      await settle(); await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(OUT, `bld-${w}-${name}.png`), timeout: 240000 });
      const info = await page.evaluate(() => window.__sw.app.builder.info);
      console.log(`${w}x${h} ${name}: ${info.calls} draw calls, ${info.triangles} triangles`);
    };
    const stock = n => page.evaluate(async name => {
      const m = await import('/js/core/craft.js');
      const list = m.stockCrafts();
      const c = list.find(x => x.name === name) || list[Math.min(list.length - 1, 2)];
      return c.toJSON();
    }, n);

    // --- Vehicle Assembly Building
    await enter({ site: 'pad', craft: await stock('Ember Twin') });
    const t0 = Date.now(), f0 = await page.evaluate(() => window.__sw.app.frame);
    await page.waitForTimeout(2000);
    const fps = (await page.evaluate(() => window.__sw.app.frame) - f0) / ((Date.now() - t0) / 1000);
    console.log(`${w}x${h}: ${fps.toFixed(1)} fps (software GL)`);
    await shot('vab-craft');
    // holding a part near an open node: markers, snap highlight, ghost
    await page.evaluate(() => { const b = window.__sw.app.builder; const top = b.nodes.filter(n => n.node === 'bottom').sort((p, q) => Math.abs(p.x - 760) - Math.abs(q.x - 760))[0] || b.nodes[0]; b.pick('tank_m200'); window.__node = top; });
    const node = await page.evaluate(() => window.__node);
    if (node) { await page.mouse.move(node.x + 60, node.y + 90); await page.mouse.move(node.x + 10, node.y + 40, { steps: 4 }); }
    await shot('vab-snap');
    await page.keyboard.press('Escape');
    // wide view of the hall
    await page.evaluate(() => { const b = window.__sw.app.builder; b.setCamera({ yaw: 2.4, pitch: 0.42, dist: 46 }); });
    await page.mouse.move(w / 2, h / 2);
    await shot('vab-wide');
    await page.evaluate(() => { const b = window.__sw.app.builder; b.setCamera({ yaw: -0.5, pitch: -0.18, dist: 30 }); });
    await shot('vab-up');
    // round 2: the lamps overhead, the floor crew and the grounding shade, the action-group editor
    await page.evaluate(() => { const b = window.__sw.app.builder; b.setCamera({ yaw: 0.6, pitch: -0.62, dist: 44 }); });
    await shot('vab-lamps');
    await page.evaluate(() => { const b = window.__sw.app.builder; b.setCamera({ yaw: 0.75, pitch: 0.3, dist: 24, ty: 3, fx: 9, fz: 9 }); });
    await shot('vab-floor');
    await page.evaluate(() => {
      const b = window.__sw.app.builder; b.setCamera({ yaw: -0.5, pitch: 0.16, dist: 34, ty: 9, fx: 0, fz: 0 });
      b.setTool('action'); b.setActionGroup('1');
      const eng = b.craft.parts.filter(p => /^eng_|^srb_/.test(p.type));
      for (const e of eng.slice(0, 2)) { const a = b.craft.actionsOf(e.id)[0]; if (a) b.bindAction('1', e.id, a.id); }
      const ch = b.craft.parts.find(p => p.type.startsWith('chute')); if (ch) { const a = b.craft.actionsOf(ch.id)[0]; if (a) b.bindAction('abort', ch.id, a.id); }
      if (eng[0]) b.select(eng[0].id);
    });
    await shot('vab-action');
    await page.evaluate(() => window.__sw.app.builder.setTool('place'));
    // empty hall with the first part hanging in the air, plus a loose piece
    await page.evaluate(() => { const b = window.__sw.app.builder; b.newCraft(); b.pick('pod_acorn'); });
    await page.mouse.move(w / 2 + 20, h / 2 - 40); await page.mouse.click(w / 2 + 20, h / 2 - 40);
    await page.evaluate(() => window.__sw.app.builder.pick('tank_m200'));
    await page.mouse.move(w / 2 + 190, h / 2 + 60); await page.mouse.click(w / 2 + 190, h / 2 + 60);
    await page.evaluate(() => window.__sw.app.builder.pick('tank_m200'));
    await page.mouse.move(w / 2 + 60, h / 2 + 90, { steps: 3 });
    await shot('vab-first');
    await page.keyboard.press('Escape');

    // --- Spaceplane Hangar
    await enter({ site: 'runway' });
    await shot('sph-empty');
    const plane = await page.evaluate(async () => {
      const m = await import('/js/core/craft.js');
      const c = m.stockCrafts().find(x => (m.stockSite ? m.stockSite(x) : x.site) === 'runway');
      return c ? c.toJSON() : null;
    });
    if (plane) { await page.evaluate(j => window.__sw.app.builder.loadCraft(j), plane); await shot('sph-craft'); }
    await page.evaluate(() => { const b = window.__sw.app.builder; b.setCamera({ yaw: 2.6, pitch: 0.2, dist: 60 }); });
    await shot('sph-wide');
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) { console.log('PAGE ERRORS:\n' + [...new Set(errors)].join('\n')); process.exitCode = 1; }
