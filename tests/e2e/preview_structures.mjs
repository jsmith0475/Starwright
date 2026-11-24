// The space centre is solid (js/core/structures.js), checked in the real game: a Skylark II that cuts its engine just
// off the pad and falls back onto the launch mount, and a capsule flown into the assembly building's wall slow (it is
// stopped outside) and fast (it is lost). Prints what the game said (toasts, strike events) and captures pictures.
//   groups: fallback bump crash
//   SIZE=small node tests/e2e/preview_structures.mjs [groups]      → tests/out/solid-<nn>-<name>-<w>x<h>.png
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = (process.argv[2] || process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const SIZE = process.env.SIZE || 'full';
const SIZES = [SIZE === 'small' ? [1100, 700] : [1920, 1200]];
const problems = [];

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: SIZES[0][0], height: SIZES[0][1] }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));

const E = (fn, arg) => page.evaluate(fn, arg);
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 });
  await page.waitForTimeout(400);
}
/** Run the flight screen's own update loop for `sim` seconds (or until the expression over w, v, f is true). */
async function ff(sim, until = 'false', dt = 0.05) {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await E(({ budget, until, dt }) => {
      const sw = window.__sw, app = sw.app, f = app.flight;
      const test = new Function('w', 'v', 'f', 'return (' + until + ');');
      const t0 = performance.now(), u0 = sw.world.ut; let hit = false, n = 0;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - u0 < budget && n++ < 20000) {
        app.current.update(dt); app.input.endFrame();
        const w = sw.world, v = w.active && !w.active.dead ? w.active : null;
        if (test(w, v, f)) { hit = true; break; }
        if (f.paused) break;
      }
      return { adv: sw.world.ut - u0, hit, n };
    }, { budget: left, until, dt });
    hit = r.hit; left -= Math.max(r.adv, r.n ? dt * 0.5 : left);
  }
  return hit;
}
const key = async (code) => { await page.keyboard.down(code); await page.waitForTimeout(50); await E(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); }); await page.keyboard.up(code); };
let n = 0;
/** A few real frames (so particles, shadows and the post chain settle), then a capture at both sizes. */
async function shot(name, opts = {}) {
  n++;
  const tag = String(n).padStart(2, '0');
  // a moment that lasts a fraction of a second (stage separation) is held still while the terrain settles and the
  // two sizes are captured: the screen keeps drawing, the simulation does not advance
  if (opts.freeze) await E(() => { const sw = window.__sw, c = sw.app.current, f = sw.app.flight; c.__update = c.update; c.update = dt => f.view.update(sw.world, dt, 0, f.cam); });
  // let the terrain for this view arrive: build the missing chunks on the page's own thread (the workers crawl
  // beside a software rasteriser), a few seconds at a time
  for (let i = 0; i < 8; i++) {
    const left = await E(() => {
      const f = window.__sw.app.flight, s = f && f.view, w = s && s.worlds;
      if (!w || !w.info || !s.settleTerrain) return 0;
      s.settleTerrain(2500);
      s.update(window.__sw.world, 1 / 30, 0, f.cam);
      return w.info.pending || 0;
    });
    if (!left) break;
    if (i === 7) console.log('  (terrain still loading for ' + name + ': ' + left + ' chunks)');
  }
  // (the globe maps bake in workers; give them a moment, they only tint the far ground)
  await E(() => { const f = window.__sw.app.flight, w = f && f.view && f.view.worlds; return w && w.settle ? w.settle(5000) : null; });
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `solid-${tag}-${name}-${w}x${h}.png`), timeout: 120000 });
  }
  await page.setViewportSize({ width: SIZES[0][0], height: SIZES[0][1] });
  if (opts.freeze) await E(() => { const c = window.__sw.app.current; if (c.__update) { c.update = c.__update; delete c.__update; } });
  console.log('  captured ' + tag + ' ' + name);
}
const want = name => !ONLY.length || ONLY.includes(name);
const cam = (yaw, pitch, dist) => E(o => { const c = window.__sw.app.flight.cam; if (o.yaw != null) c.yaw = o.yaw; if (o.pitch != null) c.pitch = o.pitch; if (o.dist != null) { if (c.setDist) c.setDist(o.dist); c.dist = o.dist; } for (let i = 0; i < 90; i++) { window.__sw.app.flight.view.update(window.__sw.world, 1 / 30, 0, c); } }, { yaw, pitch, dist });

async function boot() {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30000 });
  // the menus are slow under software GL: drive them from the page instead of waiting for stable frames
  await E(() => document.querySelector('[data-action="new"]').click());
  await page.waitForSelector('.sw-mode[data-mode="sandbox"]', { state: 'attached' });
  await E(() => document.querySelector('.sw-mode[data-mode="sandbox"]').click());
  await E(() => document.querySelector('.sw-modal .sw-btn.primary').click());
  await waitScreen('hub');
  // previews show the game at full quality even on a software rasteriser
  await E(() => { const s = window.__sw.app.settings; s.gfxForce = true; s.gfxQuality = 'high'; s.showHints = true; });
}
async function launchStock(name) {
  await E(async name => {
    const { stockCrafts } = await import('/js/core/craft.js');
    const { stockCrafts: sc, stockSite } = await import('/js/core/craft.js');
    const c = sc().find(c => c.name === name);
    const app = window.__sw.app;
    const { PARTS } = await import('/js/core/parts.js');
    const seats = c.parts.reduce((n, p) => n + ((PARTS[p.type] && PARTS[p.type].crew) || 0), 0);
    try { app.career.releaseCrew(app.career.roster.filter(p => p.status === 'assigned').map(p => p.name)); } catch { /* keep going */ }
    app.launch(c, { crew: seats ? app.career.availableCrew().slice(0, 1).map(p => p.name) : [], site: stockSite ? stockSite(c) : 'pad' });
  }, name);
  await waitScreen('flight');
  await page.waitForTimeout(1200);
}
async function launchCustom(build, crew = 1) {
  await E(async ({ src, crew }) => {
    const { Craft } = await import('/js/core/craft.js');
    const c = new Craft();
    new Function('c', src)(c);
    c.autoStage();
    const app = window.__sw.app;
    try { app.career.releaseCrew(app.career.roster.filter(p => p.status === 'assigned').map(p => p.name)); } catch { /* keep going */ }
    const names = app.career.availableCrew().slice(0, crew).map(p => p.name);
    app.launch(c, { crew: names });
  }, { src: build, crew });
  await waitScreen('flight');
  await page.waitForTimeout(1200);
}
/** Put the active vessel on a circular orbit over the day side (side = 1) or the night side (−1) of a body. */
const teleport = opts => E(async o => {
  const THREE = await import('/js/lib/three.module.min.js');
  const { SYSTEM } = await import('/js/core/bodies.js');
  const w = window.__sw.world, v = w.active, b = SYSTEM.byId[o.body || 'verda'];
  if (v.landed) { v.landed = false; v.splashed = false; v.surface = null; v.launched = true; v.launchUt = w.ut; }
  v.body = b; v.onRails = false; v._patch = null;
  const r = b.radius + o.alt;
  const vc = Math.sqrt(b.gm / r) * (o.speedFactor ?? 1);
  // toward the sun (the star sits at the origin of the global frame), flattened into the equatorial plane
  const sun = b.globalPosAt(w.ut, new THREE.Vector3()).negate(); sun.y = 0; sun.normalize();
  const out = sun.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), o.phase ?? 0).multiplyScalar(o.side ?? 1);
  const pro = new THREE.Vector3(0, 1, 0).cross(out).normalize();
  v.pos.copy(out).multiplyScalar(r); v.vel.copy(pro).multiplyScalar(vc);
  if (o.vy) v.vel.addScaledVector(out, o.vy);
  const Y = (o.retro ? pro.clone().negate() : pro.clone()), Z = out.clone(), X = new THREE.Vector3().crossVectors(Y, Z);
  v.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
  v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
  while (v.nodes.length) v.removeNode(v.nodes[0]);
  v.updateTelemetry(w.ut);
  w.step(0.001);
}, opts);
/** Set the active vessel down on a body: a few metres above the ground at lat/lon (rad), at rest, upright (or on its wheels facing `heading`). */
const placeOn = opts => E(async o => {
  const THREE = await import('/js/lib/three.module.min.js');
  const { SYSTEM } = await import('/js/core/bodies.js');
  const { World } = await import('/js/core/world.js');
  const w = window.__sw.world, v = w.active, b = SYSTEM.byId[o.body];
  // lon is measured from the sub-solar meridian so the place is in daylight (o.sun = hours of longitude off noon)
  const sun = b.globalPosAt(w.ut, new THREE.Vector3()).negate().normalize();
  const sunFixed = b.inertialToSurfaceDir(sun, w.ut, new THREE.Vector3());
  const lon0 = Math.atan2(-sunFixed.z, sunFixed.x);
  const dir = b.dirFromLatLon ? b.dirFromLatLon(o.lat || 0, lon0 + (o.lon || 0)) : sunFixed.clone();
  const up = b.surfaceDirToInertial(dir, w.ut, new THREE.Vector3()).normalize();
  const ground = b.radius + (b.surfaceHeight ? b.surfaceHeight(dir) : 0);
  v.body = b; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true;
  v.pos.copy(up).multiplyScalar(ground + (o.alt ?? 3) + (v.baseHeight || 1));
  const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
  const qFix = o.vehicle ? World.vehicleFrame(dir, o.heading ?? 90) : World.padFrame(dir);
  v.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(qFix);
  v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
  v.updateTelemetry(w.ut); w.step(0.001);
}, opts);
async function runAutopilot(make, maxSim = 4000, until = 'false') {
  await E(async src => { const ap = await import('/js/core/autopilot.js'); const w = window.__sw.world; window.__ctl = new Function('ap', 'w', 'v', 'return ' + src)(ap, w, w.active); }, make);
  let left = maxSim;
  while (left > 0) {
    const r = await E(({ budget, until }) => {
      const sw = window.__sw, app = sw.app, ctl = window.__ctl; const t0 = performance.now(), u0 = sw.world.ut; let n = 0, hit = false;
      const test = new Function('w', 'v', 'return (' + until + ');');
      while (performance.now() - t0 < 400 && !ctl.done && sw.world.ut - u0 < budget && n++ < 20000) { ctl.update(0.05); app.current.update(0.05); app.input.endFrame(); if (test(sw.world, sw.world.active)) { hit = true; break; } }
      return { adv: sw.world.ut - u0, done: ctl.done, hit };
    }, { budget: left, until });
    if (r.done || r.hit) return r;
    left -= Math.max(r.adv, 0.01);
  }
  return { done: false };
}
const LANDER = `
  const pod = c.setRoot('pod_acorn')[0];
  c.attachStack('chute', pod.id, 'top');
  const hs = c.attachStack('heatshield_m', pod.id, 'bottom')[0];
  const dec = c.attachStack('dec_m', hs.id, 'bottom')[0];
  const tank = c.attachStack('tank_m400', dec.id, 'bottom')[0];
  c.attachStack('eng_sparrow', tank.id, 'bottom');
  c.attachRadial('legs', tank.id, tank.pos.y - 1.3, Math.PI / 4, 4);
  c.attachRadial('solar', tank.id, tank.pos.y + 1.2, 0, 2);
  c.name = 'Dustfoot';
`;

const off = (x, y) => E(o => { const c = window.__sw.app.flight.cam; c.offset.set(o.x, o.y, 0); }, { x, y });
const hud = on => E(on => { document.getElementById('ui').style.visibility = on ? '' : 'hidden'; }, on);
const grp = g => !ONLY.length || ONLY.includes(g);
async function safe(name, fn) { try { await fn(); } catch (e) { console.log('  FAILED ' + name + ': ' + (e.message || e).split('\n')[0]); } }
/** Start recording what the game says: strike events and the toasts on screen. */
const listen = () => E(() => {
  const sw = window.__sw; window.__said = [];
  sw.world.on('*', (d, type) => { if (['structureStrike', 'towerStrike', 'explosion', 'landed', 'destroyed', 'crewLost'].includes(type)) window.__said.push(`${sw.world.ut.toFixed(1)}s ${type} ${d.what || ''} ${d.part || d.partName || ''} ${d.lost ? 'LOST' : ''} ${d.broken ? 'broken ' + d.broken : ''} ${d.reason || ''} ${type === 'landed' ? (d.speed || 0).toFixed(1) + ' m/s' : ''}`.replace(/\s+/g, ' ')); });
  const box = document.body; window.__toasts = [];
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && /toast/.test(n.className || '')) window.__toasts.push(n.textContent.trim()); }).observe(box, { childList: true, subtree: true });
});
const report = async label => { const r = await E(() => ({ said: window.__said, toasts: window.__toasts })); console.log('  ' + label + ' events: ' + JSON.stringify(r.said)); console.log('  ' + label + ' toasts: ' + JSON.stringify(r.toasts)); };
/** The active vessel `x, y, z` metres from the pad (east, up, south), upright, moving east at `speed`. */
const putNearPad = o => E(async o => {
  const THREE = await import('/js/lib/three.module.min.js');
  const { SYSTEM } = await import('/js/core/bodies.js');
  const { World } = await import('/js/core/world.js');
  const w = window.__sw.world, v = w.active, b = SYSTEM.home, dir = SYSTEM.launchSite.dir, Y = new THREE.Vector3(0, 1, 0);
  const up = b.surfaceDirToInertial(dir, w.ut, new THREE.Vector3()).normalize();
  const east = new THREE.Vector3().crossVectors(Y, up).normalize(), south = new THREE.Vector3().crossVectors(east, up);
  v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true; v.launchUt = w.ut;
  v.pos.copy(up).multiplyScalar(b.radius + o.y + (o.x * o.x + o.z * o.z) / (2 * b.radius)).addScaledVector(east, o.x).addScaledVector(south, o.z);
  const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x).addScaledVector(east, o.speed);
  v.q.setFromAxisAngle(Y, b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
  v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
  v.updateTelemetry(w.ut); w.step(0.001);
}, o);
const CAPSULE = `const pod = c.setRoot('pod_acorn')[0]; c.attachStack('chute', pod.id, 'top'); c.name = 'Bumper';`;
const where = () => E(async () => {
  const THREE = await import('/js/lib/three.module.min.js'); const { SYSTEM } = await import('/js/core/bodies.js');
  const w = window.__sw.world, v = w.active; if (!v || v.dead) return 'gone';
  const b = SYSTEM.home, up = b.surfaceDirToInertial(SYSTEM.launchSite.dir, w.ut, new THREE.Vector3()).normalize(), Y = new THREE.Vector3(0, 1, 0);
  const east = new THREE.Vector3().crossVectors(Y, up).normalize(), south = new THREE.Vector3().crossVectors(east, up), r = v.pos.clone().sub(up.clone().multiplyScalar(b.radius));
  return `east ${r.dot(east).toFixed(2)} m, up ${r.dot(up).toFixed(2)} m, south ${r.dot(south).toFixed(2)} m, ${v.parts.size} parts`;
});
try {
  await boot();
  await E(() => { window.__sw.app.settings.showHints = false; });
  if (grp('fallback')) await safe('fallback', async () => {
    await launchStock('Skylark II'); await listen();
    await cam(0.6, 0.12, 30); await off(0, 0); await shot('fallback-0-on-the-pad');
    await key('KeyZ'); await key('Space');
    await ff(20, 'v && v.altitude > 15');
    await E(() => { window.__sw.world.active.ctrl.throttle = 0; }); await key('KeyX');
    await ff(1.2); await shot('fallback-1-falling', { freeze: true });
    await ff(20, '!v || v.landed');
    await ff(1); await cam(0.6, 0.12, 22); await shot('fallback-2-after');
    console.log('  Skylark after the fall: ' + await where());
    await report('fallback');
  });
  if (grp('bump')) await safe('bump', async () => {
    await launchCustom(CAPSULE); await listen();
    await putNearPad({ x: -63, y: 30, z: 525, speed: 4 });
    await cam(4.4, 0.05, 25); await ff(0.5); await shot('bump-0-before', { freeze: true });
    await ff(1.5); await shot('bump-1-against-the-wall', { freeze: true });
    console.log('  capsule after a 4 m/s bump: ' + await where());
    await report('bump');
  });
  if (grp('crash')) await safe('crash', async () => {
    await launchCustom(CAPSULE); await listen();
    await putNearPad({ x: -90, y: 60, z: 525, speed: 40 });
    await cam(4.4, 0.05, 25); await ff(0.3); await shot('crash-0-on-the-way', { freeze: true });
    await ff(1); await shot('crash-1-after');
    console.log('  capsule after a 40 m/s hit: ' + await where());
    await report('crash');
  });
} catch (err) { problems.push('stopped: ' + (err.stack || err.message)); }
await browser.close(); await server.close();
if (problems.length) console.log('\nPROBLEMS:\n' + [...new Set(problems)].slice(0, 30).join('\n'));
console.log('done');
