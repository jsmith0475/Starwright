import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Body, SYSTEM } from '../../js/core/bodies.js';
import { faceDir, dirToFace, buildChunk, chunkHeightAt, chunkLod } from '../../js/render/terrainmesh.js';

const { byId, bodies } = SYSTEM;
const close = (a, b, rel = 1e-9, abs = 0) =>
  assert.ok(Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b))), `expected ${b}, got ${a}`);

function dirs(n) {
  const out = [];
  for (let i = 0; i < n; i++) {   // Fibonacci sphere
    const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), a = i * 2.399963229728653;
    out.push(new Vector3(r * Math.cos(a), y, r * Math.sin(a)));
  }
  return out;
}

test('system structure matches the body table', () => {
  assert.deepEqual(bodies.map((b) => b.id), ['helion', 'sear', 'cindra', 'murk', 'verda', 'pell', 'ost', 'rusk', 'dray',
    'thal', 'tiv', 'marn', 'slate', 'nock', 'orrin', 'brim', 'quell', 'nym', 'wend']);
  assert.equal(SYSTEM.star, byId.helion);
  assert.equal(SYSTEM.home, byId.verda);
  for (const b of bodies) {
    assert.ok(b instanceof Body);
    assert.equal(byId[b.id], b);
    assert.ok(['star', 'planet', 'moon'].includes(b.type));
    assert.ok(b.radius > 0 && b.gm > 0 && b.rotPeriod > 0 && b.sciMult > 0 && b.spaceBorder > 0);
    close(b.surfaceG, b.gm / b.radius ** 2);
    assert.equal(typeof b.color, 'number');
    assert.equal(typeof b.seed, 'number');
    if (b.parent) { assert.ok(b.parent.children.includes(b)); assert.equal(b.orbit.gm, b.parent.gm); }
    if (b.atmo) {
      assert.ok(b.atmo.height > 0 && b.atmo.scale > 0 && b.atmo.rho0 > 0 && b.atmo.color.length === 3);
      assert.ok(b.spaceBorder > b.atmo.height);
    }
  }
  assert.equal(byId.helion.parent, null);
  assert.equal(byId.helion.orbit, null);
  assert.equal(byId.helion.gm, 1.2e18);
  assert.equal(byId.helion.soi, Infinity);
  assert.deepEqual(byId.helion.children.map((b) => b.id), ['sear', 'cindra', 'murk', 'verda', 'rusk', 'thal', 'orrin', 'quell', 'wend']);
  assert.deepEqual(byId.verda.children.map((b) => b.id), ['pell', 'ost']);
  assert.deepEqual(byId.rusk.children.map((b) => b.id), ['dray']);
  assert.deepEqual(byId.thal.children.map((b) => b.id), ['tiv', 'marn', 'slate', 'nock']);
  assert.deepEqual(byId.orrin.children.map((b) => b.id), ['brim']);
  assert.deepEqual(byId.quell.children.map((b) => b.id), ['nym']);
  // the first release's bodies keep their numbers (saves and flight tests depend on them)
  const old = { cindra: [2.5e5, 2.8, 6.2e9], verda: [6.4e5, 9.6, 1.36e10], pell: [2.1e5, 1.6, 1.25e7], ost: [7.0e4, 0.5, 4.4e7],
    rusk: [3.6e5, 3.2, 2.05e10], thal: [5.2e6, 8.5, 6.8e10], tiv: [4.0e5, 2.2, 3.2e7] };
  for (const [id, [radius, g, a]] of Object.entries(old)) {
    assert.equal(byId[id].radius, radius); close(byId[id].surfaceG, g); close(byId[id].orbit.a, a);
  }
  for (const b of bodies) { assert.equal(typeof b.blurb, 'string'); assert.ok(b.blurb.length > 10, `${b.id} blurb`); }
  close(byId.verda.gm, 9.6 * 6.4e5 ** 2);
  close(byId.pell.gm, 1.6 * 2.1e5 ** 2);
  assert.equal(byId.verda.rotPeriod, 19800);
  assert.ok(byId.verda.ocean && !byId.verda.gas && byId.thal.gas && !byId.pell.ocean);
  assert.deepEqual([byId.verda.atmo.height, byId.verda.atmo.scale, byId.verda.atmo.rho0], [72000, 5800, 1.22]);
  assert.equal(byId.pell.atmo, null);
  close(byId.cindra.orbit.e, 0.18); close(byId.cindra.orbit.a, 6.2e9);
  close(byId.cindra.orbit.inclination, 6 * Math.PI / 180);
  close(byId.ost.orbit.inclination, 5.5 * Math.PI / 180);
  assert.equal(SYSTEM.launchSite.lat, 0); assert.equal(SYSTEM.launchSite.lon, 0);
  assert.equal(SYSTEM.launchSite.name, 'Starwright Flight Center');
  assert.ok(SYSTEM.launchSite.dir.distanceTo(new Vector3(1, 0, 0)) < 1e-12);
});

test('SOI values are sane and children sit inside the parent SOI', () => {
  for (const b of bodies) {
    if (!b.parent) continue;
    close(b.soi, b.orbit.a * Math.pow(b.gm / b.parent.gm, 0.4));
    assert.ok(b.soi > b.radius * 3, `${b.id} SOI should be well above its surface`);
    if (b.atmo) assert.ok(b.soi > b.radius + b.atmo.height);
    assert.ok(b.soi < b.orbit.periapsis * 0.3, `${b.id} SOI should be small next to its orbit`);
    assert.ok(b.orbit.periapsis - b.soi > b.parent.radius * 2, `${b.id} must clear its parent`);
    if (Number.isFinite(b.parent.soi)) {
      assert.ok(b.orbit.apoapsis + b.soi < b.parent.soi, `${b.id} must stay inside ${b.parent.id}'s SOI`);
    }
  }
  // siblings never overlap (the comet crosses other orbits; it is checked separately below)
  for (const p of bodies) {
    const kids = p.children.filter((b) => !b.comet).sort((a, b) => a.orbit.a - b.orbit.a);
    for (let i = 1; i < kids.length; i++) {
      assert.ok(kids[i - 1].orbit.apoapsis + kids[i - 1].soi < kids[i].orbit.periapsis - kids[i].soi,
        `${kids[i - 1].id} / ${kids[i].id} SOIs overlap`);
    }
  }
  assert.ok(byId.verda.soi > 7e7 && byId.verda.soi < 1e8);
  assert.ok(byId.pell.soi > 2e6 && byId.pell.soi < 3e6);
});

test('the comet crosses other orbits but its path never comes near another SOI', () => {
  const w = byId.wend;
  assert.ok(w.comet && w.orbit.e > 0.6);
  assert.ok(w.orbit.periapsis < byId.verda.orbit.a && w.orbit.apoapsis > byId.thal.orbit.a, 'dives inside Verda, out past Thal');
  assert.ok(w.orbit.periapsis > byId.helion.radius * 10);
  const N = 2000, pw = [], q = new Vector3();
  for (let i = 0; i < N; i++) pw.push(w.orbit.posAtTrueAnomaly(i / N * 2 * Math.PI, new Vector3()));
  for (const b of byId.helion.children) {
    if (b === w) continue;
    let moid = Infinity;
    for (let j = 0; j < N; j++) {
      b.orbit.posAtTrueAnomaly(j / N * 2 * Math.PI, q);
      for (let i = 0; i < N; i += 4) { const d = q.distanceToSquared(pw[i]); if (d < moid) moid = d; }
    }
    moid = Math.sqrt(moid);
    assert.ok(moid > 3 * (b.soi + w.soi), `${b.id}: orbits pass ${(moid / 1e9).toFixed(2)} Gm apart, SOI ${(b.soi / 1e9).toFixed(2)} Gm`);
  }
});

test('atmospheres, oxygen, rings and oceans of the wider system', () => {
  const withAir = bodies.filter((b) => b.atmo).map((b) => b.id);
  assert.deepEqual(withAir, ['murk', 'verda', 'rusk', 'thal', 'marn', 'orrin']);
  assert.deepEqual(bodies.filter((b) => b.atmo && b.atmo.oxygen).map((b) => b.id), ['verda', 'marn'], 'jets work on two worlds only');
  for (const b of bodies) if (b.atmo) assert.equal(typeof b.atmo.oxygen, 'boolean');
  assert.ok(byId.murk.pressureAtm(0) > 40, 'Murk is crushing');
  // density is tiny where each atmosphere ends, so there is no jolt at the edge
  for (const b of bodies) if (b.atmo && !b.gas) assert.ok(b.density(b.atmo.height * 0.999) < 2e-3 * b.atmo.rho0);
  assert.deepEqual(bodies.filter((b) => b.ring).map((b) => b.id), ['orrin']);
  const r = byId.orrin.ring;
  assert.ok(r.inner > byId.orrin.radius + byId.orrin.atmo.height && r.outer > r.inner);
  assert.ok(byId.brim.orbit.periapsis - byId.brim.soi > r.outer, 'the rings lie inside the innermost moon');
  assert.deepEqual(bodies.filter((b) => b.ocean).map((b) => b.id), ['verda', 'brim']);
  assert.deepEqual(bodies.filter((b) => b.gas).map((b) => b.id), ['thal', 'orrin']);
  // variety: gravity spans three orders of magnitude, some orbits are tilted or eccentric
  const g = bodies.filter((b) => b.parent && !b.gas).map((b) => b.surfaceG);
  assert.ok(Math.min(...g) < 0.06 && Math.max(...g) > 9);
  assert.ok(bodies.filter((b) => b.orbit && b.orbit.inclination > 0.17).length >= 3);
  assert.ok(bodies.filter((b) => b.orbit && b.orbit.e > 0.15).length >= 4);
});

test('launch sites: pad and runway on the home world', () => {
  const v = byId.verda, { pad, runway } = v.sites;
  assert.equal(SYSTEM.sites, v.sites);
  assert.equal(v.launchSite, pad); assert.equal(SYSTEM.launchSite, pad);
  for (const b of bodies) if (b !== v) assert.equal(b.sites, null);
  assert.equal(runway.heading, 90);
  assert.ok(runway.length >= 1200 && runway.length <= 2500 && runway.width > 20);
  assert.ok(runway.dir.distanceTo(v.dirFromLatLon(runway.lat, runway.lon)) < 1e-12);
  // local metres at the pad: east = −Z, north = +Y
  const east = (d) => -d.z * v.radius, north = (d) => d.y * v.radius;
  close(east(runway.dir), -950, 1e-4); close(north(runway.dir), -850, 1e-4);     // the threshold, south-west of the pad: where the model draws it
  close(east(runway.start.dir), -850, 1e-4); close(north(runway.start.dir), -850, 1e-4); assert.equal(runway.start.heading, 90);
  const c = runway.center.dir;
  close(east(c), 50, 1e-4); close(north(c), -850, 1e-4);      // the middle of the drawn strip (basegfx BASE_LAYOUT.runway)
  close(east(c) - east(runway.dir), runway.length / 2, 1e-4); close(north(c), north(runway.dir), 1e-4);
  // dead level along the whole strip and its overruns
  for (let s = -200; s <= runway.length + 200; s += 20) {
    for (const off of [-40, 0, 40]) {
      const d = v.dirFromLatLon(runway.lat + off / v.radius, runway.lon + s / v.radius);
      assert.equal(v.terrainHeight(d), 0, `runway at ${s} m`);
    }
  }
});

test('the base stands on a flat coastal plain: level within 3 km, sea to the east, hills inland', () => {
  const v = byId.verda;
  assert.equal(v.terrainHeight(SYSTEM.launchSite.dir), 0);
  assert.ok(v.seaLevel < 0 && v.seaLevel > -10, 'the plain is a few metres above the sea');
  const at = (east, north) => v.dirFromLatLon(north / v.radius, east / v.radius);
  for (let i = 0; i < 3000; i++) {
    const a = i * 2.399963, r = 3000 * Math.sqrt((i + 0.5) / 3000);
    const d = at(r * Math.cos(a), r * Math.sin(a));
    assert.equal(v.terrainHeight(d), 0, `not level ${r.toFixed(0)} m from the pad`);
    assert.equal(v.biomeAt(d).water, false);
    assert.equal(v.isWater(d), false);
    if (r < 2990) assert.ok(v.terrainNormal(d).distanceTo(d) < 1e-9);
  }
  // the shore is 3 to 4 km east of the pad; beyond it open water for a long way
  for (const n of [-2500, -1000, 0, 1000, 2500]) {
    assert.ok(v.terrainHeight(at(3000, n)) >= 0);
    assert.ok(v.terrainHeight(at(3750, n)) < v.seaLevel, `sea at 3.75 km east, ${n} m north`);
    for (const e of [4500, 8000, 20000, 50000]) {
      assert.ok(v.isWater(at(e, n)), `water ${e} m east`);
      assert.ok(v.biomeAt(at(e, n)).water, `water biome ${e} m east`);
      assert.equal(v.surfaceHeight(at(e, n)), v.seaLevel);
    }
  }
  // the beach slopes gently (a rover can drive into the sea)
  let prev = 0;
  for (let e = 3000; e <= 4200; e += 10) {
    const h = v.terrainHeight(at(e, 300));
    assert.ok(h <= prev + 0.5 && prev - h < 2.5, `beach step at ${e} m: ${prev} → ${h}`);
    prev = h;
  }
  // inland (west, north, south) it stays dry and rises into hills
  for (let i = 0; i < 300; i++) {
    const a = Math.PI / 2 + (i / 299) * Math.PI, r = 3200 + 90000 * (i * 0.618 % 1);   // western half-plane
    const d = at(r * Math.cos(a), r * Math.sin(a));
    assert.equal(v.biomeAt(d).water, false, `water ${r.toFixed(0)} m inland`);
    assert.ok(v.terrainHeight(d) >= 0);
  }
  assert.ok(v.terrainHeight(at(-20000, 0)) > 40, 'hills 20 km inland');
});

test('terrain heights: deterministic, bounded, zero for gas and stars, consistent with water', () => {
  const pts = dirs(4000);
  for (const b of bodies) {
    let lo = Infinity, hi = -Infinity;
    for (const d of pts) {
      const h = b.terrainHeight(d);
      assert.ok(Number.isFinite(h), `${b.id} height`);
      assert.ok(Math.abs(b.terrainHeight(d.clone().multiplyScalar(b.radius)) - h) < 1e-6, 'direction need not be normalised');
      assert.equal(b.terrainHeight(d), h, 'deterministic');
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    if (b.gas || b.type === 'star') { assert.equal(lo, 0); assert.equal(hi, 0); assert.equal(b.maxElevation, 0); continue; }
    assert.ok(lo >= b.minElevation && hi <= b.maxElevation, `${b.id}: ${lo.toFixed(0)}..${hi.toFixed(0)} outside declared ${b.minElevation}..${b.maxElevation}`);
    assert.ok(hi - lo > 0.2 * (b.maxElevation - b.minElevation), `${b.id}: declared bounds are far too loose`);
    assert.ok(hi - lo > 500, `${b.id} has real relief (${(hi - lo).toFixed(0)} m)`);
    assert.ok(b.maxElevation < 0.25 * b.radius && b.maxElevation < b.spaceBorder, `${b.id} peaks stay below space`);
    assert.ok(-b.minElevation < 0.25 * b.radius);
    if (b.atmo) assert.ok(b.maxElevation < b.atmo.height);
  }
  // water biome ⇔ terrain below sea level (allowing a sliver of disagreement right at the shore)
  for (const b of [byId.verda, byId.brim]) {
    let bad = 0;
    for (const d of pts) if (b.biomeAt(d).water !== b.isWater(d)) bad++;
    assert.ok(bad < 0.012 * pts.length, `${b.id}: ${bad} of ${pts.length} points disagree about water`);
    for (const d of pts) assert.ok(b.surfaceHeight(d) >= b.seaLevel);
  }
  for (const b of bodies) if (!b.ocean) for (const d of pts.slice(0, 50)) assert.equal(b.surfaceHeight(d), b.terrainHeight(d));
});

test('terrain is continuous at every scale, and coarse LOD stays close to the full surface', () => {
  const east = new Vector3(), d2 = new Vector3();
  for (const b of bodies) {
    if (b.gas || b.type === 'star') continue;
    let steepest = 0, maxLodErr = 0;
    for (const d of dirs(700)) {
      const h0 = b.terrainHeight(d);
      east.crossVectors(new Vector3(0, 1, 0), d).normalize();
      for (const step of [0.5, 20, 800]) {
        d2.copy(d).addScaledVector(east, step / b.radius).normalize();
        const slope = Math.abs(b.terrainHeight(d2) - h0) / step;
        if (slope > steepest) steepest = slope;
        // no cliffs taller than a few times the step: the field has no jumps
        assert.ok(slope < 6, `${b.id}: ${(slope * step).toFixed(1)} m jump over ${step} m`);
      }
      for (const lod of [30, 1000]) {
        const e = Math.abs(b.terrainHeight(d, lod) - h0);
        if (e > maxLodErr) maxLodErr = e;
        assert.ok(e < 0.45 * lod + 2, `${b.id}: lod ${lod} differs by ${e.toFixed(1)} m`);
      }
      // normals point outward and match the slope
      const n = b.terrainNormal(d);
      assert.ok(Math.abs(n.length() - 1) < 1e-9 && n.dot(d) > 0.15, `${b.id} normal`);
    }
    assert.ok(steepest > 0.05, `${b.id} should not be a billiard ball (steepest ${steepest.toFixed(3)})`);
    assert.ok(maxLodErr > 0, `${b.id}: lod should drop some detail`);
  }
});

// CPU time of this process, not wall-clock time: the budgets are about how much work a sample is, and must not
// fail because other programs are busy on the same machine.
function cpuMs() { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }

test('terrain sampling is fast enough for physics and for building terrain meshes', () => {
  const d = new Vector3();
  for (const b of bodies) {
    const t0 = cpuMs();
    const n = 30000;
    for (let i = 0; i < n; i++) {
      const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), a = i * 2.399963229728653;
      d.set(r * Math.cos(a), y, r * Math.sin(a));
      b.terrainHeight(d);
    }
    const us = (cpuMs() - t0) / n * 1000;
    assert.ok(us < 40, `${b.id}: ${us.toFixed(1)} µs per full-detail sample`);
  }
});

test('positions and velocities: parent-relative and global', () => {
  const z = byId.helion.posAt(1234);
  assert.equal(z.length(), 0);
  assert.equal(byId.helion.globalVelAt(1234).length(), 0);
  const v0 = byId.verda.posAt(0);
  assert.ok(v0.distanceTo(new Vector3(1.36e10, 0, 0)) < 1);
  assert.ok(byId.verda.velAt(0).z < 0, 'Verda orbits prograde');
  for (const t of [0, 5e4, 3e6]) {
    for (const b of bodies) {
      const g = b.globalPosAt(t), gv = b.globalVelAt(t);
      const sum = new Vector3(), sumV = new Vector3();
      for (let c = b; c; c = c.parent) { sum.add(c.posAt(t)); sumV.add(c.velAt(t)); }
      assert.ok(g.distanceTo(sum) <= 1e-9 * (1 + sum.length()));
      assert.ok(gv.distanceTo(sumV) <= 1e-9 * (1 + sumV.length()));
      // velocity is the derivative of position
      if (b.parent) {
        const h = 1;
        const fd = b.globalPosAt(t + h).sub(b.globalPosAt(t - h)).multiplyScalar(0.5 / h);
        assert.ok(fd.distanceTo(gv) < 1e-3 * gv.length(), `${b.id} velocity`);
      }
    }
  }
  const out = new Vector3();
  assert.equal(byId.pell.globalPosAt(10, out), out);
});

test('rotation convention: a surface point at +X moves toward −Z', () => {
  for (const b of bodies) {
    const w = b.angVel();
    assert.equal(w.x, 0); assert.equal(w.z, 0);
    close(w.y, 2 * Math.PI / b.rotPeriod);
    // pick the time when lon 0 is at inertial +X
    const tX = ((2 * Math.PI - b.rotationAngle(0)) % (2 * Math.PI)) / w.y;
    const p0 = b.surfaceDirToInertial(new Vector3(1, 0, 0), tX);
    assert.ok(p0.distanceTo(new Vector3(1, 0, 0)) < 1e-6, `${b.id} ${p0.toArray()}`);
    const p1 = b.surfaceDirToInertial(new Vector3(1, 0, 0), tX + b.rotPeriod * 0.01);
    assert.ok(p1.z < 0 && p1.x > 0, `${b.id}: +X should move toward −Z`);
    const q = b.surfaceDirToInertial(new Vector3(1, 0, 0), tX + b.rotPeriod / 4);
    assert.ok(q.distanceTo(new Vector3(0, 0, -1)) < 1e-6);
    // surface velocity = ω × r
    const r = b.surfaceDirToInertial(new Vector3(0.6, 0.3, -0.2), 500).multiplyScalar(b.radius);
    const fd = b.surfaceDirToInertial(new Vector3(0.6, 0.3, -0.2), 501).multiplyScalar(b.radius)
      .sub(b.surfaceDirToInertial(new Vector3(0.6, 0.3, -0.2), 499).multiplyScalar(b.radius)).multiplyScalar(0.5);
    assert.ok(fd.distanceTo(new Vector3().crossVectors(w, r)) < 1e-4 * (1 + fd.length()));
    // matches three.js applyAxisAngle about +Y and round-trips
    const d = new Vector3(0.3, 0.5, -0.81).normalize();
    for (const t of [0, 777, 123456.7]) {
      const a = b.rotationAngle(t);
      assert.ok(a >= 0 && a < 2 * Math.PI);
      const ref = d.clone().applyAxisAngle(new Vector3(0, 1, 0), a);
      const got = b.surfaceDirToInertial(d, t);
      assert.ok(got.distanceTo(ref) < 1e-12);
      assert.ok(b.inertialToSurfaceDir(got, t).distanceTo(d) < 1e-12);
    }
    const da = b.rotationAngle(b.rotPeriod * 0.25) - b.rotationAngle(0);
    close((da + 2 * Math.PI) % (2 * Math.PI), Math.PI / 2, 1e-9, 1e-9);
  }
});

test('tidally locked moons keep one face toward their parent', () => {
  assert.deepEqual(bodies.filter((b) => b.tidal).map((b) => b.id), ['sear', 'pell', 'dray', 'tiv', 'marn', 'slate', 'brim', 'nym']);
  // Quell and Nym are mutually locked
  close(byId.quell.rotPeriod, byId.nym.orbit.period);
  for (const t of [0, 1e5, 7.7e5]) {
    const face = byId.quell.surfaceDirToInertial(new Vector3(1, 0, 0), t);
    assert.ok(face.dot(byId.nym.posAt(t).normalize()) > 0.999, 'Quell keeps one face to Nym');
  }
  for (const b of bodies.filter((x) => x.tidal)) {
    const id = b.id;
    close(b.rotPeriod, b.orbit.period);
    for (const t of [0, b.rotPeriod * 0.3, b.rotPeriod * 2.7]) {
      const face = b.surfaceDirToInertial(new Vector3(1, 0, 0), t);
      const toParent = b.posAt(t).multiplyScalar(-1).normalize();
      // eccentric and inclined orbits librate a little
      assert.ok(face.dot(toParent) > (b.orbit.e > 0.015 || b.orbit.inclination > 0.02 ? 0.98 : 0.995), `${id} at t=${t}: ${face.dot(toParent)}`);
    }
  }
  // the launch site starts in daylight
  const site = byId.verda.surfaceDirToInertial(SYSTEM.launchSite.dir, 0);
  const toSun = byId.verda.posAt(0).multiplyScalar(-1).normalize();
  assert.ok(site.dot(toSun) > 0.9);
});

test('latLon follows the body-fixed direction convention', () => {
  const b = byId.verda;
  for (const [lat, lon] of [[0, 0], [0.5, 1], [-1.2, -2.5], [0.3, 3.0], [1.5, 0.4]]) {
    const d = new Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    const ll = b.latLon(d);
    close(ll.lat, lat, 1e-9, 1e-12); close(ll.lon, lon, 1e-9, 1e-12);
    assert.ok(b.dirFromLatLon(lat, lon).distanceTo(d) < 1e-12);
    assert.ok(Math.abs(b.latLon(d.clone().multiplyScalar(6.4e5)).lat - lat) < 1e-9);
  }
  // east at the launch site is −Z (Y × up), the direction the ground moves
  const up = SYSTEM.launchSite.dir;
  const east = new Vector3().crossVectors(new Vector3(0, 1, 0), up).normalize();
  assert.ok(east.distanceTo(new Vector3(0, 0, -1)) < 1e-12);
  assert.ok(b.latLon(up.clone().addScaledVector(east, 0.01)).lon > 0, 'longitude increases eastward');
});

test('atmosphere model', () => {
  const v = byId.verda;
  close(v.density(0), 1.22); close(v.pressureAtm(0), 1);
  close(v.density(5800), 1.22 / Math.E); close(v.pressureAtm(11600), Math.exp(-2));
  assert.ok(v.density(71999) > 0);
  assert.equal(v.density(72000), 0); assert.equal(v.density(1e6), 0); assert.equal(v.pressureAtm(72000), 0);
  close(v.density(-50), 1.22);
  assert.equal(byId.pell.density(0), 0); assert.equal(byId.pell.pressureAtm(10), 0);
  // hydrostatic: p = rho g H, in Verda sea-level atmospheres (until 2026-11-25 it was rho / 1.22 everywhere)
  const p0 = 1.22 * 9.6 * 5800, hyd = b => b.atmo.rho0 * b.surfaceG * b.atmo.scale / p0;
  close(byId.rusk.pressureAtm(0), hyd(byId.rusk)); close(byId.thal.pressureAtm(0), hyd(byId.thal));
  close(byId.rusk.pressureAtm(0) / (0.25 / 1.22), 1 / 2.68, 0.01);   // Rusk's air: under half the old figure
  let prev = Infinity;
  for (let a = 0; a < 72000; a += 3000) { const d = v.density(a); assert.ok(d < prev); prev = d; }
});

test('biomes: deterministic, named, and the launch site is on land', () => {
  const names = new Set();
  const pts = dirs(3000);
  for (const b of bodies) {
    assert.ok(b.biomes.length >= 3 && b.biomes.length <= 6, `${b.id} has ${b.biomes.length} biomes`);
    const seen = new Map();
    for (const d of pts) {
      const bi = b.biomeAt(d);
      assert.equal(typeof bi.id, 'string'); assert.equal(typeof bi.name, 'string'); assert.equal(typeof bi.water, 'boolean');
      assert.ok(b.biomes.includes(bi));
      assert.equal(b.biomeAt(d.clone()), bi, 'deterministic');
      seen.set(bi.id, (seen.get(bi.id) || 0) + 1);
      if (!b.ocean) assert.equal(bi.water, false);
    }
    assert.equal(seen.size, b.biomes.length, `${b.id}: every biome should occur (${[...seen.keys()]})`);
    for (const [id, n] of seen) assert.ok(n >= 6, `${b.id}/${id} is too rare (${n}/3000)`);
    for (const bi of b.biomes) { assert.ok(!names.has(bi.name), `duplicate biome name ${bi.name}`); names.add(bi.name); }
  }
  const v = byId.verda;
  assert.equal(v.biomeAt(SYSTEM.launchSite.dir).water, false);
  assert.equal(v.biomeAt(SYSTEM.launchSite.dir).id, 'greenbelt');
  // ... and so is everything within ~100 km inland of the pad (the sea lies to the east, +lon = −Z)
  for (let i = 0; i < 400; i++) {
    const a = i * 0.7, r = 0.15 * (i / 400);
    const d = new Vector3(1, r * Math.cos(a), Math.abs(r * Math.sin(a))).normalize();
    assert.equal(v.biomeAt(d).water, false, `water ${r * 640} km from the pad`);
  }
  let water = 0;
  for (const d of pts) if (v.biomeAt(d).water) water++;
  assert.ok(water > 0.35 * pts.length && water < 0.8 * pts.length, `Verda water fraction ${water / pts.length}`);
});

test('surface colours: valid, deterministic and in the right palette', () => {
  const pts = dirs(2500);
  const avg = {};
  for (const b of bodies) {
    const s = [0, 0, 0];
    for (const d of pts) {
      const c = b.surfaceColorAt(d);
      assert.equal(c.length, 3);
      for (const k of c) assert.ok(k >= 0 && k <= 1 && Number.isFinite(k), `${b.id} colour ${c}`);
      assert.deepEqual(b.surfaceColorAt(d), c);
      s[0] += c[0]; s[1] += c[1]; s[2] += c[2];
    }
    avg[b.id] = s.map((x) => x / pts.length);
  }
  const out = [0, 0, 0];
  assert.equal(byId.pell.surfaceColorAt(pts[0], out), out);
  const [vr, vg, vb] = avg.verda;
  assert.ok(vb > vr && vb > vg * 0.9, `Verda should read blue: ${avg.verda}`);
  const p = avg.pell;
  assert.ok(Math.max(...p) - Math.min(...p) < 0.06, `Pell should be grey: ${p}`);
  assert.ok(avg.ost[2] > avg.ost[0] && avg.ost[2] > 0.8, `Ost pale blue: ${avg.ost}`);
  assert.ok(avg.cindra[0] > avg.cindra[2] && avg.cindra[0] < 0.45, `Cindra dark brown: ${avg.cindra}`);
  assert.ok(avg.rusk[0] > 1.5 * avg.rusk[2] && avg.rusk[0] > 0.5, `Rusk rust red: ${avg.rusk}`);
  assert.ok(avg.thal[2] > avg.thal[0] && avg.thal[1] > avg.thal[0], `Thal teal/violet: ${avg.thal}`);
  assert.ok(avg.tiv[0] > 0.6 && avg.tiv[1] > 0.6 && avg.tiv[2] < 0.45, `Tiv sulfur: ${avg.tiv}`);
  assert.ok(avg.helion[0] > 0.9 && avg.helion[1] > 0.7, `Helion: ${avg.helion}`);
  // Verda: water is blue, launch site is green, poles are white
  const v = byId.verda;
  const pad = v.surfaceColorAt(SYSTEM.launchSite.dir);
  assert.ok(pad[1] > pad[0] && pad[1] > pad[2], `pad colour ${pad}`);
  const pole = v.surfaceColorAt(new Vector3(0, 1, 0));
  assert.ok(Math.min(...pole) > 0.8, `pole colour ${pole}`);
  for (const d of pts) {
    if (v.biomeAt(d).water) { const c = v.surfaceColorAt(d); assert.ok(c[2] > c[0] && c[2] > c[1]); }
  }
});

test('surface sampling is fast enough to bake textures', () => {
  const d = new Vector3();
  const out = [0, 0, 0];
  for (const b of bodies) {
    const t0 = cpuMs();
    const n = 100000;
    for (let i = 0; i < n; i++) {
      const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), a = i * 2.399963229728653;
      d.set(r * Math.cos(a), y, r * Math.sin(a));
      b.surfaceColorAt(d, out);
    }
    const perMillion = (cpuMs() - t0) * 10;
    assert.ok(perMillion < 4000, `${b.id}: ${perMillion.toFixed(0)} ms per million samples`);
  }
});

test('the drawn ground matches the physics ground: fine terrain chunks carry terrainHeight exactly', () => {
  // The terrain renderer meshes chunks of an N × N grid; near the vessel the cells are 0.4 to 0.75 m (one level past
  // the finest the camera asks for). Vertices must BE the physics height, and the flat triangles between them must
  // stay within centimetres of it, or landers sink into the picture and crew stand buried.
  const N = 40, o = { face: 0, u: 0, v: 0 }, d = { x: 0, y: 0, z: 0 };
  assert.equal(chunkLod(0.7), 0); assert.equal(chunkLod(1.4), 0); assert.ok(chunkLod(50) > 0);
  let worstBody = '', worst = 0;
  for (const id of ['pell', 'verda', 'rusk', 'ost', 'marn', 'slate', 'tiv', 'nock', 'wend']) {
    const b = byId[id], faceSize = (Math.PI / 2) * b.radius;
    const maxLevel = Math.max(1, Math.min(18, Math.ceil(Math.log2(faceSize / (N * 1.5))))), level = maxLevel + 1;
    const cells = 2 ** level;
    let sum = 0, n = 0, max = 0;
    for (const site of dirs(6)) {
      dirToFace(site.x, site.y, site.z, o);
      // the round trip face ↔ direction is exact
      faceDir(o.face, o.u, o.v, d);
      close(d.x, site.x, 0, 1e-12); close(d.y, site.y, 0, 1e-12); close(d.z, site.z, 0, 1e-12);
      const ix = Math.min(cells - 1, Math.floor((o.u + 1) / 2 * cells)), iy = Math.min(cells - 1, Math.floor((o.v + 1) / 2 * cells));
      const c = buildChunk(b, o.face, level, ix, iy, N);
      assert.ok(c.spacing > 0.3 && c.spacing < 0.8, `${id}: finest cells are ${c.spacing} m`);
      const u0 = -1 + (2 * ix) / cells, du = 2 / (cells * N);
      // vertices: exactly the physics height (stored as float32)
      for (const [i, j] of [[0, 0], [N, N], [7, 31], [20, 20], [39, 1]]) {
        faceDir(o.face, u0 + i * du, -1 + (2 * iy) / cells + j * du, d);
        const hp = b.terrainHeight(d);
        close(chunkHeightAt(c.hs, N, i, j), hp, 0, 1e-3 + Math.abs(hp) * 1e-6);
      }
      // between vertices: the drawn triangles against the height function
      for (let k = 0; k < 300; k++) {
        const fu = ((k * 0.61803398875) % 1) * N, fv = ((k * 0.7548776662) % 1) * N;
        faceDir(o.face, u0 + fu * du, -1 + (2 * iy) / cells + fv * du, d);
        const err = Math.abs(chunkHeightAt(c.hs, N, fu, fv) - b.terrainHeight(d));
        sum += err; n++; if (err > max) max = err;
      }
    }
    if (max > worst) { worst = max; worstBody = id; }
    assert.ok(sum / n < 0.012, `${id}: drawn ground is ${(100 * sum / n).toFixed(2)} cm off on average`);
    assert.ok(max < 0.12, `${id}: drawn ground is up to ${(100 * max).toFixed(1)} cm off`);
  }
  assert.ok(worst < 0.12, worstBody);
  // sea-bed vertices are drawn at the sea surface
  const hs = new Float32Array((2 + 1) * (2 + 1) * 2).fill(-5);
  assert.equal(chunkHeightAt(hs, 2, 0.3, 1.2, -3), -3);
  assert.equal(chunkHeightAt(hs, 2, 0.3, 1.2), -5);
});
