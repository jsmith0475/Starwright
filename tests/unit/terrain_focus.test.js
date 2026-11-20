// The ground round the followed vessel is built on the calling thread, whatever the worker pool is doing.
// (Round 3: the launch pad is the corner of four quadtree nodes at every level; only one of the four was refined
// before the first frame and the other three quarters of the space centre were drawn from 12 km grid cells.)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../js/lib/three.module.min.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { createTerrain } from '../../js/render/terrain.js';
import { getPool } from '../../js/render/workpool.js';

// workers never answer: the slowest machine there could be
const pool = getPool();
pool._pump = () => {};

function ring(body, terrain, centre, radii) {
  const c0 = centre.clone().normalize(), e1 = new THREE.Vector3(0, 1, 0).cross(c0).normalize(), e2 = new THREE.Vector3().crossVectors(c0, e1);
  const d = new THREE.Vector3(), out = {}, rows = [];
  for (const r of radii) {
    let worst = 0, widest = 0;
    for (let k = 0; k < 32; k++) {
      const a = (k + 0.37) * Math.PI / 16;
      d.copy(c0).multiplyScalar(body.radius).addScaledVector(e1, r * Math.cos(a)).addScaledVector(e2, r * Math.sin(a)).normalize();
      const e = terrain.heightAt(d, out) - body.surfaceHeight(d);
      assert.ok(Number.isFinite(out.spacing), `a chunk is drawn ${r} m from the focus`);
      worst = Math.max(worst, Math.abs(e)); widest = Math.max(widest, out.spacing * terrain.grid);
    }
    rows.push({ r, worst, widest });
  }
  return rows;
}

test('first frame on the pad: the whole space centre stands on fine ground with the workers silent', () => {
  const b = SYSTEM.home, t = createTerrain(b, { quality: 'high' });
  const focus = new THREE.Vector3(1, 0, 0).multiplyScalar(b.radius + 12);          // the pad: centre of a cube face
  t.update(focus.clone().add(new THREE.Vector3(5, 20, 70)), { sync: 0, focus, focusSync: true });
  for (const { r, worst, widest } of ring(b, t, focus, [2, 10, 30, 80, 150, 400, 1000, 1400, 2000, 3000])) {
    assert.ok(worst < 0.02, `drawn ground within 2 cm of the real ground ${r} m from the pad (off by ${worst.toFixed(3)} m)`);
    assert.ok(widest <= 2 * r * 1.05 || widest <= 2 * (Math.PI / 2) * b.radius / 2 ** t.fineLevel, `no chunk wider than twice the distance at ${r} m (${widest.toFixed(0)} m)`);
  }
  t.dispose();
});

test('a lander on a node boundary of a rough moon: no coarse stand-in next to it', () => {
  const b = SYSTEM.byId.pell, t = createTerrain(b, { quality: 'high' });
  for (const dir of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0.5, 0).normalize(), new THREE.Vector3(1, 1, 0.2).normalize(), new THREE.Vector3(0.3, -0.9, 0.31).normalize()]) {
    const focus = dir.clone().multiplyScalar(b.radius + b.surfaceHeight(dir) + 2);
    t.update(focus.clone().addScaledVector(dir, 6).add(new THREE.Vector3(3, 2, 9)), { sync: 0, focus, focusSync: true });
    for (const { r, widest } of ring(b, t, focus, [1, 3, 8, 20, 60, 200])) {
      const finest = (Math.PI / 2) * b.radius / 2 ** t.fineLevel;
      assert.ok(widest <= Math.max(2 * r * 1.05, finest * 1.01), `${r} m from the lander the widest chunk drawn is ${widest.toFixed(1)} m`);
    }
  }
  t.dispose();
});

test('without a jump nothing is built on the calling thread', () => {
  const b = SYSTEM.byId.rusk, t = createTerrain(b, { quality: 'low' });
  const focus = new THREE.Vector3(0, 1, 0).multiplyScalar(b.radius + 500);
  t.update(focus.clone(), { sync: 0, focus });
  assert.equal(t.stats.built, 6, 'only the six root chunks');
  t.dispose();
});
