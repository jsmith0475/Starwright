// Ambient-occlusion probe (docs/REALISM_PASS_SPEC.md, R1): draws flight views with occlusion off, on, and as the
// occlusion term alone, saves the three pictures and checks the rules a person would otherwise have to eyeball:
//   · where the occlusion term is 1 (sky, open ground, the distance) the picture is unchanged, bit for bit;
//   · some of the picture IS occluded (creases, contact areas), but not most of it;
//   · the picture as a whole does not get noticeably darker.
//   node tests/e2e/ao_probe.mjs [pad,pad-high,moon,moon-high]      → tests/out/ao-<view>-{off,on,term}.png, exits non-zero on a failure
// Full quality is forced on the software rasteriser, as in the preview scripts, so what is judged is what ships.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const want = v => !ONLY.length || ONLY.includes(v);
const problems = [];
const ok = (cond, what) => { console.log((cond ? '  ok   ' : '  FAIL ') + what); if (!cond) problems.push(what); };

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })).newPage();
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); else if (m.type() === 'warning' && /\[flight\]|THREE/.test(m.text())) console.log('  (page warning) ' + m.text().slice(0, 400)); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
const E = (fn, arg) => page.evaluate(fn, arg);
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 });
  await page.waitForTimeout(400);
}
const cam = (yaw, pitch, dist) => E(o => { const c = window.__sw.app.flight.cam; c.yaw = o.yaw; c.pitch = o.pitch; if (c.setDist) c.setDist(o.dist); c.dist = o.dist; for (let i = 0; i < 40; i++) window.__sw.app.current.update(0.05); window.__sw.app.input.endFrame(); }, { yaw, pitch, dist });
async function settle() {
  for (let i = 0; i < 8; i++) {
    const left = await E(() => { const f = window.__sw.app.flight, s = f && f.view, w = s && s.worlds; if (!w || !w.info || !s.settleTerrain) return 0; s.settleTerrain(2500); s.update(window.__sw.world, 1 / 30, 0, f.cam); return w.info.pending || 0; });
    if (!left) break;
  }
  await E(() => { const f = window.__sw.app.flight, w = f && f.view && f.view.worlds; return w && w.settle ? w.settle(5000) : null; });
  await page.waitForTimeout(1500);
}
/** The 3D canvas alone (no HUD) with occlusion off, on, and as the occlusion term, drawn in one task so nothing moves between them. */
const frames = () => E(() => {
  const app = window.__sw.app, post = app.flight.view.fx.post, gl = document.getElementById('gl');
  const draw = (ao, debug) => { post.params.grain = 0; post.params.ao = ao; post.params.aoDebug = debug; app.current.render(); app.current.render(); return gl.toDataURL('image/png'); };
  const out = { off: draw(0, false), on: draw(1, false), term: draw(1, true), aoOn: post.aoOn, quality: app.flight.view.qualityName };
  post.params.ao = 1; post.params.aoDebug = false;
  return out;
});
const save = (name, url) => fs.writeFileSync(path.join(OUT, name), Buffer.from(url.split(',')[1], 'base64'));

/** minOccluded: the least share of the picture that must be clearly occluded (0 for views along the ground, where a screen-space pass sees few creases). */
async function probe(view, minOccluded = 0) {
  await settle();
  await page.waitForFunction(() => { const f = window.__sw.app.flight; return f && f.view && f.view.fx.post; }, null, { timeout: 60000 });
  const fr = await frames(), on = fr;
  save('ao-' + view + '-off.png', fr.off); save('ao-' + view + '-on.png', fr.on); save('ao-' + view + '-term.png', fr.term);
  const st = await E(async ({ off, on, term }) => {
    const px = async url => { const im = new Image(); im.src = url; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const a = await px(off), b = await px(on), t = await px(term);
    let open = 0, openDiff = 0, occl = 0, la = 0, lb = 0, n = 0, tsum = 0;
    for (let i = 0; i < a.length; i += 4) {
      const ao = t[i];
      // not part of the 3D scene (the navball is drawn on the same canvas after the post chain): the same in all three
      if (t[i] === a[i] && t[i + 1] === a[i + 1] && t[i + 2] === a[i + 2] && (t[i] !== t[i + 1] || t[i] < 250)) continue;
      n++;
      tsum += ao;
      if (ao >= 254) { open++; openDiff = Math.max(openDiff, Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])); }
      if (ao < 205) occl++;
      la += a[i] + a[i + 1] + a[i + 2]; lb += b[i] + b[i + 1] + b[i + 2];
    }
    return { open: open / n, openDiff, occluded: occl / n, darker: 1 - lb / la, meanTerm: tsum / n / 255 };
  }, { off: fr.off, on: fr.on, term: fr.term });
  console.log(view + ': quality ' + on.quality + ', occlusion ' + (on.aoOn ? 'on' : 'OFF') + ', ' + JSON.stringify(st));
  ok(on.aoOn && on.quality === 'high', view + ': occlusion is on at "high"');
  ok(st.openDiff <= 2, view + ': unoccluded pixels are unchanged (largest difference ' + st.openDiff + ' of 255)');
  ok(st.occluded >= minOccluded && st.occluded < 0.25, view + ': between ' + (minOccluded * 100).toFixed(1) + ' % and 25 % of the picture is clearly occluded (' + (st.occluded * 100).toFixed(2) + ' %)');
  ok(st.darker >= 0 && st.darker < 0.04, view + ': the whole picture darkens by less than 4 % (' + (st.darker * 100).toFixed(2) + ' %)');
}

try {
  await page.goto(server.url);
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
  if (want('pad')) { await cam(2.2, 0.1, 46); await probe('pad'); }
  if (want('pad-high')) { await cam(2.2, 0.55, 30); await probe('pad-high', 0.005); }
  if (want('moon') || want('moon-high')) {
    await E(async () => {
      const THREE = await import('/js/lib/three.module.min.js');
      const { SYSTEM } = await import('/js/core/bodies.js');
      const { World } = await import('/js/core/world.js');
      const w = window.__sw.world, v = w.active, b = SYSTEM.byId.pell;
      const sun = b.globalPosAt(w.ut, new THREE.Vector3()).negate().normalize();
      const sunFixed = b.inertialToSurfaceDir(sun, w.ut, new THREE.Vector3());
      const dir = b.dirFromLatLon ? b.dirFromLatLon(0.1, Math.atan2(-sunFixed.z, sunFixed.x) + 0.6) : sunFixed.clone();
      const up = b.surfaceDirToInertial(dir, w.ut, new THREE.Vector3()).normalize();
      const ground = b.radius + (b.surfaceHeight ? b.surfaceHeight(dir) : 0);
      v.body = b; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true;
      v.pos.copy(up).multiplyScalar(ground + 1 + (v.baseHeight || 1));
      const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
      v.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
      v.w.set(0, 0, 0); v.sasTarget = null; v.ctrl.throttle = 0; v._stamp++;
      v.updateTelemetry(w.ut); w.step(0.001);
      for (let i = 0; i < 400; i++) { window.__sw.app.current.update(0.05); }
      window.__sw.app.input.endFrame();
    });
    if (want('moon')) { await cam(2.3, 0.1, 18); await probe('moon'); }
    if (want('moon-high')) { await cam(2.3, 0.6, 12); await probe('moon-high', 0.002); }
  }
} catch (err) { problems.push('probe aborted: ' + (err.stack || err.message)); }
finally { await browser.close(); await server.close(); }
if (problems.length) { console.log('\nPROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('\nao probe: all checks passed');
