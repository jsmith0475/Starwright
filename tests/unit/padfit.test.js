// The launch pad fitted to the rocket on it (js/render/padfit.js): a mount and hold-down clamps under every body that
// stands on an engine, and service arms that end on the hull. The plan is arithmetic on the craft's parts; these
// check it against the same parts, for every stock craft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../js/core/world.js';
import { stockCrafts, stockSite } from '../../js/core/craft.js';
import { planPadFit, PAD_TOWER, DEFAULT_ARMS } from '../../js/render/padfit.js';

const onPad = name => { const w = new World(), v = w.launch(stockCrafts().find(c => c.name === name), { site: 'pad' }); return { v, plan: planPadFit(v) }; };
/** The parts as the plan's frame has them: y from the deck, x and z from the centre of mass. */
const solids = v => { const g = v._lowest({ x: 0, y: 1, z: 0 }).h; return [...v.parts.values()].map(p => ({ p, d: p.def, x: p.pos.x - v.com.x, z: p.pos.z - v.com.z, y0: p.pos.y - p.def.h / 2 - v.com.y - g, y1: p.pos.y + p.def.h / 2 - v.com.y - g })); };

test('a rocket that stands on its engine bell gets a mount under the rim above that engine', () => {
  const { v, plan } = onPad('Skylark II');
  assert.equal(plan.columns.length, 1);
  const c = plan.columns[0], S = solids(v), eng = S.find(s => s.d.engine && s.y0 < 0.08), tank = S.find(s => Math.abs(s.y0 - eng.y1) < 0.05 && s !== eng);
  assert.ok(Math.abs(c.h - eng.y1) < 1e-6, 'the clamps take the rocket at the top of the engine');
  assert.ok(Math.abs(c.R - (tank.d.rBottom ?? tank.d.r)) < 1e-6, 'at the radius of the tank that sits on it');
  assert.ok(c.Rp - c.w / 2 > Math.max(c.R, eng.d.r) + 0.05, 'the ring is clear of the engine and the tank');
  assert.ok(c.top <= c.h && c.top - c.t > 0.2, 'and lies between the deck and the rim');
  assert.ok(c.legs.length >= 3, 'on at least three legs');
  // the lower arm ends on the skin of the tank it is level with: 4 cm short of it
  const arm = plan.arms.find(a => !a.crew), drum = S.find(s => s.p._stack && s.y0 < arm.y && s.y1 > arm.y + 1.8);
  assert.ok(Math.abs(arm.tip - (drum.x + drum.d.r) - 0.04) < 1e-6, `the arm ends ${(arm.tip - drum.x - drum.d.r).toFixed(3)} m from the hull`);
});

test('every stock rocket on the pad: legs and ring never stand inside another part of the craft', () => {
  let mounts = 0;
  for (const craft of stockCrafts()) {
    if (stockSite(craft) !== 'pad') continue;
    const w = new World(), v = w.launch(craft, { site: 'pad' }), plan = planPadFit(v);
    if (!plan) continue;
    const S = solids(v);
    for (const c of plan.columns) {
      mounts++;
      assert.ok(c.legs.length >= 2 && c.h >= 0.25, `${craft.name}: a mount has legs and height`);
      for (const a of c.legs) {
        const x = c.x + Math.cos(a) * c.Rp, z = c.z + Math.sin(a) * c.Rp;
        for (const s of S) {
          if (!s.p._stack || s.y0 > c.h + 0.5) continue;
          const r = Math.max(s.d.rBottom ?? s.d.r ?? 0, s.d.rTop ?? s.d.r ?? 0);
          assert.ok(Math.hypot(x - s.x, z - s.z) > r, `${craft.name}: a leg stands inside ${s.d.id}`);
        }
      }
    }
    for (const arm of plan.arms) {
      assert.ok(arm.y >= PAD_TOWER.minY && arm.y <= PAD_TOWER.maxY, `${craft.name}: arm height`);
      assert.ok(arm.tip < PAD_TOWER.hinge - 1.2, `${craft.name}: the arm has length`);
      // the tip never stands inside a drum of the stack that is level with the arm and on its line
      for (const q of S) if (q.p._stack && Math.abs(q.z) < 0.3 && q.y0 < arm.y && q.y1 > arm.y + PAD_TOWER.truss && (q.d.rTop ?? q.d.r) === (q.d.rBottom ?? q.d.r)) assert.ok(arm.tip >= q.x + q.d.r, `${craft.name}: the arm at ${arm.y.toFixed(1)} m ends inside ${q.d.id}`);
    }
  }
  assert.ok(mounts >= 8, 'most stock rockets stand on an engine');
});

test('a craft that stands on its own legs gets no mount, and the crew arm goes to the cabin', () => {
  const { v, plan } = onPad('Moonstep');
  assert.equal(plan.columns.length, 0);
  const cabin = solids(v).filter(s => s.d.crew > 0).sort((a, b) => b.y1 - a.y1)[0], arm = plan.arms.find(a => a.crew);
  assert.ok(arm && arm.y > cabin.y0 - 1 && arm.y < cabin.y1, 'the walkway is at the cabin');
  const tall = onPad('Farwind').plan;
  assert.equal(tall.arms.length, 3, 'a tall rocket gets all three arms');
  assert.ok(tall.arms.every((a, i) => !i || a.y < tall.arms[i - 1].y));
});

test('no rocket, no plan; the bare pad keeps three stock arms', () => {
  assert.equal(planPadFit(null), null);
  assert.equal(DEFAULT_ARMS.length, 3);
  assert.ok(DEFAULT_ARMS.every(a => a.tip < PAD_TOWER.hinge));
});
