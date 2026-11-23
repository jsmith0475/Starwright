// Records one real flight of Starwright frame by frame on a virtual clock, for the booster return video: a rocket
// with a returning first stage is launched with the ascent assist, the booster flies itself back and lands.
// Not part of the game and nothing here changes it: the rocket is built from stock parts through the game's own
// Craft class, the ascent assist and the booster's own return program fly it, and every frame is photographed.
// The parts of the flight that are not filmed are run at the same physics step, off camera.
//
//   node tests/tools/record_booster_video.mjs <gameDir> <outDir> [aspects] [target]
//     aspects: wide,tall (default both)      target: pad (default) or barge
//   env: FPS=60, DSF=2, CHANNEL=chrome, HEADED=1, ALLOW_SOFTWARE=1, QUALITY=high, SMALL=1 (half-size test), FULLHUD=1
// Writes <outDir>/<target>-<aspect>-<nn>-<shot>.mp4 for each shot and <outDir>/report-<target>.json with the flight's numbers.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [gameDir, outDir, onlyAspects = '', target = 'pad'] = process.argv.slice(2);
if (!gameDir || !outDir) { console.error('usage: node tests/tools/record_booster_video.mjs <gameDir> <outDir> [aspects] [pad|barge]'); process.exit(2); }
const FPS = Number(process.env.FPS || 60), STEP = 1000 / FPS, DSF = Number(process.env.DSF || 2), QUALITY = process.env.QUALITY || 'high';
const K = process.env.SMALL ? 0.5 : 1;
const ASPECTS = { wide: { w: 1920 * K, h: 1080 * K }, tall: { w: 1080 * K, h: 1920 * K } };
// keep the game's own messages (the booster calls out each step); hide the instruments so the rocket is in clear view
const HIDE = process.env.FULLHUD ? '' : '.fl-root > *:not(.fl-center){display:none!important}';
const aspectList = (onlyAspects || 'wide,tall').split(',').filter(a => ASPECTS[a]);
fs.mkdirSync(outDir, { recursive: true });

// The shots. `until` is evaluated in the page each physics step with (w, B, C): world, the booster, the capture state;
// the shot starts `lead` seconds of flight before it turns true (found on a first pass that is not filmed) and runs
// for `len` seconds or until `end` turns true and `tail` more seconds have passed. `who`: which vessel the camera
// follows. `cam`: { yaw, pitch, dist } and `spin` (rad/s).
const SHOTS = [
  { name: 'liftoff', at: 'liftoff', lead: 1.5, len: 7, who: 'upper', cam: { yaw: 2.3, pitch: 0.08, dist: 46 }, spin: 0.05 },
  { name: 'separation', at: 'sep', lead: 3, len: 7, who: 'upper', cam: { yaw: 2.5, pitch: 0.25, dist: 60 }, spin: 0.04 },
  { name: 'flip-boostback', at: 'boostback', lead: 5, len: 12, who: 'booster', cam: { yaw: 0.9, pitch: 0.2, dist: 42 }, spin: 0.06 },
  { name: 'falling', at: 'falling', lead: 0, len: 7, who: 'booster', cam: { yaw: 1.2, pitch: -0.35, dist: 38 }, spin: 0.05 },
  { name: 'landing', at: 'burn', lead: 3, len: 60, end: 'landed', tail: 6, who: 'booster', cam: { yaw: 2.2, pitch: 0.1, dist: 58 }, spin: 0.035 },
];

async function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) { try { return await import(name); } catch { /* next */ } }
  const roots = [];
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch { /* no npm */ }
  roots.push(path.join(path.dirname(process.execPath), '../lib/node_modules'), '/opt/node-tools/node_modules');
  for (const root of roots) for (const name of ['playwright', 'playwright-core']) {
    try { return createRequire(path.join(root, 'noop.js'))(name); } catch { /* next */ }
  }
  throw new Error('playwright is not installed');
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const base = path.resolve(gameDir);
const server = http.createServer((req, res) => {
  let file = path.normalize(path.join(base, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (e2, data) => {
      if (e2) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { chromium } = await loadPlaywright();
const soft = !!process.env.ALLOW_SOFTWARE;
const launchOpts = { headless: !process.env.HEADED, args: soft ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] };
if (process.env.CHANNEL) launchOpts.channel = process.env.CHANNEL;
const browser = await chromium.launch(launchOpts);
const report = { target, takes: [] };

/** One flight from the pad. With `plan` (event → mission time) the shots are filmed; without, the events are timed. */
async function flight(A, aspect, plan) {
  const ctx = await browser.newContext({ viewport: { width: A.w, height: A.h }, deviceScaleFactor: plan ? DSF : 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  page.on('pageerror', e => console.log('  PAGEERROR', e.message));
  await page.clock.install({ time: new Date('2026-11-23T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-23T12:00:01Z'));
  await page.addInitScript(ms => {
    window.__rafMs = ms;
    window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), window.__rafMs);
    window.cancelAnimationFrame = id => clearTimeout(id);
  }, STEP);
  const tick = async (ms = 100) => { await page.clock.runFor(ms); await page.waitForTimeout(15); };
  const until = async (fn, arg, what) => { for (let i = 0; i < 6000; i++) { if (await page.evaluate(fn, arg).catch(() => false)) return; await tick(); } throw new Error('timed out waiting for ' + what); };

  await page.goto(url + 'index.html?whatsnew=0', { timeout: 120000 });
  await until(() => document.body.dataset.ready === '1' && !!window.__sw, null, 'the title screen');
  const gpu = await page.evaluate(() => { try { const c = document.createElement('canvas').getContext('webgl2'), e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch (e) { return 'error ' + e.message; } });
  if (plan) console.log(`${target}-${aspect}: ${A.w * DSF}x${A.h * DSF} at ${FPS} fps, renderer = ${gpu}`);
  if (/swiftshader|llvmpipe|software/i.test(gpu) && !soft) { console.error('SOFTWARE RENDERING: no graphics card in this browser. Re-run with HEADED=1 or CHANNEL=chrome.'); process.exit(3); }

  await page.evaluate(() => document.querySelector('[data-action="new"]').click());
  await until(() => !!document.querySelector('.sw-mode[data-mode="sandbox"]'), null, 'the new game dialog');
  await page.evaluate(() => { document.querySelector('.sw-mode[data-mode="sandbox"]').click(); document.querySelector('.sw-modal .sw-btn.primary').click(); });
  await until(() => window.__sw.app.currentName === 'hub' && !!window.__sw.app.current, null, 'the space centre');
  await page.evaluate(q => { const s = window.__sw.app.settings; s.gfxForce = true; s.gfxQuality = q; s.showHints = false; window.__sw.app.applySettings && window.__sw.app.applySettings(); }, QUALITY);

  // the rocket: an upper stage with a guidance ring under a shroud nose, and a first stage with its own ring, grid fins and legs
  await page.evaluate(async () => {
    const { Craft } = await import('/js/core/craft.js');
    const c = new Craft('Homecoming');
    const [pod] = c.setRoot('probe_wisp');
    if (!c.attachStack('fairing_m', pod.id, 'top')[0]) throw new Error('the shroud nose did not attach');   // a payload shroud, so the top is not a blunt ring
    let cur = pod, first = null, last = null;
    const lower = ['tank_m800', 'tank_m800', 'tank_m400'];
    for (const t of ['tank_m400', 'eng_sparrow', 'dec_m', 'probe_wisp', ...lower, 'eng_goshawk']) {
      const [p] = c.attachStack(t, cur.id, 'bottom');
      if (lower.includes(t)) { if (cur.type === 'probe_wisp') first = p; last = p; }
      cur = p;
    }
    c.attachRadial('fin_grid', first.id, first.pos.y + 0.6, Math.PI / 4, 4);
    c.attachRadial('leg_heron', last.id, last.pos.y - 3.75 / 2 + 1.9, Math.PI / 4, 4);   // folding legs, hinged at the foot of the last tank
    c.autoStage();
    window.__sw.app.goto('flight', { craft: c.toJSON(), crew: [] });
  });
  await until(() => window.__sw.app.currentName === 'flight' && !!window.__sw.app.current && !!window.__sw.world.active, null, 'the launch pad');
  await page.addStyleTag({ content: HIDE });
  await tick(1500);

  await page.evaluate(async ({ step, target }) => {
    const sw = window.__sw, app = sw.app, w = sw.world, f = app.flight;
    const { SYSTEM } = await import('/js/core/bodies.js');
    app.fixedStep = step;
    const C = window.__cap = { t0: w.ut, upper: w.active, booster: null, ev: {}, log: [], tel: [], lastTel: -1, who: 'upper', spin: 0, sep: null, touch: null, target: target === 'barge' ? SYSTEM.home.sites.barge.dir.clone() : SYSTEM.home.sites.landing.dir.clone() };
    const mark = (k) => { if (C.ev[k] === undefined) C.ev[k] = w.ut - C.t0; };
    w.on('decouple', d => { if (!C.booster && d.debris.type === 'ship') { C.booster = d.debris; d.debris.updateTelemetry(w.ut); C.sep = { alt: d.debris.altitude, speed: d.debris.airspeed }; mark('sep'); } });
    w.on('landed', d => { if (C.booster && d.vessel === C.booster && !C.touch) { C.touch = { speed: d.speed }; mark('landed'); } });
    w.on('splashed', d => { if (C.booster && d.vessel === C.booster) mark('splashed'); });
    w.on('destroyed', d => { if (C.booster && d.vessel === C.booster) mark('lost'); });
    // only the flight's own call-outs on screen: no milestones, no hints, no "now flying"
    const toast = app.toast.bind(app);
    app.toast = (text, ...rest) => { C.log.push((w.ut - C.t0).toFixed(1) + ' ' + text); if (/Milestone|Next mission|Now flying|engaged|take over|has run dry|Time warp/.test(String(text))) return null; return toast(text, ...rest); };
    // every frame goes through this: it keeps the camera on the vessel the shot follows and turns it slowly
    const screen = app.current, update = screen.update;
    screen.update = function (dt) {
      const b = C.booster;
      if (C.spin) f.cam.yaw += C.spin * dt;
      const r = update.call(this, dt);
      if (b && !b.dead && w.ut - C.lastTel >= 0.5) { C.lastTel = w.ut; C.tel.push([+(w.ut - C.t0).toFixed(2), Math.round(b.altitude), Math.round(b.radarAlt), +b.airspeed.toFixed(1), +b.verticalSpeed.toFixed(1), +b.ctrl.throttle.toFixed(2)]); }
      if (b && !b.dead) {
        if (b.program === 'recovery' || f.assistKind === 'recovery') { if (b.ctrl.throttle > 0.05 && C.ev.sep !== undefined && w.ut - C.t0 > C.ev.sep + 2 && b.altitude > 15000) mark('boostback'); }
        if (b.verticalSpeed < -60 && b.altitude < 14000) mark('falling');
        if (C.ev.falling !== undefined && b.ctrl.throttle > 0.05 && b.radarAlt < 3000) mark('burn');
      }
      return r;
    };
    C.mark = mark;
  }, { step: 1 / FPS, target });

  // run the game's own update for `sim` seconds off camera, or until the page says stop
  const run = async (sim, stop = 'false') => {
    let left = sim, hit = false;
    while (left > 1e-6 && !hit) {
      const r = await page.evaluate(({ budget, stop, dt }) => {
        const sw = window.__sw, app = sw.app, C = window.__cap, test = new Function('w', 'B', 'C', 'return (' + stop + ');');
        const u0 = sw.world.ut, t0 = performance.now(); let hit = false;
        while (sw.world.ut - u0 < budget - 1e-9 && performance.now() - t0 < 300) { app.current.update(dt); app.input.endFrame(); if (test(sw.world, C.booster, C)) { hit = true; break; } }
        return { adv: sw.world.ut - u0, hit };
      }, { budget: left, stop, dt: 1 / FPS });
      hit = r.hit; left -= Math.max(r.adv, 1e-3);
    }
    return hit;
  };
  const met = () => page.evaluate(() => window.__sw.world.ut - window.__cap.t0);
  // the player's own hop key (backslash) steps between the upper stage and the booster
  const hopTo = async who => {
    for (let k = 0; k < 3; k++) {
      if (await page.evaluate(who => { const C = window.__cap, want = who === 'booster' ? C.booster : C.upper; return !want || want.dead || window.__sw.world.active === want; }, who)) return;
      await page.keyboard.down('Backslash'); await page.waitForTimeout(60);
      await page.evaluate(dt => { const a = window.__sw.app; a.current.update(dt); a.input.endFrame(); }, 1 / FPS);
      await page.keyboard.up('Backslash'); await page.waitForTimeout(40);
    }
  };
  const follow = async (who, cam, spin) => { await hopTo(who); return followCam(who, cam, spin); };
  const followCam = (who, cam, spin) => page.evaluate(({ who, cam, spin }) => {
    const sw = window.__sw, f = sw.app.flight, w = sw.world, C = window.__cap;
    const want = who === 'booster' ? C.booster : C.upper;
    const c = f.cam; c.yaw = cam.yaw; c.pitch = cam.pitch; if (c.setDist) c.setDist(cam.dist); c.dist = cam.dist;
    C.spin = spin; C.who = who;
  }, { who, cam, spin });

  // ignition: the ascent assist flies the upper stage; the booster's return starts by itself at separation
  const liftoffAt = 2;
  const begin = async () => { await page.evaluate(() => { window.__sw.app.flight.actions.toggleAssist(); }); };
  const toBarge = async () => { if (target !== 'barge') return; await page.evaluate(() => { const sw = window.__sw, f = sw.app.flight, C = window.__cap; if (sw.world.active !== C.booster) f.actions.hopVessel(); f.actions.runProgram('recoverybarge'); }); };

  if (!plan) {
    await run(liftoffAt); await begin(); await page.evaluate(() => window.__cap.mark('liftoff'));
    await run(260, 'C.ev.sep !== undefined'); await run(2); await toBarge();
    await run(900, 'C.ev.landed !== undefined || C.ev.splashed !== undefined || C.ev.lost !== undefined');
    await run(15, 'B && (B.dead || B.landed)'); await run(1);      // (on long legs a stage takes a few seconds to settle after its pads touch)
    const out = await page.evaluate(() => { const C = window.__cap, w = window.__sw.world, b = C.booster; const here = b && !b.dead ? b.body.inertialToSurfaceDir(b.pos.clone(), w.ut) : null; return { ev: C.ev, sep: C.sep, touch: C.touch, log: C.log, miss: here ? Math.acos(Math.min(1, here.dot(C.target))) * b.body.radius : null, landed: !!(b && b.landed && !b.splashed), dv: b && !b.dead ? b.estimateDeltaV() : 0 }; });
    await ctx.close();
    return out;
  }

  const files = [];
  let n = 0, started = false;
  for (const S of SHOTS) {
    const at = plan.ev[S.at];
    if (at === undefined) { console.log(`   no "${S.at}" in this flight: shot ${S.name} skipped`); continue; }
    const startAt = Math.max(0, at - S.lead), now = await met();
    // off camera up to the start of the shot (ignition falls inside the first shot)
    const gap = startAt - now;
    if (gap > 0) {
      if (!started && liftoffAt <= startAt) { await run(liftoffAt - now); await begin(); started = true; await run(startAt - liftoffAt); }
      else await run(gap);
    }
    if (S.who === 'booster' && target === 'barge' && !plan._sent) { await toBarge(); plan._sent = true; }
    await follow(S.who, S.cam, S.spin);
    await tick(STEP * 30);                    // let the picture catch up with where the vessel now is
    const out = path.join(outDir, `${target}-${aspect}-${String(++n).padStart(2, '0')}-${S.name}.mp4`);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '15', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const t0 = Date.now(), max = Math.round(S.len * FPS);
    let i = 0, endAt = -1;
    const shotStart = await met();
    for (; i < max; i++) {
      if (!started && (await met()) >= liftoffAt - 1e-6) { await begin(); started = true; }
      await page.clock.runFor(STEP);
      if (i % 3 === 0) await page.waitForTimeout(1);
      const buf = await page.screenshot({ type: 'jpeg', quality: 94, timeout: 120000 });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (S.end && endAt < 0 && i % 6 === 0 && await page.evaluate(k => window.__cap.ev[k] !== undefined || window.__cap.ev.lost !== undefined || window.__cap.ev.splashed !== undefined, S.end)) endAt = i;
      if (endAt >= 0 && i - endAt >= S.tail * FPS) break;
      if (i % 240 === 0 && i) console.log(`   ${S.name}: frame ${i} (${((Date.now() - t0) / 1000).toFixed(0)} s elapsed)`);
    }
    ff.stdin.end(); await new Promise(r => ff.on('close', r));
    const shotEnd = await met();
    files.push({ file: path.basename(out), shot: S.name, from: +shotStart.toFixed(2), to: +shotEnd.toFixed(2), seconds: +(i / FPS).toFixed(2), event: S.at, eventAt: +at.toFixed(2) });
    console.log(`   wrote ${path.basename(out)}: T+${shotStart.toFixed(1)} to T+${shotEnd.toFixed(1)} s (${(i / FPS).toFixed(1)} s) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const end = await page.evaluate(() => { const C = window.__cap, w = window.__sw.world, b = C.booster; const here = b && !b.dead ? b.body.inertialToSurfaceDir(b.pos.clone(), w.ut) : null; return { ev: C.ev, sep: C.sep, touch: C.touch, log: C.log, tel: C.tel, miss: here ? Math.acos(Math.min(1, here.dot(C.target))) * b.body.radius : null, landed: !!(b && b.landed && !b.splashed) }; });
  await ctx.close();
  return { files, end };
}

for (const aspect of aspectList) {
  const A = ASPECTS[aspect];
  console.log(`${target}-${aspect}: timing pass (not filmed)`);
  const plan = await flight(A, aspect, null);
  console.log('   events (s after the clock started): ' + JSON.stringify(plan.ev) + `; separation at ${(plan.sep.alt / 1000).toFixed(1)} km, ${plan.sep.speed.toFixed(0)} m/s; landed ${plan.landed}, ${plan.miss === null ? '?' : plan.miss.toFixed(2)} m from the target, touchdown ${plan.touch ? plan.touch.speed.toFixed(2) : '?'} m/s, ${plan.dv.toFixed(0)} m/s left`);
  if (!plan.landed) { console.error('The booster did not land on the timing pass: nothing filmed.'); report.takes.push({ aspect, plan }); continue; }
  const take = await flight(A, aspect, plan);
  const same = Math.abs((take.end.ev.landed || 0) - plan.ev.landed) < 0.05;
  console.log(`   filmed flight: landed ${take.end.landed}, ${take.end.miss === null ? '?' : take.end.miss.toFixed(2)} m from the target, touchdown at T+${(take.end.ev.landed || 0).toFixed(2)} s (${same ? 'the same flight as the timing pass' : 'NOT the same as the timing pass: ' + plan.ev.landed.toFixed(2)})`);
  report.takes.push({ aspect, plan: { ev: plan.ev, sep: plan.sep, touch: plan.touch, miss: plan.miss, dv: plan.dv, log: plan.log }, files: take.files, filmed: take.end });
}
fs.writeFileSync(path.join(outDir, `report-${target}.json`), JSON.stringify(report, null, 2));
await browser.close(); server.close();
console.log('ALL DONE');
