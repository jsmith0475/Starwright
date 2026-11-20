// A craft at rest touches the ground where the ground is. Round 3: two faults in the core's contact model put craft
// tens of centimetres inside (or above) sloping ground:
//   1. the ground was looked up with the time at the END of the physics step for a position at its START: the body
//      turns in between (2 m at Verda's equator in one 10 ms contact step), so the terrain was sampled 2 m east;
//   2. every contact point was tested against one plane through the terrain under the centre of mass, whatever the
//      relief under the point itself.
// Here: a lander is dropped on slopes of the home world and of two moons; once it is at rest (upright or on its
// side), every contact point is within 3 cm of the terrain under THAT point, and something touches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { World } from '../../js/core/world.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { Craft } from '../../js/core/craft.js';

function sites(bodyId, wants) {
  const b = SYSTEM.byId[bodyId];
  let seed = 12345 + bodyId.length * 977 + bodyId.charCodeAt(0);
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const d = new Vector3(), n = new Vector3(), cand = [];
  for (let i = 0; i < 3000; i++) {
    const z = rnd() * 1.6 - 0.8, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    d.set(r * Math.cos(a), z, r * Math.sin(a));
    if (b.ocean && b.terrainHeight(d) < b.seaLevel + 2) continue;
    if (b === SYSTEM.home && d.x > 0.99998) continue;
    b.terrainNormal(d, n);
    cand.push({ dir: d.clone(), slope: Math.acos(Math.min(1, n.dot(d))) * 180 / Math.PI });
  }
  return wants.map(want => cand.reduce((best, c) => (Math.abs(c.slope - want) < Math.abs(best.slope - want) ? c : best), cand[0]));
}
function lander() {
  const c = new Craft();
  const pod = c.setRoot('pod_acorn')[0];
  const dec = c.attachStack('dec_m', pod.id, 'bottom')[0];
  const tank = c.attachStack('tank_m400', dec.id, 'bottom')[0];
  c.attachStack('eng_sparrow', tank.id, 'bottom');
  c.attachRadial('legs', tank.id, tank.pos.y - 1.85, Math.PI / 4, 4);
  c.name = 'Dustfoot'; c.autoStage(); return c;
}
function dropAt(bodyId, dir) {
  const b = SYSTEM.byId[bodyId], w = new World();
  const v = w.launch(lander(), { crew: ['Ada'] });
  const up = b.surfaceDirToInertial(dir, w.ut, new Vector3()).normalize();
  v.body = b; v.landed = false; v.splashed = false; v.surface = null; v.onRails = false; v._patch = null; v.launched = true; v.launchUt = w.ut;
  v.pos.copy(up).multiplyScalar(b.radius + b.surfaceHeight(dir) + 0.5 + (v.baseHeight || 1.5));
  const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
  v.q.setFromAxisAngle(new Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
  v.w.set(0, 0, 0); v.ctrl.throttle = 0; v._stamp++; v.setLegs(true); v.updateTelemetry(w.ut);
  return { w, v, b };
}
/** Height of a craft-frame point above the terrain under it, now. */
function clearance(w, v, b, x, y, z) {
  const p = new Vector3(x - v.com.x, y - v.com.y, z - v.com.z).applyQuaternion(v.q).add(v.pos);
  return p.length() - b.radius - b.surfaceHeight(b.inertialToSurfaceDir(p.clone(), w.ut, new Vector3()));
}

for (const [bodyId, wants] of [['verda', [9, 18]], ['pell', [9, 20]], ['sear', [9, 20]]]) {
  test(`at rest on a slope of ${bodyId}: every contact point is on the terrain under it`, () => {
    for (const s of sites(bodyId, wants)) {
      const { w, v, b } = dropAt(bodyId, s.dir);
      for (let i = 0; i < 2400 && !v.landed && !v.dead; i++) w.step(0.05);
      for (let i = 0; i < 40; i++) w.step(0.05);
      const where = `${bodyId}, ${s.slope.toFixed(1)}° slope`;
      for (const x of w.vessels) {                       // the lander, and whatever broke off it on the way down
        if (x.dead || !(x.landed || x.grounded) || x.type === 'eva') continue;
        const hs = x._pts.map(c => clearance(w, x, b, c.x, c.y, c.z));
        const low = Math.min(...hs);
        const lean = new Vector3(0, 1, 0).applyQuaternion(x.q).angleTo(x.pos) * 180 / Math.PI;
        assert.ok(low > -0.03, `${where}: ${x.name} (${x.parts.size} parts, lean ${lean.toFixed(0)}°) has a contact point ${(-low * 100).toFixed(1)} cm inside the ground`);
        // the drawn foot pads (render/parts/shapes_aero.js: a dish 0.2 m in radius, rim 2.5 cm above the sole)
        for (const p of x.legParts) {
          if (!p.deployed) continue;
          const L = p.def.legs, fr = 0.2 * p.def.h / 1.2, cx = p.pos.x + p._ox * L.spread, cz = p.pos.z + p._oz * L.spread, y = p.pos.y - L.reach + 0.025;
          const rim = Math.min(...[[p._ox, p._oz], [-p._ox, -p._oz], [-p._oz, p._ox], [p._oz, -p._ox]].map(([ax, az]) => clearance(w, x, b, cx + ax * fr, y, cz + az * fr)));
          assert.ok(rim > -0.03, `${where}: ${x.name} (lean ${lean.toFixed(0)}°) has the rim of a foot pad ${(-rim * 100).toFixed(1)} cm inside the ground`);
        }
        assert.ok(low < 0.03, `${where}: ${x.name} touches the ground (nearest contact point ${(low * 100).toFixed(1)} cm up)`);
      }
      assert.ok(v.dead || v.landed || v.grounded, `${where}: it came to rest`);
    }
  });
}

test('the ground is looked up where the vessel is: a pod set down on a slope facing east or west rests at the same depth', () => {
  // the old one-step time error moved the ground 2 m east, so east- and west-facing slopes gave opposite errors
  const b = SYSTEM.home, d = new Vector3(), n = new Vector3(), e = new Vector3();
  let seed = 99; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const found = { east: null, west: null };
  for (let i = 0; i < 20000 && !(found.east && found.west); i++) {
    const z = rnd() * 0.6 - 0.3, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    d.set(r * Math.cos(a), z, r * Math.sin(a));
    if (b.terrainHeight(d) < b.seaLevel + 5) continue;
    b.terrainNormal(d, n);
    e.set(0, 1, 0).cross(d).normalize();               // local east
    const tilt = Math.acos(Math.min(1, n.dot(d))) * 180 / Math.PI, toEast = n.dot(e);
    if (tilt > 7 && tilt < 11 && Math.abs(toEast) > 0.12) found[toEast > 0 ? 'east' : 'west'] = found[toEast > 0 ? 'east' : 'west'] || d.clone();
  }
  assert.ok(found.east && found.west, 'found a slope facing each way');
  for (const [name, dir] of Object.entries(found)) {
    const w = new World(), c = new Craft('Pod'); c.setRoot('pod_acorn'); c.autoStage();
    const v = w.launch(c, { crew: ['Ada'] });
    const up = b.surfaceDirToInertial(dir, w.ut, new Vector3()).normalize();
    v.landed = false; v.surface = null; v.launched = true; v.launchUt = w.ut;
    v.pos.copy(up).multiplyScalar(b.radius + b.surfaceHeight(dir) + 0.3 + (v.baseHeight || 0.6));
    const wy = 2 * Math.PI / b.rotPeriod; v.vel.set(wy * v.pos.z, 0, -wy * v.pos.x);
    v.q.setFromAxisAngle(new Vector3(0, 1, 0), b.rotationAngle(w.ut)).multiply(World.padFrame(dir));
    v.w.set(0, 0, 0); v._stamp++; v.updateTelemetry(w.ut);
    for (let i = 0; i < 2400 && !v.landed && !v.dead; i++) w.step(0.05);
    for (let i = 0; i < 20; i++) w.step(0.05);
    assert.ok(!v.dead, name + ': the pod is still there');
    const low = Math.min(...v._pts.map(p => clearance(w, v, b, p.x, p.y, p.z)));
    assert.ok(low > -0.03 && low < 0.03, `slope facing ${name}: the pod's lowest contact point is ${(low * 100).toFixed(1)} cm from the terrain under it`);
  }
});

test('a craft stands on what is drawn lowest: stowed foot pads and the tip of a whip antenna', async () => {
  // drawn extents (render/partmesh.js, measured): a stowed strut's pad reaches 3 cm of the strut's scale under its
  // box; a whip antenna fills its box. Moonstep stands on its stowed struts on the pad, and stood 9 cm into the slab.
  const { stockCrafts } = await import('../../js/core/craft.js');
  const moon = stockCrafts().find(c => c.name === 'Moonstep');
  assert.ok(moon, 'Moonstep is a stock craft');
  const v = new World().launch(moon, { crew: [] });
  const legs = v.legParts;
  assert.ok(legs.length && legs.every(p => !p.deployed), 'its struts are stowed on the pad');
  const sole = Math.min(...legs.map(p => p.pos.y - p.def.h / 2 - 0.03 * p.def.h / 1.2));
  assert.ok(Math.abs(v._minY - sole) < 0.005, `Moonstep rests on the soles of its stowed pads (lowest contact ${v._minY.toFixed(3)}, drawn sole ${sole.toFixed(3)})`);
  const c = new Craft(); const pod = c.setRoot('pod_acorn')[0];
  c.attachRadial('antenna', pod.id, pod.pos.y - 0.9, 0, 1); c.autoStage();
  const a = new World().launch(c, { crew: ['Ada'] });
  const ant = [...a.parts.values()].find(p => p.def.id === 'antenna');
  assert.ok(Math.abs(a._minY - (ant.pos.y - ant.def.h / 2)) < 0.005, `a craft that stands on a whip antenna stands on its tip (lowest contact ${a._minY.toFixed(3)}, tip ${(ant.pos.y - ant.def.h / 2).toFixed(3)})`);
});
