// Ground-tiling probe (docs/REALISM_PASS_SPEC.md, R3): looks straight down at open ground from several heights and
// measures how strongly the picture repeats itself. The terrain's relief comes from one tiling texture laid at
// several scales; where a scale repeats in plain sight the autocorrelation of the picture has a peak at that period.
//   node tests/e2e/tiling_probe.mjs [pell,rusk]      → tests/out/tiling-<body>-<dist>.png; fails when a peak is above 0.2
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
const LIMIT = 0.2;
/** The left 512 x 512 of the 3D canvas (clear of the vessel and the navball) and its strongest repeat. */
const measure = () => E(async () => {
  const app = window.__sw.app, post = app.flight.view.fx.post; if (post) post.params.grain = 0;
  app.current.render(); app.current.render();
  const url = document.getElementById('gl').toDataURL('image/png');
  const im = new Image(); im.src = url; await im.decode();
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'); g.drawImage(im, 30, 60, S, S, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data, f = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) f[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2];
  // remove everything broader than 48 px (the lie of the land, the light falling off) with a box blur
  const I = new Float64Array((S + 1) * (S + 1));
  for (let y = 0; y < S; y++) for (let x = 0, row = 0; x < S; x++) { row += f[y * S + x]; I[(y + 1) * (S + 1) + x + 1] = I[y * (S + 1) + x + 1] + row; }
  const h = new Float32Array(S * S), B = 48;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const x0 = Math.max(0, x - B), x1 = Math.min(S, x + B + 1), y0 = Math.max(0, y - B), y1 = Math.min(S, y + B + 1);
    h[y * S + x] = f[y * S + x] - (I[y1 * (S + 1) + x1] - I[y0 * (S + 1) + x1] - I[y1 * (S + 1) + x0] + I[y0 * (S + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }
  let best = { r: -1, lag: 0, axis: '' }, sd = 0;
  for (let i = 0; i < S * S; i++) sd += h[i] * h[i];
  for (const axis of ['x', 'y']) { let fell = false; for (let lag = 2; lag < 300; lag += lag < 40 ? 1 : 2) {
    let s = 0, a = 0, b = 0;
    for (let y = 0; y < S - (axis === 'y' ? lag : 0); y++) for (let x = 0; x < S - (axis === 'x' ? lag : 0); x++) {
      const p = h[y * S + x], q = axis === 'x' ? h[y * S + x + lag] : h[(y + lag) * S + x];
      s += p * q; a += p * p; b += q * q;
    }
    const r = s / Math.sqrt(a * b + 1e-9);
    // (neighbouring pixels always agree: a repeat is a peak after the agreement has died away)
    if (!fell) { if (r < 0.08) fell = true; continue; }
    if (r > best.r) best = { r, lag, axis };
  } }
  return { url: c.toDataURL('image/png'), contrast: Math.sqrt(sd / (S * S)), ...best };
});

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
  for (const bodyId of ['pell', 'rusk']) {
    if (!want(bodyId)) continue;
    await E(async (bodyId) => {
      const THREE = await import('/js/lib/three.module.min.js');
      const { SYSTEM } = await import('/js/core/bodies.js');
      const { World } = await import('/js/core/world.js');
      const w = window.__sw.world, v = w.active, b = SYSTEM.byId[bodyId];
      const sun = b.globalPosAt(w.ut, new THREE.Vector3()).negate().normalize();
      const sunFixed = b.inertialToSurfaceDir(sun, w.ut, new THREE.Vector3());
      const dir = b.dirFromLatLon ? b.dirFromLatLon(0.1, Math.atan2(-sunFixed.z, sunFixed.x) + 0.6) : sunFixed.clone();
      const up = b.surfaceDirToInertial(dir, w.ut, new THREE.Vector3()).normalize();
      const ground = b.radius + (b.surfaceHeight ? b.surfaceHeight(dir) : 0);
      v.body = b; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true;
      v.pos.copy(up).multiplyScalar(ground + 1 + (v.baseHeight || 1));
      const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
      v.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
      v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
      v.updateTelemetry(w.ut); w.step(0.001);
      for (let i = 0; i < 400; i++) { window.__sw.app.current.update(0.05); }
      window.__sw.app.input.endFrame();
    }, bodyId);
    for (const dist of [8, 25, 80, 300]) {
      await cam(2.3, 1.45, dist); await settle();
      const m = await measure();
      fs.writeFileSync(path.join(OUT, 'tiling-' + bodyId + '-' + dist + '.png'), Buffer.from(m.url.split(',')[1], 'base64'));
      ok(m.r < LIMIT, bodyId + ' from ' + dist + ' m: strongest repeat ' + m.r.toFixed(3) + ' at ' + m.lag + ' px along ' + m.axis + ' (detail contrast ' + m.contrast.toFixed(2) + ' of 255), limit ' + LIMIT);
    }
  }
} catch (err) { problems.push('probe aborted: ' + (err.stack || err.message)); }
finally { await browser.close(); await server.close(); }
if (problems.length) { console.log('\nPROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('\ntiling probe: all checks passed');
