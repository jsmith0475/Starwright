// Realism probe: renders the views a player actually sees of the home world's environment (title backdrop,
// space-centre overview, pad, runway, a grove close up, and three flight views: on the pad, on the runway, low over
// the base) at devicePixelRatio 1 and 2, captures them, and checks there are no console errors and that every view
// stays inside its draw-call and triangle budget at each quality level.
//
//   node tests/e2e/realism_probe.mjs [tag=after] [dpr=1,2] [quality=high,medium,low] [views=title,overview,...]
//                                    [size=960x600] [size2=640x400] [shots=1] [budget=1]
//     tag      file name prefix: tests/out/realism-<tag>-<view>[-<quality>][@2x].png   (default "after")
//     dpr      device pixel ratios to run (default 1,2)
//     quality  flight quality levels to measure (default high,medium,low); captures are taken at the first one
//     size     viewport at dpr 1; size2 at dpr 2 (software GL: keep them small)
//     budget=0 report numbers only (used for the "before" run, which predates the budgets)
//
// It is standalone: it starts its own server and one browser, and exits non-zero on a console error, a page
// error, or a budget overrun. It forces full quality on the software rasteriser so what it judges is what ships.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const arg = (name, def) => { const a = process.argv.find(s => s.startsWith(name + '=')); return a ? a.slice(name.length + 1) : def; };
const TAG = arg('tag', 'after');
const DPRS = arg('dpr', '1,2').split(',').map(Number).filter(n => n > 0);
const QUALITIES = arg('quality', 'high,medium,low').split(',').filter(Boolean);
const ONLY = arg('views', '').split(',').filter(Boolean);
const SIZE = arg('size', '960x600').split('x').map(Number), SIZE2 = arg('size2', '640x400').split('x').map(Number);
const SHOTS = arg('shots', '1') !== '0', BUDGET = arg('budget', '1') !== '0';
const want = v => !ONLY.length || ONLY.includes(v);

// Hub camera poses (js/ui/baseview.js): target, azimuth, elevation, distance; time of day 0..1 (0.5 = noon)
const HUB_VIEWS = {
  overview: { tod: 0.4, pose: null },
  pad: { tod: 0.36, pose: { target: [4, 22, 0], az: 2.3, el: 0.13, dist: 230 }, display: 'pad' },
  runway: { tod: 0.6, pose: { target: [-640, 5, 800], az: -1.9, el: 0.14, dist: 420 } },
  grove: { tod: 0.38, pose: { target: [-250, 5, 380], az: 0.4, el: 0.1, dist: 110 } },
  coast: { tod: 0.66, pose: { target: [1350, 5, 500], az: -1.2, el: 0.09, dist: 900 } },
};
// Budgets per view and quality: [draw calls, triangles] for ONE frame, all passes (shadow pass included).
// Measured on the reference run (see docs/ARCHITECTURE.md "Additions (round 4: environment realism)") with head-room.
const BUDGETS = {
  // [draw calls, triangles]: about a quarter above what the software rasteriser measured at 960x600 after the
  // realism pass (docs/ARCHITECTURE.md "Additions (round 4)"); before it the hub drew 1.2M triangles and the pad 1.9M
  hub: { title: [260, 1.3e6], overview: [260, 1.3e6], pad: [260, 1.3e6], runway: [260, 1.3e6], grove: [260, 1.3e6], coast: [260, 1.3e6] },
  flight: {
    high: { 'flight-pad': [480, 2.1e6], 'flight-runway': [480, 2.1e6], 'flight-low': [480, 2.1e6], 'flight-far': [480, 2.2e6] },
    medium: { 'flight-pad': [460, 1.5e6], 'flight-runway': [460, 1.5e6], 'flight-low': [460, 1.5e6], 'flight-far': [460, 1.8e6] },
    low: { 'flight-pad': [400, 0.75e6], 'flight-runway': [400, 0.75e6], 'flight-low': [400, 0.75e6], 'flight-far': [400, 1.2e6] },
  },
};

const { chromium } = await loadPlaywright();
const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const problems = [], rows = [];
const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

/** One frame's cost of whatever the current screen draws, and an estimate of the texture memory its scenes hold. */
const MEASURE = () => {
  const app = window.__sw.app, r = app.renderer, f = app.flight;
  const scenes = f ? [f.scene, f.nearScene] : [window.__swView.scene];
  r.info.autoReset = false; r.info.reset();
  if (f) f.view.render(r); else window.__swView.render(null, true);
  const out = { calls: r.info.render.calls, tris: r.info.render.triangles, textures: r.info.memory.textures, geometries: r.info.memory.geometries, programs: r.info.programs ? r.info.programs.length : 0 };
  r.info.autoReset = true;
  // texture memory: every texture reachable from the scenes' materials (and shadow maps), 4 bytes a texel, mips + a third
  const seen = new Set(); let bytes = 0;
  const add = t => {
    if (!t || !t.isTexture || seen.has(t.uuid)) return; seen.add(t.uuid);
    const img = t.image || {}, w = img.width || img.videoWidth || 0, h = img.height || 0, d = t.isCubeTexture ? 6 : 1;
    const bpp = t.type === 1016 || t.type === 1015 ? (t.type === 1015 ? 16 : 8) : 4;      // HalfFloat / Float
    bytes += w * h * d * bpp * (t.generateMipmaps || (t.mipmaps && t.mipmaps.length > 1) ? 4 / 3 : 1);
  };
  for (const s of scenes) if (s) s.traverse(o => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    if (o.customDepthMaterial) mats.push(o.customDepthMaterial);
    for (const m of mats) { for (const k in m) { const v = m[k]; if (v && v.isTexture) add(v); } if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) add(v); } }
    if (o.isLight && o.shadow && o.shadow.map) add(o.shadow.map.texture);
  });
  for (const s of scenes) if (s && s.environment) add(s.environment);
  out.texMB = +(bytes / 1048576).toFixed(1);
  return out;
};

function check(kind, quality, view, m, dpr) {
  rows.push({ view, quality, dpr, ...m });
  console.log(`  ${view.padEnd(14)} ${String(quality).padEnd(7)} dpr ${dpr}: ${String(m.calls).padStart(4)} draws  ${fmt(m.tris).padStart(7)} tris  ${String(m.textures).padStart(3)} tex (${m.texMB} MB est.)  ${m.geometries} geos`);
  if (!BUDGET) return;
  const b = kind === 'hub' ? BUDGETS.hub[view] : (BUDGETS.flight[quality] || {})[view];
  if (!b) return;
  if (m.calls > b[0]) problems.push(`${view} (${quality}, dpr ${dpr}): ${m.calls} draw calls, budget ${b[0]}`);
  if (m.tris > b[1]) problems.push(`${view} (${quality}, dpr ${dpr}): ${m.tris} triangles, budget ${b[1]}`);
  if (m.calls < 5 || m.tris < 1000) problems.push(`${view} (${quality}, dpr ${dpr}): nothing was drawn (${m.calls} draws, ${m.tris} triangles)`);
}

try {
  for (const dpr of DPRS) {
    const [W, H] = dpr > 1 ? SIZE2 : SIZE, sfx = dpr > 1 ? `@${dpr}x` : '';
    console.log(`\n== devicePixelRatio ${dpr}, viewport ${W}x${H} (drawing buffer ${W * dpr}x${H * dpr})`);
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') problems.push(`console error (dpr ${dpr}): ` + m.text()); });
    page.on('pageerror', e => problems.push(`page error (dpr ${dpr}): ` + (e.stack || e.message)));
    const E = (fn, a) => page.evaluate(fn, a);
    const shot = async name => { if (SHOTS) { await page.screenshot({ path: path.join(OUT, `realism-${TAG}-${name}${sfx}.png`), timeout: 300000 }); } };

    await page.goto(server.url);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
    await E(async () => {
      const s = window.__sw.app.settings; s.gfxForce = true; s.gfxQuality = 'high'; s.gfxAuto = false; s.showHints = false;
      const m = await import('./js/ui/baseview.js'); const v = window.__swView = m.getBaseView(window.__sw.app); v.lockQuality(0); v.freeze(true);
    });
    const hubSnap = async () => {
      await E(() => { const app = window.__sw.app, v = window.__swView; for (let i = 0; i < 3; i++) { if (app.current && app.current.update) app.current.update(0.016); else v.update(0.016, { drift: false }); v.update(0, { drift: false }); v.render(null, true); } });
      await page.waitForTimeout(300);
    };
    // ---- title
    await page.waitForSelector('.sw-title-screen.ready', { timeout: 120000 });
    if (want('title')) { await hubSnap(); check('hub', 'high', 'title', await E(MEASURE), dpr); await shot('title'); }
    // ---- hub
    await E(() => document.querySelector('[data-action="new"]').click());
    await page.waitForSelector('.sw-mode[data-mode="sandbox"]', { state: 'attached' });
    await E(() => document.querySelector('.sw-mode[data-mode="sandbox"]').click());
    await E(() => document.querySelector('.sw-modal .sw-btn.primary').click());
    await page.waitForFunction(() => window.__sw.app.currentName === 'hub' && window.__sw.app.current, null, { timeout: 120000 });
    await page.waitForTimeout(500);
    for (const [name, v] of Object.entries(HUB_VIEWS)) {
      if (!want(name)) continue;
      await E(([v]) => {
        const hub = window.__sw.app.screens.hub, view = hub.debug.view;
        if (!hub.__frozen) { hub.__frozen = true; hub.update = () => {}; for (const n of document.querySelectorAll('.sw-pin, .sw-hint, .sw-coach, .sw-guide-card')) n.style.display = 'none'; }
        view.setTimeOfDay(v.tod); view.base.setDisplay(v.display || 'none');
        if (v.pose) view.flyTo({ target: new view.camera.position.constructor(...v.pose.target), az: v.pose.az, el: v.pose.el, dist: v.pose.dist }, { snap: true }); else view.home(true);
      }, [v]);
      await hubSnap();
      check('hub', 'high', name, await E(MEASURE), dpr);
      await shot(name);
    }
    // ---- flight, per quality level
    const flightViews = ['flight-pad', 'flight-runway', 'flight-low', 'flight-far'].filter(want);
    if (flightViews.length) for (const q of QUALITIES) {
      await E(q => { const s = window.__sw.app.settings; s.gfxForce = true; s.gfxQuality = q; s.gfxAuto = false; }, q);
      if (await E(() => window.__sw.app.currentName) !== 'hub') { await E(() => window.__sw.app.goto('hub')); await page.waitForFunction(() => window.__sw.app.currentName === 'hub', null, { timeout: 120000 }); }
      await E(async () => {
        const { stockCrafts, stockSite } = await import('/js/core/craft.js');
        const c = stockCrafts().find(c => c.name === 'Ember Twin') || stockCrafts()[0], app = window.__sw.app;
        try { app.career.releaseCrew(app.career.roster.filter(p => p.status === 'assigned').map(p => p.name)); } catch { /* keep going */ }
        app.launch(c, { crew: app.career.availableCrew().slice(0, 1).map(p => p.name), site: 'pad' });
      });
      await page.waitForFunction(() => window.__sw.app.currentName === 'flight' && window.__sw.app.current && window.__sw.app.flight, null, { timeout: 600000 });
      await page.waitForTimeout(800);
      // hold the simulation still: the screen keeps drawing, the world does not advance. Mid-morning light.
      await E(() => { const sw = window.__sw, c = sw.app.current, f = sw.app.flight; c.update = dt => f.view.update(sw.world, Math.min(dt, 0.05), 0, f.cam); for (const n of document.querySelectorAll('.sw-coach, .sw-guide-card, .sw-toasts')) n.style.display = 'none'; });
      const settle = async () => {
        for (let i = 0; i < 8; i++) {
          const left = await E(() => { const f = window.__sw.app.flight, s = f.view, w = s.worlds; if (!w || !w.info || !s.settleTerrain) return 0; s.settleTerrain(2500); s.update(window.__sw.world, 1 / 30, 0, f.cam); return w.info.pending || 0; });
          if (!left) break;
        }
        await E(() => { const f = window.__sw.app.flight, w = f.view.worlds; return w && w.settle ? w.settle(4000) : null; });
        await E(() => { const f = window.__sw.app.flight; for (let i = 0; i < 4; i++) f.view.update(window.__sw.world, 1 / 30, 0, f.cam); });
      };
      /** Put the vessel `alt` m over the point (x east, z south) of the space centre's frame; aim the camera. */
      const place = (o) => E(async o => {
        const THREE = await import('/js/lib/three.module.min.js');
        const { SYSTEM } = await import('/js/core/bodies.js');
        const { World } = await import('/js/core/world.js');
        const w = window.__sw.world, v = w.active, b = SYSTEM.home, f = window.__sw.app.flight;
        if (o.x != null) {
          const p = SYSTEM.launchSite.dir, pad = new THREE.Vector3(p.x, p.y, p.z).normalize();
          const east = new THREE.Vector3(0, 1, 0).cross(pad).normalize(), north = pad.clone().cross(east);
          const dir = pad.clone().multiplyScalar(b.radius).addScaledVector(east, o.x).addScaledVector(north, -o.z).normalize();
          const up = b.surfaceDirToInertial(dir, w.ut, new THREE.Vector3()).normalize();
          v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true;
          v.pos.copy(up).multiplyScalar(b.radius + b.terrainHeight(dir) + o.alt + (v.baseHeight || 1));
          const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
          v.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
          v.w.set(0, 0, 0); v.ctrl.throttle = 0; v._stamp++; v.updateTelemetry(w.ut);
        }
        const c = f.cam; c.yaw = o.yaw; c.pitch = o.pitch; if (c.setDist) c.setDist(o.dist); c.dist = o.dist;
        for (let i = 0; i < 60; i++) f.view.update(w, 1 / 30, 0, c);
      }, o);
      const POSES = {
        'flight-pad': { yaw: 2.25, pitch: 0.1, dist: 62 },
        'flight-runway': { x: -700, z: 850, alt: 4, yaw: 1.2, pitch: 0.12, dist: 30 },
        'flight-low': { x: -260, z: 250, alt: 60, yaw: -0.9, pitch: 0.2, dist: 45 },
        'flight-far': { x: -3700, z: -1600, alt: 35, yaw: -0.9, pitch: 0.12, dist: 45 },      // beyond the centre's own trees: the terrain's scattered woods
      };
      for (const name of flightViews) {
        await place(POSES[name]); await settle();
        const m = await E(MEASURE);
        m.quality = await E(() => window.__sw.app.flight.view.qualityName);
        check('flight', q, name, m, dpr);
        if (q === QUALITIES[0] || arg('allshots', '0') !== '0') { await page.waitForTimeout(700); await shot(name + (q === QUALITIES[0] ? '' : '-' + q)); }
      }
    }
    await ctx.close();
  }
} catch (err) {
  problems.push('probe failed: ' + (err && err.stack || err));
} finally {
  await browser.close();
  await server.close();
}
fs.writeFileSync(path.join(OUT, `realism-${TAG}-metrics.json`), JSON.stringify(rows, null, 1));
if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of [...new Set(problems)].slice(0, 30)) console.log(' - ' + p); process.exitCode = 1; }
else console.log(`\nrealism probe: ${rows.length} view measurements, no console errors${BUDGET ? ', all inside budget' : ''}`);
