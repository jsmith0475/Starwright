// The science reference: the TeX converter, and that every chapter, equation and worked number is sound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { texToMathML, texToText } from '../../js/ui/tex.js';
import { CHAPTERS, scienceContext, parseBody, parseInline } from '../../js/ui/sciencetext.js';
import { SYSTEM } from '../../js/core/bodies.js';
import { G0, PARTS, AIR_RATING } from '../../js/core/parts.js';
import { TUNING, wingCoefficients } from '../../js/core/vessel.js';
import { STRUCT, jointUtilisation } from '../../js/core/structure.js';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { Quaternion, Vector3 } from '../../js/lib/three.module.min.js';
import { machRise } from '../../js/ui/scienceaero.js';
import { dragRise, bluntness, wakeFraction, newtonWeight, pitotCp } from '../../js/core/aero.js';

const ctx = scienceContext(SYSTEM, G0);

test('tex: words inside \\text keep their spaces', () => {
  assert.match(texToMathML(String.raw`C_p = 0 \text{ in the lee}`), /<mtext>\u00a0in the lee<\/mtext>/);
  assert.match(texToMathML(String.raw`\text{where it faces the flow}`), /<mtext>where it faces the flow<\/mtext>/);
  assert.match(texToMathML(String.raw`\frac{1}{3\ \text{s}}`), /<mtext>s<\/mtext>/);
});

test('tex: fractions, roots, scripts, accents and Greek become MathML', () => {
  const m = texToMathML(String.raw`\Delta v = v_e \ln\frac{m_0}{m_1}`, { display: true });
  assert.match(m, /^<math [^>]*display="block"/);
  assert.match(m, /<mi>Δ<\/mi><mi>v<\/mi><mo>=<\/mo><msub><mi>v<\/mi><mi>e<\/mi><\/msub>/);
  assert.match(m, /<mfrac><mrow><msub><mi>m<\/mi><mn>0<\/mn><\/msub><\/mrow><mrow><msub><mi>m<\/mi><mn>1<\/mn><\/msub><\/mrow><\/mfrac>/);
  assert.match(texToMathML(String.raw`\sqrt[3]{x}`), /<mroot><mrow><mi>x<\/mi><\/mrow><mrow><mn>3<\/mn><\/mrow><\/mroot>/);
  assert.match(texToMathML(String.raw`\ddot{\mathbf{r}}`), /<mover accent="true"><mrow><mi mathvariant="bold" class="bf">r<\/mi><\/mrow><mo>¨<\/mo><\/mover>/);
  assert.match(texToMathML('x_1^2'), /<msubsup><mi>x<\/mi><mn>1<\/mn><mn>2<\/mn><\/msubsup>/);
  assert.match(texToMathML(String.raw`\int_0^T a\,dt`, { display: true }), /<msubsup><mo>∫<\/mo><mn>0<\/mn><mi>T<\/mi><\/msubsup>/);
  assert.match(texToMathML(String.raw`\sum_{k} x_k`, { display: true }), /<munder><mo>∑<\/mo>/);
  assert.match(texToMathML(String.raw`\left(\frac{a}{b}\right)`), /<mo>\(<\/mo><mrow><mfrac>/);
  assert.match(texToMathML('v = 2,337'), /<mn>2,337<\/mn>/, 'a number with a thousands comma stays one number');
  assert.match(texToMathML('a < b'), /&lt;/, 'angle brackets are escaped');
  assert.match(texToMathML(String.raw`\sin^2\alpha`), /<msup><mi>sin<\/mi><mn>2<\/mn><\/msup><mo>&#x2061;<\/mo><mi>α<\/mi>/, 'a squared function name carries its own exponent');
});

test('tex: anything unknown or unbalanced throws, so a typo cannot ship', () => {
  assert.throws(() => texToMathML(String.raw`\notacommand x`), /unknown command/);
  assert.throws(() => texToMathML(String.raw`\frac{a}{b`), /missing }/);
  assert.throws(() => texToMathML('a}'), /unexpected }/);
  assert.throws(() => texToMathML(String.raw`\left( x`), /without/);
  assert.throws(() => texToMathML('x^1^2'), /double superscript/);
});

test('tex: the spoken form drops the markup', () => {
  assert.equal(texToText(String.raw`\mu = G M`), 'μ = G M');
  assert.equal(texToText(String.raw`v_e\,\ln\frac{m_0}{m_1}`), 'v_e ln frac m_0 m_1');
});

test('science: the chapters cover the subject and each has a unique id, title and lead', () => {
  assert.ok(CHAPTERS.length >= 10);
  assert.equal(new Set(CHAPTERS.map(c => c.id)).size, CHAPTERS.length);
  for (const want of ['gravity', 'conics', 'visviva', 'kepler', 'rocket', 'maneuvers', 'transfers', 'ascent', 'atmosphere', 'aeromodel', 'structure', 'breakup', 'landing', 'rendezvous', 'numerics']) {
    assert.ok(CHAPTERS.some(c => c.id === want), 'chapter ' + want);
  }
  for (const c of CHAPTERS) { assert.ok(c.title.length > 5 && c.lead.length > 20, c.id); }
});

test('science: every equation and inline formula converts, and no computed number is missing', () => {
  let equations = 0, words = 0;
  for (const ch of CHAPTERS) {
    const body = ch.body(ctx);
    assert.doesNotMatch(body, /undefined|NaN|\[object|Infinity/, ch.id + ': a computed value is missing');
    const blocks = parseBody(body);
    assert.ok(blocks.filter(b => b.type === 'h').length >= 3, ch.id + ' has sections');
    assert.ok(blocks.filter(b => b.type === 'eq').length >= 2, ch.id + ' has equations');
    assert.ok(blocks.some(b => b.type === 'game'), ch.id + ' says what the game does');
    for (const b of blocks) {
      if (b.type === 'eq') { equations++; assert.doesNotThrow(() => texToMathML(b.text, { display: true }), ch.id + ': ' + b.text); continue; }
      if (b.type === 'calc') { assert.ok(['rocket', 'transfer', 'airflow'].includes(b.text), 'calculator ' + b.text); continue; }
      const spans = parseInline(b.text);
      for (const s of spans) {
        if (s.math !== undefined) assert.doesNotThrow(() => texToMathML(s.math), ch.id + ': ' + s.math);
        else words += String(s.t || s.b || s.i).split(/\s+/).length;
      }
      const rest = spans.filter(s => s.math === undefined).map(s => s.t || s.b || s.i).join('');
      assert.doesNotMatch(rest, /[$\\]|\*\*/, ch.id + ': stray markup in "' + b.text.slice(0, 60) + '"');
    }
  }
  assert.ok(equations >= 60, equations + ' displayed equations');
  assert.ok(words >= 5000, words + ' words: a real explanation, not a glossary');
});

test('science: the worked numbers agree with the game\'s own worlds and orbit code', () => {
  const { home, moon, star, far, parkAlt } = ctx;
  assert.equal(home, SYSTEM.home);
  const r = home.radius + parkAlt;
  // circular speed and period against the game's Orbit class
  const o = moon.orbit;
  assert.ok(Math.abs(ctx.period(home.gm, o.a) - o.period) / o.period < 1e-9);
  assert.ok(Math.abs(ctx.vcirc(home, parkAlt) - Math.sqrt(home.gm / r)) < 1e-9);
  assert.ok(Math.abs(ctx.vesc(home, parkAlt) / ctx.vcirc(home, parkAlt) - Math.SQRT2) < 1e-12);
  // Hohmann: the transfer ellipse really touches both orbits (vis-viva at each end) and energy rises monotonically outward
  const h = ctx.hohmann(star.gm, home.orbit.a, far.orbit.a);
  assert.ok(Math.abs(h.a - (home.orbit.a + far.orbit.a) / 2) < 1);
  assert.ok(Math.abs(h.vp * home.orbit.a - h.va * far.orbit.a) / (h.vp * home.orbit.a) < 1e-12, 'angular momentum is the same at both ends');
  assert.ok(Math.abs((h.vp * h.vp / 2 - star.gm / home.orbit.a) - (-star.gm / (2 * h.a))) < 1e-3, 'energy is −μ/2a');
  assert.ok(h.dv1 > 0 && h.dv2 > 0 && h.tof > 0);
  // ejection: with no excess speed the burn is exactly escape minus circular
  assert.ok(Math.abs(ctx.eject(home, parkAlt, 0) - (ctx.vesc(home, parkAlt) - ctx.vcirc(home, parkAlt))) < 1e-9);
  // the sphere of influence quoted is the one the game patches at
  assert.ok(Math.abs(home.soi - home.orbit.a * Math.pow(home.gm / star.gm, 0.4)) < 1e-3);
  assert.match(CHAPTERS.find(c => c.id === 'transfers').body(ctx), new RegExp((home.soi / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })));
});

// ---------------------------------------------------------------------------------------------------------------
// The chapters on the game's own aerodynamics, structure and breakup (js/ui/scienceaero.js). The formulas printed in
// the reference are evaluated here by hand and compared with what the real flight code does to a real vessel.

const text = id => CHAPTERS.find(c => c.id === id).body(ctx);
/** A craft in the air above the home world: air-relative velocity `speed` straight up, nose turned `tilt` about a body axis. */
function inAir(craft, { alt, speed, axis = [0, 0, 1], tilt = 0 }) {
  const w = new World(), b = SYSTEM.home, r = b.radius + alt;
  const v = w.spawn(craft, { crew: ['Ada'], body: b, pos: new Vector3(r, 0, 0), vel: new Vector3(speed, 0, -2 * Math.PI / b.rotPeriod * r) });
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(1, 0, 0));
  if (tilt) v.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(...axis), tilt));
  v.w.set(0, 0, 0); v.ctrl.sas = false; v.ctrl.throttle = 0;
  return { w, v, rho: b.density(alt), q: 0.5 * b.density(alt) * speed * speed };
}
/** pod + `tanks` M-400 canisters, with `sym` copies of a fin on the lowest. */
function finned(fin, sym, tanks = 3, angle = 0) {
  const c = new Craft('finned');
  let t = c.attachStack('tank_m400', c.setRoot('pod_acorn')[0].id, 'bottom')[0];
  for (let k = 1; k < tanks; k++) t = c.attachStack('tank_m400', t.id, 'bottom')[0];
  c.attachRadial(fin, t.id, 0, angle, sym); c.autoStage();
  return c;
}
const close = (got, want, rel, what) => assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${what}: ${got} against ${want}`);

test('aerodynamics chapter: the body-drag formulas and the drag rise are what the flight code applies', () => {
  const t = PARTS.tank_m400, face = Math.PI * t.r * t.r * t.drag.top, side = 2 * t.r * t.h * t.drag.side;
  const one = new Craft('tank'); one.setRoot('tank_m400'); one.autoStage();
  for (const speed of [200, 288, 400, 576, 960, 1500]) for (const broadside of [false, true]) {
    const { w, v, q } = inAir(one, { alt: 1153, speed, tilt: broadside ? Math.PI / 2 : 0 });
    const m = v.mass; w.step(TUNING.DT_MAX);
    const mach = speed / SYSTEM.home.soundSpeed(1153);
    // the face-and-side law: end on q (M_w A_w + k_wake M_l A_l) with both faces alike; broadside q M_blunt A_s
    const mFace = dragRise(mach, bluntness(t.drag.top));
    const classic = broadside ? dragRise(mach, 1) * side : face * mFace * (1 + wakeFraction(mach));
    // Newton's law by hand: a flat face head on C_p,max pi r², a cylinder across the flow (2/3) C_p,max (2 r h)
    const newton = pitotCp(mach, SYSTEM.home.atmo.gamma) * (broadside ? 2 / 3 * 2 * t.r * t.h : Math.PI * t.r * t.r);
    const wN = newtonWeight(mach);
    close(v.gForce * G0 * m, q * ((1 - wN) * classic + wN * newton), wN > 0 ? 2e-3 : 1e-9, `Mach ${mach.toFixed(2)} ${broadside ? 'broadside' : 'end on'}`);
  }
  assert.deepEqual([0.5, 0.7, 1.1, 2.5, 4, 8, 20].map(mm => dragRise(mm, 1)), [1, 1, 1.55, 1.9, 1.98, 2, 2]);
  assert.deepEqual([0.5, 0.7, 1.1, 2.5, 4, 8, 20].map(mm => dragRise(mm, 0)), [1, 1, 1.9, 1.1, 0.9, 0.8, 0.8]);
  assert.deepEqual([0.1, 0.2, 0.45, 0.7, 0.9].map(bluntness), [0, 0, 0.5, 1, 1]);
  close(wakeFraction(0.5), 0.25, 1e-12, 'wake at low speed'); close(wakeFraction(5), 0.01, 1e-12, 'wake at Mach 5');
  assert.deepEqual([1, 1.5, 4, 9].map(newtonWeight), [0, 0, 1, 1]);
  close(pitotCp(1e3, 1.4), 1.839, 1e-3, 'the high Mach limit of C_p,max for air');
  // wings, fins and panels keep the single curve
  assert.deepEqual([0.5, 0.7, 1.1, 2.5, 4].map(machRise), [1, 1, TUNING.MACH_PEAK, TUNING.MACH_HIGH, TUNING.MACH_HIGH]);
  close(machRise(0.9), 1.5, 1e-12, 'half way up the rise');
  // the worked example prints these two forces at 20 kPa
  const body = text('aeromodel');
  assert.ok(body.includes(ctx.sig(20000 * face * 1.25 / 1000, 3)) && body.includes(ctx.sig(20000 * side / 1000, 3)), 'the canister example');
  assert.ok(body.includes(String(Math.round(SYSTEM.home.soundSpeed(0)))) && body.includes(String(TUNING.WING_SLOPE)) && body.includes(String(TUNING.FIN_LIFT)));
  // the capsule example: its drag coefficient at Mach 8 is C_p,max (1 + cos² 25°) / 2
  assert.ok(body.includes(ctx.sig(pitotCp(8, 1.4) * (1 + Math.cos(TUNING.CAP_PHI * Math.PI / 180) ** 2) / 2, 3)), 'the capsule example');
});

test('aerodynamics chapter: fin lift, the stall and the flat plate are the game\'s', () => {
  // attached: C_L = a α, C_D = C_D0 + K C_L²; broadside: no lift, full plate drag
  const a5 = 5 * Math.PI / 180, [cl, cd] = wingCoefficients(a5, TUNING.FIN_LIFT, TUNING.FIN_STALL, [0, 0]);
  close(cl, TUNING.FIN_LIFT * a5, 1e-12, 'C_L at 5°');
  close(cd, TUNING.WING_CD0 + TUNING.WING_K * cl * cl, 1e-12, 'C_D at 5°');
  const [cl90, cd90] = wingCoefficients(Math.PI / 2);
  assert.ok(Math.abs(cl90) < 1e-12); close(cd90, TUNING.WING_CD0 + TUNING.WING_PLATE_CD, 1e-12, 'plate drag');
  const [cl45] = wingCoefficients(Math.PI / 4); close(cl45, TUNING.WING_PLATE, 1e-12, 'plate lift at 45°');
  // in flight: a Tail Fin at 5° to the flow carries q S C_L
  const { w, v, q } = inAir(finned('fin', 1), { alt: 3000, speed: 200, axis: [1, 0, 0], tilt: a5 });
  w.step(TUNING.DT_MAX);
  const fin = [...v.parts.values()].find(p => p.def.id === 'fin');
  close(Math.abs(fin._aoa), a5, 1e-9, 'angle of attack');
  close(Math.abs(fin._lift), q * PARTS.fin.fin.area * cl, 1e-9, 'lift of a Tail Fin');
});

test('structure chapter: the ring formulas and the strength table are the game\'s', () => {
  const A = ctx.aero, n = [0, 1, 0], caps = [STRUCT.LINE_T, STRUCT.LINE_C, STRUCT.LINE_S];
  for (const r of [0.3125, 0.625, 1.25, 1.875]) {
    const s = A.ring(r);
    close(jointUtilisation([0, -s.pull, 0], [0, 0, 0], n, r, ...caps).util, 1, 1e-12, 'pull apart');      // F·n < 0 is tension
    close(jointUtilisation([0, s.crush, 0], [0, 0, 0], n, r, ...caps).util, 1, 1e-12, 'crush');
    close(jointUtilisation([0, 0, 0], [s.bend, 0, 0], n, r, ...caps).util, 1, 1e-12, 'bend');
    // shear V/(πr) and twist M_t/(2πr²)
    close(jointUtilisation([STRUCT.LINE_S * Math.PI * r, 0, 0], [0, 0, 0], n, r, ...caps).util, 1, 1e-12, 'shear');
    close(jointUtilisation([0, 0, 0], [0, STRUCT.LINE_S * 2 * Math.PI * r * r, 0], n, r, ...caps).util, 1, 1e-12, 'twist');
  }
  // the worked example: compression lets a joint take more bending before its tension side opens
  const r = 0.625, comp = 200e3, bend = (STRUCT.LINE_T + comp / (2 * Math.PI * r)) * Math.PI * r * r;
  const u = jointUtilisation([0, comp, 0], [bend, 0, 0], n, r, ...caps);
  close(u.util, 1, 1e-12, 'pre-compressed joint at its limit'); assert.equal(u.mode, 'tension');
  const body = text('structure');
  assert.ok(body.includes(ctx.sig(bend / 1e6, 2)) && body.includes(String(STRUCT.FAIL_TIME)) && body.includes(String(STRUCT.HEAL_TIME)));
});

test('breakup chapter: the thin root, the air ratings and the tear-off time are the game\'s', () => {
  const A = ctx.aero, body = text('breakup');
  // a pure flat-wise moment equal to the quoted capacity puts the root exactly at its limit
  for (const id of ['fin_broad', 'fin']) {
    const f = A.fin(id), cap = STRUCT.LINE_T * f.factor;
    const u = jointUtilisation([0, 0, 0], [0, f.capM, 0], [1, 0, 0], 0.5, cap, STRUCT.LINE_C * f.factor, STRUCT.LINE_S * f.factor, { h: f.h, t: f.t, c: [0, 1, 0] });
    close(u.util, 1, 1e-12, id + ' root at the quoted moment');
    assert.equal(f.arm, PARTS[id].rw / 2);
  }
  // in flight: two opposite Broad Fins face on to the flow at the pressure the chapter quotes. The root reads a little
  // under 100 % (the fin's own mass is moved along with the ship), which is what the example says.
  const f = A.fin('fin_broad'), qLimit = f.capM / (f.area * f.cd90 * f.arm);
  assert.ok(body.includes(ctx.sig(qLimit / 1000, 2) + ' kPa'), 'the quoted face-on limit');
  const rho = SYSTEM.home.density(3000), speed = Math.sqrt(2 * qLimit / rho);
  for (const tanks of [1, 3]) {
    const { w, v } = inAir(finned('fin_broad', 2, tanks), { alt: 3000, speed, axis: [1, 0, 0], tilt: Math.PI / 2 });
    w.step(TUNING.DT_MAX);
    const utils = v.structure.joints.filter(j => j.b.def.id === 'fin_broad').map(j => j.util);
    assert.equal(utils.length, 2);
    for (const u of utils) assert.ok(u > 0.82 && u < 1, `Broad Fin root face on at ${(qLimit / 1000).toFixed(1)} kPa, ${tanks} tanks: ${(u * 100).toFixed(0)} %`);
    // 9 to 10 kPa in flight: the limit is reached between those
    const inFlight = qLimit / Math.max(...utils);
    assert.ok(inFlight > 8900 && inFlight < 10500, `in-flight limit ${(inFlight / 1000).toFixed(1)} kPa`);
  }
  // fins in an X: each at half the pressure through its face
  {
    const at = ang => { const { w, v } = inAir(finned('fin_broad', 1, 3, ang), { alt: 3000, speed: 150, axis: [1, 0, 0], tilt: Math.PI / 2 }); w.step(TUNING.DT_MAX); return v.structure.joints.find(j => j.b.def.id === 'fin_broad').util; };
    close(at(Math.PI / 4) / at(0), 0.5, 0.02, 'a fin at 45° to a cross-flow');
  }
  // every rating is listed with the game's number
  assert.equal(A.rated.length, Object.keys(AIR_RATING).length);
  for (const r of A.rated) assert.ok(body.includes(`${r.q / 1000} kPa`), r.name);
  // cross-flow q sin²θ and the damage rule, on a real nose cone pitched 60° off the flow
  const c = new Craft('nosed');
  assert.equal(c.attachStack('nose_m', c.setRoot('tank_m400')[0].id, 'top').length, 1); c.autoStage();
  const th = Math.PI / 3, { w, v, q } = inAir(c, { alt: 2000, speed: 250, tilt: th });
  const held = { pos: v.pos.clone(), vel: v.vel.clone(), q: v.q.clone() };
  const hold = () => { v.pos.copy(held.pos); v.vel.copy(held.vel); v.q.copy(held.q); v.w.set(0, 0, 0); };
  w.step(TUNING.DT_MAX);
  const nose = v.airLoads().find(l => l.name === PARTS.nose_m.name);
  close(nose.q, q * Math.sin(th) ** 2, 1e-9, 'flow across the nose cone');
  close(nose.damage, (nose.q / nose.rated - 1) * TUNING.DT_MAX / STRUCT.AIR_FAIL_TIME, 1e-9, 'damage after one step');
  close(A.tearTime(2 * nose.rated, nose.rated), STRUCT.AIR_FAIL_TIME, 1e-12, 'twice the rating');
  assert.equal(A.tearTime(nose.rated, nose.rated), Infinity);
  // and held in that airflow (the drag would otherwise slow it below its rating), it comes off when the formula says
  let steps = 1; const events = []; w.on('structure', d => events.push(d));
  while (!events.length && steps < 500) { hold(); w.step(TUNING.DT_MAX); steps++; }
  assert.ok(events.length && events[0].mode === 'airflow', 'the nose cone is torn off by the airflow');
  const predicted = A.tearTime(nose.q, nose.rated);
  assert.ok(Math.abs(steps * TUNING.DT_MAX - predicted) <= 2 * TUNING.DT_MAX, `torn off after ${(steps * TUNING.DT_MAX).toFixed(2)} s, formula ${predicted.toFixed(2)} s`);
});
