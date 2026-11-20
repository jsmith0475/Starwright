// End-to-end test of the Starwright shell: title, new game flows, the 3D Flight Center hub (hover name plates,
// click-to-enter, camera, keyboard path, no-WebGL fallback), research, missions, crew, input.
//   node tests/e2e/shell.mjs            (screenshots land in tests/out/)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });

const OPTIONAL = /\/js\/ui\/(flight|builder|tracking)\.js$/;   // screens other modules provide; may be missing
const problems = [];
const foreign = [];          // errors raised while a screen owned by another module (builder/flight/tracking) is showing
let inForeign = false;
const STRICT = process.env.STRICT === '1';
const report = text => ((inForeign && !STRICT) ? foreign : problems).push(text);
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });

async function newPage(width, height, deviceScaleFactor = 1) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
  const page = await ctx.newPage();
  const missing = new Set();
  page.on('response', r => { if (r.status() === 404 && OPTIONAL.test(new URL(r.url()).pathname)) missing.add(r.url()); });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url || '';
    if (/status of 404/.test(m.text()) && OPTIONAL.test(loc ? new URL(loc).pathname : '')) return;
    report('console error: ' + m.text() + (loc ? ' @ ' + loc : ''));
  });
  page.on('pageerror', e => report('page error: ' + (e.stack || e.message)));
  page.on('requestfailed', r => { if (!/^data:/.test(r.url())) report('request failed: ' + r.url()); });
  page.on('request', r => { const u = r.url(); if (!u.startsWith(server.url) && !/^(data|blob):/.test(u)) problems.push('external request: ' + u); });
  return { ctx, page, missing };
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
const screenName = page => page.evaluate(() => window.__sw.app.currentName);
async function waitScreen(page, name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name, { timeout: 60000 });   // generous: the suite shares a busy machine with a software rasteriser
  await page.waitForTimeout(350);
}
async function boot(page) {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await waitScreen(page, 'title');
}
async function closeModal(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sw-modal-backdrop:not(.closing)'));
  await page.waitForTimeout(200);
}
async function newGame(page, mode, { replace = false } = {}) {
  await page.click('[data-action="new"]');
  await page.waitForSelector('.sw-mode[data-mode="' + mode + '"]');
  await page.click('.sw-mode[data-mode="' + mode + '"]');
  await page.click('.sw-modal .sw-btn.primary');
  if (replace) { await page.waitForSelector('.sw-modal .sw-btn.danger'); await page.click('.sw-modal .sw-btn.danger'); }
  await waitScreen(page, 'hub');
}
async function backToHub(page) { await page.click('[data-action="back"]'); await waitScreen(page, 'hub'); }

// ---- 3D hub helpers ------------------------------------------------------------------
const BUILDINGS = ['hangar', 'pad', 'runway', 'spaceplane', 'tracking', 'research', 'missions', 'crew', 'school', 'admin'];
const hubDebug = (page, fn, arg) => page.evaluate(([f, a]) => { const d = window.__sw.app.screens.hub.debug; return (0, eval)('(' + f + ')')(d, a); }, [fn.toString(), arg]);
const pose = page => hubDebug(page, d => { const p = d.view.pose; return { az: p.az, el: p.el, dist: p.dist, x: p.target.x, z: p.target.z }; });
/** Put the camera on a building, find a pixel that picks it, and move the real mouse there. Returns the point (or null). */
async function hoverBuilding(page, id) {
  await page.mouse.move(4, 300);
  await hubDebug(page, (d, b) => d.view.flyTo(b, { snap: true }), id);
  await page.waitForTimeout(250);
  const pt = await hubDebug(page, (d, b) => {
    const c = d.screenPos(b), { w, h } = window.__sw.app.size;
    for (let r = 0; r < 9; r++) for (let k = 0; k < (r ? 8 : 1); k++) {
      const x = c.x + Math.cos(k * 0.785) * r * 9, y = c.y + Math.sin(k * 0.785) * r * 9;
      if (x < 5 || y < 5 || x > w - 5 || y > h - 5) continue;
      const top = document.elementFromPoint(x, y);
      if (top === window.__sw.app.canvas && d.view.pick(x, y) === b) return { x, y };
    }
    return null;
  }, id);
  if (!pt) return null;
  await page.mouse.move(pt.x - 3, pt.y - 2); await page.mouse.move(pt.x, pt.y);
  await page.waitForFunction(b => window.__sw.app.screens.hub.debug.hovered() === b, id, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(120);
  return pt;
}

async function run(width, height, tag) {
  console.log(`\n=== ${width}x${height} ===`);
  const { ctx, page, missing } = await newPage(width, height);
  await boot(page);

  // ---- title --------------------------------------------------------------------------
  ok(await page.evaluate(() => !!window.__sw.app.renderer), 'WebGL renderer was created');
  ok(await page.evaluate(() => window.__sw.career === null && window.__sw.world === null), '__sw exposes career/world (null on the title screen)');
  ok(await page.locator('[data-action="continue"]').count() === 0, 'no Continue button without a save');
  ok(await page.locator('.sw-wordmark').isVisible(), 'wordmark is visible');
  ok(await page.locator('.sw-menu [data-action="missions"]').count() === 1 && /flight program/.test(await page.locator('.sw-menu [data-action="missions"]').innerText()), 'the title menu has a Missions entry (tests/e2e/missions.mjs follows it)');
  await shot(page, `${tag}-01-title`);

  await page.click('[data-action="controls"]');
  await page.waitForSelector('.sw-controls');
  ok(await page.locator('.sw-controls .sw-kbd').count() > 30, 'controls reference lists keycaps');
  ok(/Logitech MX/.test(await page.locator('.sw-note').innerText()), 'controls note mentions the Mac keyboard / MX mouse setup');
  await page.waitForTimeout(250);
  await shot(page, `${tag}-02-controls`);
  await closeModal(page);

  await page.click('[data-action="settings"]');
  await page.waitForSelector('[data-setting="sfxVolume"]');
  await page.locator('[data-setting="sfxVolume"]').fill('35');
  await page.locator('label.sw-check').first().click();
  ok(await page.evaluate(() => Math.abs(window.__sw.app.settings.sfxVolume - 0.35) < 1e-6 && window.__sw.app.settings.invertPitch === true), 'settings sliders and toggles update app.settings');
  await page.waitForTimeout(250);
  await shot(page, `${tag}-03-settings`);
  await page.locator('label.sw-check').first().click();
  ok(await page.locator('[data-role="save-tools"] [data-action="import-save"]').count() === 1, 'settings offer save export / import');
  await closeModal(page);

  // Flight School is open before any game exists
  await page.click('[data-action="guide"]');
  await waitScreen(page, 'guide');
  ok(await page.locator('.sw-guide-link').count() >= 11, 'Flight School lists lessons and reference pages');
  ok(await page.locator('.sw-lesson svg').count() >= 1, 'first lesson has a diagram');
  await page.waitForSelector('[data-role="try"]');
  ok(/Start a game/.test(await page.locator('[data-role="try"]').innerText()), 'Try it explains that a game is needed');
  await shot(page, `${tag}-03b-guide-title`);
  await page.click('[data-action="back"]');
  await waitScreen(page, 'title');

  // ---- sandbox ------------------------------------------------------------------------
  await page.click('[data-action="new"]');
  await page.waitForSelector('.sw-mode');
  await page.waitForTimeout(250);
  await shot(page, `${tag}-04-newgame`);
  await closeModal(page);
  await newGame(page, 'sandbox');
  ok(await page.evaluate(() => window.__sw.career.mode === 'sandbox'), 'sandbox game started');
  ok(await page.locator('.sw-dock .sw-card').count() === 10, 'hub quick bar has a card for each of the ten buildings');
  ok(await page.evaluate(() => { const s = window.__sw.app.screens.hub; return s.is3D === true && !!s.debug.view && s.debug.view.buildings.length === 10; }), 'hub is a live 3D view of ten buildings');
  {
    const life = await page.evaluate(() => {
      const b = window.__sw.app.screens.hub.debug.view.base, g = b.group, pips = g.getObjectByName('pips'), cr = g.getObjectByName('crawler'), rk = g.getObjectByName('showRocket');
      const none0 = b.display === 'none' && !rk.visible;
      b.setDisplay('pad'); const onPad = rk.visible && b.display === 'pad' && Math.hypot(rk.position.x, rk.position.z) < 0.01;
      b.setDisplay('none'); b.setDisplay('rollout'); const z0 = cr.position.z; b.update(2, {}); const rolling = cr.position.z < z0 - 1 && Math.abs(rk.position.z - cr.position.z) < 1e-6 && rk.position.y > 5;
      b.setDisplay('none');
      const door = g.getObjectByName('building:hangar').getObjectByName('door'), y0 = door.position.y; b.setDoor('hangar', 1); b.update(1, {}); const opened = door.position.y > y0 + 1; b.setDoor('hangar', 0);
      return { none0, onPad, rolling, hidden: !rk.visible, opened, pips: pips ? pips.count : -1 };
    });
    ok(life.none0 && life.hidden, 'a new program has an empty pad: no show rocket');
    ok(life.onPad && life.rolling, 'the show rocket can stand on the pad or ride the crawler out to it');
    ok(life.opened, 'the assembly building door lifts when asked');
    ok(life.pips === -1 || life.pips > 10, 'Pips walk the campus (' + life.pips + ')');
  }
  ok(await page.locator('.sw-hub.no3d').count() === 0 && await page.locator('.sw-pin[data-building]').count() === 10, 'every building has a floating label');
  ok(await page.locator('[data-stat="funds"]').count() === 0, 'sandbox hides funds');
  ok((await page.locator('[data-role="tod"]').innerText()).trim().length > 2, 'HUD strip shows the time of day at the base');
  const frames0 = await hubDebug(page, d => d.view.frameCount);
  await page.waitForFunction(f => window.__sw.app.screens.hub.debug.view.frameCount >= f + 2, frames0, { timeout: 30000 }).catch(() => {});
  ok(await hubDebug(page, d => d.view.frameCount) >= frames0 + 2, 'the hub renders continuously (it is not a still image)');
  await shot(page, `${tag}-05-hub-sandbox`);

  // ---- camera: orbit, zoom, pan, limits ----
  const p0 = await pose(page);
  await page.mouse.move(700, 420); await page.mouse.down({ button: 'right' }); await page.mouse.move(820, 380, { steps: 5 }); await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(500);
  const p1 = await pose(page);
  ok(Math.abs(p1.az - p0.az) > 0.1 && Math.abs(p1.el - p0.el) > 0.02, `right-drag orbits the camera (az ${p0.az.toFixed(2)} → ${p1.az.toFixed(2)}, el ${p0.el.toFixed(2)} → ${p1.el.toFixed(2)})`);
  const empty = await page.evaluate(() => { const { app } = window.__sw, v = app.screens.hub.debug.view;
    for (let y = 120; y < app.size.h - 160; y += 40) for (let x = app.size.w - 60; x > 400; x -= 60) if (document.elementFromPoint(x, y) === app.canvas && !v.pick(x, y) && !v.pick(x - 90, y)) return { x, y };
    return null; });
  if (empty) { await page.mouse.move(empty.x, empty.y); await page.mouse.down(); await page.mouse.move(empty.x - 90, empty.y, { steps: 5 }); await page.mouse.up(); }
  await page.waitForTimeout(500);
  const p2 = await pose(page);
  ok(!!empty && Math.abs(p2.az - p1.az) > 0.1 && await screenName(page) === 'hub', 'left-drag on empty ground orbits too and does not enter anything');
  await page.mouse.move(700, 420);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(140); }
  await page.waitForTimeout(600);
  const p3 = await pose(page);
  ok(p3.dist < p2.dist * 0.8, `wheel zooms in smoothly (${p2.dist.toFixed(0)} m → ${p3.dist.toFixed(0)} m)`);
  await page.mouse.down({ button: 'middle' }); await page.mouse.move(600, 360, { steps: 4 }); await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(500);
  const p4 = await pose(page);
  ok(Math.hypot(p4.x - p3.x, p4.z - p3.z) > 5, 'middle-drag pans across the base');
  await page.keyboard.down('KeyD'); await page.waitForTimeout(450); await page.keyboard.up('KeyD');
  await page.waitForTimeout(300);
  const p5 = await pose(page);
  ok(Math.hypot(p5.x - p4.x, p5.z - p4.z) > 5, 'WASD moves the camera');
  const lim = await hubDebug(page, d => { const v = d.view; v.orbit(0, -5000); v.zoom(1e-6); v.pan(1e6, 1e6); v.update(10, { drift: false }); const a = { el: v.pose.el, dist: v.pose.dist, y: v.camera.position.y, x: v.pose.target.x, z: v.pose.target.z };
    v.orbit(0, 5000); v.zoom(1e6); v.update(10, { drift: false }); return { a, b: { el: v.pose.el, dist: v.pose.dist, y: v.camera.position.y } }; });
  ok(lim.a.y > 2 && lim.b.y > 2 && lim.a.dist <= 3300 && lim.b.dist >= 60 && Math.abs(lim.a.x) < 1500 && Math.abs(lim.a.z) < 1500, 'camera is clamped: never underground, never out of sight of the base');
  await page.keyboard.press('KeyH');
  await page.waitForFunction(d0 => Math.abs(window.__sw.app.screens.hub.debug.view.pose.dist - d0) < d0 * 0.2, p0.dist, { timeout: 20000 }).catch(() => {});
  const p6 = await pose(page);
  ok(Math.abs(p6.dist - p0.dist) < p0.dist * 0.2, 'H brings the camera home');
  await shot(page, `${tag}-05b-hub-orbit`);

  // ---- hover name plates, and where each building leads (3D click) ----
  const calls = await page.evaluate(() => { const { app } = window.__sw; window.__goto = app.goto; window.__calls = []; app.goto = (n, p) => { window.__calls.push([n, p || null]); }; return true; });
  const leads = {};
  let plates = 0, cursors = 0, hovered = 0;
  for (const id of BUILDINGS) {
    const pt = await hoverBuilding(page, id);
    if (!pt) { console.log('    (no pickable pixel found for ' + id + ')'); continue; }
    if (await hubDebug(page, d => d.hovered()) === id) hovered++;
    const plate = page.locator(`.sw-plate[data-building="${id}"]:not(.sw-hidden)`);
    if (await plate.count() === 1 && (await plate.locator('b').innerText()).length > 3 && (await plate.locator('.blurb').innerText()).length > 10 && (await plate.locator('[data-role="status"]').innerText()).trim().length > 2) plates++;
    if (await page.evaluate(() => window.__sw.app.canvas.style.cursor) === 'pointer') cursors++;
    if (id === 'hangar') { await page.waitForTimeout(300); await shot(page, `${tag}-05c-hub-hover`); }
    await page.evaluate(() => { window.__calls.length = 0; });
    await page.mouse.down(); await page.mouse.up();
    if (id === 'pad' || id === 'runway') {
      await page.waitForSelector('.sw-launch', { timeout: 15000 });
      leads[id] = 'launch:' + await page.locator('.sw-launch').getAttribute('data-site');
      await closeModal(page);
    } else {
      await page.waitForFunction(() => window.__calls.length > 0, null, { timeout: 15000 }).catch(() => {});
      const c = await page.evaluate(() => window.__calls[0] || null);
      leads[id] = c ? c[0] + (c[1] && c[1].site ? ':' + c[1].site : '') : 'nothing';
    }
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => { window.__sw.app.goto = window.__goto; });
  ok(calls && hovered === 10, `hovering each building in the 3D view lights it up (${hovered}/10)`);
  ok(plates === 10, `each hovered building shows a name plate with a description and a status line (${plates}/10)`);
  ok(cursors === 10, `the cursor becomes a pointer over buildings (${cursors}/10)`);
  const want = { hangar: 'builder', pad: 'launch:pad', runway: 'launch:runway', spaceplane: 'builder:runway', tracking: 'tracking', research: 'research', missions: 'missions', crew: 'crew', school: 'guide', admin: 'admin' };
  ok(JSON.stringify(leads) === JSON.stringify(want), 'clicking each building enters the right place: ' + JSON.stringify(leads));
  await page.mouse.move(4, 300);
  await page.waitForFunction(() => !document.querySelector('.sw-plate:not(.sw-hidden)'), null, { timeout: 15000 }).catch(() => {});
  ok(await page.locator('.sw-plate:not(.sw-hidden)').count() === 0 && await page.evaluate(() => window.__sw.app.canvas.style.cursor) === '', 'name plate and pointer cursor go away off the buildings');

  // a real click through the 3D view, end to end, with the camera fly-in
  for (const [id, key] of [['research', 'research'], ['school', 'guide']]) {
    const pt = await hoverBuilding(page, id);
    const d0 = (await pose(page)).dist;
    await hubDebug(page, d => d.view.home(true)); await page.waitForTimeout(200);
    const pt2 = pt && await hoverBuilding(page, id);
    if (pt2) { await page.mouse.down(); await page.mouse.up(); }
    await waitScreen(page, key);
    ok(d0 > 0 && await screenName(page) === key, `clicking the ${id} building in the scene opens ${key}`);
    await backToHub(page);
  }
  // double-click only looks closer
  { const pt = await hoverBuilding(page, 'missions');
    await hubDebug(page, d => d.view.home(true)); await page.waitForTimeout(250);
    const far = (await pose(page)).dist;
    const c = await hubDebug(page, d => d.screenPos('missions'));
    const spot = await hubDebug(page, (d, c0) => { for (let r = 0; r < 6; r++) for (let k = 0; k < 8; k++) { const x = c0.x + Math.cos(k * 0.785) * r * 3, y = c0.y + Math.sin(k * 0.785) * r * 3; if (document.elementFromPoint(x, y) === window.__sw.app.canvas && d.view.pick(x, y) === 'missions') return { x, y }; } return null; }, c);
    if (pt && spot) await page.mouse.dblclick(spot.x, spot.y);
    await page.waitForTimeout(1300);
    const near = (await pose(page)).dist;
    ok(!!spot && await screenName(page) === 'hub' && near < far * 0.7, `double-click flies the camera to a building without entering it (${far.toFixed(0)} m → ${near.toFixed(0)} m)`);
    await page.mouse.move(4, 300);
    await page.keyboard.press('KeyH'); await page.waitForTimeout(500); }

  // ---- keyboard path: every building reachable without the mouse ----
  const litNow = () => hubDebug(page, d => d.lit());
  const arrow = async key => { const was = await litNow(); await page.keyboard.press(key); await page.waitForFunction(w => window.__sw.app.screens.hub.debug.lit() !== w, was, { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(120); return litNow(); };
  const k1 = await arrow('ArrowRight');
  ok(BUILDINGS.includes(k1) && await page.locator(`.sw-plate[data-building="${k1}"]:not(.sw-hidden)`).count() === 1, `arrow keys select a building and show its name plate (${k1})`);
  const k2 = await arrow('ArrowRight'), k3 = await arrow('ArrowLeft');
  ok(k2 === BUILDINGS[(BUILDINGS.indexOf(k1) + 1) % 10] && k3 === k1, `arrow right / left step through the buildings in quick-bar order (${k1} → ${k2} → ${k3})`);
  const seen = new Set([k3]);
  for (let i = 0; i < 10 && await litNow() !== 'pad'; i++) seen.add(await arrow('ArrowRight'));
  for (let i = 0; i < 9; i++) seen.add(await arrow('ArrowRight'));
  for (let i = 0; i < 10 && await litNow() !== 'pad'; i++) await arrow('ArrowRight');
  ok(seen.size === 10 && await litNow() === 'pad', 'the arrow keys reach all ten buildings');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sw-launch[data-site="pad"]');
  ok(true, 'Enter opens the selected building (launch pad → launch dialog)');
  await closeModal(page);
  await page.keyboard.press('Digit3');
  await page.waitForSelector('.sw-launch[data-site="runway"]');
  ok(/runway/i.test(await page.locator('.sw-modal').innerText()), 'number keys jump straight in (3 → the runway launch dialog)');
  await closeModal(page);
  for (const [digit, key] of [['Digit6', 'research'], ['Digit7', 'missions'], ['Digit8', 'crew'], ['Digit9', 'guide']]) {
    await page.keyboard.press(digit);
    await waitScreen(page, key);
    await backToHub(page);
  }
  ok(true, 'number keys open research / missions / crew / flight school');
  await page.keyboard.press('Digit0');
  await waitScreen(page, 'admin');
  await page.waitForSelector('.sw-admin [data-menu="title"]');
  ok(await page.locator('.sw-fac').count() === 6, '0 opens Administration: six facilities, the program menu and the settings');
  await page.waitForSelector('.sw-admin [data-setting="gfxQuality"]');
  await page.click('.sw-admin [data-setting="gfxQuality"][data-v="medium"]');
  ok(await page.evaluate(() => window.__sw.app.settings.gfxQuality === 'medium'), 'graphics detail can be set from Administration');
  await page.click('.sw-admin [data-setting="gfxQuality"][data-v="high"]');
  await page.waitForTimeout(250);
  await shot(page, `${tag}-09b-admin`);
  await backToHub(page);
  // Tab focus on the quick bar
  await page.locator('.sw-card[data-goto="missions"]').focus();
  await page.keyboard.press('Enter');
  await waitScreen(page, 'missions');
  ok(true, 'a focused quick-bar card opens with Enter');
  await backToHub(page);
  ok(await page.evaluate(() => [...document.querySelectorAll('.sw-dock .sw-card')].every(b => b.tagName === 'BUTTON' && b.getAttribute('aria-label') && b.tabIndex >= 0)), 'quick-bar cards are labelled, focusable buttons');

  await page.click('.sw-card[data-goto="research"]');
  await waitScreen(page, 'research');
  const techCount = await page.evaluate(() => window.__sw.app.careerModule.TECH_TREE.length);
  ok(await page.locator('.sw-node').count() === techCount, 'research draws every tech node');
  ok(await page.locator('.sw-node.owned').count() === techCount, 'sandbox: every node is owned');
  await shot(page, `${tag}-06-research-sandbox`);
  await page.keyboard.press('Escape');
  await waitScreen(page, 'hub');
  ok(true, 'Esc returns from a management screen to the hub');

  // optional 3D screens: either the real module or the placeholder must come up cleanly
  for (const key of ['builder', 'tracking']) {
    const placeholder = await page.evaluate(k => !!window.__sw.app.screens[k].placeholder, key);
    inForeign = !placeholder;
    await page.click(`.sw-card[data-goto="${key}"]`);
    await waitScreen(page, key);
    console.log(`    (${key}: ${placeholder ? 'placeholder' : 'real module'})`);
    await shot(page, `${tag}-07-${key}`);
    if (placeholder) await backToHub(page);
    else { await page.evaluate(() => window.__sw.app.goto('hub')); await waitScreen(page, 'hub'); }
    ok(await page.locator('.sw-hub').count() === 1 && await page.locator(`[data-screen="${key}"]`).count() === 0, `${key} screen opens and returns to the hub`);
    await page.waitForTimeout(200);
    inForeign = false;
  }

  // launch dialog
  await page.click('.sw-card[data-goto="launch"]');
  await page.waitForSelector('.sw-launch');
  await page.waitForTimeout(300);
  const stock = await page.locator('.sw-item[data-group="stock"]').count();
  ok(stock >= 3, `launch dialog lists stock crafts (${stock})`);
  ok(await page.locator('[data-action="launch"]').isEnabled(), 'sandbox can launch a stock craft');
  await shot(page, `${tag}-08-launch-sandbox`);
  await closeModal(page);
  {   // round 3: the pad dialog used to list spaceplanes and rovers like any rocket (they then stood on their tails on the pad)
    const sites = async () => page.$$eval('.sw-launch-modal .sw-item[data-group="stock"]', l => l.map(b => b.dataset.site));
    const firstOther = l => { const i = l.findIndex(x => x !== l[0]); return i < 0 ? l.length : i; };
    await page.click('.sw-card[data-goto="launch"]'); await page.waitForSelector('.sw-launch');
    let l = await sites();
    ok(l[0] === 'pad' && l.includes('runway') && l.slice(firstOther(l)).every(x => x === 'runway'), 'launch pad dialog: designs made for the pad come first, runway designs after them');
    ok(await page.locator('.sw-launch-modal .sw-item.active').getAttribute('data-site') === 'pad' && await page.locator('[data-role="wrong-site"]').count() === 0, 'a pad design is selected to begin with, without a warning');
    await page.click('.sw-launch-modal .sw-item[data-site="runway"] >> nth=0');
    ok(/Runway design/.test(await page.locator('.sw-launch-modal .sw-item.active').innerText()) && /built for the runway/.test(await page.locator('[data-role="wrong-site"]').innerText()), 'a runway design in the pad dialog is marked and says where it belongs');
    await closeModal(page);
    await page.click('.sw-card[data-goto="runway"]'); await page.waitForSelector('.sw-launch[data-site="runway"]');
    l = await sites();
    ok(l[0] === 'runway' && l.slice(firstOther(l)).every(x => x === 'pad') && await page.locator('.sw-launch-modal .sw-item.active').getAttribute('data-site') === 'runway', 'runway dialog: runway designs first, one of them selected');
    await page.click('.sw-launch-modal .sw-item[data-site="pad"] >> nth=0');
    ok(/Pad design/.test(await page.locator('.sw-launch-modal .sw-item.active').innerText()) && /built for the launch pad/.test(await page.locator('[data-role="wrong-site"]').innerText()), 'a rocket in the runway dialog is marked the other way round');
    await closeModal(page);
  }

  // hub menu → main menu
  await page.click('[data-action="menu"]');
  await page.waitForSelector('[data-menu="title"]');
  await page.waitForTimeout(200);
  await shot(page, `${tag}-09-hub-menu`);
  await page.click('[data-menu="title"]');
  await waitScreen(page, 'title');
  ok(await page.locator('[data-action="continue"]').count() === 1, 'Continue appears once a save exists');
  await shot(page, `${tag}-10-title-with-save`);

  // ---- career -------------------------------------------------------------------------
  await newGame(page, 'career', { replace: true });
  ok(await page.evaluate(() => window.__sw.career.mode === 'career' && window.__sw.career.funds > 0), 'career game started with funds');
  ok(await page.locator('[data-stat="funds"]').count() === 1 && await page.locator('[data-stat="science"]').count() === 1, 'career shows funds and science');
  ok(await page.locator('.sw-hubbar [data-stat="rep"]').count() === 1 && await page.locator('.sw-hubbar [data-stat="mode"]').count() === 1, 'HUD strip also carries reputation and the game mode');
  ok(await page.locator('[data-role="hint"]').count() === 1, 'a new career gets the welcome hint');
  { const st = await hubDebug(page, d => ({ m: d.status('missions').text, p: d.status('pad').text, r: d.status('research').text, c: d.status('crew').text }));
    ok(/\d+ contracts? on offer/.test(st.m) && st.p.length > 3 && st.r.length > 3 && /\d/.test(st.c), `building status lines reflect the game (“${st.m}”, “${st.p}”, “${st.c}”)`); }
  ok(/Year 1, Day 1, 04:4\d:\d\d/.test(await page.locator('[data-stat="date"]').innerText()), 'status bar shows the Verda date (a new game opens in mid-morning: main.js NEW_GAME_UT)');
  await shot(page, `${tag}-11-hub-career`);

  // research: nothing is affordable at 0 science
  await page.click('.sw-card[data-goto="research"]');
  await waitScreen(page, 'research');
  ok(await page.locator('.sw-node.owned').count() === 1, 'career starts with one researched node');
  ok(await page.locator('.sw-node.affordable').count() === 0, 'nothing is affordable with 0 science');
  const firstAvail = page.locator('.sw-node.available').first();
  const availId = await firstAvail.getAttribute('data-tech');
  await firstAvail.click();
  ok(await page.locator('[data-action="unlock"]').isDisabled(), 'Unlock button is disabled when unaffordable');
  ok(await page.locator('.sw-msg[data-reason="science"]').count() === 1, 'side panel explains the missing science');
  const before = await page.evaluate(() => ({ n: window.__sw.career.tech.size, s: window.__sw.career.science }));
  await page.evaluate(() => document.querySelector('[data-action="unlock"]').click());      // disabled → no-op
  const forced = await page.evaluate(id => window.__sw.career.unlockTech(id), availId);
  const after = await page.evaluate(() => ({ n: window.__sw.career.tech.size, s: window.__sw.career.science }));
  ok(forced.ok === false && forced.reason === 'science' && after.n === before.n && after.s === before.s, 'unaffordable unlock changes nothing');
  await page.locator('.sw-node.locked').first().click();
  ok(await page.locator('.sw-msg[data-reason="prereq"]').count() === 1, 'locked node explains its prerequisites');
  await shot(page, `${tag}-12-research-career`);

  // grant science → unlock through the UI
  await page.evaluate(() => window.__sw.career.earn(0, 60, 0));
  await page.waitForFunction(() => document.querySelectorAll('.sw-node.affordable').length > 0);
  await page.click(`.sw-node[data-tech="${availId}"]`);
  ok(await page.locator('.sw-part').count() > 0, 'side panel lists the parts of the node');
  await page.click('[data-action="unlock"]');
  await page.waitForFunction(id => window.__sw.career.tech.has(id), availId);
  ok(await page.locator(`.sw-node[data-tech="${availId}"].owned`).count() === 1, 'unlocking through the UI marks the node owned');
  ok(await page.locator('.sw-toast.good').count() >= 1, 'a toast confirms the unlock');
  await page.waitForTimeout(400);
  await shot(page, `${tag}-13-research-unlocked`);
  await backToHub(page);

  // Flight School inside a career
  await page.click('.sw-card[data-goto="guide"]');
  await waitScreen(page, 'guide');
  const pages = await page.evaluate(() => [...document.querySelectorAll('.sw-guide-link')].map(b => b.dataset.lesson));
  for (const id of pages) {
    await page.click(`.sw-guide-link[data-lesson="${id}"]`);
    await page.waitForSelector(`.sw-lesson[data-lesson="${id}"]`);
    await page.waitForTimeout(150);
    if (['hop', 'orbits', 'ascent', 'pell', 'landing', 'rendezvous', 'controls', 'deltav', 'glossary'].includes(id)) await shot(page, `${tag}-13g-guide-${id}`);
    if (id === 'pell') {
      ok(/11[01]°/.test(await page.locator('.sw-lesson').innerText()), 'Pell lesson states the computed phase angle');
      await page.waitForSelector('[data-role="try"]');
      ok(/Needs research first/.test(await page.locator('[data-role="try"]').innerText()), 'Try it names the research a locked craft needs');
      await page.locator('.sw-guide-body').evaluate(n => { n.scrollTop = n.scrollHeight; });
      await page.waitForTimeout(150);
      await shot(page, `${tag}-13g-guide-pell-end`);
    }
    if (id === 'hop') { await page.waitForSelector('[data-role="try"] [data-action="try"]'); ok(await page.locator('[data-action="try"]').isEnabled(), 'first-hop lesson can launch Hopper I'); }
    if (id === 'deltav') ok(await page.locator('.sw-dvcard').count() >= 6, 'delta-v card covers the system');
    if (id === 'controls') ok(await page.locator('.sw-keys .sw-kbd').count() > 40, 'controls reference lists the keys');
  }
  await backToHub(page);

  // missions
  await page.evaluate(() => { const c = window.__sw.career; c.completeMilestone('first_launch'); c.creditScience('crew_report', 'verda', 'landed'); c.creditScience('temperature', 'pell', 'spaceLow'); });
  await page.click('.sw-card[data-goto="missions"]');
  await waitScreen(page, 'missions');
  // contracts tab is the default in a career
  const offers0 = await page.locator('.sw-contract.offer').count();
  ok(offers0 >= 3 && offers0 <= 5, `contract board posts 3-5 offers (${offers0})`);
  await shot(page, `${tag}-14a-contracts`);
  const funds0 = await page.evaluate(() => window.__sw.career.funds);
  await page.locator('.sw-contract.offer [data-action="accept"]').first().click();
  await page.waitForFunction(() => window.__sw.career.contracts.active.length === 1);
  ok(await page.locator('.sw-contract.active').count() === 1, 'accepting a contract moves it to Active');
  ok(await page.evaluate(f => window.__sw.career.funds > f, funds0), 'accepting pays an advance');
  await page.locator('.sw-contract.offer [data-action="decline"]').first().click();
  await page.waitForTimeout(250);
  ok(await page.evaluate(() => window.__sw.career.contracts.offered.length >= 2), 'declining removes an offer from the board');
  await page.evaluate(() => { const b = window.__sw.career.contracts; if (b.offered[0]) b.accept(b.offered[0].id); });
  await page.click('.sw-tab[data-tab="milestones"]'); await page.click('.sw-tab[data-tab="contracts"]');
  await page.waitForTimeout(250);
  await shot(page, `${tag}-14b-contracts-active`);
  await page.locator('.sw-contract.active [data-action="cancel"]').first().click();
  if (await page.locator('.sw-modal .sw-btn.danger').count()) await page.click('.sw-modal .sw-btn.danger');
  await page.waitForFunction(() => window.__sw.career.contracts.failed.length === 1);
  await page.waitForTimeout(300);
  await page.click('[data-sub="history"]');
  await page.waitForSelector('.sw-history-row');
  ok(await page.locator('.sw-history-row').count() >= 1, 'history lists the cancelled contract');
  await shot(page, `${tag}-14c-contracts-history`);
  // program grant: only when broke and nothing is flying
  ok(await page.locator('[data-role="grant"]:not(.sw-hidden)').count() === 0, 'no grant banner while solvent');
  const fundsKeep = await page.evaluate(() => { const c = window.__sw.career, f = c.funds; c.funds = 200; return f; });
  await page.click('.sw-tab[data-tab="milestones"]'); await page.click('.sw-tab[data-tab="contracts"]');
  await page.waitForSelector('[data-role="grant"]');
  await shot(page, `${tag}-14d-grant`);
  await page.click('[data-action="grant"]');
  await page.waitForFunction(() => window.__sw.career.funds > 5000);
  ok(await page.evaluate(() => window.__sw.career.grants === 1 && window.__sw.career.grantOffer() === null), 'program grant is paid once and the offer goes away');
  await page.evaluate(f => { window.__sw.career.funds = f; }, fundsKeep);
  await page.click('.sw-tab[data-tab="milestones"]');
  await page.waitForSelector('.sw-mission');
  const msCount = await page.evaluate(() => window.__sw.app.careerModule.MILESTONES.length);
  ok(await page.locator('.sw-mission').count() === msCount, 'mission board shows every milestone');
  ok(await page.locator('.sw-mission.done').count() === 1, 'completed milestone is marked');
  await shot(page, `${tag}-14-missions`);
  await page.click('.sw-tab[data-tab="science"]');
  await page.waitForSelector('.sw-table');
  ok(await page.locator('.sw-table tbody tr').count() === 2, 'science archive lists logged results');
  ok(/Crew Report/.test(await page.locator('.sw-table').innerText()) && /Pell/.test(await page.locator('.sw-table').innerText()), 'science keys are shown with friendly names');
  await page.waitForTimeout(200);
  await shot(page, `${tag}-15-science-archive`);
  await backToHub(page);

  // crew
  await page.click('.sw-card[data-goto="crew"]');
  await waitScreen(page, 'crew');
  const roster0 = await page.evaluate(() => window.__sw.career.roster.length);
  ok(await page.locator('.sw-pip-card[data-pip]').count() === roster0, 'crew screen shows the whole roster');
  ok(await page.locator('.sw-pip-card svg.portrait').count() === roster0, 'every Pip has a portrait');
  const distinct = await page.evaluate(() => new Set([...document.querySelectorAll('.sw-pip-card svg.portrait')].map(s => s.innerHTML.replace(/p[a-z0-9]+[bcv]\b/g, ''))).size);
  ok(distinct === roster0, 'portraits differ between Pips');
  await page.click('[data-action="hire"]');
  await page.waitForFunction(n => window.__sw.career.roster.length === n + 1, roster0);
  ok(await page.locator('.sw-pip-card[data-pip]').count() === roster0 + 1, 'hiring adds a Pip card');
  await page.waitForTimeout(300);
  await shot(page, `${tag}-16-crew`);
  // rename, and the memorial wall
  const firstName = await page.evaluate(() => window.__sw.career.roster[0].name);
  await page.locator(`.sw-pip-card[data-pip="${firstName}"] [data-action="rename"]`).click();
  await page.waitForSelector('[data-role="pip-name"]');
  await page.locator('[data-role="pip-name"]').fill('Zephyr');
  await page.waitForTimeout(200);
  await shot(page, `${tag}-16b-crew-rename`);
  await page.click('.sw-modal .sw-btn.primary');
  await page.waitForFunction(() => window.__sw.career.roster[0].name === 'Zephyr');
  ok(await page.locator('.sw-pip-card[data-pip="Zephyr"]').count() === 1, 'renaming a Pip updates the card');
  await page.evaluate(() => { const c = window.__sw.career, p = c.roster[c.roster.length - 1];
    c.awardExperience(['Zephyr'], { reachedSpace: true, visited: ['verda', 'pell'], landedOn: ['pell'], orbited: ['verda', 'pell'] });
    c.loseCrew(p.name, { where: 'Pell', vessel: 'Pell Runner' }); });
  await page.click('[data-action="back"]'); await waitScreen(page, 'hub');
  await page.click('.sw-card[data-goto="crew"]'); await waitScreen(page, 'crew');
  ok(await page.locator('.sw-memorial .sw-plaque').count() === 1, 'a lost Pip gets a plaque on the memorial wall');
  ok(await page.locator('.sw-pip-card[data-pip="Zephyr"] .sw-stars .on').count() >= 1, 'experience shows as stars');
  await page.locator('[data-role="memorial"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot(page, `${tag}-16c-crew-memorial`);
  // cannot hire when broke
  await page.evaluate(() => { window.__sw.career.funds = 10; });
  await page.waitForFunction(() => document.querySelector('[data-action="hire"]').disabled);
  ok(true, 'Hire is disabled without funds');
  await page.evaluate(() => { window.__sw.career.funds = window.__sw.app.careerModule.START_FUNDS; });
  await backToHub(page);

  // launch dialog in career: locked stock designs are blocked, cost is shown
  await page.click('.sw-card[data-goto="launch"]');
  await page.waitForSelector('.sw-launch');
  await page.waitForTimeout(300);
  ok(/Launch cost/.test(await page.locator('.sw-craft-info').innerText()), 'career launch dialog shows the launch cost');
  await shot(page, `${tag}-17-launch-career`);
  ok(/not researched/.test(await page.locator('.sw-craft-info').innerText()) || await page.locator('[data-action="launch"]').isEnabled(), 'locked stock designs explain what is missing');
  await closeModal(page);
  const flightIsPlaceholder = await page.evaluate(() => !!window.__sw.app.screens.flight.placeholder);
  if (flightIsPlaceholder) {
    // app.launch(): pays, assigns crew, hands { craft: JSON, crew, paid } to the flight screen
    const r = await page.evaluate(async () => {
      const { app } = window.__sw, c = app.career;
      const { stockCrafts } = await import('./js/core/craft.js');
      const craft = stockCrafts()[0];
      let got = null; const flight = app.screens.flight, enter = flight.enter;
      flight.enter = p => { got = p; return enter.call(flight, p); };
      const funds0 = c.funds;
      const okLaunch = app.launch(craft, { crew: [c.availableCrew()[0].name] });
      await new Promise(res => setTimeout(res, 300));
      flight.enter = enter;
      const out = { okLaunch, paid: funds0 - c.funds, cost: craft.cost(), params: got && { paid: got.paid, crew: got.crew, json: !!(got.craft && Array.isArray(got.craft.parts) && !got.craft.getPart) },
        assigned: c.roster.filter(p => p.status === 'assigned').map(p => p.name) };
      c.releaseCrew(out.assigned); c.funds = funds0;
      c.funds = 5; out.broke = app.launch(craft, { crew: [] }); c.funds = funds0;
      return out;
    });
    await waitScreen(page, 'flight');
    ok(r.okLaunch && r.paid === r.cost && r.cost > 0, `app.launch charges the launch cost (${r.cost})`);
    ok(r.params && r.params.paid === true && r.params.json && r.params.crew.length === 1 && r.assigned.length === 1, 'app.launch hands craft JSON + assigned crew to the flight screen');
    ok(r.broke === false, 'app.launch refuses when funds are short');
    await shot(page, `${tag}-17b-flight-placeholder`);
    await backToHub(page);
  }

  // ---- input --------------------------------------------------------------------------
  const inp = await page.evaluate(async () => {
    const { app } = window.__sw, input = app.input, canvas = app.canvas, out = {};
    const tick = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const z = [];
    const off = input.on('wheel', e => z.push(e.zoom));
    const wheel = init => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, ...init }));
    wheel({ deltaY: -100 }); await new Promise(r => setTimeout(r, 160));
    wheel({ deltaY: 3, deltaMode: 1 }); await new Promise(r => setTimeout(r, 160));
    wheel({ deltaY: 9000 }); await new Promise(r => setTimeout(r, 160));
    wheel({ deltaY: -4, ctrlKey: true }); await new Promise(r => setTimeout(r, 160));
    for (let i = 0; i < 40; i++) wheel({ deltaY: -120 });        // free-spin burst
    off();
    out.zoomIn = z[0]; out.lines = z[1]; out.huge = z[2]; out.pinch = z[3];
    out.burst = z.slice(4).reduce((a, b) => a * b, 1);
    out.allClamped = z.every(v => v >= 0.8 - 1e-9 && v <= 1.25 + 1e-9);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    out.down = input.down('KeyW'); out.pressed = input.pressed('KeyW');
    await tick();
    out.pressedAfterFrame = input.pressed('KeyW'); out.stillDown = input.down('KeyW');
    window.dispatchEvent(new Event('blur'));
    out.downAfterBlur = input.down('KeyW');

    const nav = new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true });
    document.body.dispatchEvent(nav); out.backBlocked = nav.defaultPrevented;
    const nav2 = new MouseEvent('mouseup', { button: 4, bubbles: true, cancelable: true });
    document.body.dispatchEvent(nav2); out.forwardBlocked = nav2.defaultPrevented;
    const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(cm); out.contextBlocked = cm.defaultPrevented;

    // game keys only swallowed while capturing, and never while typing
    const space = () => { const e = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    input.captureKeys = false; out.spaceFree = space();
    input.captureKeys = true; out.spaceCaptured = space();
    const field = document.createElement('input'); document.body.appendChild(field);
    const typed = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    field.dispatchEvent(typed); out.typingFree = !typed.defaultPrevented; field.remove();
    input.captureKeys = false; input.releaseAll();

    out.audio = ['stage', 'explosion', 'click', 'chute', 'alarm', 'success', 'splash', 'land', 'warp'].every(n => { try { app.audio.play(n); return true; } catch { return false; } });
    try { app.audio.setEngine(0.8, { vacuum: false, solid: true }); app.audio.setWind(0.5); app.audio.setEngine(0.4, { vacuum: true }); app.audio.stopAll(); out.audioCont = true; } catch { out.audioCont = false; }
    return out;
  });
  ok(inp.zoomIn > 1.15 && inp.zoomIn <= 1.25, `wheel up zooms in (${inp.zoomIn.toFixed(3)})`);
  ok(inp.lines < 1 && inp.lines > 0.85, `line-mode wheel is normalised (${inp.lines.toFixed(3)})`);
  ok(Math.abs(inp.huge - 0.8) < 1e-6, 'huge wheel delta is clamped to 0.8');
  ok(inp.pinch > 1 && inp.pinch < 1.1, `trackpad pinch zooms (${inp.pinch.toFixed(3)})`);
  ok(inp.allClamped && inp.burst <= 1.61, `free-spin burst is budgeted (x${inp.burst.toFixed(2)} for 40 events)`);
  ok(inp.down && inp.pressed && !inp.pressedAfterFrame && inp.stillDown, 'key down / pressed edge semantics');
  ok(inp.downAfterBlur === false, 'keys are released on window blur');
  ok(inp.backBlocked && inp.forwardBlocked, 'mouse back/forward buttons are blocked');
  ok(inp.contextBlocked, 'context menu is suppressed on the canvas');
  ok(!inp.spaceFree && inp.spaceCaptured && inp.typingFree, 'Space is swallowed only on game screens and never while typing');
  ok(inp.audio && inp.audioCont, 'audio API never throws');

  // real mouse drag on the canvas is delivered (needs a spot with no UI over it → use a placeholder-free probe)
  const drag = await page.evaluate(() => {
    const { input, canvas } = window.__sw.app; const seen = [];
    const offs = ['mousedown', 'mousemove', 'mouseup'].map(t => input.on(t, e => seen.push(t + ':' + e.button)));
    const pe = (type, init) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, ...init }));
    pe('pointerdown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    pe('pointermove', { button: -1, buttons: 2, clientX: 130, clientY: 110 });
    const dx = input.mouse.dx;
    pe('pointerup', { button: 2, buttons: 0, clientX: 130, clientY: 110 });
    offs.forEach(f => f());
    return { seen, dx, buttons: input.mouse.buttons };
  });
  ok(drag.seen.join(',') === 'mousedown:2,mousemove:-1,mouseup:2' && drag.dx === 30 && drag.buttons === 0, 'right-drag on the canvas is reported');

  // ---- persistence --------------------------------------------------------------------
  const saved = await page.evaluate(() => { const c = window.__sw.career; window.__sw.app.save(); return { tech: c.tech.size, roster: c.roster.length, ms: c.milestones.size }; });
  await boot(page);
  await page.click('[data-action="continue"]');
  await waitScreen(page, 'hub');
  const loaded = await page.evaluate(() => { const c = window.__sw.career; return { tech: c.tech.size, roster: c.roster.length, ms: c.milestones.size, mode: c.mode }; });
  ok(loaded.mode === 'career' && loaded.tech === saved.tech && loaded.roster === saved.roster && loaded.ms === saved.ms, 'Continue restores the saved career');
  ok(await page.evaluate(() => Math.abs(window.__sw.app.settings.sfxVolume - 0.35) < 1e-6), 'settings persist across reloads');

  // export → import round trip, and a corrupt save never breaks the title screen
  const io = await page.evaluate(() => { const M = window.__sw.app.careerModule, c = window.__sw.career;
    const text = c.exportSave(), back = M.Career.importSave(text), bad = M.Career.importSave('{not json');
    return { ok: back.ok && back.career.funds === c.funds && back.career.contracts.offered.length === c.contracts.offered.length, bad: bad.ok === false && !!bad.error }; });
  ok(io.ok && io.bad, 'save export / import round-trips and rejects rubbish');

  // delete save
  await page.click('[data-action="menu"]');
  await page.click('[data-menu="title"]');
  await waitScreen(page, 'title');
  await page.click('[data-action="delete"]');
  await page.waitForSelector('.sw-modal .sw-btn.danger');
  await page.waitForTimeout(200);
  await shot(page, `${tag}-18-delete-confirm`);
  await page.click('.sw-modal .sw-btn.danger');
  await page.waitForFunction(() => !document.querySelector('[data-action="continue"]'));
  ok(await page.evaluate(() => !window.__sw.app.hasSave()), 'Delete save removes the save');

  // ---- day and night follow game time; no-WebGL fallback --------------------------------
  await newGame(page, 'career');
  const sky = await page.evaluate(() => { const { app } = window.__sw, v = app.screens.hub.debug.view, out = [];
    for (const f of [0, 0.25, 0.5, 0.75]) { app.career.ut = f * 19800; v.setTime(app.career.ut); v.update(0.016, { drift: false }); out.push({ y: v.sky.sunDir.y, night: v.rig.state.night }); }
    app.career.ut = 0; return out; });
  ok(sky[0].y > 0.3 && sky[2].y < -0.3 && sky[0].night < 0.05 && sky[2].night > 0.9, `sun and night lighting follow game time (noon sun ${sky[0].y.toFixed(2)}, midnight ${sky[2].y.toFixed(2)})`);
  await page.evaluate(() => { const { app } = window.__sw; app.career.ut = 0.5 * 19800; });
  await page.waitForTimeout(900);
  await shot(page, `${tag}-19-hub-night`);
  await page.evaluate(() => { const { app } = window.__sw; app.career.ut = 0; });

  if (missing.size) console.log('  note: optional screens not present yet → placeholders: ' + [...missing].map(u => path.basename(u)).join(', '));
  await ctx.close();
}

// No WebGL at all: the hub must fall back to a plain list and still reach every building.

// ---- interface size --------------------------------------------------------------------
// The whole interface is zoomed by one variable; the 3D canvas is not. Everything that is placed from a screen position
// (building labels, the name plate, tooltips, map labels) and everything that is hit with the pointer must still line up.
async function runScale(width, height, dsf, tag, { expectAuto, pickSize }) {
  console.log(`\n=== interface size at ${width}×${height}, device pixel ratio ${dsf} (${tag}) ===`);
  const { ctx, page } = await newPage(width, height, dsf);
  const E = (fn, arg) => page.evaluate(fn, arg);
  const shot = (pg, name) => pg.screenshot({ path: path.join(OUT, name + '.png'), timeout: 240000 });      // a big window on a software rasteriser
  const scale = () => E(() => ({ app: window.__sw.app.ui.scale, css: parseFloat(getComputedStyle(document.getElementById('ui')).zoom), dpr: window.devicePixelRatio }));
  const offscreen = () => E(() => {
    const W = innerWidth, H = innerHeight, bad = [];
    for (const e of document.querySelectorAll('#ui button, #ui .sw-panel, #ui .sw-modal, #ui .fl-pop')) {
      const st = getComputedStyle(e); if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity < 0.05) continue;
      const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
      let p = e.parentElement, scrolled = false; while (p && p.id !== 'ui') { const o = getComputedStyle(p); if (/auto|scroll|hidden/.test(o.overflowY + o.overflowX)) { scrolled = true; break; } p = p.parentElement; }
      if (!scrolled && (r.left < -2 || r.top < -2 || r.right > W + 2 || r.bottom > H + 2)) bad.push((e.className || e.tagName) + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.right) + ',' + Math.round(r.bottom));
    }
    return bad;
  });
  await boot(page);
  let k = await scale();
  ok(k.dpr === dsf, `the page runs at device pixel ratio ${dsf}`);
  ok(Math.abs(k.app - expectAuto) < 0.001 && Math.abs(k.css - expectAuto) < 0.001, `Auto picks ${Math.round(expectAuto * 100)} % for this window (${k.app}, css zoom ${k.css})`);
  const btnBox = () => E(() => { const b = document.querySelector('[data-action="new"]'), r = b.getBoundingClientRect(); return { h: r.height, own: b.offsetHeight, font: parseFloat(getComputedStyle(b).fontSize) }; });
  let bb = await btnBox();
  ok(Math.abs(bb.h - bb.own * expectAuto) < 1.5, `a title button is drawn ${expectAuto}× its own size (${bb.h.toFixed(1)} px for ${bb.own})`);
  if (expectAuto > 1) ok(bb.font * expectAuto >= 20, `title menu text is at least 20 px on screen (${(bb.font * expectAuto).toFixed(1)})`);
  ok((await offscreen()).length === 0, 'nothing on the title screen leaves the window: ' + (await offscreen()).join(' | '));
  await shot(page, `scale-${tag}-title`);

  // the setting: Auto, fixed sizes, and the limit
  await page.click('[data-action="settings"]');
  await page.waitForSelector('[data-role="ui-scale"]');
  ok(await page.locator('[data-setting="uiScale"]').count() === 8, 'Settings has an "Interface size" row: Auto and seven sizes from 80 % to 175 %');
  ok(await page.locator('[data-setting="uiScale"][data-v="auto"].on').count() === 1, 'Auto is the default');
  await page.click('[data-setting="uiScale"][data-v="0.8"]');
  k = await scale();
  ok(Math.abs(k.css - 0.8) < 0.001, `80 % applies at once (css zoom ${k.css})`);
  await page.waitForTimeout(150);
  const nowText = await page.locator('[data-role="ui-scale-now"]').innerText();
  ok(/now 80\s*%/i.test(nowText), 'the row says what is in effect: "' + nowText + '"');
  ok((await E(() => JSON.parse(localStorage.getItem('starwright.settings.v1')).uiScale)) === 0.8, 'and it is remembered');
  await page.click('[data-setting="uiScale"][data-v="1.75"]');
  k = await scale();
  const room = Math.max(1, Math.min(1.75, Math.floor(Math.min(width / 1280, height / 720) * 20) / 20));
  ok(Math.abs(k.css - room) < 0.001, `175 % gives ${Math.round(room * 100)} % here: a bigger interface never gets less than 1280 × 720 of its own pixels (${k.css})`);
  if (room < 1.75) ok(/most this window has room for/i.test(await page.locator('[data-role="ui-scale-now"]').innerText()), 'and the row says the window limits it');
  ok((await offscreen()).length === 0, 'the settings dialog stays inside the window at the largest size: ' + (await offscreen()).join(' | '));
  await page.click(`[data-setting="uiScale"][data-v="${pickSize}"]`);
  k = await scale();
  const K = k.css;
  ok(Math.abs(K - (pickSize === 'auto' ? expectAuto : Number(pickSize))) < 0.001, `the rest of this run uses ${Math.round(K * 100)} %`);
  await closeModal(page);

  // Flight Center: labels sit on their buildings, never on each other; the pointer picks what it points at
  await newGame(page, 'sandbox');
  // a software rasteriser draws this window slowly: let the picture and the overlays catch up before measuring
  const settle = async (n = 4) => { await E(k => new Promise(r => { const step = () => (k-- > 0 ? requestAnimationFrame(step) : r()); step(); }), n); };
  await page.waitForTimeout(600); await settle(6);
  const pinState = () => hubDebug(page, d => {
    const out = [], v = d.view, P = new (v.buildings[0].focus.constructor)();
    for (const b of v.buildings) {
      const n = document.querySelector(`.sw-pin[data-building="${b.id}"]`);
      if (!n || n.classList.contains('off') || +getComputedStyle(n).opacity < 0.05) continue;
      P.set(b.focus.x, b.focus.y * 2 + 6, b.focus.z);
      const q = v.project(P, {}), i = n.querySelector('i').getBoundingClientRect(), s = n.querySelector('span').getBoundingClientRect();
      out.push({ id: b.id, px: q.x, py: q.y, ix: i.left + i.width / 2, iy: i.top + i.height / 2, l: s.left, t: s.top, r: s.right, b: s.bottom });
    }
    return out;
  });
  const overlaps = pins => { const hit = []; for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) { const a = pins[i], b = pins[j]; if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) hit.push(a.id + '/' + b.id); } return hit; };
  let pins = await pinState();
  ok(pins.length >= 5, `the Flight Center shows its building labels (${pins.length})`);
  let off = pins.filter(p => Math.hypot(p.ix - p.px, p.iy - p.py) > 9 * K);
  ok(off.length === 0, 'each label\'s marker sits on its building: ' + off.map(p => `${p.id} ${Math.round(p.ix - p.px)},${Math.round(p.iy - p.py)}`).join(' '));
  let allOver = overlaps(pins).map(x => 'home ' + x);
  for (const [name, view] of [['low east', { az: 0.4, el: 0.2, dist: 1500 }], ['low west', { az: 2.6, el: 0.22, dist: 1700 }], ['south', { az: -1.5, el: 0.3, dist: 1300 }], ['north far', { az: 1.6, el: 0.25, dist: 2200 }]]) {
    await hubDebug(page, (d, v) => d.view.flyTo(v, { snap: true }), view);
    await settle();
    pins = await pinState();
    allOver.push(...overlaps(pins).map(x => name + ' ' + x));
    off = pins.filter(p => Math.hypot(p.ix - p.px, p.iy - p.py) > 9 * K);
    if (off.length) allOver.push(name + ' marker off ' + off.map(p => p.id).join(','));
  }
  ok(allOver.length === 0, 'from five camera positions no two building labels overlap and every marker stays on its building: ' + allOver.join(' | '));
  await shot(page, `scale-${tag}-hub`);
  // every building is picked at the very point the camera looks at when it flies there (the Flight School's was a gap between its halls)
  const missed = [];
  for (const id of BUILDINGS) {
    await hubDebug(page, (d, b) => d.view.flyTo(b, { snap: true }), id);
    await page.waitForTimeout(200);
    const got = await hubDebug(page, (d, b) => { const { w, h } = window.__sw.app.size; return d.view.pick(w / 2, h / 2); }, id);
    if (got !== id) missed.push(id + '→' + got);
  }
  ok(missed.length === 0, 'the point the camera looks at picks the building, for all ten: ' + missed.join(' '));
  // real mouse on the Flight School: name plate, then a click opens it
  const pt = await hoverBuilding(page, 'school');
  await settle();
  ok(!!pt, 'the pointer finds the Flight School');
  // the plate follows the picture on screen (which may trail the camera on a slow machine), so compare with the same projection
  const plate = await hubDebug(page, d => {
    const p = document.querySelector('[data-role="plate"]'); if (!p || p.classList.contains('sw-hidden')) return null;
    const r = p.getBoundingClientRect(), b = d.view.byId.school, P = b.focus.clone(); P.y = b.focus.y * 2 + 6;
    const q = d.view.project(P, {});
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, text: p.innerText, px: q.x, py: q.y, vis: q.visible };
  });
  ok(plate && /flight school/i.test(plate.text), 'hovering it shows its name plate');
  if (plate && plate.vis) {
    const ex = Math.max(150 * K, Math.min(width - 150 * K, plate.px)), ey = Math.max(196 * K, Math.min(height - 120 * K, plate.py));
    ok(plate.l >= -1 && plate.t >= -1 && plate.r <= width + 1 && plate.b <= height + 1 && Math.abs((plate.l + plate.r) / 2 - ex) < 8 * K && Math.abs(plate.b - (ey - 20 * K)) < 10 * K,
      `the plate stands over the building as drawn, inside the window (plate ${Math.round(plate.l)},${Math.round(plate.t)} to ${Math.round(plate.r)},${Math.round(plate.b)}; building at ${Math.round(ex)},${Math.round(ey)})`);
  }
  if (pt) { await page.mouse.click(pt.x, pt.y); await waitScreen(page, 'guide'); ok(await screenName(page) === 'guide', 'clicking the Flight School opens it'); await E(() => window.__sw.app.goto('hub')); await waitScreen(page, 'hub'); }

  // tooltip: over its target, inside the window
  await E(() => window.__sw.app.goto('research')); await waitScreen(page, 'research');
  ok((await offscreen()).length === 0, 'Research and Development fits the window: ' + (await offscreen()).join(' | '));
  const tipCheck = await E(async () => {
    const n = [...document.querySelectorAll('.sw-node[data-tech]')].filter(e => e.getBoundingClientRect().width > 10)[2];
    if (!n) return { none: true };
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: r.left + 5, clientY: r.top + 5 })); n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
    await new Promise(q => setTimeout(q, 700));
    const tip = [...document.querySelectorAll('.sw-node-tip.show')].find(e => e.getBoundingClientRect().width > 10);
    if (!tip) return { none: true };
    const t = tip.getBoundingClientRect();
    return { n: [r.left, r.top, r.right, r.bottom], t: [t.left, t.top, t.right, t.bottom] };
  });
  if (tipCheck.none) console.log('  (no tech tip to measure)');
  else ok(tipCheck.t[0] >= -1 && tipCheck.t[2] <= width + 1 && tipCheck.t[1] >= -1 && tipCheck.t[3] <= height + 1 && Math.abs((tipCheck.t[0] + tipCheck.t[2]) / 2 - (tipCheck.n[0] + tipCheck.n[2]) / 2) < 200 * K && (Math.abs(tipCheck.t[1] - tipCheck.n[3]) < 24 * K || Math.abs(tipCheck.t[3] - tipCheck.n[1]) < 24 * K),
    `a tech node's card opens right beside the node (node ${tipCheck.n.map(Math.round)}, card ${tipCheck.t.map(Math.round)})`);

  // Tracking Station: the map's drawing fills the window, labels sit on their bodies, a click picks the body under it
  inForeign = true;
  await E(() => window.__sw.app.goto('tracking')); await waitScreen(page, 'tracking');
  await page.waitForFunction(() => { const m = window.__sw.app.screens.tracking.map; return m && m.debug && Object.keys(m.debug().bodies).length > 3; }, null, { timeout: 120000 });
  await page.waitForTimeout(800);
  ok(await page.locator('.map-focusbar [data-map="vessel"]:not(.sw-hidden)').count() === 0, 'with no vessel anywhere the focus bar has no "Vessel" button');
  ok(await page.locator('.map-focusbar [data-map="inner"]:not(.sw-hidden)').count() === 1, 'the other focus buttons are there');
  const mapGeo = await E(() => {
    const m = window.__sw.app.screens.tracking.map, d = m.debug(), c = document.querySelector('.map-canvas'), r = c.getBoundingClientRect();
    const labels = [...document.querySelectorAll('.map-label.body')].filter(e => e.style.display !== 'none').map(e => { const q = e.getBoundingClientRect(); return { text: e.textContent.trim().toLowerCase(), x: q.left + q.width / 2, y: q.top + q.height / 2, h: q.height }; });
    const names = Object.fromEntries(Object.keys(d.bodies).map(id => [window.__sw.app.screens.tracking.map && id, id]));
    return { canvas: [r.left, r.top, r.width, r.height, c.width, c.height], bodies: d.bodies, labels, focus: d.focus, names };
  });
  ok(Math.abs(mapGeo.canvas[0]) < 1 && Math.abs(mapGeo.canvas[1]) < 1 && Math.abs(mapGeo.canvas[2] - width) < 1.5 && Math.abs(mapGeo.canvas[3] - height) < 1.5, `the map drawing covers the window exactly (${mapGeo.canvas.slice(0, 4).map(Math.round)})`);
  ok(Math.abs(mapGeo.canvas[4] - width * Math.min(dsf, 2)) <= 2, `and has one canvas pixel per device pixel (${mapGeo.canvas[4]} wide)`);
  const lab = mapGeo.labels.map(l => { const id = Object.keys(mapGeo.bodies).find(b => b === l.text); return id ? { ...l, id, d: Math.hypot(l.x - mapGeo.bodies[id].x, l.y - mapGeo.bodies[id].y), r: mapGeo.bodies[id].r } : null; }).filter(Boolean);
  ok(lab.length >= 1, `body labels are on the map (${mapGeo.labels.map(l => l.text).join(', ')})`);
  const far = lab.filter(l => l.d > l.r + 60 * K + 30);
  ok(far.length === 0, 'each body label sits by its body: ' + far.map(l => `${l.id} ${Math.round(l.d)} px away`).join(', '));
  if (K > 1.05 && lab.length) ok(lab.every(l => l.h >= 10 * K), `map labels grow with the interface (${lab[0].h.toFixed(1)} px tall)`);
  // click a body that is clear of the panels
  const target = await E(() => {
    const d = window.__sw.app.screens.tracking.map.debug(), c = window.__sw.app.canvas;
    for (const [id, q] of Object.entries(d.bodies)) { if (!q.visible || id === d.focus) continue; if (q.x < 10 || q.y < 10 || q.x > innerWidth - 10 || q.y > innerHeight - 10) continue; const top = document.elementFromPoint(q.x, q.y); if (top === c || (top && top.closest('.map-root') && !top.closest('.map-panel, .sw-panel, button'))) return { id, x: q.x, y: q.y }; }
    return null;
  });
  if (target) {
    await page.mouse.move(target.x - 4, target.y - 3); await page.mouse.move(target.x, target.y); await page.waitForTimeout(400);
    await page.mouse.click(target.x, target.y); await page.waitForTimeout(700);
    const sel = await E(() => { const d = window.__sw.app.screens.tracking.map.debug(); return d.selection ? d.selection.id : null; });
    ok(sel === target.id, `clicking ${target.id} where it is drawn selects ${target.id} (got ${sel})`);
  } else console.log('  (no body clear of the panels to click)');
  ok((await offscreen()).length === 0, 'the Tracking Station panels fit the window: ' + (await offscreen()).join(' | '));
  await shot(page, `scale-${tag}-tracking`);
  inForeign = false;

  // Assembly: the pointer picks the part under it
  inForeign = true;
  await E(() => { window.__sw.app.goto('builder', {}); });
  await page.waitForFunction(() => window.__sw.app.currentName === 'builder' && window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
  await E(() => { const b = document.querySelector('[data-action="hint-ok"]'); if (b) b.click(); });
  await E(async () => { const m = await import('/js/core/craft.js'); window.__sw.app.builder.loadCraft(m.stockCrafts().find(x => x.name === 'Hopper I').toJSON()); });
  await page.waitForTimeout(1500);
  const bpart = await E(() => { const b = window.__sw.app.builder, c = b.craft; const p = c.parts.find(q => q.type === 'srb_ember'); return { id: p.id, pos: b.partScreenPos(p.id, 0, 0), view: b.viewRect }; });
  ok(bpart.pos.x > bpart.view.left && bpart.pos.x < bpart.view.right && bpart.pos.y > bpart.view.top && bpart.pos.y < bpart.view.bottom, `the rocket stands in the free view between the panels (booster at ${Math.round(bpart.pos.x)},${Math.round(bpart.pos.y)}; view ${Math.round(bpart.view.left)}..${Math.round(bpart.view.right)})`);
  ok(Math.abs(bpart.pos.x - bpart.view.cx) < 40 * K + 20, `centred in it (${Math.round(bpart.pos.x)} vs ${Math.round(bpart.view.cx)})`);
  await page.mouse.move(bpart.pos.x - 5, bpart.pos.y - 5); await page.mouse.move(bpart.pos.x, bpart.pos.y, { steps: 3 });
  await page.waitForFunction(id => window.__sw.app.builder.hover === id, bpart.id, { timeout: 20000 }).catch(() => {});
  ok(await E(() => window.__sw.app.builder.hover) === bpart.id, 'the pointer over the booster highlights the booster');
  ok((await offscreen()).length === 0, 'the assembly panels fit the window: ' + (await offscreen()).join(' | '));
  await shot(page, `scale-${tag}-builder`);
  inForeign = false;

  // Flight: HUD inside the window, navball overlay on the ball, throttle bar hit where it is clicked, pop-over panel placed
  inForeign = true;
  await E(async () => { const m = await import('/js/core/craft.js'); const a = window.__sw.app; await a.goto('flight', { craft: m.stockCrafts().find(x => x.name === 'Skylark II').toJSON(), crew: [a.career.roster[0].name] }); });
  await page.waitForFunction(() => window.__sw.app.currentName === 'flight' && window.__sw.app.current && window.__sw.app.flight && window.__sw.app.flight.hud, null, { timeout: 240000 });
  await page.waitForTimeout(2500);
  ok((await offscreen()).length === 0, 'the flight HUD fits the window: ' + (await offscreen()).join(' | '));
  const nav = await E(() => { const h = window.__sw.app.flight.hud; h.invalidate(); const r = h.ballRect(), o = h.overlay.getBoundingClientRect(); return { r, o: [o.left, o.top, o.width, o.height], px: h.overlay.width, dpr: Math.min(window.devicePixelRatio, 2) }; });
  ok(nav.r && Math.abs(nav.r.x - nav.o[0]) <= 1.5 && Math.abs(nav.r.y - nav.o[1]) <= 1.5 && Math.abs(nav.r.size - nav.o[2]) <= 1.5, `the navball's drawn rectangle is the overlay's rectangle (${JSON.stringify(nav.r)} vs ${nav.o.map(Math.round)})`);
  ok(nav.r && Math.abs(nav.px - nav.r.size * nav.dpr) <= 2, `the navball overlay has one canvas pixel per device pixel (${nav.px} for ${nav.r && nav.r.size} css px)`);
  ok(nav.r && nav.r.x >= 0 && nav.r.y >= 0 && nav.r.x + nav.r.size <= width && nav.r.y + nav.r.size <= height, 'the navball is inside the window');
  const bar = await E(() => { const r = document.querySelector('.fl-thr-bar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.25 }; });
  await page.mouse.click(bar.x, bar.y); await page.waitForTimeout(300);
  const thr = await E(() => window.__sw.app.flight.world.active.ctrl.throttle);
  ok(Math.abs(thr - 0.75) < 0.06, `clicking a quarter of the way down the throttle bar sets 75 % (${Math.round(thr * 100)} %)`);
  await page.keyboard.press('KeyX');
  await page.keyboard.press('KeyO');
  await page.waitForFunction(() => !!document.querySelector('.fl-pop[data-panel="missions"]'), null, { timeout: 60000 });
  await page.waitForTimeout(400);
  const pop = await E(() => { const q = s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }; return { p: q('.fl-pop[data-panel="missions"]'), c: q('.fl-console, [data-hud="console"]') }; }).catch(() => null);
  if (pop) ok(pop.p[0] >= 0 && pop.p[1] >= 0 && pop.p[2] <= width + 1 && pop.p[3] <= height + 1 && (pop.p[3] <= pop.c[1] + 1 || pop.p[0] >= pop.c[2] - 1 || pop.p[2] <= pop.c[0] + 1), `the Missions pop-over is inside the window and clear of the console (${pop.p.map(Math.round)})`);
  else ok(await page.locator('.fl-pop[data-panel="missions"]').count() === 1, 'the Missions pop-over opens');
  await shot(page, `scale-${tag}-flight`);
  inForeign = false;
  await ctx.close();
}

async function runNoWebGL() {
  console.log('\n=== no WebGL ===');
  const { ctx, page } = await newPage(1280, 720);
  await ctx.addInitScript(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/i.test(type) ? null : get.call(this, type, ...rest); }; });
  const before = problems.length;
  await boot(page);
  ok(await page.evaluate(() => window.__sw.app.renderer === null), 'the game boots without a WebGL renderer');
  await newGame(page, 'career');
  ok(await page.locator('.sw-hub.no3d').count() === 1 && await page.locator('[data-role="fallback"]').count() === 1, 'without WebGL the hub falls back to a plain list of buildings');
  ok(await page.locator('.sw-dock .sw-card').count() === 10, 'the fallback hub keeps the quick bar');
  await shot(page, 'nowebgl-hub');
  await page.click('.sw-card[data-goto="research"]');
  await waitScreen(page, 'research');
  await backToHub(page);
  await page.keyboard.press('Digit2');
  await page.waitForSelector('.sw-launch[data-site="pad"]');
  ok(true, 'the fallback hub still opens buildings by click and by key');
  // three.js logs its own "could not create a WebGL context" errors here; they are expected in this run only
  for (let i = problems.length - 1; i >= before; i--) if (/WebGL|webgl/.test(problems[i]) && !/^FAILED/.test(problems[i])) problems.splice(i, 1);
  await ctx.close();
}

try {
  const only = (process.env.ONLY || '').split(',').map(x => x.trim()).filter(Boolean);       // ONLY=scale while iterating; the default runs everything
  const want = name => !only.length || only.includes(name);
  if (want('main')) { await run(1440, 900, 'w1440'); await run(1280, 720, 'w1280'); }
  if (want('scale') || want('scale4k')) await runScale(2560, 1440, 1, 'w2560', { expectAuto: 1.6, pickSize: 'auto' });
  if (want('scale') || want('scale2x')) await runScale(1440, 900, 2, 'dpr2', { expectAuto: 1, pickSize: '0.8' });
  if (want('main') || want('nowebgl')) await runNoWebGL();
} catch (err) {
  problems.push('test crashed: ' + (err.stack || err));
} finally {
  await browser.close();
  await server.close();
}

if (foreign.length) {
  console.log(`\n${foreign.length} error(s) raised inside screens owned by other modules (not failing this test; STRICT=1 makes them fail):`);
  for (const p of [...new Set(foreign)]) console.log(' ~ ' + p);
}
console.log(`\n${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log(' - ' + p);
process.exit(problems.length ? 1 : 0);
