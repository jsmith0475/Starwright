# Would Rust (WebAssembly) make Starwright faster?

Short answer: **no, not where it is slow.** Measured on 2026-11-19, the JavaScript that Rust could replace is a
few percent of a frame. What costs time is (a) the graphics card filling pixels, (b) three.js handing draw calls to
the browser, and (c) a handful of one-off stalls (shader compilation, terrain built in one go at a scene cut,
large texture uploads). None of those gets faster in another language. They were addressed directly instead; see
"What was changed".

This file records the measurements so the question can be re-asked with numbers. Nothing was ported.

## How it was measured

- The game's own benchmark, `index.html?perf=1` (`js/ui/perfbench.js`): fixed scenes, fixed frame counts, a
  recorder (`js/perf.js`) that splits each frame's main-thread time into sim / scene / terrain / render / hud.
- Chromium's CPU profiler and the DevTools `Performance` domain in thread-tick mode (CPU time of the main thread,
  not wall time), per scene, through `tests/tools/perf_run.mjs`.
- `tests/tools/perf_split.mjs`: each section of a flight frame called in a loop in the page, fastest batch taken,
  the GPU process drained before each draw.
- `tests/tools/perf_kernels.mjs`: the pure number-crunching kernels in Node, CPU time, best of five.

The machine: a 4-core cloud VM with **no graphics card** (SwiftShader software rasteriser), shared with other
jobs (load average 15 to 27 during the runs). So:

- CPU-side numbers (JavaScript, draw calls, triangles, allocations, chunk counts) are real, and pessimistic: a
  current Mac runs the same JavaScript two to four times faster.
- GPU time cannot be measured here at all. A "high" frame takes 1 to 6 **seconds** in software. The frame times
  and fps columns below are meaningless for a real machine; they are kept only to show how completely the
  rasteriser dominates. A machine with a real graphics card has to supply the GPU column (see the last section).

## Where a frame goes

Full quality ("high": 4x MSAA HDR target, 2048 shadow map, bloom), 480 x 300 canvas, software GL, before any fix
(`tests/out/perf-base2.txt`, `perf-base-hq640.txt`):

| scene | draw calls | triangles | JS CPU / frame (thread ticks) | chunks built on main thread at arrival |
|---|---:|---:|---:|---:|
| Assembly, 39-part Farwind | 631 | 417 k | – | – |
| On the pad (Ember Twin) | 311 | 1.62 M | 9.5 ms | 266 |
| Ascent, 1 to 6 km | 286 | 1.53 M | 8.7 ms | 0 |
| Orbit, 85 km | 93 | 188 k | 5.4 ms | 162 |
| Map view | 6 | 24 k | 3.1 ms | 0 |
| Landing on Pell | 288 | 304 k | 6.5 ms | 154 |
| Plane over the base | 295 | 1.40 M | 9.3 ms | 314 |
| Re-entry | 70 | 164 k | 5.5 ms | 106 |
| Rover on Rusk | 284 | 522 k | 6.8 ms | 250 |
| Docking | 270 | 237 k | 5.9 ms | 130 |

The "JS CPU / frame" column is inflated by the test conditions: each frame took seconds, so the 5 Hz instrument
refresh, worker replies and texture streaming that normally spread over dozens of frames all landed in every
frame. Calling each section in a tight loop gives the steady-state cost (pad, after the fixes,
`tests/out/perf-split2.log`):

| section (pad, "high") | ms per frame, this VM |
|---|---:|
| physics and autopilot (`world.step`) | < 0.01 (0.027 in powered ascent) |
| scene update (matrices, particles, camera) | 0.05 |
| terrain LOD selection | 0.07 |
| HUD (DOM, already diff-gated) | 0.01 |
| navball | 0.10 |
| **three.js draw submission, 291 draw calls** | **3.50** (12.70 before the single-pass fix below) |
| **total main thread** | **3.7** |

Allocation in steady state: 6 to 30 kB per frame; no garbage-collection pause was seen inside a measured window
once textures had streamed in.

By file, CPU profile of the ascent (JavaScript only, before fixes): three.js 37 %, native GL/DOM calls 24 %,
`hud.js` 20 % (inflated, see above), GC 8.5 %, `js/core/vessel.js` **1.8 %**, terrain 1.2 %.

So of a 16.7 ms frame budget, on this slow VM:

- **simulation (the part Rust is good at): about 0.03 ms, 0.2 % of the budget.** An infinitely fast physics core
  would not move the frame rate.
- **three.js + WebGL calls: 3 to 4 ms.** This is proportional to draw calls. WebAssembly cannot call WebGL except
  through JavaScript, so a Rust renderer would make every one of those calls more expensive, not less.
- **everything else the main thread does: well under 1 ms.**
- **the rest is the GPU**, which this machine cannot measure and Rust cannot touch.

## The kernels Rust could speed up

`tests/out/perf-kernels-base.log` (Node 22, CPU time):

| kernel | cost | where it runs | when |
|---|---:|---|---|
| terrain chunk 40 x 40, Verda | 1.9 to 2.2 ms | worker pool | as the camera moves |
| terrain chunk 40 x 40, Pell (craters) | 2.5 to 5.8 ms | worker pool | as the camera moves |
| body map bake 2048 x 1024 | 3.3 to 3.5 s in total | worker pool, in rows | once per body per session |
| cloud map bake | 1.2 s | worker | once |
| `world.step`, 18-part rocket | 0.027 ms | main thread | every frame |
| `world.step`, 8 vessels on rails | 0.015 ms | main thread | every frame |
| `predictPatches` | 0.001 ms | main thread | on orbit change |
| `planHohmannToMoon` | 55 ms | main thread | one button press |
| `planInterplanetary` | 1130 ms | main thread | one button press |

Only the first four are heavy, and they are layered value noise: branch-light floating-point loops. A careful Rust
+ SIMD version would plausibly run them 1.5 to 3 times faster. What that would buy:

- terrain detail arriving a little sooner behind a fast camera (it already arrives off the main thread, so no
  frame is waiting for it), and map textures sharpening in about 1.5 s instead of 3.5 s once per body.
- **no change in frame rate**, and no change to the stalls listed below.

What it would cost: a build step in a project that has none (plain ES modules, open `index.html`), a second
implementation of the height function that the **physics** also evaluates on the main thread for ground contact.
The two must agree to the last bit or craft sink into or hover over the ground; that class of bug has been the
most expensive one in this project. JavaScript calling into WASM for single height samples would also pay a
call-boundary cost on the physics side.

**Verdict:** not worth it now. Revisit only if, on real hardware, the F3 overlay shows terrain chunks arriving
visibly late during fast low flight *and* the worker pool is saturated. Even then the first step is cheaper:
more workers, or chunk generation that reuses the parent's samples.

`planInterplanetary` freezing the page for about a second (less on a Mac) is a real defect, but the remedy is to
run the search in the existing worker pool or coarsen its first pass, not to change language. Not changed in this
round (it belongs to the planner code; reported).

## What actually hurts, and what was changed

1. **Pixels.** A 16-inch MacBook Pro canvas at devicePixelRatio 2 is 3456 x 2234 = 7.7 million pixels. "High" drew
   them into a half-float target with 4 samples each (about 250 MB of multisample storage), plus the terrain,
   atmosphere and cloud shaders per pixel, plus bloom. That is heavy for an integrated GPU and cannot be seen on
   this machine.
   - The drawing buffer is now capped at 3840 x 2160 pixels (`app.pixelRatio`), and the HDR target uses 2 samples
     instead of 4 when the pixel ratio is 1.5 or more (4 device pixels per CSS pixel already).
   - **Automatic quality** (`js/ui/governor.js`, setting `gfxAuto`, on by default, off in Settings): when the
     frame interval stays over budget for about a second it lowers render scale (1 → 0.85 → 0.72 → 0.6), then the
     shadow map, then multisampling, then bloom; it steps back up when there is headroom, with back-off.
2. **Shader compilation inside frames.** Opening the pad compiled 35 of its 42 shader programs inside drawn
   frames, and the ascent another 17 (ignition, plumes, staging): each one is a frame that waits for the compiler.
   `flightScene.prewarm` now compiles the scene's programs in the background before the first frame: 8 and 4
   remain (the navball, the post chain and effects created later). A/B: `tests/tools/perf_run.mjs --noprewarm`.
3. **Two-pass transparent materials.** Decals, heat glow and plumes were transparent and double-sided, which
   makes three.js draw each mesh twice and re-resolve its shader program on every draw: 28 program look-ups per
   frame on the pad. They are single-pass now. Pad draw submission: 12.7 → 3.5 ms on this VM; materials
   re-evaluated per frame 35 → 7.
4. **Texture swaps.** A finished body-map level uploaded colour, normal and cloud textures (8 MB each at full
   size) in one frame, and in the map several worlds finish together (5 uploads in one frame measured). They now
   go through one queue: one texture per frame over all bodies.
5. **Small per-frame costs.** `performance.memory` and a `classList.contains` on the HUD path were read every
   frame; removed.

Left as found, reported:

- **Terrain at a scene cut is built on the main thread**: 106 to 314 chunks, 0.3 to 1 s, when a flight opens or the
  camera jumps. It is hidden behind the loading curtain when a flight opens, but not on a camera jump (switching
  vessel, time warp arrival). The policy belongs to the ground-contact work (the craft must have ground under it
  on its first frame), so it was measured and not changed.
- The pad and plane scenes draw 1.4 to 1.6 million triangles a frame (terrain at 40 x 40 per chunk, drawn again
  into the shadow map). A discrete or Apple-silicon GPU does not mind; it is the first thing to lower if the Mac
  numbers show vertex load.
- The canvas itself is created with `antialias: true` although the flight scene renders into its own target: a
  multisampled backbuffer nobody uses in flight.
- `planInterplanetary` on the main thread (above).
- The assembly building has no shader pre-compile: 32 of its 34 programs are compiled inside drawn frames when
  it first opens (a one-off stutter on entry; the screen belongs to the builder work).

## What only a real GPU can answer

Run on a machine with a real graphics card, in Chrome:

1. `npm start`, then open `http://localhost:8642/?perf=1`. It flies the fixed scenes by itself (about three
   minutes), then shows a table. Press **Copy as text** and attach it to an issue. The table names the GPU, the canvas size and
   the pixel ratio by itself.
2. The same with `?perf=1&gov=1` (automatic quality left on): shows what level the governor settles at.
3. In normal play, **F3** (fn-F3 on a Mac keyboard) shows the live overlay; a screenshot of it at a moment that
   feels slow says whether the main thread or the GPU is the one behind.

Reading it: if `main` is a few milliseconds and `frame` is well over 16.7, the GPU is the limit and the governor
and the quality settings are the tools. If `main` is near `frame`, the column next to it (sim, scene, terr,
render, hud) says which code to look at, and this document should be revisited with those numbers.
