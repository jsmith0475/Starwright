// End-to-end test of What's New: a first-time player is not interrupted, a returning player sees the entries they
// have not seen exactly once, the title menu's entry opens the whole list, and nothing logs an error.
//   node tests/e2e/whatsnew.mjs          (screenshots: tests/out/whatsnew-*.png)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, loadPlaywright, CHROMIUM_ARGS } from './server.mjs';

const { chromium } = await loadPlaywright();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });
const { RELEASES, SEEN_KEY } = await import(path.join(ROOT, 'js/ui/whatsnew.js')).catch(() => ({}));   // dom.js is not touched until a function is called

const problems = [];
let checks = 0;
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });

/** A fresh browser profile, with `seed` put in localStorage before the game first loads. */
async function open(seed, query = '') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  if (seed) await ctx.addInitScript(s => { if (!sessionStorage.getItem('__seeded')) { for (const k in s) localStorage.setItem(k, s[k]); sessionStorage.setItem('__seeded', '1'); } }, seed);
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  page.on('console', m => { if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) problems.push('console: ' + m.text()); });
  page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
  await page.goto(server.url + query);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
  return { ctx, page };
}
const shown = page => page.evaluate(() => [...document.querySelectorAll('.sw-whatsnew [data-entry]')].map(n => n.dataset.entry));
const seenId = page => page.evaluate(k => localStorage.getItem(k), SEEN_KEY);
const reload = async page => { await page.reload(); await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 }); };
const all = RELEASES.map(e => e.id), latest = all[0];

try {
  console.log('\n=== First visit: nothing pops up ===');
  {
    const { ctx, page } = await open(null);
    await page.waitForTimeout(400);
    ok((await shown(page)).length === 0 && await page.locator('.sw-modal').count() === 0, 'a first-time player goes straight to the menu');
    ok(await seenId(page) === latest, 'the list is marked as seen (' + await seenId(page) + ')');
    const entry = page.locator('[data-action="whatsnew"]');
    ok(await entry.count() === 1 && /What's New/.test(await entry.innerText()), "the title menu has a What's New entry");
    const order = await page.evaluate(() => [...document.querySelectorAll('[data-action]')].map(b => b.dataset.action));
    ok(order.indexOf('whatsnew') === order.indexOf('about') + 1, 'it sits after About (' + order.join(', ') + ')');
    const fit = await page.evaluate(() => { const m = document.querySelector('.sw-menu').getBoundingClientRect(); return m.bottom <= innerHeight && m.top >= 0; });
    ok(fit, 'the menu still fits the screen at 1440×900');
    await entry.click();
    await page.waitForSelector('.sw-whatsnew [data-entry]');
    const r = await page.evaluate(() => {
      const root = document.querySelector('.sw-whatsnew'), a = root.querySelector('a');
      return { days: [...root.querySelectorAll('section')].map(s => s.dataset.day), heads: [...root.querySelectorAll('h3')].map(h => h.textContent),
        flat: [...root.querySelectorAll('[data-entry]')].filter(n => { const b = n.getBoundingClientRect(); return !(b.width > 300 && b.height > 30); }).length,
        raw: /\]\(https/.test(root.textContent), href: a && a.href, target: a && a.target, rel: a && a.rel,
        title: document.querySelector('.sw-whatsnew-modal .sw-title').textContent, wide: root.scrollWidth > root.clientWidth + 1 };
    });
    ok((await shown(page)).join() === all.join(), 'the menu entry shows every entry, newest first (' + all.length + ')');
    ok(r.days.length === new Set(RELEASES.map(e => e.date)).size && /^\d{1,2} [A-Z][a-z]+ \d{4}$/.test(r.heads[0]), 'entries are grouped under a dated heading (' + r.heads.join(' | ') + ')');
    ok(r.flat === 0 && !r.wide && !r.raw, 'every entry is laid out, nothing overflows sideways, no raw markup');
    ok(/What's new in Starwright/.test(r.title), "it is titled What's new in Starwright");
    ok(!r.href || (/^https:\/\//.test(r.href) && r.target === '_blank' && /noopener/.test(r.rel)), 'links open in a new tab');
    await page.screenshot({ path: path.join(OUT, 'whatsnew-all.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.sw-whatsnew', { state: 'detached' });
    ok(await page.locator('[data-action="whatsnew"]').count() === 1, 'Esc closes it and the menu is back');
    await ctx.close();
  }

  console.log('\n=== Returning player who has never seen the list ===');
  {
    const { ctx, page } = await open({ 'starwright.settings.v1': '{}' });
    await page.waitForSelector('.sw-whatsnew [data-entry]');
    ok((await shown(page)).join() === all.join(), 'the pop-up comes up by itself with everything');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.textContent) === 'Got it', 'Got it has the focus');
    await page.screenshot({ path: path.join(OUT, 'whatsnew-popup.png') });
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sw-whatsnew', { state: 'detached' });
    ok(await page.locator('.sw-modal').count() === 0 && await page.locator('[data-action="new"]').count() === 1, 'Enter dismisses it and the menu is ready');
    await reload(page);
    await page.waitForTimeout(400);
    ok((await shown(page)).length === 0, 'it does not come back on the next launch');
    await ctx.close();
  }

  console.log('\n=== Returning player who saw an earlier release ===');
  if (all.length >= 2) {
    const last = all[Math.min(2, all.length - 1)];
    const { ctx, page } = await open({ [SEEN_KEY]: last });
    await page.waitForSelector('.sw-whatsnew [data-entry]');
    const got = await shown(page);
    ok(got.join() === all.slice(0, all.indexOf(last)).join(), 'only the entries above "' + last + '" are shown (' + got.join(', ') + ')');
    await page.screenshot({ path: path.join(OUT, 'whatsnew-since.png') });
    await page.locator('.sw-whatsnew-modal .sw-btn.primary').click();
    await page.waitForSelector('.sw-whatsnew', { state: 'detached' });
    ok(await seenId(page) === latest, 'and the newest entry is now the one remembered');
    await ctx.close();
  }

  console.log('\n=== Up to date, and the address switches ===');
  {
    const a = await open({ [SEEN_KEY]: latest, 'starwright.settings.v1': '{}' });
    await a.page.waitForTimeout(400);
    ok((await shown(a.page)).length === 0, 'a player who is up to date sees nothing');
    await a.ctx.close();
    const b = await open({ 'starwright.settings.v1': '{}' }, '?whatsnew=0');
    await b.page.waitForTimeout(400);
    ok((await shown(b.page)).length === 0, '?whatsnew=0 keeps it away');
    await b.ctx.close();
    const c = await open(null, '?whatsnew=1');
    await c.page.waitForSelector('.sw-whatsnew [data-entry]');
    ok((await shown(c.page)).join() === all.join(), '?whatsnew=1 shows it with everything');
    await c.ctx.close();
  }
} catch (err) {
  problems.push('test crashed: ' + (err.stack || err.message));
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
