// Captures of the sea for the eye (docs/REALISM_PASS_SPEC.md, R5): the vessel is put over shallow water on the day
// side of the home world, and the flight view is captured from low over the waves and from higher up.
//   node tests/e2e/preview_water.mjs      → tests/out/water-<n>.png
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const want = v => !ONLY.length || ONLY.includes(v);
const problems = [];
const ok = (cond, what) => { console.log((cond ? '  ok   ' : '  FAIL ') + what); if (!cond) problems.push(what); };

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })).newPage();
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); else if (m.type() === 'warning' && /\[flight\]|THREE/.test(m.text())) console.log('  (page warning) ' + m.text().slice(0, 400)); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
const E = (fn, arg) => page.evaluate(fn, arg);
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 });
  await page.waitForTimeout(400);
}
const cam = (yaw, pitch, dist) => E(o => { const c = window.__sw.app.flight.cam; c.yaw = o.yaw; c.pitch = o.pitch; if (c.setDist) c.setDist(o.dist); c.dist = o.dist; for (let i = 0; i < 40; i++) window.__sw.app.current.update(0.05); window.__sw.app.input.endFrame(); }, { yaw, pitch, dist });
async function settle() {
  for (let i = 0; i < 8; i++) {
    const left = await E(() => { const f = window.__sw.app.flight, s = f && f.view, w = s && s.worlds; if (!w || !w.info || !s.settleTerrain) return 0; s.settleTerrain(2500); s.update(window.__sw.world, 1 / 30, 0, f.cam); return w.info.pending || 0; });
    if (!left) break;
  }
  await E(() => { const f = window.__sw.app.flight, w = f && f.view && f.view.worlds; return w && w.settle ? w.settle(5000) : null; });
  await page.waitForTimeout(1500);
}

try {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30000 });
  await E(() => document.querySelector('[data-action="new"]').click());
  await page.waitForSelector('.sw-mode[data-mode="sandbox"]', { state: 'attached' });
  await E(() => document.querySelector('.sw-mode[data-mode="sandbox"]').click());
  await E(() => document.querySelector('.sw-modal .sw-btn.primary').click());
  await waitScreen('hub');
  await E(() => { const s = window.__sw.app.settings; s.gfxForce = true; s.gfxQuality = 'high'; s.gfxAuto = false; s.showHints = false; });
  await E(async () => {
    const { stockCrafts, stockSite } = await import('/js/core/craft.js');
    const app = window.__sw.app, c = stockCrafts().find(c => c.name === 'Skylark II');
    app.launch(c, { crew: app.career.availableCrew().slice(0, 1).map(p => p.name), site: stockSite ? stockSite(c) : 'pad' });
  });
  await waitScreen('flight');
  await page.waitForTimeout(1200);
  let n = 0;
  for (const [alt, yaw, pitch, dist] of [[25, 0.6, 0.12, 30], [25, 3.6, 0.3, 40], [600, 2.0, 0.5, 60], [6000, 2.0, 0.9, 80]]) {
    await E(async (alt) => {
      const THREE = await import('/js/lib/three.module.min.js');
      const { SYSTEM } = await import('/js/core/bodies.js');
      const { World } = await import('/js/core/world.js');
      const w = window.__sw.world, v = w.active, b = SYSTEM.home;
      const sun = b.globalPosAt(w.ut, new THREE.Vector3()).negate().normalize();
      const sunFixed = b.inertialToSurfaceDir(sun, w.ut, new THREE.Vector3());
      // open water on the day side: deep, with a shore within reach so the shallows are in the picture too
      let dir = null, bestD = -1; const t = new THREE.Vector3(), ax = new THREE.Vector3(0, 1, 0).cross(sunFixed).normalize(), ay = sunFixed.clone().cross(ax);
      let sd = 12345; const rnd = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296;      // (the same spot every run)
      for (let i = 0; i < 4000; i++) {
        const a = rnd() * 6.283, rr = rnd() * 0.8;
        t.copy(sunFixed).addScaledVector(ax, Math.cos(a) * rr).addScaledVector(ay, Math.sin(a) * rr).normalize();
        const depth = b.seaLevel - b.terrainHeight(t, 0);
        if (depth > 1.5 && depth < 6 && depth > bestD) { bestD = depth; dir = t.clone(); if (depth > 3) break; }
      }
      if (!dir) throw new Error('no shallow sea found');
      const up = b.surfaceDirToInertial(dir, w.ut, new THREE.Vector3()).normalize();
      const ground = b.radius + b.seaLevel + alt;
      v.body = b; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true;
      v.pos.copy(up).multiplyScalar(ground + 1 + (v.baseHeight || 1));
      const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
      v.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
      v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
      v.updateTelemetry(w.ut); w.step(0.001);
      for (let i = 0; i < 3; i++) { window.__sw.app.current.update(0.02); }
      window.__sw.app.input.endFrame();
    }, alt);
    // hold the vessel where it is while the picture is taken
    await E(() => { const sw = window.__sw, c = sw.app.current, f = sw.app.flight; if (!c.__update) { c.__update = c.update; c.update = dt => f.view.update(sw.world, dt, 0, f.cam); } });
    await cam(yaw, pitch, dist); await settle();
    const url = await E(() => { const app = window.__sw.app, post = app.flight.view.fx.post; if (post) post.params.grain = 0; app.current.render(); app.current.render(); return document.getElementById('gl').toDataURL('image/png'); });
    fs.writeFileSync(path.join(OUT, 'water-' + (++n) + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    console.log('  water-' + n + '.png  (' + alt + ' m up)');
    await E(() => { const c = window.__sw.app.current; if (c.__update) { c.update = c.__update; delete c.__update; } });
  }
} catch (err) { problems.push('capture aborted: ' + (err.stack || err.message)); }
finally { await browser.close(); await server.close(); }
if (problems.length) { console.log('\nPROBLEMS:\n' + problems.join('\n')); process.exit(1); }
