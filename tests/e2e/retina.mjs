// High-density displays: the flight view's two scenes (far: sky and terrain; near: vessels and the space centre) must
// land on the same pixels at any device pixel ratio and in every graphics profile.
//   node tests/e2e/retina.mjs            captures: tests/out/retina-<dpr>-<profile>.png
//   REVERT=1 node tests/e2e/retina.mjs   mutation check: serves flightscene.js with the round-3 viewport fix undone
//                                        (the suite must then FAIL at ratio 2; nothing on disk is changed)
// How: two flat-coloured balls (magenta in the far scene, red in the near scene) are put in front of the camera, one in each scene, drawn over everything. The page is
// captured and each ball must be where the camera projects it. A scene drawn with the wrong viewport (the bug the
// owner saw on a retina display: the far scene scaled 2× about the bottom-left corner while the rocket was not)
// puts its ball somewhere else or off the picture.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const REVERT = !!process.env.REVERT;
const W = 800, H = 500, TOL = 5;      // CSS pixels of the page; tolerance in CSS pixels

const problems = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });

async function run(dpr) {
  console.log(`\n=== device pixel ratio ${dpr} ===`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
  let reverted = false;
  if (REVERT) await page.route('**/js/ui/flightscene.js', async route => {
    const src = fs.readFileSync(path.join(ROOT, 'js/ui/flightscene.js'), 'utf8');
    const out = src.replace(/rt\.viewport\.set\(0, 0, rt\.width, rt\.height\);\s*renderer\.setRenderTarget\(rt\);/, 'renderer.setViewport(0, 0, rt.width, rt.height);');
    reverted = out !== src;
    await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: out });
  });
  const E = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(server.url, { timeout: 240000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app, null, { timeout: 240000 });
  await E(() => document.querySelector('[data-action="new"]').click());
  await page.waitForSelector('.sw-mode[data-mode="sandbox"]', { state: 'attached' });
  await E(() => document.querySelector('.sw-mode[data-mode="sandbox"]').click());
  await E(() => document.querySelector('.sw-modal .sw-btn.primary').click());
  await page.waitForFunction(() => window.__sw.app.currentName === 'hub' && window.__sw.app.current, null, { timeout: 600000 });
  await E(async () => {
    const { stockCrafts } = await import('/js/core/craft.js');
    const app = window.__sw.app; app.settings.showHints = false;
    app.launch(stockCrafts().find(c => c.name === 'Skylark II'), { crew: app.career.availableCrew().slice(0, 1).map(p => p.name), site: 'pad' });
  });
  await page.waitForFunction(() => { const a = window.__sw.app; return a.currentName === 'flight' && a.flight && a.flight.view && a.world && a.world.active && a.flight.view.views.has(a.world.active); }, null, { timeout: 600000, polling: 50 });
  if (REVERT) ok(reverted, 'mutation applied: flightscene.js served with the viewport fix undone');
  // hold the rocket 900 m up, physics frozen, so only sky and far terrain are behind the markers
  const setup = await E(async () => {
    const THREE = await import('/js/lib/three.module.min.js');
    const sw = window.__sw, app = sw.app, f = app.flight, sc = f.view, w = sw.world, v = w.active, b = v.body;
    f.hud.setHidden(true);
    v.landed = false; v.surface = null; v.launched = true; v.launchUt = w.ut;
    const up = b.surfaceDirToInertial(new THREE.Vector3(1, 0, 0), w.ut, new THREE.Vector3()).normalize();
    v.pos.copy(up).multiplyScalar(b.radius + 900);
    const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x); v.w.set(0, 0, 0); v._stamp++; v.updateTelemetry(w.ut);
    const c = app.current; c.update = dt => sc.update(w, dt, 0, f.cam);
    f.cam.yaw = 2.2; f.cam.pitch = 0.25; if (f.cam.setDist) f.cam.setDist(60); f.cam.dist = 60;
    for (let i = 0; i < 60; i++) sc.update(w, 1 / 30, 0, f.cam);
    const mk = (scene, color) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, toneMapped: false, fog: false, transparent: true }));
      m.renderOrder = 9999; m.frustumCulled = false; scene.add(m); return m;
    };
    window.__mk = { far: mk(sc.far, 0xff00ff), near: mk(sc.near, 0xff0000), THREE };
    return { post: !!(sc.fx && sc.fx.post), soft: sc.softGL, ratio: app.renderer.getPixelRatio(), canvas: [app.renderer.domElement.width, app.renderer.domElement.height] };
  });
  console.log(`    canvas ${setup.canvas.join('×')} device px, renderer ratio ${setup.ratio}, software GL ${setup.soft}, post chain ${setup.post}`);
  ok(Math.abs(setup.ratio - dpr) < 0.01, `the canvas is drawn at ratio ${setup.ratio} for a display of ratio ${dpr}`);
  for (const prof of ['auto', 'high', 'medium', 'low']) {
    const exp = await E(prof => {
      const sw = window.__sw, app = sw.app, f = app.flight, sc = f.view, mkr = window.__mk, cam = sc.camera;
      if (prof === 'auto') { app.settings.gfxForce = false; } else { app.settings.gfxForce = true; app.settings.gfxQuality = prof; }
      sc.applySettings();
      for (let i = 0; i < 3; i++) sc.update(sw.world, 1 / 30, 0, f.cam);
      cam.updateMatrixWorld(true);
      const right = new mkr.THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), upv = new mkr.THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1), fwd = new mkr.THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate();
      const place = (m, dx, dy) => { m.position.copy(cam.position).addScaledVector(fwd, 50).addScaledVector(right, dx).addScaledVector(upv, dy); m.scale.setScalar(1.6); const p = m.position.clone().project(cam); return { x: (p.x * 0.5 + 0.5) * app.size.w, y: (-p.y * 0.5 + 0.5) * app.size.h }; };
      const out = { far: place(mkr.far, -22, 14), near: place(mkr.near, 22, 14), quality: sc.qualityName, shadows: !!sc.near.children.find(o => o.isDirectionalLight && o.castShadow) };
      const t = sc.fx && sc.fx.post && sc.fx.post.target; out.target = t ? [t.width, t.height] : null;
      return out;
    }, prof);
    await E(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
    const file = path.join(OUT, `retina-${dpr}-${prof}${REVERT ? '-reverted' : ''}.png`);
    const png = await page.screenshot({ path: file, timeout: 300000 });
    const found = await E(async ({ b64, dpr }) => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data, acc = { far: [0, 0, 0], near: [0, 0, 0] };
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4, r = d[i], gg = d[i + 1], bl = d[i + 2];
        if (r - gg > 70 && bl - gg > 70) { acc.far[0] += x; acc.far[1] += y; acc.far[2]++; }
        else if (r - gg > 80 && r - bl > 80) { acc.near[0] += x; acc.near[1] += y; acc.near[2]++; }
      }
      const cen = a => (a[2] > 12 ? { x: a[0] / a[2] / dpr, y: a[1] / a[2] / dpr, n: a[2] } : null);
      return { far: cen(acc.far), near: cen(acc.near), size: [img.width, img.height] };
    }, { b64: png.toString('base64'), dpr });
    const d = k => (found[k] ? Math.hypot(found[k].x - exp[k].x, found[k].y - exp[k].y) : Infinity);
    const say = k => (found[k] ? `at (${found[k].x.toFixed(1)}, ${found[k].y.toFixed(1)}), ${d(k).toFixed(1)} px from` : 'NOT FOUND; expected at') + ` (${exp[k].x.toFixed(1)}, ${exp[k].y.toFixed(1)})`;
    const label = `ratio ${dpr}, profile ${prof} (${exp.quality}${exp.target ? ', scene target ' + exp.target.join('×') : ', no post chain'}, shadows ${exp.shadows ? 'on' : 'off'})`;
    ok(found.size[0] === W * dpr, `${label}: the capture is ${found.size.join('×')} device px`);
    ok(d('far') <= TOL, `${label}: the far scene (sky, terrain) is drawn where the camera puts it: marker ${say('far')} the projection`);
    ok(d('near') <= TOL, `${label}: the near scene (vessels, space centre) is drawn where the camera puts it: marker ${say('near')} the projection`);
  }
  await ctx.close();
}

let crashed = null;
try { for (const dpr of [1, 2]) await run(dpr); } catch (err) { crashed = err; }
await browser.close();
await server.close();
if (crashed) problems.push('suite stopped: ' + (crashed.stack || crashed.message));
const uniq = [...new Set(problems)];
console.log(`\n${checks} checks, ${uniq.length} problem(s)`);
if (uniq.length) { console.log(uniq.slice(0, 40).join('\n')); process.exit(1); }
