// Physics verification inside the unit suite: the quick groups of tests/verify (the real game core against an
// independent reference: its own integrator, Kepler solver and textbook formulas, sharing no maths with js/core),
// plus one regression test for each physics bug that verification found. Full report: npm run verify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../verify/run.mjs';
import { fmt, simpleShip, spawn, run, World, SYSTEM, V, A } from '../verify/harness.mjs';
import { gameCoast } from '../verify/gameflight.mjs';
import * as R from '../verify/ref.mjs';
import { PARTS } from '../../js/core/parts.js';
import { Orbit } from '../../js/core/orbit.js';
import { predictPatches } from '../../js/core/trajectory.js';
import { planPair } from '../verify/checks_planner.mjs';

const report = rows => rows.map(r => `${r.group} :: ${r.name}: expected ${fmt(r.expected)}, got ${fmt(r.actual)}, error ${fmt(r.error)} > ${fmt(r.tol)}${r.note ? ' (' + r.note + ')' : ''}`).join('\n');

// one test per chapter so a failure names its area; 3c (the 20 s encounter fuzz) runs in `npm run verify` and is
// represented here by the regression cases below and by 3b / 3d
for (const [title, only, skip] of [
  ['two-body motion: speeds, periods, Kepler propagation, conservation at every warp, physics/rails hand-over', ['1'], null],
  ['burns: rocket equation, mass flow, thrust, staging, delta-v readout, maneuver nodes', ['2'], null],
  ['multi-body: ephemeris, SOI continuity, map prediction, Pell transfer, flyby, rendezvous, rotation', ['3'], ['3c']],
  ['atmosphere and surface: density, drag, heating, gravity, ballistic hops', ['4'], null],
  ['structure: joint loads against an independent multibody solver, closed forms, thin-ring strength, live closure, failure', ['7'], null],
  ['aerodynamic breakup: thin roots, air ratings against the vessel state, open panels, tear-off law, conservation, stock flights', ['8'], null],
]) {
  test(`physics verification, ${title}`, async () => {
    const S = await runAll({ fast: true, only, skip });
    assert.ok(S.passed.length > 10, `only ${S.passed.length} checks ran`);
    assert.equal(S.failed.length, 0, '\n' + report(S.failed));
  });
}

// ---- regression: thrust used the mass at the START of each 20 ms step, so every burn fell short of the rocket
// equation by dt/2 x ve x mdot x (1/m1 - 1/m0): 0.23 m/s on this ship, up to 0.1 % on a bare solid booster
test('regression: a burn to depletion delivers the rocket-equation delta-v (mid-step mass)', () => {
  for (const throttle of [1, 0.5]) {
    const w = new World();
    const v = spawn(w, simpleShip(), 'helion', [2e11, 0, 0], [0, 0, 0]);      // deep space: gravity 3e-5 m/s2
    const m0 = v.mass, en = PARTS.eng_sparrow.engine, fuel = PARTS.tank_m400.res.fuel;
    v.ctrl.sas = true; v.ctrl.throttle = throttle;
    w.stage();
    const dir = A(V([0, 1, 0]).applyQuaternion(v.q)), v0 = A(v.vel);
    run(w, fuel / (throttle * en.thrust * 1000 / (en.ispVac * R.G0)) + 20, 1);
    assert.ok(Math.abs(v.mass - (m0 - fuel)) < 1e-6, 'tank is dry');
    const got = R.dot(R.sub(A(v.vel), v0), dir), want = R.rocketDv(en.ispVac, m0, m0 - fuel);
    assert.ok(Math.abs(got - want) < 0.05, `throttle ${throttle}: delta-v ${got.toFixed(3)} vs rocket equation ${want.toFixed(3)} m/s (was 0.23 / 0.12 m/s short)`);
  }
});

// ---- regression: the encounter search stopped at the first outward crossing of 1.5x the outermost moon's orbit and
// sampled 300 points whatever the orbit, so encounters on the inbound leg or on fast eccentric passes were missed
// or found late. Each case below (state about `parent` at t0) was missed entirely by the old search; the entry
// times are from the independent brute-force reference (tests/verify/ref.mjs refPatched).
const MISSED = [
  { parent: 'verda', r: [-30263585.10985663, 22054990.91894656, 26955093.836062603], v: [-82.81291843668278, 53.11685647814426, 257.30065207440936], t0: 5390923.681796857, enter: 'ost', t: 5994308.40082348 },
  { parent: 'rusk', r: [-6367066.898520163, -783270.8420849517, 2431968.164346304], v: [-1.8315126468604461, -66.63530773593818, 234.94724083943072], t0: 299267997.6202838, enter: 'dray', t: 299425483.0694523 },
  { parent: 'thal', r: [1012498398.5119522, 643746727.5170642, -169183255.58243656], v: [20.242974839414046, 39.34598000347694, -393.21216474951353], t0: -6455884.196874242, enter: 'nock', t: 2686954.520393442 },
  { parent: 'orrin', r: [9566964.691797247, 1575097.4426021613, 28822866.559979603], v: [2091.7040359995844, 331.30821375508026, 206.42892093161117], t0: 3068793.8093020646, enter: 'brim', t: 3135516.8915261403 },
  { parent: 'quell', r: [-4175389.2316234754, 163925.7566385776, 2494254.013636376], v: [-6.4318536297277795, 1.024850565114614, 65.81846297534705], t0: 476958399.8139822, enter: 'nym', t: 478189105.5885391 },
  // a 13 km/s hyperbolic pass through Verda's SOI that clips the SOI of Pell for 370 s: the search stepped by the
  // local dynamical time, far longer than the whole pass, and never sampled near Pell
  { parent: 'verda', r: [26627896.785946846, 68140727.92246246, 47156737.70445824], v: [-3651.0647597784773, -10971.44995842706, -5781.789747409165], t0: 288256596.4565442, enter: 'pell', t: 288262590.9759114 },
];
test('regression: encounters the old search missed are predicted and flown on time (Ost, Dray, Nock, Brim, Nym, fast Pell graze)', () => {
  const sys = R.readSystem(), eph = new R.Ephemeris(sys);
  for (const c of MISSED) {
    const P = SYSTEM.byId[c.parent];
    // the recorded time is what the reference still says
    const ref = R.refPatched(sys, eph, { body: sys.byId[c.parent], r: c.r, v: c.v, t: c.t0 }, c.t + 100, { maxEvents: 1 });
    assert.ok(ref.events[0] && ref.events[0].to.id === c.enter && Math.abs(ref.events[0].t - c.t) < 1e-3, `${c.enter}: reference still enters at ${c.t}`);
    // the map
    const patches = predictPatches(Orbit.fromState(V(c.r), V(c.v), P.gm, c.t0), P, c.t0, 2);
    assert.equal(patches[0].endType, 'enter', `${c.enter}: the map predicts an encounter`);
    assert.equal(patches[0].nextBody.id, c.enter);
    assert.ok(Math.abs(patches[0].tEnd - c.t) < 0.01, `${c.enter}: predicted entry ${patches[0].tEnd} vs ${c.t}`);
    // the flight, as the active vessel at full warp and as a background vessel at 100 000x
    for (const mode of ['active', 'background']) {
      const g = gameCoast({ body: sys.byId[c.parent], r: c.r, v: c.v, t: c.t0 }, c.t + 50, { mode });
      const e = g.events[0];
      assert.ok(e && e.to === c.enter, `${c.enter} (${mode}): the vessel enters the SOI (${e ? e.to : 'no SOI change'})`);
      if (mode === 'active') assert.ok(Math.abs(e.t - c.t) < 0.01, `${c.enter}: entered at ${e.t} vs ${c.t}`);
    }
  }
});

// ---- regression: the interplanetary planner aimed its first guess with the textbook burn sqrt(v_inf^2 + 2GM/r),
// which forgets that v-infinity is wanted at the edge of a finite SOI, and then closed the miss by burning harder:
// Verda to Rusk left with +10.7 % and arrived at 2.46x the Hohmann speed after 0.61 of the Hohmann time.
test('regression: the transfer planner stays close to the minimum-energy transfer (Verda to Rusk and back, Verda to Murk)', () => {
  const sys = R.readSystem();
  for (const [f, t] of [['verda', 'rusk'], ['rusk', 'verda'], ['verda', 'murk']]) {
    const p = planPair(sys.byId[f], sys.byId[t]);
    assert.ok(p.ok, `${f} to ${t}: a complete plan (${p.why || ''})`);
    assert.ok(Math.abs(p.eject / p.optEject - 1) < 0.02, `${f} to ${t}: ejection ${p.eject.toFixed(1)} vs optimum ${p.optEject.toFixed(1)} m/s`);
    assert.ok(p.vInf < 1.35 * p.optVInf, `${f} to ${t}: arrival ${p.vInf.toFixed(0)} vs Hohmann ${p.optVInf.toFixed(0)} m/s`);
    assert.ok(Math.abs(p.time / p.optTime - 1) < 0.25, `${f} to ${t}: ${(p.time / 86400).toFixed(1)} days vs Hohmann ${(p.optTime / 86400).toFixed(1)}`);
    assert.ok(p.total < 1.08 * p.optTotal + 1.3 * p.plane, `${f} to ${t}: total ${p.total.toFixed(0)} vs optimum ${p.optTotal.toFixed(0)} m/s (+ tilt ${p.plane.toFixed(0)})`);
  }
});
