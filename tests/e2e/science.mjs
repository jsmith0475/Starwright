// End-to-end test of the science reference: the title menu's Science entry opens the reader, every chapter draws
// its equations as real MathML with a laid-out size, the three calculators answer and react to input, the chapter is
// remembered, and nothing logs an error.
//   node tests/e2e/science.mjs          (screenshots: tests/out/science-*.png)
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
page.on('console', m => { if ((m.type() === 'error' || /\[science\]/.test(m.text())) && !/GL Driver Message|GPU stall/.test(m.text())) problems.push('console: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + (e.stack || e.message)));
const num = s => Number(String(s).replace(/[^0-9.\-]/g, ''));

try {
  console.log('\n=== Science reference (1440×900) ===');
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
  const entry = page.locator('[data-action="science"]');
  ok(await entry.count() === 1 && /Science/.test(await entry.innerText()), 'the title menu has a Science entry');
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-action]')].map(b => b.dataset.action));
  ok(order.indexOf('science') === order.indexOf('guide') + 1, 'it sits after Flight School (' + order.join(', ') + ')');
  await entry.click();
  await page.waitForSelector('.sw-sci .sw-sci-eq math');
  const chapters = await page.evaluate(() => [...document.querySelectorAll('.sw-sci-nav [data-chapter]')].map(b => b.dataset.chapter));
  ok(chapters.length >= 15, `the reader lists ${chapters.length} chapters`);
  ok(await page.evaluate(() => window.__sw.app.science.chapters.length) === chapters.length, 'app.science knows the same chapters');

  let totalEq = 0, bad = [];
  for (const id of chapters) {
    await page.click(`[data-chapter="${id}"]`);
    const r = await page.evaluate(() => {
      const pageEl = document.querySelector('.sw-sci-page');
      const eqs = [...pageEl.querySelectorAll('.sw-sci-eq')];
      const maths = [...pageEl.querySelectorAll('math')];
      const flat = maths.filter(m => { const b = m.getBoundingClientRect(); return !(b.width > 4 && b.height > 6); }).length;
      const raw = [...pageEl.querySelectorAll('p, li, h3')].filter(n => /\$|\\[a-z]+|\*\*/.test([...n.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join(''))).map(n => n.textContent.slice(0, 50));
      const wide = eqs.filter(e => e.scrollWidth > e.clientWidth + 1).length;
      const frac = pageEl.querySelector('mfrac'), fb = frac ? frac.getBoundingClientRect() : null;
      return { title: pageEl.querySelector('h2').textContent, eqs: eqs.length, maths: maths.length, flat, raw, wide, fracH: fb ? fb.height : 0, notes: pageEl.querySelectorAll('.sw-sci-note').length,
        on: document.querySelector('.sw-sci-nav .on').dataset.chapter, top: pageEl.scrollTop, numbers: eqs.map(e => e.querySelector('small').textContent) };
    });
    totalEq += r.eqs;
    if (r.on !== id) bad.push(id + ': list not marked');
    if (r.eqs < 2) bad.push(id + ': only ' + r.eqs + ' equations');
    if (r.flat) bad.push(id + ': ' + r.flat + ' formulas have no size');
    if (r.raw.length) bad.push(id + ': raw markup shown: ' + r.raw.join(' | '));
    if (r.wide) bad.push(id + ': ' + r.wide + ' equations wider than the page');
    if (r.fracH && r.fracH < 22) bad.push(id + ': fractions are not stacked (height ' + r.fracH + ')');
    if (!r.notes) bad.push(id + ': no "In Starwright" or example note');
    if (r.top !== 0) bad.push(id + ': does not open at its top');
    if (new Set(r.numbers).size !== r.numbers.length) bad.push(id + ': equation numbers repeat');
  }
  ok(bad.length === 0, 'every chapter draws its equations as laid-out MathML, numbered, with no raw markup: ' + bad.join(' ; '));
  ok(totalEq >= 60, totalEq + ' displayed equations in all');

  await page.click('[data-chapter="gravity"]');
  await page.screenshot({ path: path.join(OUT, 'science-01-gravity.png') });
  await page.click('[data-turn="next"]');
  ok(await page.evaluate(() => document.querySelector('.sw-sci-nav .on').dataset.chapter) === chapters[1], 'the button at the foot turns to the next chapter');
  await page.keyboard.press('[');
  ok(await page.evaluate(() => document.querySelector('.sw-sci-nav .on').dataset.chapter) === chapters[0], 'the [ key turns back');

  // rocket equation calculator
  await page.click('[data-chapter="rocket"]');
  const rc = page.locator('[data-calc="rocket"]');
  await rc.scrollIntoViewIfNeeded();
  const out = async (calc, key) => (await page.locator(`[data-calc="${calc}"] [data-out="${key}"]`).innerText()).trim();
  const dv0 = num(await out('rocket', 'dv'));
  ok(Math.abs(dv0 - 320 * 9.80665 * Math.log(10 / 4)) < 1, `the rocket calculator opens with 10 t, 4 t, 320 s = ${dv0} m/s`);
  await rc.locator('input').nth(1).fill('2');
  const dv1 = num(await out('rocket', 'dv'));
  ok(Math.abs(dv1 - 320 * 9.80665 * Math.log(5)) < 1, `an empty mass of 2 t gives ${dv1} m/s at once`);
  ok(/2\.08 on Verda|on Verda/.test(await out('rocket', 'twr')), 'thrust to weight is given for the home world: ' + await out('rocket', 'twr'));
  await rc.locator('input').nth(1).fill('20');
  ok(await out('rocket', 'dv') === 'n/a' && /at least the empty mass/.test(await rc.locator('.why').innerText()), 'an impossible stage (empty heavier than full) says so and shows no number');
  await page.screenshot({ path: path.join(OUT, 'science-02-rocket.png') });

  // transfer calculator
  await page.click('[data-chapter="transfers"]');
  const tc = page.locator('[data-calc="transfer"]');
  await tc.scrollIntoViewIfNeeded();
  const ej = num(await out('transfer', 'eject')), tof = await out('transfer', 'tof');
  ok(ej > 900 && ej < 1300 && /days/.test(tof), `Verda to Rusk: ejection ${ej} m/s, coast ${tof}`);
  const why = await tc.locator('.why').innerText();
  ok(!/NaN|undefined/.test(why) && /° apart/.test(why), 'the note under it has real numbers: ' + why.slice(0, 120));
  await tc.locator('select').nth(1).selectOption('thal');
  const ej2 = num(await out('transfer', 'eject'));
  ok(ej2 > ej, `a farther world costs more: Thal ${ej2} m/s`);
  await tc.locator('select').nth(0).selectOption('pell');
  const toOpts = await tc.locator('select').nth(1).locator('option').allInnerTexts();
  ok(toOpts.includes('Ost') && !toOpts.includes('Pell') && !toOpts.includes('Rusk'), 'choosing a moon offers its sister moons only: ' + toOpts.join(', '));
  ok(Number.isFinite(num(await out('transfer', 'eject'))), 'and still answers');
  await page.screenshot({ path: path.join(OUT, 'science-03-transfer.png') });

  // the three chapters on the game's own aerodynamics follow "Flight through air", and the air-load calculator answers
  const at = chapters.indexOf('atmosphere');
  ok(chapters[at + 1] === 'aeromodel' && chapters[at + 2] === 'structure' && chapters[at + 3] === 'breakup', 'flight model, structure and breakup follow the chapter on flight through air');
  for (const id of ['aeromodel', 'structure', 'breakup']) { await page.click(`[data-chapter="${id}"]`); await page.screenshot({ path: path.join(OUT, `science-05-${id}.png`) }); }
  const ac = page.locator('[data-calc="airflow"]');
  await ac.scrollIntoViewIfNeeded();
  const q0 = num(await out('airflow', 'q')), x0 = num(await out('airflow', 'cross'));
  const qWant = 0.5 * 1.22 * Math.exp(-8000 / 5800) * 360 * 360 / 1000;
  ok(Math.abs(q0 - qWant) < 0.06 && Math.abs(x0 - qWant / 2) < 0.06, `the air-load calculator opens at 8 km, 360 m/s, 45°: ${q0} kPa, ${x0} kPa across (${qWant.toFixed(1)} and half of it)`);
  ok(/Mach 1\.13/.test(await out('airflow', 'mach')), 'it gives the Mach number and the drag factor: ' + await out('airflow', 'mach'));
  ok(/large dish .*8 kPa/.test(await out('airflow', 'rated')) && !/nose cone/.test(await out('airflow', 'rated')), 'at 45° the dishes go and the nose cone stays: ' + (await out('airflow', 'rated')).slice(0, 110));
  await ac.locator('input').nth(2).fill('0');
  ok(num(await out('airflow', 'cross')) === 0 && /Sunfoil/.test(await out('airflow', 'rated')), 'nose first there is no flow across the rocket, and only open panels go: ' + (await out('airflow', 'rated')).slice(0, 110));
  await ac.locator('input').nth(2).fill('90');
  ok(/nose cone/.test(await out('airflow', 'rated')), 'broadside the nose cone goes too');
  await ac.locator('input').nth(0).fill('80');
  ok(/above the atmosphere/.test(await out('airflow', 'rho')) && /No air/.test(await out('airflow', 'rated')), 'above the top of the atmosphere there is no air and no load');
  await ac.locator('input').nth(0).fill('8'); await ac.locator('input').nth(2).fill('60');
  await ac.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'science-06-airflow.png') });
  await page.click('[data-chapter="transfers"]');

  // closing and coming back
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sw-sci'));
  ok(await page.locator('[data-action="science"]').count() === 1, 'Escape closes the reader and the menu is still there');
  await page.click('[data-action="science"]');
  await page.waitForSelector('.sw-sci .sw-sci-eq math');
  ok(await page.evaluate(() => document.querySelector('.sw-sci-nav .on').dataset.chapter) === 'transfers', 'it reopens at the chapter last read');

  // small window
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.waitForTimeout(300);
  const fit = await page.evaluate(() => { const m = document.querySelector('.sw-sci-modal').getBoundingClientRect(), p = document.querySelector('.sw-sci-page'); return { in: m.left >= 0 && m.top >= 0 && m.right <= innerWidth + 1 && m.bottom <= innerHeight + 1, scroll: p.scrollHeight > p.clientHeight, w: p.clientWidth }; });
  ok(fit.in && fit.scroll && fit.w > 400, 'at 1024 × 640 the reader fits the window and the page scrolls (' + JSON.stringify(fit) + ')');
  await page.screenshot({ path: path.join(OUT, 'science-04-small.png') });
} catch (err) {
  problems.push('test aborted: ' + (err.stack || err.message));
}

await browser.close();
await server.close();
console.log(`\n${checks} checks, ${problems.length} problem(s)`);
for (const p of problems) console.log('  - ' + p);
process.exit(problems.length ? 1 : 0);
