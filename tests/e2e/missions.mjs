// End-to-end test of missions as a gameplay loop: the title menu's Missions entry, the flight program (the fixed
// chain of milestone missions) in Mission Control, accepting a contract and flying it with the in-flight mission
// tracker open, the notices and the payment, a missed deadline, a cancelled contract, and the same screens in a
// sandbox program (no contracts, the program still tracked).
//   node tests/e2e/missions.mjs [only=title,program,contract,deadline,cancel,sandbox]     (screenshots: tests/out/missions-*.png)
// Menus are clicked with the real mouse; the flight itself is stepped through the flight screen's own update loop
// (as the other suites do), because a software rasteriser cannot fly an ascent in real time.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const only = (process.argv.find(a => a.startsWith('only=')) || '').slice(5).split(',').filter(Boolean);
const want = name => !only.length || only.includes(name);

const problems = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
page.on('console', m => { if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));

const E = (fn, arg) => page.evaluate(fn, arg);
const shot = name => page.screenshot({ path: path.join(OUT, 'missions-' + name + '.png'), timeout: 240000 }).catch(e => console.log('  (screenshot ' + name + ' skipped: ' + e.message.split('\n')[0] + ')'));
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 600000 });
  await page.waitForTimeout(300);
}
const career = () => E(() => { const c = window.__sw.career; return c ? { mode: c.mode, funds: c.funds, science: c.science, rep: c.reputation, ut: c.ut, ms: [...c.milestones], next: c.nextProgramStep() && c.nextProgramStep().id,
  offered: c.contracts.offered.map(k => ({ id: k.id, type: k.type, title: k.title, advance: k.advance, days: k.days })),
  active: c.contracts.active.map(k => ({ id: k.id, type: k.type, title: k.title, advance: k.advance, reward: k.reward, penalty: k.penalty, days: k.days, done: k.objectives.map(o => !!o.done) })),
  completed: c.contracts.completed.map(k => k.id), failed: c.contracts.failed.map(k => ({ id: k.id, reason: k.reason })) } : null; });
/** Every toast the game raises is kept (toasts queue and time out; the test must not depend on catching them on screen). */
const tapToasts = () => E(() => { const app = window.__sw.app; if (app.__toasts) return; app.__toasts = []; const t = app.toast; app.toast = (text, ...rest) => { app.__toasts.push(String(text)); return t(text, ...rest); }; });
const toasts = () => E(() => window.__sw.app.__toasts || []);
const clearToasts = () => E(() => { if (window.__sw.app.__toasts) window.__sw.app.__toasts.length = 0; });
/** Run the flight screen's own update loop for `sim` seconds, or until the expression over (w, v) holds. */
async function ff(sim, until = 'false', dt = 0.05) {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await E(({ budget, until, dt }) => {
      const sw = window.__sw, app = sw.app;
      const test = new Function('w', 'v', 'return (' + until + ');');
      const t0 = performance.now(), u0 = sw.world.ut; let hit = false, n = 0;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - u0 < budget && n++ < 20000) {
        app.current.update(dt); app.input.endFrame();
        const w = sw.world, v = w.active && !w.active.dead ? w.active : null;
        if (test(w, v)) { hit = true; break; }
      }
      return { adv: sw.world.ut - u0, hit, n };
    }, { budget: left, until, dt });
    hit = r.hit; left -= Math.max(r.adv, r.n ? dt * 0.5 : left);
  }
  return hit;
}
/** A real key press that the flight screen is sure to see (one update while it is down). */
const key = async code => { await page.keyboard.down(code); await page.waitForTimeout(40); await E(() => { const a = window.__sw.app; if (a.currentName === 'flight' && a.current) { a.current.update(0.02); a.input.endFrame(); } }); await page.keyboard.up(code); await page.waitForTimeout(40); };
const panelText = () => E(() => { const p = document.querySelector('.fl-pop[data-panel="missions"]'); return p ? p.innerText : null; });
async function toTitle() {
  if (await E(() => window.__sw.app.currentName) === 'title') return;
  await E(() => window.__sw.app.exitToTitle());
  await waitScreen('title');
}
async function launchFromPad(name) {
  await page.click('[data-goto="launch"]');
  await page.waitForSelector(`.sw-launch-modal [data-craft="${name}"]`);
  await page.click(`.sw-launch-modal [data-craft="${name}"]`);
  await page.click('.sw-launch-modal [data-action="launch"]');
  await waitScreen('flight');
  await E(() => { const b = document.querySelector('[data-action="hint-close"], .fl-hint button'); if (b) b.click(); });
}

await page.goto(server.url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
await waitScreen('title');
await tapToasts();

// =============================================================================================
// The title menu has a Missions entry; with no save it explains missions and starts a career in Mission Control
console.log('\n— title menu');
ok(await page.locator('.sw-menu [data-action="missions"]').count() === 1, 'the title menu has a Missions entry');
ok(/Missions/.test(await page.locator('.sw-menu [data-action="missions"]').innerText()), 'it is labelled Missions');
await page.click('.sw-menu [data-action="missions"]');
await page.waitForSelector('.sw-missions-intro');
const intro = await page.locator('.sw-missions-intro').innerText();
ok(/flight program/i.test(intro) && /Contracts/.test(intro) && /Career mode only/.test(intro), 'with no saved game it opens a panel that explains the flight program and contracts');
ok(await page.locator('.sw-missions-intro [data-action="start-career"]').count() === 1 && await page.locator('.sw-missions-intro [data-action="open-missions"]').count() === 0, 'the panel offers "Start a career" (and nothing to open: there is no save)');
await shot('01-title-intro');
await page.click('.sw-missions-intro [data-action="start-career"]');
await waitScreen('missions');
let c = await career();
ok(c && c.mode === 'career', 'Start a career makes a career program');
ok(await page.locator('[data-screen="missions"], .sw-interior').count() >= 1 && await page.locator('.sw-program[data-role="program"]').count() === 1, 'it lands in Mission Control, with the flight program on top');
ok(await page.locator('.sw-program.spot').count() === 1, 'the flight program is lit up for the newcomer');

// =============================================================================================
if (want('program')) {
  console.log('\n— the flight program in Mission Control');
  const total = await E(async () => (await import('/js/core/career.js')).PROGRAM.length);
  ok(await page.locator('.sw-program-next').getAttribute('data-program-next') === 'first_launch', 'the next mission is the first launch');
  ok((await page.locator('[data-role="program-count"]').innerText()).replace(/\s/g, '') === `0/${total}`, `the program counts its missions (0 / ${total})`);
  ok(/First flights/i.test(await page.locator('[data-role="program-chapter"]').innerText()), 'the chapter is named');
  const nextText = await page.locator('.sw-program-next').innerText();
  ok(/Light the Fuse/.test(nextText) && /Lift a vessel off the pad/.test(nextText), 'the next mission has a title and says what to do');
  ok(await page.locator('.sw-program-next .sw-rewards .sw-chip').count() === 3, 'a career sees funds, science and reputation for it');
  ok(await page.locator('.sw-program-steps .sw-program-step').count() === 6 && await page.locator('.sw-program-steps .sw-program-step.next').count() === 1, 'the missions of the chapter are listed, the next one marked');
  await shot('02-mission-control-program');
  await page.click('[data-action="program-all"]');
  ok(await page.locator('[data-role="program-list"] .sw-program-row').count() === total, 'Whole program lists every mission');
  const far = await page.locator('[data-role="program-list"]').innerText();
  ok(/Pell/.test(far) && /Ost/.test(far) && /Rusk/.test(far) && /Nym/.test(far), 'from the moons to the far worlds');
  await shot('03-mission-control-whole-program');
  await page.click('[data-action="program-all"]');
  ok(await page.locator('[data-role="program-list"]').count() === 0, 'and folds away again');
  const box = await page.locator('.sw-contracts').boundingBox();
  ok(box && box.height > 250 && box.y + box.height <= 900 + 1, 'the contract board keeps its room below the program (' + (box ? Math.round(box.height) : 0) + ' px)');
}

// =============================================================================================
let reach = null;
if (want('contract')) {
  console.log('\n— accept a contract in Mission Control');
  // the simplest job on the board: carry a Pip above an altitude. Decline others until one is posted.
  for (let i = 0; i < 12 && await page.locator('.sw-contract.offer[data-type="reach"]').count() === 0; i++) {
    await page.locator('.sw-contract.offer [data-action="decline"]').first().click();
    await page.waitForTimeout(150);
  }
  ok(await page.locator('.sw-contract.offer[data-type="reach"]').count() >= 1, 'the board has an altitude contract for a new program');
  const before = await career();
  const id = await page.locator('.sw-contract.offer[data-type="reach"]').first().getAttribute('data-contract');
  const offer = before.offered.find(k => k.id === id);
  await page.locator(`.sw-contract.offer[data-contract="${id}"] [data-action="accept"]`).click();
  await page.waitForSelector(`.sw-contract.active[data-contract="${id}"]`);
  c = await career();
  reach = c.active.find(k => k.id === id);
  ok(!!reach && c.funds === before.funds + offer.advance, `accepting pays the advance (✦ ${offer.advance})`);
  ok((await toasts()).some(t => /^Signed: /.test(t)), 'and says so');
  ok(await page.locator(`.sw-contract.active[data-contract="${id}"] .sw-objectives li[data-done="0"]`).count() === 1, 'the contract book shows it with its open objective');
  // a second, hand-made contract with two steps, so that an "objective complete" notice has to appear on the way
  await E(() => {
    const b = window.__sw.career.contracts, now = window.__sw.career.ut;
    b.active.push({ id: 'cT', type: 'reach', key: 'test:two-steps', title: 'Two Rungs', text: 'A test contract with two objectives.', agency: 'the Test Office', bodyId: 'verda', difficulty: 1,
      objectives: [{ kind: 'reach', bodyId: 'verda', altMin: 3000, crew: 1, label: 'Carry a Pip above 3 km over Verda', done: false }, { kind: 'reach', bodyId: 'verda', altMin: 9000, crew: 1, label: 'Carry a Pip above 9 km over Verda', done: false }],
      advance: 0, reward: { funds: 700, science: 1.5, rep: 2 }, penalty: { funds: 0, rep: 1 }, days: 20, offeredAt: now, expiresAt: null, acceptedAt: now, deadlineAt: now + 20 * 19800, state: 'active' });
  });
  await shot('04-contract-accepted');

  console.log('\n— fly it, with the mission tracker open');
  await page.keyboard.press('Escape');
  await waitScreen('hub');
  await launchFromPad('Hopper I');
  const atPad = await career();
  ok(await page.locator('.fl-tools [data-tool="missions"]').count() === 1, 'the flight toolbar has a Missions button');
  await page.click('.fl-tools [data-tool="missions"]');
  await page.waitForSelector('.fl-pop[data-panel="missions"]');
  let text = await panelText();
  ok(/Flight program/i.test(text) && /Light the Fuse/.test(text), 'the tracker names the next program mission');
  ok(text.includes(reach.title) && /Two Rungs/.test(text), 'and lists the active contracts');
  ok(await page.locator('.fl-pop[data-panel="missions"] .fl-ms[data-contract="cT"] .fl-ms-obj').count() === 2 && await page.locator('.fl-pop[data-panel="missions"] .fl-ms-obj.done').count() === 0, 'each objective is a line, none ticked yet');
  ok(/\d+ days left/i.test(text), 'with the time left on the deadline');
  ok(await page.locator('.fl-pop[data-panel="missions"] .fl-ms[data-contract="cT"] .fl-ms-live').first().innerText() === '0 km of 3 km', 'the read-out starts at the pad (0 km of 3 km)');
  await shot('05-flight-tracker-pad');
  await key('KeyO');
  ok(await page.locator('.fl-pop[data-panel="missions"]').count() === 0, 'O closes the tracker');
  await key('KeyO');
  ok(await page.locator('.fl-pop[data-panel="missions"]').count() === 1, 'and O opens it again');
  {   // the tracker sits inside the window and clear of the console and the crew portraits
    const g = await E(() => { const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; }; return { p: r('.fl-pop[data-panel="missions"]'), con: r('[data-hud="console"]'), crew: r('[data-hud="crew"]'), w: innerWidth, h: innerHeight }; });
    const hit = (a, b) => a && b && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 2 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 2;
    ok(g.p && g.p.l >= 0 && g.p.r <= g.w && g.p.b <= g.h && !hit(g.p, g.con) && !hit(g.p, g.crew), 'the tracker stays inside the window, clear of the console and the crew');
  }

  await clearToasts();
  await key('KeyZ'); await key('Space');
  ok(await ff(20, 'v && v.altitude > 600'), 'the Hopper lifts off');
  await page.waitForTimeout(250);
  const mid = await page.locator('.fl-pop[data-panel="missions"] .fl-ms[data-contract="cT"] .fl-ms-live').first().innerText();
  ok(/^(0\.[6-9]|[12](\.\d)?) km of 3 km$/.test(mid), 'the read-out follows the climb (' + mid + ')');
  let t = await toasts();
  ok(t.some(x => /^Milestone: Light the Fuse/.test(x)), 'lifting off flies the first program mission');
  ok(t.some(x => /^Next mission: Above the Weather/.test(x)), 'and the next mission is announced');
  ok(/Above the Weather/.test(await panelText()), 'the tracker moves on to it');
  ok(await ff(60, 'v && v.altitude > 3400'), 'climbs past 3 km');
  await page.waitForTimeout(250);
  t = await toasts();
  ok(t.some(x => /^Objective complete — Two Rungs/.test(x)), 'an objective notice appears in flight');
  ok(await page.locator('.fl-pop[data-panel="missions"] .fl-ms[data-contract="cT"] .fl-ms-obj.done').count() === 1, 'and the tracker ticks that objective');
  await shot('06-flight-tracker-objective');
  const altMin = await E(id => window.__sw.career.contracts.active.find(k => k.id === id).objectives[0].altMin, reach.id);
  ok(await ff(240, `v && v.altitude > ${altMin + 800}`), `climbs past the contract altitude (${altMin / 1000} km)`);
  await page.waitForTimeout(250);
  t = await toasts();
  ok(t.some(x => x.startsWith('Contract complete — ' + reach.title) && /✦/.test(x) && /science/.test(x) && /reputation/.test(x)), 'the completion notice appears in flight, with what was paid');
  ok(t.some(x => /^Contract complete — Two Rungs/.test(x)), 'the two-step contract completes as well');
  c = await career();
  ok(c.completed.includes(reach.id) && c.completed.includes('cT') && c.active.length === 0, 'both contracts are filed as completed');
  const msFunds = await E(async ids => { const m = await import('/js/core/career.js'); return ids.map(i => m.milestoneDef(i)).reduce((s, d) => ({ funds: s.funds + d.funds, science: s.science + d.science, rep: s.rep + d.rep }), { funds: 0, science: 0, rep: 0 }); }, c.ms.filter(i => !atPad.ms.includes(i)));
  ok(c.funds === atPad.funds + reach.reward.funds + 700 + msFunds.funds, `funds are paid: contracts ✦ ${reach.reward.funds} + ✦ 700, missions ✦ ${msFunds.funds}`);
  ok(Math.abs(c.science - (atPad.science + reach.reward.science + 1.5 + msFunds.science)) < 1e-6, `science is paid (${c.science})`);
  ok(c.rep === atPad.rep + reach.reward.rep + 2 + msFunds.rep, `reputation is paid (${c.rep})`);
  text = await panelText();
  ok(/No active contracts/.test(text) && !text.includes(reach.title), 'the tracker no longer lists the finished contracts');
  ok(c.ms.includes('alt_10km') ? !/Above the Weather/.test(text) : true, 'and shows the mission after the ones just flown');
  await shot('07-flight-tracker-complete');
  // back to the Flight Center; the History tab has the job
  await E(() => window.__sw.app.goto('hub'));
  await waitScreen('hub');
  await page.click('[data-goto="missions"]');
  await waitScreen('missions');
  await page.click('[data-sub="history"]');
  ok(await page.locator(`.sw-history-row[data-contract="${reach.id}"][data-outcome="completed"]`).count() === 1, 'Mission Control files it under History as completed');
  ok(await page.locator('.sw-program-step.done').count() >= 2, 'and the flight program shows the flown missions ticked');
  await page.click('[data-sub="active"]');
}

// =============================================================================================
if (want('deadline')) {
  console.log('\n— a missed deadline');
  if (await E(() => window.__sw.app.currentName) !== 'missions') { await E(() => window.__sw.app.goto('missions')); await waitScreen('missions'); }
  const before = await career();
  const id = await page.locator('.sw-contract.offer').first().getAttribute('data-contract');
  await page.locator(`.sw-contract.offer[data-contract="${id}"] [data-action="accept"]`).click();
  await page.waitForSelector(`.sw-contract.active[data-contract="${id}"]`);
  const k = (await career()).active.find(x => x.id === id);
  ok(k && k.days > 0, `accepted "${k && k.title}" with ${k && k.days} days to finish`);
  ok(/days left|left/.test(await page.locator(`.sw-contract.active[data-contract="${id}"] [data-role="deadline"]`).innerText()), 'the contract book shows the time left');
  await page.keyboard.press('Escape'); await waitScreen('hub');
  // the days go by (as they do under time warp in the Tracking Station or on a long flight)
  await clearToasts();
  await E(days => { window.__sw.career.ut += (days + 1) * 19800; }, k.days);
  await page.click('[data-goto="missions"]'); await waitScreen('missions');
  const after = await career();
  ok(after.failed.some(f => f.id === id && f.reason === 'deadline') && !after.active.some(x => x.id === id), 'when the deadline passes the contract fails');
  ok(after.funds === before.funds + k.advance - Math.min(k.penalty.funds, before.funds + k.advance) && after.rep === before.rep - k.penalty.rep, `the advance is taken back and reputation drops by ${k.penalty.rep}`);
  ok((await toasts()).some(x => x.startsWith('Contract failed (deadline passed) — ' + k.title)), 'and the player is told (it used to be filed without a word)');
  await page.click('[data-sub="history"]');
  ok(/Missed deadline/i.test(await page.locator(`.sw-history-row[data-contract="${id}"]`).innerText()), 'History says "Missed deadline"');
  await shot('08-deadline-missed');
  await page.click('[data-sub="active"]');
}

// =============================================================================================
if (want('cancel')) {
  console.log('\n— a cancelled contract');
  if (await E(() => window.__sw.app.currentName) !== 'missions') { await E(() => window.__sw.app.goto('missions')); await waitScreen('missions'); }
  const before = await career();
  const id = await page.locator('.sw-contract.offer').first().getAttribute('data-contract');
  await page.locator(`.sw-contract.offer[data-contract="${id}"] [data-action="accept"]`).click();
  await page.waitForSelector(`.sw-contract.active[data-contract="${id}"]`);
  const k = (await career()).active.find(x => x.id === id);
  await page.locator(`.sw-contract.active[data-contract="${id}"] [data-action="cancel"]`).click();
  await page.waitForSelector('.sw-modal .sw-btn.danger');
  ok(/repay the advance/.test(await page.locator('.sw-modal').last().innerText()), 'cancelling asks first and names the cost');
  await E(() => [...document.querySelectorAll('.sw-modal .sw-btn')].find(b => /Keep it/.test(b.textContent)).click());
  await page.waitForTimeout(400);
  ok((await career()).active.some(x => x.id === id), '"Keep it" keeps the contract');
  await page.locator(`.sw-contract.active[data-contract="${id}"] [data-action="cancel"]`).click();
  await page.waitForSelector('.sw-modal .sw-btn.danger');
  await page.click('.sw-modal .sw-btn.danger');
  await page.waitForFunction(i => !window.__sw.career.contracts.active.some(x => x.id === i), id);
  const after = await career();
  ok(after.failed.some(f => f.id === id && f.reason === 'cancelled'), 'confirming files it as cancelled');
  ok(after.funds === before.funds && after.rep === before.rep - k.penalty.rep, `the advance goes back (funds as before) and reputation drops by ${k.penalty.rep}`);
  await page.click('[data-sub="history"]');
  ok(/Cancelled/i.test(await page.locator(`.sw-history-row[data-contract="${id}"]`).innerText()), 'History says "Cancelled"');
  await page.click('[data-sub="active"]');
}

// =============================================================================================
if (want('title')) {
  console.log('\n— title menu with a career save');
  await toTitle();
  ok(/next: /i.test(await page.locator('.sw-menu [data-action="missions"]').innerText()), 'the Missions entry names the next mission of the saved program');
  await page.click('.sw-menu [data-action="missions"]');
  await waitScreen('missions');
  ok((await career()).mode === 'career' && await page.locator('.sw-missions-intro').count() === 0, 'with a career save, Missions loads it and goes straight to Mission Control');
  ok(await page.locator('.sw-contracts').count() === 1, 'on the contract board');
  await page.keyboard.press('Escape'); await waitScreen('hub');
}

// =============================================================================================
if (want('sandbox')) {
  console.log('\n— missions outside career mode');
  await toTitle();
  await E(() => window.__sw.app.newGame('sandbox'));
  await waitScreen('hub');
  await page.click('[data-goto="missions"]'); await waitScreen('missions');
  ok(await page.locator('.sw-program[data-role="program"] .sw-program-next').getAttribute('data-program-next') === 'first_launch', 'a sandbox program has the flight program too');
  ok(/Sandbox: missions are tracked/.test(await page.locator('[data-role="program-mode"]').innerText()) && await page.locator('.sw-program-next .sw-rewards .sw-chip').count() === 0, 'it says that nothing is paid here, and shows no rewards');
  await page.click('.sw-tab[data-tab="contracts"]');
  ok(/Contracts are part of Career mode/.test(await page.locator('.sw-missions').first().innerText()) && /start a Career game/.test(await page.locator('[data-role="career-only"]').innerText()), 'the Contracts tab says plainly that contracts are career-only');
  await page.click('.sw-tab[data-tab="milestones"]');
  ok(await page.locator('.sw-mission[data-milestone]').count() > 40, 'milestones are listed');
  const fit = await E(() => { const p = document.querySelector('.sw-program').getBoundingClientRect(), t = document.querySelector('.sw-mc-strip').getBoundingClientRect(); return p.bottom <= t.top + 1 && p.right <= innerWidth && [...document.querySelectorAll('.sw-program *')].every(e => e.scrollWidth <= e.clientWidth + 2 || getComputedStyle(e).overflow === 'visible'); });
  ok(fit, 'the program strip is laid out above the tabs without clipped text');
  await shot('09-sandbox-mission-control');
  await page.keyboard.press('Escape'); await waitScreen('hub');
  await launchFromPad('Hopper I');
  await key('KeyO');
  await page.waitForSelector('.fl-pop[data-panel="missions"]');
  const text = await panelText();
  ok(/Light the Fuse/.test(text) && /Paid contracts belong to Career mode/.test(text), 'in flight the tracker shows the program and says contracts are for careers');
  ok(await page.locator('.fl-pop[data-panel="missions"] .fl-ms-pay').count() === 0, 'with no rewards listed in a sandbox');
  await key('KeyZ'); await key('Space');
  await ff(15, 'v && v.altitude > 300');
  await page.waitForTimeout(250);
  ok((await career()).ms.includes('first_launch') && /Above the Weather/.test(await panelText()), 'the program is tracked in a sandbox flight as well');
  await shot('10-sandbox-flight-tracker');
  await E(() => window.__sw.app.goto('hub')); await waitScreen('hub');
  // title menu with a sandbox save: the panel, with a way into this program's Mission Control
  await toTitle();
  await page.click('.sw-menu [data-action="missions"]');
  await page.waitForSelector('.sw-missions-intro');
  ok(/Sandbox program/.test(await page.locator('[data-role="missions-saved"]').innerText()), 'with a sandbox save the panel explains that it has no contracts');
  ok(await page.locator('.sw-missions-intro [data-action="start-career"]').count() === 1 && await page.locator('.sw-missions-intro [data-action="open-missions"]').count() === 1, 'and offers both "Start a career" and this program\'s Mission Control');
  await shot('11-title-intro-sandbox');
  await page.click('.sw-missions-intro [data-action="open-missions"]');
  await waitScreen('missions');
  ok((await career()).mode === 'sandbox' && await page.locator('.sw-program-step.done').count() >= 1, 'opening it shows the sandbox program with its flown mission ticked');
  // and "Start a career" from there asks before replacing the save
  await toTitle();
  await page.click('.sw-menu [data-action="missions"]');
  await page.waitForSelector('.sw-missions-intro');
  await page.click('.sw-missions-intro [data-action="start-career"]');
  await page.waitForSelector('.sw-modal .sw-btn.danger');
  ok(/overwritten/.test(await page.locator('.sw-modal').last().innerText()), 'starting a career over a saved game asks first');
  await page.click('.sw-modal .sw-btn.danger');
  await waitScreen('missions');
  ok((await career()).mode === 'career' && (await career()).ms.length === 0, 'and then starts a fresh career in Mission Control');
}

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
