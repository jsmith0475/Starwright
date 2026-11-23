// 9. Two vessels at once (reusable boosters, phase 1; docs/BOOSTERS.md). A dropped stage that can still be flown
// keeps full physics at any distance from the vessel being watched. These checks ask whether that physics is the
// same physics: against two-body motion from tests/verify/ref.mjs, against the conservation laws, and against
// itself when the player watches a different vessel.
import { Craft } from '../../js/core/craft.js';
import { LOAD_RANGE } from '../../js/core/world.js';
import { World, SYSTEM, A, spawn, run } from './harness.mjs';
import * as R from './ref.mjs';

const sys = R.readSystem();

/** capsule + tank + Sparrow / separator / [guidance ring] + tanks + Goshawk, four fins. */
function rocket({ ring = true } = {}) {
  const c = new Craft('Verifier Returner');
  const [pod] = c.setRoot('pod_acorn');
  let cur = pod, low = null;
  for (const t of ['tank_m400', 'eng_sparrow', 'dec_m', ...(ring ? ['probe_wisp'] : []), 'tank_m800', 'tank_m200', 'eng_goshawk']) {
    cur = c.attachStack(t, cur.id, 'bottom')[0];
    if (t === 'tank_m200') low = cur;
  }
  c.attachRadial('fin', low.id, low.pos.y, Math.PI / 4, 4);
  c.autoStage();
  return c;
}
const mom = vs => vs.reduce((s, v) => R.add(s, R.scale(A(v.vel), v.mass)), [0, 0, 0]);
const stateOf = v => [...A(v.pos), ...A(v.vel), v.q.x, v.q.y, v.q.z, v.q.w, v.mass];

/** In deep space: the separation shares out momentum and mass and makes a flyable booster. */
function separation(S) {
  const w = new World();
  const v = spawn(w, rocket(), 'helion', [2e11, 0, 0], [0, 30, 0]);
  let booster = null;
  w.on('decouple', d => { booster = d.debris; });
  v.ctrl.sas = false;
  run(w, 1, 0.5);
  const m0 = v.mass, p0 = mom([v]);
  // skip the first stage's ignition: fire stages until the stack splits
  for (let i = 0; i < 4 && !booster; i++) { v.ctrl.throttle = 0; w.stage(); }
  S.ok('the stack split in two', !!booster);
  if (!booster) return;
  S.check('mass of the two pieces = mass before', m0, v.mass + booster.mass, 1e-6, { unit: 'kg' });
  const p1 = mom([v, booster]);
  S.check('momentum of the two pieces = momentum before', 0, R.norm(R.sub(p1, p0)) / R.norm(p0), 1e-12, { max: true, note: 'relative' });
  S.ok('the piece with the guidance ring is a ship, and is named a booster', booster.type === 'ship' && / booster$/.test(booster.name), booster.name);
  S.ok('the same piece without a ring is debris', (() => {
    const w2 = new World(); const u = spawn(w2, rocket({ ring: false }), 'helion', [2e11, 0, 0], [0, 30, 0]);
    let d = null; w2.on('decouple', e => { d = e.debris; });
    for (let i = 0; i < 4 && !d; i++) { u.ctrl.throttle = 0; w2.stage(); }
    return d && d.type === 'debris';
  })());
}

/**
 * Over airless Pell, on a path that comes down: the upper stage burns away, and the booster left far behind is
 * compared with two-body motion from the reference, next to the same measure for the vessel being flown.
 */
function farKepler(S) {
  const pell = sys.byId.pell;
  const r0 = [pell.radius + 60000, 0, 0], v0 = [0, 0, -200];
  const w = new World();
  const v = spawn(w, rocket(), 'pell', r0, v0);
  let booster = null;
  w.on('decouple', d => { booster = d.debris; });
  for (let i = 0; i < 4 && !booster; i++) { v.ctrl.throttle = 0; w.stage(); }
  // the upper stage flies off under power; the booster coasts
  v.ctrl.sas = true; v.ctrl.throttle = 1;
  let guard = 0;
  while (booster.pos.distanceTo(v.pos) < LOAD_RANGE * 2 && guard++ < 20000) w.step(0.02);
  v.ctrl.throttle = 0;
  run(w, 1, 0.02);
  S.info('distance between the stages when the comparison starts', booster.pos.distanceTo(v.pos), 'm', 'the load range is 2,500 m');
  S.ok('the booster is under full physics (not on rails) out there', !booster.onRails && w.tracked.includes(booster));
  const T = 100;
  const b0 = { r: A(booster.pos), v: A(booster.vel) }, a0 = { r: A(v.pos), v: A(v.vel) };
  run(w, T, 0.02);
  const refB = R.keplerUV(b0.r, b0.v, pell.gm, T), refA = R.keplerUV(a0.r, a0.v, pell.gm, T);
  const errB = R.norm(R.sub(A(booster.pos), refB.r)), errA = R.norm(R.sub(A(v.pos), refA.r));
  S.ok('still under full physics at the end', !booster.onRails && !booster.dead);
  S.check(`booster far away: position after ${T} s vs two-body reference`, 0, errB, 1e-3, { unit: 'm', max: true });
  S.check(`vessel being flown: the same measure`, 0, errA, 1e-3, { unit: 'm', max: true });
  S.check('booster velocity vs two-body reference', 0, R.norm(R.sub(A(booster.vel), refB.v)), 1e-5, { unit: 'm/s', max: true });
  // energy and angular momentum of the far booster over the coast
  const E = s => R.dot(s.v, s.v) / 2 - pell.gm / R.norm(s.r);
  const e1 = { r: A(booster.pos), v: A(booster.vel) };
  S.check('booster specific energy over the coast', E(b0), E(e1), 1e-6, { rel: true, unit: 'J/kg' });
  S.check('booster angular momentum over the coast', R.norm(R.cross(b0.r, b0.v)), R.norm(R.cross(e1.r, e1.v)), 1e-7, { rel: true, unit: 'm^2/s' });
}

/** From the pad through the air: the same launch watched three ways gives the same flight. */
function watching(S) {
  const fly = watch => {
    const w = new World();
    const upper = w.launch(rocket(), { crew: ['Ada'] });
    let booster = null;
    w.on('decouple', d => { if (!booster) booster = d.debris; });
    upper.ctrl.throttle = 1;
    w.stage();
    const first = upper.engines.find(e => e.part.ignited).part;
    for (let i = 0; i < 20000 && !first.flameout; i++) w.step(0.02);
    w.stage();
    const rows = [];
    for (let i = 1; i <= 3000; i++) {
      if (watch === 'booster' && i === 1) w.switchTo(booster);
      if (watch === 'both' && i % 250 === 0) w.switchTo(w.active === upper ? booster : upper);
      w.step(0.02);
      if (i % 500 === 0) rows.push([...stateOf(upper), ...stateOf(booster)]);
    }
    return { rows, sep: booster.pos.distanceTo(upper.pos), alive: !upper.dead && !booster.dead };
  };
  const a = fly('upper'), b = fly('booster'), c = fly('both');
  S.ok('both vessels are still flying after 60 s in all three flights', a.alive && b.alive && c.alive);
  S.info('distance between them at the end', a.sep, 'm');
  const worst = other => {
    let m = 0;
    for (let k = 0; k < a.rows.length; k++) for (let j = 0; j < a.rows[k].length; j++) m = Math.max(m, Math.abs(a.rows[k][j] - other.rows[k][j]) / Math.max(1, Math.abs(a.rows[k][j])));
    return m;
  };
  S.check('watching the booster instead of the upper stage: largest difference in any state value', 0, worst(b), 1e-6, { max: true, note: 'relative; position, velocity, attitude and mass of both, six samples' });
  S.check('switching between them every 5 s: largest difference', 0, worst(c), 1e-6, { max: true, note: 'relative' });
}

export const groups = [
  { name: '9a. Separation: mass, momentum, and what the dropped stage becomes', fast: true, run: S => separation(S) },
  { name: '9b. A booster far from the vessel being flown vs two-body motion', fast: true, run: S => farKepler(S) },
  { name: '9c. The flight does not depend on which vessel is watched', fast: true, run: S => watching(S) },
];
