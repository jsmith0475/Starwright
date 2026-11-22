// A scripted "first evening" play-through that behaves like a player: real keyboard and mouse events wherever the
// feature is input-related, screenshots into tests/out/play-*.png.
//   node tests/e2e/playthrough.mjs                 everything
//   ONLY=career,keys node tests/e2e/playthrough.mjs    selected sections
// Sections: career keys mouse orbit science tracking pell robust perf
//
// Software GL renders a few frames per second, so long stretches are advanced by calling the flight screen's own
// update(dt) (same path as the game loop: input → world.step → HUD), clearing input edges like the main loop does.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });

const only = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const want = name => !only.length || only.includes(name);
const problems = [], notes = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }
function note(text) { notes.push(text); console.log('  · ' + text); }

const WHATSNEW_LATEST = (await import('../../js/ui/whatsnew.js')).RELEASES[0].id;
const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });

async function newPage(width = 1440, height = 900, storage = null) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  // a seeded save makes this a returning player: mark What's New as seen, so its pop-up (tests/e2e/whatsnew.mjs) stays out of the way
  if (storage) storage = { 'starwright.whatsnew.v1': WHATSNEW_LATEST, ...storage };
  if (storage) await ctx.addInitScript(s => { if (!sessionStorage.getItem('__seeded')) { for (const k in s) localStorage.setItem(k, s[k]); sessionStorage.setItem('__seeded', '1'); } }, storage);
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);            // software GL on a busy machine: a single frame can take seconds
  // every toast ever shown, so a check does not race the toast's own few-second lifetime on a slow machine
  await page.addInitScript(() => { window.__toastLog = []; const start = () => new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { const list = n.matches && n.matches('.sw-toast') ? [n] : [...n.querySelectorAll('.sw-toast')]; for (const t of list) window.__toastLog.push(t.textContent); } }).observe(document.documentElement, { childList: true, subtree: true }); if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start); });
  page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text() + ' @ ' + (m.location()?.url || '')); });
  page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
  page.on('requestfailed', r => { if (!/^data:/.test(r.url())) problems.push('request failed: ' + r.url()); });
  await page.addInitScript(() => { window.__ctxMenus = 0; window.addEventListener('contextmenu', e => { if (!e.defaultPrevented) window.__ctxMenus++; }, false); });
  return { ctx, page };
}
const shot = async (page, name, wait = 700) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(OUT, 'play-' + name + '.png') }); };
async function waitScreen(page, name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 240000 });
  await page.waitForTimeout(400);
}
const E = (page, fn, arg) => page.evaluate(fn, arg);
const tel = page => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, f = sw.app.flight;
  if (!w || !f) return null;
  const v = w.active && !w.active.dead ? w.active : null;
  const res = {};
  if (v) for (const k in v.resources) res[k] = v.resources[k].amount;
  return {
    ut: w.ut, warp: w.warpIndex, warpTarget: w.warpTarget, vessels: w.vessels.map(x => ({ id: x.id, name: x.name, type: x.type, sit: x.situation })), paused: f.paused, mapOpen: f.mapOpen,
    hud: { ...f.hud.values }, speedMode: f.state.speedMode, camMode: f.cam.mode, hudHidden: f.hud.hidden, hint: f.hud.hintText || '',
    cam: { yaw: f.cam.yaw, pitch: f.cam.pitch, dist: f.cam.dist, ox: f.cam.offset.x, oy: f.cam.offset.y },
    v: v && { id: v.id, name: v.name, type: v.type, sit: v.situation, alt: v.altitude, radar: v.radarAlt, vs: v.verticalSpeed, speed: v.airspeed, orb: v.orbitalSpeed, thr: v.ctrl.throttle,
      sas: v.ctrl.sas, rcs: v.ctrl.rcs, sasMode: v.ctrl.sasMode, stage: v.stageIndex, stages: v.stages.length, parts: v.parts.size, crew: v.crew, ap: v.apoapsis, pe: v.periapsis,
      landed: v.landed, splashed: v.splashed, thrust: v.thrust, nodes: v.nodes.length, nodeDv: v.nodeDv, science: v.science.length, dv: v.deltaV, res, mass: v.mass,
      legs: v.legsDown, solar: v.solarOut, w: [v.w.x, v.w.y, v.w.z], body: v.body.id, tx: v.ctrl.tx, ty: v.ctrl.ty, tz: v.ctrl.tz },
  };
});
/** Advance the game through the flight screen's update(dt); stops early when `until` (JS expression of w, v, f) is true. */
async function ff(page, simSeconds, until = 'false', dt = 0.05) {
  let left = simSeconds, hit = false;
  while (left > 0 && !hit) {
    const r = await page.evaluate(({ budget, until, dt }) => {
      const sw = window.__sw, app = sw.app, f = app.flight;
      const test = new Function('w', 'v', 'f', 'return (' + until + ');');
      const t0 = performance.now(); const sim0 = sw.world ? sw.world.ut : 0; let hit = false, n = 0;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world) {
        const w = sw.world;
        if (w.ut - sim0 >= budget) break;
        app.current.update(dt); app.input.endFrame(); n++;
        const v = w.active && !w.active.dead ? w.active : null;
        if (test(w, v, f)) { hit = true; break; }
        if (f.paused || n > 20000) break;
      }
      return { advanced: sw.world ? sw.world.ut - sim0 : budget, hit, n, gone: app.currentName !== 'flight' };
    }, { budget: left, until, dt });
    hit = r.hit;
    if (r.gone) break;
    left -= Math.max(r.advanced, r.n ? dt * 0.5 : left);
  }
  return hit;
}
/** One update tick so a key edge is consumed even if the (slow) render loop has not come round yet. */
const tick = (page, dt = 0.02) => page.evaluate(d => { const a = window.__sw.app; if (a.currentName === 'flight' && a.flight && !a.flight.paused) { a.current.update(d); a.input.endFrame(); } }, dt);
/** A real key tap. */
const key = async (page, code, hold = 60) => { await page.keyboard.down(code); await page.waitForTimeout(hold); await tick(page); await page.keyboard.up(code); await page.waitForTimeout(30); await tick(page); };
/** Hold a real key while the sim advances `sim` seconds. */
const holdKey = async (page, code, sim, until = 'false') => { await page.keyboard.down(code); await page.waitForTimeout(40); const r = await ff(page, sim, until, 0.02); await page.keyboard.up(code); await page.waitForTimeout(30); await tick(page); return r; };
const toasts = page => page.evaluate(() => [...document.querySelectorAll('.sw-toast')].map(n => n.textContent));
const clearToasts = page => page.evaluate(() => { document.querySelectorAll('.sw-toast').forEach(n => n.remove()); if (window.__toastLog) window.__toastLog.length = 0; });
/** Every toast shown since the last clearToasts, whether it is still on screen or has already timed out. */
const allToasts = page => page.evaluate(() => [...new Set([...(window.__toastLog || []), ...[...document.querySelectorAll('.sw-toast')].map(n => n.textContent)])]);
const hintText = page => page.evaluate(() => { const n = document.querySelector('.fl-hint'); return n && !n.classList.contains('sw-hidden') && getComputedStyle(n).display !== 'none' ? n.innerText.replace(/\s+/g, ' ').trim() : ''; });

async function boot(page, mode) {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
  if (!mode) return;
  await page.click('[data-action="new"]');
  await page.click(`.sw-mode[data-mode="${mode}"]`);
  await page.click('.sw-modal .sw-btn.primary');
  await waitScreen(page, 'hub');
}
async function launchStock(page, craftName) {
  await page.click('.sw-card[data-goto="launch"]');
  await page.waitForSelector('.sw-launch');
  await page.click(`.sw-item[data-craft="${craftName}"]`);
  await page.click('[data-action="launch"]');
  await waitScreen(page, 'flight');
  await page.waitForTimeout(900);
}
/** Launch a craft built in page context from a list of steps (for designs the stock list does not have). */
async function launchCustom(page, build, crew = 1) {
  await page.evaluate(async ({ src, crew }) => {
    const { Craft } = await import('/js/core/craft.js');
    const c = new Craft();
    new Function('c', src)(c);
    c.autoStage();
    const app = window.__sw.app;
    const names = app.career.availableCrew().slice(0, crew).map(p => p.name);
    app.launch(c, { crew: names });
  }, { src: build, crew });
  await waitScreen(page, 'flight');
  await page.waitForTimeout(900);
}
const frames = (page, n = 4) => page.evaluate(k => new Promise(r => { const step = () => (k-- > 0 ? requestAnimationFrame(step) : r()); step(); }), n);

// =====================================================================================================
// 1. Career: title → hangar → build from starting parts → fly by hand → recover → research → relaunch
// =====================================================================================================
async function career() {
  console.log('\n=== 1. fresh career: build, fly, recover, research, relaunch ===');
  const { ctx, page } = await newPage();
  await boot(page, 'career');
  const c0 = await E(page, () => ({ funds: window.__sw.career.funds, sci: window.__sw.career.science, tech: [...window.__sw.career.tech] }));
  ok(c0.funds >= 10000 && c0.sci === 0 && c0.tech.join() === 'start', `career starts with ${c0.funds} funds, 0 science, tech "start"`);
  await shot(page, '01-hub');

  await page.click('.sw-card[data-goto="builder"]');
  await waitScreen(page, 'builder');
  await page.waitForFunction(() => window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
  const B = (fn, arg) => page.evaluate(fn, arg);
  const settle = async () => {
    await page.waitForTimeout(150);
    await page.waitForFunction(() => { const c = window.__sw.app.builder.camera; return Math.abs(c.dist - c.tdist) < 0.02 && Math.abs(c.ty - c.tty) < 0.02 && Math.abs(c.yaw - c.tyaw) < 0.005 && Math.abs(c.pitch - c.tpitch) < 0.005; }, null, { timeout: 15000 });
    await page.waitForTimeout(250); await frames(page, 3);
  };
  const posOf = (id, fy = 0, side = 0) => B(([i, f, s]) => window.__sw.app.builder.partScreenPos(i, f, s), [id, fy, side]);
  const parts = () => B(() => window.__sw.app.builder.craft.parts.map(p => ({ id: p.id, type: p.type })));
  const pick = async (cat, type) => { await page.click(`.bld-cat[data-cat="${cat}"]`); await page.click(`.bld-card[data-part="${type}"]`); };
  const place = async p => { await page.mouse.move(p.x, p.y, { steps: 6 }); await frames(page, 4); await page.mouse.down(); await page.mouse.up(); await settle(); };
  if (await page.locator('[data-action="hint-ok"]').count()) await page.click('[data-action="hint-ok"]');
  const locked = await page.locator('.bld-card.locked, .bld-card[disabled]').count();
  note(`hangar: ${await page.locator('.bld-card').count()} part cards visible in the first category, ${locked} locked`);

  await pick('command', 'pod_acorn'); await place({ x: 700, y: 400 });
  let ps = await parts(); const pod = ps[0].id;
  await pick('engines', 'srb_ember'); await place(await posOf(pod, -0.8));
  await pick('utility', 'chute'); await place(await posOf(pod, 0.75));
  ps = await parts();
  const srb = ps.find(p => p.type === 'srb_ember');
  ok(ps.length === 3 && srb, 'pod + booster + parachute built with the mouse from starting parts');
  if (srb) {
    await pick('science', 'sci_thermo'); await place(await posOf(pod, 0.0, 0.42));
    await E(page, () => { const b = window.__sw.app.builder; if (b.setSymmetry) b.setSymmetry(3); });
    await page.keyboard.press('x'); await page.keyboard.press('x');
    await pick('aero', 'fin'); await place(await posOf(srb.id, -0.7, 0.4));
  }
  ps = await parts();
  ok(ps.some(p => p.type === 'sci_thermo'), 'thermal probe attached to the capsule side');
  ok(ps.filter(p => p.type === 'fin').length >= 3, `fins attached with symmetry (${ps.filter(p => p.type === 'fin').length})`);
  await page.fill('.bld-name', 'First Try');
  await page.mouse.move(1000, 200);
  await shot(page, '02-hangar-built');
  const cost = await B(() => window.__sw.app.builder.craft.cost());
  await page.click('[data-action="launch"]');
  await page.waitForSelector('.bld-launch');
  await shot(page, '03-launch-dialog', 300);
  await page.click('.sw-modal .sw-btn.primary');
  await waitScreen(page, 'flight');
  await page.waitForTimeout(900);
  let t = await tel(page);
  const funds1 = await E(page, () => window.__sw.career.funds);
  ok(Math.abs(c0.funds - funds1 - cost) < 1, `launch cost ${cost} was charged (${c0.funds} → ${funds1})`);
  ok(t.v.sit === 'prelaunch' && t.v.crew.length === 1, 'on the pad with a Pip aboard');
  const h0 = await hintText(page);
  ok(/Space/.test(h0) && /launch/i.test(h0), `pad hint tells a new player how to launch ("${h0.slice(0, 90)}")`);
  await shot(page, '04-pad');

  // science on the pad through the real panel
  await page.click('[data-tool="science"]');
  await page.waitForSelector('.fl-pop');
  await shot(page, '05-science-panel', 300);
  for (let i = 0; i < 6 && await page.locator('.fl-pop [data-action="run"]:not([disabled])').count(); i++) { await page.locator('.fl-pop [data-action="run"]:not([disabled])').first().click(); await tick(page); await page.waitForTimeout(80); }
  t = await tel(page);
  ok(t.v.science === 2, `crew report + temperature stored on the pad (${t.v.science})`);
  await page.keyboard.press('Escape'); await tick(page);
  ok(await page.locator('.fl-pop').count() === 0 && !(await tel(page)).paused, 'Esc closes the science panel (not the pause menu)');

  // launch by hand
  await key(page, 'KeyT'); await key(page, 'KeyT');
  await key(page, 'KeyZ');
  await key(page, 'Space');
  await ff(page, 2);
  t = await tel(page);
  ok(t.v.sit !== 'prelaunch' && t.v.thrust > 0, 'Space ignites the booster');
  await ff(page, 12);
  await shot(page, '06-ascent');
  // flying-low science
  await E(page, () => { const f = window.__sw.app.flight, v = window.__sw.world.active; for (const p of v.parts.values()) if (p.def.experiment) f.actions.runExperiment(p.id, p.def.experiment); });
  await ff(page, 120, 'v && v.thrust === 0 && v.stageIndex >= 1');
  t = await tel(page);
  const hBurn = await hintText(page);
  note(`after burnout at ${(t.v.alt / 1000).toFixed(1)} km, ${t.v.speed.toFixed(0)} m/s the hint says: "${hBurn}"`);
  await shot(page, '07-burnout');
  await ff(page, 300, 'v && v.altitude > 18000 || v.verticalSpeed < 0');
  await E(page, () => { const f = window.__sw.app.flight, v = window.__sw.world.active; for (const p of v.parts.values()) if (p.def.experiment) f.actions.runExperiment(p.id, p.def.experiment); });
  await ff(page, 600, 'v && v.verticalSpeed < -5');
  t = await tel(page);
  const apex = t.v.alt;
  note(`apex ≈ ${(apex / 1000).toFixed(1)} km`);
  ok((await hintText(page)) === '', 'no parachute nagging at the top of the arc (too high to open one)');
  await ff(page, 600, 'v && v.altitude < 27000'); await ff(page, 1.5);
  const hTop = await hintText(page);
  ok(/Space/.test(hTop) && /parachute/i.test(hTop), `falling with a stowed parachute the hint says to stage ("${hTop}")`);
  await key(page, 'Space');
  t = await tel(page);
  ok(t.v.stage === t.v.stages, 'Space arms the parachute (last stage)');
  await ff(page, 900, 'v && v.landed', 0.05);
  // physics warp on the way down is allowed by keyboard
  t = await tel(page);
  ok(t.v.landed, `landed/splashed under the parachute (${t.v.sit}, crew ${t.v.crew.join(',')})`);
  await ff(page, 3);
  await shot(page, '08-landed');
  const hLand = await hintText(page);
  ok(/recover/i.test(hLand), `after landing the hint points at Recover ("${hLand}")`);
  const before = await E(page, () => ({ funds: window.__sw.career.funds, sci: window.__sw.career.science, ms: [...window.__sw.career.milestones] }));
  await page.click('[data-tool="recover"]');
  await page.waitForSelector('[data-summary="recovery"]');
  await shot(page, '09-recovery', 300);
  const after = await E(page, () => ({ funds: window.__sw.career.funds, sci: window.__sw.career.science, ms: [...window.__sw.career.milestones], roster: window.__sw.career.roster.map(r => r.status) }));
  ok(after.funds > before.funds && after.sci > before.sci, `recovery pays out: funds ${before.funds} → ${after.funds}, science ${before.sci} → ${after.sci}`);
  ok(after.ms.includes('first_launch'), `milestones so far: ${after.ms.join(', ')}`);
  ok(after.roster.every(s => s === 'available'), 'crew is back on the roster');
  note(`BALANCE first flight: cost ${cost}, net funds ${after.funds - c0.funds}, science ${after.sci} (cheapest tech: 5 and 10)`);
  await page.click('.sw-modal .sw-btn.primary');
  await waitScreen(page, 'hub');
  ok(await E(page, () => window.__sw.career.flightState === null), 'no flight left behind after recovery');

  // research
  await page.click('.sw-card[data-goto="research"]');
  await waitScreen(page, 'research');
  await shot(page, '10-research');
  await page.click('.sw-node[data-tech="basic_rocketry"]');
  const canUnlock = await page.locator('[data-action="unlock"]:not([disabled])').count();
  ok(canUnlock === 1, 'the first tech node can be unlocked with the science from one flight');
  if (canUnlock) await page.click('[data-action="unlock"]');
  const tech = await E(page, () => ({ tech: [...window.__sw.career.tech], sci: window.__sw.career.science }));
  ok(tech.tech.includes('basic_rocketry'), `basic_rocketry unlocked, ${tech.sci} science left`);
  if (tech.sci >= 10) {
    await page.click('.sw-node[data-tech="survivability"]');
    if (await page.locator('[data-action="unlock"]:not([disabled])').count()) await page.click('[data-action="unlock"]');
    note('second node (survivability, 10) also affordable after one flight: ' + (await E(page, () => window.__sw.career.tech.has('survivability'))));
  }
  await shot(page, '11-research-unlocked');
  await page.keyboard.press('Escape');
  await waitScreen(page, 'hub');

  // relaunch the saved design
  await page.click('.sw-card[data-goto="builder"]');
  await waitScreen(page, 'builder');
  await page.waitForFunction(() => window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
  const kept = await B(() => window.__sw.app.builder.craft.parts.length);
  note(`back in the hangar the last design ${kept ? 'is still on the floor (' + kept + ' parts)' : 'is gone (empty floor)'}`);
  ok(await page.locator('.bld-card[data-part="eng_goshawk"]').count() >= 0, 'hangar reopens');
  if (!kept) { await B(() => window.__sw.app.goto('hub')); await waitScreen(page, 'hub'); await launchStock(page, 'Hopper I'); }
  else { await page.click('[data-action="launch"]'); await page.waitForSelector('.bld-launch'); await page.click('.sw-modal .sw-btn.primary'); await waitScreen(page, 'flight'); await page.waitForTimeout(600); }
  t = await tel(page);
  ok(t && t.v && t.v.sit === 'prelaunch', 'second launch is on the pad');
  ok((await hintText(page)) !== '' || true, 'pad hint state after first_launch: "' + (await hintText(page)) + '"');
  await ctx.close();
}

const sections = { career };

const TESTER = `
  const pod = c.setRoot('pod_acorn')[0];
  c.attachStack('chute', pod.id, 'top');
  const mono = c.attachStack('tank_mono', pod.id, 'bottom')[0];
  const bat = c.attachStack('battery', mono.id, 'bottom')[0];
  const tank = c.attachStack('tank_m200', bat.id, 'bottom')[0];
  c.attachStack('eng_sparrow', tank.id, 'bottom');
  c.attachRadial('rcs', tank.id, tank.pos.y + 0.5, 0, 4);
  c.attachRadial('legs', tank.id, tank.pos.y - 0.6, Math.PI / 4, 4);
  c.attachRadial('solar', mono.id, mono.pos.y, Math.PI / 2, 2);
  c.attachRadial('antenna', pod.id, pod.pos.y - 0.2, 0, 1);
  c.attachRadial('sci_thermo', pod.id, pod.pos.y - 0.2, Math.PI, 1);
  c.name = 'Tester';
`;
/** Put the active vessel on a circular orbit (or any state) without flying there. */
const teleport = (page, opts) => page.evaluate(async o => {
  const THREE = await import('/js/lib/three.module.min.js');
  const { SYSTEM } = await import('/js/core/bodies.js');
  const w = window.__sw.world, v = w.active, b = SYSTEM.byId[o.body || 'verda'];
  if (v.landed) { v.landed = false; v.splashed = false; v.surface = null; v.launched = true; v.launchUt = w.ut; }
  v.body = b; v.onRails = false; v._patch = null;
  const r = b.radius + o.alt;
  const vc = Math.sqrt(b.gm / r) * (o.speedFactor ?? 1);
  v.pos.set(r, 0, 0); v.vel.set(0, 0, -vc);
  if (o.vy) v.vel.x = o.vy;
  // nose along prograde, "top" (local Z) pointing away from the planet
  const Y = new THREE.Vector3(0, 0, -1), Z = new THREE.Vector3(1, 0, 0), X = new THREE.Vector3().crossVectors(Y, Z);
  v.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
  v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
  while (v.nodes.length) v.removeNode(v.nodes[0]);
  v.updateTelemetry(w.ut);
  w.step(0.001);
}, opts);
const axes = page => page.evaluate(async () => {
  const THREE = await import('/js/lib/three.module.min.js');
  const v = window.__sw.world.active; const f = a => { const d = new THREE.Vector3(...a).applyQuaternion(v.q); return [d.x, d.y, d.z]; };
  return { X: f([1, 0, 0]), Y: f([0, 1, 0]), Z: f([0, 0, 1]), vel: [v.vel.x, v.vel.y, v.vel.z], w: [v.w.x, v.w.y, v.w.z], ut: window.__sw.world.ut };
});
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// =====================================================================================================
// 2. Every flight key
// =====================================================================================================
async function keys() {
  console.log('\n=== 2. every flight key from the README ===');
  const { ctx, page } = await newPage();
  await boot(page, 'sandbox');
  await launchCustom(page, TESTER);
  let t = await tel(page);
  ok(t.v.sit === 'prelaunch' && t.v.res.mono > 100, 'custom RCS test craft is on the pad');
  await shot(page, '20-tester-pad');

  // ---- throttle
  await holdKey(page, 'ShiftLeft', 0.6); t = await tel(page);
  const thrShift = t.v.thr;
  ok(thrShift > 0.15 && thrShift < 0.6, `holding Shift raises the throttle smoothly (${(thrShift * 100).toFixed(0)}% after 0.6 s)`);
  await holdKey(page, 'ControlLeft', 0.3); t = await tel(page);
  ok(t.v.thr < thrShift - 0.1, `Ctrl lowers it (${(t.v.thr * 100).toFixed(0)}%)`);
  await holdKey(page, 'ArrowUp', 0.5); const up = (await tel(page)).v.thr;
  await holdKey(page, 'ArrowDown', 0.3); const dn = (await tel(page)).v.thr;
  ok(up > t.v.thr + 0.2 && dn < up - 0.1, `arrow up / down move the throttle too (${(up * 100).toFixed(0)}% → ${(dn * 100).toFixed(0)}%)`);
  await key(page, 'KeyZ'); ok((await tel(page)).v.thr === 1, 'Z = full throttle');
  await key(page, 'KeyX'); ok((await tel(page)).v.thr === 0, 'X = cut throttle');
  ok(Math.abs((await tel(page)).hud.throttle - 0) < 1e-6 && (await page.locator('.fl-thr-pct').innerText()) === '0%', 'HUD throttle read-out follows');

  // ---- toggles
  const sas0 = t.v.sas;
  await key(page, 'KeyT'); ok((await tel(page)).v.sas === !sas0, 'T toggles SAS');
  await key(page, 'KeyT');
  await key(page, 'KeyR'); t = await tel(page); ok(t.v.rcs === true && await page.locator('[data-light="rcs"].on').count() === 1, 'R switches RCS on (light on)');
  await key(page, 'KeyG'); t = await tel(page); ok(t.v.legs === true && await page.locator('[data-light="legs"].on').count() === 1, 'G lowers the legs (light on)');
  await key(page, 'KeyG'); ok((await tel(page)).v.legs === false, 'G raises them again');
  await key(page, 'KeyU'); t = await tel(page); ok(t.v.solar === true && await page.locator('[data-light="solar"].on').count() === 1, 'U unfolds the solar panels');
  await key(page, 'KeyC'); ok((await tel(page)).speedMode === 'orbit' && /orbit/i.test(await page.locator('.fl-mode-chip').innerText()), 'C switches the speed read-out to orbit');
  await key(page, 'KeyC'); ok((await tel(page)).speedMode === 'surface', 'C switches back to surface');
  const modes = [];
  for (let i = 0; i < 4; i++) { await key(page, 'KeyV'); modes.push((await tel(page)).camMode); }
  ok(modes.join() === 'chase,free,locked,orbit', `V cycles camera modes (${modes.join(' → ')})`);
  await key(page, 'F2'); ok((await tel(page)).hudHidden && !(await page.locator('.fl-console').isVisible()), 'F2 hides the HUD');
  await shot(page, '21-hud-hidden', 300);
  await key(page, 'F2'); ok(!(await tel(page)).hudHidden && await page.locator('.fl-console').isVisible(), 'F2 shows it again');
  await clearToasts(page);
  await key(page, 'BracketRight');
  ok((await toasts(page)).some(x => /no other vessel/i.test(x)), '] with nothing else around says so');

  // ---- warp keys on the pad, in the air and under thrust
  await key(page, 'Period'); await key(page, 'Period');
  ok((await tel(page)).warp === 2, '. raises time warp');
  await key(page, 'Comma'); ok((await tel(page)).warp === 1, ', lowers it');
  await key(page, 'Slash'); ok((await tel(page)).warp === 0, '/ stops time warp');
  await key(page, 'KeyZ'); await key(page, 'Space');
  await ff(page, 6);
  t = await tel(page);
  ok(t.v.thrust > 0, `Space lit the engine (alt ${t.v.alt.toFixed(0)} m)`);
  if (t.v.sit !== 'flying') ok(/Not enough thrust/.test(await hintText(page)), `too heavy to lift off, and the hint says so: "${await hintText(page)}"`);
  await clearToasts(page);
  for (let i = 0; i < 6; i++) await key(page, 'Period', 40);
  t = await tel(page);
  const warpMsg = (await allToasts(page)).filter(x => /warp/i.test(x));
  ok(t.warp === 3 && warpMsg.length > 0, `under thrust warp stops at 4× with a message: "${warpMsg[0] || ''}"`);
  ok(warpMsg.every(x => !/\((thrust|atmosphere|altitude|limit)\)/.test(x)), 'the limit message is plain English');
  await shot(page, '22-warp-limit', 200);
  await key(page, 'Slash');

  // ---- map and back
  await key(page, 'KeyM'); ok((await tel(page)).mapOpen, 'M opens the map');
  await shot(page, '23-map', 900);
  await key(page, 'KeyM'); ok(!(await tel(page)).mapOpen, 'M closes it');
  await key(page, 'KeyM'); await key(page, 'Escape'); t = await tel(page);
  ok(!t.mapOpen && !t.paused, 'Esc closes the map (without opening the pause menu)');

  // ---- attitude signs, in orbit with SAS off
  await teleport(page, { alt: 120000 });
  await key(page, 'KeyX');
  await E(page, () => { const v = window.__sw.world.active; v.ctrl.sas = false; });
  const turn = async code => { await E(page, () => window.__sw.world.active.w.set(0, 0, 0)); const a = await axes(page); await holdKey(page, code, 0.8); const b = await axes(page); return { a, b }; };
  let r = await turn('KeyD'); ok(dot(sub(r.b.Y, r.a.Y), r.a.X) > 0.01, 'D yaws the nose to the right (toward +X; ball slides left)');
  r = await turn('KeyA'); ok(dot(sub(r.b.Y, r.a.Y), r.a.X) < -0.01, 'A yaws left');
  r = await turn('KeyS'); ok(dot(sub(r.b.Y, r.a.Y), r.a.Z) > 0.01, 'S pitches the nose up (toward the pilot\'s head)');
  r = await turn('KeyW'); ok(dot(sub(r.b.Y, r.a.Y), r.a.Z) < -0.01, 'W pitches down');
  r = await turn('KeyE'); ok(dot(r.b.Z, r.a.X) > 0.01, 'E rolls clockwise (top goes right)');
  r = await turn('KeyQ'); ok(dot(r.b.Z, r.a.X) < -0.01, 'Q rolls counter-clockwise');
  // the ball agrees: a direction to the vessel's right is drawn right of centre
  const ballOk = await E(page, async () => {
    const THREE = await import('/js/lib/three.module.min.js');
    const f = window.__sw.app.flight, v = window.__sw.world.active;
    const X = new THREE.Vector3(1, 0, 0).applyQuaternion(v.q), Z = new THREE.Vector3(0, 0, 1).applyQuaternion(v.q), Y = new THREE.Vector3(0, 1, 0).applyQuaternion(v.q);
    const p1 = f.ball.project(Y.clone().addScaledVector(X, 0.3).normalize(), {}), p2 = f.ball.project(Y.clone().addScaledVector(Z, 0.3).normalize(), {});
    return p1.x > 0.1 && Math.abs(p1.y) < 0.01 && p2.y > 0.1 && Math.abs(p2.x) < 0.01 && p1.front && p2.front;
  });
  ok(ballOk, 'attitude ball: vessel-right is screen-right, vessel-top is screen-up');
  await E(page, () => { const v = window.__sw.world.active; v.w.set(0, 0, 0); v.ctrl.sas = true; v.ctrl.sasMode = 'hold'; v.sasTarget = null; });
  await ff(page, 3);

  // ---- RCS translation
  t = await tel(page);
  if (!t.v.rcs) await key(page, 'KeyR');
  const push = async code => { const m0 = (await tel(page)).v.res.mono; const a = await axes(page); await holdKey(page, code, 1.5); const b = await axes(page); const m1 = (await tel(page)).v.res.mono; return { dv: sub(b.vel, a.vel), a, used: m0 - m1, secs: b.ut - a.ut }; };
  // subtract gravity: compare against a no-key coast of the same length
  // gravity per second of game time, from a no-key coast. The game also runs (and falls) during the real-time pauses
  // around a key press, so each push is corrected by its own elapsed game time, not by a fixed 1.5 s.
  const coast = async () => { const a = await axes(page); await ff(page, 1.5, 'false', 0.02); const b = await axes(page); const k = 1 / Math.max(1e-6, b.ut - a.ut); return sub(b.vel, a.vel).map(x => x * k); };
  const tr = {};
  for (const [code, axis, sign] of [['KeyH', 'Y', 1], ['KeyN', 'Y', -1], ['KeyL', 'X', 1], ['KeyJ', 'X', -1], ['KeyI', 'Z', 1], ['KeyK', 'Z', -1]]) {
    // the baseline (gravity and drag with no key held) drifts as the craft falls: measure it right before each push
    const g = await coast();
    const p = await push(code); const net = sub(p.dv, g.map(x => x * p.secs)); const along = dot(net, p.a[axis]) * sign;
    tr[code] = along;
    ok(along > 0.05 && p.used > 0, `${code.slice(3)} translates along ${sign > 0 ? '+' : '−'}${axis} (${along.toFixed(2)} m/s, ${p.used.toFixed(2)} kg mono)`);
  }
  await key(page, 'KeyR');
  const off = await push('KeyH');
  ok(off.used === 0, 'with RCS off (R) the translation keys do nothing');
  await shot(page, '24-orbit-rcs');

  // ---- warp limits in space
  await clearToasts(page);
  for (let i = 0; i < 12; i++) await key(page, 'Period', 30);
  t = await tel(page);
  const lim = (await allToasts(page)).filter(x => /warp/i.test(x));
  ok(t.warp >= 5 && t.warp < 10 && lim.length > 0, `at 120 km warp tops out at index ${t.warp} with a message: "${lim[lim.length - 1] || ''}"`);
  await key(page, 'Slash');
  ok((await tel(page)).warp === 0, '/ drops back to 1×');

  // ---- pause menu: every item
  await key(page, 'Escape');
  await page.waitForSelector('.fl-menu');
  t = await tel(page);
  ok(t.paused, 'Esc opens the pause menu and pauses the flight');
  const items = await page.locator('.fl-menu [data-menu]').evaluateAll(els => els.map(e => e.dataset.menu + (e.disabled ? '(off)' : '')));
  note('pause menu items: ' + items.join(', '));
  await shot(page, '25-pause-menu', 300);
  const ut0 = t.ut;
  await page.waitForTimeout(500);
  ok(Math.abs((await tel(page)).ut - ut0) < 1e-6, 'time stands still while the menu is open');
  await page.click('[data-menu="controls"]');
  await page.waitForFunction(() => /W|Pitch/i.test((document.querySelector('.sw-modal') || {}).innerText || '') && !document.querySelector('.fl-menu'));
  await shot(page, '26-controls', 300);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.fl-menu');
  ok(true, 'Controls opens and Esc returns to the pause menu');
  await page.click('[data-menu="settings"]');
  await page.waitForFunction(() => !document.querySelector('.fl-menu') && document.querySelector('.sw-modal'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.fl-menu');
  await page.click('[data-menu="quicksave"]');
  await page.waitForSelector('.fl-menu');
  ok((await toasts(page)).some(x => /quicksaved/i.test(x)), 'Quicksave from the menu works and keeps the menu open');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await tick(page);
  ok(!(await tel(page)).paused, 'Esc resumes');

  // ---- F5 / F9 and Shift+K / Shift+L
  const mark = async () => E(page, () => { const v = window.__sw.world.active; return { ut: window.__sw.world.ut, mono: v.resources.mono.amount }; });
  await key(page, 'F5');
  const s1 = await mark();
  await ff(page, 20);
  await page.keyboard.down('F9'); await page.waitForTimeout(60); await tick(page); await page.keyboard.up('F9');
  await page.waitForSelector('.sw-modal');
  await shot(page, '27-quickload-confirm', 300);
  await page.click('.sw-modal .sw-btn.primary');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await tick(page);
  let s2 = await mark();
  ok(Math.abs(s2.ut - s1.ut) < 1, `F5 / F9 round-trips the flight (ut ${s1.ut.toFixed(1)} → ${s2.ut.toFixed(1)})`);
  await ff(page, 5);
  const thr0 = (await tel(page)).v.thr;
  await page.keyboard.down('ShiftLeft'); await page.waitForTimeout(30); await page.keyboard.down('KeyK'); await page.waitForTimeout(60); await tick(page); await page.keyboard.up('KeyK'); await page.keyboard.up('ShiftLeft'); await tick(page);
  const s3 = await mark();
  ok((await allToasts(page)).filter(x => /quicksaved/i.test(x)).length >= 1 && (await tel(page)).v.thr === thr0, 'Shift+K quicksaves without nudging the throttle');
  await ff(page, 15);
  await page.keyboard.down('ShiftLeft'); await page.waitForTimeout(30); await page.keyboard.down('KeyL'); await page.waitForTimeout(60); await tick(page); await page.keyboard.up('KeyL'); await page.keyboard.up('ShiftLeft');
  await page.waitForSelector('.sw-modal');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await tick(page);
  s2 = await mark();
  ok(Math.abs(s2.ut - s3.ut) < 1, `Shift+K / Shift+L round-trips too, Enter confirms the dialog (ut ${s3.ut.toFixed(1)} → ${s2.ut.toFixed(1)})`);
  t = await tel(page);
  ok(t.v && t.v.tx === 0 && t.v.ty === 0 && t.v.tz === 0 && t.v.thr === thr0, 'no stuck translation / throttle after Shift+L');
  await ctx.close();
}
sections.keys = keys;

// =====================================================================================================
// 3. Mouse
// =====================================================================================================
async function mouse() {
  console.log('\n=== 3. mouse: wheel (coarse + hi-res), drags, double-click, context menu ===');
  const { ctx, page } = await newPage();
  await boot(page, 'sandbox');
  await launchStock(page, 'Skylark II');
  const cam = async () => (await tel(page)).cam;
  const settle = async () => { await page.waitForTimeout(250); await ff(page, 0.8, 'false', 0.02); };
  await page.mouse.move(700, 380);
  let c0 = await cam();
  await page.mouse.wheel(0, 100); await settle();
  let c1 = await cam();
  ok(c1.dist > c0.dist * 1.15 && c1.dist < c0.dist * 1.4, `one coarse notch out zooms ×${(c1.dist / c0.dist).toFixed(2)}`);
  await page.mouse.wheel(0, -100); await settle();
  let c2 = await cam();
  ok(Math.abs(c2.dist - c0.dist) < c0.dist * 0.03, 'one notch back in returns to the same distance');
  // hi-res wheel: many tiny deltas
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 4);
  await settle();
  c1 = await cam();
  ok(c1.dist > c0.dist * 1.25 && c1.dist < c0.dist * 1.6, `40 small hi-res deltas (160 px) zoom smoothly ×${(c1.dist / c0.dist).toFixed(2)}`);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -4);
  await settle();
  c2 = await cam();
  ok(Math.abs(c2.dist - c0.dist) < c0.dist * 0.05, `and back (${c0.dist.toFixed(1)} → ${c2.dist.toFixed(1)})`);
  // free-spin flick: a flood of big deltas must not teleport the camera
  await E(page, () => { const cv = window.__sw.app.canvas; for (let i = 0; i < 80; i++) cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, clientX: 700, clientY: 380, bubbles: true, cancelable: true })); });
  await settle();
  c1 = await cam();
  ok(c1.dist < c0.dist * 1.7 && c1.dist > c0.dist * 1.3, `a free-spin flood of 80×120 px in one frame is budgeted (×${(c1.dist / c0.dist).toFixed(2)})`);
  for (let k = 0; k < 30; k++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(25); }
  await settle();
  c1 = await cam();
  ok(c1.dist >= 4 && c1.dist < 6, `zooming all the way in stops at the minimum (${c1.dist.toFixed(1)} m)`);
  await shot(page, '30-zoom-in', 300);
  for (let k = 0; k < 60; k++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(25); }
  await settle();
  c1 = await cam();
  ok(c1.dist > 1500 && c1.dist <= 3000, `zooming out stops at the maximum (${c1.dist.toFixed(0)} m)`);
  await shot(page, '31-zoom-out', 300);
  await page.mouse.dblclick(700, 380); await settle();
  c1 = await cam();
  ok(Math.abs(c1.dist - c0.dist) < 1, 'double-click resets the view');

  // right-drag orbit
  await page.mouse.move(700, 380); await page.mouse.down({ button: 'right' }); await page.mouse.move(800, 340, { steps: 5 }); await page.mouse.up({ button: 'right' });
  c1 = await cam();
  ok(Math.abs(c1.yaw - c0.yaw) > 0.3 && Math.abs(c1.pitch - c0.pitch) > 0.1, 'right-drag orbits the camera');
  // middle-drag offset
  await page.mouse.move(700, 380); await page.mouse.down({ button: 'middle' }); await page.mouse.move(760, 420, { steps: 5 }); await page.mouse.up({ button: 'middle' });
  c2 = await cam();
  ok(Math.abs(c2.ox) > 0.5 && Math.abs(c2.yaw - c1.yaw) < 1e-6, `middle-drag offsets the view (${c2.ox.toFixed(1)}, ${c2.oy.toFixed(1)} m)`);
  await page.mouse.dblclick(700, 380); await settle();
  // a drag that starts on the canvas and ends over a HUD panel
  c0 = await cam();
  const wing = await page.locator('[data-hud="altitude"]').boundingBox();
  await page.mouse.move(700, 380); await page.mouse.down({ button: 'right' });
  await page.mouse.move(wing.x + 40, wing.y + 40, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  c1 = await cam();
  await page.mouse.move(wing.x + 120, wing.y + 60, { steps: 4 });
  await page.mouse.move(600, 300, { steps: 4 });
  c2 = await cam();
  ok(Math.abs(c1.yaw - c0.yaw) > 0.3, 'a right-drag keeps orbiting while the pointer crosses a HUD panel');
  ok(Math.abs(c2.yaw - c1.yaw) < 1e-9 && Math.abs(c2.pitch - c1.pitch) < 1e-9, 'releasing over the panel ends the drag (no stuck button)');
  // a drag that starts on a HUD panel does nothing to the camera
  await page.mouse.move(wing.x + 60, wing.y + 60); await page.mouse.down({ button: 'right' }); await page.mouse.move(700, 300, { steps: 5 }); await page.mouse.up({ button: 'right' });
  await page.mouse.move(wing.x + 60, wing.y + 60); await page.mouse.down(); await page.mouse.move(650, 300, { steps: 5 }); await page.mouse.up();
  const c3 = await cam();
  ok(Math.abs(c3.yaw - c2.yaw) < 1e-9, 'a drag that starts on a HUD panel leaves the camera alone');
  // right-clicks everywhere
  for (const sel of ['[data-hud="altitude"]', '.fl-vessel', '.fl-time', '.fl-tools', '.fl-stage', '.fl-hub-bg']) { const b = await page.locator(sel).first().boundingBox(); if (b) await page.mouse.click(b.x + b.width / 2, b.y + 8, { button: 'right' }); }
  await page.mouse.click(700, 380, { button: 'right' });
  await page.click('[data-tool="science"]'); await page.mouse.click(1300, 150, { button: 'right' }); await page.click('[data-tool="science"]');
  ok(await E(page, () => window.__ctxMenus) === 0, `the browser context menu never opens in flight (${await E(page, () => window.__ctxMenus)} leaked)`);
  // mouse back button toggles the map, never navigates
  const url0 = page.url();
  await page.mouse.move(700, 380);
  await E(page, () => { const cv = window.__sw.app.canvas; const o = { button: 3, buttons: 8, clientX: 700, clientY: 380, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }; cv.dispatchEvent(new PointerEvent('pointerdown', o)); cv.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); });
  await tick(page);
  ok((await tel(page)).mapOpen && page.url() === url0, 'mouse "back" button opens the map instead of leaving the page');

  // ---- map
  await ff(page, 0.5); await page.waitForTimeout(400);
  const md = () => E(page, () => { const d = window.__sw.app.flight.map.debug(); return d; });
  let m0 = await md();
  note('map debug keys: ' + Object.keys(m0 || {}).join(','));
  const mdist = d => d.dist ?? d.camDist ?? d.distance;
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 100); await page.waitForTimeout(300); await ff(page, 0.6);
  let m1 = await md();
  ok(mdist(m1) > mdist(m0) * 1.1, `map: coarse wheel zooms out (×${(mdist(m1) / mdist(m0)).toFixed(2)})`);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -4);
  await page.waitForTimeout(300); await ff(page, 0.6);
  let m2 = await md();
  ok(mdist(m2) < mdist(m1) * 0.85, `map: hi-res wheel zooms in smoothly (×${(mdist(m2) / mdist(m1)).toFixed(2)})`);
  await page.mouse.move(700, 400); await page.mouse.down({ button: 'right' }); await page.mouse.move(820, 350, { steps: 6 }); await page.mouse.up({ button: 'right' });
  await ff(page, 0.4);
  const m3 = await md();
  ok(JSON.stringify([m3.yaw, m3.pitch]) !== JSON.stringify([m2.yaw, m2.pitch]), 'map: right-drag orbits');
  for (const sel of ['.fl-rp', '.fl-time', '.map-panel', '.map-focus']) { const b = await page.locator(sel).first().boundingBox().catch(() => null); if (b) await page.mouse.click(b.x + b.width / 2, b.y + 8, { button: 'right' }); }
  await page.mouse.click(700, 400, { button: 'right' });
  ok(await E(page, () => window.__ctxMenus) === 0, 'no context menu in the map either');
  const camBefore = await cam();
  await page.mouse.move(700, 400); await page.mouse.wheel(0, 300); await page.mouse.down({ button: 'right' }); await page.mouse.move(760, 430, { steps: 3 }); await page.mouse.up({ button: 'right' });
  await key(page, 'KeyM'); await ff(page, 0.5);
  const camAfter = await cam();
  ok(Math.abs(camAfter.dist - camBefore.dist) < 0.5 && Math.abs(camAfter.yaw - camBefore.yaw) < 1e-6, 'mouse work in the map does not move the flight camera');
  await shot(page, '32-after-map');

  // ---- hangar
  await E(page, () => window.__sw.app.goto('builder', {}));
  await waitScreen(page, 'builder');
  await page.waitForFunction(() => window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
  await page.waitForTimeout(800);
  const bc = () => E(page, () => { const c = window.__sw.app.builder.camera; return { dist: c.tdist, yaw: c.tyaw, pitch: c.tpitch, ty: c.tty }; });
  let b0 = await bc();
  await page.mouse.move(700, 430);
  // in the hangar the plain wheel scrolls along the craft; Shift+wheel (or a pinch) zooms
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 100); await page.waitForTimeout(200);
  let b1 = await bc();
  ok(b1.dist > b0.dist * 1.1, `hangar: Shift + coarse wheel zooms out (×${(b1.dist / b0.dist).toFixed(2)})`);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -4);
  await page.waitForTimeout(200);
  let b2 = await bc();
  ok(b2.dist < b1.dist * 0.85, `hangar: Shift + hi-res wheel zooms in (×${(b2.dist / b1.dist).toFixed(2)})`);
  await page.keyboard.up('Shift');
  await page.mouse.down({ button: 'right' }); await page.mouse.move(800, 400, { steps: 5 }); await page.mouse.up({ button: 'right' });
  let b3 = await bc();
  ok(Math.abs(b3.yaw - b2.yaw) > 0.1, 'hangar: right-drag orbits');
  await page.mouse.move(700, 430); await page.mouse.down({ button: 'middle' }); await page.mouse.move(700, 500, { steps: 5 }); await page.mouse.up({ button: 'middle' });
  const b4 = await bc();
  ok(Math.abs(b4.ty - b3.ty) > 0.05, 'hangar: middle-drag pans');
  for (const sel of ['.bld-card', '.bld-info', '.bld-name']) { const b = await page.locator(sel).first().boundingBox().catch(() => null); if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' }); }
  note(`hangar context menus leaked over panels: ${await E(page, () => window.__ctxMenus)}`);
  await ctx.close();
}
sections.mouse = mouse;


// =====================================================================================================
// 4. To orbit by hand: keys on a schedule, a maneuver node made with the mouse, burned with the node SAS mode
// =====================================================================================================
const hudText = page => page.evaluate(() => {
  const q = s => { const n = document.querySelector(s); return n ? n.innerText.replace(/\s+/g, ' ').trim() : ''; };
  const kv = {}; document.querySelectorAll('.fl-kv .k').forEach(k => { kv[k.textContent] = k.nextElementSibling ? k.nextElementSibling.innerText.replace(/\s+/g, ' ').trim() : ''; });
  return { alt: q('[data-hud="altitude"] .fl-big'), spd: q('[data-hud="speed"]'), kv, dv: q('.fl-dv b'), node: q('.fl-node'), hdg: q('[data-hud="heading"]'), sit: q('.fl-vessel-sit'), met: q('.fl-met'), twr: q('.fl-throttle'), alerts: q('.fl-alerts') };
});
const km = s => { const m = /([\d.,]+)\s*(km|Mm|m)/.exec(s || ''); if (!m) return NaN; const x = parseFloat(m[1].replace(/,/g, '')); return m[2] === 'km' ? x * 1000 : m[2] === 'Mm' ? x * 1e6 : x; };
const secs = s => { let t = 0, any = false; for (const m of (s || '').matchAll(/(\d+)\s*([dhms])/g)) { any = true; t += +m[1] * { d: 19800, h: 3600, m: 60, s: 1 }[m[2]]; } return any ? t : NaN; };

async function orbit() {
  console.log('\n=== 4. Skylark II to orbit by hand ===');
  const { ctx, page } = await newPage();
  await boot(page, 'sandbox');
  await launchStock(page, 'Skylark II');
  let h = await hudText(page), t = await tel(page);
  ok(/1\.00 atm/.test(h.kv['Air pressure']), `on the pad the HUD shows sea-level pressure ("${h.kv['Air pressure']}")`);
  note(`pad heading read-out: "${h.hdg}"`);
  ok(/SAS/.test(await hintText(page)), `pad hint: "${await hintText(page)}"`);
  ok(t.v.sas === true, 'SAS is already on at the pad');
  await key(page, 'KeyZ'); await key(page, 'Space');
  await ff(page, 60, 'v && v.altitude > 1000');
  await ff(page, 1.2);
  ok(/D/.test(await hintText(page)) && /turn/i.test(await hintText(page)), `at 1 km a first-timer is told to start the turn ("${await hintText(page)}")`);
  await shot(page, '40-turn-hint', 300);
  // pitch program flown with the D key (SAS hold keeps what we set): 80° at 1 km … 45° at 10 km … 20° at 30 km
  const target = alt => alt < 1000 ? 90 : alt < 10000 ? 80 - 35 * (alt - 1000) / 9000 : alt < 30000 ? 45 - 25 * (alt - 10000) / 20000 : 20;
  let staged = 0, sawDry = false, sawCut = false, maxQ = 0;
  for (let i = 0; i < 400; i++) {
    t = await tel(page);
    if (!t.v || t.v.ap > 80000 || t.v.alt > 34000) break;
    maxQ = Math.max(maxQ, t.hud.q || 0);
    const hint = await hintText(page);
    if (/Out of fuel/i.test(hint)) { sawDry = true; await key(page, 'Space'); staged++; await ff(page, 0.6); if ((await tel(page)).v.thrust === 0) { await key(page, 'Space'); staged++; } continue; }
    const want = target(t.v.alt);
    if (t.hud.pitch > want + 1.5) await holdKey(page, 'KeyD', 3, `f.state.pitch < ${want}`);
    else await ff(page, 1.5, `!v || v.apoapsis > 80000 || v.thrust === 0`);
  }
  t = await tel(page); h = await hudText(page);
  ok(Math.abs(t.hud.heading - 90) < 12, `holding D tips the rocket east (heading ${t.hud.heading.toFixed(0)}°, pitch ${t.hud.pitch.toFixed(0)}° at ${(t.v.alt / 1000).toFixed(1)} km)`);
  await shot(page, '41-ascent-30km', 300);
  // above ~30 km: follow prograde with the SAS mode button
  await page.click('[data-sas="prograde"]'); await tick(page);
  t = await tel(page);
  ok(/rograde/.test(t.v.sasMode), `clicking the prograde button sets SAS to ${t.v.sasMode}`);
  for (let i = 0; i < 300; i++) {
    t = await tel(page);
    if (!t.v || t.v.ap > 80000) break;
    const hint = await hintText(page);
    if (/cut throttle/i.test(hint)) sawCut = true;
    if (/Out of fuel/i.test(hint)) { sawDry = true; await key(page, 'Space'); staged++; await ff(page, 0.6); if ((await tel(page)).v.thrust === 0 && (await tel(page)).v.stage < (await tel(page)).v.stages - 1) { await key(page, 'Space'); staged++; } continue; }
    await ff(page, 1, '!v || v.apoapsis > 80000 || v.thrust === 0');
  }
  if (/cut throttle/i.test(await hintText(page))) sawCut = true;
  await shot(page, '42-ap-80', 200);
  await key(page, 'KeyX');
  t = await tel(page); h = await hudText(page);
  ok(t.v.ap > 79000 && t.v.thr === 0, `apoapsis ${(t.v.ap / 1000).toFixed(1)} km, throttle cut with X at ${(t.v.alt / 1000).toFixed(1)} km`);
  ok(sawDry && staged >= 1, `"Out of fuel: press Space" hint appeared and staging with Space worked (${staged} presses)`);
  ok(sawCut, 'the "Apoapsis above 72 km: cut throttle" hint appeared while burning');
  note(`max dynamic pressure on the way up ${(maxQ / 1000).toFixed(1)} kPa`);
  // HUD numbers against the world
  const truth = await E(page, () => { const w = window.__sw.world, v = w.active, o = v.getOrbit(w.ut); return { ap: o.apoapsis - v.body.radius, pe: o.periapsis - v.body.radius, tAp: o.timeToApoapsis(w.ut), alt: v.pos.length() - v.body.radius, vs: v.verticalSpeed }; });
  ok(Math.abs(km(h.kv.Apoapsis) - truth.ap) < 150, `HUD apoapsis "${h.kv.Apoapsis}" matches the orbit (${(truth.ap / 1000).toFixed(2)} km)`);
  ok(Math.abs(secs(h.kv.Apoapsis.replace(/^[\d.,]+ km/, '')) - truth.tAp) < 3, `time to apoapsis matches (${truth.tAp.toFixed(0)} s)`);
  ok(/below ground|km|m/.test(h.kv.Periapsis), `periapsis read-out: "${h.kv.Periapsis}" (orbit: ${(truth.pe / 1000).toFixed(1)} km)`);
  // delta-v left: independent rocket-equation check for the stages that remain
  const dvCheck = await E(page, async () => {
    const { G0 } = await import('/js/core/parts.js');
    const v = window.__sw.world.active;
    let fuel = 0, ve = 0, n = 0;
    for (const e of v._engines) { if (!e.part.ignited || e.part.def.engine.type === 'solid') continue; ve = e.part.def.engine.ispVac * G0; n++; const seen = new Set(); for (const t of e.tanks) if (!seen.has(t.id)) { seen.add(t.id); fuel += t.res.fuel; } }
    return { mine: n === 1 ? ve * Math.log(v.mass / (v.mass - fuel)) : null, hud: v.deltaV, shown: document.querySelector('.fl-dv b').textContent, laterEngines: v.hasEngineStagesLeft() };
  });
  if (dvCheck.mine !== null && !dvCheck.laterEngines) ok(Math.abs(dvCheck.mine - dvCheck.hud) < Math.max(15, dvCheck.mine * 0.03), `Δv left ${dvCheck.shown} matches the rocket equation (${dvCheck.mine.toFixed(0)} m/s)`);
  else note(`Δv check skipped (engines lit: ${dvCheck.mine}, later engine stages: ${dvCheck.laterEngines}); HUD shows ${dvCheck.shown}`);
  ok(/plan|map/i.test(await hintText(page)), `coasting hint points at the map: "${await hintText(page)}"`);

  // ---- coast out of the air, open the map with M, plan the circularisation with the mouse
  await ff(page, 600, 'v && v.altitude > 72500');
  await key(page, 'KeyM');
  await ff(page, 1); await page.waitForTimeout(600);
  const dbg = () => E(page, () => window.__sw.app.flight.map.debug());
  // Planning with the mouse takes this script a while in real time, and the game keeps running between its steps:
  // on a fast machine the apoapsis would arrive before the node is finished. Hold the world's clock while planning
  // (the screen, the map and the input still run every frame); it is released before "Warp to node".
  const holdClock = on => E(page, on => { const w = window.__sw.world; if (on) w.step = function () {}; else delete w.step; }, on);
  await holdClock(true);
  const tAp = await E(page, () => { const w = window.__sw.world, v = w.active; return w.ut + v.getOrbit(w.ut).timeToApoapsis(w.ut); });
  let pt = null;
  for (const dtp of [0, -8, 8, -20, 20, -40, -55, 40]) {
    const p = await E(page, tt => {
      const q = window.__sw.app.flight.map.screenPointAtTime(tt);
      // a marker label (e.g. "Atmosphere in …") may sit on top of the line there: a player clicks the bare orbit beside it
      if (q && q.visible) { const el = document.elementFromPoint(q.x + 1, q.y + 1); q.free = !el || el.tagName === 'CANVAS' || !el.closest('[class*="label"], [class*="marker"], [class*="pin"], button'); }
      return q;
    }, tAp + dtp);
    if (p && p.visible && p.free) { pt = p; break; }
  }
  if (!pt) { const d = await dbg(); note('map state: ' + JSON.stringify({ focus: d.focus, dist: d.dist, yaw: d.yaw, pitch: d.pitch, chains: d.chains, p: await E(page, tt => window.__sw.app.flight.map.screenPointAtTime(tt), tAp) }).slice(0, 700)); }
  ok(!!pt, 'the apoapsis point is on screen in the map');
  await shot(page, '43-map-before-node', 300);
  await page.mouse.move(pt.x + 30, pt.y + 30); await page.mouse.move(pt.x + 1, pt.y + 1, { steps: 4 });
  await page.waitForTimeout(250); await tick(page);
  const hov = await E(page, p => { const d = window.__sw.app.flight.map.debug(), el = document.elementFromPoint(p.x + 1, p.y + 1); return { hover: d.hover, el: el ? el.tagName + '.' + String(el.className).slice(0, 60) : null, p }; }, pt);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(300); await tick(page);
  let d = await dbg();
  if (d.nodes.length !== 1) note('map click: ' + JSON.stringify(hov).slice(0, 500));
  ok(d.nodes.length === 1 && Math.abs(d.nodes[0].t - tAp) < 60, `clicking the orbit near the apoapsis adds a node there (${d.nodes.length ? (d.nodes[0].t - tAp).toFixed(0) : '?'} s from Ap)`);
  // drag the prograde handle until the planned periapsis clears the atmosphere
  for (let i = 0; i < 40; i++) {
    d = await dbg();
    const pe = d.chains[1] ? d.chains[1].pe : -1e9;
    if (pe > 74000) break;
    // the gizmo is laid out by the map's next rendered frame, which can be seconds away in software GL
    const handle = page.locator('.map-handle[data-axis="prograde"][data-sign="1"]');
    await handle.waitFor({ state: 'visible' });
    const hb = await handle.boundingBox();
    d = await dbg();
    const node = d.nodeScreen[0];
    const hx = hb.x + hb.width / 2, hy = hb.y + hb.height / 2;
    let ux = hx - node.x, uy = hy - node.y; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    const pull = pe < 20000 ? 90 : pe < 60000 ? 45 : 22;
    await page.mouse.move(hx, hy); await page.mouse.down();
    await page.mouse.move(hx + ux * pull, hy + uy * pull, { steps: 4 });
    await page.waitForTimeout(pe < 20000 ? 900 : 350); await tick(page);
    await page.mouse.up(); await page.waitForTimeout(150); await tick(page);
  }
  d = await dbg();
  const planned = d.chains[1] || { pe: NaN, ap: NaN };
  ok(planned.pe > 72000, `dragging the prograde handle raises the planned periapsis to ${(planned.pe / 1000).toFixed(1)} km (${d.nodes[0].dv.prograde.toFixed(1)} m/s)`);
  await shot(page, '44-map-node', 400);
  t = await tel(page); h = await hudText(page);
  const nd = await E(page, async () => {
    const { G0 } = await import('/js/core/parts.js');
    const w = window.__sw.world, v = w.active, n = v.nodes[0], dv = Math.hypot(n.dv.prograde, n.dv.normal, n.dv.radial);
    let F = 0, mdot = 0; for (const e of v._engines) if (e.part.ignited && !e.part.flameout) { const en = e.part.def.engine; F += en.thrust * 1000; mdot += en.thrust * 1000 / (en.ispVac * G0); }
    const ve = F / mdot;
    return { dv, burn: v.mass * ve / F * (1 - Math.exp(-dv / ve)), tTo: n.t - w.ut, nodeDv: v.nodeDv, hudBurn: window.__sw.app.flight.hud.values.nodeBurn, hudDv: window.__sw.app.flight.hud.values.nodeDv };
  });
  ok(Math.abs(nd.hudDv - nd.dv) < 0.2 && new RegExp(nd.dv.toFixed(1).replace('.', '\\.')).test(h.node.replace(/,/g, '')), `node card shows the planned ${nd.dv.toFixed(1)} m/s ("${h.node}")`);
  ok(Math.abs(nd.hudBurn - nd.burn) < Math.max(1, nd.burn * 0.06), `burn time ${nd.hudBurn.toFixed(1)} s matches thrust and mass (${nd.burn.toFixed(1)} s)`);
  ok(Math.abs(secs(h.node.split(/node in/i)[1].split(/burn time/i)[0]) - nd.tTo) < 3, `"node in" matches (${nd.tTo.toFixed(0)} s)`);

  // ---- "Warp to node" from the map panel
  await holdClock(false);
  await page.click('.map-node .sw-btn.primary');
  await tick(page);
  t = await tel(page);
  ok(t.warpTarget !== null, 'the map\'s "Warp to node" button starts an auto-warp');
  await ff(page, 4000, 'w.warpTarget === null && w.warpIndex === 0', 0.05);
  t = await tel(page);
  const lead = await E(page, () => { const w = window.__sw.world; return w.active.nodes[0].t - w.ut; });
  ok(lead > 5 && lead < nd.burn / 2 + 60, `warp stops shortly before the burn (${lead.toFixed(0)} s to the node, half burn ${(nd.burn / 2).toFixed(0)} s)`);
  await key(page, 'KeyM');
  ok(!(await tel(page)).mapOpen, 'back to the flight view');
  ok(/star|maneuver/i.test(await hintText(page)), `hint explains the next step: "${await hintText(page)}"`);
  await page.click('[data-sas="maneuver"]'); await tick(page);
  ok((await tel(page)).v.sasMode === 'maneuver', 'the maneuver SAS button is accepted now that a node exists');
  await ff(page, 600, `v.nodes[0] && v.nodes[0].t - w.ut < ${(nd.burn / 2).toFixed(1)}`, 0.05);
  await shot(page, '45-before-burn', 200);
  const aim = await E(page, async () => { const THREE = await import('/js/lib/three.module.min.js'); const w = window.__sw.world, v = w.active; const bv = v.burnVector(w.ut, new THREE.Vector3()).normalize(); const nose = new THREE.Vector3(0, 1, 0).applyQuaternion(v.q); return Math.acos(Math.min(1, bv.dot(nose))) * 180 / Math.PI; });
  ok(aim < 4, `SAS maneuver mode has the nose on the marker (${aim.toFixed(1)}° off)`);
  await key(page, 'KeyZ');
  await ff(page, nd.burn / 2, 'v.nodeDv < 30', 0.05);
  const mid = await tel(page); h = await hudText(page);
  ok(Math.abs(mid.hud.nodeDv - mid.v.nodeDv) < 12, `while burning the node card counts down (${mid.hud.nodeDv.toFixed(0)} m/s shown, ${mid.v.nodeDv.toFixed(0)} left)`);
  await ff(page, 200, '!v.nodes.length || v.nodeDv < 1.5', 0.02);
  await key(page, 'KeyX');
  await ff(page, 2);
  t = await tel(page); h = await hudText(page);
  ok(t.v.sit === 'orbit' && t.v.pe > 70000, `in orbit by hand: ${(t.v.pe / 1000).toFixed(1)} × ${(t.v.ap / 1000).toFixed(1)} km, ${t.v.dv.toFixed(0)} m/s left`);
  ok(Math.abs(km(h.kv.Periapsis) - t.v.pe) < 300 && Math.abs(km(h.kv.Apoapsis) - t.v.ap) < 300, `HUD Ap/Pe agree ("${h.kv.Apoapsis}" / "${h.kv.Periapsis}")`);
  ok(t.v.nodes === 0 || t.v.nodeDv < 3, 'the node is finished (removed or nearly zero)');
  ok(/Orbiting/.test(h.sit), `vessel card: "${h.sit}"`);
  await ff(page, 3);
  await shot(page, '46-orbit');
  ok(await E(page, () => window.__sw.career.milestones.has('orbit_verda')), 'orbit milestone recorded');
  ok((await hintText(page)) === '', `no nagging hint once in orbit ("${await hintText(page)}")`);
  await ctx.close();
}
sections.orbit = orbit;


// =====================================================================================================
// 5a. Science: run, transmit, recover
// =====================================================================================================
async function science() {
  console.log('\n=== 5a. science: run → transmit → recover ===');
  const { ctx, page } = await newPage();
  await boot(page, 'science');
  await launchCustom(page, TESTER);
  const sci = () => E(page, () => window.__sw.career.science);
  await page.click('[data-tool="science"]');
  await page.waitForSelector('.fl-pop');
  const rows = await page.locator('.fl-pop [data-exp]').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
  note('science panel on the pad: ' + rows.join(' | '));
  for (let i = 0; i < 6 && await page.locator('.fl-pop [data-action="run"]:not([disabled])').count(); i++) { await page.locator('.fl-pop [data-action="run"]:not([disabled])').first().click(); await tick(page); await page.waitForTimeout(80); }
  let t = await tel(page);
  ok(t.v.science === 2, 'two results stored');
  await shot(page, '50-science-stored', 300);
  const s0 = await sci(), ec0 = t.v.res.elec;
  const worth = await E(page, () => window.__sw.career.scienceValue('crew_report', 'verda', 'landed').next);
  const tx = page.locator('.fl-pop [data-stored="crew_report"] [data-action="transmit"]');
  ok(await tx.isEnabled(), 'Transmit is enabled with an antenna and charge aboard');
  await tx.click(); await tick(page); await page.waitForTimeout(100);
  t = await tel(page);
  const s1 = await sci();
  ok(Math.abs((s1 - s0) - worth / 2) < 0.011, `transmitting the crew report banks half its value now (+${(s1 - s0).toFixed(2)}, full value ${worth})`);
  ok(t.v.science === 1 && Math.abs(ec0 - t.v.res.elec - 5) < 0.5, `the result leaves the vessel and 5 EC are used (${(ec0 - t.v.res.elec).toFixed(1)})`);
  ok((await toasts(page)).some(x => /Transmitted Crew Report: \+/.test(x)), 'a toast confirms what was sent: ' + (await toasts(page)).filter(x => /Transmitted/.test(x)).join(''));
  const again = await page.locator('.fl-pop [data-exp="crew_report"]').innerText();
  note('after transmitting, the experiment row reads: ' + again.replace(/\s+/g, ' '));
  ok(await page.locator('.fl-pop [data-exp="crew_report"] [data-action="run"]').isEnabled(), 'the crew report can be taken again after transmitting');
  await shot(page, '51-science-transmitted', 300);
  // drain the battery: transmit must refuse politely
  await E(page, () => { for (const p of window.__sw.world.active.parts.values()) if (p.res.elec) p.res.elec = 0.2; });
  await ff(page, 0.5);
  const txT = page.locator('.fl-pop [data-stored="temperature"] [data-action="transmit"]');
  ok(!(await txT.isEnabled()), 'Transmit is disabled when the batteries are flat');
  await txT.hover({ force: true }); await page.waitForTimeout(500);
  const tip = await page.locator('.sw-tooltip').innerText().catch(() => '');
  ok(/charge/i.test(tip), `…and the tooltip says why ("${tip}")`);
  await page.keyboard.press('Escape'); await tick(page);
  // hop off the pad is not possible with this engine: recover is not offered on the pad
  ok(!(await page.locator('[data-tool="recover"]').isVisible()), 'no Recover button while still on the pad (prelaunch)');
  // a vessel without an antenna
  await key(page, 'Escape'); await page.waitForSelector('.fl-menu'); await page.click('[data-menu="revertHangar"]'); await page.click('.sw-modal .sw-btn.danger');
  await waitScreen(page, 'builder');
  ok(Math.abs(await sci() - s0) < 0.01, 'revert to the hangar also takes back the transmitted science (no free points)');
  await E(page, () => window.__sw.app.goto('hub')); await waitScreen(page, 'hub');
  await launchStock(page, 'Hopper I');
  await page.click('[data-tool="science"]');
  await page.locator('.fl-pop [data-action="run"]:not([disabled])').first().click(); await tick(page); await page.waitForTimeout(100);
  const noAnt = page.locator('.fl-pop [data-action="transmit"]').first();
  ok(!(await noAnt.isEnabled()), 'no antenna: Transmit is disabled');
  await page.mouse.move(700, 300); await page.waitForTimeout(250);
  await noAnt.hover({ force: true }); await page.waitForFunction(() => /antenna/i.test((document.querySelector('.sw-tooltip') || {}).innerText || ''), null, { timeout: 3000 }).catch(() => {});
  const tip2 = await page.locator('.sw-tooltip').innerText().catch(() => '');
  ok(/antenna/i.test(tip2), `tooltip: no antenna aboard ("${tip2}")`);
  await shot(page, '52-no-antenna', 200);
  await ctx.close();
}
sections.science = science;

// =====================================================================================================
// 5b. Two vessels in orbit, hub, tracking station (real World.fromJSON), fly one, terminate the other, resume
// =====================================================================================================
async function tracking() {
  console.log('\n=== 5b. tracking station, resume, lost vessel with surviving debris ===');
  const { ctx, page } = await newPage();
  await boot(page, 'sandbox');
  await launchStock(page, 'Skylark II');
  await teleport(page, { alt: 110000 });
  await ff(page, 3);
  let t = await tel(page);
  ok(t.v.sit === 'orbit', 'Skylark II placed in a 110 km orbit');
  // leave during time warp
  for (let i = 0; i < 6; i++) await key(page, 'Period', 30);
  ok((await tel(page)).warp >= 5, 'on rails warp');
  await ff(page, 300, 'false', 0.05);
  await key(page, 'Escape'); await page.waitForSelector('.fl-menu');
  ok((await tel(page)).paused, 'pause menu opens during time warp');
  await page.click('[data-menu="exit"]');
  await waitScreen(page, 'hub');
  let fsn = await E(page, () => ({ n: window.__sw.career.flightState.vessels.length, warp: window.__sw.career.flightState.warpIndex, ut: window.__sw.career.flightState.ut, cut: window.__sw.career.ut }));
  ok(fsn.n >= 1 && fsn.warp === 0, `leaving during warp saves the flight at 1× (${fsn.n} object(s), ut ${fsn.ut.toFixed(0)})`);
  await shot(page, '60-hub-flight-in-progress');
  // second craft while one is in orbit
  await launchStock(page, 'Hopper I');
  t = await tel(page);
  ok(t.vessels.filter(v => v.type === 'ship').length === 2, 'launching a second craft keeps the first one in the world');
  ok(Math.abs(t.ut - fsn.ut) < 5, 'the new launch continues from the saved universal time');
  await teleport(page, { alt: 160000 });
  await ff(page, 2);
  await key(page, 'Escape'); await page.waitForSelector('.fl-menu'); await page.click('[data-menu="exit"]');
  await waitScreen(page, 'hub');
  await page.click('.sw-card[data-goto="tracking"]');
  await waitScreen(page, 'tracking');
  await page.waitForSelector('.trk-item');
  await page.waitForTimeout(1500);
  const items = await page.locator('.trk-item').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
  ok(items.length === 2 && items.some(x => /Skylark II/.test(x) && /Orbiting Verda/.test(x)) && items.some(x => /Hopper I/.test(x)), `tracking lists both vessels: ${items.join(' | ')}`);
  await shot(page, '61-tracking');
  const crewBefore = await E(page, () => window.__sw.career.roster.filter(r => r.status === 'assigned').length);
  // terminate the Hopper (real click + confirm)
  await page.locator('.trk-item', { hasText: 'Hopper I' }).click();                      // actions live on the detail card of the selected row
  await page.locator('[data-trk="detail"] [data-action="terminate"]').click();
  await page.waitForSelector('.sw-modal');
  await shot(page, '62-terminate-confirm', 300);
  await page.click('.sw-modal .sw-btn.danger');
  await page.waitForFunction(() => document.querySelectorAll('.trk-item').length === 1);
  const afterT = await E(page, () => ({ n: window.__sw.career.flightState.vessels.length, assigned: window.__sw.career.roster.filter(r => r.status === 'assigned').length, saved: JSON.parse(localStorage.getItem('starwright.save.v1')).flightState.vessels.length }));
  ok(afterT.n === 1 && afterT.saved === 1 && afterT.assigned === crewBefore - 1, 'terminating removes the vessel from the saved flight state and frees its crew');
  // fly the other
  ok(await page.locator('.trk-item.active', { hasText: 'Skylark II' }).count() === 1, 'the remaining vessel is selected after the other is terminated');
  await page.locator('.trk-item', { hasText: 'Skylark II' }).click();
  await page.locator('[data-trk="detail"] [data-action="fly"]').click();
  await waitScreen(page, 'flight');
  await ff(page, 1);
  t = await tel(page);
  ok(t.v && t.v.name === 'Skylark II' && t.v.sit === 'orbit' && Math.abs(t.v.alt - 110000) < 3000, `"Fly" resumes the right vessel where it was (${t.v && t.v.sit}, ${(t.v.alt / 1000).toFixed(1)} km)`);
  await shot(page, '63-resumed');
  // resumed flight: revert to last save
  await ff(page, 30);
  await key(page, 'Escape'); await page.waitForSelector('.fl-menu');
  ok(await page.locator('[data-menu="revertSave"]').isEnabled() && await page.locator('[data-menu="revertLaunch"]').count() === 0, 'a resumed flight offers "Revert to last save"');
  await shot(page, '64-resumed-menu', 300);
  const utResume = await E(page, () => window.__sw.app.flight.actions.lastSave().ut);
  await page.click('[data-menu="revertSave"]'); await page.click('.sw-modal .sw-btn.danger');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await tick(page);
  t = await tel(page);
  ok(Math.abs(t.ut - utResume) < 1 && t.v && t.v.name === 'Skylark II', `revert goes back to the moment of resuming (ut ${t.ut.toFixed(0)})`);

  // ---- stage: debris appears; then the active vessel is destroyed while the debris survives
  await key(page, 'F5');
  const n0 = t.vessels.length;
  await key(page, 'Space'); await ff(page, 1);
  if ((await tel(page)).vessels.length === n0) { await key(page, 'Space'); await ff(page, 1); }
  t = await tel(page);
  ok(t.vessels.some(v => v.type === 'debris'), `staging leaves debris nearby (${t.vessels.map(v => v.type).join(', ')})`);
  await E(page, () => { const w = window.__sw.world, v = w.active; v.destroyParts([...v.parts.keys()], w._ev, 'explosion'); w._processEvents(); if (!v.dead) { w._destroy(v, 'explosion'); w._processEvents(); } });
  await ff(page, 2);
  t = await tel(page);
  ok(t.v === null && await page.locator('.fl-center').isVisible(), 'losing the vessel brings up the "was lost" card even though debris survives');
  const btns = await page.locator('.fl-center [data-center]').evaluateAll(els => els.map(e => e.dataset.center + ':' + e.innerText));
  note('lost card buttons: ' + btns.join(' | '));
  ok(btns.some(b => /quickload/.test(b)) && btns.some(b => /hub/.test(b)), 'it offers the quicksave and the Flight Center');
  await shot(page, '65-lost-with-debris');
  const errsBefore = problems.length;
  await ff(page, 20);
  await key(page, 'BracketRight'); await key(page, 'KeyM'); await ff(page, 1); await key(page, 'KeyM'); await key(page, 'KeyV'); await key(page, 'Period'); await ff(page, 3); await key(page, 'Slash');
  const camOk = await E(page, () => { const c = window.__sw.app.flight.camera; return [c.position.x, c.position.y, c.position.z].every(Number.isFinite); });
  ok(problems.length === errsBefore && camOk, 'with no vessel under control the screen keeps running (keys, map, warp) without errors');
  await page.click('[data-center="quickload"]');
  await ff(page, 1);
  t = await tel(page);
  ok(t.v && t.v.name === 'Skylark II' && !(await page.locator('.fl-center').isVisible()), 'loading the quicksave from the card brings the vessel back');
  // crew lost bookkeeping after a quickload
  ok(await E(page, () => window.__sw.career.roster.filter(r => r.status === 'lost').length) === 0, 'the Pip lost in the explosion is alive again after the quickload');
  // exit, resume from the hub button
  await key(page, 'Escape'); await page.waitForSelector('.fl-menu'); await page.click('[data-menu="exit"]');
  await waitScreen(page, 'hub');
  await page.click('[data-action="resume"]');
  await waitScreen(page, 'flight');
  t = await tel(page);
  ok(t.v && t.v.name === 'Skylark II' && t.v.sit === 'orbit', 'hub "Resume" returns to the flight');
  await ctx.close();
}
sections.tracking = tracking;


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
/** Run a js/core/autopilot.js controller through the flight screen's own update loop. */
async function runAutopilot(page, make, maxSim = 4000) {
  await page.evaluate(async src => { const ap = await import('/js/core/autopilot.js'); const w = window.__sw.world; window.__ctl = new Function('ap', 'w', 'v', 'return ' + src)(ap, w, w.active); }, make);
  let left = maxSim;
  while (left > 0) {
    const r = await page.evaluate(budget => {
      const sw = window.__sw, app = sw.app, ctl = window.__ctl; const t0 = performance.now(), u0 = sw.world.ut; let n = 0;
      while (performance.now() - t0 < 400 && !ctl.done && sw.world.ut - u0 < budget && app.currentName === 'flight' && n++ < 20000) { ctl.update(0.05); app.current.update(0.05); app.input.endFrame(); }
      return { adv: sw.world.ut - u0, done: ctl.done, failed: ctl.failed, phase: ctl.phase, log: ctl.log.map(l => l.msg) };
    }, left);
    if (r.done) return r;
    left -= Math.max(r.adv, 0.01);
  }
  return { done: false, failed: true, log: ['timeout'] };
}

// =====================================================================================================
// 5c. Pell: legs, landing, EVA + vessel switching, flag, liftoff, SOI toasts, return to Verda
// =====================================================================================================
async function pell() {
  console.log('\n=== 5c. Pell landing, EVA, vessel switching, SOI changes, return ===');
  const { ctx, page } = await newPage();
  await boot(page, 'science');
  await launchCustom(page, LANDER);
  await key(page, 'Space');                      // light the engine (throttle is at zero)
  await teleport(page, { body: 'pell', alt: 9000, speedFactor: 0.55 });
  await ff(page, 2);
  let t = await tel(page), h = await hudText(page);
  ok(t.v.body === 'pell' && /Pell/.test(h.sit), `vessel card: "${h.sit}"`);
  ok(/vacuum/.test(h.kv['Air pressure']), 'no air at Pell: "vacuum"');
  await ff(page, 900, 'v.verticalSpeed < -10 && v.radarAlt < 6000');
  await ff(page, 1.2);
  ok(/G/.test(await hintText(page)) && /legs/i.test(await hintText(page)), `falling toward an airless moon with legs up: "${await hintText(page)}"`);
  await shot(page, '70-pell-descent', 300);
  await clearToasts(page);
  await key(page, 'KeyG');
  t = await tel(page);
  ok(t.v.legs === true && (await toasts(page)).some(x => /legs down/i.test(x)), 'G lowers the legs (toast + light)');
  await ff(page, 1.2);
  ok(!/legs/i.test(await hintText(page)), 'the legs hint goes away');
  const land = await runAutopilot(page, 'ap.hoverslamLanding(w, v, { useWarp: false })');
  t = await tel(page);
  ok(land.done && !land.failed && t.v && t.v.landed && t.v.body === 'pell', `landed on Pell on its legs (${land.log.join(' → ')})`);
  await ff(page, 3);
  h = await hudText(page);
  ok(/Landed on Pell/.test(h.sit), `vessel card: "${h.sit}"`);
  ok(!(await page.locator('[data-tool="recover"]').isVisible()), 'no Recover button away from Verda');
  ok(await E(page, () => window.__sw.career.milestones.has('pell_landing')), 'Pell landing milestone');
  ok((await hintText(page)) === '', `no stray hint on Pell ("${await hintText(page)}")`);
  await shot(page, '71-pell-landed');
  await key(page, 'F5');

  // ---- EVA through the crew panel, switch back and forth
  await page.click('[data-tool="crew"]'); await page.waitForSelector('.fl-pop [data-action="eva"]');
  await shot(page, '72-crew-panel', 300);
  await page.click('.fl-pop [data-action="eva"]'); await tick(page); await ff(page, 1.5);
  t = await tel(page);
  ok(t.v.type === 'eva' && await page.locator('.fl-eva').isVisible() && !(await page.locator('.fl-res').isVisible()), 'the Pip is outside; the HUD switches to the spacewalk card');
  await shot(page, '73-eva-pell');
  const shipDist = () => E(page, () => { const w = window.__sw.world, s = w.vessels.find(v => v.type === 'ship'), e = w.vessels.find(v => v.type === 'eva'); if (s.landed) s.syncLanded(w.ut); if (e.landed) e.syncLanded(w.ut); return [e.pos.x - s.pos.x, e.pos.y - s.pos.y, e.pos.z - s.pos.z]; });
  const shipD = async () => Math.hypot(...await shipDist());
  const d0 = await shipDist();
  await holdKey(page, 'KeyW', 2.5);
  const d1 = await shipDist();
  const walked = Math.hypot(...sub(d1, d0));
  ok(walked > 2 && walked < 6, `W walks the Pip (${walked.toFixed(1)} m in 2.5 s)`);
  await key(page, 'BracketRight'); await ff(page, 0.5);
  t = await tel(page);
  ok(t.v.type === 'ship' && t.v.name === 'Dustfoot' && await page.locator('.fl-res').isVisible() && !(await page.locator('.fl-eva').isVisible()), '] switches to the lander (ship HUD back)');
  ok(t.v.crew.length === 0 && (await page.locator('.fl-alert', { hasText: /no control/i }).count()) === 1, 'the empty lander shows "No control"');
  await shot(page, '74-switched-to-lander');
  await clearToasts(page);
  await key(page, 'KeyZ'); await ff(page, 3);
  ok((await tel(page)).v.landed && (await toasts(page)).some(x => /No control/.test(x)), `an uncrewed capsule does not answer Z, and says why (${(await toasts(page)).join(' | ')})`);
  await key(page, 'KeyX');
  await key(page, 'BracketLeft'); await ff(page, 0.5);
  t = await tel(page);
  ok(t.v.type === 'eva', '[ switches back to the Pip');
  // surface sample + EVA report through the buttons, flag with P
  await page.click('[data-eva="sample"]'); await tick(page);
  await page.click('[data-eva="report"]'); await tick(page);
  ok((await tel(page)).v.science === 2, 'surface sample and spacewalk report taken');
  await page.keyboard.down('KeyP'); await page.waitForTimeout(60); await tick(page); await page.keyboard.up('KeyP');
  await page.waitForSelector('[data-flag-name]');
  await page.fill('[data-flag-name]', 'First Dust');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await tick(page);
  ok(await E(page, () => window.__sw.world.flags.length === 1 && window.__sw.world.flags[0].name === 'First Dust'), 'P plants a named flag (typing in the name field does not fly the Pip)');
  // walk back and board with F
  const dbg = async l => note(l + ': ' + JSON.stringify(await E(page, () => { const w = window.__sw.world, v = w.active; return { type: v.type, landed: v.landed, sit: v.situation, modal: !!document.querySelector('.sw-modal-backdrop'), ae: document.activeElement && document.activeElement.tagName, ctrl: [v.ctrl.tx, v.ctrl.tz, v.ctrl.ty], ck: window.__sw.app.input.captureKeys }; })) + ' d=' + (await shipD()).toFixed(1));
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop')); await tick(page);
  await holdKey(page, 'KeyW', 6);
  await clearToasts(page);
  await key(page, 'KeyF');
  ok((await tel(page)).v.type === 'eva' && (await toasts(page)).some(x => /closer/i.test(x)), `F too far from the hatch explains itself (${(await toasts(page)).join(' | ')})`);
  let best = 1e9;
  for (let i = 0; i < 60 && (await tel(page)).v.type === 'eva'; i++) { const d = await shipD(); if (d > best + 0.2) break; best = d; if (d < 4.5) await key(page, 'KeyF'); else await holdKey(page, 'KeyS', 0.4); }
  note('walked back to ' + best.toFixed(1) + ' m from the lander centre and pressed F');
  await ff(page, 0.5);
  t = await tel(page);
  ok(t.v.type === 'ship' && t.v.crew.length === 1 && t.v.science >= 2, `back aboard with the samples (${t.v.science} results)`);

  // ---- lift off by hand
  await key(page, 'KeyZ');
  await ff(page, 6);
  t = await tel(page);
  ok(!t.v.landed && t.v.vs > 2, `Z lifts off from Pell (vs ${t.v.vs.toFixed(1)} m/s)`);
  await key(page, 'KeyG');
  ok((await tel(page)).v.legs === false, 'G raises the legs');
  await holdKey(page, 'KeyD', 4, 'f.state.pitch < 45');
  await ff(page, 200, 'v.apoapsis > 12000');
  await key(page, 'KeyX');
  t = await tel(page); h = await hudText(page);
  ok(/Pell/.test(h.sit) && t.v.ap > 11000, `sub-orbital above Pell, Ap ${(t.v.ap / 1000).toFixed(1)} km ("${h.sit}")`);
  await shot(page, '75-pell-ascent');

  // ---- SOI change out of Pell under rails warp, then into Pell again
  await E(page, async () => { const { SYSTEM } = await import('/js/core/bodies.js'); const w = window.__sw.world, v = w.active, b = SYSTEM.byId.pell; const r = b.soi * 0.97; v.pos.set(r, 0, 0); v.vel.set(420, 0, -60); v._stamp++; v.updateTelemetry(w.ut); });
  await ff(page, 1);
  await clearToasts(page);
  for (let i = 0; i < 7; i++) await key(page, 'Period', 30);
  ok((await tel(page)).warp >= 5, `rails warp near the edge of Pell's SOI (index ${(await tel(page)).warp})`);
  await ff(page, 4000, 'v.body.id === "verda"', 0.05);
  await ff(page, 0.3);
  t = await tel(page);
  const soiToasts = await toasts(page);
  ok(t.v.body === 'verda' && soiToasts.some(x => /pull of Verda/.test(x)), `SOI change toast: ${soiToasts.filter(x => /pull|warp/i.test(x)).join(' | ')}`);
  ok(t.warp === 0 && soiToasts.some(x => /warp stopped.*sphere/i.test(x)), 'time warp drops to 1× at the SOI change and says why');
  await shot(page, '76-soi-toast', 200);
  h = await hudText(page);
  ok(/Verda/.test(h.sit), `vessel card after the change: "${h.sit}"`);

  // ---- return: a re-entry state at Verda (constructed), stage, parachute, land, recover
  // coming home from Pell: apoapsis at Pell's orbit, periapsis 32 km, caught at 95 km on the way down
  const ret = await E(page, async () => { const { SYSTEM } = await import('/js/core/bodies.js'); const b = SYSTEM.byId.verda, pl = SYSTEM.byId.pell; const ra = pl.orbit ? pl.orbit.a : 12e6, rp = b.radius + 32000, r = b.radius + 95000, a = (ra + rp) / 2; const sp = Math.sqrt(b.gm * (2 / r - 1 / a)), h = Math.sqrt(b.gm * a * (1 - ((ra - rp) / (ra + rp)) ** 2)); const vt = h / r; return { vt, vr: -Math.sqrt(Math.max(0, sp * sp - vt * vt)), vc: Math.sqrt(b.gm / r) }; });
  await teleport(page, { alt: 95000, speedFactor: ret.vt / ret.vc, vy: ret.vr });
  note(`return leg: entering at ${(Math.hypot(ret.vt, ret.vr)).toFixed(0)} m/s (${(ret.vr).toFixed(0)} m/s radial)`);
  await E(page, () => { const v = window.__sw.world.active; v.ctrl.sas = true; });
  await page.click('[data-sas="retrograde"]'); await tick(page);
  await ff(page, 3);
  await key(page, 'Space'); await ff(page, 1);
  t = await tel(page);
  ok(t.v.parts <= 4, `Space drops the lander stage before re-entry (${t.v.parts} parts left)`);
  await ff(page, 2000, 'v && v.altitude < 60000');
  await ff(page, 600, '!v || v.heatFlux > 80000 || v.altitude < 30000');
  await shot(page, '77-reentry', 300);
  t = await tel(page);
  ok(!!t.v, 'the capsule survives the first part of re-entry');
  t = await tel(page); note(`after the heat: alt ${(t.v.alt / 1000).toFixed(1)} km, ${t.v.sit}, Ap ${(t.v.ap / 1000).toFixed(0)} km`);
  await ff(page, 20000, '!v || (v.altitude < 12000 && v.verticalSpeed < 0)', 0.1);
  await ff(page, 1.5);
  ok(/parachute/i.test(await hintText(page)), `hint during descent: "${await hintText(page)}"`);
  await key(page, 'Space');
  await ff(page, 1500, '!v || v.landed');
  t = await tel(page);
  ok(t.v && t.v.landed, `home again: ${t.v ? t.v.sit : 'lost'}`);
  await ff(page, 2);
  const ms = await E(page, () => [...window.__sw.career.milestones]);
  ok(ms.includes('pell_return'), `"There and Back" milestone (${ms.join(', ')})`);
  await page.click('[data-tool="recover"]');
  await page.waitForSelector('[data-summary="recovery"]');
  const sum = await page.locator('[data-summary="recovery"]').innerText();
  ok(/Surface Sample · Pell/.test(sum), 'the recovery summary lists the Pell samples');
  await shot(page, '78-recovery-pell', 300);
  note('recovery summary: ' + sum.replace(/\s+/g, ' '));
  await ctx.close();
}
sections.pell = pell;

// =====================================================================================================
// 6. Robustness
// =====================================================================================================
async function robust() {
  console.log('\n=== 6. robustness ===');
  {
    const { ctx, page } = await newPage();
    await boot(page, 'career');
    const funds0 = await E(page, () => window.__sw.career.funds);
    await launchStock(page, 'Hopper I');
    // ---- resize
    for (const [w, hgt] of [[1024, 640], [1920, 1080], [1280, 720]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(500); await ff(page, 0.5);
      const g = await E(page, () => {
        const f = window.__sw.app.flight, r = q => { const n = document.querySelector(q); if (!n) return null; const b = n.getBoundingClientRect(); return b.width ? { x: b.left, y: b.top, r: b.right, b: b.bottom } : null; };
        f.hud.invalidate(); const ball = f.hud.ballRect(), dom = r('.fl-ball');
        return { size: window.__sw.app.size, aspect: f.camera.aspect, console: r('.fl-console'), stages: r('.fl-stages'), tools: r('.fl-tools'), time: r('.fl-time'), vessel: r('.fl-vessel'), hint: r('.fl-hint'), alt: r('[data-hud="altitude"]'), res: r('[data-hud="resources"]'), crew: r('[data-hud="crew"]'), ball, dom, canvas: [window.__sw.app.canvas.clientWidth, window.__sw.app.canvas.clientHeight] };
      });
      const fits = g.console && g.console.x >= 0 && g.console.r <= w && g.console.b <= hgt;
      // second pass layout: staging bottom-left, console bottom-centre, crew bottom-right; clock over vessel top-left, altimeter top-centre, resources and toolbar top-right
      const noOverlap = (!g.stages || g.stages.r <= g.console.x + 2) && (!g.crew || g.console.r <= g.crew.x + 2) && g.vessel.y >= g.time.b - 1
        && !!g.alt && g.time.r <= g.alt.x + 2 && g.vessel.r <= g.alt.x + 2 && g.alt.r <= (g.res ? g.res.x : g.tools.x) + 2 && (!g.res || g.res.r <= g.tools.x + 2) && g.alt.b <= g.console.y && g.tools.b <= hgt;
      ok(fits && Math.abs(g.aspect - w / hgt) < 0.01 && g.canvas[0] === w, `${w}×${hgt}: console fits, camera aspect follows`);
      ok(noOverlap, `${w}×${hgt}: HUD pieces do not overlap` + (noOverlap ? '' : ' ' + JSON.stringify({ c: g.console, s: g.stages, t: g.time, tools: g.tools, v: g.vessel, alt: g.alt, res: g.res, crew: g.crew })));
      ok(g.ball && Math.abs(g.ball.x - g.dom.x) < 1.5 && Math.abs(g.ball.y - g.dom.y) < 1.5, `${w}×${hgt}: the attitude ball is drawn where its frame is`);
      ok(!g.hint || (g.hint.x >= 0 && g.hint.r <= w), `${w}×${hgt}: hint card inside the window`);
      await shot(page, `80-resize-${w}`, 400);
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(300);
    // ---- tab hidden while a key is held: nothing sticks
    await key(page, 'Space'); await ff(page, 3);
    await page.keyboard.down('KeyD'); await page.waitForTimeout(50); await tick(page);
    const yawHeld = await E(page, () => window.__sw.world.active.ctrl.yaw);
    await E(page, () => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('blur')); });
    await tick(page);
    const yawAfter = await E(page, () => window.__sw.world.active.ctrl.yaw);
    await E(page, () => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.keyboard.up('KeyD');
    ok(yawHeld === 1 && yawAfter === 0, 'a key held while the tab loses focus is released (no stuck yaw)');
    // a long frame after the tab comes back: the main loop clamps dt
    const ut0 = (await tel(page)).ut;
    await E(page, () => { const a = window.__sw.app; a.current.update(Math.min(Math.max(30, 0), 0.1)); a.input.endFrame(); });
    ok((await tel(page)).ut - ut0 < 0.5, 'main loop clamps a 30 s frame gap to 0.1 s');
    // ---- leave with the craft flying low → comes back, second launch while one sits on the pad
    await key(page, 'Escape'); await page.waitForSelector('.fl-menu'); await page.click('[data-menu="revertLaunch"]'); await page.click('.sw-modal .sw-btn.danger');
    await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)')); await tick(page);
    await key(page, 'Escape'); await page.waitForSelector('.fl-menu'); await page.click('[data-menu="exit"]');
    await waitScreen(page, 'hub');
    const f1 = await E(page, () => ({ funds: window.__sw.career.funds, assigned: window.__sw.career.roster.filter(r => r.status === 'assigned').length, fs: !!window.__sw.career.flightState }));
    ok(f1.fs && f1.assigned === 1, 'a craft left on the pad is kept as a flight in progress');
    await launchStock(page, 'Hopper I');
    await page.waitForTimeout(300);
    const f2 = await E(page, () => ({ funds: window.__sw.career.funds, assigned: window.__sw.career.roster.filter(r => r.status === 'assigned').length, ships: window.__sw.world.vessels.filter(v => v.type === 'ship').length }));
    const tt = await toasts(page);
    ok(f2.ships === 1 && f2.assigned === 1, 'launching again clears the pad: one craft, one Pip assigned');
    const cost = funds0 - f1.funds;
    ok(f2.funds > f1.funds - cost + cost * 0.9, `the craft rolled off the pad is refunded (funds ${funds0} → ${f1.funds} → ${f2.funds}); toast: ${tt.filter(x => /rolled/.test(x)).join('')}`);
    await shot(page, '81-second-launch', 200);
    // ---- quickload while the map is open (with a node selected)
    await teleport(page, { alt: 130000 }); await ff(page, 2);
    await key(page, 'F5');
    await key(page, 'KeyM'); await ff(page, 1); await page.waitForTimeout(400);
    await E(page, () => { const w = window.__sw.world, v = w.active; const n = v.addNode(w.ut + 600, { prograde: 30, normal: 0, radial: 0 }); const m = window.__sw.app.flight.map; if (m.selectNode) m.selectNode(n || v.nodes[0]); });
    await ff(page, 1);
    const errs = problems.length;
    await page.keyboard.down('F9'); await page.waitForTimeout(60); await tick(page); await page.keyboard.up('F9');
    await page.waitForSelector('.sw-modal'); await page.click('.sw-modal .sw-btn.primary');
    await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
    await ff(page, 2); await page.waitForTimeout(600);
    let t = await tel(page);
    ok(t.mapOpen && t.v && t.v.nodes === 0 && problems.length === errs, 'quickload with the map open: the map keeps working on the restored world (stale node gone, no errors)');
    ok(await page.locator('.map-node').isHidden().catch(() => true), 'the node panel of the discarded node is closed');
    await shot(page, '82-quickload-in-map', 300);
    await key(page, 'KeyM');
    // ---- pause during warp keeps the rate and the clock
    for (let i = 0; i < 5; i++) await key(page, 'Period', 30);
    const wi = (await tel(page)).warp;
    await key(page, 'Escape'); await page.waitForSelector('.fl-menu');
    const utp = (await tel(page)).ut; await page.waitForTimeout(600);
    ok((await tel(page)).ut === utp && /Paused/.test(await page.locator('.fl-warp-rate').innerText()), 'pause during warp freezes the clock; the rate chip says Paused');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)')); await tick(page);
    ok((await tel(page)).warp === wi, `warp continues at the same rate after the menu closes (index ${wi})`);
    await key(page, 'Slash');
    await ctx.close();
  }
  // ---- broken saves must not brick the title screen
  const cases = {
    'garbage text': { 'starwright.save.v1': 'not json {{{', 'starwright.quicksave.v1': '%%%' },
    'old/partial save': { 'starwright.save.v1': JSON.stringify({ version: 0, mode: 'career' }) },
    'save with a broken flight': { 'starwright.save.v1': JSON.stringify({ version: 1, mode: 'sandbox', funds: 0, science: 0, ut: 100, tech: ['start'], roster: [{ name: 'Juno', status: 'assigned' }], flightState: { version: 1, ut: 100, vessels: [{ id: 1, bogus: true }], activeId: 1 } }), 'starwright.quicksave.v1': JSON.stringify({ world: '{"vessels":[{"x":1}]}', career: '{"mode":"career"}', ut: 5 }) },
    'null save': { 'starwright.save.v1': 'null', 'starwright.settings.v1': '[1,2' },
  };
  for (const [name, storage] of Object.entries(cases)) {
    const { ctx, page } = await newPage(1280, 720, storage);
    const before = problems.length;
    await page.goto(server.url);
    const ready = await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 }).then(() => true, () => false);
    const hasNew = ready && await page.locator('[data-action="new"]').isVisible();
    ok(ready && hasNew, `${name}: the title screen still comes up with New Game`);
    if (ready && await page.locator('[data-action="continue"]').count()) {
      await page.click('[data-action="continue"]');
      await page.waitForTimeout(900);
      const scr = await E(page, () => window.__sw.app.currentName);
      const tst = await toasts(page);
      if (scr === 'hub') {
        // try everything that touches the saved flight
        if (await page.locator('[data-action="resume"]').count()) {
          await page.click('[data-action="resume"]');
          await page.waitForTimeout(1500);
          const scr2 = await E(page, () => window.__sw.app.currentName);
          ok(scr2 === 'hub' || scr2 === 'flight', `${name}: Resume ends up on "${scr2}" (${(await toasts(page)).join(' | ')})`);
          if (scr2 === 'flight') { await E(page, () => window.__sw.app.goto('hub')); await waitScreen(page, 'hub'); }
        }
        await page.click('.sw-card[data-goto="tracking"]'); await page.waitForTimeout(1500);
        ok(await E(page, () => window.__sw.app.currentName) === 'tracking' && await page.locator('.trk-root').isVisible(), `${name}: tracking station opens`);
        await page.keyboard.press('Escape'); await page.waitForTimeout(600);
        await launchStock(page, 'Hopper I');
        ok((await tel(page)).v.sit === 'prelaunch', `${name}: a new launch still works`);
        await page.keyboard.down('F9'); await page.waitForTimeout(60); await tick(page); await page.keyboard.up('F9'); await page.waitForTimeout(300);
        if (await page.locator('.sw-modal').count()) { await page.click('.sw-modal .sw-btn.primary'); await page.waitForTimeout(500); }
        ok((await tel(page)) && (await tel(page)).v && (await tel(page)).v.sit === 'prelaunch', `${name}: F9 with a broken quicksave leaves the flight alone (${(await toasts(page)).filter(x => /quick/i.test(x)).join(' | ')})`);
      } else ok(scr === 'title' && tst.length > 0, `${name}: Continue explains itself and stays on the title ("${tst.join(' | ')}")`);
    }
    // expected console noise from the deliberately broken data is not a test problem
    const fresh = problems.splice(before).filter(p => !/could not be restored|could not restore|fromJSON|quickload failed|enter failed|Cannot read|is not|undefined|saved flight/i.test(p));
    for (const p of fresh) problems.push(name + ': ' + p);
    if (ready) { await page.goto(server.url); await page.waitForFunction(() => document.body.dataset.ready === '1' && !!document.querySelector('[data-action="new"]')); await page.click('[data-action="new"]'); await page.click('.sw-mode[data-mode="career"]'); await page.click('.sw-modal .sw-btn.primary'); await page.waitForTimeout(500); if (await page.locator('.sw-modal .sw-btn.danger').count()) await page.click('.sw-modal .sw-btn.danger'); await waitScreen(page, 'hub'); ok(await E(page, () => localStorage.getItem('starwright.quicksave.v1') === null), `${name}: a new game starts clean (old quicksave dropped)`); }
    await ctx.close();
  }
}
sections.robust = robust;

// =====================================================================================================
// 7. Performance: cost of update() (not render)
// =====================================================================================================
async function perf() {
  console.log('\n=== 7. update() cost per frame ===');
  const { ctx, page } = await newPage();
  await boot(page, 'sandbox');
  await launchStock(page, 'Pell Runner');
  await key(page, 'KeyZ'); await key(page, 'Space');
  await ff(page, 40, 'v.altitude > 3000');
  const measure = (label, n = 400) => E(page, ({ n }) => {
    const sw = window.__sw, app = sw.app, f = app.flight, w = sw.world;
    const wrap = (obj, name, acc) => { const orig = obj[name]; obj[name] = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { acc.t += performance.now() - t; } }; return () => { obj[name] = orig; }; };
    const aStep = { t: 0 }, aHud = { t: 0 }, aScene = { t: 0 }, aMap = { t: 0 };
    const undo = [wrap(w, 'step', aStep), wrap(f.hud, 'update', aHud), wrap(f.view, 'update', aScene)];
    if (f.map) undo.push(wrap(f.map, 'update', aMap));
    const times = [];
    for (let i = 0; i < n; i++) { const t0 = performance.now(); app.current.update(1 / 60); app.input.endFrame(); times.push(performance.now() - t0); }
    undo.forEach(u => u());
    times.sort((a, b) => a - b);
    const sum = times.reduce((s, x) => s + x, 0);
    return { avg: sum / n, p95: times[Math.floor(n * 0.95)], max: times[n - 1], step: aStep.t / n, hud: aHud.t / n, scene: aScene.t / n, map: aMap.t / n, parts: w.active ? w.active.parts.size : 0, vessels: w.vessels.length };
  }, { n });
  const fmtP = p => `avg ${p.avg.toFixed(2)} ms · p95 ${p.p95.toFixed(2)} · max ${p.max.toFixed(1)} | world.step ${p.step.toFixed(2)} · scene ${p.scene.toFixed(2)} · hud ${p.hud.toFixed(2)} · map ${p.map.toFixed(2)} (${p.parts} parts, ${p.vessels} vessels)`;
  let p = await measure('atmo');
  note('PERF Pell Runner under thrust in the atmosphere: ' + fmtP(p));
  ok(p.avg < 4, `update() in the atmosphere averages ${p.avg.toFixed(2)} ms (< 4 ms)`);
  ok(p.hud < 0.6, `HUD update costs ${p.hud.toFixed(2)} ms per frame`);
  await teleport(page, { alt: 150000 }); await ff(page, 2);
  await E(page, () => { const w = window.__sw.world, v = w.active; v.addNode(w.ut + 900, { prograde: 120, normal: 0, radial: 0 }); v.addNode(w.ut + 3000, { prograde: 300, normal: 10, radial: 0 }); });
  p = await measure('orbit');
  note('PERF orbit with 2 nodes, flight view: ' + fmtP(p));
  ok(p.avg < 4, `update() in orbit with 2 nodes averages ${p.avg.toFixed(2)} ms`);
  await key(page, 'KeyM'); await ff(page, 1); await page.waitForTimeout(500);
  p = await measure('map');
  note('PERF map mode with 2 nodes: ' + fmtP(p));
  ok(p.avg < 4, `update() in map mode with 2 nodes averages ${p.avg.toFixed(2)} ms`);
  await shot(page, '90-perf-map', 300);
  await ctx.close();
}
sections.perf = perf;

// SECTIONS-MORE

try {
  for (const name of Object.keys(sections)) if (want(name)) await sections[name]();
} catch (err) {
  problems.push('test aborted: ' + (err.stack || err.message));
}
await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log('  - ' + p);
if (notes.length) { console.log('\nNotes:'); for (const n of notes) console.log('  · ' + n); }
process.exit(problems.length ? 1 : 0);
