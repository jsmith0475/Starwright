// Screenshots of the 3D Flight Center (hub and title) at several times of day and camera angles.
//   node tests/e2e/preview_base.mjs [quick]        → tests/out/base-*.png
// It drives the real game (title → new sandbox game → hub) so what is judged is what ships.
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

const TIMES = { dawn: 0.262, noon: 0.5, dusk: 0.735, night: 0.02 };
// camera poses: target [x, y, z], azimuth, elevation, distance (see js/ui/baseview.js)
const VIEWS = {
  overview: null,
  high: { target: [40, 0, 430], az: 0.2, el: 0.95, dist: 2300 },
  pad: { target: [6, 26, -4], az: 2.5, el: 0.2, dist: 300 },
  vab: { target: [0, 45, 500], az: -0.75, el: 0.24, dist: 420 },
  campus: { target: [-250, 10, 560], az: 0.9, el: 0.3, dist: 620 },
  runway: { target: [-640, 5, 800], az: -1.9, el: 0.16, dist: 520 },
  tracking: { target: [620, 20, 210], az: 1.2, el: 0.22, dist: 330 },
  low: { target: [200, 10, 520], az: 4.2, el: 0.075, dist: 900 },
};
const PLAN = quick
  ? [['noon', 'overview'], ['noon', 'high'], ['dusk', 'campus'], ['night', 'pad'], ['dawn', 'low'], ['night', 'overview']]
  : Object.keys(TIMES).flatMap(t => ['overview', 'pad', 'vab', 'campus'].map(v => [t, v])).concat([['noon', 'high'], ['noon', 'runway'], ['noon', 'tracking'], ['dusk', 'low'], ['dawn', 'runway'], ['night', 'tracking']]);
const SMALL = new Set(['noon-overview', 'dusk-overview', 'night-overview', 'noon-pad', 'dawn-vab', 'noon-campus']);

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const errors = [];
try {
  for (const [w, h] of quick || only === 'life' ? [[1440, 900]] : [[1440, 900], [1024, 768]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e.stack || e)));
    await page.goto(server.url);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    const snap = async (name, hoverId = null) => {
      await page.evaluate(id => { const app = window.__sw.app, view = window.__swView; if (app.current && app.current.update) app.current.update(0.016); else view.update(0.016, { drift: false }); view.render(id, true); }, hoverId);
      await page.waitForTimeout(450);
      await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 180000 });
      console.log('  ' + name);
    };
    await page.evaluate(async () => { const m = await import('./js/ui/baseview.js'); window.__swView = m.getBaseView(window.__sw.app); window.__swView.lockQuality(0); window.__swView.freeze(true); });
    await page.waitForSelector('.sw-title-screen.ready', { timeout: 60000 });
    if (!only || only === 'title') await snap(`base-${w}-title`);
    await page.click('[data-action="new"]');
    await page.click('.sw-mode[data-mode="career"]');
    await page.click('.sw-modal .sw-btn.primary');
    await page.waitForFunction(() => window.__sw.app.currentName === 'hub' && window.__sw.app.current, null, { timeout: 60000 });
    await page.waitForTimeout(600);
    const info = await page.evaluate(() => { const v = window.__swView, r = window.__sw.app.renderer; r.info.autoReset = false; r.info.reset(); v.update(0.016, { drift: false }); v.render('hangar', true); const o = { calls: r.info.render.calls, tris: r.info.render.triangles, geos: r.info.memory.geometries, tex: r.info.memory.textures }; r.info.autoReset = true; return o; });
    console.log(`${w}x${h}: one frame with highlight = ${info.calls} draw calls (all passes), ${info.tris} triangles, ${info.geos} geometries, ${info.tex} textures`);
    for (const [time, viewName] of PLAN) {
      if (only && only !== viewName && only !== time && only !== `${time}-${viewName}`) continue;
      if (w < 1200 && !only && !SMALL.has(`${time}-${viewName}`)) continue;
      await page.evaluate(([tod, pose]) => {
        const v = window.__sw.app.screens.hub.debug.view;
        v.setTimeOfDay(tod);
        if (pose) v.flyTo({ target: new v.camera.position.constructor(...pose.target), az: pose.az, el: pose.el, dist: pose.dist }, { snap: true }); else v.home(true);
      }, [TIMES[time], VIEWS[viewName]]);
      await snap(`base-${w}-${time}-${viewName}`);
    }
    if (!only || only === 'hover') {
      // hover: the name plate and the outline
      await page.evaluate(() => { const v = window.__sw.app.screens.hub.debug.view; v.setTimeOfDay(0.42); v.home(true); });
      await page.evaluate(() => window.__swView.update(0.016, { drift: false }));
      await page.waitForTimeout(400);
      const p = await page.evaluate(() => window.__sw.app.screens.hub.debug.screenPos('hangar'));
      await page.mouse.move(p.x, p.y); await page.mouse.move(p.x + 2, p.y + 1);
      await page.waitForFunction(() => window.__sw.app.screens.hub.debug.hovered() === 'hangar', null, { timeout: 30000 });
      await snap(`base-${w}-hover`, 'hangar');
    }
    if (only === 'life' || (!only && !quick && w > 1200)) {
      // the moving parts: doors, the crawler with the show rocket, Pips on foot, the rocket on the pad
      const life = async (name, tod, pose, setup) => {
        await page.evaluate(([tod, pose, setup]) => {
          const v = window.__sw.app.screens.hub.debug.view, b = v.base;
          v.setTimeOfDay(tod); v.flyTo({ target: new v.camera.position.constructor(...pose.target), az: pose.az, el: pose.el, dist: pose.dist }, { snap: true });
          b.setDisplay('none'); if (setup.display) b.setDisplay(setup.display);
          b.setDoor('hangar', setup.door || 0); b.setDoor('spaceplane', setup.door || 0);
          for (let i = 0; i < (setup.steps || 0); i++) b.update(0.5, {});
          v.update(0.016, { drift: false });
        }, [tod, pose, setup]);
        await snap(`base-${w}-life-${name}`);
      };
      await page.evaluate(() => { window.__sw.app.screens.hub.update = () => {}; for (const n of document.querySelectorAll('.sw-pin, .sw-hint')) n.style.display = 'none'; });      // the hub would close the doors again
      await life('rollout', 0.4, { target: [0, 22, 330], az: -0.9, el: 0.16, dist: 300 }, { display: 'rollout', door: 1, steps: 60 });
      await life('doors', 0.45, { target: [0, 18, 462], az: 3.5, el: 0.12, dist: 150 }, { display: 'rollout', door: 1, steps: 8 });
      await life('pad', 0.34, { target: [4, 24, 0], az: 2.3, el: 0.14, dist: 210 }, { display: 'pad' });
      await life('pad-night', 0.02, { target: [4, 24, 0], az: 2.5, el: 0.2, dist: 300 }, { display: 'pad' });
      await life('pips', 0.42, { target: [300, 3, 520], az: 0.5, el: 0.3, dist: 90 }, { steps: 30 });
      await life('plane-hangar', 0.6, { target: [-730, 10, 740], az: 0.5, el: 0.16, dist: 190 }, { door: 1, steps: 10 });
      await life('grove', 0.38, { target: [-250, 5, 380], az: 0.4, el: 0.1, dist: 170 }, {});
    }
    if (only === 'interiors' || (!only && !quick)) {
      // the building interiors: live backdrop + instrument panels (give the career something to show first)
      await page.evaluate(() => {
        const c = window.__sw.career;
        c.science = 140; c.funds = 96000; c.reputation = 18;
        for (const id of ['basic_rocketry', 'survivability', 'general_construction', 'propulsion']) c.tech.add(id);
        if (c.contracts) { c.contracts.refresh(); const k = c.contracts.offered[0]; if (k) c.contracts.accept(k.id); }
        window.__swView.freeze(false);
      });
      const interior = async (screen, name, params, after) => {
        await page.evaluate(([s, p]) => window.__sw.app.goto(s, p || {}), [screen, params]);
        await page.waitForFunction(s => window.__sw.app.currentName === s, screen, { timeout: 60000 });
        await page.evaluate(() => { const v = window.__swView; v.setTimeOfDay(0.4); for (let i = 0; i < 40; i++) v.update(0.1, { drift: false }); });
        if (after) await after();
        await page.waitForFunction(() => import('./js/ui/interior.js').then(m => m.partIconsPending() === 0), null, { timeout: 300000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(OUT, `interior-${w}-${name}.png`), timeout: 180000 });
        console.log('  interior-' + w + '-' + name);
      };
      await interior('research', 'research', null, () => page.evaluate(() => document.querySelector('.sw-node[data-tech="heavy"]').dispatchEvent(new MouseEvent('mouseenter'))));
      await interior('missions', 'missions');
      await interior('missions', 'milestones', { tab: 'milestones' });
      await interior('crew', 'crew');
      await interior('guide', 'school');
      await interior('admin', 'admin');
      await page.evaluate(() => window.__sw.app.goto('hub'));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) { console.log(errors.length + ' console error(s):'); for (const e of [...new Set(errors)].slice(0, 12)) console.log(' - ' + e); process.exitCode = 1; }
