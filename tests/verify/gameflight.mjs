// Drives the real game through coasting flights and records what it did, for comparison with ref.refPatched().
import { World, SYSTEM, V, A, capsule, spawn } from './harness.mjs';
import { WARP_RATES } from '../../js/core/world.js';
import * as R from './ref.mjs';

/**
 * Coast a vessel in the game from `state` ({ body: ref body, r, v, t }) to tEnd and record every SOI change.
 * mode 'active': the vessel is the one the player flies; time advances with World.warpTo at up to `maxWarp`
 *                (default: the top rate) in wall-clock slices of `slice` seconds, so the game's own warp limits,
 *                SOI stops and chunking are all exercised.
 * mode 'background': a capsule landed on the pad is the active vessel and the test vessel is on rails in the
 *                background while the world runs at `rate` (default 100 000x) in `slice`-second slices.
 * Returns { events: [{ t, from, to, r, v }], end: { bodyId, r, v, t }, stopped: reason | null, world, vessel }.
 */
export function gameCoast(state, tEnd, { mode = 'active', slice = 0.5, maxWarp = WARP_RATES.length - 1, craft = null, maxSteps = 4e6 } = {}) {
  const w = new World({ ut: state.t });
  let anchor = null;
  if (mode === 'background') anchor = w.launch(capsule(), { crew: ['Bo'] });
  const v = spawn(w, craft || capsule(), state.body.id, state.r, state.v, { makeActive: mode === 'active' });
  if (anchor) w.switchTo(anchor);
  const events = [];
  let stopped = null;
  w.on('soi', d => { if (d.vessel === v) events.push({ t: w.ut, from: d.from.id, to: d.to.id, r: A(v.pos), v: A(v.vel), exact: mode === 'active' }); });
  w.on('destroyed', d => { if (d.vessel === v) stopped = 'destroyed:' + d.reason; });
  let steps = 0;
  while (w.ut < tEnd - 1e-6 && !stopped && steps++ < maxSteps) {
    if (mode === 'active') {
      if (w.warpTarget === null) w.warpTo(tEnd);
      const before = w.ut, n = events.length;
      w.step(slice);
      if (maxWarp < WARP_RATES.length - 1 && w.warpIndex > maxWarp) w.setWarp(maxWarp), w.warpTo(tEnd);
      // physics took over at 1x because the path meets air or ground: that is the end of a coast
      if (w.warpIndex === 0 && w.warpTarget === null && events.length === n && w.ut < tEnd - 1e-6 && w.ut - before < slice * 1.5) {
        const p = v._patch;
        const alt = v.pos.length() - v.body.radius;
        if (v.dead) stopped = 'destroyed';
        else if (alt < (v.body.atmo ? v.body.atmo.height : 0) + 0.02 * v.body.radius + 30 * v.vel.length()) stopped = v.body.atmo ? 'atmo' : 'impact';
        else if (p && (p.endType === 'atmo' || p.endType === 'impact')) stopped = p.endType;
      }
    } else {
      if (w.warpIndex !== maxWarp) w.setWarp(maxWarp);
      w.step(Math.min(slice, (tEnd - w.ut) / w.rate));
    }
    if (v.dead && !stopped) stopped = 'destroyed';
  }
  return { events, end: { bodyId: v.body.id, r: A(v.pos), v: A(v.vel), t: w.ut }, stopped, world: w, vessel: v, steps };
}

/** Compare a game coast with the reference: → { sameSequence, worstDt, endPos (m), endRel, detail }. */
export function compareCoast(sys, eph, state, tEnd, game, ref) {
  const refSoi = ref.events.filter(e => e.type === 'enter' || e.type === 'exit');
  const gSeq = game.events.map(e => `${e.from}>${e.to}`).join(' '), rSeq = refSoi.map(e => `${e.from.id}>${e.to.id}`).join(' ');
  let worstDt = 0, worstPos = 0, worstVel = 0;
  const n = Math.min(game.events.length, refSoi.length);
  for (let i = 0; i < n; i++) {
    if (game.events[i].to !== refSoi[i].to.id) break;
    worstDt = Math.max(worstDt, Math.abs(game.events[i].t - refSoi[i].t));
    if (game.events[i].exact) {
      // state just after the change, in the new frame, at the game's own event time, against the reference arc
      const back = R.keplerUV(refSoi[i].r, refSoi[i].v, refSoi[i].to.gm, game.events[i].t - refSoi[i].t);
      worstPos = Math.max(worstPos, R.dist(game.events[i].r, back.r));
      worstVel = Math.max(worstVel, R.dist(game.events[i].v, back.v));
    }
  }
  return { sameSequence: gSeq === rSeq, gSeq, rSeq, worstDt, worstPos, worstVel };
}
