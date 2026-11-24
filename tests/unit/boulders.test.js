// Boulders are solid (js/core/boulders.js, docs/BOULDERS.md): the field the renderer draws is the field the
// physics collides with. These tests hold the two together, and set real craft against real rocks: a rover is
// stopped by a boulder and rolls over a stone, a lander's foot stands on one, a Pip cannot walk through one, and
// the landing autopilot and the rover's cruise control keep clear of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from '../../js/lib/three.module.min.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { World } from '../../js/core/world.js';
import { Vessel, surfaceAt } from '../../js/core/vessel.js';
import { stockCrafts } from '../../js/core/craft.js';
import { SCENARIO_CRAFT, SCENARIO_UT, placeLanded } from '../../js/core/scenarios.js';
import { BOULDERS, ROCK_FIELD, ROCK_SHAPE, ROCK_BOX, boulderField, boulderCell, bouldersNear, boulderProbe, boulderHazard, boulderAt, _grid } from '../../js/core/boulders.js';
import { assessSite, findSite, slopeLimit, footprint } from '../../js/core/landingsite.js';
import { faceDir, dirToFace } from '../../js/render/terrainmesh.js';
import { styleOf } from '../../js/render/worldstyle.js';
import { rockModelBoxes, rockKindNumbers } from '../../js/render/scatter.js';

const DEG = 180 / Math.PI, TAU = 2 * Math.PI;
const Y = new Vector3(0, 1, 0);
const pell = SYSTEM.byId.pell;

/** Boulders on level ground of body `b` whose tops stand between lo and hi metres, found on a fixed walk round the world. */
function rocksOnLevelGround(b, lo, hi, want = 1) {
  const out = [], n = new Vector3(), d = new Vector3();
  for (let k = 0; k < 600 && out.length < want; k++) {
    const d0 = new Vector3(Math.cos(k * 0.37), 0.3 * Math.sin(k * 1.3), Math.sin(k * 0.37)).normalize();
    for (const x of bouldersNear(b, d0.x, d0.y, d0.z, 200, [])) {
      if (!(x.top > lo && x.top < hi)) continue;
      d.set(x.dx, x.dy, x.dz);
      if (b.terrainNormal(d, n, 6).angleTo(d) > 0.02 || b.terrainNormal(d, n, 2).angleTo(d) > 0.03) continue;
      // alone: nothing else within ten metres to confuse the picture
      if (bouldersNear(b, x.ox, x.oy, x.oz, 10, []).length > 1) continue;
      out.push(x);
      if (out.length >= want) break;
    }
  }
  assert.ok(out.length >= want, `found ${out.length} of ${want} boulders ${lo} to ${hi} m high on level ground of ${b.name}`);
  return out;
}
const frameAt = (t) => { const up = new Vector3(t.ox, t.oy, t.oz).normalize(), east = new Vector3().crossVectors(Y, up).normalize(); return { up, east, north: new Vector3().crossVectors(up, east) }; };
const tiltOf = v => new Vector3(0, 1, 0).applyQuaternion(v.q).angleTo(v.pos.clone().normalize()) * DEG;
function withRocks(solid, fn) { const was = BOULDERS.solid; BOULDERS.solid = solid; try { return fn(); } finally { BOULDERS.solid = was; } }

test('the boulder grid is the renderer\'s grid', () => {
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
  for (let face = 0; face < 6; face++) for (const [u, v] of [[0, 0], [-0.93, 0.4], [0.61, -0.99], [0.999, 0.999]]) {
    faceDir(face, u, v, a); _grid.faceDir(face, u, v, b);
    assert.deepEqual(b, a);
    const f1 = { ...dirToFace(a.x, a.y, a.z) }, f2 = { ..._grid.dirToFace(a.x, a.y, a.z) };
    assert.deepEqual(f2, f1);
  }
});

test('every world\'s rocks are the ones its style draws, and each kind is placed by the numbers the renderer has', () => {
  for (const body of SYSTEM.bodies) {
    const sc = styleOf(body.id).scatter, spec = ROCK_FIELD[body.id];
    if (!sc || !sc.rocks) { assert.equal(spec, undefined, body.id + ' draws no rocks and has no field'); continue; }
    assert.ok(spec, body.id + ' draws rocks: it needs a field');
    assert.equal(spec.rocks, sc.rocks, body.id + ' density');
    const kinds = (sc.rockKinds || [{ kind: 'worn' }]).slice(0, 2);
    assert.deepEqual(spec.kinds.map(k => k[0]), kinds.map(k => k.kind), body.id + ' kinds');
    assert.deepEqual(spec.kinds.map(k => k[1] ?? 0.5), kinds.map(k => k.share ?? 0.5), body.id + ' shares');
  }
  const drawn = rockKindNumbers();
  for (const k in drawn) {
    const S = ROCK_SHAPE[k]; assert.ok(S, k);
    assert.deepEqual({ size: S.size, squash: S.squash, tilt: S.tilt, sink: S.sink, lie: S.lie, wind: S.wind }, drawn[k], k);
  }
});

test('the collision shape of each kind of rock fits its drawn model', () => {
  const boxes = rockModelBoxes();
  for (const k in boxes) {
    const B = ROCK_BOX[k], M = boxes[k]; assert.ok(B, k);
    // widths, height and middle, each within a tenth of the model's width
    const wx = M[1] - M[0], wz = M[4] - M[3];
    assert.ok(Math.abs((B[1] - B[0]) - wx) < 0.1 * wx, `${k}: width along x ${(B[1] - B[0]).toFixed(2)} against the model's ${wx.toFixed(2)}`);
    assert.ok(Math.abs((B[4] - B[3]) - wz) < 0.1 * wz, `${k}: width along z ${(B[4] - B[3]).toFixed(2)} against the model's ${wz.toFixed(2)}`);
    assert.ok(Math.abs(B[2] - M[2]) < 0.1 * M[2], `${k}: top ${B[2]} against the model's ${M[2].toFixed(2)}`);
    assert.ok(Math.abs((B[0] + B[1]) / 2 - (M[0] + M[1]) / 2) < 0.1 * wx && Math.abs((B[3] + B[4]) / 2 - (M[3] + M[4]) / 2) < 0.1 * wz, k + ': the middle');
  }
});

test('the field: the same every time, on the ground, none on the space centre or under the sea', () => {
  const F = boulderField(pell);
  assert.ok(F && F.perCell === 12, 'Pell: twelve boulders to a cell');
  assert.equal(boulderField(SYSTEM.star), null);
  const a = boulderCell(pell, 4, 2000, 2000);
  F.cache.clear();
  const b = boulderCell(pell, 4, 2000, 2000);
  assert.equal(a.length, 12);
  assert.deepEqual(b.map(x => [x.x, x.y, x.z, x.size, x.yaw, x.squash]), a.map(x => [x.x, x.y, x.z, x.size, x.yaw, x.squash]));
  for (const x of a) {
    const d = new Vector3(x.dx, x.dy, x.dz);
    assert.ok(Math.abs(Math.hypot(x.x, x.y, x.z) - (pell.radius + pell.terrainHeight(d, 0) + x.sink)) < 1e-6, 'it sits on the physics ground, sunk a little');
    assert.ok(x.top >= 0 && x.top < 8 && x.a > 0.1 && x.c > 0.1, 'a size a rock can be');
    // rotation matrix is a rotation
    const m = x.m; assert.ok(Math.abs(m[0] * m[0] + m[3] * m[3] + m[6] * m[6] - 1) < 1e-9 && Math.abs(m[0] * m[1] + m[3] * m[4] + m[6] * m[7]) < 1e-9);
  }
  const home = SYSTEM.home, R = home.radius;
  for (const k of ['pad', 'runway', 'landing', 'tower']) { const s = home.sites[k].dir; assert.equal(bouldersNear(home, s.x, s.y, s.z, 400, []).length, 0, 'no boulders at ' + k); }
  let seen = 0;
  for (let i = 0; i < 300; i++) {
    const d = new Vector3(Math.cos(i * 0.7), 0.5 * Math.sin(i * 0.31), Math.sin(i * 0.7)).normalize();
    for (const x of bouldersNear(home, d.x * R, d.y * R, d.z * R, 60, [])) { seen++; assert.ok(x.h >= home.seaLevel + 0.4, 'none under the sea'); }
  }
  assert.ok(seen > 20, 'and there are some on the land: ' + seen);
});

test('a point against a boulder: inside it, outside it, and which way is out', () => {
  const [t] = rocksOnLevelGround(pell, 0.8, 1.4);
  const { up, east } = frameAt(t), o = new Vector3(t.ox, t.oy, t.oz), out = { d: 0, nx: 0, ny: 0, nz: 0 };
  assert.equal(boulderProbe(t, o.x, o.y, o.z, 0, out), true, 'its middle is inside');
  const above = o.clone().addScaledVector(up, t.reach + 0.3);
  assert.equal(boulderProbe(t, above.x, above.y, above.z, 0, out), false, 'above its top is outside');
  assert.ok(out.d > 0.2 && new Vector3(out.nx, out.ny, out.nz).dot(up) > 0.7, 'and the way out from there is up');
  const beside = o.clone().addScaledVector(east, Math.min(t.a, t.c) * 0.5).addScaledVector(up, 0.1);
  assert.equal(boulderProbe(t, beside.x, beside.y, beside.z, 0, out), true);
  assert.ok(out.d < 0 && out.d > -t.reach && new Vector3(out.nx, out.ny, out.nz).dot(east) > 0.3, 'a point in its east side is pushed east');
  const along = new Vector3(t.m[0], t.m[3], t.m[6]);      // the model's own x axis, body-fixed
  const off = o.clone().addScaledVector(along, t.a + 0.25).addScaledVector(up, 0.2 * t.b);
  assert.equal(boulderProbe(t, off.x, off.y, off.z, 0, out), false);
  assert.equal(boulderProbe(t, off.x, off.y, off.z, 0.5, out), true, 'grown by half a metre it reaches a point 25 cm off its side');
  assert.ok(boulderAt(pell, o.x, o.y, o.z), 'boulderAt finds it');
  assert.ok(boulderHazard(pell, o.clone().normalize(), 2) >= t.top - 1e-9, 'and so does the landing-site question');
  withRocks(false, () => { assert.equal(boulderAt(pell, o.x, o.y, o.z), null); assert.equal(boulderHazard(pell, o.clone().normalize(), 2), 0); });
});

const STEER = +(process.env.STEER || 1);
/** The stock rover 25 m west of boulder t, pointing at it, the stick held forward for `seconds`. → { x: metres east of the rock at the end, closest, parts lost } */
function driveAt(t, seconds = 40) {
  const { up, east } = frameAt(t), R = pell.radius, w = new World({ ut: SCENARIO_UT });
  const start = up.clone().addScaledVector(east, -25 / R).normalize();
  const craft = stockCrafts().find(x => x.name === 'Trundle Scout');
  const v = placeLanded(w, craft.clone ? craft.clone() : craft, pell, start, { vehicle: true, heading: 90 });
  const parts = v.parts.size;
  v.ctrl.brake = false; v.ctrl.drive = 1;
  const { north } = frameAt(t);
  let x = -25, top = 0;
  for (let i = 0; i < 30 * seconds && !v.dead; i++) {
    w.step(1 / 30);
    const p = pell.inertialToSurfaceDir(v.pos, w.ut, new Vector3());
    x = (p.x - t.ox) * east.x + (p.y - t.oy) * east.y + (p.z - t.oz) * east.z;
    // hold the line that runs east through the middle of the rock (the ground is never quite level)
    const y = (p.x - t.ox) * north.x + (p.y - t.oy) * north.y + (p.z - t.oz) * north.z;
    const fwd = pell.inertialToSurfaceDir(new Vector3(0, 1, 0).applyQuaternion(v.q), w.ut, new Vector3());
    v.ctrl.steer = Math.max(-1, Math.min(1, STEER * (0.5 * y + 2 * fwd.dot(north))));
    top = Math.max(top, v.landed ? 0 : v.groundSpeed);
  }
  return { x, lost: parts - v.parts.size, top, upright: new Vector3(0, 0, 1).applyQuaternion(v.q).dot(v.pos.clone().normalize()) };
}

test('a rover is stopped by a boulder a metre high, and is not hurt at walking pace', () => {
  const [t] = rocksOnLevelGround(pell, 0.9, 1.5);
  const hit = driveAt(t);
  assert.ok(hit.x < -Math.min(t.a, t.c) * 0.5 && hit.x > -(t.reach + 2.5), `it stands against the rock: ${hit.x.toFixed(2)} m from its middle (rock reaches ${t.reach.toFixed(2)} m)`);
  assert.equal(hit.lost, 0, 'nothing broke at ' + hit.top.toFixed(1) + ' m/s');
  assert.ok(hit.upright > 0.9, 'and it is on its wheels');
  const through = withRocks(false, () => driveAt(t));
  assert.ok(through.x > 10, 'with the rocks switched off the same drive goes straight through: ' + through.x.toFixed(1) + ' m past');
});

test('a rover rolls over a stone lower than its wheel', () => {
  const [t] = rocksOnLevelGround(pell, 0.1, 0.22);
  const r = driveAt(t);
  assert.ok(r.x > 10, 'it is past the stone: ' + r.x.toFixed(1) + ' m');
  assert.equal(r.lost, 0);
  assert.ok(r.upright > 0.9);
});

/** The Wayfarer lander let down at `down` m/s with one foot over boulder t (or beside it by `miss` metres east). */
function setDown(t, { down = 1, miss = 0 } = {}) {
  const b = pell, R = b.radius, w = new World();
  const { up: bd, east, north } = frameAt(t);
  const v = w.spawn(SCENARIO_CRAFT['Wayfarer (lander)'](), { body: b, pos: new Vector3(R + 5000, 0, 0), vel: new Vector3(), makeActive: true });
  v.setLegs(true);
  for (let i = 0; i < 80; i++) w.step(0.05);
  // where its first foot is from its middle, when it stands as the pad frame stands it (x east, z south)
  const c = v._pts[v.legParts[0]._lp0], fe = c.x - v.com.x, fn = -(c.z - v.com.z);
  const d = bd.clone().addScaledVector(east, (miss - fe) / R).addScaledVector(north, -fn / R).normalize();
  const upI = b.surfaceDirToInertial(d, w.ut, new Vector3()), low = -v._lowest(new Vector3(0, 1, 0)).h, wy = TAU / b.rotPeriod;
  v.pos.copy(upI).multiplyScalar(R + surfaceAt(b, d) + low + t.top + 0.5);
  v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x).addScaledVector(upI, -down);
  v.q.copy(new Quaternion().setFromAxisAngle(Y, b.rotationAngle(w.ut)).multiply(World.padFrame(d)));
  v.w.set(0, 0, 0); v.ctrl.sas = false; v.ctrl.throttle = 0; v._gndSkip = 0; v._gnd = null; v.updateTelemetry(w.ut);
  const parts = v.parts.size;
  for (let i = 0; i < 20 * 40 && !v.dead && !v.landed; i++) w.step(0.05);
  const r = new Vector3(c.x - v.com.x, c.y - v.com.y, c.z - v.com.z).applyQuaternion(v.q);
  const P = b.inertialToSurfaceDir(v.pos.clone().add(r), w.ut, new Vector3());
  return { tilt: tiltOf(v), rest: !!v.landed, lost: parts - v.parts.size, foot: P.length() - R - b.terrainHeight(P.clone().normalize()) };
}

test('a lander that comes down with one foot on a boulder stands on it, leaning', () => {
  // a rock taller than a leg has travel to swallow (a low one the suspension takes up, and the lander stands near level)
  const [t] = rocksOnLevelGround(pell, 0.9, 1.3);
  const on = setDown(t), off = withRocks(false, () => setDown(t));
  assert.ok(on.rest && off.rest, 'it comes to rest');
  assert.equal(on.lost, 0, 'nothing broke at 1 m/s');
  // (the foot is measured where an unloaded leg ends, so it reads a little above the ground even on bare ground)
  assert.ok(on.foot > off.foot + 0.5 * t.top, `the foot is on the rock: ${on.foot.toFixed(2)} m up against ${off.foot.toFixed(2)} m with the rocks switched off (rock ${t.top.toFixed(2)} m)`);
  assert.ok(on.tilt > off.tilt + 4 && on.tilt < 30, `and the lander leans: ${on.tilt.toFixed(1)} degrees against ${off.tilt.toFixed(1)}`);
});

test('a Pip cannot walk through a boulder, and can walk away from one', () => {
  const [t] = rocksOnLevelGround(pell, 0.9, 1.6);
  const { up } = frameAt(t), R = pell.radius;
  const walk = (solid) => withRocks(solid, () => {
    const pip = Vessel.makePip('Ada');
    pip.body = pell;
    const qRel = World.padFrame(up), ahead = new Vector3(0, 0, 1).applyQuaternion(qRel);
    const start = up.clone().addScaledVector(ahead, -6 / R).normalize();
    pip.landed = true; pip.surface = { dir: start.clone(), qRel: World.padFrame(start), h: 0, qTarget: null };
    pip.syncLanded(0);
    pip.ctrl.tz = 1;
    const ev = [];
    for (let i = 0; i < 50 * 10; i++) pip.simulate(0.02, i * 0.02, ev);
    const gone = (pip.surface.dir.clone().sub(start)).dot(ahead) * R;
    // then turn round and walk back
    pip.ctrl.tz = -1; pip.ctrl.tx = 0;
    for (let i = 0; i < 50 * 6; i++) pip.simulate(0.02, 10 + i * 0.02, ev);
    return { gone, back: (pip.surface.dir.clone().sub(start)).dot(ahead) * R };
  });
  const free = walk(false), held = walk(true);
  assert.ok(free.gone > 12, 'with the rocks off ten seconds of walking is ' + free.gone.toFixed(1) + ' m, through the rock');
  assert.ok(held.gone > 2 && held.gone < 6 - Math.min(t.a, t.c) * 0.4 + 0.3, `with them solid the Pip stops at the rock: ${held.gone.toFixed(2)} m of the 6 m to its middle`);
  assert.ok(held.back < held.gone - 1.5, 'and walks away again');
});

test('the landing autopilot does not choose ground with a boulder on it', () => {
  let rejected = 0, asked = 0;
  for (const id of ['pell', 'dray', 'nock', 'rusk']) {
    const b = SYSTEM.byId[id];
    for (let i = 0; i < 12; i++) {
      const near = new Vector3(Math.cos(i * 1.1 + 0.3), 0.4 * Math.sin(i * 0.9), Math.sin(i * 1.1 + 0.3)).normalize();
      const res = findSite(b, near, { radius: 5, reach: 300, limit: 0.1 });
      asked++;
      if (res.here.boulder > 0) rejected++;
      if (!res.ok) continue;
      assert.equal(boulderHazard(b, res.dir, 5), 0, `${id} ${i}: the chosen ground is clear`);
      assert.equal(assessSite(b, res.dir, 5).boulder, 0);
    }
  }
  assert.ok(rejected >= 3, `some of the ${asked} places first asked about had a boulder in the footprint: ${rejected}`);
  // a boulder in the footprint is reported with its height
  const [t] = rocksOnLevelGround(pell, 0.8, 1.4);
  const s = assessSite(pell, new Vector3(t.dx, t.dy, t.dz), 4);
  assert.ok(Math.abs(s.boulder - t.top) < 1e-9 && s.slope < 0.03, 'level ground with a boulder on it: ' + s.boulder.toFixed(2) + ' m');
  assert.ok(slopeLimit({ baseRadius: 2, baseHeight: 3 }) > 0 && footprint({ baseRadius: 2 }) === 4);
});
