// Before/after contact sheet of the realism probe's captures: node tests/tools/realism_sheet.mjs [before] [after]
// Reads tests/out/realism-<before>-<view>.png and realism-<after>-<view>.png, writes tests/out/realism-sheet.png
// (and realism-sheet-2.png when there are more than four views).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, CHROMIUM_ARGS } from '../e2e/server.mjs';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../out');
const [A = 'before', B = 'after'] = process.argv.slice(2);
const VIEWS = ['title', 'overview', 'pad', 'runway', 'grove', 'coast', 'flight-pad', 'flight-runway', 'flight-low'];
const have = VIEWS.filter(v => fs.existsSync(path.join(OUT, `realism-${A}-${v}.png`)) && fs.existsSync(path.join(OUT, `realism-${B}-${v}.png`)));
if (!have.length) { console.error('no pairs of captures found in ' + OUT); process.exit(1); }
const uri = f => 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, f)).toString('base64');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: CHROMIUM_ARGS.filter(a => !/gl|gpu/i.test(a)) });
try {
  const PER = 4;
  for (let s = 0; s * PER < have.length; s++) {
    const views = have.slice(s * PER, s * PER + PER);
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 80 + views.length * 466 }, deviceScaleFactor: 1 })).newPage();
    const rows = views.map(v => `<div class="r"><figure><img src="${uri(`realism-${A}-${v}.png`)}"><figcaption>${v} · ${A}</figcaption></figure><figure><img src="${uri(`realism-${B}-${v}.png`)}"><figcaption>${v} · ${B}</figcaption></figure></div>`).join('');
    await page.setContent(`<style>body{margin:0;background:#14171c;color:#dfe6ee;font:14px system-ui,sans-serif}h1{font-size:18px;margin:0;padding:14px 16px}.r{display:flex;gap:8px;padding:0 16px 8px}figure{margin:0;flex:1}img{width:100%;display:block;border-radius:4px}figcaption{padding:4px 2px 0;opacity:.75}</style><h1>Starwright environment: ${A} / ${B}</h1>${rows}`);
    await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
    const file = path.join(OUT, s ? `realism-sheet-${s + 1}.png` : 'realism-sheet.png');
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
    await page.close();
  }
} finally { await browser.close(); }
