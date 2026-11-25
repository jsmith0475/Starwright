import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Orbit } from '../../js/core/orbit.js';
import { SYSTEM } from '../../js/core/bodies.js';
import {
  predictPatches, toParentFrame, toChildFrame, checkSoiTransition, applyManeuver, maneuverBasis,
} from '../../js/core/trajectory.js';

const { verda, pell, ost, helion, thal, tiv, rusk } = SYSTEM.byId;
const V = (x, y, z) => new Vector3(x, y, z);
const close = (a, b, rel = 1e-9, abs = 0, msg = '') =>
  assert.ok(Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b))), `${msg} expected ${b}, got ${a}`);
const circ = (body, r) => Math.sqrt(body.gm / r);

// global (star-relative) state of a patch at time t
function globalState(patch, t) {
  const { r, v } = patch.orbit.stateAt(t);
  return { r: r.add(patch.body.globalPosAt(t)), v: v.add(patch.body.globalVelAt(t)) };
}
function assertContinuous(patches) {
  for (let i = 1; i < patches.length; i++) {
    const a = patches[i - 1], b = patches[i];
    assert.equal(b.tStart, a.tEnd);
    assert.equal(b.body, a.nextBody);
    const ga = globalState(a, a.tEnd), gb = globalState(b, b.tStart);
    assert.ok(ga.r.distanceTo(gb.r) < 1e-6 * ga.r.length() + 1, `position jump ${ga.r.distanceTo(gb.r)} m at patch ${i}`);
    assert.ok(ga.v.distanceTo(gb.v) < 1e-6 * ga.v.length() + 1e-3, `velocity jump ${ga.v.distanceTo(gb.v)} m/s at patch ${i}`);
  }
}
function assertPatchShape(patches) {
  for (const p of patches) {
    assert.ok(p.orbit instanceof Orbit);
    assert.ok(p.body && typeof p.body.id === 'string');
    assert.ok(Number.isFinite(p.tStart));
    assert.ok(p.tEnd >= p.tStart);
    assert.ok([null, 'exit', 'enter', 'impact', 'atmo'].includes(p.endType));
    if (p.endType === null) { assert.equal(p.tEnd, Infinity); assert.equal(p.nextBody, null); }
    else assert.ok(Number.isFinite(p.tEnd));
  }
}

// Transfer ellipse from a low Verda orbit, phased so the vessel reaches Pell's orbit `offset` metres
// (along-track) away from Pell's centre.
function pellTransfer(offset, t0 = 0, rp = 7.5e5, ra = 1.4e7) {
  const a = (rp + ra) / 2;
  const vp = Math.sqrt(verda.gm * (2 / rp - 1 / a));
  const probe = Orbit.fromState(V(rp, 0, 0), V(0, 0, -vp), verda.gm, t0);
  const nuArr = probe.trueAnomalyAtRadius(pell.orbit.a);
  const tArr = probe.timeAtTrueAnomaly(nuArr, t0);
  const pp = pell.posAt(tArr);
  const pellAngle = Math.atan2(-pp.z, pp.x);                 // counter-clockwise from +X seen from +Y
  const th = pellAngle + offset / pell.orbit.a - nuArr;      // periapsis direction of the transfer
  const r = V(rp * Math.cos(th), 0, -rp * Math.sin(th));
  const v = V(-vp * Math.sin(th), 0, -vp * Math.cos(th));
  return Orbit.fromState(r, v, verda.gm, t0);
}

test('frame conversions are inverse and consistent with body motion', () => {
  const t = 4321;
  const pos = V(1.2e6, 3e5, -4e5), vel = V(100, -50, 700);
  const up = toParentFrame(pell, pos, vel, t);
  assert.equal(up.body, verda);
  assert.ok(up.pos.distanceTo(pos.clone().add(pell.posAt(t))) < 1e-6);
  assert.ok(up.vel.distanceTo(vel.clone().add(pell.velAt(t))) < 1e-9);
  const down = toChildFrame(pell, up.pos, up.vel, t);
  assert.equal(down.body, pell);
  assert.ok(down.pos.distanceTo(pos) < 1e-6 && down.vel.distanceTo(vel) < 1e-9);
  assert.ok(pos.distanceTo(V(1.2e6, 3e5, -4e5)) === 0, 'inputs are not mutated');
});

test('checkSoiTransition', () => {
  const t = 1000;
  // comfortably inside Verda's SOI, far from the moons
  assert.equal(checkSoiTransition(verda, V(0, 5e6, 0), V(1000, 0, 0), t), null);
  // beyond the SOI and receding → parent frame
  const out = checkSoiTransition(verda, V(verda.soi * 1.001, 0, 0), V(900, 0, -100), t);
  assert.equal(out.body, helion);
  assert.ok(out.pos.distanceTo(verda.posAt(t).add(V(verda.soi * 1.001, 0, 0))) < 1);
  // beyond the SOI but coming back in → stay
  assert.equal(checkSoiTransition(verda, V(verda.soi * 1.001, 0, 0), V(-900, 0, 0), t), null);
  // inside Pell's SOI and approaching → child frame
  const pp = pell.posAt(t), pv = pell.velAt(t);
  const near = pp.clone().add(V(0, pell.soi * 0.9, 0));
  const inn = checkSoiTransition(verda, near, pv.clone().add(V(0, -300, 0)), t);
  assert.equal(inn.body, pell);
  assert.ok(inn.pos.distanceTo(V(0, pell.soi * 0.9, 0)) < 1e-3);
  assert.ok(inn.vel.distanceTo(V(0, -300, 0)) < 1e-6);
  // just outside Pell's SOI → nothing
  assert.equal(checkSoiTransition(verda, pp.clone().add(V(0, pell.soi * 1.01, 0)), pv.clone().add(V(0, -300, 0)), t), null);
  // the star has no parent
  assert.equal(checkSoiTransition(helion, V(5e11, 0, 0), V(1e4, 0, 0), t), null);
  // round trip consistency: after leaving a child we are not immediately pulled back in
  const leaving = checkSoiTransition(pell, V(pell.soi * 1.0001, 0, 0), V(400, 0, 0), t);
  assert.equal(leaving.body, verda);
  assert.equal(checkSoiTransition(verda, leaving.pos, leaving.vel, t), null);
});

test('maneuverBasis is orthonormal with radial pointing out', () => {
  const r = V(7.5e5, 0, 0), v = V(0, 0, -2000);
  const b = maneuverBasis(r, v);
  assert.ok(b.prograde.distanceTo(V(0, 0, -1)) < 1e-12);
  assert.ok(b.normal.distanceTo(V(0, 1, 0)) < 1e-12);
  assert.ok(b.radial.distanceTo(V(1, 0, 0)) < 1e-12);
  const r2 = V(3e5, -8e5, 4e5), v2 = V(1500, 900, -2100);
  const c = maneuverBasis(r2, v2);
  for (const k of ['prograde', 'normal', 'radial']) close(c[k].length(), 1, 1e-12);
  assert.ok(Math.abs(c.prograde.dot(c.normal)) < 1e-12 && Math.abs(c.prograde.dot(c.radial)) < 1e-12 && Math.abs(c.normal.dot(c.radial)) < 1e-12);
  assert.ok(c.radial.dot(r2) > 0);
  assert.ok(c.radial.distanceTo(new Vector3().crossVectors(c.prograde, c.normal)) < 1e-12);
  const rad = maneuverBasis(V(7e5, 0, 0), V(100, 0, 0));
  for (const k of ['prograde', 'normal', 'radial']) close(rad[k].length(), 1, 1e-9);
});

test('applyManeuver: prograde burn raises apoapsis, other axes behave', () => {
  const r0 = 7.5e5;
  const o = Orbit.fromState(V(r0, 0, 0), V(0, 0, -circ(verda, r0)), verda.gm, 0);
  const t = 600;
  const up = applyManeuver(o, t, { prograde: 100, normal: 0, radial: 0 });
  assert.ok(up.apoapsis > r0 + 1e5, `apoapsis ${up.apoapsis}`);
  close(up.periapsis, r0, 1e-6);
  const a = 1 / (2 / r0 - (circ(verda, r0) + 100) ** 2 / verda.gm);
  close(up.apoapsis, 2 * a - r0, 1e-6);
  // burn point becomes the periapsis; position unchanged, speed up by exactly dv
  assert.ok(up.posAt(t).distanceTo(o.posAt(t)) < 1e-3);
  close(up.velAt(t).length(), o.velAt(t).length() + 100, 1e-9);
  close(up.timeToApoapsis(t), up.period / 2, 1e-6);
  const down = applyManeuver(o, t, { prograde: -100, normal: 0, radial: 0 });
  assert.ok(down.periapsis < r0 - 1e5);
  close(down.apoapsis, r0, 1e-6);
  const big = applyManeuver(o, t, { prograde: 1200, normal: 0, radial: 0 });
  assert.ok(big.hyper);
  // normal burn tilts the plane, keeps speed² = v² + dv²
  const tilt = applyManeuver(o, t, { prograde: 0, normal: 300, radial: 0 });
  close(tilt.inclination, Math.atan2(300, circ(verda, r0)), 1e-6);
  assert.ok(tilt.H.dot(o.velAt(t)) < 0, 'normal burn tips the orbit normal away from the velocity');
  // radial-out burn: gains outward speed, angular momentum unchanged
  const rad = applyManeuver(o, t, { prograde: 0, normal: 0, radial: 50 });
  close(rad.velAt(t).dot(o.posAt(t).normalize()), 50, 1e-6);
  close(rad.p, o.p, 1e-9);
  const same = applyManeuver(o, t, { prograde: 0, normal: 0, radial: 0 });
  assert.ok(same.posAt(5000).distanceTo(o.posAt(5000)) < 1e-2);
});

test('stable low orbit: one open-ended patch', () => {
  const o = Orbit.fromState(V(7.5e5, 0, 0), V(0, 300, -circ(verda, 7.5e5)), verda.gm, 100);
  const patches = predictPatches(o, verda, 100);
  assertPatchShape(patches);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].orbit, o);
  assert.equal(patches[0].body, verda);
  assert.equal(patches[0].tStart, 100);
  assert.equal(patches[0].tEnd, Infinity);
  assert.equal(patches[0].endType, null);
  assert.equal(patches[0].nextBody, null);
  // high circular orbit between the moons, and a low Pell orbit, are stable too
  const mid = Orbit.fromState(V(2.5e7, 0, 0), V(0, 0, -circ(verda, 2.5e7)), verda.gm, 0);
  assert.equal(predictPatches(mid, verda, 0)[0].endType, null);
  const lp = Orbit.fromState(V(2.4e5, 0, 0), V(0, 0, -circ(pell, 2.4e5)), pell.gm, 0);
  assert.equal(predictPatches(lp, pell, 0)[0].endType, null);
});

test('atmosphere entry ends a patch with "atmo" at the top of the atmosphere', () => {
  const top = verda.radius + verda.atmo.height;
  // apoapsis 150 km, periapsis 30 km (inside the atmosphere), starting at apoapsis
  const ra = verda.radius + 1.5e5, rp = verda.radius + 3e4;
  const va = Math.sqrt(verda.gm * (2 / ra - 2 / (ra + rp)));
  const o = Orbit.fromState(V(0, 0, ra), V(va, 0, 0), verda.gm, 50);
  const patches = predictPatches(o, verda, 50);
  assertPatchShape(patches);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].endType, 'atmo');
  assert.equal(patches[0].nextBody, null);
  const s = o.stateAt(patches[0].tEnd);
  close(s.r.length(), top, 1e-9);
  assert.ok(s.r.dot(s.v) < 0, 'entry is on the inbound leg');
  assert.ok(patches[0].tEnd > 50 && patches[0].tEnd < 50 + o.period / 2);
  // starting on the way up (after leaving the atmosphere) the entry is still found, later
  const tUp = o.timeAtTrueAnomaly(o.trueAnomalyAtRadius(top + 100), 50);
  const p2 = predictPatches(o, verda, tUp);
  assert.equal(p2[0].endType, 'atmo');
  close(o.posAt(p2[0].tEnd).length(), top, 1e-9);
  assert.ok(p2[0].tEnd > tUp);
  // a suborbital hop already inside the atmosphere ends at the ground
  const hop = Orbit.fromState(V(verda.radius + 1000, 0, 0), V(800, 0, -300), verda.gm, 0);
  const p3 = predictPatches(hop, verda, 0);
  assert.equal(p3[0].endType, 'impact');
  close(hop.posAt(p3[0].tEnd).length(), verda.radius, 1e-9);
  assert.ok(p3[0].tEnd > 60);
  // hyperbolic arrival dipping into the atmosphere
  const hy = Orbit.fromState(V(5e7, 0, 6.6e5), V(-3000, 0, 0), verda.gm, 0);
  const p4 = predictPatches(hy, verda, 0);
  assert.ok(hy.hyper && hy.periapsis < top);
  assert.equal(p4[0].endType, 'atmo');
  close(hy.posAt(p4[0].tEnd).length(), top, 1e-9);
  // Rusk and Thal have atmospheres too
  const ro = Orbit.fromState(V(rusk.radius + 2e5, 0, 0), V(0, 0, -circ(rusk, rusk.radius + 2e5) * 0.9), rusk.gm, 0);
  assert.equal(predictPatches(ro, rusk, 0)[0].endType, 'atmo');
});

test('surface impact ends a patch with "impact" on airless bodies', () => {
  const r0 = pell.radius + 5e4;
  const o = Orbit.fromState(V(r0, 0, 0), V(0, 0, -circ(pell, r0) * 0.5), pell.gm, 10);
  const patches = predictPatches(o, pell, 10);
  assertPatchShape(patches);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].endType, 'impact');
  const s = o.stateAt(patches[0].tEnd);
  close(s.r.length(), pell.radius, 1e-9);
  assert.ok(s.r.dot(s.v) < 0);
  // straight drop: free-fall time is finite and sane
  const drop = Orbit.fromState(V(r0, 0, 0), V(0, 0, 0), pell.gm, 0);
  const pd = predictPatches(drop, pell, 0);
  assert.equal(pd[0].endType, 'impact');
  const tFlat = Math.sqrt(2 * 5e4 / pell.surfaceG);
  assert.ok(pd[0].tEnd > tFlat * 0.9 && pd[0].tEnd < tFlat * 1.4, `fall time ${pd[0].tEnd} vs ${tFlat}`);
  // launched upward from the surface: comes back down
  const lob = Orbit.fromState(V(pell.radius + 1, 0, 0), V(200, 0, -100), pell.gm, 0);
  const pl = predictPatches(lob, pell, 0);
  assert.equal(pl[0].endType, 'impact');
  assert.ok(pl[0].tEnd > 100);
  // a grazing-safe periapsis does not impact
  const safe = Orbit.fromState(V(r0, 0, 0), V(0, 0, -circ(pell, r0) * 0.95), pell.gm, 0);
  assert.equal(predictPatches(safe, pell, 0)[0].endType, null);
});

test('escape from Verda: exit patch into a Helion orbit, continuous across the boundary', () => {
  const r0 = 7.5e5, sp = circ(verda, r0) * 1.5;
  const inc = 0.5;   // inclined so the outbound leg misses both moons
  const o = Orbit.fromState(V(r0, 0, 0), V(0, sp * Math.sin(inc), -sp * Math.cos(inc)), verda.gm, 2000);
  assert.ok(o.hyper);
  const patches = predictPatches(o, verda, 2000);
  assertPatchShape(patches);
  assert.ok(patches.length >= 2);
  assert.equal(patches[0].endType, 'exit');
  assert.equal(patches[0].nextBody, helion);
  assert.equal(patches[1].body, helion);
  assert.equal(patches[1].tStart, patches[0].tEnd);
  const s = o.stateAt(patches[0].tEnd);
  close(s.r.length(), verda.soi, 1e-9);
  assert.ok(s.r.dot(s.v) > 0);
  assertContinuous(patches);
  // the heliocentric orbit is closed, near Verda's, and is not immediately recaptured by Verda
  const h = patches[1].orbit;
  assert.ok(!h.hyper);
  close(h.gm, helion.gm);
  assert.ok(h.periapsis < verda.orbit.a * 1.01 && h.apoapsis > verda.orbit.a * 0.99);
  assert.ok(Math.abs(h.a - verda.orbit.a) < 0.3 * verda.orbit.a);
  if (patches[1].endType === 'enter') {
    assert.ok(patches[1].tEnd - patches[1].tStart > 1e5, 'must not re-detect the body just left');
  }
  // matches the live-sim helper at the boundary
  const tr = toParentFrame(verda, s.r, s.v, patches[0].tEnd);
  assert.ok(tr.pos.distanceTo(h.posAt(patches[0].tEnd)) < 10);
  assert.ok(tr.vel.distanceTo(h.velAt(patches[0].tEnd)) < 1e-3);
  // maxPatches is honoured
  const one = predictPatches(o, verda, 2000, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].endType, 'exit');
  // elliptical orbit whose apoapsis lies beyond the SOI also exits
  const ell = Orbit.fromState(V(0, r0, 0), V(circ(verda, r0) * 1.412, 0, 0), verda.gm, 0);
  assert.ok(!ell.hyper && ell.apoapsis > verda.soi);
  const pe = predictPatches(ell, verda, 0);
  assert.equal(pe[0].endType, 'exit');
  close(ell.posAt(pe[0].tEnd).length(), verda.soi, 1e-9);
  assertContinuous(pe);
});

test('Pell transfer: encounter patch followed by exit back to Verda', () => {
  const o = pellTransfer(1.5e6);
  assert.ok(o.apoapsis > pell.orbit.a);
  const patches = predictPatches(o, verda, 0);
  assertPatchShape(patches);
  assert.ok(patches.length >= 3, `got ${patches.map((p) => `${p.body.id}:${p.endType}`)}`);
  const [p0, p1, p2] = patches;
  assert.equal(p0.body, verda);
  assert.equal(p0.endType, 'enter');
  assert.equal(p0.nextBody, pell);
  assert.ok(p0.tEnd > 0 && p0.tEnd < o.period / 2, 'encounter on the outbound leg');
  // at the boundary the vessel is on Pell's SOI
  const rel = o.posAt(p0.tEnd).sub(pell.posAt(p0.tEnd));
  close(rel.length(), pell.soi, 1e-6);

  assert.equal(p1.body, pell);
  assert.ok(p1.orbit.hyper, 'flyby is hyperbolic');
  close(p1.orbit.gm, pell.gm);
  assert.ok(p1.orbit.periapsis > pell.radius, `flyby periapsis ${p1.orbit.periapsis}`);
  assert.ok(p1.orbit.periapsis < pell.soi);
  assert.equal(p1.endType, 'exit');
  assert.equal(p1.nextBody, verda);
  assert.ok(p1.tEnd > p1.tStart + 600);
  close(p1.orbit.posAt(p1.tEnd).length(), pell.soi, 1e-9);
  close(p1.orbit.posAt(p1.tStart).length(), pell.soi, 1e-6);

  assert.equal(p2.body, verda);
  assert.equal(p2.tStart, p1.tEnd);
  assert.notEqual(p2.tEnd, p2.tStart, 'must not re-enter Pell immediately after leaving it');
  if (p2.endType === 'enter' && p2.nextBody === pell) assert.ok(p2.tEnd - p2.tStart > 3600);
  assertContinuous(patches);
  // the flyby changed the Verda-relative orbit
  assert.ok(Math.abs(p2.orbit.energy - o.energy) > 1e-4 * Math.abs(o.energy));
  // live-sim helper agrees with the predicted boundary
  const s = o.stateAt(p0.tEnd);
  const tr = checkSoiTransition(verda, s.r, s.v, p0.tEnd);
  assert.ok(tr && tr.body === pell);
  assert.ok(tr.pos.distanceTo(p1.orbit.posAt(p0.tEnd)) < 1);
});

test('Pell transfer: aimed at the centre impacts, badly phased misses', () => {
  const hit = predictPatches(pellTransfer(0), verda, 0);
  assert.equal(hit[0].endType, 'enter');
  assert.equal(hit[1].body, pell);
  assert.equal(hit[1].endType, 'impact');
  assert.equal(hit.length, 2);
  close(hit[1].orbit.posAt(hit[1].tEnd).length(), pell.radius, 1e-9);
  // Pell on the far side of its orbit when the vessel gets there: no encounter on the way out
  const miss = predictPatches(pellTransfer(Math.PI * pell.orbit.a), verda, 0);
  assert.ok(!(miss[0].endType === 'enter' && miss[0].tEnd < 0.5 * miss[0].orbit.period));
  // sweeping the phase: encounters happen for a contiguous window of offsets only
  let n = 0;
  for (let k = -6; k <= 6; k++) {
    const p = predictPatches(pellTransfer(k * 1e6), verda, 0, 2);
    const enc = p[0].endType === 'enter' && p[0].nextBody === pell && p[0].tEnd < 0.5 * p[0].orbit.period;
    if (Math.abs(k) <= 2) assert.ok(enc, `offset ${k}e6 m should encounter Pell`);
    if (enc) n++;
  }
  assert.ok(n >= 5 && n < 13, `${n} encounters in the sweep`);
});

test('fast pass through a small SOI between samples is still detected', () => {
  // long-period ellipse (sample spacing ≈ 12 min) crossing Ost's orbit at speed, aimed to clip its SOI
  const tEnc = 30000;
  const target = ost.posAt(tEnc).add(V(0, ost.soi * 0.9, 0));
  // straight-ish fast trajectory through `target` at tEnc
  const vel = target.clone().normalize().multiplyScalar(2500).add(V(0, 0, 0));
  const o = Orbit.fromState(target, vel, verda.gm, tEnc);
  const t0 = tEnc - 9000;
  const patches = predictPatches(o, verda, t0);
  assertPatchShape(patches);
  assert.equal(patches[0].endType, 'enter');
  assert.equal(patches[0].nextBody, ost);
  assert.ok(patches[0].tEnd < tEnc && patches[0].tEnd > t0);
  close(o.posAt(patches[0].tEnd).distanceTo(ost.posAt(patches[0].tEnd)), ost.soi, 1e-6);
  assert.equal(patches[1].body, ost);
  assert.equal(patches[1].endType, 'exit');
  assertContinuous(patches);
});

test('heliocentric transfer reaches Thal and its moon system is patched in', () => {
  // start on Thal's SOI edge heading inward and check the Thal patch behaves (exit or Tiv/atmo event)
  const t = 5e5;
  const dir = V(1, 0.02, 0.3).normalize();
  const pos = dir.clone().multiplyScalar(thal.soi * 0.999);
  const vel = dir.clone().multiplyScalar(-2500).add(V(0, 0, -600));
  const o = Orbit.fromState(pos, vel, thal.gm, t);
  const patches = predictPatches(o, thal, t);
  assertPatchShape(patches);
  assert.ok(['exit', 'atmo', 'enter'].includes(patches[0].endType));
  assertContinuous(patches);
  // and from the Helion side: a vessel placed just outside Thal's SOI, moving toward it, gets an 'enter'
  const g = toParentFrame(thal, dir.clone().multiplyScalar(thal.soi * 1.05), vel, t);
  const ho = Orbit.fromState(g.pos, g.vel, helion.gm, t);
  const hp = predictPatches(ho, helion, t);
  assertPatchShape(hp);
  assert.equal(hp[0].endType, 'enter');
  assert.equal(hp[0].nextBody, thal);
  assert.equal(hp[1].body, thal);
  assertContinuous(hp);
  assert.ok(tiv.soi > 0);
});

test('prediction is fast and never returns NaN for odd inputs', () => {
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) predictPatches(pellTransfer(1.5e6 + i * 1e3), verda, 0);
  const ms = (performance.now() - t0) / 20;
  assert.ok(ms < 30, `${ms.toFixed(2)} ms per prediction`);
  const odd = [
    Orbit.fromState(V(7e5, 0, 0), V(3000, 0, 0), verda.gm, 0),           // radial up, falls back
    Orbit.fromState(V(7e5, 0, 0), V(9000, 0, 0), verda.gm, 0),           // radial escape
    Orbit.fromState(V(verda.soi * 1.2, 0, 0), V(500, 0, 0), verda.gm, 0),   // already outside the SOI
    Orbit.fromState(V(1e5, 0, 0), V(0, 0, -100), verda.gm, 0),           // underground
    Orbit.fromState(V(2e10, 0, 0), V(0, 0, -9000), helion.gm, 0),        // heliocentric escape
    Orbit.fromState(V(2e10, 0, 0), V(0, 0, 0), helion.gm, 0),            // falling into the star
  ];
  const bodiesFor = [verda, verda, verda, verda, helion, helion];
  odd.forEach((o, i) => {
    const p = predictPatches(o, bodiesFor[i], 0);
    assertPatchShape(p);
    for (const q of p) assert.ok(!Number.isNaN(q.tEnd) && !Number.isNaN(q.orbit.e));
  });
  assert.equal(predictPatches(odd[0], verda, 0)[0].endType, 'impact');
  assert.equal(predictPatches(odd[1], verda, 0)[0].endType, 'exit');
  assert.equal(predictPatches(odd[2], verda, 0)[0].endType, 'exit');
  assert.equal(predictPatches(odd[2], verda, 0)[0].tEnd, 0);
  assert.equal(predictPatches(odd[3], verda, 0)[0].endType, 'impact');
  assert.equal(predictPatches(odd[5], helion, 0)[0].endType, 'impact');
});

test('an encounter less than one sample step away is still predicted (re-planned close in, or after a late burn)', () => {
  // Paths aimed through the SOI of a moon and of a planet; predict again from shortly before the SOI entry, down to
  // a fiftieth of the encounter search's first sample step. Before the fix, a closest approach inside that first
  // step was never looked at, so rails warp flew straight through Nock and Rusk.
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const m of [pell, rusk, SYSTEM.byId.nock]) {
    const P = m.parent, mu = P.gm, step = 0.1 * Math.sqrt(m.orbit.a ** 3 / mu);
    let n = 0;
    for (let k = 0; k < 60 && n < 20; k++) {
      const tc = 1e6 * rnd(), mp = m.posAt(tc), mv = m.velAt(tc);
      const vinf = mv.length() * (0.08 + 0.1 * rnd());
      const vr = V(rnd() - 0.5, (rnd() - 0.5) * 0.4, rnd() - 0.5).normalize().multiplyScalar(vinf);
      const perp = V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5); perp.addScaledVector(vr, -perp.dot(vr) / vr.lengthSq()).normalize();
      const o = Orbit.fromState(mp.clone().addScaledVector(perp, m.soi * 0.5 * rnd()), mv.clone().add(vr), mu, tc);
      if (o.periapsis < P.radius * 1.05) continue;
      const dd = t => o.posAt(t).distanceTo(m.posAt(t)) - m.soi;
      let lo = tc, g = 0; while (dd(lo) < 0 && g++ < 10000) lo -= m.soi / vinf * 0.05;
      if (dd(lo) < 0) continue;
      let hi = tc; for (let i = 0; i < 80; i++) { const x = (lo + hi) / 2; if (dd(x) > 0) lo = x; else hi = x; }
      n++;
      for (const lead of [0.02, 0.1, 0.3, 0.7, 2]) {
        const t0 = hi - lead * step;
        if (dd(t0) <= 0) continue;
        const p = predictPatches(Orbit.fromState(o.posAt(t0), o.velAt(t0), mu, t0), P, t0, 1)[0];
        assert.ok(p.endType === 'enter' && p.nextBody === m, `${m.id}: lead ${lead} step: encounter predicted`);
        close(p.tEnd, hi, 0, 1, `${m.id}: entry time`);
      }
    }
    assert.ok(n >= 10, `${m.id}: enough aimed paths (${n})`);
  }
});
