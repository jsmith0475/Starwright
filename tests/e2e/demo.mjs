// End-to-end test of the demo tour (js/ui/demo.js): runs the whole tour accelerated (&fast=1) in headless Chromium and
// checks that every chapter starts, shows its caption and reaches its end, that the tour ends by itself with no page
// errors, and that the player's saved game, quicksave and settings are byte-for-byte what they were before.
//   node tests/e2e/demo.mjs                 the whole suite
//   node tests/e2e/demo.mjs orbit,map       only those chapters (each started on its own; for debugging)
// Round 3 (a play-test showed the rocket "launching from under the ground" while every suite was green) added what a viewer
// would notice, checked on every drawn frame by the tour's own &watch=1 monitor (js/ui/demo.js makeWatch):
//   · the flight camera never under the ground, the ship never under the ground, the ship never out of the picture,
//     no jump of the picture without a cut;
//   · the whole tour IN ORDER at its real pace on a machine that draws only ten frames a second (&step=0.1), where
//     every chapter must still end "ok" with no stand-in, and the tour must be shorter than six minutes of tour time;
//   · a wall clock that runs forty times too fast must not fail a chapter (time limits count tour time);
//   · after a chapter that fails, the next one must not go back to the pad.
// What runs where. A software renderer (the cloud machines) needs seconds for one frame, so the tour at its real pace
// cannot be judged there; those checks are in their own section and are SKIPPED, with a line that says so, unless
// REAL_GPU is set:
//   node tests/e2e/demo.mjs                      accelerated tour, forced failure, lying wall clock (any machine)
//   REAL_GPU=1 node tests/e2e/demo.mjs           the above + the tour in order at real speed in a real Chrome window
//   REAL_GPU=only node tests/e2e/demo.mjs        only the real-speed section   (DEMO_CHANNEL=chrome, DEMO_DPR=2,
//                                                DEMO_SIZE=1440x900 are the defaults)
//   DEMO_REPORT=report.json node tests/e2e/demo.mjs
//       no browser: judges a report saved from a run by hand. Open …/?demo=1&clean=1&watch=1 on the real machine, let
//       it end, then in the console: copy(JSON.stringify(__demoReport)) and paste into the file.
// The real-speed checks: every chapter "ok" with no stand-in; no per-frame finding (camera or ship under the ground,
// ship out of the picture, a jump with no cut, darkness near the ground, ground still loading when a scene is shown);
// every caption on screen long enough to be read; the tour between four and six minutes of tour time.
// A log of the run (the tour's own log and the per-chapter table) is written to tests/out/demo-e2e-<pid>.log.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, `demo-e2e-${process.pid}.log`);
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = ['starwright.save.v1', 'starwright.quicksave.v1', 'starwright.settings.v1', 'starwright.save.corrupt'];

let checks = 0;
const problems = [], lines = [];
const log = s => { lines.push(s); console.log(s); };
const check = (ok, what) => { checks++; if (!ok) { problems.push(what); log('  FAIL ' + what); } return ok; };

const REAL = process.env.REAL_GPU || '', REAL_ONLY = REAL === 'only', REPORT_FILE = process.env.DEMO_REPORT || '';
const TOUR_MAX = 360;                    // seconds of tour time: the tour is meant to be four to six minutes long
const TOUR_MIN = 240;
const CHAPTER_IDS = ['title', 'centre', 'build', 'launch', 'orbit', 'map', 'landing', 'eva', 'reentry', 'plane', 'rover', 'docking', 'tracking', 'system', 'program', 'closing'];
/** The checks on a tour at its real pace, made on window.__demoReport (see js/ui/demo.js reportChapter). */
function judgeReport(rep, label) {
  if (!check(!!rep && Array.isArray(rep.chapters) && rep.chapters.length > 0, `${label}: there is no report`)) return;
  for (const c of rep.chapters) {
    log(`  ${c.id.padEnd(9)} ${String(c.status).padEnd(8)} ${String(c.tourSeconds).padStart(6)} s tour ${String(c.wallSeconds).padStart(6)} s wall  ground wait ${c.groundWaitSeconds ?? '?'} s  captions ${c.captions.map(x => `${x.text} ${x.seconds}s`).join(', ')}`);
    check(c.status === 'ok', `${label}: chapter ${c.id} ended as "${c.status}"${c.fallback ? ' (' + c.fallback + ')' : ''}`);
    check(c.captions.length > 0, `${label}: chapter ${c.id} showed no caption`);
    for (const pr of c.problems) check(false, `${label}: ${c.id}: [${pr.kind}] ${pr.detail}`);
    // the same clock for both on a machine that keeps up: tour time falls behind wall time when frames take over 0.1 s
    check(c.wallSeconds < c.tourSeconds * 1.25 + 2, `${label}: chapter ${c.id} took ${c.wallSeconds} s of real time for ${c.tourSeconds} s of tour (the machine did not keep up, or the page was in the background)`);
  }
  for (const id of CHAPTER_IDS) check(rep.chapters.some(c => c.id === id), `${label}: chapter ${id} is not in the report`);
  const t = rep.total;
  if (!check(!!t && t.ended, `${label}: the tour did not end by itself`)) return;
  log(`  total ${Math.floor(t.tourSeconds / 60)}:${String(Math.round(t.tourSeconds % 60)).padStart(2, '0')} of tour time, ${t.wallSeconds} s of real time, ${t.problems} problem(s)`);
  check(t.tourSeconds < TOUR_MAX, `${label}: the tour is ${Math.floor(t.tourSeconds / 60)}:${String(Math.round(t.tourSeconds % 60)).padStart(2, '0')} long; it must be under ${TOUR_MAX / 60} minutes`);
  check(t.tourSeconds > TOUR_MIN, `${label}: the tour is only ${t.tourSeconds} s long; it is meant to be four to six minutes`);
}
if (REPORT_FILE) {
  log(`judging the saved report ${REPORT_FILE}`);
  let rep = null;
  try { rep = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')); } catch (err) { check(false, 'the report could not be read: ' + err.message); }
  if (rep) judgeReport(rep, 'saved report');
  log(`${checks} checks, ${problems.length} problem(s)`);
  fs.appendFileSync(LOG, lines.join('\n') + '\n');
  process.exit(problems.length ? 1 : 0);
}

const server = await startServer(ROOT);
const [VW, VH] = (process.env.DEMO_SIZE || '1440x900').split('x').map(Number);
const browser = REAL
  ? await chromium.launch({ headless: false, channel: process.env.DEMO_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  : await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: REAL ? VW : 1440, height: REAL ? VH : 900 }, deviceScaleFactor: REAL ? Number(process.env.DEMO_DPR || 2) : 1 });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('console error: ' + m.text()); });
page.on('pageerror', e => errors.push('page error: ' + (e.stack || e.message)));

const E = (fn, arg) => page.evaluate(fn, arg);
const ready = () => page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app.demo, null, { timeout: 120000 });
const storage = () => E(keys => { const o = Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)])); for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return Object.fromEntries(Object.entries(o).sort()); }, KEYS);
const state = () => E(() => window.__sw.app.demo.state());
/** The per-frame checks (&watch=1). `jumps`: also fail on picture jumps and on ground that loads in view (not in
 *  accelerated runs: their frames are 8× apart, and they do not wait for the ground before a scene opens). */
async function watched(label, { jumps = true, ids = null } = {}) {
  const w = await E(() => window.__sw.app.demo.watchReport());
  if (!check(!!w && Object.keys(w.chapters).length > 0, `${label}: the per-frame checks did not run`)) return null;
  for (const [id, c] of Object.entries(w.chapters)) {
    if (ids && !ids.includes(id)) continue;
    if (c.flightFrames) log(`  watch ${id.padEnd(9)} ${String(c.flightFrames).padStart(5)} flight frames  camera ≥ ${c.minCamClear} m  ship ≥ ${c.minRadar} m  out of picture ${c.maxOffStreak} s  jumps ${c.jumps.length}`);
  }
  for (const p of w.problems) { if (ids && !ids.includes(p.split(':')[0])) continue; if (!jumps && /the picture jumped|the ground was still loading/.test(p)) { log('  (accelerated run) ' + p); continue; } check(false, `${label}: ${p}`); }
  return w;
}

/** Follow a running tour to its end; returns the final state and, per chapter, what was seen on the way. */
async function follow(maxSeconds, stopAfter = null) {
  const seen = {};
  const t0 = Date.now();
  let st = null;
  for (;;) {
    st = await state();
    for (const c of st.chapters) {
      const s = seen[c.id] || (seen[c.id] = { started: false, captionShown: false });
      if (c.status !== 'pending') s.started = true;
    }
    if (st.chapter && st.captionShown && st.caption) seen[st.chapter].captionShown = true;
    if (!st.running) break;
    if (stopAfter && st.chapter !== stopAfter && seen[stopAfter] && seen[stopAfter].started) { await E(() => window.__sw.app.demo.stop()); st = await state(); break; }
    if ((Date.now() - t0) / 1000 > maxSeconds) { check(false, `the tour was still running after ${maxSeconds} s (in chapter ${st.chapter})`); await E(() => window.__sw.app.demo.stop()); st = await state(); break; }
    await page.waitForTimeout(150);
  }
  return { st, seen, seconds: (Date.now() - t0) / 1000 };
}
function report(st, seen, ids) {
  for (const c of st.chapters) {
    if (ids && !ids.includes(c.id)) continue;
    const s = seen[c.id] || {};
    log(`  ${c.id.padEnd(9)} ${String(c.status).padEnd(8)} ${String(c.seconds ?? '').padStart(6)} s  captions ${c.captions}${c.fallbacks && c.fallbacks.length ? '  fallback: ' + c.fallbacks.join('; ') : ''}${c.error ? '  error: ' + c.error : ''}`);
    check(!!s.started, `chapter ${c.id} did not start`);
    check(c.captions > 0 && !!c.captionSeen, `chapter ${c.id} showed no caption`);
    check(c.status === 'ok', `chapter ${c.id} ended as "${c.status}"${c.error ? ': ' + c.error : ''}${c.fallbacks && c.fallbacks.length ? ' (' + c.fallbacks.join('; ') + ')' : ''}`);
  }
}

try {
  // ---- a player with a saved game, a quicksave and settings of their own
  await page.goto(server.url + 'index.html', { timeout: 180000 });
  await ready();
  await E(() => {
    const app = window.__sw.app;
    const c = app.Career.newGame('science', { seed: 5 });
    c.science = 123; c.save();
    localStorage.setItem('starwright.quicksave.v1', localStorage.getItem('starwright.save.v1'));
    const s = JSON.parse(localStorage.getItem('starwright.settings.v1') || '{}');
    s.demoTestMarker = 'keep-me';
    localStorage.setItem('starwright.settings.v1', JSON.stringify(s));
  });
  const before = await storage();
  check(!!before[KEYS[0]] && !!before[KEYS[1]] && !!before[KEYS[2]], 'the test could not prepare a saved game');

  if (!ONLY.length && !REAL_ONLY) {
    // ---- the entry on the title screen, pause and exit keys
    await page.reload({ timeout: 180000 });
    await ready();
    const btn = page.locator('.sw-menu [data-action="demo"]');
    check(await btn.count() === 1, 'no "Demo tour" button on the title screen');
    if (await btn.count()) {
      await btn.click();
      await page.waitForFunction(() => window.__sw.app.demo.running, null, { timeout: 10000 }).catch(() => {});
      let st = await state();
      check(st.running && st.sandbox, 'the title-screen button did not start the tour in its sandbox');
      check(await page.locator('.swd .swd-strip').count() === 1 && await page.locator('.swd .swd-progress span').count() === st.chapters.length, 'the overlay has no control strip or progress bar');
      await page.waitForFunction(() => window.__sw.app.demo.state().captionShown, null, { timeout: 30000 }).catch(() => {});
      st = await state();
      check(st.captionShown && st.caption === 'Starwright', 'the first caption did not appear');
      await page.keyboard.press('Space');
      st = await state();
      const clock = st.clock;
      check(st.paused, 'Space did not pause the tour');
      await page.waitForTimeout(700);
      check((await state()).clock === clock, 'the tour clock ran while paused');
      await page.keyboard.press('Space');
      check(!(await state()).paused, 'Space did not resume the tour');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => window.__sw.app.demo.state().chapter === 'centre', null, { timeout: 20000 }).catch(() => {});
      check((await state()).chapter === 'centre', 'the right arrow did not go to the next chapter');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__sw.app.demo.running && !document.querySelector('.swd'), null, { timeout: 60000 }).catch(() => {});
      st = await state();
      check(!st.running && !st.sandbox, 'Esc did not leave the tour');
      check(await E(() => window.__sw.app.currentName) === 'title', 'leaving the tour did not return to the title screen');
      check(JSON.stringify(await storage()) === JSON.stringify(before), 'starting and leaving the tour changed the stored game');
    }

    // ---- the entry in the Flight Center menu: starts from a running game, Esc brings that game back
    await page.locator('.sw-menu [data-action="continue"]').click();
    await page.waitForFunction(() => window.__sw.app.currentName === 'hub' && window.__sw.app.current, null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('[data-action="menu"]').first().click();
    const inGame = await storage();                  // continuing the game is the player's own doing; the tour must add nothing to it
    const item = page.locator('.sw-modal [data-menu="demo"]');
    check(await item.count() === 1, 'no "Demo tour" entry in the Flight Center menu');
    if (await item.count()) {
      await item.click();
      await page.waitForFunction(() => window.__sw.app.demo.running, null, { timeout: 10000 }).catch(() => {});
      check((await state()).sandbox, 'the Flight Center entry did not start the tour in its sandbox');
      await page.waitForTimeout(800);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.__sw.app.demo.running && !document.querySelector('.swd') && window.__sw.app.currentName === 'hub', null, { timeout: 120000 }).catch(() => {});
      check(await E(() => window.__sw.app.currentName === 'hub' && window.__sw.app.career && !window.__sw.app.career.demo && window.__sw.app.career.mode === 'science' && window.__sw.app.career.science === 123), 'leaving the tour did not bring the player\'s own game back to the Flight Center');
      check(JSON.stringify(await storage()) === JSON.stringify(inGame), 'a tour started from the Flight Center changed the stored game');
    }
    // (leaving a running game saves it, which is the game's own doing: take the reference from a fresh title screen)
    await page.goto(server.url + 'index.html', { timeout: 180000 });
    await ready();
    const stored = await storage();

    // ---- the whole tour, accelerated, started from the address
    await page.goto(server.url + 'index.html?demo=1&fast=1&clean=1&watch=1', { timeout: 180000 });
    await ready();
    await page.waitForFunction(() => window.__sw.app.demo.running || window.__sw.app.demo.state().ended, null, { timeout: 20000 }).catch(() => {});
    check(await page.locator('.swd.clean').count() === 1, 'clean mode was not applied');
    const { st, seen, seconds } = await follow(900);
    log(`full tour (fast): ${seconds.toFixed(0)} s real, ${st.clock} s tour clock`);
    report(st, seen);
    const wf = await watched('accelerated tour', { jumps: false });
    for (const id of ['launch', 'orbit', 'landing', 'eva', 'reentry', 'plane', 'rover', 'docking']) check(!!wf && !!wf.chapters[id] && wf.chapters[id].flightFrames > 0, `the per-frame checks saw no flight in chapter ${id}`);
    check(st.ended, 'the tour did not end by itself');
    check(st.chapters.length >= 14, 'fewer chapters than expected: ' + st.chapters.length);
    await page.waitForFunction(() => !document.querySelector('.swd') && window.__sw.app.currentName === 'title', null, { timeout: 60000 }).catch(() => {});
    check(await page.locator('.swd').count() === 0, 'the overlay was left behind');
    check(await E(() => window.__sw.app.currentName) === 'title', 'the tour did not end on the title screen');
    check(await E(() => !window.__sw.app.career || !window.__sw.app.career.demo), 'the sandbox program was left in place');
    check(await E(() => /native code/.test(String(Math.random))), 'Math.random was not put back');
    check(await E(() => !document.body.classList.contains('sw-demo') && !document.body.classList.contains('sw-demo-closing')), 'body classes were left behind');
    const after = await storage();
    for (const k of new Set([...KEYS, ...Object.keys(stored), ...Object.keys(after)])) check(after[k] === stored[k], `stored key ${k} changed during the tour`);
    check(await page.locator('.sw-menu [data-action="continue"]').count() === 1, 'the title screen no longer offers the saved game');
    fs.appendFileSync(LOG, st.log.map(l => `${String(l.t).padStart(7)} ${l.chapter.padEnd(9)} ${l.kind.padEnd(5)} ${l.msg}`).join('\n') + '\n');

    // ---- after a chapter that fails, the tour goes on with a picture that looks meant: the next chapter's stand-in
    //      is the rocket already climbing, not a second roll-out seen from inside the launch tower
    await page.goto(server.url + 'index.html?demo=1&fast=1&clean=1&watch=1&chapter=launch&fail=launch', { timeout: 180000 });
    await ready();
    await page.waitForFunction(() => window.__sw.app.demo.running, null, { timeout: 20000 }).catch(() => {});
    {
      const { st: s2, seconds: sec2 } = await follow(400, 'orbit');
      const launch = s2.chapters.find(c => c.id === 'launch'), orbit = s2.chapters.find(c => c.id === 'orbit');
      log(`after a failed launch chapter (${sec2.toFixed(0)} s real): launch ${launch.status}, orbit ${orbit.status} ${orbit.seconds} s${orbit.fallbacks.length ? ' fallback: ' + orbit.fallbacks.join('; ') : ''}${orbit.error ? ' error: ' + orbit.error : ''}`);
      check(launch.status === 'failed', 'the launch chapter was not made to fail (&fail=launch)');
      check(orbit.status === 'ok', `after a failed launch the orbit chapter ended as "${orbit.status}"${orbit.error ? ': ' + orbit.error : ''}`);
      const w2 = await watched('after a failed launch', { jumps: false, ids: ['orbit'] });
      const o = w2 && w2.chapters.orbit;
      check(!!o && o.flightFrames > 0 && o.minRadar > 1000, `after a failed launch the orbit chapter showed the rocket ${o ? o.minRadar : '?'} m above the ground (it must open on the rocket in flight, not on the pad)`);
    }

    // ---- a wall clock that lies: chapter time limits and waits count tour time, so a clock running forty times too
    //      fast (or a page that needs minutes for a few frames) must not fail a chapter
    {
      const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const p2 = await ctx2.newPage();
      p2.on('pageerror', e => errors.push('page error (fast wall clock): ' + (e.stack || e.message)));
      await p2.addInitScript(() => { const real = performance.now.bind(performance), t0 = real(); performance.now = () => t0 + (real() - t0) * 40; });
      await p2.goto(server.url + 'index.html?demo=1&clean=1&step=1/30&chapter=title', { timeout: 180000 });
      await p2.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app.demo && window.__sw.app.demo.running, null, { timeout: 120000 });
      await p2.waitForFunction(() => { const s = window.__sw.app.demo.state(); return !s.running || s.index > 0; }, null, { timeout: 600000, polling: 200 }).catch(() => {});
      const s3 = await p2.evaluate(() => { const d = window.__sw.app.demo, s = d.state(); d.stop(); return s; });
      const t = s3.chapters[0];
      log(`title chapter with the wall clock 40× fast: ${t.status} after ${t.seconds} s of tour time${t.error ? ' (' + t.error + ')' : ''}`);
      check(t.status === 'ok', `with a fast wall clock the title chapter ended as "${t.status}"${t.error ? ': ' + t.error : ''}`);
      check(t.seconds > 5 && t.seconds < 14, `with a fast wall clock the title chapter took ${t.seconds} s of tour time (fixed step: it should not depend on the clock)`);
      await ctx2.close();
    }

    // the report every run leaves behind (window.__demoReport): here only that it is complete; it is judged at real speed
    {
      await page.goto(server.url + 'index.html?demo=1&fast=1&clean=1&watch=1&chapter=program', { timeout: 180000 });
      await ready();
      await page.waitForFunction(() => window.__sw.app.demo.running, null, { timeout: 20000 }).catch(() => {});
      await follow(400);
      const rep = await E(() => window.__demoReport);
      check(!!rep && rep.chapters.length === 2 && rep.chapters[0].id === 'program' && rep.chapters[1].id === 'closing', 'the report of a run from the program chapter does not list program and closing');
      check(!!rep && !!rep.total && rep.total.ended === true && rep.total.tourSeconds > 0, 'the report has no total');
      for (const c of (rep ? rep.chapters : [])) {
        check(typeof c.tourSeconds === 'number' && typeof c.wallSeconds === 'number' && typeof c.ok === 'boolean' && Array.isArray(c.problems) && Array.isArray(c.captions) && c.captions.length > 0 && c.captions.every(x => x.text && x.seconds >= 0), `the report of chapter ${c.id} is not complete: ${JSON.stringify(c).slice(0, 300)}`);
        check(c.status === 'ok', `chapter ${c.id} ended as "${c.status}" in the report run`);
      }
      const prog = rep && rep.chapters[0];
      check(!!prog && prog.captions.some(x => x.text === 'Scenarios'), 'the program chapter did not show the Scenarios picker');
    }
  }

  // ---- the whole tour IN ORDER at its real pace. Only meaningful where frames are drawn at the speed a viewer sees
  //      them, so it needs a real GPU (REAL_GPU=1); on a software renderer one frame takes seconds. Nothing here was
  //      dropped from the suite: these are the checks that used to run in a ten-frames-a-second section which could
  //      not finish on the cloud machines (an hour was not enough).
  if (ONLY.length) { /* single chapters: below */ }
  else if (!REAL) log('SKIPPED: the tour in order at real speed (per-frame checks, caption pace, length under six minutes). Run with REAL_GPU=1 on a machine with a GPU, or judge a saved report with DEMO_REPORT=<file>.');
  else {
    await page.goto(server.url + 'index.html?demo=1&clean=1&watch=1', { timeout: 180000 });
    await ready();
    await page.waitForFunction(() => window.__sw.app.demo.running || window.__sw.app.demo.state().ended, null, { timeout: 20000 }).catch(() => {});
    const { st: s4, seen: seen4, seconds: sec4 } = await follow(900);
    log(`full tour in order at real speed: ${sec4.toFixed(0)} s real, ${s4.clock} s tour clock`);
    report(s4, seen4);
    check(s4.ended, 'the real-speed tour did not end by itself');
    await watched('tour at real speed');
    for (const c of s4.chapters) check(!c.lapseCut, `chapter ${c.id}: a time-lapse was cut short ${c.lapseCut}× (the machine could not keep up)`);
    judgeReport(await E(() => window.__demoReport), 'tour at real speed');
    fs.appendFileSync(LOG, '\nreal-speed tour\n' + s4.log.map(l => `${String(l.t).padStart(7)} ${l.chapter.padEnd(9)} ${l.kind.padEnd(5)} ${l.msg}`).join('\n') + '\n');
  }

  if (ONLY.length) {
    for (const id of ONLY) {
      await page.goto(server.url + `index.html?demo=1&fast=1&chapter=${id}`, { timeout: 180000 });
      await ready();
      await page.waitForFunction(() => window.__sw.app.demo.running, null, { timeout: 20000 }).catch(() => {});
      const { st, seen, seconds } = await follow(400, id);
      log(`chapter ${id}: ${seconds.toFixed(0)} s real`);
      report(st, seen, [id]);
      for (const l of st.log) if (l.kind !== 'info' || process.env.DEMO_VERBOSE) log(`     ${l.kind} ${l.chapter}: ${l.msg}`);
      const after = await storage();
      for (const k of KEYS) check(after[k] === before[k], `stored key ${k} changed during chapter ${id}`);
    }
  }
} catch (err) {
  check(false, 'the test itself stopped: ' + (err && err.stack || err));
}
for (const e of errors) check(false, e);
check(true, 'no page errors');
await browser.close();
await server.close();
log(`${checks} checks, ${problems.length} problem(s)`);
fs.appendFileSync(LOG, lines.join('\n') + '\n');
process.exit(problems.length ? 1 : 0);
