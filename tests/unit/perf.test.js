// The frame-time recorder (js/perf.js) and the automatic quality governor (js/ui/governor.js): pure logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { perf } from '../../js/perf.js';
import { createGovernor, LEVELS } from '../../js/ui/governor.js';

// a clock the tests move by hand: the recorder's arithmetic is checked exactly, whatever the machine is doing
let clock = 0;
const realNow = performance.now;
function fakeClock(fn) { clock = 1000; performance.now = () => clock; try { fn(); } finally { performance.now = realNow; } }
const spin = ms => { clock += ms; };
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} ≈ ${b}`);

test('perf: off by default and then records nothing', () => {
  assert.equal(perf.on, false);
  perf.frameBegin(0); perf.begin('sim'); perf.end(); perf.count('x'); perf.frameEnd();
  assert.equal(perf.total, 0);
  assert.equal(perf.summary().frames, 0);
});

test('perf: nested sections get exclusive time and the buckets add up to the frame', () => fakeClock(() => {
  perf.enable(true);
  try {
    for (let i = 0; i < 6; i++) {
      perf.frameBegin(clock);
      spin(0.5);
      perf.begin('scene'); spin(3);
      perf.begin('terrain'); spin(4); perf.end();
      spin(1);
      perf.end();
      perf.begin('render'); spin(2); perf.end();
      perf.count('chunksFromWorkers', 2);
      perf.frameEnd();
      spin(6.2);                                                   // waiting for the next refresh
    }
    const s = perf.summary();
    assert.equal(s.frames, 5, 'the first frame has no interval and is left out');
    near(s.scene, 4, 'scene excludes the terrain inside it');
    near(s.terrain, 4, 'terrain');
    near(s.render, 2, 'render');
    near(s.other, 0.5, 'unmarked time in the frame callback');
    near(s.cpu.avg, 10.5, 'main-thread total');
    near(s.sim + s.scene + s.terrain + s.render + s.hud + s.other, s.cpu.avg, 'the buckets add up to the total');
    near(s.dt.avg, 16.7, 'frame interval');
    assert.equal(s.counters.chunksFromWorkers, 10);
  } finally { perf.enable(false); }
}));

test('perf: work marked between frames (worker replies) is counted once, as async', () => fakeClock(() => {
  perf.enable(true);
  try {
    perf.frameBegin(clock); perf.frameEnd();
    spin(3);
    perf.begin('terrain'); spin(5); perf.end();                    // a worker reply lands between two frames
    spin(3);
    perf.frameBegin(clock); perf.begin('render'); spin(2); perf.end(); spin(0.25); perf.frameEnd();
    const f = perf.last(1)[0];
    near(f.terrain, 5, 'terrain');
    near(f.async, 5, 'async');
    near(f.render, 2, 'render');
    near(f.other, 0.25, 'the async work is not double counted as "other"');
    near(f.cpu, 7.25, 'and it is part of the main-thread total');
  } finally { perf.enable(false); }
}));

test('perf: long frames and hitches are counted from the frame interval', () => {
  perf.enable(true);
  try {
    const realNow = performance.now;
    let t = 1000;
    performance.now = () => t;
    try {
      for (let i = 0; i < 100; i++) { perf.frameBegin(t); t += 2; perf.frameEnd(); t += (i === 50 ? 80 : i % 10 === 0 ? 38 : 14.7); }
    } finally { performance.now = realNow; }
    const s = perf.summary();
    assert.equal(s.frames, 99);
    assert.equal(s.long50, 1);
    assert.equal(s.long33, 10);
    assert.ok(Math.abs(s.worst - 82) < 0.01);
    assert.ok(Math.abs(s.dt.p50 - 16.7) < 0.01);
    assert.equal(s.hitches, 1, 'a hitch is a frame over 2.5x the median: the 82 ms one, not the ten 40 ms ones');
  } finally { perf.enable(false); }
});

// ---------------------------------------------------------------------------------------------- governor
const run = (g, ms, dt, opts) => { let changed = 0; for (let t = 0; t < ms; t += dt) if (g.tick(dt, opts)) changed++; return changed; };

test('governor: holds full quality while frames are on budget', () => {
  const g = createGovernor();
  assert.equal(run(g, 60000, 16.7), 0);
  assert.equal(g.level, 0);
  assert.deepEqual(g.state, LEVELS[0]);
  // 120 Hz display, and a game running at a steady 55 fps: both fine
  run(g, 20000, 8.3); run(g, 20000, 18.2);
  assert.equal(g.level, 0);
});

test('governor: over budget → render scale first, then shadows, then post; and it settles where the budget is met', () => {
  const g = createGovernor();
  const order = [];
  let last = g.level;
  // a GPU that is fill-bound: frame time follows the pixel count (28 ms at full scale), shadows cost 2 ms
  const cost = s => 4 + 24 * s.scale * s.scale + 2 * s.shadow;
  for (let t = 0; t < 120000;) { const dt = Math.max(16.7, cost(g.state)); t += dt; g.tick(dt); if (g.level !== last) { order.push(g.level); last = g.level; } }
  assert.ok(g.level >= 1, 'it stepped down');
  assert.ok(Math.max(16.7, cost(g.state)) <= 20, 'and now meets the budget: ' + cost(g.state).toFixed(1) + ' ms at level ' + g.level);
  assert.equal(g.state.shadow, 1, 'resolution was enough: the shadows were not touched');
  assert.equal(g.state.msaa, true);
  // the sacrifice order in the level table itself
  for (let i = 1; i < LEVELS.length; i++) {
    const a = LEVELS[i - 1], b = LEVELS[i];
    assert.ok(b.scale <= a.scale && b.shadow <= a.shadow && (a.msaa || !b.msaa) && (a.bloom || !b.bloom), 'levels only ever take away');
    if (b.shadow < a.shadow) assert.equal(b.scale, LEVELS[3].scale, 'shadows go only after the render scale is at its floor');
    if (!b.msaa) assert.equal(b.shadow, 0, 'post goes only after the shadows are off');
  }
});

test('governor: a hopeless GPU reaches the floor quickly and stays there without thrashing', () => {
  const g = createGovernor();
  run(g, 30000, 70);
  assert.equal(g.level, LEVELS.length - 1);
  const before = g.changes;
  run(g, 120000, 70);
  assert.equal(g.changes, before, 'no more changes once at the floor');
});

test('governor: climbs back when there is headroom, and backs off when the step up does not hold', () => {
  const g = createGovernor();
  run(g, 8000, 30);
  const low = g.level;
  assert.ok(low >= 1);
  run(g, 90000, 16.7);                       // the heavy scene is over
  assert.equal(g.level, 0, 'back at full quality');
  // a machine that can only just hold level 1: every step up fails; the tries get rarer
  const h = createGovernor();
  let ups = 0, last = 0;
  const ups1 = () => { ups = 0; for (let t = 0; t < 300000;) { const dt = h.level === 0 ? 24 : 16.7; t += dt; h.tick(dt); if (h.level < last) ups++; last = h.level; } return ups; };
  const first = ups1(), second = ups1();
  assert.ok(first >= 1 && first <= 8, 'tries in the first five minutes: ' + first);
  assert.ok(second <= 3, 'and fewer later (back-off): ' + second);
  assert.equal(h.level <= 1, true);
});

test('governor: ignores hitches, loading, hidden tabs and frames the main thread itself made slow', () => {
  const g = createGovernor();
  for (let i = 0; i < 3000; i++) g.tick(i % 40 === 0 ? 120 : 16.7);        // a 120 ms hitch every 40 frames
  assert.equal(g.level, 0, 'isolated hitches');
  run(g, 20000, 40, { busy: true });
  assert.equal(g.level, 0, 'slow frames while terrain streams in');
  run(g, 20000, 40, { cpuMs: 36 });
  assert.equal(g.level, 0, 'slow frames that are the main thread\'s own doing');
  run(g, 20000, 40, { hidden: true });
  assert.equal(g.level, 0, 'hidden tab');
  for (let i = 0; i < 50; i++) g.tick(5000);
  assert.equal(g.level, 0, 'stalls');
  run(g, 5000, 40, { cpuMs: 6 });
  assert.ok(g.level > 0, 'the same slow frames with an idle main thread do count');
});

test('governor: off and lock', () => {
  const g = createGovernor();
  run(g, 10000, 40);
  assert.ok(g.level > 0);
  g.enabled = false;
  assert.deepEqual(g.state, LEVELS[0], 'turned off: full quality at once');
  assert.equal(run(g, 10000, 40), 0);
  g.enabled = true;
  g.lock(2);
  assert.equal(g.level, 2);
  assert.equal(run(g, 10000, 40), 0, 'a locked level does not move');
  assert.deepEqual(g.state, LEVELS[2]);
  g.lock(null);
  run(g, 10000, 40);
  assert.ok(g.level > 2);
});

test('perf: shader programs count against the frame that compiled them, not when they were pre-compiled between frames', () => fakeClock(() => {
  const programs = [];
  const renderer = { info: { autoReset: true, programs, render: { calls: 0, triangles: 0, lines: 0, points: 0 }, reset() {} } };
  const before = perf.renderer;
  perf.renderer = renderer;
  perf.enable(true);
  try {
    const frame = inFrame => { perf.frameBegin(clock); for (let i = 0; i < inFrame; i++) programs.push({}); spin(5); perf.frameEnd(); spin(11); };
    frame(0);
    frame(3);                                   // three programs first used while drawing: a hitch
    for (let i = 0; i < 40; i++) programs.push({});      // flightscene.prewarm: compiled while no frame is waiting
    frame(0);
    frame(1);
    const fs = perf.last(3);
    assert.deepEqual(fs.map(f => f.programs), [3, 0, 1]);
    assert.equal(perf.summary(3).programs, 4);
  } finally { perf.enable(false); perf.renderer = before; }
}));

test('governor: ambient occlusion is kept for the first three levels and dropped before shadows', () => {
  assert.equal(LEVELS.length, 8, 'the level count is part of the contract with tests/e2e/perf.mjs');
  LEVELS.forEach((l, i) => assert.equal(l.ao, i < 3, 'level ' + i));
  const firstShadowCut = LEVELS.findIndex(l => l.shadow < 1), firstAoCut = LEVELS.findIndex(l => !l.ao);
  assert.ok(firstAoCut > 0 && firstAoCut < firstShadowCut, 'occlusion goes before shadows');
});
