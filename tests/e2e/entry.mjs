// End-to-end check of the entry instruments in the real game (docs/ENTRY.md): a capsule at the top of Verda's air,
// the Entry box on the flight screen with its TRIM and BANK switches, the bank following the roll key, the lift
// marker on the attitude ball, the predicted peaks and landing against the entry as flown, and the path on the map.
//   node tests/e2e/entry.mjs     (screenshots land in tests/out/entry-*.png)
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
page.on('console', m => { if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async name => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, name + '.png') }); };
const waitScreen = async name => { await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 240000 }); await page.waitForTimeout(400); };
/** Run the game's own update loop for `sim` seconds of game time, or until the expression `until` (of w, v) is true. */
async function ff(sim, until = 'false') {
  let left = sim, hit = false;
  while (left > 0 && !hit) {
    const r = await E(({ budget, until }) => {
      const sw = window.__sw, app = sw.app, test = new Function('w', 'v', 'return (' + until + ');');
      const t0 = performance.now(), ut0 = sw.world.ut; let hit = false;
      const rec = window.__entry;
      while (performance.now() - t0 < 400 && app.currentName === 'flight' && sw.world.ut - ut0 < budget) {
        app.current.update(0.02); app.input.endFrame();
        const v = sw.world.active;
        if (rec && v) { if (v.gForce > rec.g) rec.g = v.gForce; if (v.heatFlux > rec.flux) rec.flux = v.heatFlux; }
        if (test(sw.world, v)) { hit = true; break; }
      }
      return { advanced: sw.world.ut - ut0, hit };
    }, { budget: left, until });
    hit = r.hit; left -= Math.max(r.advanced, 0.01);
  }
  return hit;
}
const entryText = () => E(() => { const b = document.querySelector('[data-hud="entry"]'); return b && !b.classList.contains('sw-hidden') ? b.innerText.replace(/\s+/g, ' ') : null; });
const values = () => E(() => window.__sw.app.flight.hud.values.entry);

console.log('\n=== Entry instruments ===');
await page.goto(server.url, { timeout: 240000 });
await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app, null, { timeout: 240000 });
await E(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('starwright.')) localStorage.removeItem(k); });
await page.reload();
await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__sw && window.__sw.app, null, { timeout: 240000 });
await page.waitForSelector('.sw-menu [data-action="scenarios"]');
await page.click('.sw-menu [data-action="scenarios"]');
await page.waitForSelector('.sw-scn-modal .sw-scn-grid');
await page.click('.sw-scn-card[data-scenario="morning-orbit"] [data-action="start"]');
await waitScreen('flight');
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(600);
await E(() => { for (const m of document.querySelectorAll('.sw-modal [data-action="close"], .sw-modal .sw-btn.primary')) m.click(); });

// in orbit: no Entry box
ok(await entryText() === null, 'in a 100 km orbit the Entry box is hidden');

// put the capsule alone at the top of the air: 2,300 m/s, 1.5 degrees below level
const setup = await E(() => {
  const sw = window.__sw, w = sw.world, v = w.active, b = v.body;
  // leave the service stage behind: stage until only the capsule's own parts are left
  for (let i = 0; i < 6 && v.parts.size > 4; i++) v.activateNextStage([]);
  const r = b.radius + b.atmo.height - 200, a = 1.5 * Math.PI / 180;
  v.pos.set(r, 0, 0); v.vel.set(-2300 * Math.sin(a), 0, 2300 * Math.cos(a)); v.w.set(0, 0, 0);
  v.ctrl.throttle = 0; v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  window.__entry = { g: 0, flux: 0 };
  return { parts: [...v.parts.values()].map(p => p.type), trim: v.trimParts.length, mass: v.mass };
});
console.log('  capsule: ' + setup.parts.join(', ') + ', ' + Math.round(setup.mass) + ' kg');
ok(setup.trim === 1, 'the capsule offers Entry trim');
await ff(2);
await page.waitForTimeout(700); await ff(0.2);
let txt = await entryText();
ok(txt !== null && /TRIM/.test(txt) && /BANK/.test(txt), 'entering the air the Entry box shows, with TRIM and BANK: ' + txt);
let val = await values();
ok(val && val.end === 'land' && val.peakG > 2 && val.peakG < 5, 'ballistic: a landing is predicted, peak ' + (val && val.peakG ? val.peakG.toFixed(2) : '?') + ' g');
const ballisticG = val ? val.peakG : 0;

await page.click('[data-entry="trim"]');
await page.click('[data-entry="bank"]');
await page.waitForTimeout(700); await ff(0.2); await page.waitForTimeout(600); await ff(0.1);
val = await values();
ok(val && val.trim && val.bankHold, 'TRIM and BANK switch on');
ok(val && val.end === 'land' && val.peakG < ballisticG * 0.75, 'lift up: the predicted peak falls to ' + (val && val.peakG ? val.peakG.toFixed(2) : '?') + ' g (ballistic ' + ballisticG.toFixed(2) + ')');
const predicted = val ? { g: val.peakG, flux: val.peakFlux } : { g: 0, flux: 0 };
const predDir = await E(() => { const p = window.__sw.app.flight.actions.entryPrediction(); return p ? [p.dir.x, p.dir.y, p.dir.z] : null; });

// hold the roll key: the commanded bank turns, then bring it back
await page.keyboard.down('KeyE'); await ff(2); await page.keyboard.up('KeyE');
const banked = await E(() => window.__sw.world.active.bank * 180 / Math.PI);
ok(banked > 20 && banked < 60, 'two seconds of the roll-right key turn the commanded bank about 40° to the right (' + banked.toFixed(0) + '°)');
await E(() => { window.__sw.world.active.bank = 0; });

// down to Mach 5 in thick air: the instruments read, the ball carries the lift marker
await ff(400, 'v.gForce > 1.2');
await page.waitForTimeout(700); await ff(0.2);
val = await values(); txt = await entryText();
console.log('  at 1.2 g: ' + txt);
ok(val && val.ld > 0.2 && val.ld < 0.36, 'lift over drag reads ' + (val && val.ld ? val.ld.toFixed(2) : '?') + ' (0.27 expected at the trim angle)');
ok(val && Math.abs(val.bank) < 0.12, 'bank now reads near 0° (' + (val && val.bank !== null ? (val.bank * 57.3).toFixed(1) : '?') + '°)');
ok(val && val.flux > 20000, 'heat flux reads ' + (val ? (val.flux / 1000).toFixed(0) : '?') + ' kW/m²');
await shot('entry-hud');
await page.keyboard.press('KeyM');
await page.waitForTimeout(900); await ff(0.2);
await shot('entry-map');
const lab = await E(() => [...document.querySelectorAll('.map-label, .sw-map-label, [class*="pill"]')].map(n => n.textContent).filter(t => /Down in|Skips out/.test(t)));
ok(lab.length > 0, 'the map marks where the path ends: ' + (lab[0] || 'no label found'));
await page.keyboard.press('KeyM');

// fly it down and compare with what was predicted at the top
await ff(1500, 'v.altitude < 3000 || v.landed || v.dead');
const end = await E(() => {
  const sw = window.__sw, v = sw.world.active, b = v.body, THREE = v.pos.constructor;
  const d = v.pos.clone().applyAxisAngle(new THREE(0, 1, 0), -b.rotationAngle(sw.world.ut)).normalize();
  return { dead: v.dead, alt: v.altitude, g: window.__entry.g, flux: window.__entry.flux, dir: [d.x, d.y, d.z], R: b.radius };
});
ok(!end.dead, 'the capsule comes down whole');
ok(Math.abs(end.g - predicted.g) < 0.12 * predicted.g, 'peak g flown ' + end.g.toFixed(2) + ' against ' + predicted.g.toFixed(2) + ' predicted at the top');
ok(Math.abs(end.flux - predicted.flux) < 0.08 * predicted.flux, 'peak heat flux flown ' + (end.flux / 1000).toFixed(1) + ' against ' + (predicted.flux / 1000).toFixed(1) + ' kW/m² predicted');
if (predDir) {
  const dot = Math.min(1, end.dir[0] * predDir[0] + end.dir[1] * predDir[1] + end.dir[2] * predDir[2]), miss = Math.acos(dot) * end.R / 1000;
  ok(miss < 25, 'it comes down ' + miss.toFixed(1) + ' km from the point predicted at the top of the air');
}

await browser.close(); await server.close();
console.log(`\n${checks - problems.filter(p => p.startsWith('FAILED')).length} of ${checks} checks passed`);
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
