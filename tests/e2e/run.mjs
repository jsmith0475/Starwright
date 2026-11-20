// Runs every end-to-end suite in tests/e2e one after another and prints one summary.
//   node tests/e2e/run.mjs                 every suite (the play-through and the contact suite in ONLY= batches, one browser each)
//   node tests/e2e/run.mjs flight docking  only the suites whose name contains one of the words
//   node tests/e2e/run.mjs --previews      also run the preview_*.mjs capture scripts (slow; they only write images)
//   node tests/e2e/run.mjs --bail          stop at the first failing suite
// Exit code: 0 when every suite passed, 1 otherwise.
//
// Suites are discovered, not listed: any tests/e2e/*.mjs that is not a helper (server, serve, run) is a suite;
// files named preview_* are capture scripts and stay out unless --previews is given.
// A suite passes when its process exits with 0. The "N checks, M problem(s)" line each suite prints is echoed
// in the summary. Each suite's full output goes to tests/out/e2e-<name>.log; the tail is shown when it fails.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'tests/out');
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const words = args.filter(a => !a.startsWith('--'));
const HELPERS = new Set(['server.mjs', 'serve.mjs', 'run.mjs']);
// The play-through is long: it runs in batches so one browser never has to survive the whole thing.
const PLAYTHROUGH_BATCHES = ['career', 'keys,mouse', 'orbit,science', 'tracking', 'pell', 'robust,perf'];
// The ground-contact suite is long too (every stock craft, every landable body): same treatment, by its sections.
const CONTACT_BATCHES = ['stock', 'soft,lod', 'warp,depth,splash,centre,builder', 'demo', 'runway', 'worlds'];
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 45 * 60 * 1000;      // per run

/** The play-through's own section names, read from the file so a new section is never silently skipped. */
function playthroughSections() {
  try {
    const src = fs.readFileSync(path.join(HERE, 'playthrough.mjs'), 'utf8');
    const names = new Set();
    const first = /const sections = \{([^}]*)\}/.exec(src);
    if (first) for (const n of first[1].split(',')) { const k = n.split(':')[0].trim(); if (k) names.add(k); }
    for (const m of src.matchAll(/^sections\.(\w+)\s*=/gm)) names.add(m[1]);
    return [...names];
  } catch { return []; }
}

const runs = [];
for (const file of fs.readdirSync(HERE).filter(f => f.endsWith('.mjs')).sort()) {
  if (HELPERS.has(file)) continue;
  const name = file.replace(/\.mjs$/, '');
  if (name.startsWith('preview_') && !flags.has('--previews')) continue;
  if (words.length && !words.some(w => name.includes(w))) continue;
  if (name === 'playthrough') {
    const all = playthroughSections();
    const batches = PLAYTHROUGH_BATCHES.map(b => b.split(',').filter(s => !all.length || all.includes(s))).filter(b => b.length);
    const covered = new Set(batches.flat());
    for (const s of all) if (!covered.has(s)) batches.push([s]);
    if (!batches.length) runs.push({ name, file, env: {} });
    for (const b of batches) runs.push({ name: 'playthrough[' + b.join(',') + ']', file, env: { ONLY: b.join(',') } });
  } else if (name === 'contact') {
    for (const b of CONTACT_BATCHES) runs.push({ name: 'contact[' + b + ']', file, env: { ONLY: b } });
  } else runs.push({ name, file, env: {} });
}
if (!runs.length) { console.log('No e2e suite matches: ' + words.join(' ')); process.exit(1); }

function runOne(run) {
  return new Promise(resolve => {
    const log = path.join(OUT, 'e2e-' + run.name.replace(/[^\w.-]+/g, '_') + '.log');
    const out = fs.createWriteStream(log);
    const t0 = Date.now();
    const env = { ...process.env, ...run.env };
    if (!('ONLY' in run.env)) delete env.ONLY;
    const child = spawn(process.execPath, [path.join(HERE, run.file)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', timedOut = false;
    const take = d => { out.write(d); tail = (tail + d.toString()).slice(-6000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer); out.end();
      const m = [...tail.matchAll(/(\d+) checks?, (\d+) problem\(s\)/g)].pop();
      resolve({ ...run, code: timedOut ? 'timeout' : code, secs: (Date.now() - t0) / 1000, checks: m ? Number(m[1]) : null, problems: m ? Number(m[2]) : null, tail, log });
    });
  });
}

const results = [];
console.log(`Running ${runs.length} e2e run(s): ${runs.map(r => r.name).join(', ')}\n`);
for (const run of runs) {
  process.stdout.write(`▶ ${run.name} … `);
  const r = await runOne(run);
  results.push(r);
  const passed = r.code === 0;
  console.log(`${passed ? 'ok' : 'FAILED'}  (${r.checks != null ? r.checks + ' checks, ' + r.problems + ' problem(s), ' : ''}${r.secs.toFixed(0)} s${passed ? '' : ', exit ' + r.code})`);
  if (!passed) {
    const lines = r.tail.split('\n');
    const from = Math.max(0, lines.length - 30);
    console.log(lines.slice(from).map(l => '    ' + l).join('\n'));
    console.log('    full log: ' + path.relative(ROOT, r.log));
    if (flags.has('--bail')) break;
  }
}

const failed = results.filter(r => r.code !== 0);
const pad = (s, n) => String(s).padEnd(n);
console.log('\n================ e2e summary ================');
for (const r of results) console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${pad(r.name, 30)} ${pad(r.checks != null ? r.checks + ' checks' : '', 12)} ${pad(r.problems != null ? r.problems + ' problem(s)' : '', 14)} ${r.secs.toFixed(0)} s`);
const sum = k => results.reduce((s, r) => s + (r[k] || 0), 0);
console.log(`\n${results.length - failed.length} of ${results.length} run(s) passed · ${sum('checks')} checks · ${sum('problems')} problem(s) · ${(sum('secs') / 60).toFixed(1)} min`);
if (results.length < runs.length) console.log(`(stopped early: ${runs.length - results.length} run(s) not started)`);
process.exit(failed.length || results.length < runs.length ? 1 : 0);
