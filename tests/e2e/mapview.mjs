// End-to-end test of the orbital map view (js/ui/mapview.js) through tests/map-preview.html, with REAL mouse input.
//   node tests/e2e/mapview.mjs          screenshots land in tests/out/map-*.png
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });

async function open(query = '', { width = 1440, height = 900, dsf = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);            // software GL on a busy machine can take seconds per frame
  page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text() + ' @ ' + (m.location()?.url || '')); });
  page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
  page.on('requestfailed', r => { if (!/^data:/.test(r.url())) problems.push('request failed: ' + r.url()); });
  await page.goto(server.url + 'tests/map-preview.html' + query);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForTimeout(700);
  return { ctx, page };
}
const dbg = page => page.evaluate(() => window.__map.debug());
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const settle = (page, ms = 900) => page.waitForTimeout(ms);
/** Polls the map's debug state until `test(d)` holds (or `ms` runs out); returns the last state. */
async function waitDbg(page, test, ms = 4000) {
  let d = await dbg(page);
  for (const t0 = Date.now(); !test(d) && Date.now() - t0 < ms;) { await page.waitForTimeout(100); d = await dbg(page); }
  return d;
}
async function pressUntilFocus(page, id, key = 'Tab') {
  for (let i = 0; i < 10; i++) { if ((await dbg(page)).focus === id) return true; await page.keyboard.press(key); await page.waitForTimeout(60); }
  return (await dbg(page)).focus === id;
}

try {
  // ------------------------------------------------------------------ 1. opening view
  console.log('map view @1440x900');
  const { ctx, page } = await open();
  let d = await dbg(page);
  ok(d.open && d.focus === 'Skylark II', 'opens focused on the active vessel (' + d.focus + ')');
  ok(d.chains.length === 1 && d.chains[0] && near(d.chains[0].ap, 120e3, 500) && near(d.chains[0].pe, 80e3, 500),
    'predicts the 80 × 120 km orbit (Ap ' + Math.round(d.chains[0]?.ap) + ', Pe ' + Math.round(d.chains[0]?.pe) + ')');
  ok(d.labels.some(t => /^Ap 120\.0 km/.test(t)) && d.labels.some(t => /^Pe 80\.00 km/.test(t)), 'Ap / Pe pills show altitudes: ' + d.labels.filter(t => /^(Ap|Pe)/.test(t)).join(', '));
  ok(await page.locator('.map-body').innerText().then(t => /Verda/.test(t) && /Radius/.test(t) && /Biomes/i.test(t)), 'body info panel shows Verda');
  ok(await page.locator('.map-orbit').innerText().then(t => /Skylark II/.test(t) && /Apoapsis/.test(t) && /Inclination/.test(t)), 'vessel orbit panel is filled in');
  await shot(page, 'map-01-open.png');

  // ------------------------------------------------------------------ 2. zoom + orbit the camera with the mouse
  await page.mouse.move(720, 620);
  const dist0 = d.dist;
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(130); }
  await settle(page, 500);
  d = await dbg(page);
  ok(d.dist > dist0 * 1.8, 'wheel zooms out (×' + (d.dist / dist0).toFixed(2) + ')');
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(130); }
  for (let i = 0; i < 20; i++) { await settle(page, 250); d = await dbg(page); if (Math.abs(d.dist / d.distTarget - 1) < 1e-3) break; }   // let the zoom ease out
  ok(near(d.dist / dist0, 1, 0.05), 'wheel zooms back in (×' + (d.dist / dist0).toFixed(2) + ')');
  const yaw0 = d.yaw, pitch0 = d.pitch;
  await page.mouse.move(700, 650);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(820, 610, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  d = await dbg(page);
  ok(Math.abs(d.yaw - yaw0) > 0.3 && Math.abs(d.pitch - pitch0) > 0.1, 'right-drag orbits the camera (Δyaw ' + (d.yaw - yaw0).toFixed(2) + ', Δpitch ' + (d.pitch - pitch0).toFixed(2) + ')');
  ok(d.nodes.length === 0, 'right-drag does not create nodes');

  // ------------------------------------------------------------------ 3. hover the orbit, click to add a node
  const ut = await page.evaluate(() => window.__world.ut);
  let pt = null;
  for (const ahead of [900, 1300, 500, 1700, 2100, 2500, 300, 2900]) {       // a spot on the orbit that is on screen, not behind Verda and not in front of its disc
    const p = await page.evaluate(t => window.__map.screenPointAtTime(t), ut + ahead);
    const offDisc = p && Object.values(d.bodies).every(b => !b.visible || Math.hypot(b.x - p.x, b.y - p.y) > b.r + 12);
    if (p && p.visible && offDisc && p.x > 300 && p.x < 1140 && p.y > 90 && p.y < 800) { pt = { ...p, ahead }; break; }
  }
  ok(!!pt, 'found a visible point on the orbit to hover');
  await page.mouse.move(pt.x + 30, pt.y + 30);
  await page.mouse.move(pt.x + 2, pt.y + 2, { steps: 4 });
  await page.waitForTimeout(150);
  d = await waitDbg(page, s => !!s.hover, 3000);          // a slow frame must not read as "no ghost"
  ok(d.hover && near(d.hover.t - ut, pt.ahead, 60), 'hovering the trajectory shows the "+" ghost with the time to that point (' + (d.hover ? Math.round(d.hover.t - ut) + ' s' : 'none') + ')');
  ok(d.labels.some(t => /^Add maneuver · T−/.test(t)), 'ghost label: ' + d.labels.find(t => /^Add maneuver/.test(t)));
  await shot(page, 'map-02-hover.png');
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(300);
  d = await waitDbg(page, d => d.nodes.length === 1 && d.nodeScreen.length === 1);      // the gizmo is laid out on the next frame
  ok(d.nodes.length === 1 && d.selected === 0 && near(d.nodes[0].t - ut, pt.ahead, 60), 'click adds and selects a node there');
  ok(await page.locator('.map-node').isVisible(), 'node panel opens');
  ok(await page.locator('.map-handle').evaluateAll(els => els.filter(e => e.style.display !== 'none').length) === 6, 'six gizmo handles are shown');

  // ------------------------------------------------------------------ 4. drag the prograde handle
  const ap0 = d.chains[0].ap;
  const hb = await page.locator('.map-handle[data-axis="prograde"][data-sign="1"]').boundingBox();
  const node = d.nodeScreen[0];
  let hx = hb.x + hb.width / 2, hy = hb.y + hb.height / 2;
  let ux = hx - node.x, uy = hy - node.y; const ul = Math.hypot(ux, uy); ux /= ul; uy /= ul;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + ux * 5, hy + uy * 5);
  await page.waitForTimeout(400);
  const fine = (await dbg(page)).nodes[0].dv.prograde;
  await page.mouse.move(hx + ux * 70, hy + uy * 70, { steps: 6 });
  await page.waitForTimeout(1300);
  await shot(page, 'map-03-drag.png');
  await page.mouse.up();
  await page.waitForTimeout(500);
  d = await dbg(page);
  ok(fine >= 0 && fine < 0.5, 'a tiny pull changes dv slowly (fine control): ' + fine.toFixed(3) + ' m/s');
  ok(d.nodes[0].dv.prograde > 15 && d.nodes[0].dv.normal === 0 && d.nodes[0].dv.radial === 0, 'dragging the prograde handle outward raises prograde dv (' + d.nodes[0].dv.prograde.toFixed(1) + ' m/s)');
  ok(d.chains.length === 2 && d.chains[1] && d.chains[1].ap > ap0 + 10e3, 'the planned trajectory has a higher apoapsis (' + Math.round(ap0 / 1000) + ' → ' + Math.round((d.chains[1]?.ap || 0) / 1000) + ' km)');
  ok(d.labels.some(t => /^Ap .* km/.test(t) && !/^Ap 120\.0/.test(t)), 'planned Ap pill is shown: ' + d.labels.filter(t => /Ap /.test(t)).join(', '));
  const stable = d.nodes[0].dv.prograde;
  await page.waitForTimeout(300);
  ok((await dbg(page)).nodes[0].dv.prograde === stable, 'dv stops changing after release');

  // wheel over a handle nudges by 0.1 (Shift 1)
  const hb2 = await page.locator('.map-handle[data-axis="prograde"][data-sign="1"]').boundingBox();
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(150);
  d = await dbg(page);
  ok(near(d.nodes[0].dv.prograde - stable, 0.1, 0.002), 'wheel over the handle nudges +0.1 m/s (' + (d.nodes[0].dv.prograde - stable).toFixed(3) + ')');
  await page.keyboard.down('Shift'); await page.mouse.wheel(0, 100); await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  d = await dbg(page);
  ok(near(d.nodes[0].dv.prograde - stable, -0.9, 0.002), 'Shift+wheel nudges by 1 m/s (' + (d.nodes[0].dv.prograde - stable).toFixed(3) + ')');

  // panel: buttons and editable fields
  await page.locator('.map-dv-row:has-text("Normal") .sw-btn:has-text("+")').click();
  await page.locator('.map-num[data-axis="radial"]').fill('-12.5');
  await page.locator('.map-num[data-axis="radial"]').press('Enter');
  await page.waitForTimeout(250);
  d = await dbg(page);
  ok(d.nodes[0].dv.normal === 1 && d.nodes[0].dv.radial === -12.5, 'panel + button and numeric field edit dv (normal ' + d.nodes[0].dv.normal + ', radial ' + d.nodes[0].dv.radial + ')');
  const t0 = d.nodes[0].t;
  await page.locator('.map-node .sw-btn:has-text("+10s")').click();
  await page.locator('.map-node .sw-btn:has-text("−1s")').click();
  await page.locator('.map-node .sw-btn:has-text("+1 orbit")').click();
  await page.waitForTimeout(250);
  d = await dbg(page);
  const period = await page.evaluate(() => window.__world.active.getOrbit().period);
  ok(near(d.nodes[0].t - t0, 9 + period, 0.01), 'time buttons shift the node (+10 s, −1 s, +1 orbit)');
  await page.locator('.map-node .sw-btn:has-text("−1 orbit")').click();
  const total = await page.locator('.map-node-total .sw-value').innerText();
  const burn = await page.locator('.map-kv .sw-value').nth(1).innerText();
  ok(/m\/s/.test(total) && /s$/.test(burn), 'panel shows total dv (' + total + ') and burn time (' + burn + ')');
  await page.locator('.map-num[data-axis="radial"]').fill('0'); await page.locator('.map-num[data-axis="radial"]').press('Enter');
  await page.locator('.map-dv-row:has-text("Normal") .sw-btn:has-text("−")').click();
  await page.waitForTimeout(400);
  await shot(page, 'map-04-node.png');

  // ------------------------------------------------------------------ 5. drag the node along the orbit
  d = await dbg(page);
  const n0 = d.nodeScreen[0], tBefore = d.nodes[0].t;
  const utNow = await page.evaluate(() => window.__world.ut);
  let dest = null;
  for (const delta of [500, -350, 800, -200, 300]) {
    const p = await page.evaluate(t => window.__map.screenPointAtTime(t, 0), tBefore + delta);
    if (tBefore + delta > utNow + 60 && p && p.visible && p.x > 300 && p.x < 1140 && p.y > 90 && p.y < 800 && Math.hypot(p.x - n0.x, p.y - n0.y) > 30) { dest = { ...p, delta }; break; }
  }
  ok(!!dest, 'found a place to drag the node to');
  await page.mouse.move(n0.x, n0.y);
  await page.mouse.down();
  await page.mouse.move(dest.x, dest.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  d = await dbg(page);
  ok(near(d.nodes[0].t - tBefore, dest.delta, 80), 'dragging the node marker along the orbit changes its time (' + Math.round(d.nodes[0].t - tBefore) + ' s, wanted ' + dest.delta + ')');
  ok(d.nodes.length === 1, 'dragging does not add nodes');

  // ------------------------------------------------------------------ 6. a second node on the planned trajectory
  let p2 = null;
  // (a point in front of a body's disc belongs to the body, not to the trajectory: the map offers no ghost there)
  for (const ahead of [1500, 2200, 1000, 2900, 3600, 700, 1800, 2500, 3200, 400]) {
    const p = await page.evaluate(t => window.__map.screenPointAtTime(t), d.nodes[0].t + ahead);
    const clear = p && d.nodeScreen.every(n => Math.hypot(n.x - p.x, n.y - p.y) > 90) && Object.values(d.bodies).every(b => !b.visible || Math.hypot(b.x - p.x, b.y - p.y) > b.r + 12);
    const hit = p && await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id === 'gl', [p.x, p.y]);
    if (p && p.visible && clear && hit && p.x > 290 && p.x < 1150 && p.y > 80 && p.y < 820) { p2 = { ...p, ahead }; break; }
  }
  ok(!!p2, 'found a point on the planned (dashed) trajectory');
  await page.mouse.move(p2.x + 25, p2.y - 25);
  await page.mouse.move(p2.x + 1, p2.y + 1, { steps: 4 });
  await page.waitForTimeout(150);
  d = await waitDbg(page, s => !!s.hover, 3000);
  ok(d.hover && d.hover.chain === 1, 'the ghost appears on the post-burn trajectory (chain ' + (d.hover ? d.hover.chain : '—') + ')');
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(300);
  d = await dbg(page);
  ok(d.nodes.length === 2 && d.selected === 1 && d.nodes[1].t > d.nodes[0].t, 'second (chained) node added after the first');
  const hb3 = await page.locator('.map-handle[data-axis="prograde"][data-sign="-1"]').boundingBox();
  await page.mouse.move(hb3.x + hb3.width / 2, hb3.y + hb3.height / 2);
  for (let i = 0; i < 12; i++) { await page.keyboard.down('Shift'); await page.mouse.wheel(0, -100); await page.keyboard.up('Shift'); await page.waitForTimeout(40); }
  await page.waitForTimeout(500);
  d = await dbg(page);
  ok(near(d.nodes[1].dv.prograde, -12, 0.01), 'retrograde handle wheel: second node dv = ' + d.nodes[1].dv.prograde.toFixed(2));
  ok(d.chains.length === 3 && d.chains[2] && d.chains[2].pe < d.chains[1].pe - 1000, 'third chain reflects the second burn (Pe ' + Math.round(d.chains[1].pe / 1000) + ' → ' + Math.round((d.chains[2]?.pe || 0) / 1000) + ' km)');
  await page.mouse.move(720, 860);
  await page.waitForTimeout(300);
  await shot(page, 'map-05-two-nodes.png');

  // warp to node goes through world.warpTo
  await page.evaluate(() => { window.__world.warpTo = t => window.__world.log.push(['warpTo', t]); });   // record only
  await page.locator('.map-node .sw-btn:has-text("Warp to node")').click();
  const warp = await page.evaluate(() => window.__world.log.at(-1));
  ok(warp && warp[0] === 'warpTo' && warp[1] < d.nodes[1].t - 15 && warp[1] > d.nodes[1].t - 60, 'Warp to node calls world.warpTo(node.t − burn/2 − 15)');

  // pruneNodes is explicit
  ok(await page.evaluate(() => window.__map.pruneNodes()) === 0, 'pruneNodes() leaves future nodes alone');

  // Delete key removes the selected node
  await page.mouse.move(720, 860);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  d = await dbg(page);
  ok(d.nodes.length === 1 && d.selected === -1, 'Delete removes the selected node');
  ok(!(await page.locator('.map-node').isVisible()), 'node panel closes');

  // ------------------------------------------------------------------ 7. focus changes
  ok(await pressUntilFocus(page, 'pell'), 'Tab cycles focus to Pell');
  await settle(page, 1600);
  d = await dbg(page);
  ok(await page.locator('.map-body').innerText().then(t => /Pell/.test(t) && /Moon of Verda/i.test(t)), 'body panel follows the focus');
  await shot(page, 'map-06-pell.png');
  ok(await pressUntilFocus(page, 'helion', 'Shift+Tab'), 'Shift+Tab cycles back to Helion');
  await settle(page, 1800);
  d = await dbg(page);
  ok(d.dist > 1e11, 'Helion focus shows the whole system (camera at ' + (d.dist / 1e9).toFixed(0) + ' Gm)');
  // nine planets now: the giants and the home world are always named, crowded inner worlds may give way
  const planetNames = await page.evaluate(() => window.__SYSTEM.bodies.filter(b => b.type === 'planet').map(b => b.name));
  ok(['Helion', 'Verda', 'Thal', 'Orrin'].every(n => d.labels.includes(n)) && d.labels.filter(t => planetNames.includes(t)).length >= 5 && !d.labels.includes('Pell'),
    'planet labels visible, moons folded away: ' + d.labels.join(', '));
  await shot(page, 'map-07-system.png');
  await page.keyboard.press('Backquote');
  await settle(page, 1600);
  d = await dbg(page);
  ok(d.focus === 'Skylark II', 'backquote returns to the active vessel');

  // double-click a body to focus it: zoom out until Pell is on screen, then double-click its marker
  for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(110); }
  await settle(page, 700);
  await shot(page, 'map-08-verda-system.png');
  d = await dbg(page);
  const pellPos = d.bodies.pell.visible && d.labels.includes('Pell') ? d.bodies.pell : null;
  ok(!!pellPos, 'Pell label is on screen in the Verda-system view');
  if (pellPos) {
    await page.mouse.dblclick(pellPos.x, pellPos.y);
    await settle(page, 1500);
    d = await dbg(page);
    ok(d.focus === 'pell', 'double-clicking Pell focuses it (' + d.focus + ')');
    ok(d.nodes.length === 1, 'double-click does not add a node');
  }

  // the "Inner" preset: the star, framed for the home world and its neighbours
  await page.click('[data-map="inner"]');
  await settle(page, 1800);
  d = await waitDbg(page, s => s.focus === 'helion' && Math.abs(s.dist / s.distTarget - 1) < 0.02, 10000);   // the glide from a moon close-up takes a few seconds
  await settle(page, 500);
  d = await dbg(page);
  {
    const lim = await page.evaluate(() => { const S = window.__SYSTEM, star = S.bodies.find(b => b.type === 'star'); return { home: S.home.orbit.apoapsis, outer: Math.max(...star.children.map(c => c.orbit.apoapsis)) }; });
    ok(d.focus === 'helion' && d.dist > lim.home * 1.5 && d.dist < lim.outer * 1.2, 'Inner preset focuses the star at inner-system scale (' + (d.dist / 1e9).toFixed(0) + ' Gm)');
    ok(d.labels.includes('Verda'), 'the home world is named in the inner-system view');
  }
  await shot(page, 'map-08b-inner.png');

  // "Plan burn": the transfer panel asks the core planner for the burn to the selected moon and adds the node
  await page.keyboard.press('Backquote');
  await settle(page, 1200);
  await page.evaluate(() => window.__map.select(window.__SYSTEM.byId.pell));
  await settle(page, 700);
  ok(await page.locator('[data-map="transfer-panel"]').isVisible() && await page.locator('[data-map="plan-transfer"]').isVisible(), 'transfer panel offers "Plan burn" for a moon of the body being orbited');
  {
    const before = (await dbg(page)).nodes.length;
    await page.click('[data-map="plan-transfer"]');
    await page.waitForFunction(n => window.__map.debug().nodes.length > n, before, { timeout: 60000 }).catch(() => {});
    await settle(page, 900);
    d = await dbg(page);
    const added = d.nodes.length === before + 1, sel = d.selected >= 0 ? d.nodes[d.selected] : null;
    ok(added && sel && sel.dv.prograde > 500 && sel.dv.prograde < 1500, 'Plan burn adds and selects a prograde node (' + (sel ? sel.dv.prograde.toFixed(0) : '?') + ' m/s)');
    ok(d.chains.some(c => c && c.patches.some(pt => pt.body === 'pell')), 'the planned trajectory meets Pell');
    await shot(page, 'map-08c-planned.png');
    // put things back as the following checks expect them: one node, nothing selected
    await page.evaluate(t => { const m = window.__map, v = window.__world.active; m.selectNode(null); m.select(null); const i = v.nodes.findIndex(n => Math.abs(n.t - t) < 1e-6); if (i >= 0) v.nodes.splice(i, 1); }, sel ? sel.t : -1);
    await settle(page, 400);
  }

  // exit / enter clean-up
  const left = await page.evaluate(() => { window.__map.exit(); return { root: !!document.querySelector('.map-root'), open: window.__map.isOpen }; });
  ok(!left.root && !left.open, 'exit() removes the map DOM');
  await page.evaluate(() => window.__map.enter());
  await settle(page, 400);
  ok((await dbg(page)).open && await page.locator('.map-root').count() === 1, 'enter() restores it');
  await ctx.close();

  // ------------------------------------------------------------------ 8. Pell transfer vessel: encounter markers
  console.log('encounter trajectory');
  {
    const { ctx, page } = await open('?active=runner');
    let d = await dbg(page);
    const pats = d.chains[0]?.patches || [];
    ok(pats.length >= 3 && pats[0].end === 'enter' && pats[0].next === 'pell' && pats[1].body === 'pell' && pats[1].end === 'exit', 'patches: ' + pats.map(p => p.body + ':' + p.end).join(' → '));
    ok(d.labels.some(t => /^Enter Pell SOI in /.test(t)), 'SOI entry marker: ' + d.labels.find(t => /Enter Pell/.test(t)));
    await shot(page, 'map-09-transfer.png');
    await page.evaluate(() => window.__map.focus('pell'));
    await settle(page, 1500);
    for (let i = 0; i < 9; i++) { await page.mouse.move(720, 500); await page.mouse.wheel(0, 120); await page.waitForTimeout(110); }
    await settle(page, 700);
    d = await dbg(page);
    ok(d.labels.some(t => /^Pell Pe \d/.test(t)), 'closest-approach pill at Pell: ' + d.labels.filter(t => /Pell/.test(t)).join(', '));
    await shot(page, 'map-10-pell-flyby.png');
    await ctx.close();
  }

  // ------------------------------------------------------------------ 9. Retina-like rendering
  console.log('deviceScaleFactor 2');
  {
    const { ctx, page } = await open('', { dsf: 2 });
    const d = await dbg(page);
    const size = await page.evaluate(() => { const c = document.querySelector('.map-canvas'); return [c.width, c.height]; });
    ok(size[0] === 2880 && size[1] === 1800, 'overlay canvas is rendered at 2× (' + size.join('×') + ')');
    ok(d.labels.some(t => /^Ap /.test(t)), 'markers present at 2×');
    await shot(page, 'map-11-retina.png');
    await ctx.close();
  }

  // ------------------------------------------------------------------ 10. browse-only mode (tracking station)
  console.log('browse-only mode');
  {
    const { ctx, page } = await open('?tracking=1');
    const d = await dbg(page);
    ok(d.open && d.focusIsBody && d.nodes.length === 0, 'opens on a body when there is no active vessel (' + d.focus + ')');
    await page.mouse.move(720, 450); await page.mouse.down(); await page.mouse.up();
    ok((await dbg(page)).nodes.length === 0, 'no node editing without an active vessel');
    await shot(page, 'map-12-browse.png');
    await ctx.close();
  }

  // ------------------------------------------------------------------ 11. tracking station screen
  console.log('tracking station');
  {
    const { ctx, page } = await open('?screen=tracking');
    ok(await page.locator('[data-trk="empty"]').innerText().then(t => /No flights in progress/.test(t)), 'empty state: "No flights in progress"');
    let d = await dbg(page);
    ok(d.open && d.focusIsBody, 'the system map is still browsable (focus ' + d.focus + ')');
    await page.mouse.move(900, 500);
    const dist0 = d.dist;
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(120); }
    await settle(page, 400);
    ok((await dbg(page)).dist > dist0 * 1.5, 'zoom works in the empty station');
    await shot(page, 'map-13-tracking-empty.png');
    await page.locator('.trk-side [data-action="back"]').click();
    ok(await page.evaluate(() => window.__calls.some(c => c[0] === 'goto' && c[1] === 'hub')), 'Back to hub → app.goto("hub")');
    await ctx.close();
  }
  {
    const { ctx, page } = await open('?screen=tracking&flights=1&tracking=1');
    const names = await page.locator('.trk-item .trk-name').allInnerTexts();
    ok(names.length === 5 && names.includes('Skylark II') && names.includes('Skylark II booster'), 'lists the vessels: ' + names.join(', '));
    ok(await page.locator('.trk-item[data-vessel] [data-action]').count() === 0, 'rows are compact: the actions live on the detail card');
    ok(await page.locator('.trk-item[data-vessel="1"] .trk-sub').innerText().then(t => /Orbiting Verda/.test(t) && /Wren, Odo/.test(t)), 'rows show situation, body and crew');
    await page.locator('.trk-item[data-vessel="2"]').click();
    await settle(page, 1500);
    let d = await dbg(page);
    ok(d.focus === 'Pell Runner' && d.chains[0] && d.chains[0].patches.length >= 2, 'selecting a vessel focuses it and shows its trajectory');
    await shot(page, 'map-14-tracking.png');
    ok(await page.locator('[data-trk="detail"]').innerText().then(t => /Pell Runner/.test(t) && /Apoapsis|Periapsis/.test(t)), 'the detail card describes the selected vessel');
    await page.locator('[data-trk="detail"] [data-action="fly"]').click();
    ok(await page.evaluate(() => { const c = window.__calls.find(c => c[0] === 'goto' && c[1] === 'flight'); return c && c[2].resume === true && c[2].vesselId === 2; }), 'Fly → app.goto("flight", {resume: true, vesselId})');
    await page.locator('.trk-item[data-vessel="3"]').click();
    await page.locator('[data-trk="detail"] [data-action="terminate"]').click();
    await page.locator('.sw-modal .sw-btn:has-text("Cancel")').click();
    await page.waitForTimeout(400);
    ok(await page.locator('.trk-item[data-vessel]').count() === 5, 'cancelling the confirmation keeps the vessel');
    await page.locator('.trk-item[data-vessel="1"]').click();
    await page.locator('[data-trk="detail"] [data-action="terminate"]').click();
    await page.locator('.sw-modal .sw-btn:has-text("Terminate")').click();
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ n: window.__world.vessels.length, calls: window.__calls, state: window.__app.career.flightState }));
    ok(after.n === 4 && await page.locator('.trk-item[data-vessel]').count() === 4, 'Terminate removes the vessel from the world and the list');
    ok(after.calls.some(c => c[0] === 'save') && after.state && after.state.vessels.length === 4 && !after.state.vessels.includes(1), 'the world is saved back to career.flightState');
    ok(after.calls.some(c => c[0] === 'releaseCrew' && c[1].join() === 'Wren,Odo'), 'crew are returned to the roster');
    const gone = await page.evaluate(() => { window.__screen.exit(); return !document.querySelector('.map-root') && !document.querySelector('.trk-root'); });
    ok(gone, 'exit() removes the tracking DOM and the map');
    await ctx.close();
  }

  // ------------------------------------------------------------------ 12. targeting + closest approach
  console.log('targeting');
  {
    const { ctx, page } = await open('?target=1');
    let d = await dbg(page);
    ok(d.target === null && d.approaches.length === 0 && !(await page.locator('.map-target').isVisible()), 'no target at first');
    // zoom out a little so the whole orbit and the station are on screen
    await page.mouse.move(720, 620);
    for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(130); }
    let st = null;
    for (let i = 0; i < 40 && !st; i++) {               // wait until the station is on the near side
      await page.waitForTimeout(250);
      d = await dbg(page);
      const s = d.vessels.find(v => v.name === 'Harbor Station');
      const hit = s && await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id === 'gl', [s.x, s.y]);
      if (s && hit && s.x > 290 && s.x < 1150 && s.y > 80 && s.y < 820) st = s;
      else if (i % 8 === 7) { await page.mouse.down({ button: 'right' }); await page.mouse.move(820, 620, { steps: 4 }); await page.mouse.up({ button: 'right' }); await page.mouse.move(720, 620); }
    }
    ok(!!st, 'the station marker is on screen');
    await page.mouse.move(st.x, st.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300);
    d = await dbg(page);
    ok(d.selection && d.selection.name === 'Harbor Station' && d.nodes.length === 0, 'clicking a vessel marker selects it (no node added)');
    ok(await page.locator('.map-sel').innerText().then(t => /Harbor Station/.test(t) && /Verda/.test(t) && /away/.test(t)), 'selection panel describes it');
    await page.locator('[data-map="set-target"]').click();
    await page.waitForTimeout(1300);
    d = await dbg(page);
    ok(d.target && d.target.kind === 'vessel' && d.target.name === 'Harbor Station' && await page.evaluate(() => window.__world.active.targetId) === 6, '"Set as target" → world.setTarget(active, vessel)');
    ok(await page.locator('[data-map="set-target"]').innerText() === 'Targeted' && await page.locator('[data-map="set-target"]').isDisabled(), 'the button shows "Targeted"');
    ok(d.approaches.length >= 1 && d.approaches.length <= 2 && d.approaches.every(a => a.chain === 0) && d.approaches[0].rank === 0 && d.approaches[0].distance < 60e3 && d.approaches[0].t > await page.evaluate(() => window.__world.ut),
      'closest approach on the current orbit: ' + (d.approaches[0] ? (d.approaches[0].distance / 1000).toFixed(2) + ' km, ' + d.approaches[0].relSpeed.toFixed(1) + ' m/s' : 'none'));
    const caLabel = d.labels.find(t => /^Closest approach /.test(t));
    ok(d.approaches[0]?.visible ? /^Closest approach [\d.,]+ k?m · [\d.,]+ m\/s in \d/.test(caLabel || '') : true, 'closest-approach pill: ' + caLabel);
    const tgtOk = t => /Harbor Station/.test(t) && /Distance/i.test(t) && /Rel\. speed/i.test(t) && /Rel\. incl/i.test(t) && /speed\s+[\d.,]+ m\/s/i.test(t) && /km in \d/.test(t);
    let tgtTxt = '';
    for (let i = 0; i < 40; i++) { tgtTxt = await page.locator('.map-target').innerText(); if (tgtOk(tgtTxt)) break; await page.waitForTimeout(150); }   // the panel refreshes a few times a second
    ok(tgtOk(tgtTxt), 'target panel shows distance, relative speed, relative inclination and closest approach: ' + tgtTxt.replace(/\s+/g, ' ').slice(0, 150));
    await page.mouse.move(720, 860);
    await page.waitForTimeout(200);
    await shot(page, 'map-15-target.png');

    // a planned burn gets its own marker
    const ca0 = d.approaches[0].distance;
    await page.evaluate(() => { const w = window.__world; w.active.nodes.push({ t: w.ut + 600, dv: { prograde: 9, normal: 0, radial: 0 } }); });
    await page.waitForTimeout(1500);
    d = await dbg(page);
    ok(d.approaches.some(a => a.chain === 1) && d.approaches.find(a => a.chain === 1).distance !== ca0, 'the planned trajectory has its own closest approach (' +
      d.approaches.map(a => 'chain ' + a.chain + ': ' + (a.distance / 1000).toFixed(2) + ' km').join(', ') + ')');
    ok(d.approaches.filter(a => a.visible).length >= d.labels.filter(t => /^(Closest|2nd) approach /.test(t)).length && d.labels.some(t => /^Closest approach /.test(t)), 'approach pills: ' + d.labels.filter(t => /^(Closest|2nd) approach /.test(t)).join(' | '));
    ok(await page.locator('.map-target').innerText().then(t => /After burn/i.test(t)), 'target panel adds the "After burn" row');
    await shot(page, 'map-16-target-plan.png');
    await page.evaluate(() => { window.__world.active.nodes.length = 0; });

    // clear
    await page.locator('[data-map="clear-target"]').click();
    await page.waitForTimeout(400);
    d = await dbg(page);
    ok(d.target === null && d.approaches.length === 0 && !d.labels.some(t => /approach/.test(t)) && !(await page.locator('.map-target').isVisible()), '"Clear target" drops the target and its markers');
    ok(await page.locator('[data-map="set-target"]').innerText() === 'Set as target', 'the selection can be targeted again');

    // body target: click Pell's marker in the Verda-system view
    await page.mouse.move(720, 620);
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(110); }
    await settle(page, 800);
    d = await dbg(page);
    ok(d.bodies.pell.visible, 'Pell is on screen');
    await page.mouse.move(d.bodies.pell.x, d.bodies.pell.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300);
    d = await dbg(page);
    ok(d.selection && d.selection.kind === 'body' && d.selection.id === 'pell', 'clicking a body marker selects it');
    await page.locator('[data-map="set-target"]').click();
    await page.waitForTimeout(1300);
    d = await dbg(page);
    ok(d.target && d.target.kind === 'body' && d.target.id === 'pell' && await page.evaluate(() => window.__world.active.targetId) === 'pell', 'a moon can be targeted');
    ok(d.approaches.length >= 1 && d.approaches[0].rank === 0 && d.approaches[0].distance > 1e6, 'no encounter → closest approach to Pell (' + (d.approaches[0] ? (d.approaches[0].distance / 1e6).toFixed(2) + ' Mm' : 'none') + ')');
    await page.mouse.move(720, 860);
    await page.waitForTimeout(200);
    await shot(page, 'map-17-target-moon.png');
    await page.mouse.move(400, 760); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300);
    d = await dbg(page);
    ok(d.selection === null && d.target && d.target.id === 'pell', 'clicking empty space deselects but keeps the target');
    await ctx.close();
  }
  {
    const { ctx, page } = await open('?active=runner');
    await page.evaluate(() => window.__world.setTarget(window.__world.active, 'pell'));
    await page.waitForTimeout(1300);
    const d = await dbg(page);
    ok(d.target && d.target.id === 'pell' && d.approaches.length === 0 && d.labels.some(t => /^Enter Pell SOI/.test(t)), 'with an encounter the SOI markers are used instead of a closest-approach marker');
    await ctx.close();
  }
  // ------------------------------------------------------------------ 13. marker hover / pin, hover cards, AN / DN, transfer helper
  console.log('markers, hover cards, planning aids');
  {
    const { ctx, page } = await open('?target=1');
    const clear = (page, x, y) => page.evaluate(([x, y]) => x > 300 && x < innerWidth - 300 && y > 90 && y < innerHeight - 110 && document.elementFromPoint(x, y)?.id === 'gl', [x, y]);
    let d = await dbg(page);
    ok(d.vessels.length >= 2 && d.vessels.every(v => typeof v.role === 'string' && v.role.length > 0), 'every vessel is drawn with a type icon: ' + d.vessels.map(v => v.name + '=' + v.role).join(', '));
    ok(d.vessels.find(v => v.name === 'Harbor Station')?.role === 'station', 'the station is typed as a station');

    // Ap / Pe marker: hover expands it with the time-to, right-click pins it
    await page.evaluate(() => window.__map.setView({ dist: 3.4e6, yaw: 0.3, pitch: 1.05 }));
    await settle(page, 500);
    d = await dbg(page);
    let mk = null;
    for (const m of d.markers) if (/:(ap|pe)$/.test(m.key) && await clear(page, m.x, m.y)) { mk = m; break; }
    ok(!!mk, 'an Ap / Pe marker is on screen (' + d.markers.map(m => m.key).join(', ') + ')');
    if (mk) {
      const short = d.labels.find(t => /^(Ap|Pe) /.test(t) && !/ · /.test(t));
      ok(!!short, 'at rest the pill shows only the altitude: ' + short);
      await page.mouse.move(mk.x + 1, mk.y + 1);
      d = await waitDbg(page, d => d.hoverMarker === mk.key && d.labels.some(t => /^(Ap|Pe) .* · /.test(t)));
      ok(d.hoverMarker === mk.key && d.labels.some(t => /^(Ap|Pe) [\d.,]+ k?m · /.test(t)), 'hovering a marker adds the time to it: ' + d.labels.find(t => /^(Ap|Pe) .* · /.test(t)));
      const yawBefore = d.yaw;
      await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(200);
      d = await dbg(page);
      ok(d.pinned.includes(mk.key) && d.yaw === yawBefore, 'right-click (no drag) pins the marker');
      await page.mouse.move(720, 860);
      await page.waitForTimeout(300);
      d = await dbg(page);
      ok(d.hoverMarker !== mk.key && d.labels.some(t => /^(Ap|Pe) [\d.,]+ k?m · /.test(t)), 'a pinned marker keeps its details after the mouse leaves');
      await shot(page, 'map-18-pinned.png');
      const again = d.markers.find(m => m.key === mk.key);
      await page.mouse.move(again.x + 1, again.y + 1);
      await page.waitForTimeout(250);
      await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(200);
      d = await dbg(page);
      ok(!d.pinned.includes(mk.key), 'right-click again unpins it');
    }

    // hover card on a vessel and on a body
    let st = null;
    for (let i = 0; i < 40 && !st; i++) {
      d = await dbg(page);
      const s = d.vessels.find(v => v.name === 'Harbor Station');
      if (s && await clear(page, s.x, s.y)) st = s; else await page.waitForTimeout(250);
    }
    ok(!!st, 'the station marker is on screen');
    if (st) {
      await page.mouse.move(st.x + 1, st.y + 1);
      await page.waitForTimeout(500);
      d = await dbg(page);
      const card = page.locator('.map-card');
      ok(!!d.card && await card.isVisible() && await card.innerText().then(t => /Harbor Station/.test(t) && /Station/i.test(t) && /Verda/.test(t)), 'hovering a vessel shows its card: ' + (await card.innerText()).replace(/\s+/g, ' ').slice(0, 90));
      await shot(page, 'map-19-card.png');
      await page.mouse.move(720, 860);
      await page.waitForTimeout(400);
      ok(!(await card.isVisible()), 'the card goes away with the mouse');
    }
    await page.evaluate(() => window.__map.setView({ dist: 4.2e7, yaw: 0.3, pitch: 0.9 }));
    await settle(page, 600);
    d = await dbg(page);
    ok(d.bodies.pell.visible, 'Pell is on screen in the wide view');
    await page.mouse.move(d.bodies.pell.x + 1, d.bodies.pell.y + 1);
    await page.waitForTimeout(500);
    ok(await page.locator('.map-card').innerText().then(t => /Pell/.test(t) && /Moon/i.test(t)).catch(() => false), 'hovering a body shows its card');
    await page.mouse.move(720, 860);

    // relative nodes against a vessel target
    await page.evaluate(() => { const w = window.__world; w.setTarget(w.active, 6); window.__map.setView({ dist: 3.6e6, yaw: 0.2, pitch: 0.75 }); });
    await page.waitForTimeout(1500);
    d = await waitDbg(page, d => d.relNodes.length >= 2 && d.labels.some(t => /^(AN|DN) /.test(t)));
    const kinds = d.relNodes.filter(n => n.chain === 0).map(n => n.kind).sort().join();
    ok(kinds === 'an,dn' && d.relInc > 0 && d.relInc < Math.PI / 2, 'ascending and descending nodes against the target (relative inclination ' + (d.relInc * 180 / Math.PI).toFixed(2) + '°)');
    ok(d.relNodes.filter(n => n.visible).length <= d.labels.filter(t => /^(AN|DN) [\d.]+°/.test(t)).length + 1 && d.labels.some(t => /^(AN|DN) [\d.]+°/.test(t)), 'AN / DN pills: ' + d.labels.filter(t => /^(AN|DN) /.test(t)).join(' | '));
    const tgtText = (await page.locator('.map-target').innerText()).replace(/\s+/g, ' ');
    ok(/Rel\. incl\.? ?[\d.]+°/i.test(tgtText), 'the target panel shows the relative inclination: ' + tgtText.slice(0, 140));
    ok(d.approaches.filter(a => a.chain === 0).map(a => a.rank).join() === (d.approaches.filter(a => a.chain === 0).length === 2 ? '0,1' : '0'), 'approaches are ranked: ' + d.approaches.map(a => 'rank ' + a.rank + ' ' + (a.distance / 1000).toFixed(1) + ' km').join(', '));

    // transfer window helper against a moon
    await page.evaluate(() => { const w = window.__world; w.setTarget(w.active, 'pell'); window.__map.setView({ dist: 4.2e7, yaw: 0.3, pitch: 0.9 }); });
    await page.waitForTimeout(1500);
    d = await dbg(page);
    const tr = d.transfer;
    ok(tr && tr.kind === 'moon' && tr.to === 'Pell' && tr.from === 'Skylark II' && tr.timeToWindow > 0 && tr.transferTime > 3600 && tr.ejectDv > 500 && tr.ejectDv < 1500,
      'transfer helper: ' + (tr ? 'phase ' + (tr.phaseNow * 180 / Math.PI).toFixed(0) + '° now, ' + (tr.phaseNeeded * 180 / Math.PI).toFixed(0) + '° needed, window in ' + Math.round(tr.timeToWindow) + ' s, ' + tr.ejectDv.toFixed(0) + ' m/s' : 'none'));
    const panel = page.locator('.map-transfer');
    ok(await panel.isVisible() && await panel.innerText().then(t => /Pell/.test(t) && /°/.test(t) && /m\/s/.test(t)), 'the transfer panel is shown: ' + (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 120));
    await shot(page, 'map-20-transfer-window.png');
    const utW = await page.evaluate(() => { const w = window.__world; w.warpTo = t => w.log.push(['warpTo', t]); return w.ut; });
    await page.locator('[data-map="warp-window"]').click();
    const call = await page.evaluate(() => window.__world.log.at(-1));
    ok(call && call[0] === 'warpTo' && near(call[1] - utW, tr.timeToWindow - 90, 30), '"Warp to window" → world.warpTo(just before the window)');
    await page.locator('[data-map="clear-target"]').click();
    await page.waitForTimeout(400);
    ok((await dbg(page)).transfer === null && !(await panel.isVisible()), 'the transfer panel goes away with the target');

    // camera helpers used by the preview tour and by other screens
    const sd = await page.evaluate(() => { const m = window.__map; m.focus('thal', { instant: true }); const s = m.systemDist(window.__SYSTEM.byId.thal); m.setView({ dist: s, yaw: 1, pitch: 0.4 }); return { s, d: m.debug() }; });
    ok(sd.d.focus === 'thal' && near(sd.d.dist / sd.s, 1, 1e-6) && sd.d.yaw === 1 && near(sd.d.pitch, 0.4, 1e-9), 'setView() / systemDist() frame a planet with its moons (' + (sd.s / 1e6).toFixed(0) + ' Mm)');
    await settle(page, 900);
    d = await dbg(page);
    const moons = await page.evaluate(() => window.__SYSTEM.byId.thal.children.map(m => m.id));
    ok(moons.length >= 2 && moons.every(id => d.bodies[id] && d.bodies[id].x > -50 && d.bodies[id].x < 1490 && d.bodies[id].y > -50 && d.bodies[id].y < 950), 'all ' + moons.length + ' moons of Thal fit in the system view');
    await ctx.close();
  }

  // ------------------------------------------------------------------ 14. a crowded system stays readable
  console.log('crowded system');
  {
    const { ctx, page } = await open('?scene=fleet');
    await page.evaluate(() => { window.__map.focus('helion', { instant: true }); window.__map.setView({ yaw: 0.5, pitch: 0.62 }); });
    await settle(page, 1500);
    const d = await dbg(page);
    const info = await page.evaluate(() => {
      const pills = [...document.querySelectorAll('.map-label')].filter(e => e.style.display !== 'none' && e.offsetWidth > 0).map(e => e.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 0; i < pills.length; i++) for (let j = i + 1; j < pills.length; j++) {
        const a = pills[i], b = pills[j];
        if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2) overlaps++;
      }
      return { pills: pills.length, overlaps, bodies: window.__SYSTEM.bodies.length, vessels: window.__world.vessels.length, ms: window.__frameMs };
    });
    ok(info.bodies >= 16 && info.vessels >= 24, 'the fleet scene has ' + info.bodies + ' bodies and ' + info.vessels + ' vessels');
    ok(d.labels.includes('Helion') && d.labels.filter(t => ['Thal', 'Orrin', 'Quell', 'Wend'].includes(t)).length >= 3, 'outer planets are labelled in the whole-system view: ' + d.labels.join(', '));
    ok(info.pills > 0 && info.overlaps === 0, 'no two labels overlap (' + info.pills + ' shown)');
    ok(!info.ms || info.ms.avg < 12, 'map frame cost with the fleet: ' + (info.ms ? info.ms.avg.toFixed(1) + ' ms avg' : 'n/a'));
    await ctx.close();
  }

  // ------------------------------------------------------------------ 15. tracking station: filters, worlds, rename, re-type
  console.log('tracking station tools');
  {
    const { ctx, page } = await open('?screen=tracking&flights=1&tracking=1');
    const rows = () => page.locator('.trk-item[data-vessel] .trk-name').allInnerTexts();
    await page.locator('.trk-filter[data-filter="debris"]').click();
    await page.waitForTimeout(200);
    let names = await rows();
    ok(names.length === 4 && !names.includes('Skylark II booster'), 'the debris filter hides debris: ' + names.join(', '));
    await page.locator('.trk-filter[data-filter="all"]').click();
    await page.waitForTimeout(200);
    ok((await rows()).length === 5, '"All" shows everything again');

    await page.locator('.trk-item[data-vessel="1"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-trk="detail"] [data-action="rename"]').click();
    await page.locator('[data-trk="rename-field"]').fill('Skylark Prime');
    await page.locator('[data-trk="rename-field"]').press('Enter');
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => window.__world.vessels.find(v => v.id === 1).name) === 'Skylark Prime' && (await rows()).includes('Skylark Prime'), 'rename changes the vessel and its row');
    const saves = await page.evaluate(() => window.__calls.filter(c => c[0] === 'save').length);
    ok(saves >= 1, 'renaming saves the game');
    await page.locator('[data-trk="detail"] .trk-role[data-role="station"]').click();
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => window.__world.vessels.find(v => v.id === 1).role) === 'station', 're-typing sets vessel.role');
    ok((await dbg(page)).vessels.find(v => v.id === 1)?.role === 'station', 'the map icon follows the new type');
    await page.locator('.trk-filter[data-filter="station"]').click();
    await page.waitForTimeout(200);
    ok(!(await rows()).includes('Skylark Prime'), 'the type filter uses the new type');
    await page.locator('.trk-filter[data-filter="all"]').click();

    await page.locator('.trk-tab[data-tab="worlds"]').click();
    await page.waitForTimeout(300);
    const nBodies = await page.evaluate(() => window.__SYSTEM.bodies.length);
    ok(await page.locator('.trk-item.body[data-body]').count() === nBodies, 'the Worlds tab lists all ' + nBodies + ' bodies');
    await page.locator('.trk-item[data-body="rusk"]').click();
    await settle(page, 1600);
    let d = await dbg(page);
    ok(d.focus === 'rusk' && await page.locator('.map-body').innerText().then(t => /Rusk/.test(t) && /Gravity/i.test(t) && /Radius/i.test(t)), 'picking a world focuses it and fills the body panel');
    await shot(page, 'map-21-tracking-worlds.png');
    await page.locator('.trk-tab[data-tab="vessels"]').click();
    await page.waitForTimeout(200);
    ok((await rows()).length === 5, 'back on the Flights tab');
    await ctx.close();
  }

  // ------------------------------------------------------------------ 16. tracking station on a real world: warp, alarms, recover
  console.log('tracking station (real world): warp, alarms, recovery');
  {
    const { ctx, page } = await open('?screen=tracking&real=1');
    const st = () => page.evaluate(() => { const w = window.__real; return { ut: w.ut, warp: w.warpIndex, n: w.vessels.length, toasts: window.__toasts.map(String) }; });
    let s0 = await st();
    ok(s0.n >= 7 && await page.locator('.trk-item[data-vessel]').count() === s0.n, 'the saved flight is loaded: ' + s0.n + ' objects');
    const nodeT = await page.evaluate(() => window.__real.vessels.find(v => v.name === 'Skylark II').nodes[0].t);
    for (let i = 0; i < 4; i++) { await page.locator('[data-trk="warp"] [data-action="warp-up"]').click(); await page.waitForTimeout(60); }
    let s1 = await st();
    ok(s1.warp >= 3 && /×/.test(await page.locator('[data-trk="rate"]').innerText()), 'the warp strip raises the rate (' + (await page.locator('[data-trk="rate"]').innerText()) + ')');
    for (let i = 0; i < 4; i++) { await page.locator('[data-trk="warp"] [data-action="warp-up"]').click(); await page.waitForTimeout(60); }   // 1,000×
    let s2 = await st();
    for (let i = 0; i < 240 && s2.warp > 0; i++) { await page.waitForTimeout(250); s2 = await st(); }
    ok(s2.warp === 0 && s2.ut > s0.ut + 600 && s2.ut <= nodeT - 30 && s2.ut >= nodeT - 120, 'warp stops by itself before the maneuver (' + Math.round(nodeT - s2.ut) + ' s before the node)');
    ok(s2.toasts.some(t => /Warp stopped/.test(t) && /Skylark II/.test(t)), 'and says why: ' + s2.toasts.find(t => /Warp stopped/.test(t)));
    // drop the node: the next alarm is the Pell Runner reaching Pell's sphere of influence
    await page.evaluate(() => { window.__real.vessels.find(v => v.name === 'Skylark II').nodes.length = 0; window.__toasts.length = 0; });
    for (let i = 0; i < 9; i++) { await page.locator('[data-trk="warp"] [data-action="warp-up"]').click(); await page.waitForTimeout(60); }   // 10,000×
    let s3 = await st();
    ok(s3.warp >= 8, 'warp again (index ' + s3.warp + ')');
    for (let i = 0; i < 400 && s3.warp > 0; i++) { await page.waitForTimeout(250); s3 = await st(); }
    const runner = await page.evaluate(() => { const v = window.__real.vessels.find(v => v.name === 'Pell Runner'); return v ? v.body.id : null; });
    ok(s3.warp === 0 && runner === 'pell' && s3.toasts.some(t => /Warp stopped/.test(t) && /Pell/.test(t)), 'warp stops when a craft changes sphere of influence: ' + s3.toasts.find(t => /Warp stopped/.test(t)));
    await page.locator('[data-trk="warp"] [data-action="warp-up"]').click();
    await page.waitForTimeout(150);
    await page.locator('[data-trk="warp"] [data-action="warp-stop"]').click();
    await page.waitForTimeout(150);
    ok((await st()).warp === 0, 'the stop button drops to ×1');

    // recover the capsule that is down on the home world
    const sounder = await page.evaluate(() => window.__real.vessels.find(v => v.name === 'Mote Sounder').id);
    await page.locator('.trk-item[data-vessel="' + sounder + '"]').click();
    await page.waitForTimeout(400);
    const funds0 = await page.evaluate(() => window.__app.career.funds);
    const rec = page.locator('[data-trk="detail"] [data-action="recover"]');
    ok(await rec.isEnabled(), 'Recover is offered for a craft landed on the home world');
    await page.locator('.trk-item[data-vessel]').first().click();
    await page.waitForTimeout(300);
    const firstId = await page.locator('.trk-item[data-vessel]').first().getAttribute('data-vessel');
    if (String(firstId) !== String(sounder)) ok(!(await rec.isEnabled().catch(() => false)), 'Recover is not offered for a craft in orbit');
    await page.locator('.trk-item[data-vessel="' + sounder + '"]').click();
    await page.waitForTimeout(300);
    await rec.click();
    await page.waitForTimeout(300);
    const modalBtn = page.locator('.sw-modal .sw-btn:has-text("Recover")');
    if (await modalBtn.count()) await modalBtn.click();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({ n: window.__real.vessels.length, funds: window.__app.career.funds, saved: !!window.__app.career.flightState, kept: window.__app.career.flightState ? window.__app.career.flightState.vessels.length : 0, sel: window.__screen.selected ? window.__screen.selected.name : null, toasts: window.__toasts.map(String) }));
    ok(after.n === s0.n - 1 && await page.locator('.trk-item[data-vessel="' + sounder + '"]').count() === 0, 'Recover removes the craft from the world and the list');
    ok(after.funds > funds0 && after.toasts.some(t => /recovered/.test(t)), 'the craft value is credited (' + Math.round(after.funds - funds0) + ' funds): ' + after.toasts.find(t => /recovered/.test(t)));
    ok(after.saved && after.kept === after.n && !!after.sel, 'the flight is saved and another object is selected (' + after.sel + ')');
    await shot(page, 'map-22-tracking-real.png');
    await ctx.close();
  }
} catch (err) {
  problems.push('test crashed: ' + (err.stack || err.message));
} finally {
  await browser.close();
  await server.close();
}

console.log('\n' + checks + ' checks, ' + problems.length + ' problem(s)');
for (const p of problems) console.log(' - ' + p);
process.exit(problems.length ? 1 : 0);
