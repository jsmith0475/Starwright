// Starwright — automatic quality governor: keeps the frame rate by trading picture quality, in a fixed order.
//
// Pure logic (no DOM, no three.js; tests/unit/perf.test.js drives it with made-up frame times). The flight scene
// owns one, feeds it every frame's interval and applies the level it answers with:
//
//   const gov = createGovernor({ budgetMs: 16.7 });
//   const changed = gov.tick(dtMs, { cpuMs, busy });     // once per drawn frame; true when gov.level changed
//   gov.state            { scale, shadow, msaa, bloom, detail, ao }   what to draw with right now
//                        (detail [realism pass]: vegetation levels to drop below the setting, js/render/flora.js vegLevel;
//                        the smaller render scale already draws fewer full trees, so this only steps in at 0.6)
//   gov.level            0 = everything the settings ask for … LEVELS.length − 1 = the floor
//   gov.enabled = false  → state returns to level 0 at once and tick() does nothing
//   gov.lock(n | null)   pin a level (benchmarks, previews)
//
// Order of sacrifice (what the eye misses least goes first):
//   1. render scale: 1 → 0.85 → 0.72 → 0.6 of the device pixels (on a retina display 0.72 is still 1.44 device
//      pixels per CSS pixel: sharper than a non-retina screen at full scale)
//   2. shadows: half-size shadow map, then no shadow pass at all
//   3. post: multisampling off, then bloom off
// Ambient occlusion (js/render/ao.js) is not a step of its own: it is on for the first three levels and goes with
// the last cut in render scale, where its half-resolution pass is too coarse to be worth its cost.
// It steps down when the smoothed frame interval has been over budget for about a second, and tries one step up
// after a quiet spell; if that step up does not hold, the next try waits twice as long (so a machine that cannot
// do better is not asked every few seconds). A slow frame caused by the game's own main-thread work (cpuMs close
// to the whole interval) is not the GPU's fault, and lowering the picture quality would not help: it is ignored.
// So are isolated hitches, hidden tabs, and frames drawn while the scene is still loading (`busy`).

export const LEVELS = [
  { scale: 1, shadow: 1, msaa: true, bloom: true, detail: 0, ao: true },
  { scale: 0.85, shadow: 1, msaa: true, bloom: true, detail: 0, ao: true },
  { scale: 0.72, shadow: 1, msaa: true, bloom: true, detail: 0, ao: true },
  { scale: 0.6, shadow: 1, msaa: true, bloom: true, detail: 1, ao: false },
  { scale: 0.6, shadow: 0.5, msaa: true, bloom: true, detail: 1, ao: false },
  { scale: 0.6, shadow: 0, msaa: true, bloom: true, detail: 1, ao: false },
  { scale: 0.6, shadow: 0, msaa: false, bloom: true, detail: 2, ao: false },
  { scale: 0.6, shadow: 0, msaa: false, bloom: false, detail: 2, ao: false },
];

export function createGovernor({ budgetMs = 16.7, levels = LEVELS } = {}) {
  const OVER = budgetMs * 1.2;          // 20 ms at a 60 Hz budget: one dropped frame in five, sustained
  const UNDER = budgetMs * 1.06;        // "on budget": vsync jitter included
  const SETTLE = 45;                    // frames ignored after a change (new render targets, shader variants)
  const DOWN_MS = 900, UP_MS_MIN = 6000, UP_MS_MAX = 120000;
  let level = 0, locked = false, enabled = true;
  let ema = 0, settle = SETTLE, overMs = 0, calmMs = 0, upWait = UP_MS_MIN, probing = 0, lastUpFrom = -1;
  const g = {
    levels,
    get level() { return level; },
    get state() { return levels[enabled || locked ? level : 0]; },
    get enabled() { return enabled; },
    set enabled(v) { v = !!v; if (v === enabled) return; enabled = v; if (!locked) level = 0; g.reset(); },
    get locked() { return locked; },
    get smoothed() { return ema; },
    /** times the governor changed the level since it was made (for the overlay and the tests) */
    changes: 0,
    lock(n) { locked = n != null; if (locked) level = Math.max(0, Math.min(levels.length - 1, n | 0)); g.reset(); },
    reset() { ema = 0; settle = SETTLE; overMs = 0; calmMs = 0; probing = 0; },
    /**
     * @param dtMs   time since the previous frame started (ms)
     * @param cpuMs  main-thread time the game itself spent on the previous frame (ms), if known
     * @param busy   true while the scene is loading (terrain chunks, texture bakes arriving)
     * @returns true when the level changed (the caller re-applies gov.state)
     */
    tick(dtMs, { cpuMs = 0, busy = false, hidden = false } = {}) {
      if (!enabled || locked) return false;
      if (hidden || !(dtMs > 0) || dtMs > 400) { settle = Math.max(settle, 10); return false; }     // tab switch, breakpoint, load stall
      if (settle > 0) { settle--; ema = 0; return false; }
      // one slow frame is a hitch, not a trend: it enters the average clamped
      const x = ema ? Math.min(dtMs, ema * 2.5) : dtMs;
      ema = ema ? ema + (x - ema) * 0.08 : x;
      const mainBound = cpuMs > 0 && cpuMs > dtMs * 0.75;          // the main thread, not the GPU, set this frame's pace
      if (ema > OVER && !busy && !mainBound) {
        overMs += dtMs; calmMs = 0;
        if (overMs >= DOWN_MS && level < levels.length - 1) {
          // a step up that did not hold: wait longer before the next try
          if (probing > 0 && lastUpFrom === level + 1) upWait = Math.min(UP_MS_MAX, upWait * 2);
          // far over budget: do not creep down one notch a second
          level = Math.min(levels.length - 1, level + (ema > budgetMs * 2.2 ? 2 : 1));
          probing = 0; overMs = 0; settle = SETTLE; ema = 0; g.changes++;
          return true;
        }
      } else if (ema <= UNDER) {
        overMs = 0; calmMs += dtMs;
        if (probing > 0) { probing -= dtMs; if (probing <= 0) upWait = Math.max(UP_MS_MIN, upWait * 0.5); }   // the step up held
        if (level > 0 && calmMs >= upWait) {
          lastUpFrom = level; level--; calmMs = 0; probing = 4000; settle = SETTLE; ema = 0; g.changes++;
          return true;
        }
      } else { overMs = Math.max(0, overMs - dtMs * 0.5); calmMs = 0; }
      return false;
    },
  };
  return g;
}
