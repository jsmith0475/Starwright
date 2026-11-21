// Live-reflection probe (docs/REALISM_PASS_SPEC.md, R2): checks that the environment probe of the flight scene is on
// at "high", that it is the map the vessel's materials use, and that it shows the real surroundings:
//   · the part of the cube map that looks down matches a plain camera looking down at the same ground (within 15 %);
//   · on an airless moon by day the ground below is far brighter than the sky above; on the home world the sky is blue.
// It also saves a close view of the vessel with the probe off and on, for the eye.
//   node tests/e2e/env_probe.mjs [pad,moon]      → tests/out/env-<view>-{off,on}.png, exits non-zero on a failure
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
/** Close view of the vessel with live reflections off (the painted maps) and on. */
async function pictures(view) {
  const shot = async on => {
    await E(on => { const app = window.__sw.app; app.settings.gfxReflect = on; app.flight.view.applySettings(); const post = app.flight.view.fx.post; if (post) post.params.grain = 0; for (let i = 0; i < 8; i++) app.current.render(); }, on);
    const url = await E(() => { window.__sw.app.current.render(); return document.getElementById('gl').toDataURL('image/png'); });
    fs.writeFileSync(path.join(OUT, 'env-' + view + '-' + (on ? 'on' : 'off') + '.png'), Buffer.from(url.split(',')[1], 'base64'));
  };
  await shot(false); await shot(true);
}
/** Median colours of the probe's downward and upward cones, and of a plain camera looking down, all in linear HDR. */
const measure = () => E(async () => {
  const THREE = await import('/js/lib/three.module.min.js');
  const app = window.__sw.app, view = app.flight.view, probe = view.envProbe, r = app.renderer;
  if (!probe || !probe.texture) return { on: false };
  const N = probe.cube.width, up = view.info.up.clone().normalize(), half = THREE.DataUtils.fromHalfFloat;
  const median = a => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
  const cones = { down: [[], [], []], up: [[], [], []] };
  const rig = new THREE.CubeCamera(0.5, 2e9, probe.cube); rig.coordinateSystem = r.coordinateSystem; rig.updateCoordinateSystem(); rig.updateMatrixWorld(true);
  const buf = new Uint16Array(N * N * 4), d = new THREE.Vector3();
  for (let f = 0; f < 6; f++) {
    r.readRenderTargetPixels(probe.cube, 0, 0, N, N, buf, f);
    const cam = rig.children[f];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      d.set((x + 0.5) / N * 2 - 1, (y + 0.5) / N * 2 - 1, 0.5).unproject(cam).normalize();
      const c = d.dot(up), set = c < -0.85 ? cones.down : c > 0.85 ? cones.up : null;
      if (set) for (let k = 0; k < 3; k++) set[k].push(half(buf[(y * N + x) * 4 + k]));
    }
  }
  // the reference: the same far scene through an ordinary camera at the same point, looking straight down
  const rt = new THREE.WebGLRenderTarget(N, N, { type: THREE.HalfFloatType });
  const pc = new THREE.PerspectiveCamera(2 * Math.acos(0.85) * 180 / Math.PI * 0.7, 1, view.camera.near, view.camera.far);
  pc.up.set(0, 0, 1); if (Math.abs(up.z) > 0.9) pc.up.set(1, 0, 0);
  pc.lookAt(up.clone().multiplyScalar(-1)); pc.updateMatrixWorld(true);
  const auto = r.autoClear; r.autoClear = true; r.setRenderTarget(rt); r.render(view.far, pc); r.setRenderTarget(null); r.autoClear = auto;
  const rb = new Uint16Array(N * N * 4); r.readRenderTargetPixels(rt, 0, 0, N, N, rb); rt.dispose();
  const ref = [[], [], []]; for (let i = 0; i < N * N; i++) for (let k = 0; k < 3; k++) ref[k].push(half(rb[i * 4 + k]));
  return { on: true, applied: view.near.environment === probe.texture, quality: view.qualityName, down: cones.down.map(median), up: cones.up.map(median), ref: ref.map(median) };
});
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const f3 = c => '(' + c.map(v => v.toFixed(3)).join(', ') + ')';
async function probe(view, kind) {
  await settle();
  await E(() => { const app = window.__sw.app; app.settings.gfxReflect = true; app.flight.view.applySettings(); for (let i = 0; i < 8; i++) app.current.render(); });
  // one full refresh after the terrain has settled
  await page.waitForTimeout(5200);
  await E(() => { const app = window.__sw.app; app.current.update(0.02); for (let i = 0; i < 10; i++) app.current.render(); });
  const m = await measure();
  console.log(view + ': ' + JSON.stringify(m));
  ok(m.on && m.applied && m.quality === 'high', view + ': the probe is on at "high" and is the scene\'s environment map');
  if (!m.on) return;
  const err = Math.max(...m.down.map((v, k) => Math.abs(v - m.ref[k]) / Math.max(1e-4, m.ref[k])));
  ok(lum(m.ref) > 0.002, view + ': the ground below is lit ' + f3(m.ref));
  ok(err < 0.15, view + ': the probe looking down ' + f3(m.down) + ' matches a camera looking down ' + f3(m.ref) + ' within 15 % (' + (err * 100).toFixed(1) + ' %)');
  if (kind === 'airless') ok(lum(m.up) < 0.3 * lum(m.down), view + ': dark sky above ' + f3(m.up) + ', bright ground below');
  if (kind === 'blue') ok(m.up[2] > m.up[0] * 1.15 && lum(m.up) > 0.01, view + ': blue sky above ' + f3(m.up));
  await pictures(view);
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
  if (want('pad')) { await cam(2.2, 0.25, 14); await probe('pad', 'blue'); }
  if (want('moon')) {
    await E(async () => {
      const THREE = await import('/js/lib/three.module.min.js');
      const { SYSTEM } = await import('/js/core/bodies.js');
      const { World } = await import('/js/core/world.js');
      const w = window.__sw.world, v = w.active, b = SYSTEM.byId.pell;
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
    });
    await cam(2.3, 0.25, 9); await probe('moon', 'airless');
  }
} catch (err) { problems.push('probe aborted: ' + (err.stack || err.message)); }
finally { await browser.close(); await server.close(); }
if (problems.length) { console.log('\nPROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('\nenv probe: all checks passed');
