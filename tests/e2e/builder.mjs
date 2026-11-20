// End-to-end test of the assembly buildings (js/ui/builder.js): drives the real game with real mouse and keyboard
// input and checks the resulting Craft through app.builder.
//   node tests/e2e/builder.mjs [only=<section>]      (screenshots land in tests/out/builder-*.png)
// Sections: bin, root, nodes, surface, mirror, subassembly, reroot, gizmos, staging, info, camera, launch, runway, career
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const only = (process.argv.find(a => a.startsWith('only=')) || '').slice(5).split(',').filter(Boolean);

const problems = [];
let checks = 0, failed = 0;
function ok(cond, what) { checks++; if (!cond) { failed++; problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);            // software GL on a busy machine can drop to a frame every few seconds
page.on('console', m => {
  if (m.type() !== 'error') return;
  if (/GL Driver Message|GPU stall/.test(m.text())) return;
  const loc = m.location()?.url || '';
  problems.push('console error: ' + m.text() + (loc ? ' @ ' + loc : ''));
});
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));

const shot = name => page.screenshot({ path: path.join(OUT, 'builder-' + name + '.png'), timeout: 120000 }).catch(e => console.log('  (screenshot ' + name + ' skipped: ' + e.message.split('\n')[0] + ')'));
const B = (fn, arg) => page.evaluate(fn, arg);
const frames = (n = 2) => page.evaluate(k => new Promise(r => { const step = () => (k-- > 0 ? requestAnimationFrame(step) : r()); step(); }), n);
const api = (prop) => B(p => window.__sw.app.builder[p], prop);
const craftInfo = () => B(() => {
  const c = window.__sw.app.builder.craft;
  return { name: c.name, root: c.root ? c.root.id : null, auto: c.autoStaging,
    parts: c.parts.map(p => ({ id: p.id, type: p.type, node: p.node, parent: p.parent, sym: p.sym, rot: p.rot, x: p.pos.x, y: p.pos.y, z: p.pos.z })),
    stages: c.stages.map(s => s.slice()) };
});
const partOf = (info, type, k = 0) => info.parts.filter(p => p.type === type)[k];
const posOf = (id, fy = 0, side = 0) => B(([i, f, s]) => window.__sw.app.builder.partScreenPos(i, f, s), [id, fy, side]);
const tap = async sel => { await page.waitForSelector(sel); await B(q => document.querySelector(q).click(), sel); };
async function waitScreen(name) {
  await page.waitForFunction(n => window.__sw && window.__sw.app.currentName === n && window.__sw.app.current, name);
}
async function settle() {    // let the camera glide finish
  await page.waitForFunction(() => { const c = window.__sw.app.builder.camera; return Math.abs(c.dist - c.tdist) < 0.03 && Math.abs(c.ty - c.tty) < 0.03 && Math.abs(c.fx - c.tfx) < 0.03 && Math.abs(c.yaw - c.tyaw) < 0.005 && Math.abs(c.pitch - c.tpitch) < 0.005; });
  await frames(2);
}
async function enterBuilder(params) {
  await B(p => { window.__sw.app.goto('builder', p); }, params || {});
  await page.waitForFunction(() => window.__sw.app.currentName === 'builder' && window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
  await B(() => { const b = document.querySelector('[data-action="hint-ok"]'); if (b) b.click(); });
  await settle();
}
async function pickCard(cat, type) {
  await tap(`.bld-cat[data-cat="${cat}"]`);
  await page.waitForSelector(`.bld-card[data-part="${type}"]`);
  await page.locator(`.bld-card[data-part="${type}"]`).scrollIntoViewIfNeeded();
  await page.click(`.bld-card[data-part="${type}"]`);
  return ok(await api('held') === type, `clicking the ${type} card in the bin picks it up`);
}
const pick = type => B(t => window.__sw.app.builder.pick(t), type);
async function hoverAt(p) {
  await page.mouse.move(p.x, p.y, { steps: 3 }); await frames(2);
  if (!await B(q => document.elementFromPoint(q.x, q.y) === window.__sw.app.canvas, p)) problems.push(`pointer at ${Math.round(p.x)},${Math.round(p.y)} is not over the 3D view`);
  return api('placement');
}
async function clickAt(p) { await page.mouse.click(p.x, p.y); await frames(2); await settle(); }
async function drag(a, b, { button = 'left', steps = 8 } = {}) {
  await page.mouse.move(a.x, a.y); await page.mouse.down({ button });
  await page.mouse.move(b.x, b.y, { steps }); await frames(1);
  await page.mouse.up({ button }); await frames(2);
}
const nodeOf = async (partId, node) => (await api('nodes')).find(n => n.partId === partId && n.node === node);
/** A point of the part that the pointer really hits (other parts may overlap it on screen). */
async function pointOn(id, tries = [[0, 0], [0.1, -0.3], [-0.1, 0.3], [0.25, -0.55], [-0.3, 0.55], [0.5, 0], [-0.5, 0]]) {
  for (const [fy, side] of tries) {
    const p = await posOf(id, fy, side);
    await page.mouse.move(p.x, p.y, { steps: 2 }); await frames(2);
    if (await api('hover') === id) return p;
  }
  return null;
}
const pause = ms => page.waitForTimeout(ms);
const stockJSON = name => B(async n => { const m = await import('/js/core/craft.js'); const c = m.stockCrafts().find(x => x.name === n); return c ? c.toJSON() : null; }, name);

const sections = [];
const section = (name, fn) => sections.push([name, fn]);
let view = null;

// =============================================================================================
section('bin', async () => {
  ok(await api('usingPartMeshes'), 'part meshes come from js/render/partmesh.js');
  const cats = await B(async () => { const m = await import('/js/core/parts.js'); return m.CATEGORIES.filter(c => c.id !== 'internal' && m.PART_LIST.some(d => d.cat === c.id)).map(c => c.id); });
  const tabs = await page.$$eval('.bld-cat', l => l.map(b => b.dataset.cat));
  ok(JSON.stringify(tabs) === JSON.stringify(cats), `category tabs follow CATEGORIES at run time (${tabs.length} tabs)`);
  ok(await page.$$eval('.bld-cat svg', l => l.length) === tabs.length, 'every category tab has an icon');
  let total = 0;
  for (const c of cats) { await tap(`.bld-cat[data-cat="${c}"]`); total += await page.locator('.bld-card').count(); }
  const listed = await B(async () => (await import('/js/core/parts.js')).PART_LIST.filter(d => d.cat !== 'internal').length);
  ok(total === listed && total >= 40, `the bin lists every part of the catalogue (${total})`);
  await tap(`.bld-cat[data-cat="${cats[0]}"]`);
  await page.waitForFunction(() => window.__sw.app.builder.ready);
  ok(await page.$$eval('.bld-card canvas.bld-thumb', l => l.length > 0 && l.every(c => c.dataset.ready === '1')), 'cards show rendered 3D thumbnails');
  const painted = await page.$eval('.bld-card canvas.bld-thumb', c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n / (d.length / 4); });
  ok(painted > 0.04, `a thumbnail really contains a drawn part (${(painted * 100).toFixed(0)}% covered)`);
  await page.hover('.bld-card'); await pause(700);
  ok(await page.locator('.sw-tooltip .bld-tip dl dt').count() >= 3, 'hovering a card shows a tooltip with its statistics');
  await page.mouse.move(700, 500);
  await page.fill('.bld-search', 'fin');
  const names = await page.$$eval('.bld-card', l => l.map(c => c.dataset.part));
  ok(names.length >= 2 && names.includes('fin'), `search finds parts across categories (${names.length} for "fin")`);
  await page.fill('.bld-search', '');
  await tap('.bld-cat[data-cat="tanks"]');
  await page.selectOption('.bld-sort', 'cost');
  const costs = await B(async () => { const m = await import('/js/core/parts.js'); return [...document.querySelectorAll('.bld-card:not(.locked)')].map(c => m.PARTS[c.dataset.part].cost); });
  ok(costs.length > 3 && costs.every((c, i) => i === 0 || c >= costs[i - 1]), 'sorting by cost orders the cards');
  await page.selectOption('.bld-sort', '');
  ok(await page.locator('.bld-tool[data-tool]').count() === 5 && await page.locator('.bld-tool[data-tool="action"]').count() === 1 && await page.locator('.bld-tool[data-tool="place"].active').count() === 1, 'tool strip offers place / move / rotate / re-root / action groups, place active');
});

// ---- owner feedback 1: the first part hangs in mid-air where it is put, and stays there
section('root', async () => {
  await B(() => window.__sw.app.builder.newCraft());
  view = await api('viewRect');
  await pickCard('command', 'pod_acorn');
  const P = { x: view.cx + 30, y: view.cy - 70 };
  const pl = await hoverAt(P);
  ok(pl && pl.state === 'valid' && pl.action.kind === 'root', 'an empty hall accepts the first part anywhere in the air');
  const hv = await api('heldView');
  ok(hv && hv.visible && Math.hypot(hv.x - P.x, hv.y - P.y) < 12, 'the held part is drawn under the pointer');
  await clickAt(P);
  const c = await craftInfo();
  ok(c.parts.length === 1 && c.parts[0].node === 'root' && await api('held') === null, 'clicking places it as the root part');
  await settle();
  const sp = await posOf(c.parts[0].id), o1 = await api('origin'), cl = await api('clearance');
  ok(Math.hypot(sp.x - P.x, sp.y - P.y) < 30, `the root stays where it was put (${Math.round(Math.hypot(sp.x - P.x, sp.y - P.y))} px from the click)`);
  ok(cl > 3, `it hangs in mid-air, not on the floor (${cl.toFixed(1)} m of clearance)`);
  await pause(900); await frames(2);
  const o2 = await api('origin');
  ok(near(o1.y, o2.y, 1e-6) && near(await api('clearance'), cl, 1e-6), 'and it does not sink afterwards');
  await shot('01-root');
});

// ---- owner feedback 2 + 3: open nodes are shown, the target node lights up, parts attach below and above
section('nodes', async () => {
  let c = await craftInfo(); const pod = c.parts[0];
  await page.mouse.move(view.right - 60, view.top + 60); await frames(2);
  let marks = await api('markers');
  ok(marks.filter(m => m.partId === pod.id && m.state === 'idle').length === 2 && await api('markersDrawn') === 2, 'with nothing held the open top and bottom nodes of the root are marked');
  await pickCard('tanks', 'tank_m200');
  let pl = await hoverAt({ x: view.right - 70, y: view.top + 70 });
  marks = await api('markers');
  ok(pl && pl.state === 'free', 'away from the craft the held part floats free');
  ok(marks.filter(m => m.state === 'ok').length === 2 && !marks.some(m => m.state === 'snap'), 'holding a stack part highlights every compatible open node (top and bottom)');
  ok(marks.filter(m => m.state === 'held').length === 2, 'the held part shows its own two nodes');
  const snaps0 = await api('snapCount');
  const nb = await nodeOf(pod.id, 'bottom');
  pl = await hoverAt({ x: nb.x + 8, y: nb.y + 46 });
  marks = await api('markers');
  ok(pl && pl.state === 'valid' && pl.action.kind === 'stack' && pl.action.node === 'bottom' && pl.action.target === pod.id, 'near the bottom node the held tank snaps to it');
  ok(pl && pl.node && pl.node.partId === pod.id && pl.node.node === 'bottom' && marks.filter(m => m.state === 'snap').length === 1 && marks.find(m => m.state === 'snap').node === 'bottom', 'exactly that node switches to the snap highlight');
  const hv = await api('heldView');
  const want = await B(async id => { const b = window.__sw.app.builder, m = await import('/js/core/parts.js'); const p = b.craft.getPart(id); return p.pos.y - m.PARTS[p.type].h / 2 - m.PARTS.tank_m200.h / 2; }, pod.id);
  ok(hv && hv.visible && near(hv.pos.y, want, 1e-6) && near(hv.pos.x, 0, 1e-6), 'a ghost of the tank sits exactly at the snapped position (not under the pointer)');
  await shot('02-snap-below');
  await clickAt({ x: nb.x + 8, y: nb.y + 46 });
  c = await craftInfo();
  const tank = partOf(c, 'tank_m200');
  ok(c.parts.length === 2 && tank && tank.node === 'bottom' && tank.parent === pod.id, 'clicking attaches it BELOW the root');
  ok(await api('snapCount') === snaps0 + 1, 'the attachment plays the snap (ring flash and sound)');
  ok(await api('clearance') > 1.5, 'the craft is still hanging clear of the floor');
  // above
  await pickCard('utility', 'chute');
  const nt = await nodeOf(pod.id, 'top');
  pl = await hoverAt({ x: nt.x, y: nt.y - 16 });
  ok(pl && pl.state === 'valid' && pl.action.node === 'top' && pl.action.target === pod.id, 'the parachute snaps to the top node');
  await clickAt({ x: nt.x, y: nt.y - 16 });
  c = await craftInfo();
  ok(partOf(c, 'chute') && partOf(c, 'chute').node === 'top' && partOf(c, 'chute').y > pod.y, 'and attaches ABOVE the root');
  // an engine under the tank, by pointing at the lower part of the tank itself
  await pickCard('engines', 'eng_sparrow');
  const low = await posOf(tank.id, -0.7, 0);
  pl = await hoverAt(low);
  ok(pl && pl.state === 'valid' && pl.action.target === tank.id && pl.action.node === 'bottom', 'pointing at the lower third of a part targets its bottom node');
  await clickAt(low);
  c = await craftInfo();
  ok(c.parts.length === 4 && partOf(c, 'eng_sparrow').parent === tank.id, 'the engine hangs below the tank');
  // a part that does not fit: a second parachute has no node to go to
  await pick('chute');
  pl = await hoverAt(await posOf(tank.id, 0, 0));
  ok(pl && pl.state !== 'valid', 'a part with nowhere to go is not offered an attachment');
  await page.keyboard.press('Escape'); await frames(1);
  ok(await api('held') === null, 'Esc drops the held part');
});

// ---- surface attachment, radial symmetry, node-only snapping, turning the held part
section('surface', async () => {
  let c = await craftInfo(); const tank = partOf(c, 'tank_m200');
  await pickCard('aero', 'fin');
  await page.keyboard.press('x'); await page.keyboard.press('x');
  ok(await api('symmetry') === 3 && await page.$eval('.bld-sym', b => b.dataset.count) === '3', 'X steps symmetry up to 3');
  const p = await posOf(tank.id, -0.45, 0.3);
  let pl = await hoverAt(p);
  ok(pl && pl.state === 'valid' && pl.action.kind === 'radial' && pl.count === 3, 'a fin over the tank side previews a surface mount ×3');
  ok((await api('heldView')).ghosts === 2, 'the two symmetric copies are shown as ghosts');
  ok((await api('markers')).filter(m => m.state === 'snap').length === 3, 'each copy shows its contact point');
  await shot('03-surface-sym3');
  await page.keyboard.down('Alt'); await page.mouse.move(p.x + 1, p.y); await frames(2);
  pl = await api('placement');
  ok(pl && pl.state !== 'valid', 'holding Alt switches surface attachment off (node snapping only)');
  await page.keyboard.up('Alt'); await frames(2);
  await clickAt(p);
  c = await craftInfo();
  const fins = c.parts.filter(q => q.type === 'fin');
  ok(fins.length === 3 && fins.every(f => f.node === 'radial' && f.parent === tank.id && f.sym === fins[0].sym && f.sym > 0), 'three fins are attached as one symmetry group');
  const angs = fins.map(f => Math.atan2(-f.z, f.x)).sort((a, b) => a - b);
  ok(near(angs[1] - angs[0], 2 * Math.PI / 3, 1e-6) && near(angs[2] - angs[1], 2 * Math.PI / 3, 1e-6), 'spaced 120° apart round the tank');
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  ok(fins.every(f => Math.abs(wrap(f.rot - Math.atan2(-f.z, f.x))) < 1e-6), 'each fin faces outward from the surface it sits on');
  ok(fins.every(f => near(Math.hypot(f.x, f.z), Math.hypot(fins[0].x, fins[0].z), 1e-6) && Math.hypot(f.x, f.z) > 0.62), 'and sits on the surface, not inside the tank');
  const deg = fins[0].rot * 180 / Math.PI;
  ok(near(deg, Math.round(deg / 15) * 15, 1e-6), 'angle snap keeps the mount on a 15° step');
  await page.keyboard.press('c');
  ok(await api('snap') === false, 'C switches angle snap off');
  await page.keyboard.press('c');
  await page.keyboard.press('Shift+X');
  ok(await api('symmetry') === 2, 'Shift+X steps symmetry back down');
  // turning a held stack part in 90° steps
  await pick('tank_s50');
  await page.keyboard.press('q');
  ok(near(await api('heldTurn'), Math.PI / 2, 1e-9), 'Q turns the held part 90° about its axis');
  await page.keyboard.press('Shift+E');
  ok(near(await api('heldTurn'), Math.PI / 2 - 5 * Math.PI / 180, 1e-9), 'Shift+E turns it back by a fine 5° step');
  await page.keyboard.press('Escape');
  await B(() => window.__sw.app.builder.setSymmetry(1));
});

section('mirror', async () => {
  let c = await craftInfo(); const tank = partOf(c, 'tank_m200');
  await page.keyboard.press('r');
  ok(await api('symMode') === 'mirror' && await page.$eval('[data-action="sym-mode"]', b => b.dataset.mode) === 'mirror', 'R switches to mirror symmetry');
  await page.keyboard.press('x');
  ok(await api('symmetry') === 2, 'in mirror mode X toggles the mirrored copy on');
  await pickCard('utility', 'solar');
  const p = await posOf(tank.id, 0.55, 0.45);
  const pl = await hoverAt(p);
  ok(pl && pl.state === 'valid' && pl.count === 2 && (await api('heldView')).ghosts === 1, 'a surface part previews itself and its mirror image');
  await clickAt(p);
  c = await craftInfo();
  const s = c.parts.filter(q => q.type === 'solar');
  ok(s.length === 2 && s[0].sym === s[1].sym && s[0].sym > 0, 'two panels are attached as a pair');
  ok(s.length === 2 && near(s[0].x, -s[1].x, 1e-6) && near(s[0].z, s[1].z, 1e-6) && near(s[0].y, s[1].y, 1e-6) && Math.abs(s[0].x) > 0.05, 'mirrored left / right across the craft centre plane');
  await page.keyboard.press('r');
  ok(await api('symMode') === 'radial', 'R switches back to radial symmetry');
  await B(() => window.__sw.app.builder.setSymmetry(1));
  await shot('04-built');
});

// ---- owner feedback 2 + 4: pull a part off with its subtree, park it in mid-air, pick it up again, re-attach
section('subassembly', async () => {
  let c = await craftInfo(); const pod = c.parts[0], tank = partOf(c, 'tank_m200'), total = c.parts.length;
  let p = await pointOn(tank.id);
  if (!ok(!!p, 'the tank can be pointed at')) return;
  await clickAt(p);
  c = await craftInfo();
  ok(await api('held') === 'tank_m200' && await api('heldParts') === total - 2, `clicking the tank pulls it off with everything attached to it (${total - 2} parts in the hand)`);
  ok(c.parts.length === 2 && !partOf(c, 'tank_m200'), 'the craft keeps only what was above it');
  await page.keyboard.press('Escape'); await frames(2);
  c = await craftInfo();
  ok(c.parts.length === total && await api('held') === null, 'Esc puts the sub-assembly back where it was');
  await pause(500);
  p = await pointOn(partOf(c, 'tank_m200').id);
  await clickAt(p);
  const drop = { x: view.right - 150, y: view.cy + 40 };
  let pl = await hoverAt(drop);
  ok(pl && pl.state === 'free', 'held away from the craft it is free');
  ok((await api('markers')).filter(m => m.state === 'ok').length >= 1, 'the open node it came from is highlighted while it is held');
  await clickAt(drop);
  c = await craftInfo();
  let loose = await api('loose');
  ok(await api('held') === null && loose.length === 1 && loose[0].parts === total - 2, 'dropped in empty space it stays in the hall as a loose piece');
  ok(c.parts.length === 2, 'the loose piece is not part of the craft');
  const lv = await api('looseView');
  ok(lv.length === 1 && lv[0].visible && lv[0].translucent, 'it is drawn translucent');
  ok(Math.hypot(loose[0].x - drop.x, loose[0].y - drop.y) < 40, 'and floats where it was dropped');
  ok(await B(() => window.__sw.app.builder.checkCraft().warnings.some(w => /loose piece/.test(w))), 'the pre-flight check warns that a loose piece will be left behind');
  await shot('05-loose');
  await pause(900); await frames(2);
  const again = await api('loose');
  ok(near(again[0].x, loose[0].x, 2) && near(again[0].y, loose[0].y, 2), 'it stays there');
  await pause(300);
  await page.mouse.move(loose[0].x, loose[0].y, { steps: 3 }); await frames(2);
  await clickAt(loose[0]);
  ok(await api('held') === 'tank_m200' && (await api('loose')).length === 0, 'clicking the loose piece picks it up again');
  const nb = await nodeOf(pod.id, 'bottom');
  pl = await hoverAt({ x: nb.x + 6, y: nb.y + 46 });
  ok(pl && pl.state === 'valid' && pl.action.node === 'bottom', 'it snaps back onto the open node');
  await clickAt({ x: nb.x + 6, y: nb.y + 46 });
  c = await craftInfo();
  ok(c.parts.length === total && partOf(c, 'tank_m200').parent === pod.id && c.parts.filter(q => q.type === 'fin').length === 3 && c.parts.filter(q => q.type === 'solar').length === 2, 're-attaching restores the whole craft');
  const fins = c.parts.filter(q => q.type === 'fin');
  ok(fins.every(f => f.sym === fins[0].sym && f.sym > 0), 'symmetry groups survive the round trip');
  ok(await B(() => { const v = window.__sw.app.builder.craft.validate(); return v.errors.length === 0; }), 'the rebuilt craft passes validation');
  // moving a sub-assembly to a different place: engine from the tank to a loose spot and back by undo
  const eng = partOf(c, 'eng_sparrow');
  await pause(500);
  p = await pointOn(eng.id);
  await clickAt(p);
  ok(await api('held') === 'eng_sparrow', 'a single part can be pulled off too');
  await page.keyboard.press('Delete'); await frames(2);
  c = await craftInfo();
  ok(c.parts.length === total - 1 && await api('held') === null, 'Delete discards the held part');
  await page.keyboard.press('Meta+z'); await frames(2);
  c = await craftInfo();
  ok(c.parts.length === total, '⌘Z brings it back');
  await page.keyboard.press('Meta+Shift+z'); await frames(2);
  ok((await craftInfo()).parts.length === total - 1, '⇧⌘Z redoes the removal');
  await page.keyboard.press('Meta+z'); await frames(2);
});

section('reroot', async () => {
  let c = await craftInfo(); const pod = c.parts[0], tank = partOf(c, 'tank_m200'), total = c.parts.length;
  await page.keyboard.press('4');
  ok(await api('tool') === 'root' && await page.locator('.bld-tool[data-tool="root"].active').count() === 1, 'key 4 selects the re-root tool');
  const p = await pointOn(tank.id);
  await clickAt(p);
  c = await craftInfo();
  const nt = partOf(c, 'tank_m200'), np = partOf(c, 'pod_acorn');
  ok(c.root === tank.id && nt.node === 'root' && nt.parent === null, 'clicking the tank makes it the root part');
  ok(np.parent === tank.id && np.node === 'top', 'the old root now hangs off it (the capsule sits on top of the tank)');
  ok(c.parts.length === total && c.parts.every(q => q.parent === null || c.parts.some(r => r.id === q.parent)), 'no part is lost and the tree is intact');
  ok(near(np.y, pod.y, 1e-9) && near(nt.y, tank.y, 1e-9), 'nothing moves');
  await page.keyboard.press('Meta+z'); await frames(2);
  ok((await craftInfo()).root === pod.id, 'undo restores the old root');
  await page.keyboard.press('1');
  ok(await api('tool') === 'place', 'key 1 returns to the place tool');
});

section('gizmos', async () => {
  let c = await craftInfo(); const eng = partOf(c, 'eng_sparrow'), tank = partOf(c, 'tank_m200');
  await page.keyboard.press('2');
  ok(await api('tool') === 'move', 'key 2 selects the move tool');
  let p = await pointOn(eng.id);
  await clickAt(p);
  ok(await api('selected') === eng.id, 'clicking a part selects it and shows the offset arrows');
  const g = await B(() => window.__sw.app.builder.gizmoScreenPos('y'));
  const centre = await posOf(eng.id);
  await shot('06-gizmo-move');
  await drag(g, { x: g.x + (g.x - centre.x) * 0.9, y: g.y + (g.y - centre.y) * 0.9 });
  c = await craftInfo();
  const moved = partOf(c, 'eng_sparrow').y - eng.y;
  ok(moved > 0.15, `dragging the vertical arrow outward offsets the part along its axis (+${moved.toFixed(2)} m)`);
  ok(near(moved * 10, Math.round(moved * 10), 1e-6), 'in 0.1 m steps while snap is on');
  ok(near(partOf(c, 'tank_m200').y, tank.y, 1e-9), 'its parent stays put');
  await page.keyboard.press('Meta+z'); await frames(2);
  ok(near(partOf(await craftInfo(), 'eng_sparrow').y, eng.y, 1e-9), 'undo restores the offset');
  // rotate the tank: everything attached turns with it
  await page.keyboard.press('3');
  ok(await api('tool') === 'rotate', 'key 3 selects the rotate tool');
  await B(id => window.__sw.app.builder.select(id), tank.id); await frames(2);
  const fin0 = c.parts.filter(q => q.type === 'fin')[0];
  const a = await B(() => window.__sw.app.builder.gizmoScreenPos('ring', -0.9)), b = await B(() => window.__sw.app.builder.gizmoScreenPos('ring', -0.9 + 0.8));
  await shot('07-gizmo-rotate');
  await drag(a, b, { steps: 10 });
  c = await craftInfo();
  const wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
  const turned = wrap(partOf(c, 'tank_m200').rot - tank.rot) * 180 / Math.PI;
  ok(Math.abs(turned) >= 15 && near(turned, Math.round(turned / 15) * 15, 1e-6), `dragging the ring turns the part in 15° steps (${turned.toFixed(0)}°)`);
  const fin1 = c.parts.find(q => q.id === fin0.id);
  const swept = wrap(Math.atan2(-fin1.z, fin1.x) - Math.atan2(-fin0.z, fin0.x)) * 180 / Math.PI;
  ok(near(swept, turned, 1e-4) && near(Math.hypot(fin1.x, fin1.z), Math.hypot(fin0.x, fin0.z), 1e-6), 'the fins on it swing round with it');
  await page.keyboard.press('Meta+z'); await frames(2);
  ok(near(partOf(await craftInfo(), 'tank_m200').rot, tank.rot, 1e-9), 'undo restores the rotation');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await frames(1);
  ok(await api('tool') === 'place' && await api('selected') === null, 'Esc leaves the tool');
});

// ---- round 2: full rotation of the held part, tilt, action groups, saved loose pieces, collision check, settle, per-building autosave
section('round2', async () => {
  const before = await B(() => window.__sw.app.builder.designJSON());
  const json = await B(async () => {
    const m = await import('/js/core/craft.js'); const c = new m.Craft('Round Two');
    const [pod] = c.setRoot('pod_acorn'); const [tank] = c.attachStack('tank_m200', pod.id, 'bottom'); c.attachStack('eng_sparrow', tank.id, 'bottom');
    return c.toJSON();
  });
  await B(j => window.__sw.app.builder.loadCraft(j), json); await settle();
  view = await api('viewRect');
  const raw = () => B(() => window.__sw.app.builder.craft.parts.map(p => ({ id: p.id, type: p.type, parent: p.parent, node: p.node, flip: !!p.flip, pitch: p.pitch || 0, roll: p.roll || 0, x: p.pos.x, y: p.pos.y, z: p.pos.z })));
  let c = await craftInfo(); const pod = c.parts[0], tank = partOf(c, 'tank_m200'), eng = partOf(c, 'eng_sparrow');

  // W / S: end-for-end flip of a held stack part
  await pick('eng_sparrow');
  await page.keyboard.press('w');
  let pose = await api('heldPose');
  ok(pose && pose.flip === true, 'W turns the held stack part end for end');
  const nt = await nodeOf(pod.id, 'top');
  let pl = null, at = null;
  for (const dy of [-16, -30, -46, -8]) { at = { x: nt.x, y: nt.y + dy }; pl = await hoverAt(at); if (pl && pl.state === 'valid') break; }
  ok(pl && pl.state === 'valid' && pl.action.kind === 'stack' && pl.action.node === 'top' && pl.action.target === pod.id, 'upside down, an engine snaps onto the top node');
  await page.mouse.click(at.x, at.y);
  const settling = await api('settling');
  await page.waitForFunction(() => window.__sw.app.builder.settling === 0);
  ok(settling >= 1, 'the part settles onto the node with a short animation, then rests');
  await frames(2); await settle();
  let parts = await raw();
  const up = parts.find(q => q.type === 'eng_sparrow' && q.parent === pod.id);
  ok(up && up.flip && up.node === 'top' && up.y > pod.y, 'it is attached flipped, nozzle up');
  ok(await B(() => { const j = window.__sw.app.builder.designJSON(); return j.parts.some(q => q.flip === true); }), 'the flip is saved with the design');
  await shot('16-flipped-engine');
  await page.keyboard.press('Meta+z'); await frames(2);
  ok((await craftInfo()).parts.length === 3, 'undo takes it off again');
  await pick('eng_sparrow'); await page.keyboard.press('w'); await page.keyboard.press('s');
  pose = await api('heldPose');
  ok(pose && pose.flip === false, 'S turns it back');
  await page.keyboard.press('Escape'); await frames(1);

  // surface parts: W/S pitch (dihedral), Q/E roll (incidence)
  await B(() => window.__sw.app.builder.setSymmetry(2));
  await pick('fin');
  await page.keyboard.press('w'); await page.keyboard.press('q');
  pose = await api('heldPose');
  ok(pose && near(Math.abs(pose.pitch), Math.PI / 12, 1e-6) && near(Math.abs(pose.roll), Math.PI / 12, 1e-6), `W tilts a held surface part away from the hull, Q rolls it, in 15° steps (${(pose.pitch * 180 / Math.PI).toFixed(0)}° / ${(pose.roll * 180 / Math.PI).toFixed(0)}°)`);
  const side = await posOf(tank.id, -0.4, 0.3);
  pl = await hoverAt(side);
  ok(pl && pl.state === 'valid' && pl.action.kind === 'radial' && pl.count === 2, 'the tilted fin previews on the tank ×2');
  await clickAt(side);
  parts = await raw();
  let fins = parts.filter(q => q.type === 'fin');
  ok(fins.length === 2 && fins.every(f => near(f.pitch, pose.pitch, 1e-6) && near(Math.abs(f.roll), Math.abs(pose.roll), 1e-6)), 'both fins are attached with that tilt');
  await shot('17-tilted-fins');
  ok(await B(([id, dp, dr]) => window.__sw.app.builder.tiltPart(id, dp, dr), [fins[0].id, -fins[0].pitch, -fins[0].roll]), 'an attached surface part can be tilted afterwards');
  parts = await raw(); fins = parts.filter(q => q.type === 'fin');
  ok(fins.every(f => f.pitch === 0 && f.roll === 0), 'and its twin follows');
  await B(() => window.__sw.app.builder.setSymmetry(1));

  // move gizmo collision check
  const y0 = (await raw()).find(q => q.id === eng.id).y;
  ok(await B(id => window.__sw.app.builder.collisions(id).length === 0, eng.id), 'parts that merely touch at a node do not count as colliding');
  ok(await B(([id, dy]) => window.__sw.app.builder.nudge(id, 0, dy, 0, { check: true }), [eng.id, pod.y - y0]) === false && near((await raw()).find(q => q.id === eng.id).y, y0, 1e-9), 'an offset that would push the engine into the capsule is refused');
  ok(await B(id => window.__sw.app.builder.nudge(id, 0, -0.3, 0, { check: true }), eng.id) === true, 'an offset into free space is accepted');
  await page.keyboard.press('Meta+z'); await frames(2);
  await page.keyboard.press('2');
  await B(id => window.__sw.app.builder.select(id), eng.id); await frames(2);
  const g = await B(() => window.__sw.app.builder.gizmoScreenPos('y')), centre = await posOf(eng.id);
  if (g && centre) {
    const podAt = await posOf(pod.id);                         // drag the engine all the way up into the capsule (its own tank does not count: parts may be tucked into what they hang from)
    const into = { x: g.x + (podAt.x - centre.x), y: g.y + (podAt.y - centre.y) };
    await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(into.x, into.y, { steps: 8 }); await frames(2);
    const clash = await api('clash');
    ok(clash && clash.includes(eng.id), 'dragging the arrow into another part marks the overlap while the button is down');
    await shot('18-collision');
    await page.mouse.up(); await frames(2);
    ok(await api('clash') === null && await B(id => window.__sw.app.builder.collisions(id).length === 0, eng.id), 'on release the part slides back to the last clear spot');
  } else ok(false, 'the move gizmo is shown for the engine');
  await B(([id, y]) => { const b = window.__sw.app.builder, p = b.craft.getPart(id); if (Math.abs(p.pos.y - y) > 1e-9) b.nudge(id, 0, y - p.pos.y, 0); }, [eng.id, y0]);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await frames(1);

  // action groups
  await page.keyboard.press('5');
  ok(await api('tool') === 'action' && await page.locator('.bld-right.acting .bld-actions').isVisible(), 'key 5 opens the action-group editor');
  const groups = await page.$$eval('.bld-act-group', l => l.map(b => b.dataset.group));
  ok(groups.length === 13 && ['1', '9', 'gear', 'lights', 'brakes', 'abort'].every(k => groups.includes(k)), `it offers groups 1-9, Gear, Lights, Brakes and Abort (${groups.length})`);
  await tap('.bld-act-group[data-group="2"]');
  ok(await api('actionGroup') === '2' && await page.locator('.bld-act-group[data-group="2"].active').count() === 1, 'clicking a group makes it the one being edited');
  const pe = await pointOn(eng.id);
  if (ok(!!pe, 'the engine can be pointed at with the action tool')) {
    await clickAt(pe);
    ok(await api('selected') === eng.id && (await craftInfo()).parts.length === 5, 'clicking a part selects it instead of pulling it off');
    const acts = await page.$$eval('.bld-act-btn[data-act]', l => l.map(b => b.dataset.act));
    ok(acts.length >= 1, `the panel lists what the part can do (${acts.join(', ')})`);
    await tap(`.bld-act-btn[data-act="${acts[0]}"]`);
    let ag = await api('actionGroups');
    ok(ag['2'] && ag['2'].length === 1 && ag['2'][0].part === eng.id && ag['2'][0].action === acts[0], 'clicking an action binds it to the group');
    ok(await page.locator('.bld-act-row').count() === 1 && await page.locator('.bld-act-group[data-group="2"].has').count() === 1, 'the binding is listed and the group is marked as used');
    await shot('19-action-groups');
    // pull the tank (with the engine under it) off, park it, check it is saved, put it back
    await page.keyboard.press('1');
    let pt = await pointOn(tank.id);
    await clickAt(pt);
    ok(await api('held') === 'tank_m200' && !(await api('actionGroups'))['2'], 'pulling the section off takes its bindings with it');
    const drop = { x: view.right - 150, y: view.cy + 40 };
    await hoverAt(drop); await clickAt(drop);
    const saved = await B(() => window.__sw.app.builder.designJSON());
    ok((await api('loose')).length === 1 && Array.isArray(saved.subassemblies) && saved.subassemblies.length === 1 && saved.subassemblies[0].asm.parts.length === 4, 'a loose piece is saved with the design as a sub-assembly');
    await B(j => window.__sw.app.builder.loadCraft(j), saved); await settle();
    ok((await craftInfo()).parts.length === 1 && (await api('loose')).length === 1, 'loading the design brings the loose piece back');
    const l = (await api('loose'))[0];
    await page.mouse.move(l.x, l.y, { steps: 3 }); await frames(2);
    await clickAt(l);
    ok(await api('held') === 'tank_m200', 'it can be picked up again');
    const root = (await craftInfo()).parts[0], nb = await nodeOf(root.id, 'bottom');
    pl = await hoverAt({ x: nb.x + 8, y: nb.y + 46 });
    ok(pl && pl.state === 'valid' && pl.action.node === 'bottom', 'and snaps back under the capsule');
    await clickAt({ x: nb.x + 8, y: nb.y + 46 });
    c = await craftInfo(); ag = await api('actionGroups');
    const eng2 = partOf(c, 'eng_sparrow');
    ok(c.parts.length === 5 && ag['2'] && ag['2'].length === 1 && ag['2'][0].part === eng2.id && ag['2'][0].action === acts[0], 'the engine is still in action group 2 after the round trip');
    await page.keyboard.press('5');
    await tap('.bld-act-group[data-group="2"]');
    await tap('.bld-act-row [data-action="act-remove"]');
    ok(!(await api('actionGroups'))['2'], '× takes a binding out of the group');
    await page.keyboard.press('Meta+z'); await frames(2);
    ok(!!(await api('actionGroups'))['2'], 'and undo restores it');
  }
  await tap('[data-action="act-done"]');
  ok(await api('tool') === 'place' && await page.locator('.bld-right.acting').count() === 0, 'Done returns to building');

  // parts on wings; jets on hardpoints
  await pick('wing_broad');
  let wp = null;
  for (const [fy, sd] of [[0.2, 0.3], [0.2, -0.3], [0.4, 0.5], [0, 0.6]]) { const q = await posOf((await craftInfo()).parts.find(x => x.type === 'tank_m200').id, fy, sd); const r = await hoverAt(q); if (r && r.state === 'valid' && r.action.kind === 'radial') { wp = q; break; } }
  if (ok(!!wp, 'a wing goes on the side of the tank')) {
    await clickAt(wp);
    const wing = partOf(await craftInfo(), 'wing_broad');
    ok(await B(async id => { const b = window.__sw.app.builder; return b.craft.canAttachRadial('pylon_s', id) && b.craft.canAttachRadial('light_glim', id); }, wing.id), 'wings accept surface-mounted parts');
    const made = await B(async id => {
      const b = window.__sw.app.builder, c2 = b.craft, w = c2.getPart(id);
      const [py] = c2.attachRadial('pylon_s', id, w.pos.y, w.rot + Math.PI / 2, 1);
      if (!py) return null;
      const [jet] = c2.attachOuter('jet_puffin', py.id);
      return jet ? { pylon: py.parent, jet: jet.parent === py.id, thrust: c2.stats().some(st => st.jetThrust > 0 || st.thrust > 0) } : { pylon: py.parent, jet: false };
    }, wing.id);
    ok(made && made.pylon === wing.id && made.jet, 'a hardpoint under the wing carries a jet engine');
  } else await page.keyboard.press('Escape');

  // per-building autosave
  const count = (await craftInfo()).parts.length;
  await B(() => window.__sw.app.goto('hub')); await waitScreen('hub');
  const slots = await B(() => { const s = window.__sw.app.career.settings.builderAutosave || {}; return { pad: s.pad ? s.pad.parts.length : -1, padName: s.pad && s.pad.name, runway: s.runway ? s.runway.parts.length : -1 }; });
  ok(slots.pad === count && slots.padName === 'Round Two', `leaving stores the rocket hall's work in its own autosave slot (${slots.pad} parts)`);
  await enterBuilder({ site: 'pad' });
  ok((await craftInfo()).parts.length === count && (await craftInfo()).name === 'Round Two', 'and coming back restores it');
  await B(j => window.__sw.app.builder.loadCraft(j), before); await settle();
});

section('staging', async () => {
  await tap('[data-action="load"]');
  await page.waitForSelector('.bld-load-row');
  const stock = await page.$$eval('.bld-load-row[data-stock="1"]', l => l.map(r => r.dataset.craft));
  ok(stock.length >= 7 && stock.includes('Ember Twin'), `the open dialog lists the reference designs (${stock.length})`);
  ok(await page.$$eval('.bld-load-row[data-stock="1"] .bld-load-pic img', l => l.length > 0 && l.every(i => i.src.startsWith('data:image'))), 'each with a rendered craft thumbnail');
  await shot('08-open-dialog');
  await B(() => document.querySelector('.bld-load-row[data-craft="Ember Twin"] [data-action="open"]').click());
  await page.waitForFunction(() => window.__sw.app.builder.craft.name === 'Ember Twin' && !document.querySelector('.sw-modal'));
  await settle();
  let c = await craftInfo();
  ok(c.parts.length === 18 && c.stages.length === 5, 'opening Ember Twin loads its 18 parts and 5 stages');
  const n = c.stages.length;
  ok(await page.locator('.bld-stage').count() === n, `the staging stack shows one group per stage (${n})`);
  ok(await page.$$eval('.bld-stage', l => l.map(s => +s.dataset.stage)).then(l => l.every((v, i) => v === n - 1 - i)), 'the stage that fires first is at the bottom');
  ok(await page.locator('.bld-chip canvas').count() >= 5, 'stages hold part icons');
  const dv = await page.$$eval('.bld-stage.burns .dv b', l => l.map(b => Number(b.textContent.replace(/[^\d.]/g, ''))));
  ok(dv.length >= 2 && dv.every(v => v > 0), `burning stages show delta-v (${dv.join(', ')} m/s)`);
  ok(await page.$$eval('.bld-stage.burns .bld-stage-stats', l => l.every(s => /TWR/.test(s.textContent) && /\d+(s|m|:)/.test(s.textContent))), 'with TWR and burn time');
  const totalVac = await page.$eval('.bld-stage-total', b => b.textContent);
  await tap('.bld-seg [data-atmo="1"]');
  const totalSea = await page.$eval('.bld-stage-total', b => b.textContent);
  ok(totalSea !== totalVac && parseFloat(totalSea.replace(/,/g, '')) < parseFloat(totalVac.replace(/,/g, '')), `the sea-level switch lowers the numbers (${totalVac} → ${totalSea})`);
  await tap('.bld-seg [data-atmo="0"]');
  const twr0 = await page.$eval('.bld-stage.burns .bld-stage-stats', s => s.textContent);
  const bodies = await page.$$eval('.bld-body option', l => l.map(o => o.value));
  await page.selectOption('.bld-body', bodies.find(b => b !== 'verda') || bodies[1]);
  const twr1 = await page.$eval('.bld-stage.burns .bld-stage-stats', s => s.textContent);
  ok(bodies.length >= 3 && twr0 !== twr1, 'choosing another body recomputes TWR for its gravity');
  await page.selectOption('.bld-body', 'verda');

  // drag a part icon to another stage
  const chuteId = partOf(c, 'chute').id;
  const from = c.stages.findIndex(s => s.includes(chuteId));
  const to = from === 0 ? 1 : from - 1;
  const box = async sel => { const r = await page.locator(sel).first().boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  await page.locator(`.bld-stage[data-stage="${from}"] .bld-chip[data-type="chute"]`).scrollIntoViewIfNeeded();
  let a = await box(`.bld-stage[data-stage="${from}"] .bld-chip[data-type="chute"]`), b = await box(`.bld-stage[data-stage="${to}"] .bld-stage-main`);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 8, a.y + 8, { steps: 2 }); await page.mouse.move(b.x, b.y, { steps: 6 });
  ok(await page.locator('.bld-drag-ghost').count() === 1 && await page.locator(`.bld-stage[data-stage="${to}"].over`).count() === 1, 'dragging an icon shows a drag ghost and highlights the target stage');
  await page.mouse.up(); await frames(2);
  c = await craftInfo();
  ok(c.stages.filter(s => s.includes(chuteId)).length === 1 && (c.stages.length === n ? c.stages[to].includes(chuteId) : c.stages.length === n - 1), 'dropping the parachute icon on another stage moves it there');
  ok(c.auto === false && await page.$eval('.bld-right-head .sw-chip', e => e.textContent) === 'Custom', 'staging is now custom');
  await page.keyboard.press('Meta+z'); await frames(2);
  c = await craftInfo();
  ok(c.stages.length === n && c.stages[from].includes(chuteId), 'undo puts the icon back');

  // drag an icon onto a gap between stages: a new stage
  a = await box(`.bld-stage[data-stage="${from}"] .bld-chip[data-type="chute"]`); b = await box(`.bld-ins[data-insert="${n}"]`);
  await drag(a, b, { steps: 8 });
  c = await craftInfo();
  ok(c.stages.every(s => s.length > 0), 'dropping an icon on a gap gives it a stage of its own (no empty stage is left behind)');
  ok(c.stages[c.stages.length - 1].length === 1 && c.stages[c.stages.length - 1][0] === chuteId, 'the new stage sits where it was dropped (on top, firing last)');
  await page.keyboard.press('Meta+z'); await frames(2);

  // reorder whole stages by their grip
  c = await craftInfo();
  const before = c.stages.map(s => s.join(','));
  a = await box('.bld-stage[data-stage="0"] .bld-stage-grip'); b = await box('.bld-stage[data-stage="2"] .bld-stage-main');
  await drag(a, b, { steps: 8 });
  c = await craftInfo();
  let after = c.stages.map(s => s.join(','));
  ok(after.length === before.length && after[2] === before[0] && after[0] === before[1] && after[1] === before[2], 'dragging a stage by its grip onto another moves it to that position');
  await page.keyboard.press('Meta+z'); await frames(2);
  ok((await craftInfo()).stages.map(s => s.join(',')).join('|') === before.join('|'), 'undo restores the order');

  // add / remove stages
  await tap('[data-action="stage-add"]');
  c = await craftInfo();
  ok(c.stages.length === n + 1 && c.stages[n].length === 0 && await page.locator('.bld-stage.empty').count() === 1, 'the plus button adds an empty stage');
  await tap('.bld-stage.empty [data-action="stage-remove"]');
  ok((await craftInfo()).stages.length === n, 'its minus button removes it again');
  await tap('.bld-ins[data-insert="1"]'); await tap('.bld-ins[data-insert="0"]');
  c = await craftInfo();
  ok(c.stages.length === n + 2 && c.stages[0].length === 0 && c.stages[2].length === 0, 'the gaps between stages insert empty stages in place');
  await tap('[data-action="stage-trim"]');
  ok((await craftInfo()).stages.length === n, 'the trim button removes every empty stage');
  await shot('09-staging');
  // automatic reset
  a = await box(`.bld-stage[data-stage="${from}"] .bld-chip[data-type="chute"]`); b = await box(`.bld-stage[data-stage="${to}"] .bld-stage-main`);
  await drag(a, b, { steps: 8 });
  ok((await craftInfo()).auto === false, 'a manual change switches automatic staging off');
  await tap('[data-action="reset-staging"]');
  c = await craftInfo();
  const autoStages = await B(() => { const k = window.__sw.app.builder.craft.clone(); k.autoStage(); return k.stages.map(s => s.join(',')).join('|'); });
  ok(c.auto === true && c.stages.map(s => s.join(',')).join('|') === autoStages && await page.$eval('.bld-right-head .sw-chip', e => e.textContent) === 'Auto', 'Reset rebuilds the stages automatically');
});

section('info', async () => {
  if ((await craftInfo()).name !== 'Ember Twin') await B(async j => window.__sw.app.builder.loadCraft(j), await stockJSON('Ember Twin'));
  const stat = id => page.$eval(`.bld-stat[data-stat="${id}"] .sw-value`, e => e.textContent);
  ok(await stat('parts') === '18' && /t$/.test(await stat('mass')) && parseFloat(await stat('mass')) > 1, `the info bar shows part count and mass (${await stat('mass')})`);
  ok(/\d/.test(await stat('cost')) && /\d/.test(await stat('dv')) && /\d\.\d\d/.test(await stat('twr')) && /×/.test(await stat('size')), 'and cost, delta-v, TWR and size');
  for (const k of ['com', 'cot', 'col']) await tap(`.bld-marker[data-marker="${k}"]`);
  await frames(2);
  const ms = await api('markersShown');
  ok(ms && ms.com && ms.cot, 'the CoM and CoT toggles show their 3D markers');
  ok(await page.locator('.bld-marker.active').count() === 3, 'all three marker toggles light up');
  const bal = await api('balance');
  ok(bal && bal.mass > 1000 && bal.thrust > 0 && Math.abs(bal.com.x) < 0.05 && bal.cot.y < bal.com.y, 'centre of thrust lies below the centre of mass on the craft axis');
  await shot('10-markers');
  for (const k of ['com', 'cot', 'col']) await tap(`.bld-marker[data-marker="${k}"]`);
  await tap('[data-action="report"]');
  ok(await page.locator('.bld-report:not(.sw-hidden) tbody tr').count() >= 3, 'the engineer’s report lists every stage');
  await tap('[data-action="report"]');
  // name, notes, save, reopen
  await page.fill('.bld-name', 'Test Twin');
  await tap('[data-action="describe"]');
  await page.waitForSelector('textarea.bld-desc');
  await page.fill('textarea.bld-desc', 'Two boosters and a prayer.');
  await tap('.sw-modal .sw-btn.primary');
  await page.waitForFunction(() => !document.querySelector('.sw-modal'));
  await tap('[data-action="save"]');
  const saved = await B(() => { const j = window.__sw.app.career.crafts['Test Twin']; return j ? { parts: j.parts.length, site: j.site, desc: j.desc, thumb: (j.thumb || '').slice(0, 22) } : null; });
  ok(saved && saved.parts === 18 && saved.site === 'pad', 'Save stores the design in the programme');
  ok(saved && saved.desc === 'Two boosters and a prayer.' && saved.thumb.startsWith('data:image/'), 'with its description and a thumbnail picture');
  await tap('[data-action="new"]');
  ok((await craftInfo()).parts.length === 0, 'New clears the hall');
  await tap('[data-action="load"]');
  await page.waitForSelector('.bld-load-row[data-craft="Test Twin"]');
  ok(await page.$eval('.bld-load-row[data-craft="Test Twin"]', r => !!r.querySelector('.bld-load-pic img') && /prayer/.test(r.textContent) && r.dataset.stock === ''), 'the open dialog shows the saved design with its picture and notes');
  await B(() => document.querySelector('.bld-load-row[data-craft="Test Twin"] [data-action="open"]').click());
  await page.waitForFunction(() => window.__sw.app.builder.craft.name === 'Test Twin' && !document.querySelector('.sw-modal'));
  ok((await craftInfo()).parts.length === 18 && await page.$eval('.bld-name', i => i.value) === 'Test Twin', 'opening it restores the craft');
  ok(await api('clearance') > 1.5, 'a loaded craft also hangs clear of the floor');
  await settle();
});

section('camera', async () => {
  if ((await craftInfo()).parts.length < 5) await B(async j => window.__sw.app.builder.loadCraft(j), await stockJSON('Ember Twin'));
  await B(() => window.__sw.app.builder.frame()); await settle();
  const empty = { x: view.right - 40, y: view.top + 50 };
  await page.mouse.move(empty.x, empty.y); await frames(1);
  let c0 = await api('camera');
  await page.mouse.wheel(0, 200); await frames(2);
  let c1 = await api('camera');
  ok(Math.abs(c1.tty - c0.tty) > 0.2 && near(c1.tdist, c0.tdist, 1e-9), `the wheel scrolls along the craft without zooming (${(c1.tty - c0.tty).toFixed(2)} m)`);
  await page.keyboard.down('Shift'); await page.mouse.wheel(0, 240); await page.keyboard.up('Shift'); await frames(2);
  let c2 = await api('camera');
  ok(Math.abs(c2.tdist - c1.tdist) > 0.2 && near(c2.tty, c1.tty, 1e-9), `Shift+wheel zooms (${c1.tdist.toFixed(1)} → ${c2.tdist.toFixed(1)} m)`);
  // a free-spinning wheel: a burst of big deltas must not fling the view away
  await B(() => window.__sw.app.builder.frame()); await settle();
  c0 = await api('camera');
  const f0 = await B(() => window.__sw.app.frame);
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 480);
  await frames(1);
  c1 = await api('camera');
  const elapsed = await B(() => window.__sw.app.frame) - f0 + 1;
  const viewH = 2 * c0.dist * Math.tan(19 * Math.PI / 180), travel = Math.abs(c1.tty - c0.ty);
  ok(travel > 0.05, `a burst of 60 big wheel events scrolls the view (${travel.toFixed(1)} m)`);
  ok(Math.abs(c1.tty - c1.ty) <= viewH * 0.281 && travel <= viewH * 0.281 * elapsed && near(c1.tdist, c0.tdist, 1e-9), `but never queues more than a quarter screen ahead: a flick glides instead of flinging (${travel.toFixed(1)} m in ${elapsed} frames, screen ${viewH.toFixed(1)} m)`);
  const b = await B(() => { const bb = window.__sw.app.builder.craft.bounds(); return { lo: bb.minY, hi: bb.maxY }; });
  await settle();
  c1 = await api('camera');
  ok(c1.ty >= b.lo - 3.5 && c1.ty <= b.hi + 3.5, 'and the view never leaves the craft');
  await page.keyboard.down('Shift'); for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 480); await page.keyboard.up('Shift');
  c2 = await api('camera');
  ok(c2.tdist <= 90 && c2.tdist >= 2.6, 'a flick with Shift cannot zoom out of the hall');
  await B(() => window.__sw.app.builder.frame()); await settle();
  c0 = await api('camera');
  await drag(empty, { x: empty.x - 140, y: empty.y + 30 }, { button: 'right' });
  c1 = await api('camera');
  ok(Math.abs(c1.tyaw - c0.tyaw) > 0.3, 'right-drag orbits');
  await drag(empty, { x: empty.x - 90, y: empty.y + 60 }, { button: 'middle' });
  c2 = await api('camera');
  ok(Math.hypot(c2.tfx - c1.tfx, c2.tfz - c1.tfz) > 0.2 || Math.abs(c2.tty - c1.tty) > 0.2, 'middle-drag pans');
  ok(near(c2.tyaw, c1.tyaw, 1e-9), 'without turning the view');
  await B(() => window.__sw.app.builder.frame()); await settle();
  const c = await craftInfo(); const n = c.parts.length;
  const target = c.parts.find(p => p.type === 'eng_sparrow') || c.parts[c.parts.length - 1];
  const p = await pointOn(target.id);
  if (p) {
    await page.mouse.dblclick(p.x, p.y); await frames(3);
    const c3 = await api('camera');
    ok(near(c3.tty, target.y, 0.05), 'double-click focuses the view on a part');
    ok(await api('held') === null && (await craftInfo()).parts.length === n, 'without pulling it off');
  } else ok(false, 'could not point at a part to double-click');
  await page.keyboard.press('f'); await settle();
  ok(Math.abs((await api('camera')).tty - target.y) > 0.3, 'F frames the whole craft again');
});

section('launch', async () => {
  await tap('[data-action="launch"]');
  await page.waitForSelector('.bld-launch');
  ok(await page.locator('.bld-launch select[data-seat]').count() === 1, 'the launch dialog offers a seat for the capsule');
  const crew = await page.$$eval('.bld-launch select[data-seat] option', l => l.length);
  ok(crew >= 2 && await page.$eval('.bld-launch select[data-seat]', s => s.value !== ''), 'with the available crew, one pre-assigned');
  ok(await page.$eval('.bld-site [data-site="pad"]', b => b.classList.contains('active')), 'the pad is the default roll-out site here');
  await shot('11-launch-dialog');
  await tap('.bld-site [data-site="runway"]');
  ok(await page.$eval('.bld-site [data-site="runway"]', b => b.classList.contains('active')), 'the runway can be chosen instead');
  await tap('.bld-site [data-site="pad"]');
  // capture the hand-over instead of flying
  await B(() => { const a = window.__sw.app; a.__goto = a.goto; a.goto = (name, params) => { if (name === 'flight') { a.__launched = { name, site: params.site, craftSite: params.craft.site, parts: params.craft.parts.length, crew: params.crew, paid: params.paid }; return; } return a.__goto(name, params); }; });
  await tap('.sw-modal .sw-btn.primary');
  await pause(300);
  const l = await B(() => { const a = window.__sw.app; a.goto = a.__goto; return a.__launched; });
  ok(l && l.name === 'flight' && l.site === 'pad' && l.craftSite === 'pad' && l.parts >= 5 && l.paid === true, 'Launch hands the craft to the flight screen for the pad');
  ok(l && Array.isArray(l.crew) && l.crew.length === 1, 'with the assigned crew');
  await B(() => { for (const m of document.querySelectorAll('.sw-modal-x')) m.click(); });
});

section('runway', async () => {
  await enterBuilder({ site: 'runway' });
  view = await api('viewRect');
  ok(await api('site') === 'runway' && await page.locator('.bld.bld-plane').count() === 1 && /Spaceplane/.test(await page.$eval('.bld-title', e => e.textContent)), 'site "runway" opens the spaceplane hangar');
  ok(await api('symMode') === 'mirror' && await api('symmetry') === 2, 'mirror symmetry is on by default there');
  ok((await craftInfo()).parts.length === 0, 'it keeps its own design, separate from the rocket hall');
  await shot('12-hangar-empty');
  await pick('cockpit_swift');
  const P = { x: view.cx - 60, y: view.cy - 10 };
  let pl = await hoverAt(P);
  ok(pl && pl.state === 'valid' && pl.action.kind === 'root', 'the cockpit can be hung anywhere as the root');
  await clickAt(P); await settle();
  let c = await craftInfo(); const cock = c.parts[0];
  const top = await nodeOf(cock.id, 'top') || await posOf(cock.id, 1, 0), bot = await nodeOf(cock.id, 'bottom');
  ok(Math.abs(top.x - bot.x) > 2.5 * Math.abs(top.y - bot.y), 'the craft lies horizontally: its nose axis runs across the screen');
  ok(await api('clearance') > 1, `and hangs above the hangar floor (${(await api('clearance')).toFixed(1)} m)`);
  const fwd = await B(id => { const b = window.__sw.app.builder, s = b.scene.getObjectByName('craft'), T = b.three; const p = b.craft.getPart(id); const v = new T.Vector3(0, 1, 0).applyQuaternion(s.quaternion), u = new T.Vector3(0, 0, 1).applyQuaternion(s.quaternion); return { vz: v.z, vy: v.y, uy: u.y }; }, cock.id);
  ok(near(fwd.vz, 1, 1e-6) && near(fwd.vy, 0, 1e-6) && near(fwd.uy, 1, 1e-6), 'nose forward along the hangar, top of the craft up');
  await pick('fus_m');
  const behind = { x: bot.x + (bot.x - top.x) * 0.35, y: bot.y + (bot.y - top.y) * 0.35 };
  pl = await hoverAt(behind);
  ok(pl && pl.state === 'valid' && pl.action.kind === 'stack' && pl.action.node === 'bottom', 'a fuselage section snaps to the node behind the cockpit');
  await clickAt(behind);
  c = await craftInfo(); const fus = partOf(c, 'fus_m');
  ok(!!fus && fus.parent === cock.id, 'and attaches there');
  await pick('wing_broad');
  let wp = null;
  for (const [fy, side] of [[0, 0.2], [0, -0.2], [0.2, 0.5], [-0.2, -0.5], [0, 0.8], [0, -0.8]]) {
    const q = await posOf(fus.id, fy, side); const r = await hoverAt(q);
    if (r && r.state === 'valid' && r.action.kind === 'radial' && r.count === 2) { wp = q; break; }
  }
  if (ok(!!wp, 'a wing over the fuselage previews a mirrored pair')) {
    await shot('13-hangar-wings');
    await clickAt(wp);
    c = await craftInfo();
    const w = c.parts.filter(q => q.type === 'wing_broad');
    ok(w.length === 2 && near(w[0].x, -w[1].x, 1e-6) && near(w[0].z, w[1].z, 1e-6) && near(w[0].y, w[1].y, 1e-6), 'the two wings are mirror images, left and right of the fuselage');
  } else await page.keyboard.press('Escape');
  await tap('[data-action="launch"]');
  await page.waitForSelector('.bld-launch');
  ok(await page.$eval('.bld-site [data-site="runway"]', b => b.classList.contains('active')), 'the launch dialog rolls out to the runway by default');
  await B(() => { for (const m of document.querySelectorAll('.sw-modal-buttons .sw-btn:not(.primary)')) m.click(); });
  await page.waitForFunction(() => !document.querySelector('.sw-modal'));
  const count = (await craftInfo()).parts.length;
  await shot('14-hangar');
  // leaving keeps the work: autosave slot and per-building memory
  await B(() => window.__sw.app.goto('hub')); await waitScreen('hub');
  const auto = await B(() => { const j = window.__sw.app.career.crafts.__autosave; return j ? { parts: j.parts.length, site: j.site } : null; });
  ok(auto && auto.parts === count && auto.site === 'runway', 'leaving stores the work in progress in the __autosave slot');
  await enterBuilder({ site: 'runway' });
  ok((await craftInfo()).parts.length === count, 'coming back to the hangar restores the design');
  await enterBuilder({ site: 'pad' });
  ok(await api('site') === 'pad' && (await craftInfo()).parts.length >= 5 && await page.locator('.bld.bld-plane').count() === 0, 'and the rocket hall still has its own');
  await enterBuilder({ craft: await stockJSON('Kite Trainer') || await stockJSON('Hopper I'), site: 'runway' });
  await settle();
  ok((await craftInfo()).parts.length > 5, 'a design passed in params opens in the hangar');
  await shot('15-hangar-stock');
});

section('career', async () => {
  await B(() => { const a = window.__sw.app; a.goto('hub'); });
  await waitScreen('hub');
  await B(() => { const a = window.__sw.app; a.career = a.Career.newGame('career'); if (window.__sw.career !== undefined) window.__sw.career = a.career; });
  await enterBuilder({ site: 'pad' });
  const locked = await B(async () => { const m = await import('/js/core/parts.js'); const c = window.__sw.app.career; return m.PART_LIST.filter(d => !c.isPartUnlocked(d.id)).map(d => [d.cat, d.id]); });
  if (!locked.length) { ok(true, 'career mode: every part is unlocked from the start (nothing to check)'); return; }
  const [cat, id] = locked[0];
  await tap(`.bld-cat[data-cat="${cat}"]`);
  ok(await page.locator(`.bld-card.locked[data-part="${id}"]`).count() === 1, `career mode greys out parts that are not researched (${locked.length} locked)`);
  await B(q => document.querySelector(q).click(), `.bld-card.locked[data-part="${id}"]`);
  ok(await api('held') === null, 'a locked part cannot be picked up');
  ok(await page.locator('.bld-funds').count() === 1, 'the top bar shows programme funds');
});

// =============================================================================================
try {
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  await tap('[data-action="new"]');
  await tap('.sw-mode[data-mode="sandbox"]');
  await tap('.sw-modal .sw-btn.primary');
  await waitScreen('hub');
  await B(p => { window.__sw.app.goto('builder', p); }, { site: 'pad' });
  await page.waitForFunction(() => window.__sw.app.currentName === 'builder' && window.__sw.app.builder && window.__sw.app.builder.ready, null, { timeout: 240000 });
  console.log('\n=== first visit ===');
  ok(await page.locator('.bld-hint').isVisible(), 'the first visit shows the how-to hint');
  await shot('00-first-visit');
  await tap('[data-action="hint-ok"]');
  ok(await page.locator('.bld-hint').count() === 0, 'which can be dismissed');
  await settle();
  view = await api('viewRect');
  console.log('  quality: ' + await api('quality'));

  for (const [name, fn] of sections) {
    if (only.length && !only.includes(name)) continue;
    console.log(`\n=== ${name} ===`);
    const t = Date.now();
    try { await fn(); }
    catch (err) { failed++; checks++; problems.push(`section "${name}" stopped: ${(err.stack || err.message).split('\n').slice(0, 4).join(' | ')}`); console.log('  ✗ section stopped: ' + err.message.split('\n')[0]); await shot('fail-' + name); }
    // leave every section in a clean state
    await B(() => { for (const m of document.querySelectorAll('.sw-modal-x')) m.click(); const b = window.__sw.app.builder; if (b && window.__sw.app.currentName === 'builder') { b.cancel(); b.setTool('place'); } }).catch(() => {});
    await page.keyboard.up('Alt').catch(() => {}); await page.keyboard.up('Shift').catch(() => {});
    console.log(`  (${((Date.now() - t) / 1000).toFixed(0)} s)`);
  }
} catch (err) {
  failed++; checks++;
  problems.push('crashed: ' + (err.stack || err.message));
  await shot('crash');
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${checks} checks, ${checks - failed} passed, ${failed} failed` + (problems.length ? `, ${problems.length} problem line${problems.length === 1 ? '' : 's'}:` : '.'));
for (const p of problems) console.log('  - ' + p);
process.exit(problems.length ? 1 : 0);
