// The assembly building's structure report (js/ui/builder/loads.js): the pure part between analyzeCraft()
// (js/core/loadcases.js) and what the panel, the pre-launch check and the 3D overlay show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { analyzeCraft } from '../../js/core/loadcases.js';
import { STRUCT } from '../../js/core/structure.js';
import { LOAD, loadLevel, loadColor, loadPercent, loadFill, loadWords, caseWords, casePhases, jointWhere, jointNormal, loadReport, loadSignature } from '../../js/ui/builder/loads.js';

/** A stack built downward from its first part. → { c, parts: [in order] } */
function stack(types) {
  const c = new Craft('Test');
  const parts = [c.setRoot(types[0])[0]];
  for (const t of types.slice(1)) { const m = c.attachStack(t, parts[parts.length - 1].id, 'bottom'); assert.equal(m.length, 1, 'attached ' + t); parts.push(m[0]); }
  return { c, parts };
}
/** A heavy size-L capsule on a size-S separator on a long thin stack of size-S tanks, pushed by a big engine. */
const noodle = () => stack(['pod_hearth', 'dec_s', ...Array(7).fill('tank_s200'), 'tank_l3200', 'eng_condor']);
/** A probe core on a tank and engine with two boosters on clamps. → { c, tank, clamps, boosters } */
function boosted() {
  const { c, parts } = stack(['probe_facet', 'tank_m800', 'eng_goshawk']);
  const tank = parts[1];
  const clamps = c.attachRadial('dec_radial', tank.id, tank.pos.y, 0, 2);
  const boosters = c.attachOuter('srb_ember', clamps[0].id);
  assert.equal(clamps.length, 2); assert.equal(boosters.length, 2);
  return { c, tank, clamps, boosters };
}
const J = (o = {}) => ({ a: 1, b: 2, kind: 'stack', pos: { x: 0, y: -1, z: 0 }, r: 0.625, util: 0.3, mode: 'compression', case: 'stage 1 max Q', cases: {}, axial: -1e5, shear: 1e3, bending: 1e3, braced: false, ...o });

test('colour scale: teal below 50 %, amber from 50 %, red from 90 %', () => {
  assert.equal(loadLevel(0), 'ok'); assert.equal(loadLevel(0.499), 'ok');
  assert.equal(loadLevel(0.5), 'warn'); assert.equal(loadLevel(0.899), 'warn');
  assert.equal(loadLevel(0.9), 'bad'); assert.equal(loadLevel(1.4), 'bad');
  assert.equal(loadLevel(NaN), 'ok'); assert.equal(loadLevel(undefined), 'ok');
  assert.equal(loadColor(0.2), 0x39d0c0);           // the game's teal
  assert.equal(loadColor(0.6), 0xffb347);           // ... and amber
  assert.equal(loadColor(0.95), LOAD.COLORS.bad);
  assert.notEqual(LOAD.COLORS.bad, LOAD.COLORS.warn);
  assert.equal(LOAD.NEAR, STRUCT.WARN, 'the "close to its limit" threshold is the flight warning threshold');
});

test('percent and bar fill', () => {
  assert.equal(loadPercent(0.424), '42 %'); assert.equal(loadPercent(1.4), '140 %'); assert.equal(loadPercent(0), '0 %');
  assert.equal(loadPercent(NaN), '--'); assert.equal(loadPercent(undefined), '--'); assert.equal(loadPercent(-0.1), '0 %');
  assert.equal(loadFill(0.25), 0.25); assert.equal(loadFill(1.7), 1); assert.equal(loadFill(-1), 0); assert.equal(loadFill(NaN), 0);
});

test('the deciding load in plain words, from the mode and the numbers', () => {
  // ring of 0.625 m: axial N/(2 pi r) against bending M/(pi r²)
  assert.equal(loadWords(J({ mode: 'compression', axial: -2e5, bending: 1e3 })), 'pushed together');
  assert.equal(loadWords(J({ mode: 'compression', axial: -2e5, bending: 2e5 })), 'bending');
  assert.equal(loadWords(J({ mode: 'tension', axial: 3e5, bending: 1e3 })), 'pulled apart');
  assert.equal(loadWords(J({ mode: 'tension', axial: 3e5, bending: 4e5 })), 'bending');
  // the tension side of a stack that is squeezed overall can only be bending
  assert.equal(loadWords(J({ mode: 'tension', axial: -1.7e5, bending: 1.7e5 })), 'bending');
  assert.equal(loadWords(J({ mode: 'shear', axial: 0, bending: 9e9 })), 'shear');
  // the crossover is where the two line loads are equal: M = N r / 2
  const r = 0.5, N = 1e5;
  assert.equal(loadWords(J({ r, mode: 'compression', axial: -N, bending: N * r / 2 * 0.99 })), 'pushed together');
  assert.equal(loadWords(J({ r, mode: 'compression', axial: -N, bending: N * r / 2 * 1.01 })), 'bending');
  assert.equal(loadWords(null), '');
  for (const w of ['tension', 'compression']) assert.ok(!/tension|compression/.test(loadWords(J({ mode: w }))), 'never the raw field');
});

test('load cases in plain words', () => {
  assert.equal(caseWords('stage 1 max Q', 1), 'at max Q');
  assert.equal(caseWords('stage 1 max Q', 3), 'at max Q');
  assert.equal(caseWords('stage 1 ignition', 2), 'at lift-off');
  assert.equal(caseWords('stage 1 burn-out', 1), 'at burn-out');
  assert.equal(caseWords('stage 1 burn-out', 2), 'at burn-out of the first burn');
  assert.equal(caseWords('stage 2 burn-out', 2), 'at burn-out of the second burn');
  assert.equal(caseWords('stage 2 ignition', 2), 'at ignition of the second burn');
  assert.equal(caseWords('stage 3 steering', 3), 'under full steering of the third burn');
  assert.ok(caseWords('something new').includes('something new'), 'an unknown case is still shown');
  assert.equal(caseWords('', 1), '');
  assert.equal(casePhases(['stage 1 ignition', 'stage 1 max Q', 'stage 2 burn-out']), 2);
  assert.equal(casePhases([]), 0); assert.equal(casePhases(undefined), 0);
});

test('a joint is named by its two parts: the lower one hangs under the upper one', () => {
  const { c, parts } = stack(['pod_hearth', 'dec_s', 'tank_s200', 'tank_s200', 'eng_wren']);
  const [pod, dec, t1, t2, eng] = parts;
  assert.equal(jointWhere(c, J({ a: pod.id, b: dec.id })), 'Stack Separator S under Hearth Command Module');
  assert.equal(jointWhere(c, J({ a: dec.id, b: pod.id })), 'Stack Separator S under Hearth Command Module', 'whichever side is the root');
  assert.equal(jointWhere(c, J({ a: t2.id, b: eng.id })), 'Wren Booster Engine under Flask S-200');
  assert.equal(jointWhere(c, J({ a: t1.id, b: t2.id })), 'Flask S-200 to Flask S-200');
  assert.equal(jointWhere(c, J({ a: pod.id, b: 999 })), 'part #999 under Hearth Command Module', 'a part that is gone does not throw');
  const b = boosted();
  assert.equal(jointWhere(b.c, J({ kind: 'radial', a: b.tank.id, b: b.clamps[0].id })), 'Radial Release Clamp on Canister M-800');
  assert.equal(jointWhere(b.c, J({ kind: 'radial', a: b.clamps[0].id, b: b.tank.id })), 'Radial Release Clamp on Canister M-800');
  assert.equal(jointWhere(b.c, J({ kind: 'outer', a: b.clamps[1].id, b: b.boosters[1].id })), 'Ember Solid Booster on Radial Release Clamp');
});

test('joint planes: stack joints lie across the axis, side mounts face outward from their host', () => {
  const b = boosted(), raw = analyzeCraft(b.c);
  const n = { x: 9, y: 9, z: 9 };
  for (const j of raw.joints) {
    jointNormal(b.c, j, n);
    assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-9, 'unit normal');
    if (j.kind === 'stack') { assert.deepEqual(n, { x: 0, y: 1, z: 0 }); continue; }
    assert.ok(Math.abs(n.y) < 1e-9, 'a side mount on an upright tank faces sideways');
    // outward: away from the core's axis, on the side the joint is on
    assert.ok(n.x * j.pos.x + n.z * j.pos.z > 0.99 * Math.hypot(j.pos.x, j.pos.z), `${j.kind} joint at x=${j.pos.x.toFixed(2)} faces outward`);
  }
  assert.ok(raw.joints.some(j => j.kind === 'radial') && raw.joints.some(j => j.kind === 'outer'));
  // the joint point of a side mount is on the skin of its host
  const tank = b.tank, rj = raw.joints.find(j => j.kind === 'radial' && (j.a === tank.id || j.b === tank.id));
  assert.ok(Math.abs(Math.hypot(rj.pos.x - tank.pos.x, rj.pos.z - tank.pos.z) - 0.625) < 0.02, 'clamp joint on the tank wall');
});

test('report of a synthetic result: order, top five, folding of symmetric copies, warnings', () => {
  const { c, parts } = stack(['pod_hearth', 'dec_s', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_s200', 'tank_s200', 'eng_wren']);
  const id = i => parts[i].id;
  const result = {
    cases: ['stage 1 ignition', 'stage 1 max Q', 'stage 1 burn-out'],
    joints: [
      J({ a: id(2), b: id(3), util: 0.2 }),
      J({ a: id(0), b: id(1), util: 1.4, mode: 'tension', axial: -1e5, bending: 5e5, r: 0.3125, pos: { x: 0, y: -1, z: 0 } }),
      J({ a: id(1), b: id(2), util: 0.8, mode: 'compression', axial: -9e5, bending: 10, r: 0.3125, case: 'stage 1 burn-out', braced: true }),
      J({ a: id(3), b: id(4), util: 0.55 }), J({ a: id(4), b: id(5), util: 0.1 }), J({ a: id(5), b: id(6), util: 0.05 }),
      J({ a: id(6), b: id(7), util: 0.6, mode: 'shear' }),
      J({ a: id(6), b: id(7), util: NaN }),                         // junk is dropped, not shown
    ],
  };
  const rep = loadReport(c, result);
  assert.equal(rep.empty, false); assert.equal(rep.count, 7); assert.equal(rep.phases, 1);
  assert.equal(rep.rows.length, 5, 'the five most loaded');
  assert.deepEqual(rep.rows.map(r => r.percent), ['140 %', '80 %', '60 %', '55 %', '20 %']);
  assert.deepEqual(rep.rows.map(r => r.level), ['bad', 'warn', 'warn', 'warn', 'ok']);
  assert.equal(rep.worst, rep.rows[0]);
  assert.equal(rep.worst.text, 'Stack Separator S under Hearth Command Module: bending at max Q, 140 % – will break');
  assert.equal(rep.worst.fill, 1);
  assert.deepEqual(rep.worst.ids.slice().sort(), [id(0), id(1)].sort());
  assert.deepEqual(rep.worst.pos, { x: 0, y: -1, z: 0 });
  assert.equal(rep.rows[1].text, 'Flask S-200 under Stack Separator S: pushed together at burn-out, 80 %, braced – close to its limit');
  assert.equal(rep.rows[1].braced, true); assert.equal(rep.rows[0].braced, false);
  assert.equal(rep.rows[2].words, 'shear'); assert.equal(rep.rows[2].verdict, '');
  // one mark per joint for the overlay, worst first, each row pointing at its own
  assert.equal(rep.marks.length, 7);
  assert.deepEqual(rep.marks.map(m => m.util), [1.4, 0.8, 0.6, 0.55, 0.2, 0.1, 0.05]);
  assert.deepEqual(rep.rows.map(r => r.marks), [[0], [1], [2], [3], [4]]);
  assert.deepEqual(rep.marks[0], { x: 0, y: -1, z: 0, nx: 0, ny: 1, nz: 0, r: 0.3125, util: 1.4 });
  // warnings: the one that breaks and the one near its limit, in plain words, nothing for the rest
  assert.equal(rep.warnings.length, 2);
  assert.match(rep.warnings[0], /^Stack Separator S under Hearth Command Module will break in flight: bending at max Q, 140 % of its strength\.$/);
  assert.match(rep.warnings[1], /^Flask S-200 under Stack Separator S is close to its limit: pushed together at burn-out, 80 % of its strength\.$/);
  assert.equal(loadReport(c, result, { top: 2 }).rows.length, 2);
  // more hot joints than lines: the rest are counted
  const many = { cases: result.cases, joints: [1.5, 1.4, 1.3, 1.2, 1.1, 0.99].map((u, i) => J({ a: id(i), b: id(i + 1), util: u })) };
  const w = loadReport(c, many).warnings;
  assert.equal(w.length, 4); assert.match(w[3], /^3 more joints are at or near the limit/);
  assert.equal(loadReport(c, many).breaking, 3); assert.equal(rep.breaking, 1);
  // a run of identical joints is told apart by counting from the nose
  const run = loadReport(c, { cases: result.cases, joints: [J({ a: id(3), b: id(4), util: 0.3, pos: { x: 0, y: -5, z: 0 } }), J({ a: id(2), b: id(3), util: 0.2, pos: { x: 0, y: -3, z: 0 } }), J({ a: id(4), b: id(5), util: 0.6, pos: { x: 0, y: -7, z: 0 } })] });
  assert.deepEqual(run.rows.map(r => r.where), ['Flask S-200 to Flask S-200, 3rd from the top', 'Flask S-200 to Flask S-200, 2nd from the top', 'Flask S-200 to Flask S-200, 1st from the top']);
  assert.match(loadReport(c, { cases: [], joints: [J({ a: id(3), b: id(4), pos: { x: 0, y: -5, z: 0 } }), J({ a: id(2), b: id(3), util: 0.2 })] }, { nose: 'nose' }).rows[0].where, /^Flask S-200 to Flask S-200, 2nd from the nose$/);

  // symmetric copies share a row
  const b = boosted();
  const sym = { cases: ['stage 1 ignition', 'stage 2 ignition'], joints: [
    J({ kind: 'radial', a: b.tank.id, b: b.clamps[0].id, util: 0.521, pos: { x: 0.625, y: -3, z: 0 }, r: 0.35 }),
    J({ kind: 'radial', a: b.tank.id, b: b.clamps[1].id, util: 0.519, pos: { x: -0.625, y: -3, z: 0 }, r: 0.35 }),
    J({ kind: 'outer', a: b.clamps[0].id, b: b.boosters[0].id, util: 0.3, pos: { x: 0.85, y: -3, z: 0 } }),
  ] };
  const rs = loadReport(b.c, sym);
  assert.equal(rs.rows.length, 2); assert.equal(rs.rows[0].n, 2); assert.equal(rs.count, 3);
  assert.match(rs.rows[0].text, /^Radial Release Clamp on Canister M-800 ×2: /);
  assert.deepEqual(rs.rows[0].marks, [0, 1]);
  assert.equal(rs.rows[0].ids.length, 3, 'the tank and both clamps light up');
  assert.ok(rs.marks[0].nx > 0.99 && rs.marks[1].nx < -0.99, 'each ring faces outward on its own side');
});

test('nothing to report: no design, one part, a result without joints', () => {
  for (const rep of [loadReport(null, null), loadReport(new Craft('x'), undefined), loadReport(new Craft('x'), { joints: [], cases: [], warnings: [] }), loadReport(null, {})]) {
    assert.equal(rep.empty, true); assert.equal(rep.worst, null); assert.deepEqual(rep.rows, []); assert.deepEqual(rep.warnings, []); assert.deepEqual(rep.marks, []);
  }
  const one = new Craft('One'); one.setRoot('pod_acorn');
  assert.equal(loadReport(one, analyzeCraft(one)).empty, true);
  assert.equal(loadReport(new Craft('Empty'), analyzeCraft(new Craft('Empty'))).empty, true);
});

test('real designs without engines or staging give a quiet report, not an error', () => {
  const glider = stack(['pod_acorn', 'tank_m200']).c;                   // no engine, no stages
  const rep = loadReport(glider, analyzeCraft(glider));
  assert.equal(rep.empty, false); assert.equal(rep.count, 1);
  assert.ok(rep.worst.util >= 0 && rep.worst.util < 0.5, 'util ' + rep.worst.util);
  assert.ok(rep.worst.text.length > 10); assert.deepEqual(rep.warnings, []);
  const unstaged = stack(['pod_acorn', 'tank_m200', 'eng_sparrow']).c;
  unstaged.autoStaging = false; unstaged.stages = [];
  const r2 = loadReport(unstaged, analyzeCraft(unstaged));
  assert.equal(r2.empty, false); assert.ok(Number.isFinite(r2.worst.util));
});

test('stock designs: a sane percentage, a readable line, no warnings', () => {
  for (const c of stockCrafts()) {
    const raw = analyzeCraft(c), rep = loadReport(c, raw);
    assert.equal(rep.empty, false, c.name);
    assert.equal(rep.count, raw.joints.length);
    assert.ok(rep.worst.util > 0 && rep.worst.util < LOAD.NEAR, `${c.name}: ${rep.worst.percent}`);
    assert.equal(rep.worst.util, raw.worst.util);
    assert.ok(rep.rows.length >= 1 && rep.rows.length <= 5);
    for (let i = 1; i < rep.rows.length; i++) assert.ok(rep.rows[i].util <= rep.rows[i - 1].util, 'worst first');
    for (const r of rep.rows) {
      assert.match(r.text, /^.+: (bending|pushed together|pulled apart|shear) (at|under) .+, \d+ %/, c.name + ': ' + r.text);
      assert.ok(!/tension|compression|stage \d|undefined|NaN|_/.test(r.text), c.name + ': ' + r.text);
      assert.ok(r.marks.length === r.n && r.ids.length >= 2);
    }
    assert.deepEqual(rep.warnings, [], c.name);
    assert.equal(rep.marks.length, raw.joints.length);
    for (const m of rep.marks) assert.ok([m.x, m.y, m.z, m.nx, m.ny, m.nz, m.r, m.util].every(Number.isFinite) && m.r > 0);
  }
});

test('a tall thin stack under a heavy capsule: the report goes red, names the joint and warns', () => {
  const { c } = noodle();
  const raw = analyzeCraft(c), rep = loadReport(c, raw);
  assert.ok(rep.worst.util >= 1, 'worst joint ' + rep.worst.percent);
  assert.equal(rep.worst.level, 'bad');
  assert.equal(rep.worst.verdict, 'will break');
  assert.match(rep.worst.text, /(Flask S-200|Stack Separator S|Drum L-3200).* – will break$/);
  assert.ok(rep.warnings.length >= 1);
  assert.match(rep.warnings[0], /will break in flight: /);
  assert.equal(rep.warnings.filter(w => /will break/.test(w)).length, Math.min(3, loadReport(c, raw, { top: 99 }).rows.filter(r => r.util >= 1).length));
  // every warned joint is a real joint of the thin part of the stack
  for (const j of raw.joints.filter(j => j.util >= 1)) assert.equal(j.r, 0.3125);
});

test('brace struts: a braced joint says so', () => {
  const b = boosted();
  const before = loadReport(b.c, analyzeCraft(b.c), { top: 99 });
  assert.ok(before.rows.every(r => !r.braced));
  // a strut on the tank whose tip reaches each booster
  const struts = b.c.attachRadial('strut', b.tank.id, b.tank.pos.y + 1.2, 0, 2);
  assert.equal(struts.length, 2);
  const raw = analyzeCraft(b.c), after = loadReport(b.c, raw, { top: 99 });
  assert.ok(raw.joints.some(j => j.braced), 'the strut reaches the booster');
  const braced = after.rows.filter(r => r.braced);
  assert.ok(braced.length >= 1);
  for (const r of braced) assert.match(r.text, /, braced/);
  assert.ok(braced.some(r => /Radial Release Clamp on Canister M-800/.test(r.where)));
  const clampBefore = before.rows.find(r => /Radial Release Clamp on Canister M-800/.test(r.where)), clampAfter = after.rows.find(r => /Radial Release Clamp on Canister M-800/.test(r.where));
  assert.ok(clampAfter.util < clampBefore.util, `the strut takes load off the clamp: ${clampBefore.percent} → ${clampAfter.percent}`);
});

test('the signature changes with the parts and the staging, not with the name', () => {
  const { c, parts } = stack(['pod_acorn', 'tank_m200', 'eng_sparrow', 'dec_m', 'tank_m400', 'eng_goshawk']);
  const s0 = loadSignature(c);
  c.name = 'Another name'; c.desc = 'notes';
  assert.equal(loadSignature(c), s0);
  assert.equal(loadSignature(Craft.fromJSON(c.toJSON())), s0, 'a save and load round trip is the same design');
  const st = c.stages.map(s => s.slice());
  c.autoStaging = false; c.stages = [st[0].concat(st[1]), ...st.slice(2)];
  const s1 = loadSignature(c);
  assert.notEqual(s1, s0, 'staging');
  c.moveSubtree(parts[5].id, 0, -0.1, 0);
  const s2 = loadSignature(c);
  assert.notEqual(s2, s1, 'a moved part');
  c.attachStack('nose_m', parts[0].id, 'top');
  assert.notEqual(loadSignature(c), s2, 'a new part');
  assert.equal(loadSignature(null), '');
});
