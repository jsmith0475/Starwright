// 3. Bodies in motion: ephemeris, spheres of influence, frame changes across moving bodies, transfers, flybys,
//    rendezvous and the rotating surface.
import { Orbit } from '../../js/core/orbit.js';
import { predictPatches, closestApproach } from '../../js/core/trajectory.js';
import { WARP_RATES, PHYSICS_WARP_MAX } from '../../js/core/world.js';
import * as AP from '../../js/core/autopilot.js';
import { transferWindow as uiTransferWindow } from '../../js/ui/map/planning.js';
import { World, SYSTEM, V, A, capsule, simpleShip, spawn, run } from './harness.mjs';
import { gameCoast, compareCoast } from './gameflight.mjs';
import * as R from './ref.mjs';

const sys = R.readSystem(), eph = new R.Ephemeris(sys);
const verda = sys.byId.verda, pell = sys.byId.pell;
const deg = 180 / Math.PI;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------------------------------------------------------------------------------------------- 3a
function ephemeris(S) {
  for (const b of sys.bodies) {
    if (!b.parent) continue;
    const g = SYSTEM.byId[b.id];
    let worstP = 0, worstV = 0;
    for (const t of [0, 12345.6, 3.3e6, 9.87e7, 4.2e9]) {
      const ref = eph.rel(b, t);
      worstP = Math.max(worstP, R.dist(A(g.posAt(t)), ref.r) / R.norm(ref.r));
      worstV = Math.max(worstV, R.dist(A(g.velAt(t)), ref.v) / R.norm(ref.v));
    }
    S.check(`${b.name}: position from its elements at 5 epochs up to 133 years, worst rel error`, 0, worstP, 2e-9);
    S.check(`${b.name}: velocity from its elements, worst rel error`, 0, worstV, 2e-9);
    // Kepler's third law with the system's own numbers: the period the game uses vs 2 pi sqrt(a^3 / GM_parent)
    S.check(`${b.name}: orbital period obeys Kepler III for its parent's GM`, b.period, g.orbit.period, 1e-12, { unit: 's', rel: true });
    // and the body really is back where it started one such period later
    S.check(`${b.name}: returns to its start after one period`, 0, g.posAt(b.period).distanceTo(g.posAt(0)) / b.elements.a, 1e-9);
    // vis-viva of the body's own motion
    const s = { r: A(g.posAt(777777)), v: A(g.velAt(777777)) };
    S.check(`${b.name}: its speed satisfies vis-viva about the parent`, R.visViva(b.parent.gm, R.norm(s.r), b.elements.a), R.norm(s.v), 1e-9, { unit: 'm/s', rel: true });
    S.check(`${b.name}: sphere of influence = Laplace a (m/M)^(2/5)`, b.soiLaplace, g.soi, 1e-12, { unit: 'm', rel: true });
    const hill = b.elements.a * (1 - b.elements.e) * Math.cbrt(b.gm / (3 * b.parent.gm));
    S.ok(`${b.name}: SOI is well clear of its own surface (> 2 radii)`, g.soi > 2 * b.radius, `SOI ${(g.soi / 1000).toFixed(0)} km, radius ${(b.radius / 1000).toFixed(0)} km`);
    // (for a heavy moon the Laplace sphere is a little larger than the Hill sphere, as for Earth's Moon: 66 000 vs 61 500 km)
    if (g.soi > hill) S.info(`${b.name}: Laplace SOI exceeds its Hill radius by`, (g.soi / hill - 1) * 100, '%', 'normal for mass ratios above ~1 %; same as the real Moon');
    if (b.parent.parent) {
      const pg = SYSTEM.byId[b.parent.id];
      S.ok(`${b.name}: orbit stays inside its parent's SOI (apoapsis + own SOI < parent SOI)`, b.elements.a * (1 + b.elements.e) + g.soi < pg.soi);
      S.ok(`${b.name}: orbit stays above its parent's surface and air`, b.elements.a * (1 - b.elements.e) - g.soi > b.parent.radius + (b.parent.atmo ? b.parent.atmo.height : 0));
    }
    // information: how far the two-body period (parent + own mass) is from the one used (parent mass only)
    const twoBody = R.TAU * Math.sqrt(b.elements.a ** 3 / (b.parent.gm + b.gm));
    if (b.gm / b.parent.gm > 1e-3) S.info(`${b.name}: period if its own mass counted too (two-body) is shorter by`, (1 - twoBody / b.period) * 100, '%', `mass ratio ${(b.gm / b.parent.gm).toExponential(2)}; the game treats moons as massless for their own orbit`);
    S.check(`${b.name}: surface gravity = GM / R^2`, b.gm / b.radius ** 2, g.surfaceG, 1e-12, { unit: 'm/s^2', rel: true });
    if (b.rotPeriodDef === 'tidal') S.check(`${b.name}: tidally locked, rotation period = orbital period`, b.period, g.rotPeriod, 1e-12, { unit: 's', rel: true });
  }
  // no two sibling SOIs can ever overlap
  let overlap = null;
  for (const p of sys.bodies) for (const a of p.children) for (const b of p.children) {
    if (a === b || a.elements.a > b.elements.a) continue;
    if (a.elements.a * (1 + a.elements.e) + a.soiLaplace > b.elements.a * (1 - b.elements.e) - b.soiLaplace) {
      // radial bands overlap: only a problem if the orbits can actually bring them together (reported, not failed)
      overlap = (overlap ? overlap + ', ' : '') + `${a.name}/${b.name}`;
    }
  }
  S.info('sibling pairs whose SOI radial bands overlap (could meet only if phased so)', overlap || 'none');
}

// ---------------------------------------------------------------------------------------------- 3b
/** A coasting state around `parent` that reaches inside the SOI of `child` at about time T. */
function targeted(child, T, offFrac, vrelFrac, leadFrac, dirSeed = 1) {
  const rnd = rng(dirSeed), P = child.parent;
  const u = () => { const z = 2 * rnd() - 1, a = R.TAU * rnd(), s = Math.sqrt(1 - z * z); return R.unit([s * Math.cos(a), z * 0.3, s * Math.sin(a)]); };
  const cs = eph.rel(child, T);
  const rT = R.add(cs.r, R.scale(u(), child.soiLaplace * offFrac)), vT = R.add(cs.v, R.scale(u(), R.norm(cs.v) * vrelFrac));
  const el = R.stateToElements(rT, vT, P.gm);
  if (!(el.e < 0.995) || el.ra > (P.soiLaplace || Infinity) * 0.9 || el.rp < P.radius * 1.2 + (P.atmo ? P.atmo.height : 0)) return null;
  const lead = el.period * leadFrac;
  const s0 = R.keplerUV(rT, vT, P.gm, -lead);
  if (R.dist(s0.r, eph.rel(child, T - lead).r) < child.soiLaplace * 1.05) return null;
  return { state: { body: P, r: s0.r, v: s0.v, t: T - lead }, el, T };
}

function soiContinuity(S, long) {
  // one fixed flyby of Pell (a moving body): in, around and out again
  let c = null, ref = null;
  for (let seed = 7; seed < 200; seed++) {
    c = targeted(pell, 3.0e6, 0.6, 0.35, 0.4, seed);
    if (!c) continue;
    ref = R.refPatched(sys, eph, c.state, c.T + 0.5 * c.el.period, { maxEvents: 2 });
    if (ref.events.length === 2 && ref.events[1].type === 'exit') break;
  }
  S.ok('reference flyby of Pell: enters and leaves', ref.events.length === 2 && ref.events[0].type === 'enter' && ref.events[1].type === 'exit', ref.events.map(e => e.type).join(','));
  const [ein, eout] = ref.events;
  const tEnd = eout.t + 3000;
  const refEnd = R.refPatched(sys, eph, c.state, tEnd).state;
  // textbook frame change at entry, written out: v_rel = v - v_moon, r_rel = r - r_moon, at the same instant
  const pre = R.keplerUV(c.state.r, c.state.v, verda.gm, ein.t - c.state.t), moon = eph.rel(pell, ein.t);
  S.check('reference: speed relative to Pell at entry = |v - v_Pell|', R.norm(R.sub(pre.v, moon.v)), R.norm(ein.v), 1e-9, { unit: 'm/s' });
  for (let idx = PHYSICS_WARP_MAX + 1; idx < WARP_RATES.length; idx++) {
    if (!long && ![4, 7, 10].includes(idx)) continue;
    const g = gameCoast(c.state, tEnd, { mode: 'active', maxWarp: idx, slice: 0.21 });
    const cmp = compareCoast(sys, eph, c.state, tEnd, g, ref);
    const lab = `Pell flyby as the flown vessel, up to ${WARP_RATES[idx]}x`;
    S.ok(`${lab}: same SOI changes as the reference (verda>pell, pell>verda)`, cmp.sameSequence, `${cmp.gSeq} | ${cmp.rSeq}`);
    S.check(`${lab}: SOI entry/exit time error, worst`, 0, cmp.worstDt, 1e-3, { unit: 's' });
    S.check(`${lab}: position continuity across the frame changes, worst`, 0, cmp.worstPos, 0.05, { unit: 'm' });
    S.check(`${lab}: velocity continuity (moon's velocity subtracted / added), worst`, 0, cmp.worstVel, 1e-4, { unit: 'm/s' });
    S.check(`${lab}: position after the flyby vs reference`, 0, g.end.bodyId === refEnd.body.id ? R.dist(g.end.r, refEnd.r) : NaN, 5, { unit: 'm' });
  }
  for (const [slice, rate] of [[1, 100000], [0.016, 100000], [3, 1000]]) {
    const g = gameCoast(c.state, tEnd, { mode: 'background', maxWarp: WARP_RATES.indexOf(rate), slice });
    const lab = `Pell flyby as a background vessel, ${rate}x in ${(slice * rate).toFixed(0)} s steps`;
    S.ok(`${lab}: both SOI changes happen`, g.events.map(e => e.to).join('>') === 'pell>verda', g.events.map(e => e.to).join('>'));
    S.check(`${lab}: position after the flyby vs reference`, 0, g.end.bodyId === refEnd.body.id ? R.dist(g.end.r, refEnd.r) : NaN, 5, { unit: 'm' });
    S.check(`${lab}: velocity after the flyby vs reference`, 0, R.dist(g.end.v, refEnd.v), 1e-3, { unit: 'm/s' });
  }
  // physics stepping across the boundary (1x and 4x): start 12 s before the entry / the exit
  for (const [ev, name] of [[ein, 'entry'], [eout, 'exit']]) for (const idx of [0, PHYSICS_WARP_MAX]) {
    const from = ev === ein ? { body: verda, ...R.keplerUV(c.state.r, c.state.v, verda.gm, ev.t - 12 - c.state.t), t: ev.t - 12 }
      : { body: pell, ...R.keplerUV(ein.r, ein.v, pell.gm, ev.t - 12 - ein.t), t: ev.t - 12 };
    const w = new World({ ut: from.t });
    const v = spawn(w, capsule(), from.body.id, from.r, from.v);
    let tEv = null, at = null;
    w.on('soi', () => { tEv = w.ut; at = { r: A(v.pos), v: A(v.vel) }; });
    w.setWarp(idx);
    while (w.ut < from.t + 24) w.step(0.05);
    const lab = `Pell SOI ${name} under ${WARP_RATES[idx]}x physics stepping`;
    S.ok(`${lab}: the change happens`, tEv !== null);
    const dtMax = idx ? 0.1 : 0.02;
    S.check(`${lab}: time of the change vs reference (within one sub-step of ${dtMax} s)`, ev.t, tEv ?? NaN, dtMax * 1.01 + 1e-6, { unit: 's' });
    if (at) {
      const back = R.keplerUV(ev.r, ev.v, ev.to.gm, tEv - ev.t);
      S.check(`${lab}: position continuity`, 0, R.dist(at.r, back.r), 0.02, { unit: 'm' });
      S.check(`${lab}: velocity continuity`, 0, R.dist(at.v, back.v), 2e-4, { unit: 'm/s' });
    }
  }
}

// ---------------------------------------------------------------------------------------------- 3c
function fuzzOne(state, tEnd0, mode, maxEvents = 3) {
  const ref = R.refPatched(sys, eph, state, tEnd0, { maxEvents });
  const last = ref.events.at(-1);
  const tEnd = last && (ref.events.length >= maxEvents || !last.to) ? last.t - 40 : tEnd0;
  if (!(tEnd > state.t + 1)) return null;
  const refSoi = ref.events.filter(e => e.to && e.t < tEnd);
  const game = gameCoast(state, tEnd, { mode });
  const cmp = compareCoast(sys, eph, state, tEnd, game, { events: refSoi });
  const refEnd = R.refPatched(sys, eph, state, tEnd, { maxEvents }).state;
  const sameBody = game.end.bodyId === refEnd.body.id;
  return {
    n: refSoi.length, ok: cmp.sameSequence && sameBody && Math.abs(game.end.t - tEnd) < 1e-3,
    dt: mode === 'active' ? cmp.worstDt : 0, end: sameBody ? R.dist(game.end.r, refEnd.r) / R.norm(refEnd.r) : Infinity,
    detail: `game [${cmp.gSeq}] ref [${cmp.rSeq}] t0=${state.t} tEnd=${tEnd} stopped=${game.stopped} state=${JSON.stringify({ body: state.body.id, r: state.r, v: state.v, t: state.t })}`,
  };
}

function encounterFuzz(S, long) {
  // (i) aimed encounters with every body that has an SOI: slow and fast, short and multi-revolution leads
  const perBody = long ? 40 : 4;
  let total = 0, events = 0, bad = 0, worstDt = 0, worstEnd = 0, firstBad = '';
  const small = { n: 0, bad: 0 };
  for (const mode of ['active', 'background']) {
    for (const c of sys.bodies.filter(b => b.parent)) {
      const rnd = rng(1000 + c.radius % 977 + (mode === 'active' ? 0 : 5));
      let made = 0;
      for (let k = 0; k < perBody * 3 && made < perBody; k++) {
        const fast = k % 2 === 1;
        const tc = targeted(c, 2e6 + 5e8 * rnd() * (k % 3 === 0 ? 0.01 : 1), 0.05 + 0.9 * rnd(),
          Math.pow(10, fast ? -0.5 + 0.7 * rnd() : -2 + 1.5 * rnd()), 0.05 + (k % 4 === 0 ? 3.5 : 0.9) * rnd(), 1 + Math.floor(rnd() * 1e6));
        if (!tc) continue;
        const r = fuzzOne(tc.state, tc.T + 0.3 * tc.el.period, mode);
        if (!r) continue;
        made++; total++; events += r.n;
        if (c.soiLaplace < 1e6) small.n++;
        if (!r.ok) { bad++; if (c.soiLaplace < 1e6) small.bad++; if (!firstBad) firstBad = `${c.id} ${mode}: ${r.detail}`; }
        else { worstDt = Math.max(worstDt, r.dt); worstEnd = Math.max(worstEnd, r.end); }
      }
    }
  }
  S.check(`aimed encounters, all 18 bodies, flown and background vessels: ${total} flights, ${events} SOI changes; flights that differ from the reference`, 0, bad, 0, { note: firstBad });
  S.check(`aimed encounters with the small moons (SOI < 1000 km: Dray, Nock, Nym, Wend): ${small.n} flights; missed or wrong`, 0, small.bad, 0);
  S.check('aimed encounters: worst SOI-change time error (flown vessel)', 0, worstDt, 2e-3, { unit: 's' });
  S.check('aimed encounters: worst end position error / distance', 0, worstEnd, 2e-5, { note: 'flybys amplify the 1e-5 s root-finding tolerance' });

  // (ii) unaimed random orbits among the moons of Verda and Thal and among the planets: sequence and ordering
  for (const pid of ['verda', 'thal', 'helion']) {
    const P = sys.byId[pid], rnd = rng(31337 + P.children.length), N = long ? 80 : 8;
    let n = 0, ev = 0, wrong = 0, wEnd = 0, first = '';
    for (let k = 0; k < N; k++) {
      const kids = P.children;
      const far = Math.max(...kids.map(c => c.elements.a * (1 + c.elements.e))), near = Math.min(...kids.map(c => c.elements.a * (1 - c.elements.e)));
      const rpMin = P.radius * 1.3 + (P.atmo ? P.atmo.height : 0);
      let rp, ra;
      if (rnd() < 0.5) { rp = rpMin + (near - rpMin) * rnd(); ra = far * (0.3 + 1.2 * rnd()); }
      else { const c = kids[Math.floor(rnd() * kids.length)]; rp = c.elements.a * (0.6 + 0.5 * rnd()); ra = c.elements.a * (0.95 + 0.8 * rnd()); }
      if (rp > ra) [rp, ra] = [ra, rp];
      const a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
      const el = { a, e, i: rnd() < 0.5 ? 0 : 6 * rnd(), lan: 360 * rnd(), argp: 360 * rnd(), M0: R.TAU * rnd() };
      const t0 = 1e7 * rnd(), s = R.elementsToState(el, P.gm, t0, t0);
      const r = fuzzOne({ body: P, r: s.r, v: s.v, t: t0 }, t0 + Math.min(R.orbitPeriod(P.gm, a) * (2 + 6 * rnd()), 4e8), k % 2 ? 'active' : 'background', 4);
      if (!r) continue;
      n++; ev += r.n;
      if (!r.ok) { wrong++; if (!first) first = r.detail; } else wEnd = Math.max(wEnd, r.end);
    }
    S.check(`random orbits around ${P.name}: ${n} flights, ${ev} SOI changes; flights whose sequence of bodies differs from the reference`, 0, wrong, 0, { note: first });
    S.check(`random orbits around ${P.name}: worst end position error / distance`, 0, wEnd, 1e-5);
  }
}

// the map's prediction (predictPatches) alone, against the reference, including what the old sampler missed
function mapPrediction(S) {
  const cases = [];
  const rnd = rng(4242);
  for (const c of sys.bodies.filter(b => b.parent)) for (let k = 0; k < 12; k++) {
    const tc = targeted(c, 2e6 + 5e8 * rnd(), 0.05 + 0.9 * rnd(), Math.pow(10, k % 2 ? -0.5 + 0.7 * rnd() : -2 + 1.7 * rnd()), 0.05 + 0.9 * rnd(), 1 + Math.floor(rnd() * 1e6));
    if (tc) cases.push({ c, tc });
  }
  let n = 0, miss = 0, worstT = 0, worstPe = 0;
  for (const { c, tc } of cases) {
    const ref = R.refPatched(sys, eph, tc.state, tc.T + 0.05 * tc.el.period, { maxEvents: 1 });
    const e = ref.events[0];
    if (!e || e.type !== 'enter') continue;
    n++;
    const P = SYSTEM.byId[c.parent.id];
    const p = predictPatches(Orbit.fromState(V(tc.state.r), V(tc.state.v), P.gm, tc.state.t), P, tc.state.t, 2);
    if (p[0].endType !== 'enter' || p[0].nextBody.id !== e.to.id || !p[1]) { miss++; continue; }
    worstT = Math.max(worstT, Math.abs(p[0].tEnd - e.t));
    const want = R.stateToElements(e.r, e.v, e.to.gm);
    worstPe = Math.max(worstPe, Math.abs(p[1].orbit.periapsis - want.rp) / want.rp);
  }
  S.check(`map prediction: ${n} aimed encounters (all bodies); first encounter missed or with the wrong body`, 0, miss, 0);
  S.check('map prediction: encounter time error, worst', 0, worstT, 1e-3, { unit: 's' });
  S.check('map prediction: predicted periapsis at the encountered body, worst rel error', 0, worstPe, 1e-6);
}

// ---------------------------------------------------------------------------------------------- 3e
/** Angle (rad, -pi..pi) from a to b measured in the prograde sense about the orbit normal n. */
const phaseOf = (a, b, n) => Math.atan2(R.dot(R.cross(a, b), n), R.dot(a, b));

function hohmannToPell(S) {
  const r1 = verda.radius + 100e3, r2 = pell.elements.a;
  const tb = R.hohmann(verda.gm, r1, r2);
  S.info('textbook Hohmann 100 km Verda orbit -> Pell orbit radius: departure burn', tb.dv1, 'm/s');
  S.info('textbook: transfer time', tb.tof, 's');
  S.info('textbook: phase angle (Pell ahead of the ship at the burn)', tb.phase * deg, 'deg');
  const w = new World();
  const v = spawn(w, simpleShip(), 'verda', [r1, 0, 0], [0, 0, -R.circularSpeed(verda.gm, r1)]);
  v.ctrl.sas = true; w.stage();
  const gPell = SYSTEM.byId.pell;
  // the map's transfer-window helper
  const ui = uiTransferWindow(v.getOrbit(0), gPell.orbit, 0);
  S.check('map helper: phase angle needed vs textbook', tb.phase * deg, ui.phaseNeeded * deg, 1e-6, { unit: 'deg' });
  S.check('map helper: transfer time vs textbook', tb.tof, ui.transferTime, 1e-6, { unit: 's' });
  S.check('map helper: departure delta-v vs textbook', tb.dv1, ui.vInf, 1e-6, { unit: 'm/s' });
  S.check('map helper: arrival speed relative to Pell vs textbook', tb.dv2, ui.vArr, 1e-6, { unit: 'm/s' });
  const n1 = Math.sqrt(verda.gm / r1 ** 3), n2 = Math.sqrt(verda.gm / r2 ** 3);
  const p0 = phaseOf([r1, 0, 0], eph.rel(pell, 0).r, [0, 1, 0]);
  let wait = (p0 - tb.phase) / (n1 - n2); const syn = R.TAU / (n1 - n2); wait -= syn * Math.floor(wait / syn);
  S.check('map helper: time to the window vs textbook (phase closes at n1 - n2)', wait, ui.timeToWindow, 1e-3, { unit: 's' });
  // the planner (searches for an encounter with a 15 % radius periapsis, so it differs a little from the centre-to-centre textbook case)
  const plan = AP.planHohmannToMoon(w, v, gPell);
  S.ok('planner finds a transfer to Pell', !!plan);
  S.check('planner: departure delta-v vs textbook Hohmann', tb.dv1, plan.dv, 0.01, { unit: 'm/s', rel: true });
  const atNode = R.keplerUV([r1, 0, 0], [0, 0, -R.circularSpeed(verda.gm, r1)], verda.gm, plan.node.t);
  const phaseNode = phaseOf(atNode.r, eph.rel(pell, plan.node.t).r, [0, 1, 0]);
  // meeting Pell at the leading or trailing edge of its SOI instead of at its centre moves the phase by up to
  // asin(SOI / a) = 11.6 deg either way; the planner takes the first window it finds (the leading edge)
  S.check('planner: phase angle at its node vs textbook (centre-to-centre)', tb.phase * deg, phaseNode * deg, Math.asin(pell.soiLaplace / r2) * deg + 1, { unit: 'deg', note: 'tolerance = angular radius of the SOI: an edge encounter, not a centre hit' });
  S.check('planner: time from the burn to the SOI of Pell vs textbook half-ellipse', tb.tof, plan.encounterUt - plan.node.t, 0.15, { unit: 's', rel: true });
  // the reference's own answer for the planned impulsive burn
  const vAfter = R.add(atNode.v, R.scale(R.unit(atNode.v), plan.dv));
  const refPlan = R.refPatched(sys, eph, { body: verda, r: atNode.r, v: vAfter, t: plan.node.t }, plan.node.t + 2 * tb.tof, { maxEvents: 1 });
  const e0 = refPlan.events[0];
  S.ok('reference agrees the planned burn reaches Pell', !!e0 && e0.type === 'enter' && e0.to.id === 'pell');
  const refPe = R.stateToElements(e0.r, e0.v, pell.gm);
  S.check('planner: predicted SOI entry time vs reference (impulsive burn)', e0.t, plan.encounterUt, 0.01, { unit: 's' });
  S.check('planner: predicted periapsis altitude at Pell vs reference', refPe.rp - pell.radius, plan.periapsis, 1, { unit: 'm' });
  // now fly it: finite burn, then coast on rails to Pell
  const ctl = AP.executeNode(w, v, { useWarp: true });
  AP.fly(w, ctl, { maxSim: 2e5 });
  S.ok('the injection burn completed', ctl.done && !ctl.failed);
  const post = { body: verda, r: A(v.pos), v: A(v.vel), t: w.ut };
  const refFly = R.refPatched(sys, eph, post, w.ut + 2 * tb.tof, { maxEvents: 1 });
  const map = predictPatches(v.getOrbit(w.ut), v.body, w.ut, 3);
  const enc = map.find(p => p.body.id === 'pell');
  S.ok('after the real burn the map still shows a Pell encounter', !!enc);
  const refPe2 = R.stateToElements(refFly.events[0].r, refFly.events[0].v, pell.gm);
  S.check('after the burn: map SOI entry time vs reference', refFly.events[0].t, enc ? enc.tStart : NaN, 0.01, { unit: 's' });
  S.check('after the burn: map periapsis at Pell vs reference', refPe2.rp - pell.radius, enc ? enc.orbit.periapsis - pell.radius : NaN, 1, { unit: 'm' });
  let tSoi = null;
  w.on('soi', d => { if (d.vessel === v && tSoi === null) tSoi = w.ut; });
  while (tSoi === null && w.ut < post.t + 2 * tb.tof) { if (w.warpTarget === null) w.warpTo(post.t + 2 * tb.tof); w.step(0.5); }
  S.ok('flown: arrives in the SOI of Pell', v.body.id === 'pell');
  S.check('flown: SOI entry time vs the map prediction made after the burn', enc ? enc.tStart : NaN, tSoi ?? NaN, 0.01, { unit: 's' });
  const got = R.stateToElements(A(v.pos), A(v.vel), pell.gm);
  S.check('flown: periapsis altitude at Pell vs the map prediction made after the burn', enc ? enc.orbit.periapsis - pell.radius : NaN, got.rp - pell.radius, 1, { unit: 'm' });
  // finite-burn error, stated as an equivalent delta-v error at the node (reference: periapsis for dv +- 1 m/s)
  const peFor = d => { const q = R.refPatched(sys, eph, { body: verda, r: atNode.r, v: R.add(atNode.v, R.scale(R.unit(atNode.v), plan.dv + d)), t: plan.node.t }, plan.node.t + 2 * tb.tof, { maxEvents: 1 }).events[0]; return q && q.to ? R.stateToElements(q.r, q.v, pell.gm).rp : NaN; };
  const sens = Math.max(Math.abs(peFor(1) - peFor(0)), Math.abs(peFor(-1) - peFor(0)));
  const burnS = plan.dv / (65000 / v.mass) * 0.75, arc = burnS * n1;
  const budget = 0.2 + plan.dv * arc * arc / 12;
  S.info('injection: periapsis at Pell moves per 1 m/s of burn error by', sens, 'm', `burn lasts ~${burnS.toFixed(0)} s (${(arc * deg).toFixed(1)} deg of orbit); error budget ${budget.toFixed(2)} m/s`);
  S.check('flown: periapsis altitude vs the plan made before the burn (finite-burn error)', plan.periapsis, got.rp - pell.radius, budget * sens, { unit: 'm', note: `= ${(Math.abs(got.rp - pell.radius - plan.periapsis) / sens).toFixed(2)} m/s equivalent; a mid-course correction is expected` });
  S.check('flown: SOI entry time vs the plan', plan.encounterUt, tSoi ?? NaN, 900, { unit: 's' });
  // arrival speed relative to Pell vs textbook (Pell's speed minus the transfer ellipse's apoapsis speed)
  S.check('flown: speed relative to Pell at SOI entry vs textbook Hohmann arrival speed', tb.dv2, v.vel.length(), 0.06, { unit: 'm/s', rel: true });
  const vInf = Math.sqrt(Math.max(0, R.dot(A(v.vel), A(v.vel)) - 2 * pell.gm / v.pos.length()));
  S.check('flown: v-infinity of the Pell hyperbola = sqrt(v_soi^2 - 2GM/r_soi)', Math.sqrt(-pell.gm / got.a), vInf, 1e-9, { unit: 'm/s' });
  S.info('flown: sense of the pass around Pell', R.unit(got.h)[1] > 0 ? 'prograde' : 'retrograde');
  // does aiming at the leading edge of the SOI (phase 98.8 deg) instead of the centre (110.6 deg) cost anything?
  // departure: nothing (the planner burns the Hohmann delta-v, row above). Arrival: compare the capture burn.
  const capAt = (vi, rp) => Math.sqrt(vi * vi + 2 * pell.gm / rp) - Math.sqrt(pell.gm / rp);
  const vInfCentre = Math.sqrt(tb.dv2 * tb.dv2 - 2 * pell.gm / pell.soiLaplace);        // centre-to-centre Hohmann, SOI edge at Pell's distance
  const vInfFlown = Math.sqrt(-pell.gm / got.a);
  S.check('edge aim vs centre aim: capture burn into a circular orbit at the flown periapsis', capAt(vInfCentre, got.rp), capAt(vInfFlown, got.rp), 0.03, { unit: 'm/s', rel: true, note: `v-infinity ${vInfFlown.toFixed(1)} vs ${vInfCentre.toFixed(1)} m/s for a centre hit` });
  S.check('edge aim vs centre aim: departure + capture, whole trip', tb.dv1 + capAt(vInfCentre, got.rp), plan.dv + capAt(vInfFlown, got.rp), 0.01, { unit: 'm/s', rel: true, note: 'the earlier phase angle costs under 1 % and saves waiting; no encounter is missed (3c, 3d)' });
}

// ---------------------------------------------------------------------------------------------- 3f
function interplanetary(S, target = 'rusk') {
  const tgt = sys.byId[target], gT = SYSTEM.byId[target], gH = SYSTEM.byId.verda, mu = sys.byId.helion.gm;
  const win = AP.transferWindow(gH, gT, 0);
  S.ok(`a launch window from Verda to ${tgt.name} exists`, !!win);
  const A1 = eph.rel(verda, win.t), B1 = eph.rel(tgt, win.t), B2 = eph.rel(tgt, win.t + win.tof);
  const n = R.unit(R.cross(A1.r, A1.v));
  const r1 = R.norm(A1.r), r2 = R.norm(B2.r), at = (r1 + r2) / 2;
  const proj = R.sub(B2.r, R.scale(n, R.dot(B2.r, n)));
  S.check('window: target at arrival is opposite the departure point', 180, Math.abs(phaseOf(A1.r, proj, n)) * deg, 1e-4, { unit: 'deg' });
  S.check('window: phase angle at departure (measured with the reference ephemeris)', phaseOf(A1.r, R.sub(B1.r, R.scale(n, R.dot(B1.r, n))), n) * deg, win.phase * deg, 1e-6, { unit: 'deg' });
  const circ = R.hohmann(mu, verda.elements.a, tgt.elements.a);
  S.check('window: phase angle vs circular-coplanar textbook value', circ.phase * deg, win.phase * deg, 12, { unit: 'deg', note: `${tgt.name} has e = ${tgt.elements.e}: its angular speed varies by +-${(2 * tgt.elements.e * 100).toFixed(0)} %` });
  S.check('window: transfer time vs circular-coplanar textbook value', circ.tof, win.tof, 0.08, { unit: 's', rel: true });
  const syn = 1 / Math.abs(1 / verda.period - 1 / tgt.period);
  S.check('window: synodic period', syn, win.synodic, 1e-9, { unit: 's', rel: true });
  // excess speeds: departure tangential from Verda's radius, arrival against the target's actual velocity
  const tang = R.unit(R.cross(n, A1.r));
  const vInfDep = R.norm(R.sub(R.scale(tang, R.visViva(mu, r1, at)), A1.v));
  const tang2 = R.unit(R.cross(n, B2.r));
  const vInfArr = R.norm(R.sub(R.scale(tang2, R.visViva(mu, r2, at)), B2.v));
  S.check('window: departure excess speed (v-infinity) vs textbook', vInfDep, win.vInfDepart, 1e-6, { unit: 'm/s', rel: true });
  S.check('window: arrival excess speed (v-infinity) vs textbook', vInfArr, win.vInfArrive, 1e-6, { unit: 'm/s', rel: true });
  S.info('circular-coplanar textbook v-infinity at departure / arrival', `${circ.vInf1.toFixed(1)} / ${circ.vInf2.toFixed(1)}`, 'm/s');
  const rPark = verda.radius + 120e3;
  S.check('window: ejection delta-v from a 120 km orbit = sqrt(vinf^2 + 2GM/r) - sqrt(GM/r)', R.ejectionDv(verda.gm, rPark, vInfDep), win.ejectionDv(rPark), 1e-6, { unit: 'm/s', rel: true });
  S.check('window: ejection angle = acos(-1/e), e = 1 + r vinf^2 / GM', Math.acos(-1 / (1 + rPark * vInfDep ** 2 / verda.gm)) * deg, win.ejectionAngle(rPark) * deg, 1e-6, { unit: 'deg' });
  const rCap = tgt.radius + 100e3;
  S.check('window: capture delta-v at the target', R.ejectionDv(tgt.gm, rCap, vInfArr), win.captureDv(rCap), 1e-6, { unit: 'm/s', rel: true });

  S.check('window: transfer time = pi sqrt(a_t^3 / GM) for the actual radii', Math.PI * Math.sqrt(at ** 3 / mu), win.tof, 10, { unit: 's', note: 'the game iterates the arrival radius 4 times' });

  // ---- (A) the textbook transfer flown by hand: burn the textbook delta-v at the textbook point, see what the game does
  {
    const w = new World({ ut: win.t - 20000 });
    const s0 = { r: [rPark, 0, 0], v: [0, 0, -R.circularSpeed(verda.gm, rPark)] };
    const v = spawn(w, simpleShip(), 'verda', s0.r, s0.v);
    v.ctrl.sas = true; w.stage();
    // periapsis of the escape hyperbola: the outgoing asymptote (along Verda's motion for an outward transfer) turned
    // back by the asymptote angle acos(-1/e) about the orbit normal
    const dirInf = R.unit(R.sub(R.scale(tang, R.visViva(mu, r1, at)), A1.v));
    const eHyp = 1 + rPark * vInfDep ** 2 / verda.gm, nuInf = Math.acos(-1 / eHyp);
    const h = [0, 1, 0];
    const rotY = (x, ang) => R.add(R.scale(x, Math.cos(ang)), R.scale(R.cross(h, x), Math.sin(ang)));
    const pHat = rotY(dirInf, -nuInf);
    const nPark = Math.sqrt(verda.gm / rPark ** 3);
    let ang = phaseOf(R.unit(s0.r), pHat, h); if (ang < 0) ang += R.TAU;
    // first pass over that point at least 300 s from now and as close to the window as the parking orbit allows
    let tNode = w.ut + ang / nPark; while (tNode < win.t - Math.PI / nPark) tNode += R.TAU / nPark;
    const dvTb = R.ejectionDv(verda.gm, rPark, vInfDep);
    v.addNode(tNode, { prograde: dvTb });
    const ctl = AP.executeNode(w, v, { useWarp: true });
    AP.fly(w, ctl, { maxSim: 1e6 });
    S.ok('textbook ejection: burn completed', ctl.done && !ctl.failed);
    const hyp = R.stateToElements(A(v.pos), A(v.vel), verda.gm);
    S.check('textbook ejection: v-infinity of the escape hyperbola vs textbook', vInfDep, Math.sqrt(-verda.gm / hyp.a), 0.01, { unit: 'm/s', rel: true, note: 'finite burn of ~50 s' });
    let tExit = null;
    w.on('soi', d => { if (d.vessel === v && tExit === null) tExit = w.ut; });
    while (tExit === null && w.ut < tNode + 4e6) { if (w.warpTarget === null) w.warpTo(tNode + 4e6); w.step(0.5); }
    S.ok('textbook ejection: leaves the SOI of Verda into solar orbit', v.body.id === 'helion');
    const helio = R.stateToElements(A(v.pos), A(v.vel), mu);
    const vb = eph.rel(verda, tExit);
    const vExcess = R.sub(A(v.vel), vb.v);
    S.check('textbook ejection: excess velocity at the SOI edge points along Verda\'s motion (angle off)', 0, R.angleBetween(vExcess, vb.v) * deg, 4, { unit: 'deg', note: 'the asymptote is only reached at infinity; SOI is 118 radii out' });
    S.check('textbook ejection: speed gained over Verda in solar orbit vs v-infinity', vInfDep, R.norm(A(v.vel)) - R.norm(vb.v), 0.06, { unit: 'm/s', rel: true });
    // the textbook treats the SOI as infinitely far away; at the real SOI edge the ship still has sqrt(v_inf^2 + 2GM/r_soi)
    const vEdge = Math.sqrt(vInfDep ** 2 + 2 * verda.gm / verda.soiLaplace);
    S.check('textbook ejection: speed relative to Verda at the SOI edge vs sqrt(v_inf^2 + 2GM/r_soi)', vEdge, R.norm(vExcess), 0.01, { unit: 'm/s', rel: true });
    // the same burn as one impulse through the independent patched-conic reference
    const nodeRef = R.keplerUV(s0.r, s0.v, verda.gm, tNode - (win.t - 20000));
    const refEj = R.refPatched(sys, eph, { body: verda, r: nodeRef.r, v: R.add(nodeRef.v, R.scale(R.unit(nodeRef.v), dvTb)), t: tNode }, tNode + 4e6, { maxEvents: 1 });
    const rOut = refEj.events.find(e => e.type === 'exit');
    S.ok('reference: the impulsive textbook burn leaves Verda', !!rOut);
    if (rOut) {
      const refHelio = R.stateToElements(rOut.r, rOut.v, mu);
      S.check('textbook ejection: SOI exit time vs reference (impulsive)', rOut.t, tExit, 900, { unit: 's', note: 'finite burn of ~50 s on a ~1e5 s climb to the SOI edge' });
      S.check('textbook ejection: aphelion of the solar orbit vs reference (impulsive)', refHelio.ra, helio.ra, 0.005, { unit: 'm', rel: true, note: 'finite burn' });
      S.check('textbook ejection: perihelion vs reference (impulsive)', refHelio.rp, helio.rp, 0.002, { unit: 'm', rel: true });
      S.check('textbook ejection: solar orbit period vs reference (impulsive)', refHelio.period, helio.period, 0.005, { unit: 's', rel: true });
    }
    S.check('textbook ejection: perihelion vs Verda\'s distance', r1, helio.rp, 0.01, { unit: 'm', rel: true });
    S.check('textbook ejection: solar orbit stays in Verda\'s orbital plane', 0, helio.inc * deg, 0.01, { unit: 'deg' });
    const note = `finite SOI: the ship leaves with ${vEdge.toFixed(0)} m/s, not the textbook ${vInfDep.toFixed(0)} m/s (SOI is only ${(verda.soiLaplace / r1 * 100).toFixed(2)} % of the orbit radius but GM/r_soi is not negligible)`;
    S.info('textbook ejection: aphelion / target distance at arrival', `${helio.ra.toExponential(4)} / ${r2.toExponential(4)}`, 'm', note);
    S.info('textbook ejection: half period of the solar orbit / Hohmann transfer time', `${(helio.period / 2).toFixed(0)} / ${win.tof.toFixed(0)}`, 's');
    const tAp = tExit + R.keplerTimeToApo(A(v.pos), A(v.vel), mu);
    const ship = R.keplerUV(A(v.pos), A(v.vel), mu, tAp - tExit), tg = eph.rel(tgt, tAp);
    const d = R.sub(tg.r, ship.r);
    const outOfPlane = Math.abs(R.dot(d, n)), inPlane = Math.sqrt(Math.max(0, R.dot(d, d) - outOfPlane ** 2));
    S.info('textbook ejection: miss at aphelion without any correction, in-plane / out-of-plane, in target SOI radii', `${(inPlane / tgt.soiLaplace).toFixed(1)} / ${(outOfPlane / tgt.soiLaplace).toFixed(1)}`, '', `target inclination ${tgt.elements.i} deg; a textbook burn alone does not arrive: a correction burn is always needed`);
    S.info('textbook ejection: speed relative to the target at aphelion / textbook arrival v-infinity', `${R.dist(ship.v, tg.v).toFixed(0)} / ${vInfArr.toFixed(0)}`, 'm/s');
  }

  // ---- (B) the game's own planner, flown the way the game's flight test flies it (planar ejection, mid-course fix)
  const w = new World();
  const v = spawn(w, simpleShip(), 'verda', [rPark, 0, 0], [0, 0, -R.circularSpeed(verda.gm, rPark)]);
  v.ctrl.sas = true; w.stage();
  const plan = AP.planInterplanetary(w, v, gT, { planar: true, periapsis: 400e3 });
  S.ok('planner returns an ejection node', !!plan && !!plan.node);
  S.check('planner: node within a few days of the window', win.t, plan.node.t, 5 * 86400, { unit: 's' });
  const optEj = Math.sqrt(vInfDep ** 2 + 2 * verda.gm / rPark - 2 * verda.gm / verda.soiLaplace) - R.circularSpeed(verda.gm, rPark);
  S.check('planner: ejection delta-v vs minimum-energy patched conic (v-infinity at the SOI edge)', optEj, plan.dv, 0.02, { unit: 'm/s', rel: true, note: 'the old planner burned 1127.9 m/s here (+8 %)' });
  const horizon = plan.node.t + 2.2 * win.tof;
  const ctl = AP.executeNode(w, v, { useWarp: true });
  AP.fly(w, ctl, { maxSim: 3e7 });
  S.ok('the ejection burn completed', ctl.done && !ctl.failed, ctl.log.map(l => l.msg).join('; '));
  const coast = (until, lim) => { while (!until() && w.ut < lim && !v.dead) { if (w.warpTarget === null) w.warpTo(lim); w.step(0.5); } w.cancelWarpTo(); w.setWarp(0); };
  coast(() => v.body.id !== 'verda', w.ut + 5e6);
  const tEj = w.ut;
  coast(() => w.ut > tEj + win.tof * 0.4, horizon);
  const corr = AP.planCorrection(w, v, gT, { seek: true, periapsis: 400e3, horizon: 1.3 * win.tof });
  S.ok('mid-course correction finds the target', !!corr && corr.periapsis !== null);
  if (corr && corr.node) AP.fly(w, AP.executeNode(w, v, { useWarp: true }), { maxSim: 3e7 });
  S.info('planner: ejection burn / mid-course correction', `${plan.dv.toFixed(1)} / ${corr ? corr.dv.toFixed(1) : '?'}`, 'm/s', `minimum-energy ejection ${optEj.toFixed(1)} m/s; the correction is mostly the 1.5 deg tilt of Rusk's orbit`);
  const map = predictPatches(v.getOrbit(w.ut), v.body, w.ut, 4);
  const enc = map.find(p => p.body.id === target);
  S.ok('the map shows the encounter with the target', !!enc);
  const now = { body: sys.byId[v.body.id], r: A(v.pos), v: A(v.vel), t: w.ut };
  const refFly = R.refPatched(sys, eph, now, horizon, { maxEvents: 3 });
  const rIn = refFly.events.find(e => e.to && e.to.id === target);
  S.ok('reference: the flown trajectory enters the target SOI', !!rIn, refFly.events.map(e => `${e.type} ${e.to ? e.to.id : ''}`).join(', '));
  if (!enc || !rIn) return;
  const refEl = R.stateToElements(rIn.r, rIn.v, tgt.gm);
  S.check('map prediction: time of the target SOI entry vs reference', rIn.t, enc.tStart, 0.05, { unit: 's' });
  S.check('map prediction: periapsis altitude at the target vs reference', refEl.rp - tgt.radius, enc.orbit.periapsis - tgt.radius, 20, { unit: 'm' });
  // fly the coast at full warp and see what the simulation then does
  const seen = [];
  w.on('soi', d => { if (d.vessel === v) seen.push({ t: w.ut, to: d.to.id, r: A(v.pos), v: A(v.vel) }); });
  while (v.body.id !== target && w.ut < horizon && !v.dead) { if (w.warpTarget === null) w.warpTo(horizon); w.step(0.5); }
  S.ok(`flown at up to 100 000x: arrives in the SOI of ${tgt.name}`, v.body.id === target, seen.map(e => e.to).join(' > '));
  const arr = seen.find(e => e.to === target);
  if (!arr) return;
  S.check('flown: time of the SOI entry vs the map prediction', enc.tStart, arr.t, 0.05, { unit: 's' });
  const gotEl = R.stateToElements(arr.r, arr.v, tgt.gm);
  S.check('flown: periapsis altitude at the target vs the map prediction', enc.orbit.periapsis - tgt.radius, gotEl.rp - tgt.radius, 20, { unit: 'm' });
  S.check('flown: periapsis altitude vs reference patched conics', refEl.rp - tgt.radius, gotEl.rp - tgt.radius, 20, { unit: 'm' });
  const vInfGot = Math.sqrt(-tgt.gm / gotEl.a);
  S.check('flown: arrival v-infinity vs reference patched conics', Math.sqrt(-tgt.gm / refEl.a), vInfGot, 1e-3, { unit: 'm/s' });
  S.check('planner flight: arrival v-infinity vs textbook Hohmann value', vInfArr, vInfGot, 0.35, { unit: 'm/s', rel: true, note: 'old planner: 2254 m/s' });
  S.check('planner flight: transfer time vs textbook Hohmann time', win.tof / 86400, (arr.t - plan.node.t) / 86400, 0.25, { unit: 'days', rel: true, note: 'old planner: 44.7 days' });

  // ---- gravity assist: keep coasting through the target's SOI and out again
  const gIn = globalAt(v, arr.t, arr.r, arr.v, target);
  const eOut = [];
  w.on('soi', d => { if (d.vessel === v && d.from.id === target) eOut.push({ t: w.ut, r: A(v.pos), v: A(v.vel) }); });
  const lim = arr.t + 4 * R.TAU * Math.sqrt(tgt.soiLaplace ** 3 / tgt.gm);
  while (!eOut.length && w.ut < lim && !v.dead && w.warpIndex + (w.warpTarget !== null) + 1) {
    if (w.warpTarget === null) w.warpTo(lim);
    const u0 = w.ut; w.step(0.5);
    if (w.ut === u0 || (w.warpIndex === 0 && w.warpTarget === null && !eOut.length && v.pos.length() < tgt.radius + (tgt.atmo ? tgt.atmo.height : 0) + 50e3)) break;
  }
  if (!eOut.length) { S.info('gravity assist at the target: the pass hits the air or the ground, no flyby', 'skipped'); return; }
  const bo = eph.rel(tgt, eOut[0].t);          // the game reports the state after an exit in the parent's frame
  flybyChecks(S, `${tgt.name} flyby`, tgt, arr, { t: eOut[0].t, r: R.sub(eOut[0].r, bo.r), v: R.sub(eOut[0].v, bo.v) }, gIn, v, 'heliocentric');
}

/** Heliocentric (or parent-frame) velocity of a state given relative to body `id` at time t (reference ephemeris). */
function globalAt(v, t, r, vel, id) { const b = eph.rel(sys.byId[id], t); return { r: R.add(r, b.r), v: R.add(vel, b.v) }; }

/** Turn angle and parent-frame speed change of a flyby, against the hyperbola formulas. `ein`/`eout`: {t, r, v} in the body frame. */
function flybyChecks(S, lab, body, ein, eout, gIn, vessel, frameName) {
  const el = R.stateToElements(ein.r, ein.v, body.gm);
  const vInf = Math.sqrt(-body.gm / el.a);
  const fb = R.flyby(body.gm, el.rp, vInf);
  S.check(`${lab}: eccentricity = 1 + rp vinf^2 / GM`, fb.e, el.e, 1e-9);
  // the velocity turns by exactly 2 asin(1/e) between the asymptotes; between the two SOI crossings (finite radius)
  // it turns a little less: the angle between v(-nu) and v(+nu) of the same hyperbola
  const nu = Math.acos((el.p / R.norm(ein.r) - 1) / el.e);
  const turnSoi = 2 * Math.atan2(Math.sin(nu), el.e + Math.cos(nu));                 // direction change of the velocity vector
  const measured = R.angleBetween(ein.v, eout.v);
  S.check(`${lab}: velocity turn between SOI entry and exit vs the hyperbola`, Math.abs(turnSoi) * deg, measured * deg, 1e-6, { unit: 'deg' });
  S.info(`${lab}: asymptotic turn angle 2 asin(1/e)`, fb.turn * deg, 'deg', `periapsis ${(el.rp - body.radius).toFixed(0)} m above the surface, v-infinity ${vInf.toFixed(1)} m/s`);
  S.check(`${lab}: speed relative to the body is the same going out as coming in`, R.norm(ein.v), R.norm(eout.v), 1e-6, { unit: 'm/s' });
  S.check(`${lab}: time inside the SOI vs the hyperbola's time of flight`, 2 * hypTime(body.gm, el, R.norm(ein.r)), eout.t - ein.t, 0.01, { unit: 's' });
  // parent-frame speed change: v_out = v_body(t_out) + (rotated relative velocity)
  const bOut = eph.rel(body, eout.t);
  const hHat = R.unit(el.h), k = Math.abs(turnSoi);
  // rotate ein.v about the orbit normal by the turn angle (Rodrigues), in the sense of the motion
  const rot = (x, ang) => R.add(R.add(R.scale(x, Math.cos(ang)), R.scale(R.cross(hHat, x), Math.sin(ang))), R.scale(hHat, R.dot(hHat, x) * (1 - Math.cos(ang))));
  const vOutPred = R.add(bOut.v, rot(ein.v, k));
  const gOut = R.add(eout.v, bOut.v);
  S.check(`${lab}: ${frameName} velocity after the flyby vs formula (vector error)`, 0, R.dist(vOutPred, gOut), 1e-4, { unit: 'm/s' });
  S.check(`${lab}: ${frameName} speed change vs formula`, R.norm(vOutPred) - R.norm(gIn.v), R.norm(gOut) - R.norm(gIn.v), 1e-4, { unit: 'm/s' });
}
/** Time from periapsis to radius r on a hyperbola with elements el. */
function hypTime(mu, el, r) {
  const a = -el.a, F = Math.acosh((1 + r / a) / el.e);
  return Math.sqrt(a ** 3 / mu) * (el.e * Math.sinh(F) - F);
}

function pellFlyby(S) {
  let c = null, ref = null;
  for (let seed = 300; seed < 600; seed++) {
    c = targeted(pell, 5.1e6, 0.5, 0.45, 0.35, seed);
    if (!c) continue;
    ref = R.refPatched(sys, eph, c.state, c.T + 0.6 * c.el.period, { maxEvents: 2 });
    if (ref.events.length === 2 && ref.events[1].type === 'exit') break;
  }
  const g = gameCoast(c.state, ref.events[1].t + 100, { mode: 'active' });
  S.ok('Pell flyby: the game enters and leaves the SOI', g.events.length === 2);
  if (g.events.length !== 2) return;
  const gIn = globalAt(null, g.events[0].t, g.events[0].r, g.events[0].v, 'pell');
  const bo = eph.rel(pell, g.events[1].t);     // the game reports the state after an exit in the parent's frame
  flybyChecks(S, 'Pell flyby', pell, g.events[0], { t: g.events[1].t, r: R.sub(g.events[1].r, bo.r), v: R.sub(g.events[1].v, bo.v) }, gIn, g.vessel, 'Verda-centred');
}

// ---------------------------------------------------------------------------------------------- 3g
function rendezvous(S, long) {
  // target in a circular 250 km orbit; chaser nearby with a small offset and relative velocity (both under full physics)
  const r0 = verda.radius + 250e3, vc = R.circularSpeed(verda.gm, r0), n = vc / r0;
  const tgtS = { r: [r0, 0, 0], v: [0, 0, -vc] };
  // local frame of the target: x radial, y along-track, z = orbit normal
  const basis = s => { const x = R.unit(s.r), z = R.unit(R.cross(s.r, s.v)), y = R.cross(z, x); return { x, y, z }; };
  const toLocal = (ts, cs) => {
    const b = basis(ts), dr = R.sub(cs.r, ts.r), dv = R.sub(cs.v, ts.v);
    const w = R.scale(b.z, n);                                   // frame rotation
    const dvRot = R.sub(dv, R.cross(w, dr));
    return [R.dot(dr, b.x), R.dot(dr, b.y), R.dot(dr, b.z), R.dot(dvRot, b.x), R.dot(dvRot, b.y), R.dot(dvRot, b.z)];
  };
  const b0 = basis(tgtS);
  const rel0 = [120, -400, 60, 0.15, -0.25, 0.1];
  const w0 = R.scale(b0.z, n);
  const dr = R.add(R.add(R.scale(b0.x, rel0[0]), R.scale(b0.y, rel0[1])), R.scale(b0.z, rel0[2]));
  const dvRot = R.add(R.add(R.scale(b0.x, rel0[3]), R.scale(b0.y, rel0[4])), R.scale(b0.z, rel0[5]));
  const chS = { r: R.add(tgtS.r, dr), v: R.add(tgtS.v, R.add(dvRot, R.cross(w0, dr))) };
  const w = new World();
  const tgt = spawn(w, capsule(), 'verda', tgtS.r, tgtS.v);
  const ch = spawn(w, capsule(), 'verda', chS.r, chS.v);
  w.setTarget(ch, tgt);
  let worstCW = 0, worstExact = 0, worstHud = 0;
  const span = long ? 600 : 200;
  for (let t = 20; t <= span; t += 20) {
    run(w, 20, 1);
    const got = toLocal({ r: A(tgt.pos), v: A(tgt.vel) }, { r: A(ch.pos), v: A(ch.vel) });
    const cw = R.clohessyWiltshire(rel0, n, w.ut);
    worstCW = Math.max(worstCW, Math.hypot(got[0] - cw[0], got[1] - cw[1], got[2] - cw[2]));
    // exact: both on their own Kepler orbits
    const te = R.keplerUV(tgtS.r, tgtS.v, verda.gm, w.ut), ce = R.keplerUV(chS.r, chS.v, verda.gm, w.ut);
    worstExact = Math.max(worstExact, R.dist(R.sub(A(ch.pos), A(tgt.pos)), R.sub(ce.r, te.r)));
    worstHud = Math.max(worstHud, Math.abs(ch.targetInfo.distance - R.dist(ce.r, te.r)), Math.abs(ch.targetInfo.relSpeed - R.dist(ce.v, te.v)) * 100);
  }
  S.ok('both craft are simulated with full physics (within load range)', !tgt.onRails && !ch.onRails);
  S.check(`relative position over ${span} s vs exact two-orbit solution, worst`, 0, worstExact, 0.01, { unit: 'm' });
  // CW is a linearisation: its own error is of order (separation^2 / r) * (n t) ~ 0.5 m here
  S.check(`relative motion over ${span} s vs Clohessy-Wiltshire equations, worst`, 0, worstCW, long ? 3 : 1, { unit: 'm', note: 'CW is linearised: expected error ~ d^2/r x n t' });
  S.check('target readout: distance and relative speed vs exact (m, and cm/s)', 0, worstHud, 0.02);

  // closest approach prediction between two different orbits, against a brute-force search and against flying it
  const A0 = R.elementsToState({ a: verda.radius + 300e3, e: 0.02, i: 3, lan: 20, argp: 50, M0: 0.2 }, verda.gm, 0);
  const B0 = R.elementsToState({ a: verda.radius + 420e3, e: 0.05, i: 1, lan: 80, argp: 200, M0: 2.9 }, verda.gm, 0);
  const oA = Orbit.fromState(V(A0.r), V(A0.v), SYSTEM.byId.verda.gm, 0), oB = Orbit.fromState(V(B0.r), V(B0.v), SYSTEM.byId.verda.gm, 0);
  const horizon = 40000;
  const ca = closestApproach(oA, oB, 0, horizon);
  let best = { d: Infinity, t: 0 };
  const sep = t => R.dist(R.keplerUV(A0.r, A0.v, verda.gm, t).r, R.keplerUV(B0.r, B0.v, verda.gm, t).r);
  for (let t = 0; t <= horizon; t += 2) { const d = sep(t); if (d < best.d) best = { d, t }; }
  for (let h = 2; h > 1e-6; h /= 2) for (const t of [best.t - h, best.t + h]) { const d = sep(t); if (d < best.d) best = { d, t }; }
  S.check('closest approach of two orbits over 40 000 s: predicted distance vs brute-force reference', best.d, ca.distance, 0.01, { unit: 'm' });
  S.check('closest approach: predicted time vs reference', best.t, ca.t, 0.05, { unit: 's' });
  const w2 = new World();
  const a2 = spawn(w2, capsule(), 'verda', A0.r, A0.v), b2 = spawn(w2, capsule(), 'verda', B0.r, B0.v, { makeActive: false });
  w2.warpTo(ca.t);
  while (w2.ut < ca.t - 1e-6) { if (w2.warpTarget === null) w2.warpTo(ca.t); w2.step(0.3); }
  S.check('closest approach: actual separation in the simulation at the predicted time', ca.distance, a2.pos.distanceTo(b2.pos), 0.05, { unit: 'm' });
  S.check('closest approach: actual relative speed at that time vs predicted', ca.relSpeed, a2.vel.distanceTo(b2.vel), 1e-4, { unit: 'm/s' });
}

// ---------------------------------------------------------------------------------------------- 3h
function surfaceRotation(S) {
  const g = SYSTEM.byId.verda;
  const w = new World();
  const v = w.launch(simpleShip({ engine: 'eng_goshawk' }), { crew: ['Ada'] });
  const R0 = v.pos.length();
  const want = R.TAU * R0 / verda.rotPeriod;
  S.check('on the pad: inertial speed = 2 pi R / rotation period (eastward)', want, v.vel.length(), 1e-9, { unit: 'm/s' });
  S.check('on the pad: surface speed reads zero', 0, v.airspeed, 1e-9, { unit: 'm/s' });
  const east = R.cross([0, 1, 0], R.unit(A(v.pos)));
  S.check('on the pad: velocity points east (prograde, same sense as the orbits)', 1, R.dot(R.unit(A(v.vel)), R.unit(east)), 1e-12);
  const p0 = A(v.pos);
  run(w, 1000, 1);
  // rotate p0 about +Y by omega t (counter-clockwise seen from +Y)
  const ang = R.TAU * 1000 / verda.rotPeriod, c = Math.cos(ang), s = Math.sin(ang);
  const p1 = [p0[0] * c + p0[2] * s, p0[1], -p0[0] * s + p0[2] * c];
  S.check('landed vessel co-rotates: position after 1000 s vs rigid rotation', 0, R.dist(A(v.pos), p1), 1e-6, { unit: 'm' });
  S.check('landed vessel: felt gravity reading = GM / r^2', verda.gm / R0 ** 2 / R.G0, v.gForce, 1e-9, { unit: 'g' });
  S.check('sidereal day in the game = table value', verda.rotPeriod, g.rotPeriod, 1e-9, { unit: 's' });
  // tidally locked moon: the same face keeps pointing at the parent
  const gp = SYSTEM.byId.pell;
  let worst = 0;
  for (const t of [0, 3e4, 7e4, 1.3e5, 5e6]) {
    const toParent = R.unit(R.scale(A(gp.posAt(t)), -1));
    const face = R.unit(A(gp.surfaceDirToInertial(V([1, 0, 0]), t)));
    worst = Math.max(worst, R.angleBetween(toParent, face));
  }
  S.check('Pell is tidally locked: its 0-longitude point keeps facing Verda', 0, worst * deg, 1e-6, { unit: 'deg' });

  // released from the surface frame: a craft that lets go at rest relative to the ground of a spinning airless moon
  // carries the ground's inertial velocity and then follows the Kepler orbit of that state
  for (const id of ['ost', 'pell']) {
    const b = sys.byId[id], gb = SYSTEM.byId[id];
    const h = 12000, r = b.radius + h, wsp = R.TAU / b.rotPeriod;
    const pos = [r, 0, 0], vel = [wsp * pos[2], 0, -wsp * pos[0]];
    const w3 = new World();
    const c = w3.spawn(capsule(), { crew: ['Ada'], body: gb, pos: V(pos), vel: V(vel) });
    S.check(`${b.name}: craft at rest over the ground has inertial speed omega r`, wsp * r, c.orbitalSpeed, 1e-9, { unit: 'm/s' });
    S.check(`${b.name}: and zero surface speed`, 0, c.airspeed, 1e-9, { unit: 'm/s' });
    const T = 60;
    run(w3, T, 1);
    const ref = R.keplerUV(pos, vel, b.gm, T);
    S.check(`${b.name}: 60 s after release, position vs the Kepler orbit of the release state`, 0, R.dist(A(c.pos), ref.r), 1e-3, { unit: 'm' });
    const el = R.stateToElements(pos, vel, b.gm);
    S.check(`${b.name}: apoapsis of that orbit is the release point`, r, c.apoapsis + b.radius, 1e-3, { unit: 'm' });
    S.info(`${b.name}: periapsis radius of the released orbit (below the surface: it falls)`, el.rp, 'm');
  }
}

export const groups = [
  { name: '3a. Bodies: positions from elements, Kepler III, Laplace SOI, hierarchy', fast: true, run: S => ephemeris(S) },
  { name: '3b. SOI changes across a moving body: continuity at every warp and under physics stepping', fast: true, run: (S, long) => soiContinuity(S, long) },
  { name: '3c. Encounters: no skipped, late or mis-ordered SOI changes (game vs brute-force reference)', fast: true, run: (S, long) => encounterFuzz(S, long) },
  { name: '3d. Map prediction of encounters (predictPatches) vs reference', fast: true, run: S => mapPrediction(S) },
  { name: '3e. Hohmann transfer, low Verda orbit to Pell: planner vs textbook, then flown', fast: true, run: S => hohmannToPell(S) },
  { name: '3f. Interplanetary transfer Verda to Rusk and gravity assist: window, plan, flight', fast: false, run: S => interplanetary(S, 'rusk') },
  { name: '3g. Gravity assist at Pell: turn angle and speed change vs the hyperbola', fast: true, run: S => pellFlyby(S) },
  { name: '3h. Rendezvous: relative motion vs Clohessy-Wiltshire, closest approach', fast: true, run: (S, long) => rendezvous(S, long) },
  { name: '3i. Rotating surface: launch-site speed, co-rotation, release from the surface frame', fast: true, run: S => surfaceRotation(S) },
];
