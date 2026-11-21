# Realism pass 3: specification

Date: 2026-11-20. Read `docs/SECOND_PASS.md` (hard rules, renderer contract) first; this file adds to it.
The task list is in `docs/REALISM_PASS_PLAN.md`.

## Goal

Move the flight, hangar and space-centre pictures from "clean stylised" towards "grounded and physically
plausible" without giving up what makes Starwright easy to share: no asset files, no build step, about 1.2 MB.

## Decisions already made

- The asset-free rule stays. Everything is still made in code at load.
- Order of work: ambient occlusion, live reflections, terrain shading, rock grounding, water.
- Not in this pass: scanned textures or an HDR sky file, volumetric clouds, authored models, temporal
  anti-aliasing, WebGPU. Each is listed under "Later" with the reason.

## Constraints (copied from the project's own rules)

- Original, procedural art only; no network at run time; plain ES modules; three.js r170 vendored.
- `js/core` stays pure. Nothing in this pass touches it.
- Renderer contract: sRGB output, ACES tone mapping, PCF soft shadows, logarithmic depth. Custom shaders include
  three's tonemapping, colorspace and logdepthbuf chunks.
- `npm test` stays green (349 tests on 2026-11-20). No test is weakened or skipped.
- 60 fps on a recent Mac laptop GPU at "high". One shadow cascade, at most 2048.
- Draw-call and triangle budgets of `tests/e2e/realism_probe.mjs` and `tests/e2e/perf.mjs` hold. A pass may
  raise a budget only by the fixed number of full-screen passes it adds, and the change is written down here.
- No `git` commands that change the tree. Snapshots go to `.build/sw-*.tar.gz` as before.

## Requirements

Each one has a check that a person can run and a picture to compare.

### R1 Ambient occlusion (flight)
- Creases and contact areas darken: under a landed vessel, between tanks and boosters, at the foot of pad
  structures, rocks on the ground.
- Sky, stars, far globes and anything beyond 400 m are untouched. Emissive and very bright pixels (plumes, lamps,
  the sun's glare) are not darkened.
- No haloes round the vessel against the sky, no banding on flat ground, no shimmer when the camera is still.
- On at "high" only. New setting `gfxAO` (default on) in Settings and the in-flight graphics menu. The governor
  switches it off at level 3, before it touches shadows.
- Cost: two full-screen passes at half resolution. No second scene render.

### R2 Reflections from the real scene
- Metal and glass on vessels reflect the sky, sun, horizon and ground of the body they are at: blue over Verda,
  grey regolith on Pell, orange on Rusk, black with one sun in deep space.
- A small cube map (64 px faces) of the far scene, refreshed one face at a time and re-filtered when all six are
  new or the lighting has changed. Never more than one extra face render per frame.
- Falls back to today's fixed gradient when float render targets are missing or quality is below "high".

### R3 Terrain shading
- No visible repeat of the detail texture at any height from 2 m to 20 km on Pell, Rusk and Verda.
- Material follows the ground: slope (rock on steep faces, dust or soil on flats), height and the body's style.
- Close-up relief: a micro-normal layer that holds up at rover-camera height.
- Physics is unaffected: `body.terrainHeight` is not changed, only shading.

### R4 Rocks and scatter
- Scattered rocks sit in the ground (base buried, contact darkening), take the ground's colour family, and vary
  in size and shape so they do not read as dark blobs.

### R5 Water
- Wave normals that move, a Fresnel sky reflection, a sun glitter path that breaks up, colour by depth near the
  shore, and a foam line where the sea meets land.
- Reads correctly from the pad (2 m), from 1 km and from orbit, with no moire at grazing angles.

### R6 Hangar and space centre
- The same occlusion pass in the assembly building and the space-centre view, through a shared post chain.

## Quality tiers

| Tier | AO | Live reflections | Terrain / water shading |
|---|---|---|---|
| high | on | on | full |
| medium | off | off | full, fewer texture samples |
| low, soft | off | off | as today |

## Verification

- `npm test` after every task.
- `node tests/e2e/preview_flight.mjs <names>` before and after each task, same names, compared side by side.
  Shots used: pad, liftoff, orbit-day, moon, eva, rover, rover-pell, arrival.
- `node tests/e2e/realism_probe.mjs` for draw-call and triangle budgets.
- `node tests/e2e/perf.mjs` once per task that adds a pass.
- The headless browser draws with a software rasteriser. Frame rate on a real GPU cannot be measured there; the
  owner checks it on the Mac with the F3 overlay after each task that adds a pass.

## Later (not in this pass)

- Scanned texture sets and an HDR sky: the largest remaining gain, but ends the asset-free download. Revisit as an
  optional "high detail" pack once R1 to R5 are in.
- Volumetric clouds and lit smoke: high GPU cost in a browser.
- Temporal anti-aliasing: needs motion vectors through every custom shader.
- Authored models: an art job, and photoreal rockets would clash with the Pips.
