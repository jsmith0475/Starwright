// Captures of a splashdown for the eye: a capsule under its parachute is put a few hundred metres over open sea on
// the day side of the home world and comes down by itself. Pictures are taken at fixed times after the base touches
// the water (the crown, the falling spray, the foam ring spreading) and again once the capsule floats at rest
// (two pictures a few seconds apart, to see it ride the swell).
//   node tests/e2e/preview_splash.mjs [tag] [--size=1280x800]     → tests/out/splash-<tag>-<n>-<name>.png
// It is a capture script, not a test: it fails only on page errors or when the scene cannot be reached.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const TAG = args.find(a => !a.startsWith('--')) || 'now';
const SIZE = (args.find(a => a.startsWith('--size=')) || '--size=1280x800').slice(7).split('x').map(Number);
const problems = [];

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const page = await (await browser.newContext({ viewport: { width: SIZE[0], height: SIZE[1] }, deviceScaleFactor: 1 })).newPage();
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
const E = (fn, arg) => page.evaluate(fn, arg);
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 });
  await page.waitForTimeout(400);
}
/** Run the flight screen's own loop for `sim` seconds, or until the expression over (w, v, f) is true. */
async function ff(sim, until = 'false', dt = 1 / 60) {
  let left = sim, hit = false;
  while (left > 1e-6 && !hit) {
    const r = await E(({ budget, until, dt }) => {
      const sw = window.__sw, app = sw.app, f = app.flight;
      const test = new Function('w', 'v', 'f', 'return (' + until + ');');
      const t0 = performance.now(); let hit = false, n = 0, adv = 0;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && adv < budget - 1e-9) {
        app.current.update(dt); app.input.endFrame(); adv += dt; n++;
        const w = sw.world, v = w.active && !w.active.dead ? w.active : null;
        if (test(w, v, f)) { hit = true; break; }
      }
      return { adv, hit, n };
    }, { budget: left, until, dt });
    hit = r.hit; left -= r.n ? r.adv : left;
  }
  return hit;
}
const cam = (yaw, pitch, dist) => E(o => { const c = window.__sw.app.flight.cam; c.yaw = o.yaw; c.pitch = o.pitch; if (c.setDist) c.setDist(o.dist); c.dist = o.dist; }, { yaw, pitch, dist });
let n = 0;
async function snap(name) {
  // the terrain for this view, built on the page's own thread; the simulation does not advance
  for (let i = 0; i < 6; i++) {
    const left = await E(() => { const f = window.__sw.app.flight, s = f && f.view, w = s && s.worlds; if (!w || !w.info || !s.settleTerrain) return 0; s.settleTerrain(2500); s.update(window.__sw.world, 0, 0, f.cam); return w.info.pending || 0; });
    if (!left) break;
  }
  const url = await E(() => { const app = window.__sw.app, post = app.flight.view.fx.post; if (post) post.params.grain = 0; app.current.render(); app.current.render(); return document.getElementById('gl').toDataURL('image/png'); });
  const file = `splash-${TAG}-${String(++n).padStart(2, '0')}-${name}.png`;
  fs.writeFileSync(path.join(OUT, file), Buffer.from(url.split(',')[1], 'base64'));
  const s = await E(() => { const v = window.__sw.world.active; return { alt: +v.altitude.toFixed(2), speed: +(v.surfaceVel ? v.surfaceVel.length() : 0).toFixed(2), landed: v.landed, splashed: v.splashed, floating: !!v._floating }; });
  console.log('  ' + file + '  ' + JSON.stringify(s));
}

try {
  await page.goto(server.url + '?whatsnew=0');
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
  // down to the capsule and its parachute, then 320 m over deep open water in daylight, falling
  await E(async () => {
    const THREE = await import('/js/lib/three.module.min.js');
    const { SYSTEM } = await import('/js/core/bodies.js');
    const { World } = await import('/js/core/world.js');
    const w = window.__sw.world, b = SYSTEM.home;
    let v = w.active;
    v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true; v.launchUt = w.ut;
    const sun = b.globalPosAt(w.ut, new THREE.Vector3()).negate().normalize();
    const sunFixed = b.inertialToSurfaceDir(sun, w.ut, new THREE.Vector3());
    let dir = null; const t = new THREE.Vector3(), ax = new THREE.Vector3(0, 1, 0).cross(sunFixed).normalize(), ay = sunFixed.clone().cross(ax);
    let sd = 4321; const rnd = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296;      // (the same spot every run)
    for (let i = 0; i < 6000 && !dir; i++) {
      const a = rnd() * 6.283, rr = 0.25 + rnd() * 0.5;       // the sun well up but not overhead: the spray has a lit side
      t.copy(sunFixed).addScaledVector(ax, Math.cos(a) * rr).addScaledVector(ay, Math.sin(a) * rr).normalize();
      if (b.seaLevel - b.terrainHeight(t, 0) > 60) dir = t.clone();
    }
    if (!dir) throw new Error('no deep sea found');
    const up = b.surfaceDirToInertial(dir, w.ut, new THREE.Vector3()).normalize();
    v.body = b;
    v.pos.copy(up).multiplyScalar(b.radius + b.seaLevel + 320);
    const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x).addScaledVector(up, -12);
    v.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
    v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
    v.updateTelemetry(w.ut); w.step(0.001);
    for (let i = 0; i < 12 && w.active.stageIndex < w.active.stages.length - 1; i++) w.stage();
    v = w.active;
    for (let i = 0; i < 3 && !w.active.chuteParts.some(p => p.deployed && p.deployed !== 'stowed'); i++) w.stage();
    v = w.active;
    for (let i = 0; i < 3; i++) window.__sw.app.current.update(0.02);
    window.__sw.app.input.endFrame();
  });
  const st = () => E(() => { const v = window.__sw.world.active; return { parts: v.parts.size, stage: v.stageIndex + '/' + v.stages.length, chutes: v.chuteParts.map(p => p.deployed || 'packed'), alt: Math.round(v.altitude), vs: Math.round(v.verticalSpeed) }; });
  console.log('  start ' + JSON.stringify(await st()));
  await ff(300, 'v && v.altitude < 60');
  console.log('  low   ' + JSON.stringify(await st()));
  await cam(0.8, 0.16, 16);
  await ff(1); await snap('coming-down');
  await E(() => { const sw = window.__sw; sw.__tr = []; const c = sw.app.current, u = c.update.bind(c); c.update = dt => { u(dt); const v = sw.world.active; if (v && sw.__tr.length < 400 && v.altitude - v.body.seaLevel < 4) sw.__tr.push([+(v.altitude - v.body.seaLevel).toFixed(2), +v.verticalSpeed.toFixed(2), v.grounded ? 1 : 0, v._touched ? 1 : 0, v._floating ? 1 : 0, v.landed ? 1 : 0].join(' ')); }; });
  if (!await ff(120, 'v && (v._touched || v.grounded || v.landed)')) throw new Error('the capsule never reached the water');
  let t = 0;
  for (const [at, name] of [[0.12, 'contact'], [0.45, 'crown'], [1.0, 'spray-falling'], [2.2, 'foam-spreading'], [5, 'foam-ring'], [10, 'settling']]) {
    await ff(at - t); t = at; await cam(0.8, 0.16, 16); await snap(name);
  }
  if (process.env.TRACE) console.log((await E(() => window.__sw.__tr)).filter((_, i) => i % 3 === 0).join('\n'));
  await ff(120, 'v && v.landed'); await ff(6);
  await cam(0.8, 0.1, 9);
  await ff(0.1); await snap('afloat-a');
  await ff(1.7); await snap('afloat-b');
  await ff(1.7); await snap('afloat-c');
} catch (err) { problems.push('capture aborted: ' + (err.stack || err.message)); }
finally { await browser.close(); await server.close(); }
if (problems.length) { console.log('\nPROBLEMS:\n' + problems.join('\n')); process.exit(1); }
