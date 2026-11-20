// End-to-end test of targeting, docking, fuel transfer and undocking on the flight screen.
//   node tests/e2e/docking.mjs            (screenshots land in tests/out/docking-*.png)
//
// The stock "Latch Target" and "Latch Chaser" are put straight into a 90 km orbit, 45 m apart, in their orbital
// configuration (launch stages removed), through the same modules the game uses (window.__sw + dynamic imports);
// the flight is then opened with the normal "resume" path. Everything after that goes through the real UI:
// keys, HUD buttons, the pop-over panels. The approach itself is flown by the in-game docking assist.
//
// As in flight.mjs, long stretches are advanced by calling the screen's own update(dt) in a loop.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });

async function newPage(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  // every toast ever shown, so a check does not race the toast's own few-second lifetime on a slow machine
  await page.addInitScript(() => { window.__toastLog = []; const start = () => new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { const list = n.matches && n.matches('.sw-toast') ? [n] : [...n.querySelectorAll('.sw-toast')]; for (const t of list) window.__toastLog.push(t.textContent); } }).observe(document.documentElement, { childList: true, subtree: true }); if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start); });            // software GL on a busy machine: a single frame can take seconds
  page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text() + ' @ ' + (m.location()?.url || '')); });
  page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
  page.on('requestfailed', r => { if (!/^data:/.test(r.url())) problems.push('request failed: ' + r.url()); });
  return { ctx, page };
}
const shot = async (page, name) => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, name + '.png') }); };
async function waitScreen(page, name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 240000 });
  await page.waitForTimeout(400);
}
const E = (page, fn, arg) => page.evaluate(fn, arg);
const toasts = page => page.evaluate(() => [...document.querySelectorAll('.sw-toast')].map(n => n.textContent));
const shownToasts = page => page.evaluate(() => [...document.querySelectorAll('.sw-toast')].filter(n => n.style.display !== 'none').length);
const clearToasts = page => page.evaluate(() => { document.querySelectorAll('.sw-toast').forEach(n => n.remove()); if (window.__toastLog) window.__toastLog.length = 0; });
/** Was a toast matching `re` shown since the last clearToasts (still on screen or already gone)? */
const sawToast = (page, re) => page.evaluate(src => { const r = new RegExp(src); return [...document.querySelectorAll('.sw-toast')].some(n => r.test(n.textContent)) || (window.__toastLog || []).some(x => r.test(x)); }, re.source);
/** One real frame of the flight screen (input edges → actions → world.step → HUD). */
const tick = (page, n = 1) => page.evaluate(n => { const a = window.__sw.app; for (let i = 0; i < n; i++) { if (a.currentName === 'flight' && !a.flight.paused) { a.current.update(0.02); a.input.endFrame(); } } }, n);
const key = async (page, code, hold = 60) => { await page.keyboard.down(code); await page.waitForTimeout(hold); await tick(page); await page.keyboard.up(code); await page.waitForTimeout(30); await tick(page); };
/** Advance the game by calling update(dt); stops early when `until` (a JS expression using w, v, f) is true. */
async function ff(page, simSeconds, until = 'false', dt = 0.05) {
  let left = simSeconds, hit = false;
  while (left > 0 && !hit) {
    const r = await page.evaluate(({ budget, until, dt }) => {
      const sw = window.__sw, app = sw.app, f = app.flight;
      const test = new Function('w', 'v', 'f', 'return (' + until + ');');
      const t0 = performance.now(); let sim0 = sw.world ? sw.world.ut : 0, hit = false, n = 0;
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
/** Snapshot for assertions. */
const tel = page => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, f = sw.app.flight;
  const v = w.active && !w.active.dead ? w.active : null;
  const fuelOf = (vv, type) => { const p = vv.partList.find(q => q.def.id === type); return p ? p.res.fuel : null; };
  return {
    ut: w.ut, vessels: w.vessels.filter(x => !x.dead).map(x => ({ id: x.id, name: x.name, type: x.type, parts: x.parts.size })),
    speedMode: f.state.speedMode, assist: f.assist ? f.assist.phase : null, assistKind: f.assistKind,
    hud: JSON.parse(JSON.stringify(f.hud.values)), panel: f.hud.panelKind,
    v: v && { id: v.id, name: v.name, parts: v.parts.size, targetId: v.targetId ?? null, sas: v.ctrl.sas, sasMode: v.ctrl.sasMode, rcs: v.ctrl.rcs,
      ti: v.targetInfo ? { name: v.targetInfo.name, distance: v.targetInfo.distance, relSpeed: v.targetInfo.relSpeed } : null,
      docked: v.dockedPairs, freePorts: v.dockPorts.length, stamp: v.structureStamp, mono: v.resources.mono ? v.resources.mono.amount : 0,
      fuel: v.resources.fuel ? v.resources.fuel.amount : 0, crew: v.crew, m400: fuelOf(v, 'tank_m400'),
      noseErr: v.targetInfo ? new (v.pos.constructor)(0, 1, 0).applyQuaternion(v.q).angleTo(v.targetInfo.dir) * 180 / Math.PI : null },
  };
});
/** Do two visible elements overlap? (CSS selectors; hidden / missing elements never overlap) */
const overlap = (page, a, b) => page.evaluate(([a, b]) => {
  const rect = sel => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(n).visibility !== 'hidden' ? r : null; };
  const ra = rect(a), rb = rect(b);
  if (!ra || !rb) return false;
  return ra.left < rb.right - 1 && rb.left < ra.right - 1 && ra.top < rb.bottom - 1 && rb.top < ra.bottom - 1;
}, [a, b]);
const visible = (page, sel) => page.evaluate(sel => { const n = document.querySelector(sel); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 1 && r.height > 1; }, sel);
const inView = (page, sel) => page.evaluate(sel => { const n = document.querySelector(sel); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 1 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; }, sel);

async function layout(page, label) {
    await tick(page, 12); await page.waitForTimeout(300);
    const pairs = [['[data-hud="time"]', '[data-hud="tools"]'], ['[data-hud="vessel"]', '[data-hud="time"]'], ['[data-hud="panel"]', '[data-hud="tools"]'], ['[data-hud="panel"]', '[data-hud="console"]'], ['[data-hud="panel"]', '[data-hud="crew"]'], ['[data-hud="panel"]', '[data-hud="resources"]'], ['[data-hud="panel"]', '[data-hud="stages"]'], ['[data-hud="panel"]', '[data-hud="vessel"]'], ['[data-hud="panel"]', '[data-hud="time"]'], ['[data-hud="panel"]', '[data-hud="hint"]'], ['[data-hud="panel"]', '[data-hud="target"]'],
      ['[data-hud="target"]', '.fl-above'], ['[data-hud="target"]', '[data-hud="resources"]'], ['[data-hud="target"]', '[data-hud="vessel"]'], ['[data-hud="targetmodes"]', '.fl-lights'], ['[data-hud="targetmodes"]', '[data-hud="throttle"]'],
      ['[data-hud="targetmodes"]', '[data-hud="ball"]'], ['[data-hud="sasmodes"]', '[data-hud="ball"]'], ['[data-hud="stages"]', '[data-hud="console"]'], ['[data-hud="crew"]', '[data-hud="console"]'], ['[data-hud="resources"]', '[data-hud="altitude"]'], ['[data-hud="altitude"]', '[data-hud="time"]'], ['[data-hud="altitude"]', '[data-hud="target"]'], ['[data-hud="resources"]', '[data-hud="tools"]']];
    const bad = [];
    for (const [a, b] of pairs) if (await overlap(page, a, b)) bad.push(a + ' × ' + b);
    ok(bad.length === 0, `${label}: nothing overlaps (${bad.join('; ') || 'checked ' + pairs.length + ' pairs'})`);
    ok(await inView(page, '[data-hud="tools"]') && await inView(page, '[data-hud="console"]') && (!(await visible(page, '[data-hud="panel"]')) || await inView(page, '[data-hud="panel"]')), `${label}: tool bar, console and panel are fully on screen`);
  }

async function startSandbox(page) {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
  await page.click('[data-action="new"]');
  await page.click('.sw-mode[data-mode="sandbox"]');
  await page.click('.sw-modal .sw-btn.primary');
  await waitScreen(page, 'hub');
}

/** Both stock crafts in a 90 km orbit, the chaser 45 m in front of the target's ring and 6 m to the side, turned away. */
async function setUpOrbit(page) {
  return page.evaluate(async () => {
    const base = location.origin + '/js/';
    const [{ World }, { stockCrafts }, { Orbit }, { SYSTEM }, THREE] = await Promise.all([
      import(base + 'core/world.js'), import(base + 'core/craft.js'), import(base + 'core/orbit.js'), import(base + 'core/bodies.js'), import(base + 'lib/three.module.min.js')]);
    const sw = window.__sw, career = sw.career || sw.app.career;
    const stock = name => stockCrafts().find(c => c.name === name);
    // orbital configuration: drop everything below the separator that carries the big launch tank
    const trim = craft => {
      const seps = craft.parts.filter(p => p.type === 'dec_m');
      const low = seps.filter(d => craft.subtree(d).some(p => p.type === 'tank_m800')).sort((x, y) => craft.subtree(x).length - craft.subtree(y).length)[0];
      if (low) craft.removePart(low.id);
      craft.autoStage();
      return craft;
    };
    const home = SYSTEM.home;
    const o = Orbit.fromElements({ a: home.radius + 90000, e: 0 }, home.gm, 0);
    const s = o.stateAt(0);
    const w = new World({ ut: career.ut || 0 });
    const tgt = w.spawn(trim(stock('Latch Target')), { pos: s.r, vel: s.v, makeActive: false });
    tgt.ctrl.sas = true; tgt.ctrl.sasMode = 'hold';
    const nose = new THREE.Vector3(0, 1, 0).applyQuaternion(tgt.q), side = new THREE.Vector3(1, 0, 0).applyQuaternion(tgt.q);
    const pilot = (career.availableCrew ? career.availableCrew() : career.roster)[0];
    const chaser = w.spawn(trim(stock('Latch Chaser')), { crew: pilot ? [pilot.name] : [], pos: s.r.clone().addScaledVector(nose, 45).addScaledVector(side, 6), vel: s.v });
    chaser.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.0);      // pointing somewhere else entirely
    chaser.ctrl.sas = true; chaser.ctrl.sasMode = 'hold';
    const info = { target: { id: tgt.id, parts: tgt.parts.size, fuel: tgt.resources.fuel.amount }, chaser: { id: chaser.id, parts: chaser.parts.size, fuel: chaser.resources.fuel.amount, crew: chaser.crew.slice() } };
    career.flightState = w.toJSON();
    await sw.app.goto('flight', { resume: true });
    return info;
  });
}

// =====================================================================================================
async function main() {
  const { ctx, page } = await newPage(1440, 900);
  await startSandbox(page);
  console.log('=== set-up: Latch Target + Latch Chaser in orbit ===');
  const setup = await setUpOrbit(page);
  await waitScreen(page, 'flight');
  await page.waitForTimeout(1000);
  await tick(page, 3);
  let t = await tel(page);
  ok(t.vessels.length === 2 && t.v && t.v.name === 'Latch Chaser', `two vessels in flight, flying the chaser (${t.vessels.map(x => x.name).join(', ')})`);
  ok(t.v.freePorts === 1 && setup.target.parts > 4 && setup.chaser.crew.length === 1, `the chaser has a free Latch Ring and a Pip aboard (${setup.chaser.crew.join(', ')})`);
  await E(page, () => { const h = window.__sw.app.flight.actions; h.dismissHint && h.dismissHint(); });

  // ------------------------------------------------------------------------------- 1. before any target
  console.log('=== 1. no target yet ===');
  ok(!(await visible(page, '[data-hud="target"]')), 'the target read-out is hidden without a target');
  ok(await visible(page, '[data-sas="target"]') && await visible(page, '[data-sas="antiTarget"]') && await visible(page, '[data-sas="relPrograde"]') && await visible(page, '[data-sas="relRetrograde"]'), 'the four target SAS buttons are on the console');
  ok(await E(page, () => ['target', 'antiTarget', 'relPrograde', 'relRetrograde'].every(m => document.querySelector(`[data-sas="${m}"]`).classList.contains('off'))), 'they are dimmed while there is no target');
  await page.click('[data-sas="target"]'); await tick(page);
  t = await tel(page);
  ok(t.v.sasMode !== 'target' && (await toasts(page)).some(x => /No target set/.test(x)), 'clicking one explains that a target is needed');
  await key(page, 'KeyC'); const m1 = (await tel(page)).speedMode; await key(page, 'KeyC'); const m2 = (await tel(page)).speedMode;
  ok(m1 !== 'target' && m2 !== 'target' && m1 !== m2, `C only cycles surface / orbit without a target (${m1}, ${m2})`);
  ok(await E(page, () => window.__sw.app.flight.ball.markerAt('target') === null), 'no target marker on the ball');
  await clearToasts(page);

  // ------------------------------------------------------------------------------- 2. set the target with Y
  console.log('=== 2. target with the Y key ===');
  await key(page, 'KeyY');
  await tick(page, 12);
  t = await tel(page);
  ok(t.v.targetId === setup.target.id, 'Y targets the nearest vessel (Latch Target)');
  ok(await sawToast(page, /Target: Latch Target/), 'a toast names the new target');
  ok(await visible(page, '[data-hud="target"]'), 'the target read-out appears');
  const card = await E(page, () => document.querySelector('[data-hud="target"]').innerText.replace(/\s+/g, ' '));
  ok(/Latch Target/.test(card) && /Dist\s*4\d(\.\d)?\s*m/i.test(card) && /Rel\s*\d+\.\d\d\s*m\/s/i.test(card), `it shows the name, distance and relative speed ("${card}")`);
  ok(t.hud.target && t.hud.target.name === 'Latch Target' && Math.abs(t.hud.target.distance - t.v.ti.distance) < 0.5 && t.hud.target.distance > 35 && t.hud.target.distance < 55, `hud.values.target follows vessel.targetInfo (${t.hud.target && t.hud.target.distance.toFixed(1)} m)`);
  ok(t.hud.target.approach && Number.isFinite(t.hud.target.approach.distance) && /Closest/i.test(card), `closest approach on the present orbits is shown (${t.hud.target.approach && t.hud.target.approach.distance.toFixed(0)} m)`);
  ok(await E(page, () => ['target', 'antiTarget', 'relPrograde', 'relRetrograde'].every(m => !document.querySelector(`[data-sas="${m}"]`).classList.contains('off'))), 'the target SAS buttons light up');
  // navball: marker direction and the pixels actually drawn on the overlay canvas
  await page.waitForTimeout(500);      // let a real frame draw the overlay
  const mk = await E(page, () => {
    const f = window.__sw.app.flight, v = window.__sw.world.active;
    const p = f.ball.markerAt('target'), a = f.ball.markerAt('antiTarget');
    if (!p || !a) return null;
    const expect = { x: v.targetInfo.dir.clone().applyQuaternion(v.q.clone().invert()).x, y: v.targetInfo.dir.clone().applyQuaternion(v.q.clone().invert()).z };
    // where drawOverlay puts it: clamped to the rim when off the visible half
    let x = p.x, y = p.y; const l = Math.hypot(x, y) || 1;
    if (!p.front) { x = x / l * 0.93; y = y / l * 0.93; } else if (l > 0.93) { x *= 0.93 / l; y *= 0.93 / l; }
    const c = f.hud.overlay, g = c.getContext('2d'), R = c.width / 2;
    const cx = Math.round(R + x * R), cy = Math.round(R - y * R), win = Math.round(R * 0.12);
    const d = g.getImageData(Math.max(0, cx - win), Math.max(0, cy - win), win * 2, win * 2).data;
    let orchid = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 60 && d[i] > 110 && d[i + 2] > 120 && d[i + 1] < d[i] * 0.7 && d[i + 2] >= d[i] * 0.9) orchid++;   // orchid, also when dimmed on the far side
    return { p, a, expect, orchid, kinds: f.ball.markers.map(m => m.kind) };
  });
  ok(mk && Math.abs(mk.p.x - mk.expect.x) < 1e-6 && Math.abs(mk.p.y - mk.expect.y) < 1e-6, 'the ball has a target marker in the direction of the target');
  ok(mk && Math.abs(mk.a.x + mk.p.x) < 1e-6 && Math.abs(mk.a.y + mk.p.y) < 1e-6 && mk.a.front !== mk.p.front, 'and an anti-target marker directly opposite');
  ok(mk && mk.orchid > 6, `the target glyph is drawn on the ball overlay (${mk && mk.orchid} orchid pixels at the marker)`);
  await shot(page, 'docking-01-target-set');

  // ------------------------------------------------------------------------------- 3. the target list panel
  console.log('=== 3. target list panel ===');
  await page.click('[data-tool="target"]'); await tick(page, 12);
  ok(await visible(page, '[data-panel="target"]'), 'the Target button opens the list');
  const rows = await E(page, () => [...document.querySelectorAll('[data-panel="target"] [data-target]')].map(r => ({ id: r.dataset.target, kind: r.dataset.kind, cur: r.classList.contains('cur'), text: r.innerText.replace(/\s+/g, ' ') })));
  ok(rows.some(r => r.kind === 'vessel' && /Latch Target/.test(r.text) && r.cur && /Vessel · 4\d/.test(r.text)), `Latch Target is listed with its distance and marked as current (${rows.filter(r => r.kind === 'vessel').map(r => r.text).join(' | ')})`);
  ok(rows.some(r => r.kind === 'body' && /Pell/.test(r.text)) && rows.some(r => r.kind === 'body' && /Thal/.test(r.text)) && !rows.some(r => /Verda|Helion/.test(r.text)), 'the other worlds are listed too (not the one being orbited, not the star)');
  await shot(page, 'docking-02-target-panel');
  await page.click('[data-panel="target"] .fl-pop-row.cur [data-action="clear-target"]'); await tick(page, 12);
  t = await tel(page);
  ok(t.v.targetId === null && !(await visible(page, '[data-hud="target"]')) && (await sawToast(page, /Target cleared/)), 'Clear drops the target and hides the read-out');
  await page.click('[data-panel="target"] [data-target="pell"] [data-action="target"]'); await tick(page, 12);
  t = await tel(page);
  ok(t.v.targetId === 'pell' && t.hud.target && t.hud.target.kind === 'body' && t.hud.target.distance > 1e6, `a world can be targeted from the list (Pell, ${t.hud.target && (t.hud.target.distance / 1e6).toFixed(1)} Mm)`);
  await page.click(`[data-panel="target"] [data-target="${setup.target.id}"] [data-action="target"]`); await tick(page, 12);
  t = await tel(page);
  ok(t.v.targetId === setup.target.id, 'Set on the vessel row targets it again');
  await key(page, 'Escape');
  ok((await tel(page)).panel === null, 'Esc closes the panel');
  // Shift+Y clears, Y sets again
  await page.keyboard.down('ShiftLeft'); await key(page, 'KeyY'); await page.keyboard.up('ShiftLeft'); await tick(page, 3);
  ok((await tel(page)).v.targetId === null, 'Shift+Y clears the target');
  await key(page, 'KeyY'); await tick(page, 12);
  ok((await tel(page)).v.targetId === setup.target.id, 'Y sets it again');
  await clearToasts(page);

  // ------------------------------------------------------------------------------- 4. speed mode + SAS modes
  console.log('=== 4. target speed mode and SAS modes ===');
  const modes = [];
  for (let i = 0; i < 3; i++) { await key(page, 'KeyC'); modes.push((await tel(page)).speedMode); }
  ok(modes.includes('target') && modes.includes('orbit') && modes.includes('surface'), `C now cycles through three modes (${modes.join(' → ')})`);
  while ((await tel(page)).speedMode !== 'target') await key(page, 'KeyC');
  await tick(page, 12);
  t = await tel(page);
  const chip = await E(page, () => document.querySelector('[data-hud="speedmode"]').textContent);
  ok(chip === 'Target' && Math.abs(t.hud.speed - t.v.ti.relSpeed) < 0.05, `the speed read-out shows the speed relative to the target (${t.hud.speed.toFixed(2)} m/s, chip "${chip}")`);
  await page.click('[data-sas="target"]'); await tick(page, 2);
  ok((await tel(page)).v.sasMode === 'target', 'the target SAS button selects mode "target"');
  await ff(page, 60, 'v && v.targetInfo && Math.acos(Math.min(1, new (v.pos.constructor)(0, 1, 0).applyQuaternion(v.q).dot(v.targetInfo.dir))) < 0.05');
  t = await tel(page);
  ok(t.v.noseErr < 4, `SAS turns the nose onto the target (${t.v.noseErr.toFixed(1)}° off)`);
  await page.waitForTimeout(400);
  const centred = await E(page, () => { const p = window.__sw.app.flight.ball.markerAt('target'); return p && p.front && Math.hypot(p.x, p.y) < 0.1; });
  ok(centred, 'the target marker sits under the nose reticle');
  for (const m of ['antiTarget', 'relPrograde', 'relRetrograde']) {
    await page.click(`[data-sas="${m}"]`); await tick(page, 12);
    const on = await E(page, m => document.querySelector(`[data-sas="${m}"]`).classList.contains('on'), m);
    ok((await tel(page)).v.sasMode === m && on, `SAS button ${m} selects and lights that mode`);
  }
  await E(page, () => window.__sw.app.flight.actions.setSasMode('hold'));
  // the read-out, the hint and the list at both window sizes
  await page.click('[data-tool="target"]'); await tick(page, 12);
  await layout(page, '1440×900, target set, Target panel');
  await page.setViewportSize({ width: 1024, height: 768 }); await page.waitForTimeout(500);
  await layout(page, '1024×768, target set, Target panel');
  await shot(page, 'docking-02b-target-1024');
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(500);
  await key(page, 'Escape');

  // ------------------------------------------------------------------------------- 5. docking
  console.log('=== 5. docking (flown by the docking assist) ===');
  await page.click('[data-tool="dock"]'); await tick(page, 12);
  const dockTxt = await E(page, () => document.querySelector('[data-panel="dock"]').innerText.replace(/\s+/g, ' '));
  ok(/Docked \(0\)/i.test(dockTxt) && /Free Latch Rings \(1\)/i.test(dockTxt) && /Latch Ring S/.test(dockTxt) && /Docking assist/.test(dockTxt), 'the Dock panel lists the free ring and offers the docking assist');
  ok(await E(page, () => !document.querySelector('[data-action="dock-assist"]').disabled), 'the assist is available 45 m from a vessel with a matching ring');
  await shot(page, 'docking-03-dock-panel');
  const before = await E(page, () => { const f = window.__sw.app.flight, v = window.__sw.world.active; const view = f.view.views.get(v); return { builds: view.builds, meshes: view.parts.size, views: f.view.views.size, stamp: v.structureStamp }; });
  await page.click('[data-action="dock-assist"]'); await tick(page, 12);
  t = await tel(page);
  ok(t.assistKind === 'dock' && t.assist && t.hud.alerts.some(a => /Docking assist/.test(a)), `the docking assist takes over (${t.assist}; alerts: ${t.hud.alerts.join(', ')})`);
  ok(!(await visible(page, '[data-tool="assist"]')) || !(await E(page, () => document.querySelector('[data-tool="assist"]').classList.contains('active'))), 'the ascent-assist button is not lit by it');
  await key(page, 'Escape');
  await ff(page, 40);
  await shot(page, 'docking-04-approach');
  t = await tel(page);
  ok(t.v.rcs && t.v.ti && t.v.ti.relSpeed < 3.5, `it flies on RCS at a gentle pace (${t.v.ti && t.v.ti.relSpeed.toFixed(2)} m/s)`);
  await clearToasts(page);
  const docked = await ff(page, 1500, 'w.vessels.filter(x => !x.dead).length === 1');
  await tick(page, 12);
  t = await tel(page);
  ok(docked && t.vessels.length === 1, `the two vessels dock (T+${Math.round(t.ut)} s)`);
  ok(t.v.name === 'Latch Chaser' && t.v.parts === setup.target.parts + setup.chaser.parts && t.v.docked.length === 1 && t.v.freePorts === 0, `one vessel with all ${setup.target.parts + setup.chaser.parts} parts and one mated pair`);
  const tt = await toasts(page);
  ok(tt.some(x => /Docked with Latch Target/.test(x)), `a toast announces the docking (${tt.join(' | ')})`);
  ok(!tt.some(x => /Target cleared|Target lost/.test(x)), 'no stray "target cleared / lost" toast');
  ok(t.assist === null && t.assistKind === '' && t.v.targetId === null && !(await visible(page, '[data-hud="target"]')), 'the assist lets go and the target read-out disappears');
  ok(t.speedMode !== 'target', `the speed read-out leaves target mode (${t.speedMode})`);
  await page.waitForTimeout(600);
  const after = await E(page, () => {
    const f = window.__sw.app.flight, v = window.__sw.world.active, view = f.view.views.get(v);
    let wrong = 0, flipped = 0, flippedDown = 0;
    for (const [id, e] of view.parts) {
      const p = v.parts.get(id);
      if (!p || p !== e.part) { wrong++; continue; }
      const up = new (v.pos.constructor)(0, 1, 0).applyQuaternion(e.mesh.quaternion);
      if (p.flip) { flipped++; if (up.y < -0.999) flippedDown++; } else if (up.y < 0.999) wrong++;
      const want = { x: p.pos.x - v.com.x, y: p.pos.y - v.com.y, z: p.pos.z - v.com.z };
      if (Math.hypot(e.mesh.position.x - want.x, e.mesh.position.y - want.y, e.mesh.position.z - want.z) > 1e-3) wrong++;
    }
    return { builds: view.builds, meshes: view.parts.size, parts: v.parts.size, views: f.view.views.size, stamp: view.stamp, vstamp: v.structureStamp, wrong, flipped, flippedDown, children: view.group.children.filter(c => c.userData && c.type === 'Group').length };
  });
  ok(after.builds > before.builds && after.meshes === after.parts && after.stamp === after.vstamp && after.vstamp !== before.stamp, `the vessel's meshes were rebuilt for the new structure (${before.meshes} → ${after.meshes} part meshes, build #${after.builds})`);
  ok(after.views === 1 && before.views === 2, 'the absorbed vessel no longer has a view of its own');
  ok(after.flipped > 3 && after.flippedDown === after.flipped && after.wrong === 0, `flipped parts (${after.flipped}) are drawn upside down, everything sits where the sim says`);
  await shot(page, 'docking-05-docked');

  // ------------------------------------------------------------------------------- 6. fuel transfer
  console.log('=== 6. fuel transfer ===');
  // the station arrives half empty so there is room on its side
  const pre = await E(page, () => {
    const f = window.__sw.app.flight, v = window.__sw.world.active;
    const tanks = f.actions.transferParts('fuel');
    const mine = tanks.find(p => p.side === 'Latch Chaser'), theirs = tanks.find(p => p.side === 'Latch Target');
    v.parts.get(theirs.id).res.fuel = 400; v.updateResources();
    return { tanks, mine: mine.id, theirs: theirs.id, kinds: f.actions.transferResources() };
  });
  ok(pre.tanks.length >= 2 && pre.tanks.every(p => p.side === 'Latch Chaser' || p.side === 'Latch Target') && pre.kinds.includes('fuel'), `tanks of both vessels are offered, labelled by side (${pre.tanks.map(p => p.name + ' · ' + p.side).join(', ')})`);
  await tick(page, 12);
  ok(await visible(page, '[data-tool="fuel"]'), 'the Fuel button is on the tool bar');
  await page.click('[data-tool="fuel"]'); await tick(page, 12);
  ok(await visible(page, '[data-panel="fuel"]') && await visible(page, '[data-xfer="from"]') && await visible(page, '[data-xfer="to"]') && await visible(page, '[data-xfer="amount"]'), 'the Fuel panel has source, destination and amount');
  await page.selectOption('[data-xfer="from"]', String(pre.mine)); await tick(page, 12);
  await page.selectOption('[data-xfer="to"]', String(pre.theirs)); await tick(page, 12);
  const amounts = () => E(page, ids => { const v = window.__sw.world.active; return { a: v.parts.get(ids[0]).res.fuel, b: v.parts.get(ids[1]).res.fuel, ma: v.parts.get(ids[0]).def.res.fuel, mb: v.parts.get(ids[1]).def.res.fuel, total: v.resources.fuel.amount }; }, [pre.mine, pre.theirs]);
  const a0 = await amounts();
  await page.fill('[data-xfer="amount"]', '150');
  await clearToasts(page);
  await page.click('[data-panel="fuel"] [data-action="transfer"]'); await tick(page, 12);
  const a1 = await amounts();
  ok(Math.abs((a0.a - a1.a) - 150) < 1e-6 && Math.abs((a1.b - a0.b) - 150) < 1e-6 && Math.abs(a1.total - a0.total) < 1e-6, `Transfer moves exactly 150 kg from the chaser to the station (${a0.a} → ${a1.a}, ${a0.b} → ${a1.b})`);
  ok((await toasts(page)).some(x => /Moved 150 kg of propellant/.test(x)), 'a toast confirms the amount');
  const gaugeTxt = await E(page, () => [...document.querySelectorAll('[data-panel="fuel"] .fl-xfer-gauges .amt')].map(n => n.textContent).join(' / '));
  ok(new RegExp(String(Math.round(a1.b))).test(gaugeTxt.replace(/,/g, '')), `the gauges in the panel follow (${gaugeTxt})`);
  await shot(page, 'docking-06-fuel-panel');
  await page.click('[data-panel="fuel"] [data-action="balance"]'); await tick(page, 12);
  const a2 = await amounts();
  ok(Math.abs(a2.a / a2.ma - a2.b / a2.mb) < 1e-6 && Math.abs(a2.total - a0.total) < 1e-6, `Balance equalises the fill level (${(a2.a / a2.ma * 100).toFixed(1)} % and ${(a2.b / a2.mb * 100).toFixed(1)} %)`);
  await page.click('[data-panel="fuel"] [data-action="transfer-all"]'); await tick(page, 12);
  const a3 = await amounts();
  ok((a3.a < 1e-6 || Math.abs(a3.b - a3.mb) < 1e-6) && Math.abs(a3.total - a0.total) < 1e-6, `All pumps until the source is empty or the destination full (${a3.a.toFixed(0)} / ${a3.b.toFixed(0)} kg)`);
  await page.click('[data-panel="fuel"] [data-action="swap"]'); await tick(page, 12);
  ok(await E(page, ids => { const x = window.__sw.app.flight.hud.xfer; return x.from === ids[1] && x.to === ids[0]; }, [pre.mine, pre.theirs]), 'the swap button exchanges source and destination');
  const kinds = await E(page, () => window.__sw.app.flight.actions.transferResources());
  if (kinds.includes('elec')) { await page.click('[data-panel="fuel"] [data-res="elec"]'); await tick(page, 12); }
  const elecSel = await E(page, () => ({ res: window.__sw.app.flight.hud.xfer.res, options: document.querySelectorAll('[data-xfer="from"] option').length, unit: document.querySelector('[data-panel="fuel"] .unit').textContent }));
  ok(kinds.includes('elec') && elecSel.res === 'elec' && elecSel.options >= 2 && elecSel.unit === 'EC', `charge can be moved too: the panel switches resource (${kinds.join(', ')}; ${elecSel.options} batteries)`);

  // ------------------------------------------------------------------------------- 7. layout at both sizes
  console.log('=== 7. layout ===');
  await layout(page, '1440×900, docked, Fuel panel');
  await page.setViewportSize({ width: 1024, height: 768 }); await page.waitForTimeout(500);
  await layout(page, '1024×768, docked, Fuel panel');
  await shot(page, 'docking-07-fuel-1024');
  await page.click('[data-tool="dock"]'); await tick(page, 12);
  await layout(page, '1024×768, docked, Dock panel');
  await shot(page, 'docking-08-dock-1024');
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(500);

  // ------------------------------------------------------------------------------- 8. undock
  console.log('=== 8. undock ===');
  const drow = await E(page, () => [...document.querySelectorAll('[data-panel="dock"] [data-docked]')].map(r => r.innerText.replace(/\s+/g, ' ')));
  ok(drow.length === 1 && /Latch Target/.test(drow[0]) && /Undock/.test(drow[0]), `the Dock panel lists the mated pair with an Undock button ("${drow.join(' | ')}")`);
  const fuelBefore = (await tel(page)).v.fuel;
  await clearToasts(page);
  const b2 = await E(page, () => window.__sw.app.flight.view.views.get(window.__sw.world.active).builds);
  await page.click('[data-panel="dock"] [data-docked] [data-action="undock"]'); await tick(page, 12);
  t = await tel(page);
  ok(t.vessels.length === 2 && t.v.name === 'Latch Chaser' && t.vessels.some(x => x.name === 'Latch Target' && x.type === 'ship'), `undocking gives two vessels again (${t.vessels.map(x => x.name + ' ' + x.parts).join(', ')})`);
  ok(t.v.parts === setup.chaser.parts && t.vessels.find(x => x.name === 'Latch Target').parts === setup.target.parts && t.v.docked.length === 0 && t.v.freePorts === 1, 'each side has its own parts back and the ring is free');
  ok(t.v.crew.join() === setup.chaser.crew.join(), 'the Pip is still aboard the chaser');
  ok((await toasts(page)).some(x => /Undocked from Latch Target/.test(x)), 'a toast announces the undocking');
  const stationFuel = await E(page, () => { const w = window.__sw.world; return w.vessels.find(x => x !== w.active && !x.dead).resources.fuel.amount; });
  ok(Math.abs(stationFuel - a3.b) < 1e-6 && Math.abs(t.v.fuel - a3.a) < 1e-6 && Math.abs(stationFuel + t.v.fuel - fuelBefore) < 1e-6, `the pumped fuel leaves with the station (${stationFuel.toFixed(0)} kg there, ${t.v.fuel.toFixed(0)} kg here)`);
  await page.waitForTimeout(600); await tick(page, 3);
  const un = await E(page, () => {
    const f = window.__sw.app.flight, w = window.__sw.world, v = w.active, other = w.vessels.find(x => x !== v && !x.dead);
    const va = f.view.views.get(v), vb = f.view.views.get(other);
    const upOk = view => [...view.parts.values()].every(e => { const up = new (v.pos.constructor)(0, 1, 0).applyQuaternion(e.mesh.quaternion); return e.part.flip ? up.y < -0.999 : up.y > 0.999; });
    return { views: f.view.views.size, a: va && { builds: va.builds, n: va.parts.size, parts: v.parts.size, up: upOk(va) }, b: vb && { n: vb.parts.size, parts: other.parts.size, up: upOk(vb), flips: other.partList.filter(p => p.flip).length } };
  });
  ok(un.views === 2 && un.a && un.b && un.a.n === un.a.parts && un.b.n === un.b.parts && un.a.builds > b2, `both vessels have their own rebuilt meshes (${un.a && un.a.n} + ${un.b && un.b.n})`);
  ok(un.a && un.b && un.a.up && un.b.up && un.b.flips === 0, 'no part is left upside down after the split');
  const dockTxt2 = await E(page, () => document.querySelector('[data-panel="dock"]').innerText.replace(/\s+/g, ' '));
  ok(/Docked \(0\)/i.test(dockTxt2) && /Free Latch Rings \(1\)/i.test(dockTxt2), 'the Dock panel is back to "nothing docked, one free ring"');
  await ff(page, 8);
  const sep = await E(page, () => { const w = window.__sw.world, v = w.active, o = w.vessels.find(x => x !== v && !x.dead); return { d: v.pos.distanceTo(o.pos), rel: v.vel.distanceTo(o.vel) }; });
  ok(sep.rel > 0.2 && sep.rel < 0.5 && (await tel(page)).vessels.length === 2, `the halves drift apart at about 0.3 m/s and do not latch again (${sep.rel.toFixed(2)} m/s)`);
  await key(page, 'Escape');
  await shot(page, 'docking-09-undocked');

  // ------------------------------------------------------------------------------- 9. events: target lost / removed vessels
  console.log('=== 9. stale selections ===');
  await key(page, 'KeyY'); await tick(page, 12);
  ok((await tel(page)).v.targetId === setup.target.id || (await tel(page)).v.targetId !== null, 'the station can be targeted again after undocking');
  await key(page, 'KeyM'); await page.waitForTimeout(600); await tick(page, 3);
  const sel = await E(page, () => { const f = window.__sw.app.flight, w = window.__sw.world; const o = w.vessels.find(x => x !== w.active && !x.dead); f.map.select(o); return f.map.selection === o; });
  ok(sel, 'the station is selected in the map');
  await shot(page, 'docking-10-map-target');
  await clearToasts(page);
  // what the World does when a vessel on rails burns up: announce it, then drop it
  await E(page, () => { const w = window.__sw.world; const o = w.vessels.find(x => x !== w.active && !x.dead); w.emit('message', { text: `Vessel "${o.name}" burned up in the atmosphere of ${o.body.name}`, vessel: o, reason: 'atmosphere', kind: 'removed' }); w.removeVessel(o); });
  await tick(page, 12);
  t = await tel(page);
  const st = await E(page, () => ({ sel: window.__sw.app.flight.map.selection, n: window.__sw.world.vessels.length }));
  ok(st.sel === null, 'a "removed" message clears the map selection');
  ok(t.v.targetId === null && t.hud.target === null, 'the lost target is cleared from the vessel and the HUD');
  // at most two toasts are on screen at once: "Target lost" may wait its turn behind an older one, so give the queue time
  await page.waitForFunction(() => (window.__toastLog || []).some(x => /Target lost/.test(x)) || [...document.querySelectorAll('.sw-toast')].some(n => /Target lost/.test(n.textContent)), null, { timeout: 15000 }).catch(() => {});
  const lostToasts = [...new Set([...(await toasts(page)), ...(await page.evaluate(() => (window.__toastLog || []).slice()))])];
  ok(lostToasts.some(x => /burned up/.test(x)) && lostToasts.some(x => /Target lost/.test(x)) && !lostToasts.some(x => /Target cleared/.test(x)), `the player is told once (${lostToasts.join(' | ')})`);
  await key(page, 'KeyM'); await tick(page, 3);

  // ------------------------------------------------------------------------------- 10. toast queue
  console.log('=== 10. toast queue ===');
  await clearToasts(page);
  await E(page, () => { const a = window.__sw.app; for (let i = 1; i <= 5; i++) a.toast('Queued message ' + i, 'info'); });
  await page.waitForTimeout(150);
  const q0 = { shown: await shownToasts(page), all: (await toasts(page)).length };
  ok(q0.shown === 2 && q0.all === 5, `five toasts in a burst: two on screen, three waiting (${q0.shown} shown of ${q0.all})`);
  let maxShown = 0; const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const s = await E(page, () => [...document.querySelectorAll('.sw-toast')].filter(n => n.style.display !== 'none').map(n => n.textContent));
    maxShown = Math.max(maxShown, s.length); s.forEach(x => seen.add(x));
    if (seen.size === 5 && s.length === 0) break;
    await page.waitForTimeout(250);
  }
  ok(maxShown <= 2 && seen.size === 5, `never more than two at once, and all five get their turn (max ${maxShown}, saw ${seen.size})`);

  // ------------------------------------------------------------------------------- 11. save, leave, come back
  console.log('=== 11. leaving and resuming ===');
  await E(page, () => window.__sw.app.goto('hub'));
  await waitScreen(page, 'hub');
  ok(await page.locator('[data-action="resume"]').count() === 1, 'the hub offers to resume the flight');
  await page.click('[data-action="resume"]');
  await waitScreen(page, 'flight');
  await page.waitForTimeout(800); await tick(page, 3);
  t = await tel(page);
  ok(t.v && t.v.name === 'Latch Chaser' && t.v.freePorts === 1, 'the chaser is back under control');

  ok(problems.filter(p => !p.startsWith('FAILED')).length === 0, 'no console errors, page errors or failed requests');
  await ctx.close();
}

try { await main(); }
catch (err) { problems.push('test script crashed: ' + (err && err.stack || err)); console.error(err); }
finally { await browser.close(); await server.close(); }
console.log(`\n${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
