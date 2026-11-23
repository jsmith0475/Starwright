// End-to-end check of reusable boosters, phase 1, in the real game: a rocket whose first stage carries a guidance
// ring is launched with the ascent assist; after separation the hop key (\) takes the booster while the assist
// goes on flying the upper stage to orbit; fast warp is held while the booster is in flight.
//   node tests/e2e/booster.mjs            (screenshots land in tests/out/booster-*.png)
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

/** Run the flight screen's own update(dt) (input → programs → world.step → HUD) until `until` holds or `sim` seconds pass. */
async function ff(sim, until = 'false') {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await page.evaluate(({ budget, until }) => {
      const sw = window.__sw, app = sw.app, test = new Function('w', 'v', 'B', 'return (' + until + ');');
      const t0 = performance.now(), ut0 = sw.world.ut; let hit = false;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - ut0 < budget) {
        app.current.update(0.02); app.input.endFrame();
        if (test(sw.world, sw.world.active, window.__bst)) { hit = true; break; }
      }
      return { advanced: sw.world.ut - ut0, hit };
    }, { budget: left, until });
    hit = r.hit; left -= Math.max(r.advanced, 0.01);
  }
  return hit;
}
/** A real key press that the flight screen sees on its next update. */
const key = async code => { await page.keyboard.down(code); await page.waitForTimeout(60); await page.evaluate(() => { const a = window.__sw.app; a.current.update(0.02); a.input.endFrame(); }); await page.keyboard.up(code); await page.waitForTimeout(40); };
const info = () => page.evaluate(() => {
  const sw = window.__sw, w = sw.world, B = window.__bst, f = sw.app.flight;
  const u = w.getVessel(B.upperId), b = B.booster;
  return { active: w.active ? w.active.name : null, activeId: w.active ? w.active.id : null, upperId: B.upperId, boosterId: b ? b.id : null,
    boosterName: b ? b.name : '', boosterType: b ? b.type : '', boosterDead: b ? !!b.dead : null, boosterRails: b ? !!b.onRails : null, boosterAlt: b ? b.altitude : 0,
    sep: u && b ? u.pos.distanceTo(b.pos) : 0, upperAlt: u ? u.altitude : 0, upperApo: u ? u.apoapsis : 0, upperPeri: u ? u.periapsis : 0, upperProgram: u ? u.program : null,
    upperThrottle: u ? u.ctrl.throttle : 0, assist: f.assist ? f.assist.phase : null, assistKind: f.assistKind, warp: w.warpIndex, tracked: w.tracked.map(x => x.name),
    toasts: B.toasts.slice(), destroyed: B.destroyed.slice(), removed: B.removed.slice() };
});

console.log('\n=== A rocket with a guidance ring on its first stage: separation, hop, warp hold, orbit (1440×900) ===');
await page.goto(server.url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
await page.click('[data-action="new"]');
await page.click('.sw-mode[data-mode="sandbox"]');
await page.click('.sw-modal .sw-btn.primary');
await waitScreen('hub');
await page.evaluate(async () => {
  const { Craft } = await import('/js/core/craft.js');
  const c = new Craft('Test Returner');
  const [pod] = c.setRoot('pod_acorn');
  c.attachStack('chute', pod.id, 'top');
  let cur = pod, low = null;
  for (const t of ['heatshield_m', 'dec_m', 'tank_m400', 'eng_sparrow', 'dec_m', 'probe_wisp', 'tank_m800', 'tank_m200', 'eng_goshawk']) { cur = c.attachStack(t, cur.id, 'bottom')[0]; if (t === 'tank_m200') low = cur; }
  c.attachRadial('fin', low.id, low.pos.y, Math.PI / 4, 4);
  c.autoStage();
  window.__sw.app.goto('flight', { craft: c.toJSON(), crew: ['Ada'] });
});
await waitScreen('flight');
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const sw = window.__sw, w = sw.world;
  const B = window.__bst = { upperId: w.active.id, booster: null, toasts: [], destroyed: [], removed: [] };
  w.on('decouple', d => { if (!B.booster && d.debris.type === 'ship') B.booster = d.debris; });
  w.on('destroyed', d => B.destroyed.push({ name: d.vessel.name, reason: d.reason, ut: w.ut }));
  w.on('message', d => { if (d.kind === 'removed') B.removed.push(d.text); });
  const toast = sw.app.toast.bind(sw.app);
  sw.app.toast = (text, ...rest) => { B.toasts.push(String(text)); return toast(text, ...rest); };
  sw.app.flight.actions.toggleAssist();
});
ok((await info()).assistKind === 'ascent', 'the ascent assist is flying the rocket');
ok(await ff(120, 'B.booster'), 'the assist stages and the first stage separates');
let s = await info();
ok(s.boosterType === 'ship' && / booster$/.test(s.boosterName), `the dropped stage is a flyable ship called "${s.boosterName}"`);
ok(s.toasts.some(t => /is flying on its own/.test(t)), 'the player is told the booster flies on, and which key reaches it');
await ff(3);
await shot('booster-1-separation');

await key('Backslash');
s = await info();
ok(s.activeId === s.boosterId, 'the hop key (\\) takes the booster: now flying ' + s.active);
ok(s.upperProgram === 'ascent' && s.assist === null, 'the ascent assist stays with the upper stage');
await ff(25);
s = await info();
ok(s.sep > 2500 && !s.boosterDead && !s.boosterRails, `25 s later the stages are ${(s.sep / 1000).toFixed(1)} km apart and both are flying`);
ok(s.upperThrottle > 0 || s.upperApo > 79000, `the upper stage is still being flown (throttle ${s.upperThrottle.toFixed(2)}, apoapsis ${(s.upperApo / 1000).toFixed(0)} km)`);
ok(s.tracked.length === 1 && !/booster/.test(s.tracked[0]), 'the upper stage is the vessel kept under full physics far away');
await shot('booster-2-flying-the-booster');

for (let i = 0; i < 6; i++) await key('Period');
s = await info();
ok(s.warp <= 3, `fast warp is held while the other vessel is in flight (warp index ${s.warp})`);
ok(s.toasts.some(t => /Time warp limited/.test(t)), 'and the game says why: ' + (s.toasts.filter(t => /Time warp limited/.test(t)).pop() || ''));
await key('Slash');

await key('Backslash');
s = await info();
ok(s.activeId === s.upperId, 'the hop key goes back to the upper stage');
ok(s.assistKind === 'ascent' && s.assist !== null, 'and its ascent assist comes back with it (' + s.assist + ')');
ok(s.tracked.some(n => / booster$/.test(n)), 'now the booster is the one kept under full physics far away');
await shot('booster-3-back-on-the-upper-stage');

ok(await ff(600, '!window.__sw.app.flight.assist'), 'the ascent assist runs to its end');
s = await info();
ok(s.upperPeri > 72000, `the upper stage is in orbit: ${(s.upperApo / 1000).toFixed(1)} × ${(s.upperPeri / 1000).toFixed(1)} km`);
const end = s.destroyed.find(d => / booster$/.test(d.name));
ok(s.boosterDead ? (end && end.reason !== 'atmosphere') : true, s.boosterDead ? `the unguided booster came down under physics and ended by ${end && end.reason} at T+${end && end.ut.toFixed(0)} s` : 'the booster is still there');
ok(s.removed.length === 0, 'nothing was removed for being left behind');
console.log('   toasts: ' + s.toasts.join(' | '));
await shot('booster-4-orbit');

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
