// Flies every stock design for 400 s of flight (ascent program from the pad or runway start) and prints a digest of every vessel's state.
import { createHash } from 'node:crypto';
// Used to show that a change leaves existing flights untouched: run it in two checkouts and diff the output.
//   node tests/tools/flight_digest.mjs [path to a checkout, default this one]
const root = process.argv[2] || new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { World } = await import(root + '/js/core/world.js');
const { stockCrafts, stockSite } = await import(root + '/js/core/craft.js');
const AP = await import(root + '/js/core/autopilot.js');
for (const craft of stockCrafts()) {
  const w = new World();
  const v = w.launch(craft, { crew: ['Ada'], site: stockSite ? stockSite(craft) : 'pad' });
  const ev = [];
  w.on('*', (d, t) => { if (t !== 'warp' && t !== 'situation') ev.push(t + '@' + w.ut.toFixed(2)); });
  let ctl = null;
  try { ctl = AP.ascentProgram(w, { targetAlt: 80000, useWarp: false }); } catch { ctl = null; }
  const h = createHash('sha256');
  for (let i = 0; i < 20000; i++) {
    if (ctl && !ctl.done) ctl.update(0.02);
    w.step(0.02);
    if (i % 250 === 0) for (const x of w.vessels) h.update(JSON.stringify([x.id, x.type, x.pos.toArray(), x.vel.toArray(), x.q.toArray(), x.mass]));
    if (!w.active || w.active.dead) break;
  }
  h.update(ev.join(','));
  console.log(craft.name.padEnd(18), h.digest('hex').slice(0, 16), 'events', ev.length, 'vessels', w.vessels.length, 'ut', w.ut.toFixed(1));
}
