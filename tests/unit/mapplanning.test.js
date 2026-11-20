import test from 'node:test';
import assert from 'node:assert/strict';
import { Orbit } from '../../js/core/orbit.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { relativeNodes, findApproaches, transferWindow, transferFor, phaseAngle } from '../../js/ui/map/planning.js';

const { verda, pell, rusk, helion } = SYSTEM.byId;
const DEG = Math.PI / 180;
const el = (o, gm = verda.gm, t0 = 0) => Orbit.fromElements(o, gm, t0);

test('relativeNodes: relative inclination and node positions lie in both planes', () => {
  const a = el({ a: verda.radius + 200e3, e: 0.05, i: 10, lan: 20, argp: 40, M0: 1 });
  const b = el({ a: verda.radius + 400e3, e: 0.01, i: 25, lan: 70, argp: 0, M0: 0 });
  const r = relativeNodes(a, b, 100);
  assert.ok(r.relInc > 1 * DEG && r.relInc < 40 * DEG);
  for (const n of [r.an, r.dn]) {
    assert.ok(n && n.t >= 100 && n.t <= 100 + a.period + 1e-6);
    assert.ok(Math.abs(n.pos.dot(b.H)) < 1e-6 * n.radius, 'node lies in the target plane');
    assert.ok(n.pos.distanceTo(a.posAt(n.t)) < 1e-3 * n.radius, 'node time matches its position');
  }
  // at the ascending node the vessel moves toward the target's "north"
  assert.ok(a.velAt(r.an.t).dot(b.H) > 0);
  assert.ok(a.velAt(r.dn.t).dot(b.H) < 0);
  assert.ok(r.an.pos.clone().normalize().dot(r.dn.pos.clone().normalize()) < -0.999);
});

test('relativeNodes: co-planar orbits have no nodes', () => {
  const a = el({ a: verda.radius + 200e3, e: 0, i: 5, lan: 20 });
  const b = el({ a: verda.radius + 300e3, e: 0, i: 5, lan: 20 });
  const r = relativeNodes(a, b, 0);
  assert.ok(r.relInc < 1e-6 && r.an === null && r.dn === null);
});

test('findApproaches: two intercepts on crossing orbits, sorted by time', () => {
  const a = el({ a: verda.radius + 300e3, e: 0.12, i: 2, lan: 0, argp: 0, M0: 0 });
  const b = el({ a: verda.radius + 300e3, e: 0.0, i: 0, lan: 0, argp: 0, M0: 0.4 });
  const list = findApproaches(a, b, 0, Math.max(a.period, b.period));
  assert.ok(list.length >= 1 && list.length <= 2);
  for (let i = 1; i < list.length; i++) assert.ok(list[i].t > list[i - 1].t);
  for (const m of list) {
    const d = a.posAt(m.t).distanceTo(b.posAt(m.t));
    assert.ok(Math.abs(d - m.distance) < 1e-6 * d + 1e-3);
    // a real local minimum: nearby times are no closer
    for (const dt of [-5, 5]) assert.ok(a.posAt(m.t + dt).distanceTo(b.posAt(m.t + dt)) >= m.distance - 1);
    assert.ok(m.relSpeed >= 0);
  }
});

test('transferWindow: Hohmann phase angle and timing to Pell', () => {
  const park = el({ a: verda.radius + 100e3, e: 0 });
  const w = transferWindow(park, pell.orbit, 0);
  const at = (park.a + pell.orbit.a) / 2, T = Math.PI * Math.sqrt(at ** 3 / verda.gm);
  assert.ok(Math.abs(w.transferTime - T) < 1e-6 * T);
  assert.ok(w.phaseNeeded > 0 && w.phaseNeeded < Math.PI, 'outer target must lead');
  assert.ok(w.timeToWindow >= 0 && w.timeToWindow <= w.synodic + 1e-6);
  // at the window, the phase angle matches the needed one, and the target arrives opposite the departure point
  const t = w.timeToWindow;
  const ph = phaseAngle(park.posAt(t), pell.orbit.posAt(t), park.H);
  assert.ok(Math.abs(Math.atan2(Math.sin(ph - w.phaseNeeded), Math.cos(ph - w.phaseNeeded))) < 0.5 * DEG);
  const dep = park.posAt(t).normalize(), arr = pell.orbit.posAt(t + w.transferTime).normalize();
  assert.ok(dep.dot(arr) < -0.999, 'arrival is opposite the departure point');
  assert.ok(w.vInf > 100 && w.vInf < 2000);
});

test('transferWindow: an inner target trails (negative-rate case still gives a future window)', () => {
  const w = transferWindow(rusk.orbit, verda.orbit, 0);
  assert.ok(w.timeToWindow >= 0 && Number.isFinite(w.timeToWindow) && w.timeToWindow <= w.synodic + 1e-6);
  const t = w.timeToWindow;
  const ph = phaseAngle(rusk.orbit.posAt(t), verda.orbit.posAt(t), rusk.orbit.H);
  assert.ok(Math.abs(Math.atan2(Math.sin(ph - w.phaseNeeded), Math.cos(ph - w.phaseNeeded))) < 3 * DEG);
});

test('transferFor: picks the right frames', () => {
  const ship = { name: 'Ship', body: verda, landed: false, pos: { x: verda.radius + 100e3, y: 0, z: 0 }, getOrbit: () => el({ a: verda.radius + 100e3, e: 0 }) };
  const moon = transferFor(ship, pell, 0);
  assert.equal(moon.kind, 'moon'); assert.equal(moon.around, verda); assert.equal(moon.from, 'Ship');
  const planet = transferFor(ship, rusk, 0);
  assert.equal(planet.kind, 'planet'); assert.equal(planet.around, helion); assert.equal(planet.from, 'Verda');
  assert.ok(planet.ejectDv > 0 && planet.ejectDv < planet.vInf + 4000 && Number.isFinite(planet.timeToWindow));
  assert.equal(transferFor(ship, helion, 0), null);
  assert.equal(transferFor(ship, verda, 0), null);
  const fromBody = transferFor(verda, rusk, 0);
  assert.equal(fromBody.from, 'Verda'); assert.equal(fromBody.kind, 'planet');
  // a ship around Pell going to Rusk departs from Verda's orbit
  const far = transferFor({ name: 'P', body: pell, landed: true }, rusk, 0);
  assert.equal(far.from, 'Verda');
});
