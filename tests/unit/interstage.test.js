// Interstage trusses. A stage is never stood on the bell of the engine above it: wherever a stack part sits on the
// nozzle end of a rocket engine, an open lattice ring as tall as that engine joins the rim of the part below to the
// engine's mount ring (and so to the rim of the tank above). The truss is derived from the part tree
// (Craft.interstages()), belongs to the part under the engine, is counted in every mass the game works out, and
// goes with that part when the stack splits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vessel } from '../../js/core/vessel.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { partDef, G0, INTERSTAGE, wantsInterstage, interstageMass } from '../../js/core/parts.js';
import { SYSTEM } from '../../js/core/bodies.js';

const home = SYSTEM.home;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'value'}: ${a} vs ${b} (tol ${tol})`);
const wet = type => { const d = partDef(type); let m = d.mass * 1000; for (const k in d.res) if (k !== 'elec') m += d.res[k]; return m; };
/** pod / tank / Sparrow / separator / tank / Goshawk: the plain two-stage rocket. */
function twoStage() {
  const c = new Craft('Two Stage');
  const [pod] = c.setRoot('pod_acorn');
  const [t1] = c.attachStack('tank_m200', pod.id, 'bottom');
  const [e1] = c.attachStack('eng_sparrow', t1.id, 'bottom');
  const [dec] = c.attachStack('dec_m', e1.id, 'bottom');
  const [t2] = c.attachStack('tank_m400', dec.id, 'bottom');
  const [e2] = c.attachStack('eng_goshawk', t2.id, 'bottom');
  return { c, pod, t1, e1, dec, t2, e2 };
}
function inSpace(craft) {
  const v = Vessel.fromCraft(craft, { crew: ['Ada'] });
  v.body = home;
  v.pos.set(home.radius + 300000, 0, 0);
  v.vel.set(0, 0, -Math.sqrt(home.gm / (home.radius + 300000)));
  v.launched = true;
  return v;
}

test('interstage: a stage stacked under an engine gets a lattice ring that reaches the rim above the engine', () => {
  const { c, t1, e1, dec, e2 } = twoStage();
  const list = c.interstages();
  assert.equal(list.length, 1, 'one joint under an engine: the bottom engine has nothing under it');
  const t = list[0], ed = partDef('eng_sparrow'), dd = partDef('dec_m');
  assert.equal(t.owner, dec.id, 'carried by the part under the engine');
  assert.equal(t.engine, e1.id);
  assert.equal(t.dir, 1, 'it stands up from the separator');
  near(t.h, ed.h, 1e-12, 'as tall as the engine it surrounds');
  near(t.y0, dec.pos.y + dd.h / 2, 1e-9, 'stands on the top face of the separator');
  near(t.y1, e1.pos.y + ed.h / 2, 1e-9, 'reaches the engine mount ring');
  near(t.y1, t1.pos.y - partDef('tank_m200').h / 2, 1e-9, 'which is the bottom rim of the tank above');
  near(t.r0, dd.r, 1e-12); near(t.r1, ed.r, 1e-12);
  assert.ok(t.r1 >= ed.r - 1e-9, 'the ring clears the whole engine: it is at least as wide as the engine envelope');
  assert.ok(!c.interstages().some(x => x.engine === e2.id));
  // nothing was moved to make room: the stage below still sits where the engine ends
  near(dec.pos.y + dd.h / 2, e1.pos.y - ed.h / 2, 1e-9);
});

test('interstage: its mass is sensible and counted in mass, dry mass, centre of mass and the stage table', () => {
  const { c, dec } = twoStage();
  const t = c.interstages()[0];
  // 2 π r h of wall at INTERSTAGE.kgPerM2, to 0.1 kg
  const expect = Math.round(2 * Math.PI * 0.625 * 0.9 * INTERSTAGE.kgPerM2 * 10) / 10;
  assert.equal(t.mass, expect);
  assert.equal(interstageMass(0.9, 0.625, 0.625), expect);
  assert.ok(t.mass > 10 && t.mass < partDef('tank_m200').mass * 1000, 'lighter than the shortest solid tank wall of that height class, heavier than nothing: ' + t.mass);
  assert.equal(c.interstageMass(), expect);
  const parts = c.parts.reduce((m, p) => m + wet(p.type), 0);
  near(c.mass(), parts + expect, 1e-9, 'wet mass');
  near(c.dryMass(), parts - 1000 - 2000 + expect, 1e-9, 'dry mass');
  // centre of mass: the truss sits half-way up its ring
  let m = 0, my = 0;
  for (const p of c.parts) { const d = partDef(p.type), pm = wet(p.type); m += pm; my += pm * (p.pos.y + (d.comY || 0)); }
  m += expect; my += expect * (t.y0 + t.y1) / 2;
  const com = c.centerOfMass();
  near(com.mass, m, 1e-9); near(com.y, my / m, 1e-9, 'com.y');
  // stage table: it is on board for the first burn and gone, with the separator, for the second
  const st = c.stats();
  const upper = wet('pod_acorn') + wet('tank_m200') + wet('eng_sparrow');
  near(st[0].startMass, parts + expect, 1e-9);
  near(st[0].dvVac, 305 * G0 * Math.log((parts + expect) / (parts + expect - 2000)), 1e-6);
  near(st[1].startMass, upper, 1e-9, 'upper stage flies without it');
  // the vessel agrees
  const v = Vessel.fromCraft(c);
  near(v.mass, c.mass(), 1e-9, 'vessel mass');
  near(v.com.y, com.y, 1e-9, 'vessel com');
  near(v.parts.get(dec.id).mass, wet('dec_m') + expect, 1e-9, 'the separator carries it');
  near(v.deltaV, c.deltaV().vac, 0.01, 'delta-v readout');
});

test('interstage: staging takes it away with the lower stage, and nothing is left on the nozzle', () => {
  const { c, e1, dec, t2, e2 } = twoStage();
  c.autoStage();
  const expect = c.interstages()[0].mass;
  const v = inSpace(c);
  assert.deepEqual(v.partList.filter(p => p.truss).map(p => p.id), [dec.id]);
  assert.deepEqual(v.parts.get(dec.id).truss, [{ side: 1, h: 0.9, r0: 0.625, r1: 0.625, mass: expect }]);
  const m0 = v.mass;
  const ev = [];
  v.activateNextStage(ev);                    // Goshawk
  v.activateNextStage(ev);                    // separator + Sparrow
  const dc = ev.find(e => e.type === 'decouple');
  assert.ok(dc && dc.debris, 'the stack split');
  const debris = dc.debris;
  assert.deepEqual([...debris.parts.keys()].sort((a, b) => a - b), [dec.id, t2.id, e2.id]);
  assert.ok(debris.parts.get(dec.id).truss, 'the truss left with the separator');
  assert.ok(!v.partList.some(p => p.truss), 'no truss stays on the upper stage');
  assert.ok(v.parts.has(e1.id) && !v.parts.get(e1.id).truss, 'the upper engine is bare');
  near(debris.mass, wet('dec_m') + wet('tank_m400') + wet('eng_goshawk') + expect, 1e-6, 'dropped mass');
  near(v.mass, wet('pod_acorn') + wet('tank_m200') + wet('eng_sparrow'), 1e-6, 'kept mass');
  near(v.mass + debris.mass, m0, 1e-6, 'no mass made or lost');
  // contact: with the engine gone, the open rim of the lattice (0.9 m above the separator) is what touches first
  const top = debris.parts.get(dec.id).pos.y + partDef('dec_m').h / 2 + 0.9;
  assert.ok(debris._cp.some(q => q.p.id === dec.id && Math.abs(q.y - top) < 1e-9 && Math.abs(q.r - 0.625) < 1e-9), 'bounding contact at the rim');
  const rim = debris._pts.filter(q => q.p.id === dec.id && Math.abs(q.y - top) < 1e-9);
  assert.equal(rim.length, 8, 'a ring of contact samples around the rim');
  for (const q of rim) near(Math.hypot(q.x - debris.parts.get(dec.id).pos.x, q.z - debris.parts.get(dec.id).pos.z), 0.625, 1e-9);
  // ... and while the stack was whole there was no such extra ring (the engine mount / tank rim is the contact there)
  const whole = Vessel.fromCraft(c);
  const wholeTop = whole.parts.get(dec.id).pos.y + partDef('dec_m').h / 2 + 0.9;
  assert.equal(whole._pts.filter(q => q.p.id === dec.id && Math.abs(q.y - wholeTop) < 1e-9).length, 0);
});

test('interstage: it survives a save and reload of the vessel, before and after staging', () => {
  const { c, dec } = twoStage();
  c.autoStage();
  const v = inSpace(c);
  const v2 = Vessel.fromJSON(JSON.parse(JSON.stringify(v.toJSON())));
  assert.deepEqual(v2.parts.get(dec.id).truss, v.parts.get(dec.id).truss);
  near(v2.mass, v.mass, 1e-9);
  const ev = [];
  v.activateNextStage(ev); v.activateNextStage(ev);
  const debris = ev.find(e => e.type === 'decouple').debris;
  const d2 = Vessel.fromJSON(JSON.parse(JSON.stringify(debris.toJSON())));
  near(d2.mass, debris.mass, 1e-9);
  assert.equal(d2._pts.length, debris._pts.length, 'same contact samples after a reload');
});

test('interstage: which joints get one', () => {
  // any stack part under a rocket engine: a tank straight under an engine (no separator) still gets the ring
  const a = new Craft();
  const [pod] = a.setRoot('pod_acorn');
  const [eng] = a.attachStack('eng_sparrow', pod.id, 'bottom');
  const [tank] = a.attachStack('tank_m200', eng.id, 'bottom');
  assert.deepEqual(a.interstages().map(t => [t.owner, t.engine]), [[tank.id, eng.id]]);
  a.removePart(tank.id);
  assert.equal(a.interstages().length, 0, 'take the stage away and the ring goes with it');
  assert.equal(a.interstageMass(), 0);
  // built the other way up (the engine set ON TOP of the lower stage): same joint, same owner
  const b = new Craft();
  const [low] = b.setRoot('tank_m400');
  const [dec] = b.attachStack('dec_m', low.id, 'top');
  const [up] = b.attachStack('eng_sparrow', dec.id, 'top');
  b.attachStack('tank_m200', up.id, 'top');
  assert.deepEqual(b.interstages().map(t => [t.owner, t.engine, t.dir]), [[dec.id, up.id, 1]]);
  // a narrower stage under a wide engine: the ring tapers from one rim to the other
  const d = new Craft();
  const [core] = d.setRoot('tank_l1600');
  const [big] = d.attachStack('eng_condor', core.id, 'bottom');
  const [ad] = d.attachStack('adapter_lm', big.id, 'bottom', { flip: true });
  const tt = d.interstages()[0];
  assert.equal(tt.owner, ad.id);
  near(tt.r1, 1.25, 1e-12); near(tt.r0, d.radiusAt(ad, tt.y0), 1e-12);
  // solid boosters (the casing is the wall) and jets (the tailpipe is the body) do not get one
  assert.equal(wantsInterstage(partDef('srb_ember')), false);
  assert.equal(wantsInterstage(partDef('eng_sparrow')), true);
  for (const id of ['eng_moth', 'eng_goshawk', 'eng_condor', 'eng_lantern']) assert.equal(wantsInterstage(partDef(id)), true, id);
  const s = new Craft();
  const [p2] = s.setRoot('pod_acorn');
  const [srb] = s.attachStack('srb_ember', p2.id, 'bottom');
  s.attachStack('dec_m', srb.id, 'bottom');
  assert.equal(s.interstages().length, 0);
  // an engine with nothing under it has nothing to join
  const { c, e2 } = twoStage();
  assert.ok(!c.interstages().some(t => t.engine === e2.id));
});

test('interstage: every stock craft has one wherever a stage sits under an engine', () => {
  let joints = 0;
  for (const c of stockCrafts()) {
    const trusses = c.interstages();
    // find the joints independently: a stack part whose top face meets the nozzle plane of a rocket engine on its axis
    for (const e of c.parts) {
      const ed = partDef(e.type);
      if (ed.shape !== 'engine' || ed.engine.type === 'jet' || !ed.attach.stack) continue;
      const nozzleY = e.pos.y + (e.flip ? 1 : -1) * ed.h / 2;
      const under = c.parts.filter(p => p !== e && partDef(p.type).attach.stack && Math.abs(p.pos.x - e.pos.x) < 1e-6 && Math.abs(p.pos.z - e.pos.z) < 1e-6 &&
        Math.abs((p.pos.y + (e.flip ? -1 : 1) * partDef(p.type).h / 2) - nozzleY) < 1e-6 && (p.parent === e.id || e.parent === p.id));
      if (!under.length) { assert.ok(!trusses.some(t => t.engine === e.id), c.name + ': a truss with nothing to carry'); continue; }
      joints++;
      const t = trusses.find(t => t.engine === e.id);
      assert.ok(t, `${c.name}: ${partDef(under[0].type).name} rests on the nozzle of ${ed.name} with no interstage`);
      assert.equal(t.owner, under[0].id, c.name);
      near(t.h, ed.h, 1e-12, c.name + ' truss height');
      near(Math.abs(t.y1 - t.y0), ed.h, 1e-9, c.name + ' spans the engine');
      assert.ok(t.r1 >= ed.r - 1e-9 && t.r0 > 0.2, c.name + ' rims');
      assert.ok(t.mass > 5 && t.mass < 0.15 * ed.mass * 1000 + 60, `${c.name}: ${t.mass} kg of truss around a ${ed.mass} t engine`);
    }
    // every truss is counted, and flies
    const parts = c.parts.reduce((m, p) => m + wet(p.type), 0), kg = trusses.reduce((m, t) => m + t.mass, 0);
    near(c.mass(), parts + kg, 1e-6, c.name + ' mass');
    const v = Vessel.fromCraft(c);
    near(v.mass, c.mass(), 1e-6, c.name + ' vessel mass');
    assert.equal(v.partList.reduce((n, p) => n + (p.truss ? p.truss.length : 0), 0), trusses.length, c.name);
    // when a truss is carried by a separator, firing that separator takes the truss off the controlling side
    for (const t of trusses) {
      const owner = c.getPart(t.owner);
      if (!partDef(owner.type).decoupler) continue;
      const w = Vessel.fromCraft(c);
      const drop = w.dropSet([owner.id]);
      assert.ok(drop.has(owner.id), c.name + ': the separator leaves, and its truss with it');
      assert.ok(!drop.has(t.engine), c.name + ': the engine above stays with the ship');
    }
  }
  assert.ok(joints >= 8, 'the stock fleet has stacked stages to check: ' + joints);
});
