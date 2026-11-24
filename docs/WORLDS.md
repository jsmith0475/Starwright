# Higher-fidelity worlds

Every landable world now has ground of its own at walking scale, rocks that belong to it, and,
where there is air, a high thin layer of cloud or dust and proper light on the clouds at dawn
and dusk. Pell is pocked with craters down to a hand's width. Brim and Ost are broken into ice
plates with dark water or blue ice in the cracks. Sear's lava sea is a dark crust with the glow
coming up between the plates. Rusk has wind ripples, dunes and cracked mud pans.

This is roadmap item 4. It is a first pass at that item, not the end of it: see
[what is still open](#what-is-still-open).

## The rule this work kept: the ground does not move

Nothing under `js/core` changed. `Body.terrainHeight`, the function wheels, legs and fallen
landers stand on, returns exactly what it returned before, and the terrain mesh is built from
it exactly as before. Everything here is drawn on top of that ground:

- **Surface features** tilt the shading normal and change colour. A crater drawn this way is a
  dimple the eye sees and the wheels do not feel, the same way the existing detail relief
  already worked. The largest are about 150 m across and shallow; at the scale where a real
  crater that size would matter to a rover, the drawn one does not exist for the physics.
- **Rocks** are placed from the same single `terrainHeight` sample as before. Boulders have
  since been made solid; see [BOULDERS.md](BOULDERS.md).
- **Clouds** are sky.

That is a limit as well as a safety rule. If craters and dunes are ever to be driven over and
landed in, they have to go into `terrainHeight`, with the independent checks re-run and every
scenario's landing site re-examined. That is listed as open below.

`tests/unit/terrain_golden.test.js` holds the rule: it compares `terrainHeight` at 400
directions over each of the 16 solid bodies, and on a 2 m grid of 100 points, with values
recorded from `main` before this work started, and fails if any moves by a micrometre.

## Surface features (`js/render/surfacefeatures.js`)

Three kinds, drawn in the terrain fragment shader, chosen and tuned per world:

| Kind | What it is | Sizes |
|---|---|---|
| Craters | bowls with raised rims, brighter rims and darker floors | 5 sizes of cell, craters from about 0.2 m to 150 m across |
| Cracks | a net of cracks between plates; each plate has its own tilt and tone; cracks can hold a colour or glow | 3 plate sizes per world, from 0.5 to 4 m underfoot up to 32 to 512 m seen from the air |
| Ripples | wind ripples about 0.25 m apart, dunes about 15 m and 80 m apart, on level ground only | 3 wavelengths |

What each world has:

| World | Features |
|---|---|
| Sear | lava sea: dark crust plates, glowing cracks, some plates still dull red; craters on solid ground |
| Cindra | heavy cratering; dark cracked flows on the flats |
| Murk | ripples and dunes; cracked basalt pans |
| Verda | none (its ground is grass, soil, forest and sea, drawn by the vegetation and water code) |
| Pell | heavy cratering with bright rims |
| Ost | ice plates with blue cracks; a few craters |
| Rusk | ripples and dunes; cracked mud pans; a few craters |
| Dray | heavy cratering; faint grooves |
| Tiv | crust plates with glowing cracks on the brimstone lakes; a few craters |
| Marn | frost polygons on the flats; faint snow ripples |
| Slate | heavy cratering; pale fracture lines |
| Nock | the heaviest cratering |
| Brim | ice floes with dark water in the leads |
| Quell | glacier ice with blue cracks; craters |
| Nym | heavy cratering |
| Wend | deep pits and black fractures |

### How the patterns stay sharp and continuous

A world 640 km in radius cannot be addressed in single-precision metres: the steps are 6 cm.
Each terrain chunk therefore gives the shader its own position modulo 64 m and modulo 2048 m
(two more of the per-chunk phases the detail textures already used). The shader works in those
wrapped metres, keeps millimetre precision anywhere, and every cell size divides its period, so
a crack or a ripple crest runs on unbroken from one chunk to the next. Ripples use whole
numbers of waves per period in both directions for the same reason.

Patterns are laid on the plane of the cube face the ground is on (the six faces the terrain
quadtree uses). They do not line up across the twelve cube edges. No site in the game is near
one.

Plates are a cell pattern with three corrections so they do not read as wallpaper: the cell
edges are bent by smooth waves a few plates long, crack width varies from closed to wide, and
whole regions are left sound. A crack that has to be widened to stay a pixel and a half wide
at a distance is made paler by the same factor, so far ground does not turn the colour of its
cracks.

### Cost

Each kind is compiled into a world's shader only if that world uses it, and Verda's shader is
unchanged. Per pixel, where a kind is in range:

- craters: one hash per size in range, usually two sizes;
- cracks: nine hashes per plate size, one or two sizes in play at any distance, never three;
- ripples: three cosines;
- no extra texture reads: where the patches of sand and cracked ground lie comes from detail
  samples the shader has already taken.

Low quality draws none of it.

## Rocks (`js/render/scatter.js`)

Loose rocks used to be two worn-stone shapes in a different colour on every world. There are
now eight kinds, and each world has one or two:

| Kind | Shape |
|---|---|
| worn | the rounded stones from before, unchanged |
| angular | flat-faced fractured blocks |
| ice | the same blocks, pale, with a broad glint |
| shard | broken ice plates standing on edge |
| clinker | rough lumps with gas holes |
| clod | the clinker shape with plain stone shading |
| slab | flat bevelled plates with bedding bands |
| ventifact | keeled, wind-cut stones lying roughly along one wind |

Sear: clinker and slabs. Cindra: clinker and angular. Murk: worn and clinker. Verda: worn
(identical to before, instance for instance). Pell: angular and worn. Ost: ice and shards.
Rusk: ventifacts and slabs. Dray: clods and angular. Tiv: worn and slabs. Marn: worn and
slabs. Slate: slabs and angular. Nock: angular and clods. Brim: ice and ice slabs. Quell: ice
and worn. Nym: clods and worn. Wend: clods and dull ice.

Flat and blocky kinds take the slope of the ground under them, so they lie on a hillside
instead of standing out of it. A second kind costs one more draw call for boulders and one
for pebbles (two per world, none on Verda). The new shapes have fewer triangles than the worn
stone, so clutter triangles went down or stayed equal in every view measured.

## Sky (`js/render/worlds.js`)

- **A high thin layer** on three worlds, drawn in the same draw call as the cloud deck: ice
  streaks at 13 km on Verda, ice veils at 11 km on Marn, wind-drawn dust at 17 km on Rusk. It
  has its own drift. Murk keeps its unbroken overcast.
- **Dawn and dusk from below.** Each piece of cloud is lit by the sun as it stands for that
  cloud, not for the camera, so the deck toward a low sun glows, the deck behind goes
  grey-blue, and both layers stay lit for a while after the sun has set on the ground. Nothing
  changes where the sun is more than about 17 degrees above a cloud.

The high layer shows only on the world you are at; a far-off globe does not draw it, and it
casts no shadow on the ground.

## What was checked

- **Physics untouched.** No file under `js/core` differs from `main`. The full independent
  verification passes: 1,274 checks, 0 failed. The golden-height test above passes.
- **Unit tests.** 436 pass (5 new: the golden heights and four on the feature data).
- **Every world rendered before and after** in headless Chromium: ground at low sun for all
  16, and from 5 km for 10 of them, with no console or shader errors.
- **Drawn ground against physics ground**, from the same preview run: unchanged from `main`,
  within 3 cm of the height function within 25 m of the vessel on every world.
- **On a real graphics card** (Apple M5 Max, Chrome), with the game's own benchmark
  (`?perf=1&hq=1`: full 2984 x 2242 resolution, quality governor off, 300 frames) run back to
  back on this build and on the previous one, 2026-11-22:

  | Scene | Before | After |
  |---|---|---|
  | Landing on Pell, 1.7 km up | 21.5 ms a frame | 22.8 ms |
  | Rover on Rusk | 54.5 ms | 57.4 ms and 55.7 ms (two runs) |
  | On the pad | 62.4 ms | 63.6 ms |
  | Orbit, 85 km over Verda | 18.0 ms | 20.7 ms |

  The machine was busy that day (the previous build itself ran well under the 60 frames a
  second it had held the day before), so these are a comparison, not a frame-rate reading.
  Run to run, the same build moved by about as much as the differences shown. Rusk, which has
  all three kinds of feature and the dust layer, measured a third slower before the cost was
  cut to what the table shows.

Not checked, and worth a look by eye in the real game: the features and the ice glint in
motion (stills only so far), the moment of flying through the high cloud layer, and medium
quality.

## What is still open

Roadmap item 4 asked for more than this pass delivers:

- **Features you can feel.** Craters, dunes and canyons in `terrainHeight` itself, so a rover
  climbs a dune and a lander can come down in a crater. This changes physics and landing sites
  and needs the full verification and scenario pass.
- **Finer mesh near the camera.** The mesh already carries the exact physics height at 0.4 to
  0.75 m cells; a finer level only helps once the height function has detail at that scale.
- **Weather and ground haze.** Mist in valleys, dust storms on Rusk, rain on Verda.
- **The high layer on distant globes**, and its shadow on the ground.
- **Bigger and clustered rocks.** (Rocks with collision are done: [BOULDERS.md](BOULDERS.md).)
- **The home world.** Verda got the sky work only; beaches, river beds and bare mountain rock
  could use the same feature code.
