// Struts and fuel lines (js/core/span.js): where the far end goes, and that the structure braces what is drawn joined.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Craft } from '../../js/core/craft.js';
import { partDef } from '../../js/core/parts.js';
import { World } from '../../js/core/world.js';
import { SPAN, spanTarget, spanAxis, vesselSpan, isSpan } from '../../js/core/span.js';
import { STRUCT } from '../../js/core/structure.js';

const defOf = p => partDef(p.type);
/** A core tank with a booster on each side, held by `clampType` (which sets the gap between the two hulls). */
function twin(clampType) {
  const c = new Craft('span test');
  const core = c.setRoot('probe_beacon')[0];
  const tank = c.attachStack('tank_l3200', core.id, 'bottom')[0];
  c.attachStack('eng_condor', tank.id, 'bottom');
  const clamps = c.attachRadial(clampType, tank.id, tank.pos.y + 0.6, 0, 2);
  const boosters = c.attachOuter('srb_mallet', clamps[0].id);
  return { c, tank, clamps, boosters };
}
const gapOf = (tank, b) => Math.hypot(b.pos.x - tank.pos.x, b.pos.z - tank.pos.z) - partDef(tank.type).r - partDef(b.type).r;

test('the same number says how near a strut must come, in the structure and in the span rule', () => {
  assert.equal(SPAN.REACH, STRUCT.STRUT_REACH);
  assert.ok(isSpan(partDef('strut')) && isSpan(partDef('fuel_line')) && !isSpan(partDef('tank_l3200')));
});

test('a strut ends on the skin of the booster it faces, whatever the gap', () => {
  for (const clamp of ['dec_radial', 'dec_radial_l', 'pylon_m']) {
    const { c, tank, boosters } = twin(clamp);
    const gap = gapOf(tank, boosters[0]);
    assert.ok(gap > 0.1 && gap < SPAN.MAX, `${clamp}: gap ${gap.toFixed(3)} m`);
    for (const type of ['strut', 'fuel_line']) {
      const made = c.attachRadial(type, tank.id, tank.pos.y - 1.2, 0, 2);
      assert.equal(made.length, 2);
      for (const s of made) {
        const sp = spanTarget(c.parts, s, defOf, c.getPart(s.parent));
        assert.ok(sp, `${clamp} ${type}: reaches something`);
        assert.equal(sp.part.type, 'srb_mallet');
        // straight across at the booster's widest: its length is the gap between the hulls, its end is on the skin
        assert.ok(Math.abs(sp.len - gap) < 2e-3, `${clamp} ${type}: length ${sp.len.toFixed(4)} = gap ${gap.toFixed(4)}`);
        const b = sp.part, off = Math.hypot(sp.x - b.pos.x, sp.z - b.pos.z);
        assert.ok(Math.abs(off - partDef(b.type).r) < 2e-3, 'far end on the skin');
        // the surface normal there points back along the strut
        const ax = spanAxis(s);
        assert.ok(sp.nx * ax.x + sp.ny * ax.y + sp.nz * ax.z < -0.99);
      }
    }
  }
});

test('a strut facing nothing reaches nothing, and one facing a part too far away does not stretch to it', () => {
  const { c, tank, boosters } = twin('dec_radial_l');
  const side = c.attachRadial('strut', tank.id, tank.pos.y, Math.PI / 2, 1)[0];
  assert.equal(spanTarget(c.parts, side, defOf, c.getPart(side.parent)), null);
  // move the booster out beyond the longest strut
  const s = c.attachRadial('strut', tank.id, tank.pos.y - 1.2, 0, 1)[0];
  const b = boosters.find(q => q.pos.x > 0);
  b.pos.x += SPAN.MAX;
  for (const q of c.parts) if (q.parent === b.id) q.pos.x += SPAN.MAX;
  const sp = spanTarget(c.parts.filter(q => q.type !== 'dec_radial_l'), s, defOf, c.getPart(s.parent));
  assert.equal(sp, null);
});

test('a tilted strut reaches the booster higher up, and is longer for it', () => {
  const { c, tank, boosters } = twin('dec_radial_l');
  const flat = c.attachRadial('strut', tank.id, tank.pos.y - 2.0, 0, 1)[0];
  const up = c.attachRadial('strut', tank.id, tank.pos.y - 2.0, 0, 1, { pitch: 0.6 })[0];
  const a = spanTarget(c.parts, flat, defOf, tank), b = spanTarget(c.parts, up, defOf, tank);
  assert.ok(a && b && a.part === b.part && boosters.includes(a.part));
  assert.ok(b.len > a.len * 1.15, `${a.len.toFixed(3)} → ${b.len.toFixed(3)}`);
  assert.ok(b.y > a.y + 0.2);
});

test('in flight the structure braces exactly the joints of the struts that are drawn reaching', () => {
  // a wide gap: before, the 0.9 m strut fell short of a booster on a long hardpoint only by luck of the numbers;
  // now the picture and the bracing come from one rule
  for (const clamp of ['dec_radial', 'dec_radial_l', 'pylon_m']) {
    const { c, tank } = twin(clamp);
    c.attachRadial('strut', tank.id, tank.pos.y - 1.2, 0, 2);
    c.attachRadial('strut', tank.id, tank.pos.y, Math.PI / 2, 1);      // faces nothing
    c.autoStage();
    const w = new World({});
    const v = w.launch(c, { crew: [] });
    w.step(0.02);
    let reach = 0;
    for (const p of v.parts.values()) {
      if (p.def.shape !== 'strut') continue;
      const sp = vesselSpan(v, p);
      if (sp) reach++;
      assert.equal(p._brace ?? null, sp ? sp.part.id : null, `${clamp}: braced = drawn reaching`);
    }
    assert.equal(reach, 2);
    assert.ok(v.structure.joints.some(j => j.braces > 0));
  }
});
