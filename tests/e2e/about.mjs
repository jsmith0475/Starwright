// End-to-end test of the About screen: the title menu's About entry opens it, every section is drawn and readable,
// the repository link is a real link, Close returns to the menu, and nothing logs an error.
//   node tests/e2e/about.mjs          (screenshot: tests/out/about.png)
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
function ok(cond, what) { checks++; if (!cond) { problems.push('FAILED: ' + what); console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); return !!cond; }

const server = await startServer(ROOT);
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
page.on('console', m => { if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) problems.push('console: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));

try {
  console.log('\n=== About screen (1440×900) ===');
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
  const entry = page.locator('[data-action="about"]');
  ok(await entry.count() === 1 && /About/.test(await entry.innerText()), 'the title menu has an About entry');
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-action]')].map(b => b.dataset.action));
  ok(order.indexOf('about') === order.indexOf('controls') + 1, 'it sits after Controls (' + order.join(', ') + ')');
  await entry.click();
  await page.waitForSelector('.sw-about section');
  const r = await page.evaluate(() => {
    const root = document.querySelector('.sw-about');
    const secs = [...root.querySelectorAll('section')];
    const a = root.querySelector('a');
    return { ids: secs.map(s => s.dataset.about), flat: secs.filter(s => { const b = s.getBoundingClientRect(); return !(b.width > 300 && b.height > 60); }).length,
      text: root.textContent, raw: /\]\(https/.test(root.textContent), href: a && a.href, target: a && a.target, rel: a && a.rel,
      known: window.__sw.app.about.sections.length, title: document.querySelector('.sw-about-modal').textContent.slice(0, 40),
      wide: root.scrollWidth > root.clientWidth + 1 };
  });
  ok(r.ids.join() === 'what,ksp1,ksp2,made,legal' && r.known === 5, 'five sections are drawn (' + r.ids.join(', ') + ')');
  ok(r.flat === 0 && !r.wide, 'every section has a laid-out size and nothing overflows sideways');
  ok(/About Starwright/.test(r.title), 'the screen is titled About Starwright');
  ok(/Kerbal Space Program 2/.test(r.text) && /Jerry Smith/.test(r.text) && /Claude AI agents/.test(r.text) && /Grok AI agents/.test(r.text), 'it tells the history and how the game was made');
  ok(/not affiliated with or endorsed by the makers of Kerbal Space Program or by SpaceX/.test(r.text) && /not affiliated with or endorsed by Anthropic or xAI/.test(r.text), 'the not-affiliated statement is shown');
  ok(!r.raw && /^https:\/\/github\.com\/jsmith0475\/Starwright/.test(r.href || '') && r.target === '_blank' && /noopener/.test(r.rel || ''), 'the repository link is a real link that opens in a new tab');
  await page.screenshot({ path: path.join(OUT, 'about.png') });
  await page.evaluate(() => { const b = document.querySelector('.sw-about-modal .sw-modal-body'); b.scrollTop = b.scrollHeight; });
  await page.screenshot({ path: path.join(OUT, 'about-end.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sw-about', { state: 'detached' });
  ok(await page.locator('[data-action="about"]').count() === 1, 'Esc closes it and the menu is back');
} catch (err) {
  problems.push('test crashed: ' + (err.stack || err.message));
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log('  ' + p);
process.exit(problems.length ? 1 : 0);
