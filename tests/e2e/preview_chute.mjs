// Parachute pictures for eyeballing: a capsule dropped from height under each kind of parachute, captured reefed,
// opening and fully open, from far enough to see the whole thing and close enough to see where the lines meet the
// skirt. A capture script, not a test: it fails only on page errors.
//   node tests/e2e/preview_chute.mjs [only,comma,separated] [--scale 2] [--url http://...]
//   names: main skirt opening reefed twin grand drogue swing packdrogue down         → tests/out/preview-chute-<name>.png
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const argv = process.argv.slice(2), flag = k => { const i = argv.indexOf('--' + k); return i < 0 ? null : argv.splice(i, 2)[1]; };
const SCALE = +(flag('scale') || 1), URL = flag('url');
const ONLY = (argv[0] || '').split(',').map(s => s.trim()).filter(Boolean);
const want = name => !ONLY.length || ONLY.includes(name);
const problems = [];

const server = URL ? { url: URL, close() {} } : await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
const E = (fn, arg) => page.evaluate(fn, arg);

async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 });
  await page.waitForTimeout(400);
}
async function ff(sim, until = 'false', dt = 0.02) {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await E(({ budget, until, dt }) => {
      const sw = window.__sw, app = sw.app;
      const test = new Function('w', 'v', 'return (' + until + ');');
      const t0 = performance.now(), u0 = sw.world.ut; let hit = false, n = 0;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - u0 < budget && n++ < 20000) {
        app.current.update(dt); app.input.endFrame();
        const w = sw.world, v = w.active && !w.active.dead ? w.active : null;
        if (test(w, v)) { hit = true; break; }
      }
      return { adv: sw.world.ut - u0, hit, n };
    }, { budget: left, until, dt });
    hit = r.hit; left -= Math.max(r.adv, r.n ? dt * 0.5 : left);
  }
  return hit;
}
const cam = (yaw, pitch, dist) => E(o => { const c = window.__sw.app.flight.cam; c.yaw = o.yaw; c.pitch = o.pitch; if (o.dist != null) { if (c.setDist) c.setDist(o.dist); c.dist = o.dist; } for (let i = 0; i < 90; i++) window.__sw.app.flight.view.update(window.__sw.world, 1 / 30, 0, c); }, { yaw, pitch, dist });
async function shot(name) {
  for (let i = 0; i < 6; i++) {
    const left = await E(() => { const f = window.__sw.app.flight, s = f && f.view, w = s && s.worlds; if (!w || !w.info || !s.settleTerrain) return 0; s.settleTerrain(2500); s.update(window.__sw.world, 1 / 30, 0, f.cam); return w.info.pending || 0; });
    if (!left) break;
  }
  await page.waitForTimeout(700);
  const file = path.join(OUT, `preview-chute-${name}.png`);
  await page.screenshot({ path: file, timeout: 120000 });
  const info = await E(() => { const v = window.__sw.world.active, cm = window.__sw.app.flight.cam; return `cam ${cm.dist.toFixed(0)} m, lift ${(cm.lift || 0).toFixed(1)}; ` + v.chuteParts.map(p => { const c = v.chuteView(p); return c ? `${p.def.id} ${c.stage} fill ${c.fill.toFixed(2)}: ${(c.shape.rm * 2).toFixed(1)} m wide, top ${c.shape.top.toFixed(1)} m up, load ${(c.load * 100).toFixed(0)}%` : p.def.id + ' ' + p.deployed; }).join('; ') + ` | ${v.airspeed.toFixed(1)} m/s at ${v.radarAlt.toFixed(0)} m`; });
  console.log('  captured ' + name + '  (' + info + ')');
}
async function boot() {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30000 });
  await E(() => document.querySelector('[data-action="new"]').click());
  await page.waitForSelector('.sw-mode[data-mode="sandbox"]', { state: 'attached' });
  await E(() => document.querySelector('.sw-mode[data-mode="sandbox"]').click());
  await E(() => document.querySelector('.sw-modal .sw-btn.primary').click());
  await waitScreen('hub');
  await E(() => { const s = window.__sw.app.settings; s.gfxForce = true; s.gfxQuality = 'high'; s.showHints = false; });
}
/** Launch a craft built by `src`, lift it to `alt` m over the daylit land near the space centre, falling at `vy`, drifting at `vx`. */
async function drop(src, { alt = 2500, vy = -90, vx = 0, dx = 0 } = {}) {
  await E(async ({ src }) => {
    const { Craft } = await import('/js/core/craft.js');
    const c = new Craft(); new Function('c', src)(c); c.autoStage();
    const app = window.__sw.app;
    try { app.career.releaseCrew(app.career.roster.filter(p => p.status === 'assigned').map(p => p.name)); } catch { /* keep going */ }
    app.launch(c, { crew: app.career.availableCrew().slice(0, 1).map(p => p.name) });
  }, { src });
  await waitScreen('flight');
  await page.waitForTimeout(800);
  await E(async o => {
    const THREE = await import('/js/lib/three.module.min.js');
    const w = window.__sw.world, v = w.active, b = v.body;
    const up = v.pos.clone().normalize(), wy = 2 * Math.PI / b.rotPeriod;
    v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v.launched = true; v.launchUt = w.ut;
    const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    if (o.dx) { const r0 = v.pos.length(); v.pos.addScaledVector(east, o.dx).setLength(r0); up.copy(v.pos).normalize(); east.set(0, 1, 0).cross(up).normalize(); }
    v.pos.addScaledVector(up, o.alt);
    v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x).addScaledVector(up, o.vy).addScaledVector(east, o.vx);
    v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v.ctrl.sas = true; v._stamp++;
    v.updateTelemetry(w.ut); w.step(0.001);
    while (v.chuteParts.some(p => p.deployed === 'stowed')) w.stage();
  }, { alt, vy, vx, dx });
}
const CAPSULE = chute => `const pod = c.setRoot('pod_acorn')[0]; ${chute} c.attachStack('heatshield_m', pod.id, 'bottom'); c.name = 'Drop';`;
const HEARTH = chute => `const pod = c.setRoot('pod_hearth')[0]; ${chute} c.attachStack('heatshield_l', pod.id, 'bottom'); c.name = 'Drop';`;
const open = 'v && v.chuteParts.every(p => p.deployed === "full" && p.deployT >= 1)';

try {
  await boot();
  if (['main', 'skirt', 'opening', 'reefed'].some(want)) {
    await drop(CAPSULE(`c.attachStack('chute', pod.id, 'top');`), { alt: 1500 });
    if (want('reefed')) { await ff(30, 'v && v.chuteParts[0].deployed === "semi" && v.chuteParts[0].deployT >= 1'); await ff(1.5); await cam(0.8, -0.05, 70); await shot('reefed'); }
    if (want('opening')) { await ff(200, 'v && v.chuteParts[0].deployed === "full" && v.chuteParts[0].deployT > 0.45'); await cam(0.8, -0.05, 70); await shot('opening'); }
    await ff(300, open); await ff(4);
    if (want('main')) { await cam(0.8, 0.02, null); await shot('main'); await cam(2.4, 0.5, 80); await shot('main-above'); }
    if (want('skirt')) {
      // look at the skirt itself: aim the camera up the lines
      await E(() => { const c = window.__sw.app.flight.cam; c.lift = 0; });
      await cam(0.8, -0.62, 34); await shot('skirt');
    }
  }
  if (want('swing')) { await drop(CAPSULE(`c.attachStack('chute', pod.id, 'top');`), { alt: 1500, vx: 60 }); await ff(300, 'v && v.chuteParts[0].deployed === "full" && v.chuteParts[0].deployT > 0.6'); await cam(0.2, -0.05, 75); await shot('swing'); }
  if (want('twin')) { await drop(CAPSULE(`c.attachRadial('chute_radial', pod.id, pod.pos.y + 0.1, 0, 2);`), { alt: 1500 }); await ff(300, open); await ff(6); await cam(0.2, -0.08, 75); await shot('twin'); }
  if (want('grand')) { await drop(HEARTH(`c.attachStack('chute_grand', pod.id, 'top');`), { alt: 1700 }); await ff(300, open); await ff(4); await cam(0.8, -0.08, 100); await shot('grand'); }
  if (want('drogue')) { await drop(CAPSULE(`c.attachStack('chute_drogue', pod.id, 'top');`), { alt: 2600, vy: -150 }); await ff(300, open); await ff(2); await cam(0.8, -0.08, 45); await shot('drogue'); }
  if (want('packdrogue')) { await drop(CAPSULE(`c.attachStack('chute', pod.id, 'top');`), { alt: 30000, vy: -700 }); await ff(120, 'v && v.chuteParts[0].deployed === "drogue" && v.chuteParts[0].deployT >= 1'); await ff(1); await cam(0.8, -0.1, 22); await shot('packdrogue'); }
  if (want('down')) {
    // touchdown: the canopy stays, topples and deflates (the fall runs on the wall clock, so wait it out)
    await drop(CAPSULE(`c.attachStack('chute', pod.id, 'top');`), { alt: 420, vy: -30, dx: +(flag('dx') || -900) });
    await ff(400, 'v && (v.landed || v.splashed)'); await ff(0.5); await cam(2.5, 0.3, 75);
    await E(() => { for (let i = 0; i < 3; i++) { window.__sw.app.current.update(0.02); window.__sw.app.input.endFrame(); } });
    await page.waitForTimeout(6000);
    await shot('down');
  }
} finally {
  await browser.close(); server.close();
}
if (problems.length) { console.log('PROBLEMS:\n' + [...new Set(problems)].join('\n')); process.exit(1); }
console.log('ok');
