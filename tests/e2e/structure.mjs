// Structural dynamics on the flight screen (roadmap item 2): the HUD read-out, the stress overlay, visible flex,
// and what the player gets when a joint breaks. One flight of the stock "Trundle Lander": full throttle with SAS to
// about 30 kPa of dynamic pressure, then SAS off and a held pitch-up until the stack breaks.
//   NODE_PATH=/opt/node-tools/node_modules node tests/e2e/structure.mjs [outDir]
// Captures: <outDir>/structure-readout.png, structure-overlay.png, structure-break.png (default tests/out).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const QUALITY = process.env.QUALITY || 'medium';      // QUALITY=high for captures as a player with a graphics card sees them (slow here)
const problems = [];
let checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); };

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
/** Run the flight screen's own update loop for `sim` seconds, or until the expression over (w, v, f) is true. */
async function ff(sim, until = 'false', dt = 1 / 30) {
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
/** Hold the simulation still, let the picture settle for a few real frames, capture, and let it run again. */
async function shot(name, quick = false) {
  await E(() => { const sw = window.__sw, c = sw.app.current, f = sw.app.flight; c.__update = c.update; c.update = dt => { f.view.update(sw.world, dt, 0, f.cam); f.hud.update(sw.world, sw.world.active, f.state, 0); }; });
  for (let i = 0; i < 4 && !quick; i++) {
    const left = await E(() => { const f = window.__sw.app.flight, s = f && f.view, w = s && s.worlds; if (!w || !w.info || !s.settleTerrain) return 0; s.settleTerrain(2500); s.update(window.__sw.world, 1 / 30, 0, f.cam); return w.info.pending || 0; });
    if (!left) break;
  }
  await page.waitForTimeout(quick ? 250 : 700);
  const file = path.join(OUT, 'structure-' + name + '.png');
  await page.screenshot({ path: file, timeout: 180000 });
  await E(() => { const c = window.__sw.app.current; if (c.__update) { c.update = c.__update; delete c.__update; } });
  console.log('  captured ' + file);
}
const camTo = (yaw, pitch, dist) => E(o => { const c = window.__sw.app.flight.cam; c.yaw = o.yaw; c.pitch = o.pitch; if (c.setDist) c.setDist(o.dist); c.dist = o.dist; }, { yaw, pitch, dist });
const readout = () => E(() => {
  const n = document.querySelector('[data-hud="structure"]'), f = window.__sw.app.flight, v = window.__sw.world.active, st = v && v.structure;
  return { there: !!n, hidden: !n || n.classList.contains('sw-hidden'), cls: n ? n.className : '', pct: n ? n.querySelector('.amt').textContent : '', why: n ? n.querySelector('.fl-struct-why').textContent : '',
    value: f.hud.values.structure, valid: !!st && st.valid, maxUtil: st ? st.maxUtil : null, joints: st ? st.joints.length : 0 };
});

const t0 = Date.now();
try {
  // ---- a sandbox game, then the stock craft on the pad
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30000 });
  await E(() => document.querySelector('[data-action="new"]').click());
  await page.waitForSelector('.sw-mode[data-mode="sandbox"]', { state: 'attached' });
  await E(() => document.querySelector('.sw-mode[data-mode="sandbox"]').click());
  await E(() => document.querySelector('.sw-modal .sw-btn.primary').click());
  await waitScreen('hub');
  await E(q => { const s = window.__sw.app.settings; s.gfxForce = true; s.gfxQuality = q; s.gfxVegetation = 'low'; s.showHints = false; }, QUALITY);

  console.log('settings');
  {
    const r = await E(async () => {
      const app = window.__sw.app, { TUNING } = await import('/js/core/vessel.js');
      const out = { def: app.settings.structFail, tuned: TUNING.STRUCT_FAIL };
      app.settings.structFail = false; app.applySettings(); await new Promise(r => setTimeout(r, 50));
      out.off = TUNING.STRUCT_FAIL; out.saved = JSON.parse(localStorage.getItem('starwright.settings.v1')).structFail;
      app.settings.structFail = true; app.applySettings(); await new Promise(r => setTimeout(r, 50));
      out.on = TUNING.STRUCT_FAIL;
      return out;
    });
    ok(r.def === true && r.tuned === true, 'structural failures are on by default');
    ok(r.off === false && r.saved === false && r.on === true, 'the setting drives TUNING.STRUCT_FAIL and is saved');
    // the row in the Settings dialog
    const row = await E(async () => { const { settingsRows } = await import('/js/ui/hub.js'); const n = settingsRows(window.__sw.app); const i = n.querySelector('[data-setting="structFail"]'); return i ? { checked: i.checked, label: i.closest('.sw-setting').querySelector('b').textContent } : null; });
    ok(row && row.checked && row.label === 'Structural failures', 'Settings has a "Structural failures" switch');
  }

  await E(async () => {
    const { stockCrafts, stockSite } = await import('/js/core/craft.js');
    const { PARTS } = await import('/js/core/parts.js');
    const c = stockCrafts().find(c => c.name === 'Trundle Lander');
    const app = window.__sw.app;
    const seats = c.parts.reduce((n, p) => n + ((PARTS[p.type] && PARTS[p.type].crew) || 0), 0);
    app.launch(c, { crew: seats ? app.career.availableCrew().slice(0, 1).map(p => p.name) : [], site: stockSite ? stockSite(c) : 'pad' });
  });
  await waitScreen('flight');
  await page.waitForTimeout(1000);
  await E(() => {
    const w = window.__sw.world, app = window.__sw.app; window.__st = { breaks: [], stress: 0, toasts: [] };
    const toast = app.toast; app.toast = (text, ...rest) => { window.__st.toasts.push(String(text)); return toast.call(app, text, ...rest); };
    w.on('structure', e => window.__st.breaks.push({ a: e.joint.aName, b: e.joint.bName, kind: e.joint.kind, mode: e.mode, util: e.util, ut: w.ut, t: w.ut - (e.vessel.launchUt || 0),
      debrisParts: e.debris ? e.debris.parts.size : 0, debrisInWorld: !!e.debris && w.vessels.includes(e.debris), vessels: w.vessels.length }));
    w.on('stress', () => window.__st.stress++);
  });

  console.log('on the pad');
  let r = await readout();
  ok(r.there && !r.hidden, 'the HUD has a structure read-out for a multi-part vessel');
  ok(r.pct === '--' && /idle/.test(r.cls), 'it reads "--" and is dimmed on the pad (nothing to show yet): "' + r.pct + '"');

  // ---- lift off and climb
  console.log('climb');
  await E(() => { const w = window.__sw.world, v = w.active; v.ctrl.throttle = 1; v.ctrl.sas = true; window.__sw.app.flight.actions.stage(); });
  await ff(60, 'v && v.dynamicPressure > 12000');
  await ff(0.5);
  r = await readout();
  ok(r.valid && /^\d+%$/.test(r.pct), 'in flight the read-out shows a number: "' + r.pct + '" (worst joint ' + (r.maxUtil * 100).toFixed(1) + ' %)');
  ok(Number.isFinite(r.value) && Math.abs(r.value - r.maxUtil) < 0.25, 'and it follows structure.maxUtil');
  ok(/ \/ .+: .+, \d+ %$/.test(r.why), 'the detail line names the joint and the cause: "' + r.why + '"');
  await camTo(2.2, 0.12, 30);
  await shot('readout');

  // ---- the overlay
  console.log('overlay');
  const before = await E(() => ({ on: window.__sw.app.flight.view.stressOverlay, mesh: !!window.__sw.app.flight.view.stressMesh }));
  ok(before.on === false && before.mesh === false, 'the overlay is off, and nothing was built for it');
  await page.keyboard.down('Semicolon'); await page.waitForTimeout(60);
  await E(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); });
  await page.keyboard.up('Semicolon');
  await ff(0.2);
  let o = await E(() => { const f = window.__sw.app.flight, m = f.view.stressMesh; let joints = 0; for (const view of f.view.views.values()) if (view.vessel.structure) joints += view.vessel.structure.joints.length; return { on: f.view.stressOverlay, count: m ? m.count : -1, joints, visible: !!m && m.visible, cls: document.querySelector('[data-hud="structure"]').className }; });
  ok(o.on && o.visible && o.count === o.joints && o.count > 0, 'the ; key switches the overlay on: ' + o.count + ' bands for ' + o.joints + ' joints');
  ok(/\bon\b/.test(o.cls), 'the read-out shows that the overlay is on');
  ok(await E(() => window.__st.toasts.some(t => /^Stress overlay on/.test(t))), 'and a message says so');
  const nBefore = await E(() => window.__sw.world.vessels.length);

  // ---- the hard turn at high dynamic pressure
  console.log('hard turn');
  await ff(60, 'v && v.dynamicPressure > 30000');
  const q0 = await E(() => window.__sw.world.active.dynamicPressure);
  ok(q0 > 30000, 'reached 30 kPa of dynamic pressure (' + (q0 / 1000).toFixed(1) + ' kPa)');
  await E(() => { window.__sw.world.active.ctrl.sas = false; });
  await page.keyboard.down('KeyS');                       // pitch +1, held
  await ff(6, 'v && v.structure && v.structure.maxUtil > 0.8', 1 / 60);
  // a part mesh is where the flex puts it, not where the rigid craft has it
  const fl = await E(async () => {
    const THREE = await import('/js/lib/three.module.min.js');
    const f = window.__sw.app.flight, v = window.__sw.world.active, st = v.structure, view = f.view.views.get(v);
    const bent = st.updateFlex(), P = new THREE.Vector3(), R = new THREE.Vector3();
    let maxMove = 0, maxTurn = 0, maxErr = 0, n = 0;
    for (const e of view.parts.values()) {
      const p = e.part; if (p.def.wheel) continue;
      st.partFlex(p, P, R);
      const dx = e.mesh.position.x - (p.pos.x - v.com.x), dy = e.mesh.position.y - (p.pos.y - v.com.y), dz = e.mesh.position.z - (p.pos.z - v.com.z);
      maxMove = Math.max(maxMove, Math.hypot(dx, dy, dz));
      maxErr = Math.max(maxErr, Math.hypot(dx - P.x, dy - P.y, dz - P.z));
      maxTurn = Math.max(maxTurn, 2 * Math.acos(Math.min(1, Math.abs(e.mesh.quaternion.dot(e.q0)))));
      n++;
    }
    let bend = 0; for (const j of st.joints) bend = Math.max(bend, Math.hypot(j.bx, j.by, j.bz));
    return { bent, maxMove, maxTurn, maxErr, n, bend, util: st.maxUtil, text: f.hud.values.structureText, cls: document.querySelector('[data-hud="structure"]').className };
  });
  ok(fl.bent && fl.maxMove > 0.002, 'part meshes are displaced by the flex: up to ' + (fl.maxMove * 100).toFixed(1) + ' cm, turned up to ' + (fl.maxTurn * 180 / Math.PI).toFixed(2) + '° (largest joint bend ' + (fl.bend * 180 / Math.PI).toFixed(2) + '°)');
  ok(fl.maxErr < 1e-3 && fl.maxTurn > 1e-4, 'and they sit exactly where structure.partFlex puts them');
  ok(/warn|bad/.test(fl.cls), 'the read-out has changed colour at ' + (fl.util * 100).toFixed(0) + ' %: "' + fl.text + '"');
  await camTo(2.2, 0.12, 30);
  await shot('overlay');

  // ---- the break
  console.log('break');
  await ff(10, 'window.__st.breaks.length > 0', 1 / 60);
  const shown = await E(() => [...document.querySelectorAll('.sw-toast')].map(n => n.textContent));
  await camTo(2.2, 0.12, 34);
  await shot('break', true);                                // at once: the sparks last a second, the message seven
  await page.keyboard.up('KeyS');
  const b = await E(() => {
    const w = window.__sw.world, f = window.__sw.app.flight, v = w.active, view = f.view.views.get(v);
    return { breaks: window.__st.breaks, stress: window.__st.stress, vessels: w.vessels.length, ut: w.ut,
      toasts: window.__st.toasts, parts: v.parts.size, meshes: view ? view.parts.size : -1 };
  });
  ok(b.breaks.length >= 1, 'a joint broke ' + (b.breaks[0] ? b.breaks[0].t.toFixed(1) : '?') + ' s after lift-off: ' + JSON.stringify(b.breaks[0] || {}));
  ok(b.stress >= 1, 'a `stress` warning came first');
  ok(b.breaks[0] && b.breaks[0].debrisInWorld && b.breaks[0].debrisParts > 0 && b.vessels > nBefore, 'the far side became its own vessel (' + nBefore + ' → ' + b.vessels + ' vessels, ' + (b.breaks[0] || {}).debrisParts + ' parts broke away)');
  const msg = b.toasts.find(t => /broke/.test(t));
  ok(shown.some(t => /broke/.test(t)), 'the message is on screen');
  ok(!!msg && /: (bent too far|pulled apart|crushed|sheared off|twisted off)$/.test(msg), 'the player is told in plain words: "' + msg + '"');
  await ff(0.05, 'false', 1 / 60);
  const a = await E(() => { const w = window.__sw.world, f = window.__sw.app.flight, v = w.active, view = f.view.views.get(v), m = f.view.stressMesh; let joints = 0, flexed = 0; for (const vw of f.view.views.values()) { if (vw.vessel.structure) joints += vw.vessel.structure.joints.length; } for (const e of view.parts.values()) if (!v.parts.has(e.part.id)) flexed++; return { parts: v.parts.size, meshes: view.parts.size, stale: flexed, count: m.count, joints, views: f.view.views.size }; });
  ok(a.meshes === a.parts && a.stale === 0, 'the vessel is drawn with the parts it still has (' + a.parts + ')');
  ok(a.count === a.joints, 'the overlay follows the new part sets (' + a.count + ' bands, ' + a.views + ' vessels in view)');

  // ---- overlay off again (through the HUD button this time)
  await E(() => document.querySelector('[data-hud="structure"]').click());
  await ff(0.1);
  o = await E(() => { const f = window.__sw.app.flight, m = f.view.stressMesh; return { on: f.view.stressOverlay, count: m.count, visible: m.visible }; });
  ok(!o.on && o.count === 0 && !o.visible, 'a click on the read-out switches the overlay off');
  await ff(3);                                              // the wreck flies on: nothing may throw
} catch (err) {
  problems.push('script error: ' + (err.stack || err.message));
}
await browser.close();
await server.close();
console.log(`\nstructure e2e: ${checks} checks, ${problems.length} problem(s), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
