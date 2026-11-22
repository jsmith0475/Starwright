// End-to-end test of the title menu: its four groups and their order, that it fits a 1280×720 window with and
// without a saved game, and that the arrow keys walk it.
//   node tests/e2e/titlemenu.mjs [outDir]        (screenshots: tests/out/titlemenu-*.png)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.argv[2] || path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const layout = page => page.evaluate(() => {
  const m = document.querySelector('.sw-menu'), r = m.getBoundingClientRect(), w = document.querySelector('.sw-wordmark').getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, wordTop: w.top, h: innerHeight,
    groups: [...m.querySelectorAll('.sw-menu-group')].map(g => ({ id: g.dataset.group, head: g.querySelector('.sw-menu-head').textContent, actions: [...g.querySelectorAll('.sw-btn')].map(b => b.dataset.action) })),
    cut: [...m.querySelectorAll('.sw-btn')].filter(b => b.scrollWidth > b.clientWidth + 1 || [...b.querySelectorAll('small')].some(s => s.scrollWidth > s.clientWidth + 1)).map(b => b.dataset.action) };
});
const focused = page => page.evaluate(() => (document.activeElement && document.activeElement.dataset.action) || '');

try {
  for (const [w, h, dsf] of [[1440, 900, 2], [1280, 720, 1]]) {
    console.log(`\n=== ${w}×${h} ===`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
    const page = await ctx.newPage(); page.setDefaultTimeout(240000);
    page.on('console', m => { if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) problems.push('console: ' + m.text()); });
    page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
    await page.goto(server.url + '?whatsnew=0');
    await page.waitForFunction(() => document.body.dataset.ready === '1');

    let l = await layout(page);
    ok(l.groups.map(g => g.id).join() === 'play,learn,options,about', 'four groups in order: ' + l.groups.map(g => g.head).join(' / '));
    ok(l.groups[0].actions.join() === 'new,missions,scenarios', 'Play without a saved game: ' + l.groups[0].actions.join(', '));
    ok(l.groups[1].actions.join() === 'guide,science,demo', 'Learn and tour: ' + l.groups[1].actions.join(', '));
    ok(l.groups[2].actions.join() === 'settings,controls' && l.groups[3].actions.join() === 'about,whatsnew', 'Options and About are rows of two');
    ok(l.top >= 0 && l.bottom <= l.h - 8 && l.wordTop >= 0, `menu and wordmark fit (menu ${Math.round(l.top)} to ${Math.round(l.bottom)} of ${l.h})`);
    ok(l.cut.length === 0, 'no entry is cut short' + (l.cut.length ? ': ' + l.cut.join(', ') : ''));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, `titlemenu-${w}x${h}-new.png`) });

    await page.evaluate(async () => { const a = window.__sw.app; await a.newGame('career'); a.save(true); await a.exitToTitle(); });
    await page.waitForSelector('.sw-menu [data-action="continue"]');
    l = await layout(page);
    ok(l.groups[0].actions.join() === 'continue,delete,new,missions,scenarios', 'Play with a saved game: ' + l.groups[0].actions.join(', '));
    ok(l.top >= 0 && l.bottom <= l.h - 8 && l.wordTop >= 0, `with a saved game it still fits (menu ${Math.round(l.top)} to ${Math.round(l.bottom)} of ${l.h}, wordmark top ${Math.round(l.wordTop)})`);
    ok(l.cut.length === 0, 'no entry is cut short' + (l.cut.length ? ': ' + l.cut.join(', ') : ''));

    // keyboard: the arrows walk the rows, Left and Right move inside a row of two, Tab still follows the same order
    await page.focus('.sw-menu [data-action="continue"]');
    const walk = [];
    for (let i = 0; i < 8; i++) { await page.keyboard.press('ArrowDown'); walk.push(await focused(page)); }
    ok(walk.join() === 'new,missions,scenarios,guide,science,demo,settings,about', 'ArrowDown walks the rows: ' + walk.join(', '));
    await page.keyboard.press('ArrowDown'); ok(await focused(page) === 'about', 'and stops at the last row');
    await page.keyboard.press('ArrowRight'); ok(await focused(page) === 'whatsnew', 'ArrowRight moves along a row of two');
    await page.keyboard.press('ArrowUp'); ok(await focused(page) === 'controls', 'ArrowUp keeps to the same side');
    await page.keyboard.press('ArrowLeft'); ok(await focused(page) === 'settings', 'ArrowLeft moves back');
    await page.keyboard.press('Home'); ok(await focused(page) === 'continue', 'Home jumps to the first entry');
    await page.keyboard.press('ArrowRight'); ok(await focused(page) === 'delete', 'the delete button is reached with ArrowRight from Continue');
    await page.keyboard.press('End'); ok(await focused(page) === 'whatsnew', 'End jumps to the last');
    await page.focus('.sw-menu [data-action="continue"]');
    const tabs = [];
    for (let i = 0; i < 11; i++) { await page.keyboard.press('Tab'); tabs.push(await focused(page)); }
    ok(tabs.join() === 'delete,new,missions,scenarios,guide,science,demo,settings,controls,about,whatsnew', 'Tab visits every entry in order');
    await page.focus('.sw-menu [data-action="controls"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sw-modal');
    ok(true, 'Enter opens the focused entry (Controls)');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.sw-modal'));
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.mouse.move(w - 50, h - 50);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, `titlemenu-${w}x${h}-saved.png`) });

    await page.click('.sw-menu [data-action="delete"]');
    await page.waitForSelector('.sw-modal .sw-btn.danger');
    ok(/Delete saved game/.test(await page.locator('.sw-modal').innerText()), 'the delete button asks before erasing');
    await page.click('.sw-modal .sw-btn.danger');
    await page.waitForFunction(() => !document.querySelector('.sw-menu [data-action="continue"]'));
    ok(await page.locator('.sw-menu [data-action="new"].primary').count() === 1, 'after deleting, New Game leads the menu again');
    await ctx.close();
  }
} catch (err) { problems.push('threw: ' + (err.stack || err.message)); }
await browser.close(); await server.close();
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
