// Ground contact as a player sees it: everything that stands on a surface is measured in the DRAWN scene (the
// triangles of the vessel, of the terrain chunks on screen, of the space centre's slabs), never from the physics.
//   node tests/e2e/contact.mjs [sections]        sections (comma separated, default all):
//     stock    every stock craft on the pad and on the runway, with the terrain workers held and after they deliver
//     soft     the same for two craft on the reduced profile a software rasteriser gets by default
//     lod      terrain level of detail: independent of window size and pixel ratio; every level against the slabs;
//              the space centre from 0 to 60 km up
//     warp     standing on the pad at every warp rate, and a launch flown under 4× physics warp
//     demo     the demo tour's launch chapter (stepped in real time, with its time-lapse, and in fast mode) and the
//              craft the build chapter hands to it
//     runway   an aeroplane from spawn through its take-off roll (the game's own launch and the demo's "plane"
//              chapter), at device pixel ratio 1 and 2: runway drawn under the wheels, clear view from the camera
//     worlds   lander, rover, Pip, flag and debris on every landable body at a level site and on two slopes
//     splash   a capsule in the sea
//     centre   the show rocket and the crawler in the space-centre view
//     builder  the craft on the assembly floor
//     depth    depth-buffer audit of every material in the flight scenes
// Each failing check prints the numbers it saw. Captures: tests/out/contact-*.png.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = (process.argv[2] || process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const want = name => !ONLY.length || ONLY.includes(name);
const CRAFT = (process.env.CRAFT || '').split(',').map(s => s.trim()).filter(Boolean);       // stock: only these designs
const BODIES = (process.env.BODIES || '').split(',').map(s => s.trim()).filter(Boolean);     // worlds: only these bodies

// ---- what "touching" means (metres)
const SINK = 0.03;        // a landed vessel's lowest drawn point may be this far inside the surface drawn under it
const FLOAT = 0.05;       // … or this far above it
const SLAB_CLEAR = 0.008; // drawn terrain must stay this far below every slab of the space centre
const ROLL_FLOAT = 0.12;  // a wheel rolling at speed may be this far above the paving (suspension travel, hop over a painted mark)
const ROLL_SINK = 0.06;   // … or this far inside it: the painted marks stand 3 cm proud of the asphalt (layers need that much apart with a
                          // logarithmic depth buffer) and the vessel is lifted onto the paving under its centre, not under each wheel
const FALLEN_SINK = 0.06; // a craft lying on its side: its hull between two contact rings over a bump of the ground
const CAM_CLEAR = 0.3;    // the camera stays this far above the drawn ground

const problems = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }
const f2 = x => (x == null || !Number.isFinite(x) ? String(x) : x.toFixed(Math.abs(x) < 10 ? 3 : 1));
const cm = x => (x == null || !Number.isFinite(x) ? String(x) : (x * 100).toFixed(1) + ' cm');

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
let page = null, ctx = null;
const E = (fn, arg) => page.evaluate(fn, arg);

async function open(url = '', { width = 960, height = 600, dpr = 1 } = {}) {
  if (ctx) await ctx.close();
  ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
  page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
  // OLD_RUNWAY=1: mutation check. Serves bodies.js with the runway record round 3 found (650 m west of the drawn
  // strip); the runway section must then fail for the demo's aeroplane. Nothing on disk is changed.
  if (process.env.OLD_RUNWAY) await page.route('**/js/core/bodies.js', async route => {
    const src = fs.readFileSync(path.join(ROOT, 'js/core/bodies.js'), 'utf8');
    const out = src.replace("site(-950, -850, { heading: 90, length: 2000, width: 56,", "site(-1500, -850, { heading: 90, length: 1600, width: 60,").replace("runway.start = site(-850, -850,", "runway.start = site(-1500, -850,");
    if (out === src) problems.push('OLD_RUNWAY: the mutation did not apply');
    await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: out });
  });
  await page.goto(server.url + url, { timeout: 240000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app, null, { timeout: 240000 });
  await page.addScriptTag({ path: path.join(HERE, 'contact.page.js') });
  await E(() => window.__ct.init());
}
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 });
  await page.waitForTimeout(300);
}
/** A new sandbox program, standing in the hub. `high`: the full-quality profile a real GPU gets. */
async function boot({ high = true, ...size } = {}) {
  await open('', size);
  await E(() => document.querySelector('[data-action="new"]').click());
  await page.waitForSelector('.sw-mode[data-mode="sandbox"]', { state: 'attached' });
  await E(() => document.querySelector('.sw-mode[data-mode="sandbox"]').click());
  await E(() => document.querySelector('.sw-modal .sw-btn.primary').click());
  await waitScreen('hub');
  await E(high => { const s = window.__sw.app.settings; s.showHints = false; if (high) { s.gfxForce = true; s.gfxQuality = 'high'; } else { s.gfxForce = false; } }, high);
}
const frames = (n = 2) => E(n => new Promise(res => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
/** Run the flight screen's own update for `sim` seconds of game time (or until the expression over w, v, f holds). */
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
/** Let the terrain for this view arrive (workers released; missing chunks are built on the page's own thread). */
async function settle(name = '') {
  await E(() => window.__ct.stall(false));
  for (let i = 0; i < 12; i++) {
    const left = await E(() => {
      const f = window.__sw.app.flight, s = f && f.view, w = s && s.worlds;
      if (!w || !w.info || !s.settleTerrain) return 0;
      s.settleTerrain(2500);
      s.update(window.__sw.world, 1 / 30, 0, f.cam);
      return w.info.pending || 0;
    });
    if (!left) break;
    if (i === 11) console.log('  (terrain still loading' + (name ? ' for ' + name : '') + ': ' + left + ' chunks)');
  }
  await frames(2);
}
const shot = async name => { try { await page.screenshot({ path: path.join(OUT, 'contact-' + name + '.png'), timeout: 120000 }); } catch (e) { console.log('  (no capture ' + name + ': ' + e.message.split('\n')[0] + ')'); } };
const cam = (yaw, pitch, dist) => E(o => { const c = window.__sw.app.flight.cam; c.yaw = o.yaw; c.pitch = o.pitch; if (c.setDist) c.setDist(o.dist); c.dist = o.dist; for (let i = 0; i < 40; i++) window.__sw.app.flight.view.update(window.__sw.world, 1 / 30, 0, c); }, { yaw, pitch, dist });

async function launchStock(name, site) {
  const r = await E(async ({ name, site }) => {
    const { stockCrafts, stockSite } = await import('/js/core/craft.js');
    const { PARTS } = await import('/js/core/parts.js');
    const c = stockCrafts().find(c => c.name === name);
    if (!c) return null;
    const app = window.__sw.app;
    const seats = c.parts.reduce((n, p) => n + ((PARTS[p.type] && PARTS[p.type].crew) || 0), 0);
    try { app.career.releaseCrew(app.career.roster.filter(p => p.status === 'assigned').map(p => p.name)); } catch { /* keep going */ }
    window.__prevView = app.flight && app.flight.view;
    const went = app.launch(c, { crew: seats ? app.career.availableCrew().slice(0, 1).map(p => p.name) : [], site: site || stockSite(c) });
    return went ? site || stockSite(c) : 'refused';
  }, { name, site });
  if (!r) throw new Error('no stock craft ' + name);
  if (r === 'refused') return null;       // the facility limits say no (too heavy for the runway, …)
  await page.waitForFunction(n => { const a = window.__sw.app; return a.currentName === 'flight' && a.flight && a.flight.view && a.flight.view !== window.__prevView && a.world && a.world.active && a.world.active.name === n && a.flight.view.views.has(a.world.active); }, name, { timeout: 600000, polling: 50 });
  await frames(2);
  return r;
}
const stockNames = () => E(async () => (await import('/js/core/craft.js')).stockCrafts().map(c => c.name));

// ---------------------------------------------------------------------------------------------------- assertions
/** A landed vessel touches what is drawn under it. */
function contact(m, label, { sink = SINK, float = FLOAT } = {}) {
  if (!m || !m.drawn) return ok(false, `${label}: the vessel is drawn`);
  const onDeck = m.deck !== null && m.deck !== undefined && m.deck >= m.terr;
  const on = onDeck ? `on ${m.deckName}` : `on terrain L${m.level}`;
  // The vessel is lifted onto the paving under its centre (m.lifted). Painted marks stand proud of the paving they
  // are painted on (3 cm: layers need that with a logarithmic depth buffer), so a part that happens to be over a
  // mark meets the paint that much early. Measured against the paving the vessel stands on, with the paint step
  // checked on its own.
  const paint = onDeck && m.deckName === 'mark' && Number.isFinite(m.lifted) && m.lifted > 0 && Number.isFinite(m.phys) ? Math.max(0, m.deck - m.phys - m.lifted) : 0;   // m.lifted: how far over the real ground the vessel is drawn
  if (paint > 0) ok(paint <= 0.035, `${label}: the painted mark under ${m.at} stands ${cm(paint)} proud of the paving the vessel stands on (at most 3.5 cm)`);
  return ok(m.gap + paint >= -sink && m.gap + paint <= float, `${label}: lowest drawn point (${m.at}) is ${cm(m.gap + paint)} from the ${paint > 0 ? 'paving it stands on' : 'surface drawn under it'} (${on}${paint > 0 ? `, paint ${cm(paint)}` : ''}; allowed −${cm(sink)} … +${cm(float)}; drawn ${f2(m.lifted)} m over the real ground, paving ${f2(m.deck - m.phys)} m over it there; long axis ${f2(m.tilt)}° from the vertical)`);
}
function cameraAbove(c, label) { return ok(c.clear >= CAM_CLEAR, `${label}: camera is ${f2(c.clear)} m above the drawn ground (physics ground: ${f2(c.clearPhys)} m)`); }
function slabsClear(s, label, { float = 0.12 } = {}) {
  if (!s || !s.n) return ok(false, `${label}: the space centre's slabs were found`);
  ok(s.over <= -SLAB_CLEAR, `${label}: no terrain is drawn above or within ${cm(SLAB_CLEAR)} of ${s.n} slab samples (worst: terrain ${cm(s.over)} relative to the slab` + (s.over > -SLAB_CLEAR ? `, ${s.poke} above, at ${JSON.stringify(s.overAt)}` : '') + ')');
  if (float != null) ok(s.under <= float, `${label}: the drawn terrain is nowhere more than ${cm(float)} below the real ground under a slab (worst ${cm(s.under)}` + (s.under > float ? ` at ${JSON.stringify(s.underAt)}` : '') + ')');
}

/** A vessel that started on the runway has the runway's own surface drawn under its lowest point (not grass). */
function onRunway(m, label) { return ok(m && m.deck !== null && m.deck !== undefined && m.deck >= m.terr && /^(asphalt|mark)$/.test(m.deckName || ''), `${label}: what is drawn under ${m ? m.at : '-'} is the runway (${m && m.deck !== null && m.deck >= m.terr ? m.deckName : 'terrain: no paving there'})`); }
/** Nothing but the vessel itself between the camera and the vessel. */
function sightClear(sg, label) { return ok(sg && sg.rays > 0 && sg.blocked.length === 0, `${label}: nothing stands between the camera and the vessel (${sg ? sg.rays : 0} rays` + (sg && sg.blocked.length ? '; BLOCKED: ' + sg.blocked.map(b => `${b.to} by ${b.by} at ${b.at} of ${b.of} m`).join(', ') : '') + ')'); }

// ====================================================================================================== sections
async function stockSection(high, names, sites = ['pad', 'runway']) {
  await boot({ high });
  const all = await stockNames();
  const list = (names || all).filter(n => !CRAFT.length || CRAFT.includes(n));
  let first = true;
  for (const name of list) for (const site of sites) {
    const label = `${name} on the ${site}` + (high ? '' : ' (reduced profile)');
    console.log(`\n--- ${label}`);
    // the terrain workers are held: only what the game builds on its own thread before the first frame is there
    await E(() => window.__ct.stall(true));
    if (!await launchStock(name, site)) { console.log('    (the game refuses to launch it from there: facility limits)'); await E(() => window.__ct.stall(false)); continue; }
    const cold = await E(() => ({ m: window.__ct.all(), s: window.__ct.slabs(), t: window.__ct.terrain(), sight: window.__ct.sight(), site: window.__sw.world.active.launchSite }));
    const v0 = cold.m.vessels.find(v => v.name === name);
    ok(cold.site === site, `${label}: the vessel was put on the ${site} (launchSite ${cold.site})`);
    if (site === 'runway') onRunway(v0, label + ', first frame');
    sightClear(cold.sight, label + ', first frame');
    if (first) console.log('    quality ' + cold.m.quality + ', drawn−physics terrain while the workers are held: ' + cold.t.map(r => `${r.r} m [${r.min}, ${r.max}] L${r.lmin}-${r.lmax}`).join('  '));
    contact(v0, label + ', first frame, workers held');
    cameraAbove(cold.m.camera, label + ', first frame');
    slabsClear(cold.s, label + ', first frame, workers held');
    if (v0.padOff !== undefined) ok(v0.padOff < 0.05, `${label}: stands ${cm(v0.padOff)} from the centre of the pad model`);
    await settle(label);
    const warm = await E(() => ({ m: window.__ct.all(), s: window.__ct.slabs(), h: window.__ct.heightAtCheck() }));
    const v1 = warm.m.vessels.find(v => v.name === name);
    contact(v1, label + ', terrain loaded');
    cameraAbove(warm.m.camera, label + ', terrain loaded');
    slabsClear(warm.s, label + ', terrain loaded');
    for (const d of warm.m.decals) ok(d.above >= 0.01, `${label}: ${d.name} lies ${cm(d.above)} above the surface under it (${d.deck || 'terrain'})`);
    if (first && warm.h) ok(warm.h.n > 20 && warm.h.worst < 0.01, `terrain.heightAt agrees with the chunk triangles on screen (${warm.h.n} rays, worst ${cm(warm.h.worst)})`);
    if (process.env.SHOT) { await shot(`dbg0-${name.replace(/\W+/g, '_')}-${site}`); await cam(2.4, 0.06, 14); await shot(`dbg-${name.replace(/\W+/g, '_')}-${site}`); }
    if (first) { await cam(2.4, 0.06, 40); await shot(`${high ? 'high' : 'soft'}-${name.replace(/\W+/g, '_')}-${site}`); }
    first = false;
  }
}

async function lodSection() {
  console.log('\n=== terrain level of detail ===');
  // (1) which chunks are on screen does not depend on the window or on the pixel ratio
  const seen = [];
  for (const [w, h, dpr] of [[960, 600, 1], [480, 300, 1], [864, 558, 2], [432, 280, 4]]) {
    await boot({ high: true, width: w, height: h, dpr });
    await launchStock('Ember Twin', 'pad');
    await settle();
    const l = await E(() => ({ ...window.__ct.lod(), px: [window.__sw.app.renderer.domElement.width, window.__sw.app.renderer.domElement.height], ratio: window.__sw.app.renderer.getPixelRatio() }));
    seen.push(l);
    console.log(`    ${w}×${h} @${dpr}: canvas ${l.px.join('×')} (ratio ${l.ratio}), levels ${JSON.stringify(l.hist)}`);
  }
  ok(seen.every(l => l.key === seen[0].key), `the same terrain chunks are drawn at every window size and pixel ratio (${seen.map(l => l.px.join('×')).join(', ')}): the level of detail depends on distance only`);
  ok(seen[0].hist[seen[0].fine] > 0, `the finest level (L${seen[0].fine}) is on screen under the rocket`);
  // (2) every level against the physics ground round the pad: which levels could stand in without showing
  const err = await E(() => window.__ct.levelError('verda', [1, 0, 0]));
  console.log('    chunk of level L drawn in place of the real ground round the pad (drawn − physics, m) at 10 / 80 / 400 / 1400 m:');
  for (const r of err) console.log(`      L${r.level} (${r.spacing.toFixed(1)} m grid): ` + r.err.map(e => `[${e[0]}, ${e[1]}]`).join(' '));
  const bad = err.filter(r => r.err.some(e => e[1] > 0.03)).map(r => r.level);
  console.log('    levels that would cover a 3 cm slab somewhere within 1.4 km: ' + (bad.length ? 'L' + bad.join(', L') : 'none'));
  // (3) what is actually drawn within 1.4 km of the pad, at each camera height, is never one of those levels
  await boot({ high: true });
  await launchStock('Ember Twin', 'pad');
  for (const alt of [0, 150, 1200, 6000, 20000, 45000, 70000]) {
    if (alt) await E(async alt => {
      const THREE = window.__ct.THREE, w = window.__sw.world, v = w.active, b = v.body;
      if (v.landed) { v.landed = false; v.surface = null; v.launched = true; v.launchUt = w.ut; }
      const up = b.surfaceDirToInertial(new THREE.Vector3(1, 0, 0), w.ut, new THREE.Vector3()).normalize();
      v.pos.copy(up).multiplyScalar(b.radius + alt);
      const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
      v.w.set(0, 0, 0); v._stamp++; v.updateTelemetry(w.ut);
      const f = window.__sw.app.flight; f.cam.pitch = 0.9; f.cam.dist = 40; if (f.cam.setDist) f.cam.setDist(40);
      for (let i = 0; i < 30; i++) f.view.update(w, 1 / 30, 0, f.cam);
    }, alt);
    await settle('alt ' + alt);
    const r = await E(() => ({ s: window.__ct.slabs(), l: window.__ct.lod(), vis: window.__sw.app.flight.view.base.group.visible }));
    if (!r.vis) { console.log(`    ${alt} m: the space centre is not drawn`); continue; }
    slabsClear(r.s, `seen from ${alt} m above the pad (slab samples on levels ${JSON.stringify(r.s.levels)})`, { float: alt <= 6000 ? 0.12 : null });
  }
}

async function warpSection() {
  console.log('\n=== time warp on the pad and through a launch ===');
  await boot({ high: true });
  await launchStock('Skylark II', 'pad');
  await settle();
  const rates = await E(async () => (await import('/js/core/world.js')).WARP_RATES || window.__sw.world.WARP_RATES || []);
  const n = rates.length || 11;
  for (let i = 0; i < n; i++) {
    const r = await E(async i => {
      const sw = window.__sw, w = sw.world, f = sw.app.flight;
      const got = w.setWarp(i);
      let worstOff = 0, worstGap = [Infinity, -Infinity], worstCam = Infinity;
      for (let k = 0; k < 12; k++) {
        sw.app.current.update(k % 3 === 0 ? 0.1 : k % 3 === 1 ? 1 / 60 : 1 / 144); sw.app.input.endFrame();
        const m = window.__ct.vessel(), c = window.__ct.camera();
        worstOff = Math.max(worstOff, m.padOff ?? 0); worstGap = [Math.min(worstGap[0], m.gap), Math.max(worstGap[1], m.gap)]; worstCam = Math.min(worstCam, c.clear);
      }
      const s = window.__ct.slabs();
      return { got, rate: w.rate || null, off: worstOff, gap: worstGap, cam: worstCam, over: s.over, ut: w.ut, landed: w.active.landed };
    }, i);
    ok(r.landed && r.off < 0.05 && r.gap[0] >= -SINK && r.gap[1] <= FLOAT && r.over <= -SLAB_CLEAR,
      `warp index ${i} (set ${r.got}), frames of 100, 17 and 7 ms: on the pad centre within ${cm(r.off)}, gap ${cm(r.gap[0])} … ${cm(r.gap[1])}, terrain ${cm(r.over)} against the slabs (ut ${r.ut.toFixed(0)})`);
  }
  await E(() => window.__sw.world.setWarp(0));
  // a launch under 4× physics warp, sampled every frame
  await launchStock('Skylark II', 'pad');
  await settle();
  const fly = await E(async () => {
    const sw = window.__sw, w = sw.world, f = sw.app.flight, v = w.active, rows = [];
    v.ctrl.throttle = 1; w.stage();
    w.setWarp(3);
    const t0 = w.ut; let worst = Infinity, worstCam = Infinity, last = -1, lift = null;
    for (let k = 0; k < 4000 && w.ut - t0 < 60; k++) {
      sw.app.current.update(k % 2 ? 1 / 30 : 1 / 60); sw.app.input.endFrame();
      if (w.active !== v || v.dead) break;
      const m = window.__ct.vessel(), c = window.__ct.camera();
      if (lift === null && !m.landed) lift = w.ut - t0;
      worst = Math.min(worst, m.gap); worstCam = Math.min(worstCam, c.clear);
      const sec = Math.floor(w.ut - t0);
      if (sec !== last) { last = sec; rows.push([sec, +m.gap.toFixed(2), +(m.radar || 0).toFixed(1), w.warpIndex]); }
    }
    return { rows, worst, worstCam, lift, warp: w.warpIndex, dead: v.dead };
  });
  console.log('    [sim s, drawn gap m, radar alt m, warp] ' + fly.rows.filter((r, i) => i < 12 || i % 10 === 0).map(r => r.join('/')).join('  '));
  ok(fly.rows.length >= 55 && !fly.dead, `flew 60 s under physics warp (${fly.rows.length} one-second samples, lift-off at ${f2(fly.lift)} s)`);
  ok(fly.worst >= -SINK, `under physics warp the rocket's lowest drawn point is never below the drawn ground (worst ${cm(fly.worst)})`);
  ok(fly.worstCam >= CAM_CLEAR, `under physics warp the camera never goes below the drawn ground (worst ${f2(fly.worstCam)} m)`);
  ok(fly.rows.every((r, i) => i < 3 || r[1] >= fly.rows[i - 1][1] - 0.05 || r[2] > 3000), 'the drawn gap grows with the climb (no step back toward the ground)');
}

async function depthSection() {
  console.log('\n=== depth buffer audit (flight scenes) ===');
  await boot({ high: true });
  await launchStock('Ember Twin', 'pad');
  await settle();
  // light the engines so plumes, smoke, the light pool and the shadow catcher all exist
  await E(() => { const w = window.__sw.world; w.active.ctrl.throttle = 1; w.stage(); });
  await ff(1.2);
  const a = await E(() => window.__ct.materials());
  const r = a.rows;
  console.log(`    ${r.length} materials; depth bits ${a.depthBits}, logarithmic depth ${a.logBuffer}, reverse depth ${a.reverse}, camera near ${a.near} far ${a.far}`);
  ok(a.logBuffer, 'the renderer uses a logarithmic depth buffer (one depth range for near and far scenes)');
  const noLog = r.filter(m => m.depthTest && !m.logDepth);
  ok(noLog.length === 0, 'every shader that takes part in the depth test writes logarithmic depth' + (noLog.length ? ': NOT ' + noLog.map(m => `${m.scene}/${m.obj}`).join(', ') : ` (${r.filter(m => m.depthTest).length} materials)`));
  const farWriters = r.filter(m => m.scene === 'far' && m.depthWrite && m.depthTest);
  console.log('    far-scene depth writers: ' + farWriters.map(m => m.obj.replace(/chunk_.*/, 'chunk') + '@' + m.renderOrder).filter((x, i, l) => l.indexOf(x) === i).join(', '));
  const po = r.filter(m => m.polygonOffset);
  console.log('    materials with polygonOffset (it has no effect once the fragment shader writes depth, as it does with a logarithmic buffer): ' + po.map(m => `${m.scene}/${m.obj}`).filter((x, i, l) => l.indexOf(x) === i).join(', '));
  // resolution of a 24-bit logarithmic buffer at the distances the pad is looked at from
  const res = d => (1 + d) * Math.log(1 + a.far) / 2 ** a.depthBits;
  console.log('    depth resolution: ' + [50, 500, 5000, 20000].map(d => `${d} m → ${(res(d) * 1000).toFixed(2)} mm`).join(', '));
  ok(res(5000) < 0.03 / 2, `at 5 km the depth buffer resolves ${(res(5000) * 1000).toFixed(1)} mm: the 3 cm between terrain and the lowest slab is at least two steps`);
  const order = await E(() => { const sc = window.__sw.app.flight.view; const calls = []; const r = window.__sw.app.renderer, o = r.render.bind(r), c = r.clear.bind(r), cd = r.clearDepth.bind(r);
    let inside = 0;      // a render() with autoClear clears through renderer.clear(): that clear belongs to the render
    r.render = (s, cam) => { calls.push('render:' + (s.name || s.type) + ':autoClear=' + r.autoClear + ':autoClearDepth=' + r.autoClearDepth); inside++; try { return o(s, cam); } finally { inside--; } };
    r.clear = (...a) => { if (!inside) calls.push('clear'); return c(...a); }; r.clearDepth = () => { if (!inside) calls.push('clearDepth'); return cd(); };
    try { sc.render(r); } finally { r.render = o; r.clear = c; r.clearDepth = cd; }
    return calls; });
  const iF = order.findIndex(c => c.startsWith('render:flight-far')), iN = order.findIndex(c => c.startsWith('render:flight-near'));
  console.log('    draw order: ' + order.filter(c => /flight-|clear/.test(c)).join(' → '));
  ok(iF >= 0 && iN > iF && /autoClear=true/.test(order[iF]) && /autoClear=false/.test(order[iN]) && !order.slice(iF + 1, iN).some(c => /^clear/.test(c)),
    'the far scene is drawn first into a cleared buffer, then the near scene on the same depth buffer (terrain can hide what stands behind a hill)');
  const d = await E(() => window.__ct.decals());
  for (const x of d) ok(x.above >= 0.01, `engines running: ${x.name} lies ${cm(x.above)} above the surface drawn under it (${x.deck || 'terrain'})`);
  ok(d.length >= 1, `ground decals are in use while the engines run (${d.map(x => x.name).join(', ')})`);
}


// ------------------------------------------------------------------------------------------------- the demo tour
/** Start the tour from the title screen, sample every drawn frame of the launch chapter, stop when `done` says so. */
async function demoRun(label, opts, { hold, until, maxMs = 1500000, chapter = 'launch', size = { width: 480, height: 300 } }) {
  await open('', size);
  await E(({ hold, chapter }) => { window.__ct.stall(hold); window.__ct.sample(true, a => !!(a.demo && a.demo.running && a.demo.state().chapter === chapter)); }, { hold, chapter });
  await E(opts => { window.__demoDone = false; window.__sw.app.demo.start(opts).then(() => { window.__demoDone = true; }); }, opts);
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(1500);
    st = await E(() => { const a = window.__sw.app, s = window.__ct.sampled(), d = a.demo.state(); return { chapter: d.chapter, running: d.running, done: window.__demoDone, rows: s.rows.length, t: s.rows.length ? s.rows[s.rows.length - 1].t : -1, frames: s.frames, err: s.error }; });
    if (st.done || !st.running || until(st)) break;
  }
  const r = await E(() => { const a = window.__sw.app, s = window.__ct.sampled(), v = a.world && a.world.active; const o = { ...s, state: a.demo.state(), vessel: v ? { name: v.name, parts: v.parts.size } : null }; window.__ct.sample(false); return o; });
  await E(() => { try { window.__sw.app.demo.stop(); } catch { /* ended */ } });
  const rows = r.rows, W = r.worst;
  console.log(`    ${label}: ${r.frames} frames sampled, ${rows.length} one-second rows up to t = ${rows.length ? rows[rows.length - 1].t : '-'} s; vessel ${r.vessel ? r.vessel.name + ' (' + r.vessel.parts + ' parts)' : '-'}`);
  console.log('    [t s / drawn gap m / radar m / lapse / chunks pending] ' + rows.filter((x, i) => i < 8 || i % 6 === 0).map(x => `${x.t.toFixed(0)}/${x.gap.toFixed(2)}/${(x.radar || 0).toFixed(0)}/${x.lapse}/${x.pending}`).join('  '));
  if (r.error) problems.push('sampler error: ' + r.error);
  const first = rows[0];
  ok(!!first && first.landed, `${label}: the first frame of the ${chapter} chapter's flight was sampled with the vessel standing (${first ? first.site : '-'})`);
  ok(W.blockedFrames === 0, `${label}: nothing stands between the camera and the vessel in any of the ${rows.length} one-second samples` + (W.blockedRow ? ` (first at t = ${W.blockedRow.t} s, ${f2(W.blockedRow.speed)} m/s: ` + W.blockedRow.sight.blocked.map(b => `${b.to} by ${b.by} at ${b.at} of ${b.of} m`).join(', ') + `; ${W.blockedFrames} samples in all)` : ''));
  if (chapter === 'plane') {
    ok(!!first && first.site === 'runway' && /^(asphalt|mark)$/.test(first.deck || ''), `${label}, t = 0: the aeroplane stands on the drawn runway (under ${first ? first.at : '-'}: ${first ? first.deck || 'terrain' : '-'})`);
    ok(W.offRunway === 0, `${label}: every frame of the take-off roll has the runway drawn under the wheels (${r.frames} frames` + (W.offRunwayRow ? `; first off it at t = ${W.offRunwayRow.t} s, ${f2(W.offRunwayRow.speed)} m/s, over ${W.offRunwayRow.deck || 'terrain'}; ${W.offRunway} frames in all` : '') + ')');
    ok(W.rollSink >= -ROLL_SINK && W.rollFloat <= ROLL_FLOAT, `${label}: while it rolls, the wheels stay on the drawn surface (lowest drawn point from ${cm(W.rollSink)} to ${cm(W.rollFloat)}; allowed −${cm(ROLL_SINK)} … +${cm(ROLL_FLOAT)})`);
    ok(W.cam >= CAM_CLEAR, `${label}: the camera is never below the drawn ground (lowest ${f2(W.cam)} m)`);
    return { r, rows, st };
  }
  if (first) {
    ok(first.gap >= -SINK && first.gap <= FLOAT, `${label}, t = 0: lowest drawn point (${first.at}) is ${cm(first.gap)} from the surface drawn under it (${first.deck || 'terrain L' + first.level})`);
    ok(first.padOff === undefined || first.padOff < 0.05, `${label}, t = 0: the rocket stands ${cm(first.padOff)} from the centre of the pad model`);
  }
  ok(W.gap >= -SINK, `${label}: in ${r.frames} frames the rocket's lowest drawn point is never below the drawn surface (worst ${cm(W.gap)}` + (W.gapRow ? ` at t = ${W.gapRow.t} s, radar ${f2(W.gapRow.radar)} m, lapse ×${W.gapRow.lapse}` : '') + ')');
  ok(!(W.float > FLOAT), `${label}: while it stands on the pad it never floats (worst ${cm(W.float)})`);
  ok(W.cam >= CAM_CLEAR, `${label}: the camera is never below the drawn ground (lowest ${f2(W.cam)} m` + (W.camRow ? ` at t = ${W.camRow.t} s` : '') + ')');
  ok(!(W.padOff > 0.05), `${label}: while it stands, the rocket stays on the pad centre (worst ${cm(W.padOff)})`);
  const up = rows.filter(x => !x.landed);
  ok(up.every((x, i) => i === 0 || x.gap >= up[i - 1].gap - 0.05), `${label}: after lift-off the drawn gap only grows (${up.length} rows)`);
  return { r, rows, st };
}
async function demoSection() {
  console.log('\n=== the demo tour: launch chapter ===');
  // (1) stepped at 20 frames a second of real time (no fast mode): the chapter's own time-lapse (×4) is in it.
  //     Terrain workers are held for the whole run: the slowest machine there could be.
  const a = await demoRun('real-time stepping, workers held', { chapter: 'launch', clean: true, hq: false, pointer: false, step: 0.05 }, { hold: true, size: { width: 320, height: 200 }, maxMs: 2400000, until: st => st.t >= 60 || (st.chapter !== 'launch' && st.rows > 0) });
  ok(a.rows.length >= 25, `real-time stepping: at least 25 s of the launch were sampled, second by second (${a.rows.length} rows, ${a.r.frames} frames)`);
  ok(a.rows.some(x => x.lapse > 1), 'real-time stepping: the chapter\'s time-lapse was part of the run');
  await shot('demo-launch-stepped');
  // (2) fast mode (the automated tour: 8× time-lapse steps, uneven frames), workers free, starting at the build
  //     chapter so the launch flies the craft that chapter hands over
  const b = await demoRun('fast mode from the build chapter', { chapter: 'build', clean: true, hq: true, pointer: false, fast: true }, { hold: false, until: st => st.t >= 60 || (st.chapter !== 'launch' && st.chapter !== 'build' && st.rows > 0) });
  const built = b.r.state.chapters.find(c => c.id === 'build');
  ok(built && (built.status === 'ok' || built.status === 'fallback'), `fast mode: the build chapter ran (${built ? built.status : 'missing'}) and handed its craft to the launch (${b.r.vessel ? b.r.vessel.name : '-'})`);
  const lastT = b.rows.length ? b.rows[b.rows.length - 1].t : -1;
  ok(b.rows.length >= 4 && lastT >= 20, `fast mode: the launch was sampled past 20 s (${b.rows.length} rows, ${b.r.frames} frames, up to t = ${f2(lastT)} s; fast mode steps up to 0.6 s a frame)`);
}

// ------------------------------------------------------------------------------------- runway: spawn and take-off
/** Round 3 (owner: "it started on the grass", "big gray blocks behind the plane"): the aeroplane starts on the DRAWN
 *  runway and stays on it through the roll, with a clear view from the camera, on both ways into a runway flight. */
/** The Autopilot panel's take-off program from where the aeroplane stands, measured every frame until it has climbed. */
async function takeoffRoll(label) {
  const roll = await E(async () => {
    const sw = window.__sw, w = sw.world, v = w.active, ct = window.__ct, rows = [];
    const started = sw.app.flight.actions.runProgram('takeoff');        // the Autopilot panel's own take-off program
    const t0 = w.ut; let last = -1, off = 0, offRow = null, blocked = 0, blockedRow = null, sink = Infinity, float = -Infinity, frames = 0, cam = Infinity, airborne = null;
    for (let k = 0; k < 6000 && w.ut - t0 < 40 && !v.dead; k++) {
      const dt = k % 2 ? 1 / 30 : 1 / 60;
      sw.app.current.update(dt); sw.app.input.endFrame();
      const m = ct.vessel(v), g = ct.onGround(v), c = ct.camera(), sec = Math.floor(w.ut - t0), sg = sec !== last ? ct.sight(v) : null; frames++;
      const row = [sec, +v.groundSpeed.toFixed(0), g ? 1 : 0, m.deck !== null && m.deck >= m.terr ? m.deckName : 'terrain', +m.gap.toFixed(3), +(v.radarAlt || 0).toFixed(1)];
      if (g && !/^(asphalt|mark)$/.test(row[3])) { off++; offRow = offRow || row; }
      if (g) { sink = Math.min(sink, m.gap); float = Math.max(float, m.gap); } else if (airborne === null) airborne = w.ut - t0;
      cam = Math.min(cam, c.clear);
      if (sg && sg.blocked.length) { blocked++; blockedRow = blockedRow || { row, b: sg.blocked }; }
      if (sec !== last) { last = sec; rows.push(row); }
      if (!g && v.radarAlt > 60) break;
    }
    return { started, rows, off, offRow, blocked, blockedRow, sink, float, frames, cam, airborne, dead: v.dead, alt: v.radarAlt };
  });
  console.log('    [s / m/s / on ground / drawn under it / gap m / radar m] ' + roll.rows.map(r => r.join('/')).join('  '));
  ok(roll.started && !roll.dead && roll.airborne !== null && roll.alt > 20, `${label}: it took off (airborne after ${f2(roll.airborne)} s, ${f2(roll.alt)} m up at the end; ${roll.frames} frames)`);
  ok(roll.off === 0, `${label}: every frame of the roll has the runway drawn under the wheels` + (roll.offRow ? ` (first off it: ${roll.offRow.join('/')}; ${roll.off} frames)` : ''));
  ok(roll.sink >= -ROLL_SINK && roll.float <= ROLL_FLOAT, `${label}: while it rolls the wheels stay on the drawn surface (lowest drawn point from ${cm(roll.sink)} to ${cm(roll.float)}; allowed −${cm(ROLL_SINK)} … +${cm(ROLL_FLOAT)})`);
  ok(roll.blocked === 0, `${label}: nothing stands between the camera and the aeroplane during the take-off (${roll.rows.length} one-second samples` + (roll.blockedRow ? `; first: ${roll.blockedRow.row.join('/')} ` + roll.blockedRow.b.map(b => `${b.to} by ${b.by} at ${b.at} of ${b.of} m`).join(', ') : '') + ')');
  ok(roll.cam >= CAM_CLEAR, `${label}: the camera stays above the drawn ground (lowest ${f2(roll.cam)} m)`);
}
async function runwaySection() {
  for (const dpr of (process.env.DPR ? process.env.DPR.split(',').map(Number) : [1, 2])) {
    console.log(`\n=== runway take-off, device pixel ratio ${dpr} ===`);
    // (1) the game's own path: hangar → launch from the runway
    await boot({ high: true, width: 480, height: 300, dpr });
    for (const name of ['Kite Trainer', 'Trundle Scout']) {
      const label = `ratio ${dpr}, ${name} launched from the runway`;
      if (!await launchStock(name, 'runway')) { ok(false, label + ': the launch was accepted'); continue; }
      await settle(label);
      const at = await E(() => { const sw = window.__sw, v = sw.world.active, sc = sw.app.flight.view, b = sc.base, g = sc.views.get(v).group.position.clone(); b.group.updateMatrixWorld(true); const l = b.group.worldToLocal(g); return { x: l.x, z: l.z, site: v.launchSite, m: window.__ct.vessel(), sight: window.__ct.sight(), cam: window.__ct.camera() }; });
      ok(at.site === 'runway' && at.x > -950 && at.x < -700 && Math.abs(at.z - 850) < 2, `${label}: it stands on the model's runway, past the west threshold (model x = ${f2(at.x)}, z = ${f2(at.z)}; strip from x = −950 to 1050 at z = 850)`);
      onRunway(at.m, label); contact(at.m, label); sightClear(at.sight, label); cameraAbove(at.cam, label);
      if (name !== 'Kite Trainer') continue;
      await takeoffRoll(label);
      await shot(`runway-${dpr}-game`);
    }
    // (2) the demo tour's runway scene (demo/scenes.js runwayScene builds its own world from the core's site record
    //     and enters the flight screen by resuming it): the same measurements, every frame
    {
      const label = `ratio ${dpr}, the demo's runway scene`;
      await E(() => window.__sw.app.goto('hub')); await waitScreen('hub');
      await E(async () => {
        const S = await import('/js/ui/demo/scenes.js'), app = window.__sw.app;
        const world = S.runwayScene('Kite Trainer').world;
        window.__prevView = app.flight && app.flight.view;
        app.career.flightState = world.toJSON(); app.career.ut = world.ut;
        app.goto('flight', { resume: true });
      });
      await page.waitForFunction(() => { const a = window.__sw.app; return a.currentName === 'flight' && a.flight && a.flight.view && a.flight.view !== window.__prevView && a.world && a.world.active && a.world.active.name === 'Kite Trainer' && a.flight.view.views.has(a.world.active); }, null, { timeout: 600000, polling: 50 });
      await settle(label);
      const at = await E(() => { const sw = window.__sw, v = sw.world.active, sc = sw.app.flight.view, b = sc.base, g = sc.views.get(v).group.position.clone(); b.group.updateMatrixWorld(true); const l = b.group.worldToLocal(g); return { x: l.x, z: l.z, site: v.launchSite, m: window.__ct.vessel(), sight: window.__ct.sight(), cam: window.__ct.camera() }; });
      ok(at.site === 'runway' && at.x > -950 && at.x < -700 && Math.abs(at.z - 850) < 2, `${label}: it stands on the model's runway, past the west threshold (model x = ${f2(at.x)}, z = ${f2(at.z)}; strip from x = −950 to 1050 at z = 850)`);
      onRunway(at.m, label); contact(at.m, label); sightClear(at.sight, label); cameraAbove(at.cam, label);
      await takeoffRoll(label);
      await shot(`runway-${dpr}-demo-scene`);
    }
    // (3) the tour's "plane" chapter itself, as a player runs it (fast mode here: few frames on a software
    //     rasteriser, so this is the spot check; (2) is the frame-by-frame one)
    const d = await demoRun(`ratio ${dpr}, demo chapter "plane"`, { chapter: 'plane', clean: true, hq: true, pointer: false, fast: true }, { hold: false, chapter: 'plane', size: { width: 480, height: 300, dpr }, until: st => st.t >= 25 || (st.chapter !== 'plane' && st.rows > 0) });
    ok(d.rows.length >= 3, `ratio ${dpr}, demo chapter "plane": the runway flight was sampled (${d.rows.length} one-second rows, ${d.r.frames} frames)`);
    ok(d.rows.some(x => !x.ground && x.radar > 4), `ratio ${dpr}, demo chapter "plane": the aeroplane left the ground`);
    await shot(`runway-${dpr}-demo`);
  }
}

// ---------------------------------------------------------------------------------------- landers on other worlds
const LANDER = `
  const pod = c.setRoot('pod_acorn')[0];
  const dec = c.attachStack('dec_m', pod.id, 'bottom')[0];
  const tank = c.attachStack('tank_m400', dec.id, 'bottom')[0];
  c.attachStack('eng_sparrow', tank.id, 'bottom');
  c.attachRadial('legs', tank.id, tank.pos.y - 1.85, Math.PI / 4, 4);      // feet 12 cm below the bell
  c.name = 'Dustfoot';
`;
const HULK = `
  const tank = c.setRoot('tank_m400')[0];
  c.attachStack('eng_sparrow', tank.id, 'bottom');
  c.attachRadial('legs', tank.id, tank.pos.y - 1.85, Math.PI / 4, 4);      // feet 12 cm below the bell
  c.name = 'Hulk';
`;
/** Put the active lander (and a rover and an uncrewed hulk beside it) down at a site; returns what was placed. */
const placeSite = o => E(async o => {
  const THREE = window.__ct.THREE, SYSTEM = window.__ct.SYSTEM;
  const { World } = await import('/js/core/world.js');
  const { Craft, stockCrafts } = await import('/js/core/craft.js');
  const sw = window.__sw, w = sw.world, b = SYSTEM.byId[o.body];
  // clear what the previous site left behind
  const keep = w.vessels.find(v => v.name === 'Dustfoot' && v.type === 'ship' && !v.dead);
  if (w.active !== keep) w.switchTo(keep);
  for (const v of w.vessels.slice()) if (v !== keep) { v.dead = true; const i = w.vessels.indexOf(v); if (i >= 0) w.vessels.splice(i, 1); }
  w.flags.length = 0;
  const pod = [...keep.parts.values()].find(p => p.def.crew); if (pod && !pod.crew.length) { pod.crew.push('Juno'); keep.crewCount = (keep.crewCount || 0) + 1; }
  const dir = new THREE.Vector3(o.dir[0], o.dir[1], o.dir[2]).normalize();
  const put = (v, east, vehicle) => {
    const d = dir.clone();
    if (east) { const e = new THREE.Vector3(0, 1, 0).cross(d).normalize(); d.multiplyScalar(b.radius).addScaledVector(e, east).normalize(); }
    const up = b.surfaceDirToInertial(d, w.ut, new THREE.Vector3()).normalize();
    v.body = b; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true; v.launchUt = w.ut;
    v.pos.copy(up).multiplyScalar(b.radius + b.surfaceHeight(d) + (o.alt ?? 0.5) + (v.baseHeight || 1.5));
    const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
    v.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(vehicle ? World.vehicleFrame(d, 70) : World.padFrame(d));
    v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
    if (typeof v.setLegs === 'function') v.setLegs(true);
    v.updateTelemetry(w.ut);
    return v;
  };
  put(keep, 0, false);
  const out = { extras: [] };
  if (o.extras) {
    const rover = stockCrafts().find(c => c.name === 'Trundle Scout');
    const r = w.spawn(rover, { body: b, pos: keep.pos.clone(), vel: keep.vel.clone(), makeActive: false }); put(r, 14, true); out.extras.push(r.name);
    const c = new Craft(); new Function('c', o.hulk)(c); c.autoStage();
    const h = w.spawn(c, { body: b, pos: keep.pos.clone(), vel: keep.vel.clone(), makeActive: false }); put(h, -12, false); out.extras.push(h.name + ':' + h.type);
  }
  w.step(0.001);
  return out;
}, o);
/** Three places on a body: the most level ground found, a moderate slope and a steep one (land only). */
const findSites = body => E(body => {
  const THREE = window.__ct.THREE, b = window.__ct.SYSTEM.byId[body];
  let seed = 12345 + body.length * 977 + body.charCodeAt(0);
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const d = new THREE.Vector3(), n = new THREE.Vector3(), cand = [];
  for (let i = 0; i < 3000; i++) {
    const z = rnd() * 1.6 - 0.8, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    d.set(r * Math.cos(a), z, r * Math.sin(a));
    if (b.ocean && b.terrainHeight(d) < b.seaLevel + 2) continue;
    if (b === window.__ct.SYSTEM.home && d.x > 0.99998) continue;
    b.terrainNormal(d, n);
    cand.push({ dir: [d.x, d.y, d.z], slope: Math.acos(Math.min(1, n.dot(d))) * 180 / Math.PI });
  }
  const pick = want => cand.reduce((best, c) => (Math.abs(c.slope - want) < Math.abs(best.slope - want) ? c : best), cand[0]);
  return cand.length ? [pick(0), pick(9), pick(20)] : [];
}, body);
function vesselChecks(all, label, held) {
  for (const m of all.vessels) {
    const who = `${label}: ${m.type === 'eva' ? 'Pip' : m.name}${m.type === 'debris' ? ' (debris)' : ''}`;
    if (!m.drawn) { ok(false, who + ' is drawn'); continue; }
    if ((m.landed || m.grounded) && m.fallen) {
      // a craft lying on its side rests on its drawn hull (round 3: the core looked the ground up 2 m to the east and
      // on one plane, and such craft lay up to 58 cm inside the hill). The hull between two contact rings may dip
      // into a bump of the ground by a few centimetres.
      ok(m.gap >= -FALLEN_SINK && m.gap <= FLOAT, `${who}${held ? ', workers held' : ''}, lying on its side (lean ${f2(m.tilt)}° on a ${f2(m.slope)}° slope): the drawn point nearest the ground (${m.at}) is ${cm(m.gap)} from it (allowed −${cm(FALLEN_SINK)} … +${cm(FLOAT)})`);
      continue;
    }
    if (m.landed || m.grounded) {
      // contact points are points: a foot pad or tyre of half-width 0.35 m on a slope has its uphill edge in the ground
      const sink = SINK + 0.35 * Math.tan((m.slope || 0) * Math.PI / 180);
      ok(m.gap >= -sink && m.gap <= FLOAT, `${who}${held ? ', workers held' : ''}: the drawn point nearest the ground (${m.at}) is ${cm(m.gap)} from it (allowed −${cm(sink)} … +${cm(FLOAT)}; slope ${f2(m.slope)}°, lean ${f2(m.tilt)}°, terrain L${m.level}, ${f2(m.spacing)} m grid)`);
      continue;
    }
    if (!(m.landed || m.grounded)) { console.log(`    ${who}: not at rest (${m.sit}, radar ${f2(m.radar)} m, gap ${cm(m.gap)})`); ok(m.gap >= -SINK, `${who}, still moving: lowest drawn point is not below the drawn ground (${cm(m.gap)})`); continue; }
    ok(m.gap >= -SINK && m.gap <= FLOAT, `${who}${held ? ', workers held' : ''}: lowest drawn point (${m.at}) is ${cm(m.gap)} from the drawn ground (slope ${f2(m.slope)}°, lean ${f2(m.tilt)}°, terrain L${m.level}, ${f2(m.spacing)} m grid)`);
  }
  for (const [i, fl] of all.flags.entries()) ok(fl.gap >= -0.25 && fl.gap <= FLOAT, `${label}: flag ${i + 1}${held ? ', workers held' : ''}: the foot of the pole is ${cm(fl.gap)} from the drawn ground (it is planted, so up to 25 cm in the ground)`);
  ok(all.camera.clear >= CAM_CLEAR, `${label}${held ? ', workers held' : ''}: camera ${f2(all.camera.clear)} m above the drawn ground`);
}
async function worldsSection() {
  console.log('\n=== lander, rover, Pip, flag and debris on every landable body ===');
  await boot({ high: true });
  await E(async src => {
    const { Craft } = await import('/js/core/craft.js');
    const c = new Craft(); new Function('c', src)(c); c.autoStage();
    const app = window.__sw.app;
    app.launch(c, { crew: app.career.availableCrew().slice(0, 1).map(p => p.name) });
  }, LANDER);
  await page.waitForFunction(() => { const a = window.__sw.app; return a.currentName === 'flight' && a.flight && a.flight.view && a.world && a.world.active && a.flight.view.views.has(a.world.active); }, null, { timeout: 600000, polling: 50 });
  const bodies = (await E(() => window.__ct.SYSTEM.bodies.filter(b => !b.gas && b.type !== 'star').map(b => b.id))).filter(b => !BODIES.length || BODIES.includes(b));
  console.log('    bodies: ' + bodies.join(', '));
  for (const body of bodies) {
    // a level site on every body; the two slopes on a rocky planet, two moons and the home world (SLOPES=all: everywhere)
    const sites = (await findSites(body)).slice(0, process.env.SLOPES === 'all' || ['verda', 'pell', 'rusk', 'sear'].includes(body) ? 3 : 1);
    for (const [k, site] of sites.entries()) {
      const label = `${body} site ${k + 1} (${site.slope.toFixed(1)}°)`;
      const extras = k === 0;
      await E(() => window.__ct.stall(true));
      const placed = await placeSite({ body, dir: site.dir, extras, hulk: HULK });
      const rest = await ff(extras ? 90 : 60, 'w.vessels.every(x => x.dead || x.landed || (x.grounded && x.groundSpeed < 0.05))');
      await ff(1.5);
      if (extras) {
        // a Pip steps out and plants a flag
        const eva = await E(() => { const w = window.__sw.world, v = w.vessels.find(x => x.name === 'Dustfoot'); const pip = v.landed || v.grounded ? w.evaStart(v) : null; if (!pip) return null; const f = pip.landed ? w.plantFlag(pip, 'Contact') : null; return { landed: pip.landed, flag: !!f }; });
        await ff(1.5);
        if (!eva) console.log(`    ${label}: no Pip (the lander is not at rest)`);
      }
      // the legs were let down when the lander was placed: measure once the struts have finished swinging out
      const swung = await page.waitForFunction(() => { let moving = 0; window.__sw.app.flight.view.near.traverse(o => { const u = o.userData; if (u && u.deployTarget !== undefined && u.deployK !== u.deployTarget) moving++; }); return moving === 0; }, null, { timeout: 120000, polling: 100 }).then(() => true, () => false);
      ok(swung, `${label}: every deploying part has finished moving before the measurement`);
      const held = await E(() => ({ all: window.__ct.all(true), t: window.__ct.terrain([0, 2, 5, 10, 25, 60]) }));
      if (!rest) console.log(`    ${label}: not everything came to rest: ` + held.all.vessels.map(v => `${v.name} ${v.sit}`).join(', '));
      if (k === 0) console.log(`    ${label}: placed ${placed.extras.join(', ') || 'lander'}; drawn−physics terrain with the workers held: ` + held.t.map(r => `${r.r} m [${r.min}, ${r.max}] L${r.lmin}-${r.lmax}`).join('  '));
      vesselChecks(held.all, label, true);
      await settle(label);
      await ff(0.3);
      const warm = await E(() => ({ all: window.__ct.all(true), h: window.__ct.heightAtCheck() }));
      vesselChecks(warm.all, label, false);
      if (warm.h && warm.h.n > 10) ok(warm.h.worst < 0.02, `${label}: heightAt agrees with the chunk triangles (${warm.h.n} rays, worst ${cm(warm.h.worst)})`);
      if (k !== 1 && (body === 'pell' || body === 'verda' || body === 'rusk')) { await cam(2.3, 0.12, 14); await shot(`world-${body}-${k + 1}`); }
    }
  }
}

async function splashSection() {
  console.log('\n=== splashdown ===');
  await boot({ high: true });
  await E(async () => {
    const { Craft } = await import('/js/core/craft.js');
    const c = new Craft('Float'); const [pod] = c.setRoot('pod_acorn'); c.attachStack('chute', pod.id, 'top'); c.autoStage();
    const app = window.__sw.app; app.launch(c, { crew: app.career.availableCrew().slice(0, 1).map(p => p.name) });
  });
  await page.waitForFunction(() => { const a = window.__sw.app; return a.currentName === 'flight' && a.flight && a.flight.view && a.world && a.world.active && a.world.active.name === 'Float' && a.flight.view.views.has(a.world.active); }, null, { timeout: 600000, polling: 50 });
  for (const body of ['verda', 'brim']) {
    const dir = await E(body => {
      const THREE = window.__ct.THREE, b = window.__ct.SYSTEM.byId[body];
      if (!b || !b.ocean) return null;
      let seed = 4242; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const d = new THREE.Vector3();
      for (let i = 0; i < 4000; i++) { const z = rnd() * 1.2 - 0.6, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z); d.set(r * Math.cos(a), z, r * Math.sin(a)); if (b.terrainHeight(d) < b.seaLevel - 30) return [d.x, d.y, d.z]; }
      return null;
    }, body);
    if (!dir) { console.log(`    ${body}: no open water found`); continue; }
    await E(async o => {
      const THREE = window.__ct.THREE, b = window.__ct.SYSTEM.byId[o.body];
      const { World } = await import('/js/core/world.js');
      const w = window.__sw.world, v = w.active, d = new THREE.Vector3(o.dir[0], o.dir[1], o.dir[2]);
      const up = b.surfaceDirToInertial(d, w.ut, new THREE.Vector3()).normalize();
      v.body = b; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true;
      v.pos.copy(up).multiplyScalar(b.radius + b.seaLevel + 4);
      const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
      v.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(d));
      v.w.set(0, 0, 0); v.ctrl.throttle = 0; v._stamp++; v.updateTelemetry(w.ut); w.step(0.001);
    }, { body, dir });
    const hit = await ff(120, 'v && (v.splashed || v.landed)');
    await ff(4);
    await settle('splash ' + body);
    const m = await E(() => ({ v: window.__ct.vessel(), c: window.__ct.camera() }));
    ok(hit && m.v.splashed, `${body}: the capsule is in the water (${m.v.sit})`);
    ok(Math.abs(m.v.terr - m.v.sea) < 0.01, `${body}: the drawn surface under it is the sea (${f2(m.v.terr)} m, sea level ${f2(m.v.sea)} m)`);
    ok(m.v.low < m.v.sea - 0.05 && m.v.high > m.v.sea + 0.3, `${body}: it floats in the drawn sea: keel ${cm(m.v.sea - m.v.low)} under water, top ${f2(m.v.high - m.v.sea)} m above it`);
    ok(m.c.clear >= CAM_CLEAR, `${body}: camera ${f2(m.c.clear)} m above the drawn sea`);
    await cam(2.3, 0.12, 12); await shot('splash-' + body);
  }
}

// ----------------------------------------------------------------------------- the space-centre view and the builder
async function centreSection() {
  console.log('\n=== space-centre view: show rocket, crawler, slabs ===');
  await boot({ high: true });
  const res = await E(async () => {
    const THREE = window.__ct.THREE;
    const { getBaseView } = await import('/js/ui/baseview.js');
    const view = getBaseView(window.__sw.app), base = view.base, out = [];
    view.lockQuality(0);
    const solid = o => o.isMesh && o.material && !Array.isArray(o.material) && o.material.visible !== false && o.material.depthWrite !== false && !(o.material.transparent && o.material.opacity < 0.5);
    const lowest = root => { let low = Infinity, at = null; const p = new THREE.Vector3(); root.updateMatrixWorld(true); root.traverse(o => { if (!solid(o) || !o.geometry.attributes.position) return; for (let q = o; q; q = q.parent) if (!q.visible) return; const a = o.geometry.attributes.position; for (let i = 0; i < a.count; i++) { p.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld); if (p.y < low) { low = p.y; at = p.clone(); } } }); return { low, at }; };
    const under = (p, skip) => { const rc = new THREE.Raycaster(new THREE.Vector3(p.x, p.y + 0.6, p.z), new THREE.Vector3(0, -1, 0), 0, 60); for (const h of rc.intersectObjects([base.group, view.ground.group], true)) { let own = false; for (let q = h.object; q; q = q.parent) if (q === skip) own = true; let vis = true; for (let q = h.object; q; q = q.parent) if (!q.visible) vis = false; if (own || !vis || !solid(h.object)) continue; return { y: h.point.y, name: h.object.name }; } return null; };
    const rocket = base.group.getObjectByName('showRocket'), crawler = base.group.getObjectByName('crawler');
    // the rocket stands over the platform's flame hole: the vertex that touches is not the lowest one. Smallest gap
    // from any drawn vertex in the rocket's lowest half metre straight down to `onto`.
    const restsOn = onto => { base.group.updateMatrixWorld(true); const pts = [], p = new THREE.Vector3(); const lo = lowest(rocket).low; rocket.traverse(o => { if (!solid(o) || !o.geometry.attributes.position) return; for (let q = o; q; q = q.parent) if (!q.visible) return; const a = o.geometry.attributes.position, st = Math.max(1, Math.floor(a.count / 300)); for (let i = 0; i < a.count; i += st) { p.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld); if (p.y < lo + 0.5) pts.push(p.clone()); } });
      let best = null; const rc = new THREE.Raycaster(); for (const q of pts) { rc.set(new THREE.Vector3(q.x, q.y + 0.6, q.z), new THREE.Vector3(0, -1, 0)); rc.far = 60; const h = rc.intersectObject(onto, true).find(h => solid(h.object)); if (h && (best === null || q.y - h.point.y < best)) best = q.y - h.point.y; } return best; };
    for (const mode of ['pad', 'rollout']) {
      base.setDisplay(mode); base.update(0, {});
      const r = lowest(rocket); if (!r.at) { out.push({ mode: mode + '-missing' }); continue; } const g = under(r.at, rocket);
      out.push({ mode, low: r.low, ground: g ? g.y : null, name: g ? g.name : '', onCrawler: restsOn(crawler), visible: rocket.visible });
      if (mode === 'rollout') {
        // ride to the pad: the rocket stays on the crawler all the way, then stands on the pad
        let worst = 0, n = 0;
        for (let i = 0; i < 4000 && base.display === 'rollout' && n < 4000; i++, n++) {
          base.update(0.25, {});
          if (i % 40 === 0) { const gp = restsOn(crawler); worst = Math.max(worst, gp === null ? 99 : Math.abs(gp)); }
          if (crawler.position.z <= 60.01) break;
        }
        base.update(0.25, {}); base.update(0.25, {});
        const r2 = lowest(rocket), g2 = under(r2.at, rocket);
        out.push({ mode: 'rollout-arrived', low: r2.low, ground: g2 ? g2.y : null, name: g2 ? g2.name : '', ride: worst, z: crawler.position.z });
      }
    }
    const c = lowest(crawler), cg = under(c.at, crawler);
    out.push({ mode: 'crawler', low: c.low, ground: cg ? cg.y : null, name: cg ? cg.name : '' });
    // the local ground mesh against every slab (this view has its own ground, not the planet's terrain)
    let over = -Infinity, at = null, cnt = 0;
    const gm = []; view.ground.group.traverse(o => { if (o.isMesh && solid(o)) gm.push(o); });
    base.group.updateMatrixWorld(true);
    const p = new THREE.Vector3(), rc = new THREE.Raycaster();
    base.group.traverse(o => {
      if (!solid(o) || o.isInstancedMesh || !(o.name === 'slab' || o.name === 'asphalt')) return;
      const a = o.geometry.attributes.position;
      for (let i = 0; i < a.count; i += 7) {
        p.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
        if (p.y > 0.2 || p.y < 0.004) continue;
        rc.set(new THREE.Vector3(p.x, 200, p.z), new THREE.Vector3(0, -1, 0)); rc.far = 400;
        const h = rc.intersectObjects(gm, false)[0]; if (!h) continue;
        cnt++; if (h.point.y - p.y > over) { over = h.point.y - p.y; at = { x: +p.x.toFixed(1), z: +p.z.toFixed(1), slab: +p.y.toFixed(3), ground: +h.point.y.toFixed(3), mesh: h.object.name }; }
      }
    });
    base.setDisplay('none');
    return { out, over, at, cnt, camY: view.camera.position.y };
  });
  for (const r of res.out) {
    if (/-missing$/.test(r.mode)) ok(false, `show rocket (${r.mode.replace('-missing', '')}): it is drawn`);
    if (r.mode === 'pad' || r.mode === 'rollout-arrived') ok(r.ground !== null && r.low - r.ground >= -SINK && r.low - r.ground <= FLOAT, `show rocket ${r.mode === 'pad' ? 'on the pad' : 'after the roll-out'}: its base is ${cm(r.low - r.ground)} from the surface drawn under it (${r.name})`);
    if (r.mode === 'rollout') ok(r.onCrawler !== null && r.onCrawler >= -SINK && r.onCrawler <= FLOAT, `show rocket riding the crawler: the nearest it comes to the crawler's deck is ${cm(r.onCrawler)}`);
    if (r.mode === 'rollout-arrived') ok(r.ride <= FLOAT, `during the ride the rocket stays on the crawler's deck (worst ${cm(r.ride)})`);
    if (r.mode === 'crawler') ok(r.ground !== null && r.low - r.ground >= -0.12 && r.low - r.ground <= FLOAT, `the crawler's tracks are ${cm(r.low - r.ground)} from the surface drawn under them (${r.name}; tracks may bite up to 12 cm into gravel)`);
  }
  ok(res.cnt > 200 && res.over <= -SLAB_CLEAR, `the space-centre view's own ground stays below every slab (${res.cnt} samples, worst ${cm(res.over)}` + (res.over > -SLAB_CLEAR ? ' at ' + JSON.stringify(res.at) : '') + ')');
  ok(res.camY >= 4, `the space-centre camera is above the ground (${f2(res.camY)} m)`);
}

async function builderSection() {
  console.log('\n=== builder: the craft on the assembly floor ===');
  await boot({ high: true });
  for (const [site, name] of [['pad', 'Ember Twin'], ['pad', 'Pell Runner'], ['runway', 'Kite Trainer'], ['runway', 'Trundle Scout']]) {
    await E(() => window.__sw.app.goto('hub')); await waitScreen('hub');
    await E(async ({ site, name }) => { const { stockCrafts } = await import('/js/core/craft.js'); const c = stockCrafts().find(c => c.name === name); window.__sw.app.goto('builder', { site, craft: c.toJSON ? c.toJSON() : c }); }, { site, name });
    await page.waitForFunction(() => window.__sw.app.currentName === 'builder' && window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 600000 });
    await frames(3);
    const r = await E(() => {
      const THREE = window.__ct.THREE, b = window.__sw.app.builder, scene = b.scene, craft = scene.getObjectByName('craft');
      const solid = o => o.isMesh && o.material && !Array.isArray(o.material) && o.material.visible !== false && o.material.depthWrite !== false && !o.material.transparent;
      let low = Infinity, at = null; const p = new THREE.Vector3(); scene.updateMatrixWorld(true);
      craft.traverse(o => { if (!solid(o) || !o.geometry.attributes.position) return; for (let q = o; q; q = q.parent) if (!q.visible) return; const a = o.geometry.attributes.position; for (let i = 0; i < a.count; i++) { p.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld); if (p.y < low) { low = p.y; at = p.clone(); } } });
      let floor = null, fname = '';
      if (at) { const rc = new THREE.Raycaster(new THREE.Vector3(at.x, at.y + 30, at.z), new THREE.Vector3(0, -1, 0), 0, 200); for (const h of rc.intersectObjects(scene.children.filter(c => c !== craft), true)) { let own = false, vis = true; for (let q = h.object; q; q = q.parent) { if (q === craft) own = true; if (!q.visible) vis = false; } if (own || !vis || !solid(h.object) || h.point.y > at.y + 0.5) continue; floor = h.point.y; fname = h.object.name; break; } }
      return { low, floor, fname, clearance: b.clearance, parts: b.craft.parts.length, name: b.craft.name, camY: scene.getObjectByName('craft') ? null : null };
    });
    const label = `${name} in the ${site === 'pad' ? 'assembly building' : 'hangar'}`;
    ok(r.parts > 0 && Number.isFinite(r.low), `${label}: the craft is drawn (${r.parts} parts)`);
    ok(r.floor !== null && r.low - r.floor >= -SINK, `${label}: no part is below the floor (lowest drawn point ${cm(r.low - r.floor)} above ${r.fname || 'the floor'})`);
    ok(Math.abs((r.low - (r.floor ?? 0)) - r.clearance) <= 0.12, `${label}: the drawn clearance (${cm(r.low - (r.floor ?? 0))}) is the builder's own figure (${cm(r.clearance)})`);
  }
  await shot('builder-floor');
}

const sections = { stock: () => stockSection(true), soft: () => stockSection(false, ['Ember Twin', 'Kite Trainer', 'Trundle Scout'], ['pad', 'runway']), lod: lodSection, warp: warpSection, depth: depthSection, demo: demoSection, runway: runwaySection, worlds: worldsSection, splash: splashSection, centre: centreSection, builder: builderSection };

let crashed = null;
try {
  for (const [name, run] of Object.entries(sections)) {
    if (!want(name)) continue;
    console.log(`\n================ ${name} ================`);
    const t0 = Date.now();
    try { await run(); } catch (err) { problems.push(`section ${name} stopped: ` + (err.stack || err.message)); console.log('  ✗ section stopped: ' + err.message); }
    console.log(`  (${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
} catch (err) { crashed = err; }
await browser.close();
await server.close();
if (crashed) problems.push('suite stopped: ' + (crashed.stack || crashed.message));
const uniq = [...new Set(problems)];
console.log(`\n${checks} checks, ${uniq.length} problem(s)`);
if (uniq.length) { console.log(uniq.slice(0, 60).join('\n')); process.exit(1); }
