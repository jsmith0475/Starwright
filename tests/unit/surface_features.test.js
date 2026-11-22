// Walking-scale surface features (js/render/surfacefeatures.js, docs/WORLDS.md): the data is sound for every world,
// and the patterns can be continuous from one terrain chunk to the next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM } from '../../js/core/bodies.js';
import { surfaceOf, featureSetup, FEATURE_PERIODS, FEATURE_PARS, FEATURE_NORMAL, FEATURE_ALBEDO, FEATURE_EMIT } from '../../js/render/surfacefeatures.js';
import { styleOf } from '../../js/render/worldstyle.js';

const solid = SYSTEM.bodies.filter((b) => !b.gas && b.type !== 'star');
const arr = (a) => a;

test('every landable world except the home world has surface features of its own', () => {
  for (const b of solid) {
    const s = surfaceOf(b.id), any = !!(s.craters || s.cracks || s.ripples);
    assert.equal(any, b.id !== 'verda', b.id);
    const f = featureSetup(b.id, arr, arr);
    assert.equal(f.any, any);
    assert.equal(!!f.defines.FEATURES, any);
  }
  // no two worlds share the same set of numbers
  const seen = new Set(solid.filter((b) => b.id !== 'verda').map((b) => JSON.stringify(surfaceOf(b.id))));
  assert.equal(seen.size, 15);
});

test('plate sizes divide the wrap periods, so cracks meet across chunk borders', () => {
  for (const b of solid) {
    const f = featureSetup(b.id, arr, arr);
    if (!f.defines.F_CRACKS) continue;
    const [size, big] = f.uniforms.uFCk.value, mid = f.uniforms.uFCkM.value;
    assert.equal(FEATURE_PERIODS[0] % size, 0, `${b.id} size`);
    assert.equal(FEATURE_PERIODS[1] % mid, 0, `${b.id} mid`);
    assert.equal(FEATURE_PERIODS[1] % big, 0, `${b.id} big`);
    assert.ok(size < mid && mid < big, `${b.id}: three sizes in order`);
    // each cell count is a whole number, as the shader's mod() needs
    for (const [p, s] of [[64, size], [2048, mid], [2048, big]]) assert.ok(Number.isInteger(p / s));
  }
});

test('glowing cracks only on worlds whose ground glows; strengths stay in a sane range', () => {
  for (const b of solid) {
    const s = surfaceOf(b.id), st = styleOf(b.id);
    if (s.cracks) {
      if (s.cracks.on === 'lava') assert.ok(st.emissive > 0, `${b.id} has lava cracks but no glowing ground`);
      else assert.equal(s.cracks.glow, 0, b.id);
      assert.ok(s.cracks.width > 0.02 && s.cracks.width < 0.15 && s.cracks.depth <= 1 && s.cracks.tilt <= 0.15, b.id);
      assert.ok(['all', 'flat', 'lava'].includes(s.cracks.on), b.id);
    }
    if (s.craters) assert.ok(s.craters.small >= 0 && s.craters.small <= 1 && s.craters.large <= 1 && s.craters.depth <= 1.5, b.id);
    if (s.ripples) assert.ok(s.ripples.small <= 0.4 && s.ripples.dunes <= 0.5, b.id);
  }
});

test('the shader pieces are guarded, so a world without features compiles none of them', () => {
  for (const g of [FEATURE_PARS, FEATURE_ALBEDO, FEATURE_EMIT]) assert.match(g, /^\s*#if/);
  assert.match(FEATURE_NORMAL, /#ifdef FEATURES/);
  // ripples: whole numbers of waves per period in both directions
  for (const m of FEATURE_NORMAL.matchAll(/vec2\((\d+)\.0, (\d+)\.0\) \* \(6\.2831853 \/ (\d+)\.0\)/g)) {
    assert.ok(Number.isInteger(+m[1]) && Number.isInteger(+m[2]) && FEATURE_PERIODS.includes(+m[3]));
  }
});
