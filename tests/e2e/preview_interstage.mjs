// Preview captures of the interstage truss (the lattice ring between a stage and the engine above it) for eyeballing:
// a two-stage stock craft on the pad, close on the joint, the moment of separation, a little later, and the same
// joint in the assembly building.
//   node tests/e2e/preview_interstage.mjs [only,comma,separated]     names: pad sep builder
//   → tests/out/interstage/<name>.png
// It is a capture script, not a test: it fails only on page errors or when a scene cannot be reached.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out/interstage');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const want = name => !ONLY.length || ONLY.includes(name);
const CRAFT = process.env.CRAFT || 'Skylark II';
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
const key = async code => { await page.keyboard.down(code); await page.waitForTimeout(50); await E(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); }); await page.keyboard.up(code); };
/** Aim the flight camera; with `onTruss` it looks at the middle of the first interstage instead of the centre of mass. */
const cam = (yaw, pitch, dist, onTruss = false) => E(o => {
  const sw = window.__sw, c = sw.app.flight.cam, v = sw.world.active;
  c.yaw = o.yaw; c.pitch = o.pitch; if (c.setDist) c.setDist(o.dist); c.dist = o.dist;
  c.offset.set(0, 0, 0);
  if (o.onTruss) {
    const p = v.partList.find(p => p.truss);
    if (p) c.offset.y = (p.pos.y + (p.def.h + p.truss[0].h) / 2 - v.com.y) * Math.cos(o.pitch) + (c.bias || 0) * o.dist;
  }
  for (let i = 0; i < 90; i++) sw.app.flight.view.update(sw.world, 1 / 30, 0, c);
}, { yaw, pitch, dist, onTruss });
/** Aim along the line from the ship to the stage it dropped (straight behind a rocket that is still flying upright):
 *  k = 0 looks at the ship, 1 at the dropped stage's centre of mass, `truss` at the middle of the truss it carries. */
const camAt = (yaw, pitch, dist, k, truss = false) => E(o => {
  const sw = window.__sw, w = sw.world, c = sw.app.flight.cam, a = w.active;
  const d = w.vessels.find(v => v !== a && v.body === a.body && v.partList.some(p => p.truss));
  c.yaw = o.yaw; c.pitch = o.pitch; if (c.setDist) c.setDist(o.dist); c.dist = o.dist; c.offset.set(0, 0, 0);
  if (d) {
    let gap = Math.hypot(d.pos.x - a.pos.x, d.pos.y - a.pos.y, d.pos.z - a.pos.z) * o.k;
    if (o.truss) { const p = d.partList.find(p => p.truss); gap -= p.pos.y + (p.def.h + p.truss[0].h) / 2 - d.com.y; }
    c.offset.y = -gap * Math.cos(o.pitch) + (c.bias || 0) * o.dist;
  }
  for (let i = 0; i < 90; i++) sw.app.flight.view.update(w, 1 / 30, 0, c);
}, { yaw, pitch, dist, k, truss });
let n = 0;
async function shot(name, { freeze = false, clip = null } = {}) {
  n++;
  if (freeze) await E(() => { const sw = window.__sw, c = sw.app.current, f = sw.app.flight; c.__update = c.update; c.update = dt => f.view.update(sw.world, dt, 0, f.cam); });
  if (await E(() => window.__sw.app.currentName === 'flight')) {
    for (let i = 0; i < 6; i++) {
      const left = await E(() => { const f = window.__sw.app.flight, s = f && f.view, w = s && s.worlds; if (!w || !w.info || !s.settleTerrain) return 0; s.settleTerrain(2500); s.update(window.__sw.world, 1 / 30, 0, f.cam); return w.info.pending || 0; });
      if (!left) break;
    }
  }
  await page.waitForTimeout(900);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, timeout: 120000, ...(clip ? { clip } : {}) });
  if (freeze) await E(() => { const c = window.__sw.app.current; if (c.__update) { c.update = c.__update; delete c.__update; } });
  console.log('  captured ' + path.relative(ROOT, file));
}
async function launchStock(name) {
  await E(async name => {
    const { stockCrafts, stockSite } = await import('/js/core/craft.js');
    const { PARTS } = await import('/js/core/parts.js');
    const c = stockCrafts().find(c => c.name === name);
    const app = window.__sw.app;
    const seats = c.parts.reduce((n, p) => n + ((PARTS[p.type] && PARTS[p.type].crew) || 0), 0);
    try { app.career.releaseCrew(app.career.roster.filter(p => p.status === 'assigned').map(p => p.name)); } catch { /* keep going */ }
    app.launch(c, { crew: seats ? app.career.availableCrew().slice(0, 1).map(p => p.name) : [], site: stockSite ? stockSite(c) : 'pad' });
  }, name);
  await waitScreen('flight');
  await page.waitForTimeout(1200);
}
const trussReport = () => E(() => { const w = window.__sw.world, a = w.active; return w.vessels.filter(v => v.body === a.body).map(v => ({ name: v.name, type: v.type, parts: v.partList.length, trussOn: v.partList.filter(p => p.truss).map(p => p.def.id + ' (' + p.truss.map(t => t.mass + ' kg').join(', ') + ')'), m: Math.round(Math.hypot(v.pos.x - a.pos.x, v.pos.y - a.pos.y, v.pos.z - a.pos.z)) })); });

try {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30000 });
  await E(() => document.querySelector('[data-action="new"]').click());
  await page.waitForSelector('.sw-mode[data-mode="sandbox"]', { state: 'attached' });
  await E(() => document.querySelector('.sw-mode[data-mode="sandbox"]').click());
  await E(() => document.querySelector('.sw-modal .sw-btn.primary').click());
  await waitScreen('hub');
  await E(() => { const s = window.__sw.app.settings; s.gfxForce = true; s.gfxQuality = 'high'; });

  if (want('pad') || want('sep')) {
    await launchStock(CRAFT);
    console.log('  on the pad: ' + JSON.stringify(await trussReport()));
    if (want('pad')) {
      await cam(2.2, 0.1, 46); await shot('pad-wide');
      await cam(2.2, 0.05, 9, true); await shot('pad-close');
      await cam(0.6, 0.3, 5, true); await shot('pad-closer');
    }
    if (want('sep')) {
      await key('KeyZ'); await key('Space');
      await ff(400, 'v && v.engines.some(e => e.part.ignited && e.part.flameout)');
      // engines off for the picture: the upper stage's plume would hide the stage falling away behind it
      await key('KeyX');
      await cam(1.25, 0.12, 30);
      await key('Space'); await ff(0.25);
      console.log('  after staging: ' + JSON.stringify(await trussReport()));
      // from the side, aimed at the gap between the two stages
      await camAt(1.25, 0.12, 30, 0.5); await shot('separation', { freeze: true });
      // close on the top of the dropped stage: the lattice ring is on it, open at the top
      await camAt(1.25, 0.35, 7, 1, true); await shot('separation-lower-stage', { freeze: true });
    }
  }
  if (want('builder')) {
    await E(async name => {
      const { stockCrafts } = await import('/js/core/craft.js');
      const c = stockCrafts().find(c => c.name === name);
      await window.__sw.app.goto('builder', { site: 'pad', craft: c.toJSON(), quality: 'high' });
    }, CRAFT);
    await page.waitForFunction(() => window.__sw.app.currentName === 'builder' && window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
    const settle = () => page.waitForFunction(() => { const c = window.__sw.app.builder.camera; return Math.abs(c.dist - c.tdist) < 0.02 && Math.abs(c.ty - c.tty) < 0.02 && Math.abs(c.yaw - c.tyaw) < 0.005 && Math.abs(c.pitch - c.tpitch) < 0.005; }, null, { timeout: 120000 }).catch(() => {});
    // put the first-visit help away
    await E(() => { for (const b of document.querySelectorAll('button')) if (/^Got it$/.test(b.textContent.trim())) b.click(); });
    await E(() => window.__sw.app.builder.frame());
    await settle(); await shot('builder-whole');
    // close on the joint: aim the camera at the engine the truss surrounds
    await E(() => {
      // (the builder camera's focus height is in craft coordinates)
      const b = window.__sw.app.builder, t = b.craft.interstages()[0];
      b.setCamera({ yaw: 0.7, pitch: 0.12, dist: 6, ty: (t.y0 + t.y1) / 2, fx: 0, fz: 0 });
    });
    await settle(); await shot('builder-close');
  }
} catch (err) { problems.push('preview stopped: ' + (err.stack || err.message)); }

await browser.close();
await server.close();
if (problems.length) { console.log('\nPROBLEMS:\n' + [...new Set(problems)].slice(0, 30).join('\n')); process.exit(1); }
console.log('\ninterstage previews written to tests/out/interstage/');
