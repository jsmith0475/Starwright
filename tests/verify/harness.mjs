// Result table and game-side helpers for the verification suite.
// The checks compare the REAL game core (imported here) with tests/verify/ref.mjs (which imports none of it).
import { Vector3 } from '../../js/lib/three.module.min.js';
import { World } from '../../js/core/world.js';
import { Craft } from '../../js/core/craft.js';
import { SYSTEM } from '../../js/core/bodies.js';
import * as R from './ref.mjs';

export { World, SYSTEM, Vector3 };
export const V = a => new Vector3(a[0], a[1], a[2]);
export const A = R.arr;

/** Collects check rows: { group, name, expected, actual, error, tol, unit, status: PASS | FAIL | INFO, note }. */
export class Suite {
  constructor() { this.rows = []; this.group = ''; }
  /**
   * Record a check. `tol` is absolute unless opts.rel (then error = |actual - expected| / |expected|).
   * opts.unit: text after the numbers. opts.note: extra text. opts.max: `actual` only has to be <= tol (expected = 0).
   */
  check(name, expected, actual, tol, opts = {}) {
    let error = Math.abs(actual - expected);
    if (opts.rel) error = expected !== 0 ? error / Math.abs(expected) : Math.abs(actual);
    const pass = Number.isFinite(error) && error <= tol;
    this.rows.push({ group: this.group, name, expected, actual, error, tol, rel: !!opts.rel, unit: opts.unit || '', status: pass ? 'PASS' : 'FAIL', note: opts.note || '' });
    return pass;
  }
  /** A true/false check. */
  ok(name, cond, note = '') {
    this.rows.push({ group: this.group, name, expected: 'true', actual: String(!!cond), error: cond ? 0 : 1, tol: 0, rel: false, unit: '', status: cond ? 'PASS' : 'FAIL', note });
    return !!cond;
  }
  /** A number reported for information (model limits): never fails. */
  info(name, value, unit = '', note = '') {
    this.rows.push({ group: this.group, name, expected: '', actual: value, error: '', tol: '', rel: false, unit, status: 'INFO', note });
  }
  get failed() { return this.rows.filter(r => r.status === 'FAIL'); }
  get passed() { return this.rows.filter(r => r.status === 'PASS'); }
}

export function fmt(x) {
  if (typeof x === 'string') return x;
  if (x === undefined || x === null) return '';
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e7 || a < 1e-3) return x.toExponential(4);
  if (a >= 1000) return x.toFixed(1);
  return x.toPrecision(6);
}

export function printTable(rows, out = console.log) {
  const cols = ['status', 'name', 'expected', 'actual', 'error', 'tol', 'unit'];
  const head = { status: 'RESULT', name: 'CHECK', expected: 'EXPECTED', actual: 'ACTUAL', error: 'ERROR', tol: 'TOLERANCE', unit: 'UNIT' };
  let group = null;
  const cell = (r, c) => {
    if (c === 'error' || c === 'tol') return r[c] === '' ? '' : fmt(r[c]) + (r.rel ? ' rel' : '');
    return fmt(r[c]);
  };
  const w = {};
  for (const c of cols) w[c] = Math.min(c === 'name' ? 74 : 16, Math.max(head[c].length, ...rows.map(r => cell(r, c).length)));
  const line = r => cols.map(c => (typeof r === 'string' ? r : (r === head ? head[c] : cell(r, c))).padEnd(w[c]).slice(0, c === 'name' ? 200 : w[c] + 20)).join('  ');
  for (const r of rows) {
    if (r.group !== group) { group = r.group; out('\n== ' + group + ' =='); out(line(head)); }
    out(line(r) + (r.note ? '   # ' + r.note : ''));
  }
}

// ------------------------------------------------------------------------------------------ craft
/** pod + tank(s) + engine: a simple single-stage test ship. */
export function simpleShip({ tank = 'tank_m400', engine = 'eng_sparrow', pod = 'pod_acorn' } = {}) {
  const c = new Craft('Verifier');
  const [p] = c.setRoot(pod);
  const t = c.attachStack(tank, p.id, 'bottom')[0];
  c.attachStack(engine, t.id, 'bottom');
  c.autoStage();
  return c;
}
/** pod + tank + sparrow / separator / tank + kestrel: a two-stage test ship. */
export function twoStage() {
  const c = new Craft('Verifier 2');
  const [p] = c.setRoot('pod_acorn');
  const t1 = c.attachStack('tank_m200', p.id, 'bottom')[0];
  const e1 = c.attachStack('eng_sparrow', t1.id, 'bottom')[0];
  const d = c.attachStack('dec_m', e1.id, 'bottom')[0];
  const t2 = c.attachStack('tank_m800', d.id, 'bottom')[0];
  c.attachStack('eng_goshawk', t2.id, 'bottom');
  c.autoStage();
  return c;
}
export function capsule() {
  const c = new Craft('Capsule');
  c.setRoot('pod_acorn');
  c.autoStage();
  return c;
}

/** Spawn a vessel with a state given as plain arrays (relative to the game body with that id). */
export function spawn(w, craft, bodyId, r, v, opts = {}) {
  return w.spawn(craft, { crew: ['Ada'], body: SYSTEM.byId[bodyId], pos: V(r), vel: V(v), ...opts });
}

/** Step the world by `sim` seconds of simulated time at the current warp, in wall-clock slices of `slice` seconds. */
export function run(w, sim, slice = 1) {
  const end = w.ut + sim;
  let guard = 0;
  while (w.ut < end - 1e-9 && guard++ < 5e7) {
    const rate = w.rate;
    w.step(Math.min(slice, (end - w.ut) / rate));
  }
}

/** Game vessel state relative to the star, using the REFERENCE ephemeris for the body positions. */
export function globalState(eph, sys, v, t) {
  const b = eph.global(sys.byId[v.body.id], t);
  return { r: R.add(A(v.pos), b.r), v: R.add(A(v.vel), b.v) };
}
