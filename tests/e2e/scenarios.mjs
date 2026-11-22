// End-to-end test of Scenarios: the title menu entry, the picker (mouse and keyboard), starting every scenario,
// the brief on arrival, the objectives panel, the right scene with the vessel where the card says it is (landed
// craft on the ground AS DRAWN), no console errors, the scenario save slot (the player's own save untouched),
// the separate quicksave, resuming, and an objective ticking in play.
//   node tests/e2e/scenarios.mjs                      every scenario at 1440x900, device pixel ratio 1
//   DPR=2 node tests/e2e/scenarios.mjs                the same on a ratio-2 display (900x600 CSS pixels)
//   ONLY=pell-homecoming,ost-outpost node tests/e2e/scenarios.mjs      just these scenarios (the menu checks still run)
// Screenshots: tests/out/scenarios-<name>-dpr<n>.png
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const DPR = Math.max(1, +(process.env.DPR || 1));
const W = +(process.env.W || (DPR > 1 ? 900 : 1440)), H = +(process.env.H || (DPR > 1 ? 600 : 900));
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);

const problems = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
page.setDefaultTimeout(240000);
let errors = [];
page.on('console', m => { if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) errors.push('console error: ' + m.text()); });
page.on('pageerror', e => errors.push('page error: ' + (e.stack || e.message)));
const noErrors = what => { const list = errors; errors = []; return ok(list.length === 0, what + ': no console or page errors' + (list.length ? ' → ' + list.slice(0, 3).join(' | ') : '')); };

const E = (fn, arg) => page.evaluate(fn, arg);
const shot = name => page.screenshot({ path: path.join(OUT, `scenarios-${name}-dpr${DPR}.png`), timeout: 240000 }).catch(e => console.log('  (screenshot ' + name + ' skipped: ' + e.message.split('\n')[0] + ')'));
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 900000 });
  await page.waitForTimeout(250);
}
const MAIN_KEY = 'starwright.save.v1', SLOT_KEY = 'starwright.scenario.v1';
const store = key => E(k => localStorage.getItem(k), key);
async function toTitle() {
  await E(async () => { const app = window.__sw.app; if (app.currentName !== 'title') await app.exitToTitle(); });
  await waitScreen('title');
  await page.waitForSelector('.sw-menu [data-action="scenarios"]');
}
async function openPicker() {
  await page.click('.sw-menu [data-action="scenarios"]');
  await page.waitForSelector('.sw-scn-modal .sw-scn-grid');
  await page.waitForTimeout(200);
}

console.log(`\n=== Scenarios, ${W}x${H} at device pixel ratio ${DPR} ===`);
await page.goto(server.url, { timeout: 240000 });
await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app, null, { timeout: 240000 });

// ---------------------------------------------------------------------------- the player's own program comes first
await E(async () => {
  localStorage.clear();
  const { Career } = await import('/js/core/career.js');
  const c = Career.newGame('career', { seed: 99 });
  c.funds = 12345; c.ut = 40000;
  c.save();
  // a saved game makes this a returning player: mark What's New as seen, so its pop-up (tests/e2e/whatsnew.mjs) stays off the menu
  localStorage.setItem('starwright.whatsnew.v1', (await import('/js/ui/whatsnew.js')).RELEASES[0].id);
});
const mainSave = await store(MAIN_KEY);
ok(!!mainSave && JSON.parse(mainSave).funds === 12345, 'a program of the player\'s own is saved (12,345 funds)');
await page.reload({ timeout: 240000 });
await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app && window.__sw.app.currentName === 'title', null, { timeout: 240000 });
const catalog = await E(async () => (await import('/js/core/scenarios.js')).SCENARIOS.map(s => ({ ...s })));
// every notice the game shows, for the checks on what a scenario may and may not announce
await E(() => { const app = window.__sw.app; app.__notices = []; const t = app.toast; app.toast = (text, ...rest) => { app.__notices.push(String(text)); return t(text, ...rest); }; });
const notices = () => E(() => window.__sw.app.__notices.splice(0));
/** The three panels along the top of the flight screen, and whether any two overlap. */
const topPanels = () => E(() => {
  const r = q => { const n = document.querySelector(q); if (!n) return null; const b = n.getBoundingClientRect(); return b.width > 0 ? { l: b.left, r: b.right, t: b.top, b: b.bottom } : null; };
  const tl = r('.fl-tl'), alt = r('.fl-alt'), res = r('.fl-res'), tools = r('.fl-tools'), scn = r('.sw-scn-panel'), tgt = r('.fl-target');
  const hit = (a, b) => !!(a && b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5);
  return { ok: !!(tl && alt && res), tlAlt: hit(tl, alt), altRes: hit(alt, res), resTools: hit(res, tools), scnTl: hit(scn, tl), scnAlt: hit(scn, alt), scnTgt: hit(scn, tgt), vw: innerWidth,
    gaps: tl && alt && res ? [Math.round(alt.l - tl.r), Math.round(res.l - alt.r)] : null };
});
ok(catalog.length >= 10, catalog.length + ' scenarios in the catalog');

// ---------------------------------------------------------------------------- title menu and picker
{
  console.log('\n--- title menu and picker');
  await page.waitForSelector('.sw-menu [data-action="scenarios"]');
  const menu = await E(() => [...document.querySelectorAll('.sw-menu .sw-btn')].map(b => ({ action: b.dataset.action, text: (b.querySelector('.lbl') || b).textContent.trim(), small: b.querySelector('small') ? b.querySelector('small').textContent : '' })));
  const actions = menu.map(m => m.action);
  ok(actions.includes('scenarios') && menu.find(m => m.action === 'scenarios').text === 'Scenarios', 'the title menu has a Scenarios entry: ' + actions.join(', '));
  ok(actions.indexOf('scenarios') > actions.indexOf('new') && actions.indexOf('scenarios') < actions.indexOf('settings'), 'it sits with New Game, Flight School and the demo tour');
  ok(/ready-made/.test(menu.find(m => m.action === 'scenarios').small), 'its note says what it is: "' + menu.find(m => m.action === 'scenarios').small + '"');
  ok(actions[0] === 'continue', 'Continue is still the first entry');
  await page.waitForTimeout(1500);
  await shot('title');

  // keyboard: Enter on the focused menu entry opens it, the arrows walk the cards, Escape closes
  await E(() => document.querySelector('.sw-menu [data-action="scenarios"]').focus());
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sw-scn-modal .sw-scn-grid');
  await page.waitForTimeout(200);
  const focus = () => E(() => { const c = document.activeElement && document.activeElement.closest('.sw-scn-card'); return c ? c.dataset.scenario + '/' + document.activeElement.dataset.action : (document.activeElement ? document.activeElement.tagName : null); });
  ok(await focus() === catalog[0].id + '/start', 'the first card\'s Start button has the focus: ' + await focus());
  await page.keyboard.press('ArrowRight');
  ok(await focus() === catalog[1].id + '/start', 'ArrowRight moves to the second card: ' + await focus());
  const cols = await E(() => getComputedStyle(document.querySelector('.sw-scn-grid')).gridTemplateColumns.split(' ').filter(Boolean).length);
  await page.keyboard.press('ArrowDown');
  ok(await focus() === catalog[Math.min(catalog.length - 1, 1 + cols)].id + '/start', `ArrowDown moves one row (${cols} columns): ` + await focus());
  await page.keyboard.press('End');
  ok(await focus() === catalog[catalog.length - 1].id + '/start', 'End goes to the last card');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  ok((await focus()) === catalog[1].id + '/start', 'Tab walks the buttons too: ' + await focus());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sw-scn-modal'));
  ok(await E(() => window.__sw.app.currentName === 'title' && !window.__sw.app.career), 'Escape closes the picker; still on the title screen with no game loaded');

  // mouse
  await openPicker();
  const cards = await E(() => [...document.querySelectorAll('.sw-scn-card')].map(c => {
    const r = c.getBoundingClientRect(), b = c.querySelector('[data-action="start"]'), br = b ? b.getBoundingClientRect() : null;
    return { id: c.dataset.scenario, name: c.querySelector('.sw-scn-top b').textContent, diff: c.querySelector('.sw-scn-diff').textContent, world: c.querySelector('.world').textContent,
      where: c.querySelector('.where').textContent, goal: c.querySelector('.sw-scn-goal').textContent, start: b ? b.textContent : '', w: r.width, h: r.height,
      clipped: c.scrollWidth > c.clientWidth + 1 || [...c.querySelectorAll('b, p, span')].some(n => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow !== 'visible'), bw: br ? br.width : 0, bh: br ? br.height : 0 };
  }));
  ok(cards.length === catalog.length, cards.length + ' cards, one per scenario');
  ok(cards.every((c, i) => c.id === catalog[i].id && c.name === catalog[i].name && c.world === catalog[i].worldName && c.where === catalog[i].situation && c.diff === catalog[i].difficulty && c.goal === catalog[i].goal && c.start === 'Start'),
    'every card shows its name, world, situation, difficulty, goal and a Start button');
  ok(cards.every(c => c.w >= 240 && c.bw >= 50 && c.bh >= 26 && !c.clipped), 'cards and buttons are a usable size and no text is clipped');
  const modal = await E(() => { const m = document.querySelector('.sw-scn-modal').getBoundingClientRect(); const body = document.querySelector('.sw-scn-modal .sw-modal-body'); return { l: m.left, t: m.top, r: m.right, b: m.bottom, vw: innerWidth, vh: innerHeight, scroll: body.scrollHeight > body.clientHeight + 1, oy: getComputedStyle(body).overflowY }; });
  ok(modal.l >= 0 && modal.t >= 0 && modal.r <= modal.vw && modal.b <= modal.vh, `the picker fits the window (${Math.round(modal.r - modal.l)}x${Math.round(modal.b - modal.t)} in ${modal.vw}x${modal.vh})`);
  ok(!modal.scroll || /auto|scroll/.test(modal.oy), 'when the cards do not all fit, the list scrolls');
  await shot('picker');
  // the last card can be reached and clicked with the mouse (scrolled into view if needed)
  const last = page.locator(`.sw-scn-card[data-scenario="${catalog[catalog.length - 1].id}"] [data-action="start"]`);
  await last.scrollIntoViewIfNeeded();
  ok(await last.isVisible(), 'the last card\'s Start button can be brought into view');
  await page.click('.sw-scn-modal .sw-modal-buttons .sw-btn');
  await page.waitForFunction(() => !document.querySelector('.sw-scn-modal'));
  noErrors('menu and picker');
}

// ---------------------------------------------------------------------------- every scenario
let order = catalog.map(s => s.id);
if (ONLY.length) order = order.filter(id => ONLY.includes(id));
// Ost Outpost goes last: the resume and objective checks at the end use it
if (order.includes('ost-outpost')) order = order.filter(id => id !== 'ost-outpost').concat('ost-outpost');
let started = 0;

for (const id of order) {
  const s = catalog.find(x => x.id === id);
  console.log(`\n--- ${s.name} (${id}: ${s.worldName}, ${s.situation}, ${s.difficulty})`);
  await toTitle();
  await openPicker();
  const slotBefore = await E(() => window.__sw.app.scenarios.slot());
  const btn = page.locator(`.sw-scn-card[data-scenario="${id}"] [data-action="${slotBefore && slotBefore.id === id ? 'restart' : 'start'}"]`);
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  if (slotBefore) {
    // another scenario is in the slot: the game asks before replacing it
    await page.waitForSelector('.sw-modal .sw-btn.danger');
    const text = await E(() => [...document.querySelectorAll('.sw-modal')].pop().textContent);
    ok(text.includes(slotBefore.name) && /not affected/.test(text), `asks before replacing "${slotBefore.name}" and says the player's own save is not affected`);
    if (started === 1) {
      // saying no keeps everything as it was
      await page.click('.sw-modal-backdrop:last-child .sw-modal-buttons .sw-btn:not(.danger)');
      await page.waitForTimeout(300);
      ok(await E(() => window.__sw.app.currentName === 'title' && !!document.querySelector('.sw-scn-modal')) && (await E(() => window.__sw.app.scenarios.slot().id)) === slotBefore.id, 'Cancel returns to the picker with the old scenario still in its slot');
      await btn.click();
      await page.waitForSelector('.sw-modal .sw-btn.danger');
    }
    await page.click('.sw-modal .sw-btn.danger');
  }
  const screen = s.start === 'builder' ? 'builder' : 'flight';
  await waitScreen(screen);
  started++;
  ok(true, `the ${screen === 'builder' ? 'assembly building' : 'flight'} screen opened`);

  // the brief on arrival
  await page.waitForSelector('.sw-scn-brief', { timeout: 60000 });
  const brief = await E(() => { const n = document.querySelector('.sw-scn-brief'), r = n.getBoundingClientRect();
    return { text: n.textContent, goal: n.querySelector('[data-role="goal"]').textContent, items: [...n.querySelectorAll('.sw-scn-list li')].map(li => li.textContent), tips: n.querySelectorAll('.sw-scn-tips li').length,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, focus: document.activeElement && document.activeElement.dataset.action }; });
  ok(brief.text.includes(s.name) && brief.goal === s.goal, 'the brief names the scenario and its goal');
  ok(brief.items.length === s.objectives.length && brief.items.every((t, i) => t === s.objectives[i].text) && brief.tips >= 2, `the brief lists ${brief.items.length} objectives and ${brief.tips} tips`);
  ok(brief.inView, 'the brief fits the window');
  if (s.start === 'builder') {
    const hint = await E(() => { const h = document.querySelector('.bld-hint'); return h ? getComputedStyle(h).visibility : 'none'; });
    ok(hint !== 'visible', 'the assembly building\'s own welcome help does not show under the brief (' + hint + ')');
  }
  await page.waitForTimeout(600);
  await shot(id + '-brief');
  if (started % 2) await page.keyboard.press('Enter'); else await page.click('.sw-scn-brief [data-action="begin"]');
  await page.waitForFunction(() => !document.querySelector('.sw-scn-brief') && document.querySelector('.sw-scn-panel'), null, { timeout: 30000 });
  const panel = await E(() => { const n = document.querySelector('.sw-scn-panel'), r = n.getBoundingClientRect();
    return { id: n.dataset.scenario, goal: n.querySelector('[data-role="goal"]').textContent, items: n.querySelectorAll('.sw-scn-list li').length, done: n.dataset.done,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, w: r.width, h: r.height }; });
  ok(panel.id === id && panel.goal === s.goal && panel.items === s.objectives.length && panel.done === '0' && panel.inView,
    `${started % 2 ? 'Enter' : 'Begin'} closes the brief; the objectives panel stays (${Math.round(panel.w)}x${Math.round(panel.h)}, goal and ${panel.items} objectives, none done)`);

  // the game it started
  const game = await E(async () => {
    const { PARTS } = await import('/js/core/parts.js');
    const c = window.__sw.career;
    return { mode: c.mode, scenario: c.scenario && c.scenario.id, usesFunds: c.usesFunds, locked: Object.values(PARTS).filter(p => !p.hidden && !c.isPartUnlocked(p.id)).length,
      slot: JSON.parse(localStorage.getItem('starwright.scenario.v1') || 'null'), crafts: Object.keys(c.crafts || {}) };
  });
  ok(game.scenario === id && game.mode === 'sandbox' && !game.usesFunds && game.locked === 0, 'the game is this scenario: sandbox rules, every part unlocked, no funds');
  ok(game.slot && game.slot.scenario && game.slot.scenario.id === id, 'it is saved in the scenario slot');
  ok(await store(MAIN_KEY) === mainSave, 'the player\'s own save is byte for byte what it was');

  if (screen === 'builder') {
    const b = await E(async () => {
      const S = await import('/js/core/scenarios.js');
      const app = window.__sw.app, craft = app.builder.craft, want = S.buildScenario(app.career.scenario.id).craft;
      const v = craft.validate();
      return { name: craft.name, parts: craft.parts.length, want: want.parts.length, wantName: want.name, stages: craft.stages.length, wantStages: want.stages.length, errors: v.errors, dv: Math.round(craft.deltaV().vac),
        launch: !!document.querySelector('[data-action="launch"], [data-builder="launch"], .bld-launch'), meshes: app.builder.craft.parts.length };
    });
    ok(b.name === b.wantName && b.parts === b.want && b.stages === b.wantStages && b.errors.length === 0,
      `${b.name} stands in the hall: ${b.parts} parts, ${b.stages} stages, ${b.dv} m/s, no errors`);
    ok(game.crafts.includes(b.name), 'the design is also among the saved designs');
    const hintAfter = await E(() => { const h = document.querySelector('.bld-hint'); return h ? getComputedStyle(h).visibility : 'none'; });
    ok(hintAfter === 'visible' || hintAfter === 'none', 'once the brief is closed the welcome help has its turn (' + hintAfter + ')');
    await page.waitForTimeout(2500);
    await shot(id);
    noErrors(id);
    continue;
  }

  // ---- flight scenes: let the terrain come in, draw some frames, then look at where the vessel is
  await E(() => { const f = window.__sw.app.flight; if (f && f.view && f.view.settleTerrain) f.view.settleTerrain(4000); });
  await page.waitForFunction(() => { const f = window.__sw.app.flight, w = f && f.view && f.view.worlds; return !w || !w.info || !w.info.busy; }, null, { timeout: 300000, polling: 500 }).catch(() => {});
  await page.waitForTimeout(1500);
  const f = await E(async () => {
    const THREE = await import('/js/lib/three.module.min.js');
    const S = await import('/js/core/scenarios.js');
    const sw = window.__sw, app = sw.app, w = sw.world, v = w.active, b = v.body, fl = app.flight;
    const want = S.buildScenario(app.career.scenario.id);
    const o = v.landed ? null : v.getOrbit(w.ut);
    const view = fl.view.views.get(v);
    // where the vessel is on screen
    let ndc = null;
    if (view) { const p = new THREE.Vector3(); view.group.getWorldPosition(p); p.project(fl.camera); ndc = { x: p.x, y: p.y, z: p.z }; }
    const out = {
      name: v.name, wantName: want.vessel.name, body: b.id, wantBody: want.vessel.body.id, situation: v.situation, wantSituation: want.vessel.situation,
      vessels: w.vessels.filter(x => !x.dead).map(x => x.name).sort(), wantVessels: want.vessels.map(x => x.name).sort(),
      crew: v.crew.slice(), wantCrew: want.vessel.crew.slice(), parts: v.parts.size, wantParts: want.vessel.parts.size,
      alt: v.altitude, wantAlt: want.vessel.altitude, dead: !!v.dead, hasView: !!view, ndc,
      pe: o ? o.periapsis - b.radius : null, ap: o && !o.hyper ? o.apoapsis - b.radius : null, e: o ? o.e : null,
      wantPe: want.vessel.landed ? null : want.vessel.getOrbit(want.world.ut).periapsis - b.radius,
      landed: v.landed, stageIndex: v.stageIndex, stages: v.stages.length, dv: v.deltaV, wantDv: want.vessel.deltaV,
      paused: fl.paused, mapOpen: fl.mapOpen, hud: !!document.querySelector('.hud, [class*="hud"]'),
      target: w.getTarget(v) ? w.getTarget(v).name : null,
    };
    if (v.landed) {
      const dir = b.inertialToSurfaceDir(v.pos.clone().normalize(), w.ut, new THREE.Vector3());
      const phys = b.terrainHeight(dir);
      out.clear = S.groundClearance(v);
      out.lift = view ? view.lift || 0 : null; out.deck = view ? view.deck || 0 : null;
      const hOut = {};
      const worlds = fl.view.worlds;
      out.drawn = worlds && worlds.heightAt ? worlds.heightAt(b, dir, hOut) : null;
      out.spacing = hOut.spacing; out.phys = phys; out.busy = !!(worlds && worlds.info && worlds.info.busy);
      // lowest point of the vessel as drawn, against the ground as drawn under it
      out.drawnGap = out.drawn == null ? null : (phys + out.clear + (out.lift || 0)) - out.drawn;
      out.others = w.vessels.filter(x => x !== v && !x.dead && x.landed).map(x => ({ name: x.name, clear: S.groundClearance(x) }));
    }
    return out;
  });
  ok(f.name === f.wantName && f.body === f.wantBody && !f.dead, `flying ${f.name} at ${f.body}`);
  ok(JSON.stringify(f.vessels) === JSON.stringify(f.wantVessels), 'the vessels in the world: ' + f.vessels.join(', '));
  ok(JSON.stringify(f.crew) === JSON.stringify(f.wantCrew), 'crew aboard: ' + (f.crew.join(', ') || 'none (probe)'));
  ok(f.parts === f.wantParts, `all ${f.parts} parts present`);
  ok(f.situation === f.wantSituation, `situation "${f.situation}" (the card: ${s.situation})`);
  ok(f.hasView && f.ndc && Math.abs(f.ndc.x) < 0.9 && Math.abs(f.ndc.y) < 0.9 && f.ndc.z < 1, 'the vessel is drawn and in the picture' + (f.ndc ? ` (at ${f.ndc.x.toFixed(2)}, ${f.ndc.y.toFixed(2)})` : ''));
  if (f.landed) {
    ok(Math.abs(f.clear) < 0.5, `landed: its lowest point is ${f.clear.toFixed(3)} m above the terrain`);
    if (f.situation === 'prelaunch') ok(f.lift >= -0.01 && f.lift < 0.2, `on the pad: lifted ${(f.lift * 100).toFixed(1)} cm onto the paving as drawn`);
    else {
      ok(f.drawn != null && Number.isFinite(f.spacing) && !f.busy, `the ground under it is drawn (grid spacing ${Number.isFinite(f.spacing) ? f.spacing.toFixed(1) + ' m' : f.spacing})`);
      ok(f.drawnGap != null && Math.abs(f.drawnGap) < 0.5, `as drawn, the vessel's lowest point is ${f.drawnGap == null ? '?' : (f.drawnGap * 100).toFixed(1)} cm from the drawn ground (physics ground ${f.phys.toFixed(2)} m, drawn ${f.drawn == null ? '?' : f.drawn.toFixed(2)} m, lift ${(f.lift || 0).toFixed(3)} m)`);
    }
    for (const o of f.others) ok(Math.abs(o.clear) < 0.5, `${o.name} also stands on the ground (${o.clear.toFixed(3)} m)`);
  } else if (f.e != null && f.e < 1) {
    ok(Math.abs(f.pe - f.wantPe) < 3000, `orbit ${(f.pe / 1000).toFixed(1)} × ${(f.ap / 1000).toFixed(1)} km`);
  } else if (f.e != null) {
    ok(f.e > 1 && Math.abs(f.pe - f.wantPe) < 5000, `open path, closest approach ${(f.pe / 1000).toFixed(1)} km`);
  }
  ok(Math.abs(f.dv - f.wantDv) < Math.max(5, f.wantDv * 0.02), `delta-v aboard ${f.dv.toFixed(0)} m/s`);
  if (id === 'hollin-approach') ok(f.target === 'Hollin Station', 'Hollin Station is the target');
  {
    const tp = await topPanels();
    ok(tp.ok && !tp.tlAlt && !tp.altRes && !tp.resTools, `the top panels do not cover one another at ${tp.vw} px (gaps ${tp.gaps ? tp.gaps.join(' and ') : '?'} px)`);
    ok(!tp.scnTl && !tp.scnAlt && !tp.scnTgt, 'the objectives panel covers none of them' + (id === 'hollin-approach' ? ', nor the target card' : ''));
    const sit = await E(() => { const n = document.querySelector('.fl-vessel-sit'); return n ? n.textContent : ''; });
    if (id === 'rusk-arrival') ok(/^Arriving at Rusk/.test(sit), 'inbound on an open path the HUD says "' + sit + '", not "Escaping"');
    // the in-flight Missions panel (O) lists this scenario's goal and objectives, not the flight program
    await page.keyboard.press('KeyO');
    await page.waitForSelector('.fl-ms[data-scenario]', { timeout: 15000 }).catch(() => {});
    const mp = await E(() => { const n = document.querySelector('.fl-ms[data-scenario]'); if (!n) return null; const pop = n.closest('.fl-pop') || n.parentElement;
      return { id: n.dataset.scenario, name: n.querySelector('.fl-ms-head b').textContent, goal: n.querySelector('[data-role="scenario-goal"]').textContent, items: [...n.querySelectorAll('.fl-ms-obj')].map(o => o.textContent.replace(/^[✓▸○]\s*/, '')),
        program: !!pop.querySelector('[data-program-step]'), contracts: !!pop.querySelector('[data-role="no-contracts"]') }; });
    ok(mp && mp.id === id && mp.name === s.name && mp.goal === s.goal && mp.items.length === s.objectives.length && mp.items.every((t, i) => t === s.objectives[i].text),
      'the Missions panel (O) shows the scenario, its goal and its ' + s.objectives.length + ' objectives');
    ok(mp && !mp.program && !mp.contracts, 'and leaves the flight program and contracts out of it');
    if (id === order[0] || id === 'hollin-approach') await shot(id + '-missions');
    await page.keyboard.press('KeyO');
    await page.waitForTimeout(200);
  }
  await shot(id);

  // a few seconds of real play: nothing breaks, landed craft stay down, the game is not paused
  await page.waitForTimeout(2500);
  const later = await E(async () => {
    const S = await import('/js/core/scenarios.js');
    const sw = window.__sw, w = sw.world, v = w.active;
    return { ut: w.ut, name: v && v.name, dead: !v || !!v.dead, parts: v ? v.parts.size : 0, landed: v && v.landed, grounded: v && v.grounded, clear: v && v.landed ? S.groundClearance(v) : null, done: sw.career.scenario.done.length, t0: sw.career.scenario.startedUt };
  });
  ok(!later.dead && later.parts === f.parts && later.ut > later.t0, `a few seconds on: ${later.name} intact, the clock runs (T+${(later.ut - later.t0).toFixed(1)} s)`);
  if (f.landed) ok((later.landed || later.grounded) && (later.clear == null || Math.abs(later.clear) < 0.5), 'still standing on the ground');
  ok(later.done === 0, 'no objective ticks by itself');
  {
    const said = await notices();
    ok(!said.some(t => /^Milestone|^Next mission/.test(t)), 'no flight-program notices in a scenario' + (said.length ? ' (shown: ' + said.join(' | ').slice(0, 160) + ')' : ''));
  }
  noErrors(id);
}

// ---------------------------------------------------------------------------- objectives in play, quicksave, resume
if (order.length) {
  const id = order[order.length - 1], s = catalog.find(x => x.id === id);
  console.log(`\n--- progress, quicksave and resume (${s.name})`);
  let expectDone = 0;
  if (id === 'ost-outpost') {
    // a Pip steps outside: the first objective ticks, with a notice
    await notices();
    await E(() => { const w = window.__sw.world; w.evaStart(w.active); });
    await page.waitForFunction(() => { const n = document.querySelector('.sw-scn-panel'); return n && n.dataset.done === '1'; }, null, { timeout: 30000 });
    const st = await E(() => ({ status: window.__sw.app.scenarios.status(), toasts: window.__sw.app.__notices.slice(), li: [...document.querySelectorAll('.sw-scn-panel .sw-scn-list li')].map(li => li.className) }));
    ok(st.status.done === 1 && st.status.objectives[0].done && !st.status.objectives[1].done, 'sending a Pip outside ticks the first objective');
    ok(st.toasts.some(t => /Objective complete: Send a Pip outside/.test(t)), 'a notice says so: ' + st.toasts.join(' | '));
    ok(st.li[0] === 'done' && st.li[1] === 'next', 'the panel shows it done and marks the next one');
    await shot(id + '-objective');
    expectDone = 1;
  }
  // quicksave goes to the scenario's own key
  const qs = await E(() => { const ok = window.__sw.app.flight.actions.quicksave(); return { ok, scn: !!localStorage.getItem('starwright.scenario.quicksave.v1'), main: !!localStorage.getItem('starwright.quicksave.v1') }; });
  ok(qs.ok && qs.scn && !qs.main, 'a quicksave in a scenario is kept apart from the player\'s own quicksave');
  const ut = await E(() => window.__sw.world.ut);
  await toTitle();
  ok(await store(MAIN_KEY) === mainSave, 'back on the title screen: the player\'s own save is unchanged');
  const note = await E(() => document.querySelector('.sw-menu [data-action="scenarios"] small').textContent);
  ok(note === 'in progress: ' + s.name, 'the menu entry says which scenario is in progress: "' + note + '"');
  await openPicker();
  const cur = await E(() => { const c = document.querySelector('.sw-scn-card.current'); return c ? { id: c.dataset.scenario, text: c.querySelector('.sw-scn-foot small').textContent, btns: [...c.querySelectorAll('.sw-btn')].map(b => b.dataset.action), focus: document.activeElement.dataset.action } : null; });
  ok(cur && cur.id === id && cur.btns.join() === 'restart,resume' && /In progress/.test(cur.text) && cur.focus === 'resume', `its card says "${cur && cur.text}" and offers Resume (focused) and Restart`);
  await shot('picker-in-progress');
  await page.click('.sw-scn-card.current [data-action="resume"]');
  await waitScreen('flight');
  const res = await E(() => ({ id: window.__sw.career.scenario.id, done: window.__sw.career.scenario.done.length, ut: window.__sw.world.ut, vessels: window.__sw.world.vessels.filter(v => !v.dead).length, brief: !!document.querySelector('.sw-scn-brief') }));
  ok(res.id === id && res.done === expectDone && res.ut >= ut - 1 && !res.brief, `Resume returns to the flight where it was left (${res.done} objective${res.done === 1 ? '' : 's'} done, ${res.vessels} vessel${res.vessels === 1 ? '' : 's'}), without the brief`);
  await page.waitForSelector('.sw-scn-panel');
  noErrors('resume');

  // the player's own program is still there, and is an ordinary game
  await toTitle();
  await page.click('.sw-menu [data-action="continue"]');
  await waitScreen('hub');
  await page.waitForTimeout(900);
  const mine = await E(() => ({ funds: window.__sw.career.funds, mode: window.__sw.career.mode, scenario: window.__sw.career.scenario, panel: !!document.querySelector('.sw-scn-panel') }));
  ok(mine.funds === 12345 && mine.mode === 'career' && !mine.scenario && !mine.panel, 'Continue opens the player\'s own program (12,345 funds, career mode), with no scenario panel');
  ok(JSON.parse(await store(SLOT_KEY)).scenario.id === id, 'and the scenario is still waiting in its slot');
  noErrors('continue');

  // importing a save file while a scenario is being played: it says which saved game it replaces, and does only that
  console.log('\n--- importing a save while in a scenario');
  const file = await E(async () => {
    const { Career } = await import('/js/core/career.js');
    const c = Career.newGame('science', { seed: 5 }); c.science = 77; c.ut = 90000;
    return c.exportSave();
  });
  const pick = async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 30000 }), page.click('.sw-settings-modal [data-action="import-save"]')]);
    await chooser.setFiles({ name: 'other-program.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  };
  await toTitle();
  await openPicker();
  await page.click('.sw-scn-card.current [data-action="resume"]');
  await waitScreen('flight');
  await E(async () => { const app = window.__sw.app; app.save(true); await app.goto('hub'); });
  await waitScreen('hub');
  ok(await E(() => !!window.__sw.career.scenario), 'at the Flight Center of the scenario game');
  const ownBefore = await store(MAIN_KEY), slotBefore = JSON.parse(await store(SLOT_KEY)).scenario.id;
  // through the Flight Center's own menu
  await page.waitForSelector('[data-action="menu"]', { timeout: 30000 });
  await page.click('[data-action="menu"]');
  await page.waitForSelector('[data-menu="settings"]', { timeout: 15000 });
  await page.click('[data-menu="settings"]');
  await page.waitForSelector('.sw-settings-modal [data-action="import-save"]');
  await pick();
  await page.waitForSelector('.sw-modal .sw-btn.danger');
  const ask = await E(() => { const m = [...document.querySelectorAll('.sw-modal')].pop(); return { title: m.querySelector('.sw-modal-title, h3, h2') ? m.querySelector('.sw-modal-title, h3, h2').textContent : '', text: m.textContent }; });
  ok(/Replace your own program\?/.test(ask.text) && /your own saved program/.test(ask.text) && /scenario you are playing is not touched/.test(ask.text), 'it asks "Replace your own program?" and says the scenario is not touched');
  await shot('import-confirm');
  await page.click('.sw-modal-backdrop:last-child .sw-modal-buttons .sw-btn:not(.danger)');
  await page.waitForTimeout(400);
  ok(await store(MAIN_KEY) === ownBefore && await E(() => !!window.__sw.career.scenario), 'Cancel: the player\'s own save and the scenario game are both as they were');
  await pick();
  await page.waitForSelector('.sw-modal .sw-btn.danger');
  await page.click('.sw-modal .sw-btn.danger');
  await waitScreen('hub');
  await page.waitForFunction(() => window.__sw.career && !window.__sw.career.scenario, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const after = await E(() => ({ mode: window.__sw.career.mode, science: window.__sw.career.science, scenario: window.__sw.career.scenario, own: JSON.parse(localStorage.getItem('starwright.save.v1')), slot: JSON.parse(localStorage.getItem('starwright.scenario.v1')) }));
  ok(after.mode === 'science' && after.science === 77 && !after.scenario, 'Load the file: the imported program is now the player\'s own (science mode, 77 science)');
  ok(after.own.mode === 'science' && after.own.science === 77, 'it is what the main save now holds');
  ok(after.slot && after.slot.scenario && after.slot.scenario.id === slotBefore, 'and the scenario is still in its slot, untouched');
  noErrors('import');
}

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length + errors.length} problem(s) [${order.length} scenario(s), ${W}x${H}, device pixel ratio ${DPR}]`);
for (const p of [...problems, ...errors]) console.log(' - ' + p);
process.exit(problems.length + errors.length ? 1 : 0);
