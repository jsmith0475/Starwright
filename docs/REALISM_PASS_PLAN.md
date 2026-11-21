# Realism Pass 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make Starwright's 3D picture more physically plausible (occlusion, real reflections, terrain, rocks, water) while staying asset-free.

**Architecture:** The flight scene already draws two scenes into one multisampled HDR target and finishes with `js/render/post.js`. This pass gives that target a depth texture, adds screen-space passes that read it, replaces the fixed environment map with a small live cube probe, and rewrites parts of the terrain and ocean fragment shaders. Nothing in `js/core` changes.

**Tech Stack:** JavaScript ES modules, three.js r170 (vendored), WebGL 2, GLSL ES 3 through three's ShaderMaterial, Node test runner, Playwright (Chromium, software GL).

**Spec:** `docs/REALISM_PASS_SPEC.md`

## Global Constraints

- Procedural art only: no image, model or HDR files; no network at run time; no build step.
- three.js stays r170 at `js/lib/three.module.min.js`.
- `js/core` is not edited.
- Custom shaders include three's `tonemapping_fragment`, `colorspace_fragment` and logdepthbuf chunks.
- Logarithmic depth is on: linear view depth from a depth sample `d` is `exp2(d * log2(far + 1)) - 1`.
- `npm test` stays green; no test weakened or skipped.
- One shadow cascade, at most 2048.
- No `git` commands that change the tree. Snapshot with `tar` into `.build/sw-<name>-<HHMMSS>.tar.gz` before each task.
- Never call `renderer.setViewport()` while a render target is bound (it takes CSS pixels); set `rt.viewport`.
- Judge pictures from `tests/e2e/preview_flight.mjs` captures in `tests/out/`, looked at, not assumed.

## Status (2026-11-21)

All tasks are done and checked on the software rasteriser. Nothing has been run on a real GPU yet: frame rate and the
final look there are the owner's check (last step of Task 7).

| Check | Result |
|---|---|
| `npm test` | 350 pass, 0 fail |
| `ao_probe.mjs` (4 views) | all pass |
| `env_probe.mjs` (pad, moon) | all pass; probe looking down matches a plain camera within 4 % |
| `tiling_probe.mjs` (Pell, Rusk, 4 heights) | all pass; strongest repeat 0.13 (limit 0.2; was 0.32 on Pell from 300 m) |
| `realism_probe.mjs` | "high" within budget (flight-pad 382, flight-low 401, flight-far 432 of 480 draw calls). Medium and low have three rows over budget, with the same numbers on the untouched snapshot |
| `builder.mjs` | 211 of 211 |
| `shell.mjs` | 325 checks, 21 problems, all aborted script requests; the same 21 on the untouched snapshot |
| `flight.mjs` | 121 checks, 10 problems, all aborted script requests (the untouched snapshot has 11) |
| `perf.mjs` | 94 checks, 8 problems, the same 8 on the untouched snapshot |

Not run: the long suites (play-through, contact, docking, interplanetary, missions, scenarios, science, mapview, demo).

What changed against the plan as first written:
- Tasks 3 to 5 found more already in place than the plan assumed (slope rock, a fine grain layer, Fresnel, glitter,
  foam, rock shapes with contact shade). Each task was cut down to what was measurably or visibly missing:
  the repeat of the relief tile (Task 3), boulder shadows, burial and proportions (Task 4), the sea bed seen
  through water, surf width, wave shading and the far shoreline (Task 5).
- Task 6 does not use the flight composite. Drawing the hangar through it changed colours (materials that opt out
  of tone mapping, the sky through the door). The chain gained a display mode instead (`createPostChain(renderer,
  { display: true })`), which leaves the picture as it was and adds only the occlusion. At the space centre's
  overview distance the effect is close to invisible.
- A regression found and fixed on the way: the new Settings row made Playwright's click scroll `#ui` (a hidden
  box can still be scrolled), sliding the dialog off the top. `#ui` is now `overflow: clip`.
- The reflection probe draws one cube face of the far scene on a refresh frame (about 150 draw calls on the pad, six
  frames in a row, at most every 20 s when nothing changes). `realism_probe.mjs` measures a frame between refreshes.

Left for later:
- Shallow sea from several kilometres up: sandy bed inside the fine-terrain radius, baked blue map outside (a stepped
  ring). It was there before this pass.
- Ambient occlusion strength in flight is subtle by design; decide on a real display whether to raise
  `intensity` in `js/render/ao.js`.
- Playwright is not installed on this Mac. A copy matching the cached Chromium (playwright 1.64.1, revision 1248) in a
  temporary folder was used through `NODE_PATH`; install it properly.

Things learned, for whoever does the next screen-space pass:
- three r170 does resolve a multisampled target's depth into a `DepthTexture`; no pre-pass is needed.
- A half-resolution pass sits exactly on the border between two depth texels. Read depth with `texelFetch` and
  rebuild positions from the centre of the texel that was read (`aoSnap` in `js/render/ao.js`).
- Looking along the ground (camera pitch under about 0.15 rad) a screen-space pass finds almost no contact shade.
- Swapping the parts' environment map while `renderer.compileAsync` is pending throws inside three ("reading
  'isReady'"). The probe's first refresh therefore runs at the start of `prewarm()`.
- three resets `renderer.info` after the shadow pass, so its automatic counts never include shadows.

## File map

| File | Status | Responsibility |
|---|---|---|
| `js/render/ao.js` | new | Occlusion pass and its blur: depth in, one-channel occlusion texture out |
| `js/render/post.js` | modify | Scene target gains a depth texture; runs `ao.js`; composite multiplies occlusion in |
| `js/render/envprobe.js` | new | Live cube probe of the far scene, incremental faces, PMREM filter |
| `js/render/worldshaders.js` | modify | Terrain anti-tiling, material blending, micro normals; ocean waves, Fresnel, foam |
| `js/render/scatter.js` | modify | Rock shapes, burial, contact darkening, ground-matched colour |
| `js/ui/flightscene.js` | modify | Passes the camera to the post chain; owns the probe; quality and governor wiring |
| `js/ui/governor.js` | modify | `ao` flag on each level |
| `js/ui/hub.js`, `js/ui/flight.js` | modify | One settings row each: "Ambient occlusion" |
| `js/ui/builder.js`, `js/ui/baseview.js` | modify (Task 6) | Draw through the post chain in display mode (occlusion only) |
| `tests/e2e/env_probe.mjs`, `tiling_probe.mjs`, `preview_water.mjs` | new | Checks for R2 and R3; captures for R5 |
| `css/style.css` | modify | `#ui` clips instead of hiding its overflow |
| `tests/unit/perf.test.js` | modify | Governor: `ao` goes off at level 3 and never before |
| `tests/e2e/ao_probe.mjs` | new | Renders flight views with AO on and off; checks the pixel rules of R1 |
| `docs/ARCHITECTURE.md`, `docs/TECH_STACK.md` | modify (Task 7) | "Additions (round 5)"; correct the stale line count and worker claim |

## Tasks

### Task 0: Baseline
**Files:** none changed in the project.
- [x] Snapshot: `tar --exclude=./.build --exclude=./tests/out --exclude=./videos -czf .build/sw-pre-realism3-<HHMMSS>.tar.gz .`
- [x] `npm test` and record the count (349 pass on 2026-11-20).
- [x] Playwright available to `tests/e2e/server.mjs loadPlaywright()` through `NODE_PATH`.
- [x] `node tests/e2e/preview_flight.mjs pad,liftoff,orbit-day,moon,eva,rover,rover-pell,arrival`; copy the 1440x900 captures to `tests/out/r3-before/`.

### Task 1: Ambient occlusion in flight (R1)
**Files:** create `js/render/ao.js`, `tests/e2e/ao_probe.mjs`; modify `js/render/post.js`, `js/ui/flightscene.js`, `js/ui/governor.js`, `js/ui/hub.js`, `js/ui/flight.js`, `tests/unit/perf.test.js`.

**Interfaces**
- Produces `createAO(renderer) -> { target, render({ depthTexture, camera, width, height, pass }), params: { radius, intensity, maxDist }, setSize(w, h), dispose() }`. `target.texture` holds occlusion in red, 1 = open.
- `post.js`: `post.params.ao` (0 = off, default 0), `post.end({ sunUv, sunVisible, dt, camera })`. `post.depthSupported` is false when the multisampled target cannot resolve depth to a texture; AO then stays off.
- `governor.js`: every level has `ao: boolean`; true for levels 0 to 2, false from level 3. Level count and order unchanged.
- `flightscene.js`: `QUALITY.high.ao = true`; `post.params.ao = quality.ao && gs.ao && s.gfxAO !== false ? 1 : 0`.

**Steps**
- [x] Unit test first (`tests/unit/perf.test.js`): `LEVELS.slice(0, 3)` all have `ao === true`, the rest `false`, and `LEVELS.length === 8`. Run `npm test`: fails.
- [x] Add `ao` to `LEVELS`. Run `npm test`: passes.
- [x] Prove the depth path before writing the effect: give the scene target a `DepthTexture`, draw it as greyscale linear depth from the composite behind `?aodebug=depth`, capture the pad. If three r170 does not resolve multisampled depth into the texture, set `depthSupported = false` and stop here to choose between a manual `blitFramebuffer` and a depth pre-pass.
- [x] Write `ao.js`: half-resolution pass, 12 spiral taps, radius in metres projected through the camera, normal from depth derivatives, range check, 4x4 rotation pattern; then one depth-aware 4x4 blur.
- [x] Composite: `col *= mix(1.0, ao, k)` where `k` fades to 0 for sky (depth at far), beyond `maxDist`, and for luminance above 4.0.
- [x] Wire quality, governor and the `gfxAO` setting; add the two settings rows.
- [x] `tests/e2e/ao_probe.mjs`: pad view with AO off and on. Checks: sky pixels identical; mean luminance of a ground patch beside the pad drops by less than 4 %; a patch in the crease under the vessel drops by more than 8 %; no console errors.
- [x] Captures: `preview_flight.mjs pad,moon,rover,orbit-day`, compare with `tests/out/r3-before/`. Tune radius and intensity on what is seen.
- [x] `realism_probe.mjs` budgets: expect +2 draw calls per frame at "high".
- [x] Snapshot.

### Task 2: Live reflections (R2)
**Files:** create `js/render/envprobe.js`; modify `js/ui/flightscene.js` (replaces `makeEnvironment` at "high"), `js/render/parts/materials.js` (no change to the API; `setPartEnvironment` is called with the probe's texture).

**Interfaces**
- Produces `createEnvProbe(renderer, { size = 64 }) -> { texture, update(scene, position, { force }) -> boolean, dispose() }`. `update` renders at most one cube face per call and returns true on the frame the filtered texture changed.
- Consumes `near.environment`, `PM.setPartEnvironment(texture, intensity)`.

**Steps**
- [x] Capture `orbit-day`, `moon`, `rover`, `pad` close on a chrome part as the "before".
- [x] Probe renders the far scene only (sky, sun disc, terrain, globes), layers set so the near scene is excluded.
- [x] One face per frame; PMREM `fromCubemap` when the sixth lands or when the sun direction has moved 2 degrees or altitude has changed by 20 %.
- [x] Check: mean colour of the probe's down face is within 15 % of the terrain colour under the vessel on Pell and Rusk.
- [x] Captures and comparison; budgets (+1 scene-face render on refresh frames only).

### Task 3: Terrain shading (R3)
**Files:** modify `js/render/worldshaders.js` (`TERRAIN_FS`, `detailTexture`), `js/render/terrain.js` (uniforms only), `js/render/worldstyle.js` (per-body material sets).
- [x] Before captures at 2 m, 60 m, 1 km and 20 km on Pell, Rusk and Verda (`preview_worlds.mjs`).
- [x] Anti-tiling: sample the detail texture twice with hashed per-cell offsets and rotations, blended by a low-frequency mask, at each of the four `PERIODS`.
- [x] Slope and height blending between two material sets per body (flat, steep) from `worldstyle.js`.
- [x] Micro normal layer fading out beyond 30 m.
- [x] Check: autocorrelation of a 512 px ground crop at the detail period drops below 0.2 (it is measured first, on the "before").
- [x] `tests/unit/terrain_focus.test.js` and `ground_contact.test.js` still pass (shading only).

### Task 4: Rocks and scatter (R4)
**Files:** modify `js/render/scatter.js`.
- [x] Three or four rock shapes from displaced icospheres; random non-uniform scale and yaw.
- [x] Sink each instance 15 to 35 % into the ground; vertex colour darkens towards the base.
- [x] Instance colour drawn from the ground colour at the instance, darkened 10 to 25 %.
- [x] Triangle budget of `realism_probe.mjs` holds.

### Task 5: Water (R5)
**Files:** modify `js/render/worldshaders.js` (ocean part), `js/render/globe.js` (uniforms).
- [x] Two scrolling normal layers from the detail texture's gradient channels, fading with distance to stop moire.
- [x] Schlick Fresnel against the scattering model's sky colour; sun glitter from the perturbed normal.
- [x] Depth colour and foam from terrain height at the fragment (the ocean shader already has the body maps).
- [x] Captures: pad looking east, liftoff at 1 km, orbit-day.

### Task 6: Hangar and space centre (R6)
**Files:** modify `js/ui/builder.js`, `js/ui/baseview.js`; `js/render/post.js` only if its API needs widening.
- [x] Both views draw through `createPostChain` with `params.ao = 1`, bloom and lens as they are today.
- [x] `tests/e2e/builder.mjs` and `shell.mjs` pass; `preview_builder.mjs` and `preview_base.mjs` compared.

### Task 7: Hand-back
- [x] `docs/ARCHITECTURE.md`: "Additions (round 5: realism pass 3)".
- [x] `docs/TECH_STACK.md`: correct the line count and the "no Web Workers" line.
- [x] Before/after contact sheet; full `npm test`, `realism_probe.mjs`, `perf.mjs`.
- [ ] Owner checks frame rate on the Mac's GPU with F3.
