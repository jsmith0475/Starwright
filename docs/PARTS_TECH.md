# Parts catalog: tech ids and data notes

`js/core/parts.js` holds the parts catalog. This file records the tech-tree ids the parts use, the experiment ids
of the science parts, and the optional data fields, for anyone adding parts or changing how the physics reads
them. `SIZES.XL = 1.875`. Categories, in order: command, tanks, engines, structure, aero, wings, ground, utility,
science.

The "suggested" columns are the proposal the tech tree and experiments were built from. `js/core/career.js` is
the source of truth for the names, positions and costs in the game.

## Tech ids (nodes in `TECH_TREE`, js/core/career.js)

Existing grid: x = tier 0..5, y = row 0..4. Suggested positions extend it to x = 7, y = -1..6. Costs follow the
existing curve (5, 15, 30, 45, 90, 160, 300).

| id | suggested name | tier (x) | y | cost | requires | what it unlocks |
|---|---|---|---|---|---|---|
| `aviation` | Wings and Wheels | 2 | -1 | 30 | `basic_rocketry` | cockpits, fuselages, jets, wings, elevons, tails, landing gear, intakes |
| `fuel_systems` | Plumbing | 3 | 2 | 60 | `propulsion` | radial tanks, long S tank, radial thruster, fuel line |
| `aerodynamics` | Slippery Shapes | 3 | 1 | 60 | `stability` (or `general_construction`) | swept/grid fins, booster caps, air brake, strake, winglet, canard |
| `field_science` | Field Kit | 3 | 5 | 70 | `electrics` | gravimeter, seismometer, atmosphere analyser |
| `advanced_construction` | Girders and Manifolds | 4 | 0 | 120 | `general_construction`, `stability` | girders, truss, manifolds, blast rings, step plates, hull plate, shroud nose M |
| `advanced_electrics` | Bigger Sparks | 4 | 4 | 120 | `electrics` | Sunfoil Wing/Slab, Cell Pack L, fuel cell, floodlight |
| `deep_comms` | Long Ears | 4 | 5 | 140 | `electrics` | relay dish, deep-space dish |
| `ground_ops` | Tyre Tracks | 4 | 6 | 140 | `landing`, `electrics` | rover chassis, rover wheels, folding ladder |
| `orbital_assembly` | Meeting in Orbit | 5 | 3 | 220 | `command2` | Latch Ring L, Gyro Ring L, big/linear RCS, mono tanks S and L |
| `supersonic_flight` | Faster Than Sound | 5 | -1 | 260 | `aviation`, `heavy` | ramjet, delta and long wings, flight deck, wide fuselage, shock cone |
| `advanced_science` | Orbital Workshop | 5 | 5 | 280 | `field_science`, `command2` | lab module, survey scope, magnetometer boom |
| `very_heavy` | Colossal Lifting | 6 | 1 | 450 | `heavy`, `advanced_construction` | every XL part, Anvil SRB, Homestead pod, the XXL Shearwater stack ([SHEARWATER.md](SHEARWATER.md)) |
| `ion_propulsion` | Quiet Push | 6 | 4 | 500 | `advanced_electrics`, `miniature` | ion drives, xenon tanks |
| `high_power` | Power to Spare | 6 | 5 | 450 | `advanced_electrics` | Grand Array, Sunfoil Fan, isotope cell |
| `nuclear_propulsion` | Atomic Age | 7 | 2 | 800 | `advanced_propulsion` | Furnace Atomic Engine |

New parts were also placed on existing ids where they fit (`miniature`, `heavy`, `landing`, `electrics`,
`general_construction`, `propulsion`, `advanced_propulsion`).


## Experiment ids (entries in `EXPERIMENTS`, js/core/career.js)

| id | part | suggested base | suggested situations |
|---|---|---|---|
| `gravity` | `sci_grav` Plumb Gravimeter | 12 | landed, spaceLow, spaceHigh |
| `seismic` | `sci_seis` Thump Seismometer | 14 | landed |
| `atmosphere` | `sci_sniffer` Sniffer Atmosphere Analyser | 12 | flyingLow, flyingHigh, landed (bodies with atmosphere only) |
| `magnetic` | `sci_compass` Compass Boom | 10 | spaceLow, spaceHigh |
| `survey` | `sci_scope` Peeper Survey Scope | 16 | spaceLow, spaceHigh |
| `lab_study` | `sci_lab` Tinker Lab Module (crew 2, `needsCrew`) | 25 | landed, splashed, spaceLow, spaceHigh |

(The existing `sci_baro` Pressure Gauge is the barometer.)

## Fields used

The fields of the contract in `docs/SECOND_PASS.md`: `wing`, `wheel` (with `retract: true` on gear), `engine.type` `'ion'`
(+ `engine.elecUse`, `res.xenon`), `'nuclear'`, `'jet'` (+ `engine.jet = { maxAlt, maxMach }`), `light: { range }`,
shapes `fuselage`, `cockpit`, `intake`, `rover_body`, `ladder`, `light`, `wing`, `elevon`, `tailfin`, `wheel`.

Other new shapes (plain parts, no new physics needed): `xenontank`, `radialtank` (res fuel / mono / xenon on a
radial part), `radialengine` (an `engine` on a radial part; thrust along -Y at the part position; `srb_shove` is
a solid one with `res.solid`), `multicoupler`, `girder`, `panel`, `strut`, `fuelline`, `clamp`, `fairing`,
`airbrake`, `battery_radial`, `rtg`, `fuelcell`, `lab`.

### Optional extras (safe to ignore; behaviour requests)

| field | on | meaning | fallback if ignored |
|---|---|---|---|
| `variant` | many | mesh style hint only | none needed |
| `solar.fixed: true` (with `span: 0`) | `solar_tile`, `solar_slab` | generates without being deployed | panel makes nothing until "deployed" |
| `generator: { rate, fuelUse? }` | `gen_glowworm`, `gen_fizz` | EC/s always (isotope) or while fuel is available (kg/s) | part is inert |
| `antenna.range` (m) | dishes | max comms distance | `antenna.rate` still works |
| `rcs.linear: true` | `rcs_linear` | one nozzle pushing along the part's outward axis | treated as a normal RCS block |
| `airbrake: { area }` | `airbrake` | extra drag area while deployed (brakes key) | cosmetic |
| `multi: { count, radius }` | `coupler_*` | engine mounts drawn underneath; attaches as an adapter to the next size up | none needed |
| `decoupler: { force: 0 }` on a radial part without `attach.outer` | `clamp_pad` | launch clamp: staging it drops the clamp itself; ideally it also holds the vessel down until staged and is left at the pad | it falls away as a tiny part |
| `crew` without `command` | `sci_lab` | passenger/scientist seats | no seats |

Jets set `ispVac === ispAtm` so `engineIsp()` is flat; thrust falloff comes from `engine.jet`.
Ion engines: `ispAtm: 100` keeps them useless in air. The old `eng_lantern` stays `type: 'liquid'` (unchanged);
the new `eng_furnace` is the `'nuclear'` engine.

## Mesh state hooks the flight and assembly screens drive (js/render/partmesh.js `setPartState`)

See the header of `js/render/partmesh.js` for the full list.
