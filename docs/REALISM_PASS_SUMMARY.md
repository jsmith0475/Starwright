# Realism pass 3: what was done

Written 2026-11-21. Work ran on 2026-11-20 and 2026-11-21.

## Summary

The flight picture is more physically plausible in six ways: ambient occlusion, live reflections, terrain that no
longer repeats, grounded rocks, better water, and occlusion in the hangars and space centre. Everything is still
made in code; no image, model or sound files were added, and nothing in `js/core` changed.

Every check ran in headless Chromium on a software renderer. **Nothing has been run on a real GPU**, so frame rate
and the final look on a real display are unconfirmed.

**The changes are not published.** They exist only in this project folder. The folder is not a git repository, and
there is no hosting setup in it.

## How the work was organised

1. A read-only review of the game and its graphics.
2. A recommendation: stay asset-free and do code-only work, most visible gain first.
3. A spec (`docs/REALISM_PASS_SPEC.md`) and a task plan (`docs/REALISM_PASS_PLAN.md`), then the eight tasks below.

Before each stage the project was archived into `.build/`, because there is no version control:

| Archive | State |
|---|---|
| `sw-pre-realism3-194412.tar.gz` | before any change |
| `sw-realism3-ao-201210.tar.gz` | after ambient occlusion in flight |
| `sw-pre-task2-*.tar.gz` | before live reflections |
| `sw-realism3-done-084756.tar.gz` | finished |

## What changed, task by task

### Task 0: baseline

Unit tests counted (349 passing) and "before" pictures saved to `tests/out/r3-before/`.

### Task 1: ambient occlusion in flight

- A new half-resolution pass (`js/render/ao.js`) reads the scene's depth and darkens creases and contact areas.
  It adds two draw calls per frame and no second scene render.
- It runs at "high" quality only. There is a new "Ambient occlusion" switch in Settings and in the in-flight
  graphics menu, on by default.
- The automatic quality governor turns it off at its fourth level, before it touches shadows.
- The effect is subtle. It shows from above and on structures; looking along the ground it adds almost nothing.

### Task 2: live reflections

- A new probe (`js/render/envprobe.js`) draws a small cube map of the surroundings from the vessel's position and
  uses it for reflections and ambient light on parts, at "high" quality.
- It replaces a fixed painted sky. On the pad the tank picks up the real blue sky; on the moon it goes grey with
  black space above.
- It refreshes when the surroundings change (another world, the sun or horizon turning 2 degrees, height changing
  by a fifth) and otherwise at most every 20 seconds.
- A refresh draws about 150 extra draw calls per frame for six frames.

### Task 3: terrain

- The ground relief was one tiling texture laid at several scales, and from some heights it repeated in visible
  rows. Three of the scales are now sampled twice with offsets that change from patch to patch.
- Measured as the strongest repeat in a top-down picture (limit 0.2): Pell from 300 m went from 0.32 to 0.12, and a
  visible grid of pale patches on Rusk from 25 m is gone.

### Task 4: rocks

- Boulders cast a soft shadow on the ground, darker on worlds with no air.
- They lie buried to different depths and each has different proportions.
- Trees, grass and every other object stay exactly where they were.

### Task 5: water

- The sea bed seen through shallow water loses red first and fades to green, instead of showing as brown blotches.
- The surf band at the shore is narrower.
- Wave faces turned to the light are brighter.
- The far shoreline is softened so its coarse steps show less.

### Task 6: hangars and space centre

- Both views now get ambient occlusion, with the rest of the picture unchanged.
- The first attempt drew them through the flight screen's finishing pass, which changed colours. The post chain
  gained a second mode that leaves the picture as it was and only adds the occlusion.
- The effect is faint in the hangars and close to invisible from the space centre's overview distance.

### Task 7: documents and checks

- `docs/ARCHITECTURE.md`: new section "Additions (round 5: realism pass 3)".
- `docs/TECH_STACK.md`: corrected the line count (about 45,000, not 20,000) and the claim that there are no Web
  Workers.
- `docs/REALISM_PASS_PLAN.md`: results table and notes for the next pass.
- A before/after sheet: `tests/out/realism3-compare.html`.

## What the plan got wrong

Tasks 3 to 5 assumed less was already in place than there was. The code already had slope rock blending, a fine
grain layer, Fresnel water, sun glitter, foam and shaped rocks with contact shade. Each of those tasks was cut down
to what was measurably or visibly missing.

## Files

| File | Change |
|---|---|
| `js/render/ao.js` | new: occlusion pass and blur |
| `js/render/envprobe.js` | new: reflection probe |
| `js/render/post.js` | depth texture, occlusion in the composite, display mode |
| `js/render/worldshaders.js` | terrain repeat fix, water changes |
| `js/render/scatter.js` | boulder shadows, burial, proportions |
| `js/ui/flightscene.js` | quality wiring for occlusion and the probe |
| `js/ui/governor.js` | occlusion flag on each quality level |
| `js/ui/builder.js`, `js/ui/baseview.js` | occlusion in the hangars and space centre |
| `js/ui/hub.js`, `js/ui/flight.js`, `js/main.js` | the new setting |
| `css/style.css` | interface layer clips its overflow (regression fix, below) |
| `tests/unit/perf.test.js` | one new governor test |
| `tests/e2e/ao_probe.mjs`, `env_probe.mjs`, `tiling_probe.mjs` | new checks |
| `tests/e2e/preview_water.mjs` | new capture script |
| `tests/e2e/realism_probe.mjs` | measures a frame between probe refreshes |
| `docs/` | spec, plan, architecture, tech stack, this file |

## Test results

| Suite | Result |
|---|---|
| Unit tests | 350 pass, 0 fail (349 before, plus one new) |
| Occlusion, reflection and tiling probes | all pass |
| Builder suite | 211 of 211 |
| Shell suite | 21 problems, the same 21 on the untouched archive |
| Flight suite | 10 problems, all aborted script requests (untouched archive: 11) |
| Perf suite | 8 problems, the same 8 on the untouched archive |
| Draw-call budgets | "high" within budget; three medium and low rows over, identical on the untouched archive |

Not run: play-through, contact, docking, interplanetary, missions, scenarios, science, map and demo suites.

## Problems found and fixed on the way

- **Settings dialog sliding off screen.** The new settings row made the dialog long enough that clicking a lower
  row scrolled the whole interface layer upward at large interface sizes. The layer now clips instead of hiding
  its overflow, so it cannot be scrolled.
- **Lines of false shade in the occlusion.** The half-resolution pass sat on the border between depth pixels. It
  now reads depth by index and rebuilds positions from the pixel it read.
- **Error during shader pre-compilation.** Swapping the parts' reflection map while shaders were compiling threw
  inside three.js. The probe's first refresh now runs before compilation starts.
- **Hangar colours washed out.** See Task 6.

## Known limits

- **Real GPU unmeasured.** Check frame rate with F3 at "high" on the pad, during ascent and in the hangar, and
  watch for a brief stutter when the reflection probe refreshes.
- **Occlusion strength.** It is subtle in flight. Raising it is one number (`intensity` in `js/render/ao.js`).
- **Reliance on three.js internals.** The hangar and space-centre occlusion depends on how three.js r170 chooses
  tone mapping for a render target. Re-check it if three.js is updated.
- **Shallow sea from high up.** From several kilometres up there is a stepped ring where the sandy bed meets the
  blue far map. It was there before this pass.
- **Playwright.** It is not installed on this Mac. The browser suites ran from a temporary copy (version 1.64.1,
  matching the cached Chromium) passed through `NODE_PATH`.
