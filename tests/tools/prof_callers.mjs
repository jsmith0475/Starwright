// node tests/tools/prof_callers.mjs <file.cpuprofile> <functionName> [depth]   → who calls it (self time by caller chain)
import fs from 'node:fs';
const [file, fnName, depth = 5] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const self = new Map();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0));
const label = n => (n.callFrame.functionName || '(anon)') + (n.callFrame.url ? '@' + n.callFrame.url.replace(/^.*\//, '') + ':' + (n.callFrame.lineNumber + 1) : '');
// inclusive time of every node
const incl = new Map();
const walk = id => { let t = self.get(id) || 0; for (const c of byId.get(id).children || []) t += walk(c); incl.set(id, t); return t; };
walk(p.nodes[0].id);
const chains = new Map();
for (const n of p.nodes) {
  if ((n.callFrame.functionName || '') !== fnName) continue;
  const chain = []; let id = parent.get(n.id);
  while (id != null && chain.length < +depth) { chain.push(label(byId.get(id))); id = parent.get(id); }
  const k = chain.join(' < ');
  chains.set(k, (chains.get(k) || 0) + incl.get(n.id));
}
for (const [k, us] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log((us / 1000).toFixed(1).padStart(8) + ' ms  ' + k);
