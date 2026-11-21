// End-to-end check of the structure report and load overlay of the assembly building (roadmap item 2).
//   NODE_PATH=/opt/node-tools/node_modules node tests/e2e/structure_builder.mjs [quick] [out=<dir>] [hangar-shot=<file.png>]
// Opens the building with a stock rocket (sane percentage, overlay on and off), then with a deliberately weak
// design (a heavy capsule on a long thin stack: the report goes red, names the joint, a warning appears).
// Screenshots: builder-structure-*.png in tests/out (or out=<dir>).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outArg = (process.argv.find(a => a.startsWith('out=')) || '').slice(4);
const OUT = outArg ? path.resolve(outArg) + path.sep : path.join(ROOT, 'tests/out') + path.sep;
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
let checks = 0, failed = 0;
function ok(cond, what) { checks++; if (!cond) { failed++; problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(240000);
page.on('console', m => {
  if (m.type() !== 'error') return;
  if (/GL Driver Message|GPU stall/.test(m.text())) return;
  problems.push('console error: ' + m.text());
});
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));

const B = (fn, arg) => page.evaluate(fn, arg);
const frames = (n = 2) => page.evaluate(k => new Promise(r => { const step = () => (k-- > 0 ? requestAnimationFrame(step) : r()); step(); }), n);
const tap = async sel => { await page.waitForSelector(sel); await B(q => document.querySelector(q).click(), sel); };
const settle = async () => {
  await page.waitForFunction(() => { const b = window.__sw.app.builder, c = b.camera; return !b.loadsPending && Math.abs(c.dist - c.tdist) < 0.03 && Math.abs(c.ty - c.tty) < 0.03 && Math.abs(c.yaw - c.tyaw) < 0.005 && Math.abs(c.pitch - c.tpitch) < 0.005; });
  await frames(2);
};
const shot = async name => { await settle(); await page.waitForTimeout(300); await page.screenshot({ path: OUT + 'builder-structure-' + name + '.png', timeout: 240000 }); console.log('  (screenshot ' + OUT + 'builder-structure-' + name + '.png)'); };
const line = () => B(() => { const n = document.querySelector('.bld-struct'); return n ? { text: n.textContent, level: n.dataset.level, cls: n.className, pct: (n.querySelector('.bld-struct-pct') || {}).textContent, bar: (n.querySelector('.bld-ld-bar i') || { style: {} }).style.width } : null; });
const state = () => B(() => { const b = window.__sw.app.builder, r = b.loads; return { empty: r.empty, count: r.count, worst: r.worst && { util: r.worst.util, text: r.worst.text, level: r.worst.level, ids: r.worst.ids }, rows: r.rows.map(x => x.text), warnings: r.warnings, overlay: b.loadOverlay, pending: b.loadsPending, runs: b.loadsRuns, ms: b.loadsMs, check: b.checkCraft() }; });

try {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await tap('[data-action="new"]');
  await tap('.sw-mode[data-mode="sandbox"]');
  await tap('.sw-modal .sw-btn.primary');
  await page.waitForFunction(() => window.__sw.app.currentName === 'hub' && window.__sw.app.current, null, { timeout: 60000 });

  // ---------------------------------------------------------------- a stock rocket
  console.log('stock rocket');
  const stock = await B(async () => { const m = await import('/js/core/craft.js'); const c = m.stockCrafts().find(x => x.name === 'Pell Runner') || m.stockCrafts()[2]; return c.toJSON(); });
  await B(j => { window.__sw.app.goto('builder', { craft: j, site: 'pad' }); }, stock);
  await page.waitForFunction(() => window.__sw.app.currentName === 'builder' && window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
  await B(() => { const b = document.querySelector('[data-action="hint-ok"]'); if (b) b.click(); });
  await settle();
  let s = await state(), l = await line();
  ok(!s.empty && s.count === stock.parts.length - 1, `one joint per attached part (${s.count} joints, ${stock.parts.length} parts)`);
  ok(s.worst && s.worst.util > 0.02 && s.worst.util < 0.75, `stock design is comfortably inside its strength (${s.worst && (s.worst.util * 100).toFixed(0)} %)`);
  ok(l && /^\d+ %$/.test(l.pct) && Math.round(s.worst.util * 100) + ' %' === l.pct, `the Structure line shows the percentage (${l && l.pct})`);
  ok(l && l.text.includes(s.worst.text.split(':')[0]) && /(bending|pushed together|pulled apart|shear) (at|under) /.test(l.text), `... and the joint and the case in plain words (“${l && l.text}”)`);
  ok(l && l.level === s.worst.level && !/tension|compression|stage \d/.test(l.text), 'no raw field names in the line');
  ok(parseFloat(l.bar) > 1 && parseFloat(l.bar) < 75, `the bar is filled to ${l.bar}`);
  ok(!s.check.warnings.some(w => /joint|limit|break/.test(w)), 'no structural warning for a stock design');
  ok(s.overlay && !s.overlay.on && !s.overlay.visible, 'the overlay starts off');

  // overlay: toolbar button on, key L off, key L on
  await page.click('.bld-tool[data-action="loads"]'); await frames(3);
  s = await state();
  ok(s.overlay.on && s.overlay.visible && s.overlay.rings === s.count, `the toolbar button draws one ring per joint (${s.overlay.rings})`);
  ok(await B(() => document.querySelector('.bld-tool[data-action="loads"]').classList.contains('active')), 'the button shows it is on');
  const drawn = await B(() => { const g = window.__sw.app.builder.scene.getObjectByName('load_overlay'); const m = g.children[0]; return { visible: g.visible, count: m.count, colours: m.instanceColor ? Array.from(m.instanceColor.array.slice(0, 3)).map(v => +v.toFixed(2)) : null, inScene: !!g.parent }; });
  ok(drawn.visible && drawn.count === s.count && drawn.colours, `the instanced bands are in the scene (${drawn.count} instances)`);
  await page.mouse.move(720, 420); await page.keyboard.press('KeyL'); await frames(3);
  ok(!(await state()).overlay.visible, 'L switches it off');
  await page.keyboard.press('KeyL'); await frames(3);
  ok((await state()).overlay.visible, 'L switches it on again');
  // the list of five, and pointing at a joint
  await page.click('.bld-struct'); await frames(2);
  const rows = await B(() => [...document.querySelectorAll('.bld-loads .bld-ld-row')].map(n => n.textContent));
  ok(rows.length >= 2 && rows.length <= 5, `the line opens a list of the most loaded joints (${rows.length} rows)`);
  await page.hover('.bld-loads .bld-ld-row:nth-child(2)'); await frames(3);
  await page.waitForTimeout(600);        // (the tooltip of the Structure line fades)
  ok((await state()).overlay.focused >= 1, 'hovering a row points the joint out in the hall');
  await B(() => { const b = window.__sw.app.builder; b.setCamera({ dist: 16, ty: b.loads.rows[1].pos.y, pitch: 0.25 }); });
  await shot('overlay');
  await page.mouse.move(720, 300); await frames(3);
  ok((await state()).overlay.focused === 0, 'leaving the row lets go');
  const runs0 = (await state()).runs;
  await B(() => { const b = window.__sw.app.builder; b.setCamera({ yaw: b.camera.yaw + 0.2 }); });
  await frames(30);
  ok((await state()).runs === runs0, 'nothing is worked out again while the design does not change');
  await page.keyboard.press('Escape'); await frames(2);
  ok(await B(() => document.querySelector('.bld-loads').classList.contains('sw-hidden')), 'Esc closes the list');

  // ---------------------------------------------------------------- a deliberately weak design
  console.log('weak design');
  const weak = await B(async () => {
    const { Craft } = await import('/js/core/craft.js');
    const c = new Craft('Noodle');
    let cur = c.setRoot('pod_hearth')[0];
    for (const t of ['dec_s', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_l3200', 'eng_condor']) cur = c.attachStack(t, cur.id, 'bottom')[0];
    return c.toJSON();
  });
  await B(j => window.__sw.app.builder.loadCraft(j), weak);
  ok((await state()).pending, 'a new design is not analysed in the same instant (debounced)');
  await settle();
  s = await state(); l = await line();
  ok(s.worst && s.worst.util >= 1, `the weak design is over its strength (${s.worst && (s.worst.util * 100).toFixed(0)} %)`);
  ok(l.level === 'bad' && / bad/.test(l.cls) && l.bar === '100%', 'the Structure line is red and the bar is full');
  ok(/(Flask S-200|Stack Separator S|Drum L-3200)/.test(l.text) && /will break/.test(l.text), `it names the joint and says it will break (“${l.text}”)`);
  ok(s.check.ok && /will break in flight/.test(s.check.warnings[0]) && !s.check.errors.length, 'a warning (not an error) heads the pre-launch checks');
  ok(await B(() => { const n = document.querySelector('.bld-check'); return !!n && (n.classList.contains('warn')) && /will break|\+\d/.test(n.textContent + (n.getAttribute('data-tip') || '')); }), 'the info bar shows it');
  ok(s.overlay.visible && s.overlay.breaking >= 1 && s.overlay.rings === s.count, `the overlay marks ${s.overlay.breaking} breaking joint(s) with a pulse`);
  const ringPos = await B(() => {       // the worst ring really sits between its two parts
    const b = window.__sw.app.builder, r = b.loads.worst, m = b.loads.marks[r.marks[0]], c = b.craft;
    const [p, q] = r.ids.map(id => c.getPart(id));
    return { y: m.y, lo: Math.min(p.pos.y, q.pos.y), hi: Math.max(p.pos.y, q.pos.y), x: m.x, z: m.z };
  });
  ok(ringPos.y > ringPos.lo && ringPos.y < ringPos.hi && Math.abs(ringPos.x) < 1e-6 && Math.abs(ringPos.z) < 1e-6, 'the worst ring sits between the two parts it joins, on the axis');
  await page.click('.bld-struct'); await frames(2);
  await page.click('.bld-loads .bld-ld-row:nth-child(1)'); await frames(3);
  ok((await state()).overlay.focused >= 1 && await B(() => document.querySelector('.bld-loads .bld-ld-row').classList.contains('pinned')), 'clicking a row pins it and looks at the joint');
  await B(() => { const b = window.__sw.app.builder; b.setCamera({ dist: 11, pitch: 0.22 }); });
  await shot('weak');
  // the launch dialog lists the warning and still lets the player launch
  await tap('[data-action="launch"]');
  await page.waitForSelector('.bld-launch-issues');
  const dlg = await B(() => ({ warn: [...document.querySelectorAll('.bld-launch-issues .sw-msg.warn')].map(n => n.textContent), bad: document.querySelectorAll('.bld-launch-issues .sw-msg.bad').length, launch: [...document.querySelectorAll('.sw-modal .sw-btn.primary')].map(n => ({ t: n.textContent, d: n.disabled })) }));
  ok(dlg.warn.some(w => /will break in flight/.test(w)) && dlg.bad === 0, 'the launch dialog lists it as a warning');
  ok(dlg.launch.some(b => /Launch anyway/.test(b.t) && !b.d), 'and the rocket may still be launched');
  await shot('launch');
  await B(() => { const b = [...document.querySelectorAll('.sw-modal .sw-btn')].find(n => /Keep building/.test(n.textContent)); if (b) b.click(); });
  await frames(3);

  if (process.argv.includes('quick')) throw { quick: true };      // (the report, the overlay and the screenshots only)
  // ---------------------------------------------------------------- edits: never while a part is in the hand; empty designs
  console.log('editing');
  const before = await state();
  await B(() => { const b = window.__sw.app.builder; b.focusLoad(-1); document.querySelector('.bld-loads .sw-modal-x').click(); b.frame(); });
  await settle();
  const drum = weak.parts[weak.parts.length - 2].id;
  const at = await B(id => window.__sw.app.builder.partScreenPos(id, 0, 0), drum);
  await page.mouse.move(at.x, at.y, { steps: 3 }); await frames(3);
  await page.mouse.click(at.x, at.y); await frames(3);
  const holding = await B(() => window.__sw.app.builder.held);
  if (ok(holding === 'tank_l3200', 'pulled the big tank (and the engine) off the craft with the mouse')) {
    await page.waitForTimeout(700); await frames(3);
    s = await state();
    ok(s.pending && s.runs === before.runs && !s.overlay.visible, 'while the part is in the hand nothing is analysed and the overlay hides');
    ok(/stale/.test((await line()).cls), 'the line is dimmed meanwhile');
    await page.keyboard.press('Escape'); await settle();
    s = await state();
    ok(!s.pending && s.runs === before.runs && s.overlay.visible, 'putting it back shows the same result without working it out again');
  }
  await B(async () => { const { Craft } = await import('/js/core/craft.js'); const c = new Craft('One'); c.setRoot('pod_acorn'); window.__sw.app.builder.loadCraft(c.toJSON()); });
  await settle();
  s = await state(); l = await line();
  ok(s.empty && l.pct === '--' && !s.overlay.visible, 'one part: an empty report (“--”), no rings, no error');
  await B(() => window.__sw.app.builder.newCraft()); await settle();
  ok((await state()).empty && (await line()).pct === '--', 'an empty hall too');
  await B(async () => { const { Craft } = await import('/js/core/craft.js'); const c = new Craft('No engine'); const p = c.setRoot('pod_acorn')[0]; c.attachStack('tank_m200', p.id, 'bottom'); window.__sw.app.builder.loadCraft(c.toJSON()); });
  await settle();
  s = await state();
  ok(!s.empty && s.count === 1 && s.worst.util < 0.5, `no engines, no staging: a quiet report (${s.worst && (s.worst.util * 100).toFixed(0)} %)`);

  // ---------------------------------------------------------------- the spaceplane hangar (craft lies nose forward)
  console.log('hangar');
  const plane = await B(async () => { const m = await import('/js/core/craft.js'); const c = m.stockCrafts().find(x => x.name === 'Kite Trainer'); return c ? c.toJSON() : null; });
  if (plane) {
    await B(j => { window.__sw.app.goto('builder', { craft: j, site: 'runway' }); }, plane);
    await page.waitForFunction(() => window.__sw.app.currentName === 'builder' && window.__sw.app.builder && window.__sw.app.builder.ready && window.__sw.app.builder.site === 'runway', null, { timeout: 240000 });
    await settle();
    const h = await state(), hl = await line();
    ok(!h.empty && h.count === plane.parts.length - 1 && /^\d+ %$/.test(hl.pct), `the hangar reports on a plane too (${hl.pct}, “${h.worst.text}”)`);
    ok(h.overlay.on && h.overlay.visible && h.overlay.rings === h.count, 'and the overlay stays on from one building to the next');
    const hs = (process.argv.find(a => a.startsWith('hangar-shot=')) || '').slice(12);       // an extra screenshot for review
    if (hs) { await B(() => { const b = window.__sw.app.builder; b.setCamera({ dist: b.camera.dist * 0.75 }); }); await settle(); await page.waitForTimeout(300); await page.screenshot({ path: hs, timeout: 240000 }); }
  }
  console.log(`  (last analysis took ${s.ms.toFixed(1)} ms; ${s.runs} analyses in this session)`);
} catch (err) {
  if (!err || !err.quick) problems.push('script error: ' + (err.stack || err.message));
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${checks - failed}/${checks} checks passed`);
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log('structure_builder: OK');
