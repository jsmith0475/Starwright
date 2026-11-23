// End-to-end check of orbital refuelling in the real game (docs/SHEARWATER.md, step 3): the Topping Up scenario
// starts with Shearwater 150 m from the depot Deepwell. The docking assist brings the two Flank Ports together side
// by side, the Fuel panel's propellant line fills the ship while its thrusters hold the tanks settled, and it undocks.
//   node tests/e2e/topping_up.mjs     (screenshots land in tests/out/topping-*.png)
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(180000);
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
const shot = async name => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, name + '.png') }); };
const waitScreen = async name => { await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 240000 }); await page.waitForTimeout(400); };
async function ff(sim, until = 'false') {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await page.evaluate(({ budget, until }) => {
      const sw = window.__sw, app = sw.app, test = new Function('w', 'v', 'B', 'return (' + until + ');');
      const t0 = performance.now(), ut0 = sw.world.ut; let hit = false;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - ut0 < budget) {
        app.current.update(0.02); app.input.endFrame();
        if (test(sw.world, sw.world.active, window.__shw)) { hit = true; break; }
      }
      return { advanced: sw.world.ut - ut0, hit };
    }, { budget: left, until });
    hit = r.hit; left -= Math.max(r.advanced, 0.01);
  }
  return hit;
}
const key = async code => { await page.keyboard.down(code); await page.waitForTimeout(60); await page.evaluate(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); }); await page.keyboard.up(code); await page.waitForTimeout(40); };
const E = fn => page.evaluate(fn);
const state = () => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, v = w.active, B = window.__shw;
  const t = v.partList.find(p => p.type === 'tank_xxl_ship'), full = t ? (t.res.lox + t.res.ch4) / (t.def.res.lox + t.def.res.ch4) : 0;
  const o = v.getOrbit(w.ut);
  return { name: v.name, mass: v.mass, full, mono: v.resources.mono ? v.resources.mono.amount : 0, docked: (v.dockedPairs || []).length, lines: v.propellantLines.length,
    pump: v.pump ? { state: v.pump.state, moved: v.pump.moved, total: v.pump.total } : null, last: v.lastPump, accel: v.axialAccel, apo: o ? o.apoapsis - v.body.radius : 0, peri: o ? o.periapsis - v.body.radius : 0,
    assistKind: sw.app.flight.assistKind, vessels: w.vessels.filter(x => !x.dead && x.type === 'ship').map(x => x.name), toasts: B ? B.toasts.slice() : [], done: (sw.app.career && sw.app.career.scenario && sw.app.career.scenario.done) || [],
    target: v.targetInfo ? v.targetInfo.distance : null, w: v.w.length() };
});

console.log('\n=== Topping Up: side docking and the propellant line (1440×900) ===');
await page.goto(server.url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
await page.waitForSelector('.sw-menu [data-action="scenarios"]');
await page.click('.sw-menu [data-action="scenarios"]');
await page.waitForSelector('.sw-scn-modal .sw-scn-grid');
const btn = page.locator('.sw-scn-card[data-scenario="topping-up"] [data-action="start"]');
await btn.scrollIntoViewIfNeeded();
await btn.click();
await waitScreen('flight');
await page.waitForSelector('.sw-scn-brief', { timeout: 60000 });
await shot('topping-1-brief');
await E(() => { const b = document.querySelector('.sw-scn-brief .sw-btn, .sw-modal .sw-btn.primary'); if (b) b.click(); });
await page.waitForTimeout(600);
await E(() => {
  const sw = window.__sw, B = window.__shw = { toasts: [] };
  const toast = sw.app.toast.bind(sw.app);
  sw.app.toast = (text, ...rest) => { B.toasts.push(String(text)); return toast(text, ...rest); };
});
let s = await state();
ok(s.name === 'Shearwater' && Math.abs(s.full - 0.41) < 0.01, `Shearwater, ${(s.full * 100).toFixed(0)} % full`);
ok(s.target !== null && s.target > 100 && s.target < 200, `the depot is the target, ${s.target && s.target.toFixed(0)} m away`);
ok(s.vessels.includes('Deepwell'), 'Deepwell is there');
await ff(1); await shot('topping-2-start');

// the Dock panel offers the assist for Flank Ports, and it flies the approach
await page.click('.fl-tool[data-tool="dock"], [data-tool="dock"]').catch(() => E(() => window.__sw.app.flight.hud.togglePanel('dock')));
await page.waitForTimeout(400);
const dockPanel = await E(() => { const n = document.querySelector('.fl-pop'); return n ? n.textContent : ''; });
ok(/Flank Port/.test(dockPanel), 'the Dock panel lists the Flank Port');
ok(/Ready: flies the last stretch/.test(dockPanel), 'and the docking assist is ready: ' + dockPanel.slice(0, 160));
await shot('topping-3-dock-panel');
await page.click('[data-action="dock-assist"]');
s = await state();
ok(s.assistKind === 'dock', 'the docking assist is flying');
await E(() => window.__sw.app.flight.hud.closePanels());
await ff(60); await shot('topping-4-approach');
ok(await ff(900, 'v.dockedPairs.length > 0'), 'the two ships dock');
await ff(2);
s = await state();
ok(s.docked === 1 && s.lines === 1, 'one docked pair, and it carries a propellant line');
ok(s.toasts.some(t => /propellant line is connected/.test(t)), 'the player is told the line is connected');
ok(s.w < 0.03, 'the pair is not left spinning');
ok(s.done.includes('dock'), 'objective: docked');
await shot('topping-5-docked');

// the Fuel panel: the propellant line
await E(() => window.__sw.app.flight.hud.togglePanel('fuel'));
await page.waitForSelector('[data-action="pump-in"]');
const before = s;
await shot('topping-6-fuel-panel');
await page.click('[data-action="pump-in"]');
await ff(4);
s = await state();
ok(s.pump && s.pump.state === 'pumping', 'the pump is drawing: ' + JSON.stringify(s.pump));
ok(s.accel > 0.002 && s.accel < 0.006, `the thrusters hold ${(s.accel * 1000).toFixed(1)} mm/s² along the stack`);
const status = await E(() => document.querySelector('[data-pump="status"]').textContent);
ok(/Pumping in at 300 kg\/s/.test(status), 'the panel says so: ' + status);
await shot('topping-7-pumping');
ok(await ff(600, '!v.pump'), 'the pump finishes');
s = await state();
ok(s.last && s.last.why === 'done', 'because it is done: ' + (s.last && s.last.why));
ok(s.full > 0.999, `the ship's tanks are ${(s.full * 100).toFixed(1)} % full`);
ok(Math.abs(s.last.moved - 0.59 * 160000) < 2000, `${(s.last.moved / 1000).toFixed(1)} t crossed`);
ok(before.mono - s.mono > 1 && before.mono - s.mono < 400, `settling cost ${(before.mono - s.mono).toFixed(0)} kg of monopropellant`);
ok(s.peri > 90000, `still in orbit: ${(s.apo / 1000).toFixed(1)} by ${(s.peri / 1000).toFixed(1)} km`);
ok(s.done.includes('fill'), 'objective: filled');
await shot('topping-8-full');

// and let go
await E(() => window.__sw.app.flight.hud.togglePanel('dock'));
await page.waitForSelector('[data-action="undock"]');
await page.click('[data-action="undock"]');
await ff(3);
s = await state();
ok(s.docked === 0 && s.name === 'Shearwater' && s.vessels.includes('Deepwell'), 'undocked: two vessels again, and the player has Shearwater');
ok(s.full > 0.999, 'with the tanks still full');
await ff(2);
s = await state();
ok(s.done.includes('undock'), 'objective: undocked. Scenario complete');
await E(() => window.__sw.app.flight.hud.closePanels());
await shot('topping-9-apart');

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
