// Preview captures of the flight screen for eyeballing: pad, lift-off, max-Q, staging, orbit (day and night
// sides), re-entry, parachute descent, moon landing, a spacewalk, runway take-off, rover driving (runway and Pell),
// the separation moment and an arrival at Rusk and Dray, each at 1440×900 and 1024×768.
//   names for the filter: pad liftoff maxq staging orbit-day orbit-night reentry chute moon eva runway takeoff rover rover-pell separation arrival
//   node tests/e2e/preview_flight.mjs [only,comma,separated]      → tests/out/preview-flight-<nn>-<name>-<w>x<h>.png
// It is a capture script, not a test: it fails only on page errors or when a scene cannot be reached.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = (process.argv[2] || process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const SIZES = [[1440, 900], [1024, 768]];
const problems = [];

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
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
    await page.screenshot({ path: path.join(OUT, `preview-flight-${tag}-${name}-${w}x${h}.png`), timeout: 120000 });
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

try {
  await boot();
  if (['pad', 'liftoff', 'maxq', 'staging', 'orbit-day', 'orbit-night', 'reentry', 'chute'].some(want)) {
    await launchStock('Skylark II');
    await E(() => { window.__sw.app.settings.showHints = true; });
    if (want('pad')) { await cam(2.2, 0.1, 46); await shot('pad'); }
    await key('KeyZ'); await key('Space');
    if (want('liftoff')) { await ff(60, 'v && v.altitude > 45'); await cam(0.9, 0.05, 55); await shot('liftoff'); }
    if (want('maxq')) { await ff(200, 'v && (v.dynamicPressure > 14000 || v.altitude > 9000)'); await cam(1.3, 0.25, 40); await shot('maxq');
      // from above and further back, after a second of flight, so the exhaust trail down to the ground is in frame
      await cam(1.3, 1.0, 300); await ff(1.5); await shot('maxq-trail'); }
    if (want('staging')) {
      await ff(400, 'v && v.engines.some(e => e.part.ignited && e.part.flameout)');
      await key('Space'); await ff(0.35);
      await cam(1.2, 0.2, 45); await shot('staging', { freeze: true });
    }
    if (want('orbit-day')) {
      await teleport({ alt: 120000, side: 1, phase: -0.5 }); await ff(2);
      await key('KeyU'); await ff(3);
      await cam(2.4, 0.35, 22); await shot('orbit-day');
      await key('KeyZ'); await ff(1.5); await cam(0.6, 0.1, 26); await shot('orbit-burn'); await key('KeyX');
    }
    if (want('orbit-night')) { await teleport({ alt: 120000, side: -1, phase: 0.2 }); await ff(2); await cam(2.2, 0.3, 22); await shot('orbit-night'); }
    if (want('reentry') || want('chute')) {
      // drop the service stages, then fall in retrograde-first
      await E(() => { const w = window.__sw.world, v = w.active; while (v.stageIndex < v.stages.length - 1) w.stage(); });
      await teleport({ alt: 62000, side: 1, phase: -0.9, speedFactor: 0.97, vy: -260, retro: true });
      await E(() => { const v = window.__sw.world.active; v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde'; });
      await ff(600, 'v && (v.heatFlux > 0 && v.altitude < 40000 && v.mach > 4 && (v.maxTempRatio > 0.35 || v.altitude < 32000))');
      if (want('reentry')) { await cam(2.6, 0.3, 14); await shot('reentry'); }
      if (want('chute')) {
        await ff(900, 'v && v.altitude < 6000');
        await key('Space');
        await ff(600, 'v && v.chuteParts.some(p => p.deployed === "full")'); await ff(2);
        await cam(0.8, -0.15, 22); await shot('chute');
        await ff(900, 'v && v.landed'); await ff(2.5);
        await cam(0.8, 0.12, 16); await shot('splashdown');
      }
    }
  }
  if (['moon', 'eva'].some(want)) {
    await launchCustom(LANDER);
    await key('Space');
    await teleport({ body: 'pell', alt: 9000, speedFactor: 0.55, side: 1, phase: -0.7 });
    await ff(2); await key('KeyG');
    const r = await runAutopilot('ap.hoverslamLanding(w, v, { useWarp: false })', 4000, 'v && v.thrust > 0 && v.radarAlt < 22 && v.radarAlt > 0');
    if (want('moon')) { await cam(0.7, 0.14, 20); await shot('moon-landing'); }
    if (!r.done) await runAutopilot('ap.hoverslamLanding(w, v, { useWarp: false })', 2000);
    await ff(3);
    if (want('moon')) { await cam(2.3, 0.1, 18); await shot('moon-landed'); }
    if (want('eva')) {
      await E(() => document.querySelector('[data-portrait="eva"]').click());
      await ff(4);
      await cam(0.5, 0.12, 7); await ff(2); await page.waitForTimeout(1500); await cam(0.5, 0.12, 7); await shot('eva');   // the view eases over to the Pip first
    }
  }
  if (['runway', 'takeoff'].some(want)) {
    await launchStock('Kite Trainer');
    if (want('runway')) { await cam(2.5, 0.14, 24); await shot('runway'); }
    await E(() => window.__sw.app.flight.actions.runProgram('takeoff'));
    await ff(120, 'v && v.radarAlt > 12 && v.verticalSpeed > 2');
    await cam(2.2, 0.06, 26); await shot('takeoff');
    await ff(200, 'v && v.radarAlt > 320');
    await E(() => window.__sw.app.flight.setCameraMode('chase'));
    await cam(Math.PI + 0.5, 0.2, 22); await shot('plane-climb');
    await E(() => window.__sw.app.flight.setCameraMode('orbit'));
  }
  if (['rover', 'rover-pell'].some(want)) {
    await launchStock('Trundle Scout');
    await key('KeyU');
    if (want('rover')) {
      await cam(2.4, 0.2, 9); await shot('rover-runway');
      await E(() => window.__sw.app.flight.actions.runProgram('drive'));
      await ff(40, 'v && v.groundSpeed > 6'); await ff(2);
      await cam(0.9, 0.12, 10); await shot('rover-driving');
    }
    if (want('rover-pell')) {
      await E(() => { const f = window.__sw.app.flight; if (f.assist) f.actions.runProgram(f.assistKind); });
      await placeOn({ body: 'pell', lat: 0.12, lon: -0.9, vehicle: true, heading: 70, alt: 2 });
      await ff(30, 'v && v.landed'); await ff(2);
      await E(() => window.__sw.app.flight.actions.runProgram('drive'));
      await ff(60, 'v && v.groundSpeed > 5'); await ff(3);
      await cam(1.0, 0.1, 10); await shot('rover-pell');
      await cam(2.6, 0.3, 16); await shot('rover-pell-wide');
    }
  }
  if (want('separation')) {
    await launchStock('Skylark II');
    await key('KeyZ'); await key('Space');
    await ff(400, 'v && v.engines.some(e => e.part.ignited && e.part.flameout)');
    // the moment itself: decoupler fired, the spent stage a few metres behind, the next engine lighting
    // (seen from above and to the side, so the dropped stage is clear of the new engine's plume and of the console)
    await cam(1.25, 0.75, 34);
    await key('Space'); await ff(0.1);
    await cam(1.25, 0.75, 34); await shot('separation', { freeze: true });
    console.log('  (after the shot: ' + JSON.stringify(await E(() => { const w = window.__sw.world, a = w.active; return w.vessels.filter(v => v !== a && v.body === a.body).map(v => ({ type: v.type, parts: v.parts.length, m: Math.round(Math.hypot(v.pos.x - a.pos.x, v.pos.y - a.pos.y, v.pos.z - a.pos.z)) })); })) + ')');
    await ff(0.25); await cam(1.25, 0.9, 60); await shot('separation-late', { freeze: true });
  }
  if (want('arrival')) {
    await launchCustom(LANDER);
    await key('Space');
    // falling toward Rusk from the edge of its sphere of influence, then low over the day side
    await teleport({ body: 'rusk', alt: 2.2e6, side: 1, phase: -0.75, speedFactor: 1.3 }); await ff(2);
    await key('KeyU'); await ff(3);
    // (the camera rides above the ship and looks down past it, so the world it is arriving at is the backdrop)
    await cam(2.5, 1.42, 24); await shot('arrival-rusk-far');
    await teleport({ body: 'rusk', alt: 160000, side: 1, phase: -0.6 }); await ff(2);
    await cam(2.3, 0.8, 22); await shot('arrival-rusk-orbit');
    await teleport({ body: 'dray', alt: 9000, side: 1, phase: -0.5 }); await ff(2);
    await cam(2.3, 0.8, 22); await shot('arrival-dray');
  }
} catch (err) { problems.push('preview stopped: ' + (err.stack || err.message)); }

await browser.close();
await server.close();
if (problems.length) { console.log('\nPROBLEMS:\n' + [...new Set(problems)].slice(0, 30).join('\n')); process.exit(1); }
console.log('\npreview captures written to tests/out/preview-flight-*.png');
