import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Orbit, solveKeplerElliptic, solveKeplerHyperbolic } from '../../js/core/orbit.js';
import { makeNoise } from '../../js/core/noise.js';

const GM = 3.93216e12;   // Verda
const V = (x, y, z) => new Vector3(x, y, z);

function close(actual, expected, rel = 1e-9, abs = 0, msg = '') {
  const tol = Math.max(abs, rel * Math.max(Math.abs(expected), Math.abs(actual)));
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual} (tol ${tol})`);
}
function vecClose(a, b, tol, msg = '') {
  assert.ok(a.distanceTo(b) <= tol, `${msg} |Δ| = ${a.distanceTo(b)} > ${tol}  a=${a.toArray()} b=${b.toArray()}`);
}
function finiteOrbit(o) {
  for (const k of ['gm', 'e', 'p', 'a', 'n', 'M0', 't0']) assert.ok(Number.isFinite(o[k]), `${k} = ${o[k]}`);
  for (const k of ['P', 'Q', 'H']) {
    assert.ok(Number.isFinite(o[k].x + o[k].y + o[k].z), `${k} not finite`);
    close(o[k].length(), 1, 1e-9, 0, k);
  }
}
function roundTrip(r, v, gm = GM, t = 123.5, rel = 1e-9) {
  const o = Orbit.fromState(r, v, gm, t);
  finiteOrbit(o);
  const s = o.stateAt(t);
  vecClose(s.r, r, rel * r.length(), 'r');
  vecClose(s.v, v, rel * Math.max(v.length(), Math.sqrt(gm / r.length())), 'v');
  vecClose(o.posAt(t), s.r, 1e-12 * r.length());
  vecClose(o.velAt(t), s.v, 1e-12 * v.length() + 1e-12);
  return o;
}
const energy = (r, v, gm) => 0.5 * v.lengthSq() - gm / r.length();
const circ = (r) => Math.sqrt(GM / r);

test('noise is deterministic and bounded', () => {
  const a = makeNoise(42), b = makeNoise(42), c = makeNoise(43);
  let differs = false, min = 1, max = -1;
  for (let i = 0; i < 4000; i++) {
    const x = i * 0.173 - 300, y = i * 0.071 + 5, z = Math.sin(i) * 40;
    const n = a.noise3(x, y, z);
    assert.equal(n, b.noise3(x, y, z));
    if (n !== c.noise3(x, y, z)) differs = true;
    const f = a.fbm(x, y, z);
    assert.ok(n >= -1 && n <= 1 && f >= -1 && f <= 1);
    assert.equal(f, b.fbm(x, y, z));
    min = Math.min(min, n); max = Math.max(max, n);
  }
  assert.ok(differs, 'different seeds should differ');
  assert.ok(min < -0.4 && max > 0.4, `noise should use its range (${min}..${max})`);
  // continuity
  assert.ok(Math.abs(a.noise3(1.2, 3.4, 5.6) - a.noise3(1.2001, 3.4, 5.6)) < 1e-3);
});

test('round trip: circular prograde equatorial', () => {
  const r = V(7.5e5, 0, 0), v = V(0, 0, -circ(7.5e5));
  const o = roundTrip(r, v, GM, 50, 1e-8);
  assert.ok(o.e < 1e-9);
  close(o.a, 7.5e5, 1e-9);
  close(o.inclination, 0, 0, 1e-12);
  close(o.H.y, 1, 1e-12);
  // prograde: from +X towards −Z
  const s = o.stateAt(50 + o.period / 4);
  vecClose(s.r, V(0, 0, -7.5e5), 1e-3);
});

test('round trip: eccentric', () => {
  const r = V(8e5, 0, 2e5), v = V(300, 0, -2600);
  const o = roundTrip(r, v);
  assert.ok(o.e > 0.05 && o.e < 1 && !o.hyper);
  for (const dt of [0, 100, 1000, 5000, -777, 1e6]) {
    const s = o.stateAt(123.5 + dt);
    const o2 = Orbit.fromState(s.r, s.v, GM, 123.5 + dt);
    close(o2.e, o.e, 1e-9); close(o2.a, o.a, 1e-9);
    vecClose(o2.P, o.P, 1e-8); vecClose(o2.H, o.H, 1e-10);
    const s2 = o2.stateAt(123.5);
    vecClose(s2.r, r, 1e-7 * r.length() * (1 + Math.abs(dt) / o.period), `dt=${dt}`);
  }
});

test('round trip: inclined and polar', () => {
  const sp = circ(9e5);
  const o = roundTrip(V(9e5, 0, 0), V(0, sp * Math.sin(0.6), -sp * Math.cos(0.6)), GM, 0, 1e-8);
  close(o.inclination, 0.6, 1e-9);
  const polar = roundTrip(V(0, 9e5, 0), V(sp * 1.1, 0, 0));
  close(polar.inclination, Math.PI / 2, 1e-9);
  roundTrip(V(3e5, -8e5, 4e5), V(1500, 900, -2100));
});

test('round trip: retrograde', () => {
  const o = roundTrip(V(7.5e5, 0, 0), V(0, 0, +circ(7.5e5) * 1.15));
  close(o.inclination, Math.PI, 1e-9);
  close(o.H.y, -1, 1e-12);
  const s = o.stateAt(123.5 + 60);
  assert.ok(s.r.z > 0, 'retrograde moves from +X towards +Z');
});

test('round trip: hyperbolic (incl. high eccentricity)', () => {
  const o = roundTrip(V(7.5e5, 1e5, 0), V(500, 200, -circ(7.5e5) * 1.8));
  assert.ok(o.hyper && o.e > 1 && o.a < 0);
  assert.equal(o.apoapsis, Infinity); assert.equal(o.period, Infinity);
  assert.equal(o.timeToApoapsis(0), Infinity);
  const big = roundTrip(V(7.5e5, 0, 0), V(0, 0, -circ(7.5e5) * 7));
  assert.ok(big.e > 40, `e = ${big.e}`);
  for (const dt of [-1e5, -3000, -10, 10, 3000, 1e5, 1e7]) {
    for (const orb of [o, big]) {
      const s = orb.stateAt(123.5 + dt);
      assert.ok(Number.isFinite(s.r.length() + s.v.length()));
      close(energy(s.r, s.v, GM), orb.energy, 1e-9);
      const back = Orbit.fromState(s.r, s.v, GM, 123.5 + dt).stateAt(123.5);
      vecClose(back.r, orb.posAt(123.5), 1e-6 * 7.5e5 * (1 + Math.abs(dt) / 1000));
    }
  }
});

test('near-radial, exactly radial, near-parabolic and degenerate states never give NaN', () => {
  const cases = [
    [V(7e5, 0, 0), V(1500, 0, 0)],            // straight up
    [V(7e5, 0, 0), V(-1500, 0, 0)],           // straight down
    [V(7e5, 0, 0), V(0, 0, 0)],               // dropped from rest
    [V(7e5, 0, 0), V(1500, 0, -1e-7)],        // almost radial
    [V(7e5, 0, 0), V(9000, 0, 0)],            // radial escape
    [V(0, 7e5, 0), V(0, -20, 1e-3)],
    [V(7e5, 0, 0), V(0, 0, -Math.sqrt(2 * GM / 7e5))],            // exactly parabolic
    [V(7e5, 0, 0), V(0, 0, -Math.sqrt(2 * GM / 7e5) * (1 + 1e-13))],
    [V(7e5, 0, 0), V(0, 0, -Math.sqrt(2 * GM / 7e5) * (1 - 1e-9))],
    [V(7e5, 0, 0), V(Math.sqrt(2 * GM / 7e5), 0, 0)],             // radial parabolic
    [V(0, 0, 0), V(0, 0, 0)],
  ];
  for (const [r, v] of cases) {
    const o = Orbit.fromState(r, v, GM, 10);
    finiteOrbit(o);
    for (const dt of [0, 1, 50, 400, 5000, -300, 1e6]) {
      const s = o.stateAt(10 + dt);
      assert.ok(Number.isFinite(s.r.x + s.r.y + s.r.z), `r NaN for ${r.toArray()} ${v.toArray()} dt=${dt}`);
      assert.ok(!Number.isNaN(s.v.x + s.v.y + s.v.z), `v NaN for ${r.toArray()} ${v.toArray()} dt=${dt}`);
      assert.ok(!Number.isNaN(o.trueAnomalyAt(10 + dt)));
    }
    assert.ok(!Number.isNaN(o.periapsis) && !Number.isNaN(o.apoapsis) && !Number.isNaN(o.period));
    assert.ok(!Number.isNaN(o.timeToPeriapsis(10)) && !Number.isNaN(o.timeToApoapsis(10)));
    assert.ok(!Number.isNaN(o.inclination));
    if (r.length() > 0) {
      const s = o.stateAt(10);
      vecClose(s.r, r, 1e-6 * r.length(), 'radial r');
      vecClose(s.v, v, 1e-3 * Math.sqrt(GM / r.length()), 'radial v');
    }
  }
  // a ball thrown straight up comes back down the same line and reaches the textbook height
  const up = Orbit.fromState(V(7e5, 0, 0), V(1500, 0, 0), GM, 0);
  const eps = 1500 ** 2 / 2 - GM / 7e5;
  close(up.apoapsis, -GM / eps, 1e-9);
  const top = up.posAt(up.timeToApoapsis(0));
  close(top.x, -GM / eps, 1e-6);
  assert.ok(Math.hypot(top.y, top.z) < 1);
});

test('near-parabolic orbits keep precision', () => {
  for (const f of [1 - 1e-9, 1 + 1e-9, 1 - 1e-6, 1 + 1e-6]) {
    const r = V(7.5e5, 0, 1e5), v = V(200, 100, -Math.sqrt(2 * GM / r.length()) * f);
    const o = roundTrip(r, v, GM, 0, 1e-9);
    for (const dt of [50, 500, 5000, 50000]) {
      const s = o.stateAt(dt);
      close(energy(s.r, s.v, GM), energy(r, v, GM), 0, 1e-7 * GM / r.length(), `energy f=${f} dt=${dt}`);
      vecClose(new Vector3().crossVectors(s.r, s.v), new Vector3().crossVectors(r, v), 1e-8 * r.length() * v.length());
      const back = Orbit.fromState(s.r, s.v, GM, dt).stateAt(0);
      vecClose(back.r, r, 1e-5 * r.length(), `back f=${f} dt=${dt}`);
    }
  }
});

test('energy and angular momentum are conserved along stateAt', () => {
  const states = [
    [V(7.5e5, 0, 0), V(0, 0, -circ(7.5e5))],
    [V(8e5, 1e5, 2e5), V(300, -500, -2600)],
    [V(7e5, 0, 0), V(100, 300, -circ(7e5) * 1.38)],     // e ≈ 0.9
    [V(7e5, 0, 0), V(0, 0, -circ(7e5) * 1.4135)],       // e ≈ 0.998
    [V(7.5e5, 1e5, 0), V(500, 200, -circ(7.5e5) * 1.8)],
  ];
  for (const [r, v] of states) {
    const o = Orbit.fromState(r, v, GM, 0);
    const E0 = energy(r, v, GM), h0 = new Vector3().crossVectors(r, v);
    close(o.energy, E0, 1e-9, 1e-9 * GM / r.length());
    const span = o.hyper ? 2e5 : o.period;
    for (let i = -20; i <= 60; i++) {
      const s = o.stateAt(span * i / 37.3);
      close(energy(s.r, s.v, GM), E0, 0, 1e-8 * GM / r.length(), `energy e=${o.e} i=${i}`);
      vecClose(new Vector3().crossVectors(s.r, s.v), h0, 1e-9 * h0.length(), `h e=${o.e} i=${i}`);
      assert.ok(s.r.length() >= o.periapsis * (1 - 1e-9) && s.r.length() <= o.apoapsis * (1 + 1e-9));
    }
  }
});

test('period and apsides match closed forms', () => {
  const rp = 7.5e5, ra = 1.4e7;
  const a = (rp + ra) / 2;
  const vp = Math.sqrt(GM * (2 / rp - 1 / a));
  const o = Orbit.fromState(V(rp, 0, 0), V(0, 0, -vp), GM, 0);
  close(o.periapsis, rp, 1e-10); close(o.apoapsis, ra, 1e-9); close(o.a, a, 1e-9);
  close(o.e, (ra - rp) / (ra + rp), 1e-10);
  close(o.p, a * (1 - o.e * o.e), 1e-9);
  close(o.period, 2 * Math.PI * Math.sqrt(a ** 3 / GM), 1e-9);
  close(o.n, 2 * Math.PI / o.period, 1e-12);
  close(o.timeToApoapsis(0), o.period / 2, 1e-9);
  close(o.timeToPeriapsis(1), o.period - 1, 1e-9);
  close(o.timeToPeriapsis(0), 0, 0, 1e-6);
  const apo = o.stateAt(o.period / 2);
  vecClose(apo.r, V(-ra, 0, 0), 1e-2);
  close(apo.v.length(), Math.sqrt(GM * (2 / ra - 1 / a)), 1e-9);
  vecClose(o.stateAt(o.period * 3).r, V(rp, 0, 0), 1e-2);
  // hyperbolic periapsis
  const h = Orbit.fromState(V(rp, 0, 0), V(0, 0, -vp * 1.5), GM, 0);
  close(h.periapsis, rp, 1e-10);
  close(h.e, rp * (vp * 1.5) ** 2 / GM - 1, 1e-10);
  close(h.timeToPeriapsis(500), -500, 1e-9);
});

test('fromElements: frame convention and consistency with fromState', () => {
  const c = Orbit.fromElements({ a: 1e7, e: 0, i: 0, lan: 0, argp: 0, M0: 0 }, GM);
  vecClose(c.posAt(0), V(1e7, 0, 0), 1e-3);
  assert.ok(c.velAt(0).z < 0, '+X moves toward −Z');
  vecClose(c.posAt(c.period / 4), V(0, 0, -1e7), 1e-2);
  vecClose(c.H, V(0, 1, 0), 1e-12);
  close(c.trueAnomalyAt(c.period / 8), Math.PI / 4, 1e-9);

  const el = { a: 4.4e7, e: 0.3, i: 25, lan: 40, argp: 30, M0: 0.5 };
  const o = Orbit.fromElements(el, GM, 77);
  finiteOrbit(o);
  close(o.inclination, 25 * Math.PI / 180, 1e-12);
  close(o.periapsis, el.a * (1 - el.e), 1e-12); close(o.apoapsis, el.a * (1 + el.e), 1e-12);
  // ascending node (crossing to +Y) lies at longitude 40° counter-clockwise from +X seen from +Y
  const node = new Vector3().crossVectors(V(0, 1, 0), o.H).normalize();
  const lan = 40 * Math.PI / 180;
  vecClose(node, V(Math.cos(lan), 0, -Math.sin(lan)), 1e-12);
  const tNode = o.timeAtTrueAnomaly(-30 * Math.PI / 180, 77);
  const sn = o.stateAt(tNode);
  assert.ok(Math.abs(sn.r.y) < 1e-3 && sn.v.y > 0);
  assert.ok(sn.r.clone().normalize().distanceTo(node) < 1e-9);
  for (const t of [77, 1000, 123456]) {
    const s = o.stateAt(t);
    const o2 = Orbit.fromState(s.r, s.v, GM, t);
    close(o2.a, el.a, 1e-9); close(o2.e, el.e, 1e-9);
    vecClose(o2.P, o.P, 1e-9); vecClose(o2.Q, o.Q, 1e-9); vecClose(o2.H, o.H, 1e-9);
    vecClose(o2.stateAt(5e5).r, o.stateAt(5e5).r, 1e-1);
  }
  const hy = Orbit.fromElements({ a: -2e6, e: 1.7, i: 10, lan: 5, argp: 80, M0: -1 }, GM, 0);
  assert.ok(hy.hyper);
  close(hy.periapsis, 2e6 * 0.7, 1e-12);
  const s = hy.stateAt(300);
  close(energy(s.r, s.v, GM), GM / 4e6, 1e-9);
});

test('true anomaly helpers are mutually consistent', () => {
  const orbits = [
    Orbit.fromElements({ a: 2e6, e: 0.4, i: 33, lan: 100, argp: 250, M0: 1 }, GM, 10),
    Orbit.fromElements({ a: 2e6, e: 0, i: 0, lan: 0, argp: 0, M0: 2 }, GM, 10),
    Orbit.fromElements({ a: 9e6, e: 0.97, i: 80, lan: 10, argp: 20, M0: -2 }, GM, 10),
    Orbit.fromElements({ a: -3e6, e: 1.4, i: 5, lan: 0, argp: 0, M0: 0.3 }, GM, 10),
    Orbit.fromElements({ a: -3e4, e: 30, i: 150, lan: 0, argp: 0, M0: -40 }, GM, 10),
  ];
  for (const o of orbits) {
    const span = o.hyper ? 4000 : o.period;
    for (let k = -3; k <= 12; k++) {
      const t = 10 + span * k / 9.7;
      const nu = o.trueAnomalyAt(t);
      const s = o.stateAt(t);
      vecClose(o.posAtTrueAnomaly(nu), s.r, 1e-8 * s.r.length(), `pos e=${o.e}`);
      vecClose(o.velAtTrueAnomaly(nu), s.v, 1e-8 * s.v.length(), `vel e=${o.e}`);
      close(o.radiusAtTrueAnomaly(nu), s.r.length(), 1e-9);
      close(Math.atan2(s.r.dot(o.Q), s.r.dot(o.P)), nu, 1e-9, 1e-9);
      // timeAtTrueAnomaly inverts trueAnomalyAt
      const t2 = o.timeAtTrueAnomaly(nu, t - 1e-6);
      close(t2, t, 0, 1e-5 * (1 + span * 1e-6), `time e=${o.e} k=${k}`);
      if (!o.hyper) {
        const t3 = o.timeAtTrueAnomaly(nu, t + 1);
        close(t3, t + o.period, 0, 1e-5 * (1 + span * 1e-6));
        assert.ok(t3 >= t + 1);
      }
    }
    for (const nu of [-2.5, -1, 0, 0.5, 1.2, 3.1]) {
      if (o.hyper && Math.abs(nu) >= o.maxTrueAnomaly) {
        assert.equal(Math.abs(o.timeAtTrueAnomaly(nu, 0)), Infinity);
        continue;
      }
      const t = o.timeAtTrueAnomaly(nu, 500);
      if (!o.hyper) assert.ok(t >= 500 && t < 500 + o.period * (1 + 1e-12));
      const d = o.trueAnomalyAt(t) - nu;
      assert.ok(Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) < 1e-8, `nu=${nu} e=${o.e}`);
      const R = o.radiusAtTrueAnomaly(nu);
      close(o.trueAnomalyAtRadius(R), Math.abs(nu), 1e-7, o.e === 0 ? 10 : 1e-7);
      if (o.e > 0) {
        close(o.timeAtRadius(R, nu < 0, 500), t, 0, 1e-5 * (1 + (o.hyper ? 4000 : o.period) * 1e-6), `timeAtRadius nu=${nu} e=${o.e}`);
      }
    }
    close(o.timeToPeriapsis(10) >= 0 || o.hyper ? 1 : 0, 1);
  }
});

test('Kepler solvers converge over the whole range', () => {
  for (const e of [0, 0.1, 0.5, 0.9, 0.99, 0.999, 0.999999, 1 - 1e-12]) {
    for (let k = -50; k <= 50; k++) {
      for (const M of [Math.PI * k / 50, 1e-9 * k, 1e-4 * k]) {
        const E = solveKeplerElliptic(M, e);
        assert.ok(Number.isFinite(E));
        close(E - e * Math.sin(E), M, 1e-12, 1e-13, `e=${e} M=${M}`);
      }
    }
  }
  for (const e of [1 + 1e-12, 1.000001, 1.01, 1.5, 3, 10, 50]) {
    for (const M of [0, 1e-12, 1e-6, 1e-3, 0.1, 1, 5, 30, 500, 1e5, 1e9, -1e-6, -2, -777]) {
      const F = solveKeplerHyperbolic(M, e);
      assert.ok(Number.isFinite(F));
      close(e * Math.sinh(F) - F, M, 1e-11, 1e-13, `e=${e} M=${M}`);
    }
  }
});

test('toJSON / fromJSON round trip', () => {
  for (const o of [
    Orbit.fromElements({ a: 4.4e7, e: 0.3, i: 25, lan: 40, argp: 30, M0: 0.5 }, GM, 77),
    Orbit.fromState(V(7.5e5, 1e5, 0), V(500, 200, -circ(7.5e5) * 1.8), GM, 5),
    Orbit.fromState(V(7.5e5, 0, 0), V(0, 0, -circ(7.5e5)), GM, 5),
  ]) {
    const j = JSON.parse(JSON.stringify(o));
    const o2 = Orbit.fromJSON(j);
    assert.ok(o2 instanceof Orbit);
    assert.equal(o2.hyper, o.hyper);
    for (const t of [0, 5, 999, 1e5]) {
      const s1 = o.stateAt(t), s2 = o2.stateAt(t);
      vecClose(s1.r, s2.r, 1e-9 * s1.r.length()); vecClose(s1.v, s2.v, 1e-9 * s1.v.length());
    }
    const c = o.clone();
    vecClose(c.posAt(321), o.posAt(321), 1e-6);
  }
});
