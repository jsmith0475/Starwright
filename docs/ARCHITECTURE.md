# Starwright — architecture and module contracts

Starwright is an ORIGINAL browser space-flight sim in the "build a rocket, fly it with real orbital
mechanics" genre. It must have its own identity: its own name, characters ("Pips": small round-helmeted
astronauts in orange suits with a bobble antenna), art style, UI look, planet names and sounds.
NEVER use names, characters, art, UI layout/look, planet names, part names or text from Kerbal Space
Program or any other existing game. Mechanics and feel only.

Visual identity: dark slate UI panels (#141a22 / #1d2631), teal accent (#39d0c0), amber highlight
(#ffb347), rounded corners, system rounded font stack (`ui-rounded, "SF Pro Rounded", system-ui, sans-serif`).
Parts look like chunky bright toys: white tanks with teal bands, dark engine bells, cream capsules.

## Hard rules for every module

- Plain ES modules, no build step, no npm runtime deps. Three.js r170 is vendored at
  `js/lib/three.module.min.js` (import with a relative path, e.g. `import * as THREE from '../lib/three.module.min.js'`).
- The game runs from a static server (`python3 -m http.server`) in Chrome/Safari on a Mac.
- `js/core/*` is PURE SIMULATION: no `document`, `window`, canvas or WebGL. It may import three.js only
  for `Vector3`/`Quaternion`/`Matrix4` math (these are double precision in JS). It must run under Node
  (`node --test tests/unit/`), which is how the unit test harness works.
- `js/render/*` builds three.js objects. `js/ui/*` owns DOM, input and screens.
- Only touch the files your task assigns. Do not edit `js/core/parts.js` or this document; if a contract
  is wrong or missing something, add what you need in YOUR module and report it in your final message.
- Units: SI everywhere in the sim (m, s, kg, N, rad). Part defs store mass in tonnes and thrust in kN;
  convert at the edge (x1000).
- Every core module needs unit tests in `tests/unit/<module>.test.js` using `node:test` + `node:assert/strict`.

## Coordinate conventions

- Right-handed, **Y-up**, same as three.js. The ecliptic is the XZ plane, north is +Y.
- Prograde orbital motion and body rotation are counter-clockwise seen from +Y: a point at +X moves toward −Z.
  Body spin vector is `(0, +2π/rotPeriod, 0)`.
- Each vessel's `pos`/`vel` are relative to the centre of its current SOI body, in a NON-rotating frame.
- Body-fixed direction for latitude φ, longitude λ: `d = (cosφ·cosλ, sinφ, −cosφ·sinλ)`.
  Inertial direction = rotate `d` about +Y by `body.rotationAngle(t)` (three.js `applyAxisAngle(Y, angle)`).
  East at a point = `Y × up` normalised; north = `up × east`.
- Vessel local frame: **+Y is the nose** (up the stack), +X is "right", +Z is "top" (pilot's head).
  `vessel.q` rotates local → world (inertial). On the pad: local X→east, Y→up, Z→south.
- Control inputs are in [-1, 1]: `pitch` > 0 pulls the nose toward +Z local (rotation about +X local),
  `yaw` > 0 turns the nose toward +X local (i.e. rotation about −Z local), `roll` > 0 rolls clockwise seen
  from behind (rotation about +Y local). Keys: S = pitch +1, W = pitch −1, D = yaw +1, A = yaw −1, E = roll +1, Q = roll −1.
- Universal time `ut` in seconds from game start.

## js/core/noise.js

`makeNoise(seed)` → `{ noise3(x,y,z) → [-1,1], fbm(x,y,z,octaves=5,lacunarity=2,gain=0.5) → about [-1,1] }`. Deterministic.

## js/core/orbit.js

```js
export class Orbit {
  // fields: gm, e, p (semi-latus rectum), a (negative if hyperbolic), hyper (bool), n (mean motion),
  //         M0, t0, P, Q, H (unit Vector3: periapsis dir, in-plane 90° ahead, orbit normal)
  static fromState(r, v, gm, t)            // Vector3 r, v relative to the body
  static fromElements({a,e,i,lan,argp,M0}, gm, t0 = 0)   // degrees for i, lan, argp; M0 in rad
  stateAt(t)                               // → { r: Vector3, v: Vector3 }
  posAt(t, out?) / velAt(t, out?)
  trueAnomalyAt(t)
  posAtTrueAnomaly(nu, out?)               // for drawing
  radiusAtTrueAnomaly(nu)
  timeAtTrueAnomaly(nu, after)             // next time ≥ `after` (unique time for hyperbolic; may be < after)
  get periapsis() / apoapsis (Infinity if hyper) / period (Infinity if hyper)   // radii from body centre
  get inclination()                        // radians, angle between H and +Y
  timeToPeriapsis(t) / timeToApoapsis(t)
  toJSON() / static fromJSON(o)
}
```
Must be robust for circular (e≈0), equatorial, near-parabolic and near-radial (|h|≈0) states (no NaN).
Kepler solvers must converge for e up to 0.999 and hyperbolic e up to 50.

## js/core/bodies.js

```js
export class Body {
  // id, name, type ('star'|'planet'|'moon'), parent (Body|null), children [], radius, gm, surfaceG,
  // soi (Infinity for star), rotPeriod, rot0, orbit (Orbit around parent | null), atmo (null or
  // {height, scale, rho0, color:[r,g,b]}), ocean (bool), gas (bool), color (hex), seed, sciMult,
  // spaceBorder (altitude separating "low space" from "high space")
  posAt(t, out?) / velAt(t, out?)          // relative to parent (zero vector for the star)
  globalPosAt(t, out?) / globalVelAt(t, out?)   // relative to the star
  rotationAngle(t)                         // rad
  angVel()                                 // Vector3 (0, 2π/rotPeriod, 0)
  density(alt)                             // kg/m³, 0 at/above atmo.height or if no atmosphere
  pressureAtm(alt)                         // in home-sea-level atmospheres (rho0/1.22 * exp(-alt/scale)), 0 above
  surfaceDirToInertial(dirBodyFixed, t, out?) / inertialToSurfaceDir(dirInertial, t, out?)
  latLon(dirBodyFixed)                     // {lat, lon} radians
  biomeAt(dirBodyFixed)                    // {id, name, water:bool}; deterministic from seed noise
  surfaceColorAt(dirBodyFixed)             // [r,g,b] 0..1 — used by render for textures AND terrain patch
}
export const SYSTEM   // { bodies: Body[], byId: {id: Body}, star: Body, home: Body, launchSite: {lat:0, lon:0, dir: Vector3 bodyFixed, name:'Starwright Flight Center'} }
```
`soi = a·(gm/gmParent)^0.4`. Tidal bodies rotate once per orbit. `biomeAt(launchSite.dir)` must be land.
`surfaceColorAt` palettes: Verda blue oceans / green-tan land / white caps; Pell grey cratered; Ost icy
pale blue; Cindra dark scorched brown; Rusk rust-red; Thal teal/violet gas bands; Tiv sulfur yellow-green; Helion star.

Body data (gm = surfaceG·radius²):

| id | name | parent | radius (m) | surfaceG | rotPeriod (s) | orbit a (m), e, i°, lan°, argp°, M0 | atmosphere (height, scale, rho0) | notes |
|---|---|---|---|---|---|---|---|---|
| helion | Helion | — | 2.2e8 | gm = 1.2e18 | 432000 | — | — | star |
| cindra | Cindra | helion | 2.5e5 | 2.8 | 1.2e6 | 6.2e9, 0.18, 6, 70, 15, 2.1 | — | sciMult 7 |
| verda | Verda | helion | 6.4e5 | 9.6 | 19800 | 1.36e10, 0, 0, 0, 0, 0 | 72000, 5800, 1.22 | home, ocean, sciMult 1 |
| pell | Pell | verda | 2.1e5 | 1.6 | tidal | 1.25e7, 0, 0, 0, 0, 1.7 | — | sciMult 4 |
| ost | Ost | verda | 7.0e4 | 0.5 | 40000 | 4.4e7, 0.08, 5.5, 40, 30, 0.5 | — | sciMult 5 |
| rusk | Rusk | helion | 3.6e5 | 3.2 | 24000 | 2.05e10, 0.05, 1.5, 130, 60, 3.6 | 45000, 6500, 0.25 | sciMult 6 |
| thal | Thal | helion | 5.2e6 | 8.5 | 36000 | 6.8e10, 0.04, 1.2, 200, 10, 5.1 | 400000, 40000, 3.0 | gas giant, sciMult 9 |
| tiv | Tiv | thal | 4.0e5 | 2.2 | tidal | 3.2e7, 0.01, 0.5, 0, 0, 2.4 | — | sciMult 9 |

## js/core/trajectory.js

```js
// Patched-conic prediction. Returns an array of patches:
// { orbit: Orbit, body: Body, tStart, tEnd (Infinity if closed orbit with no event), endType: null|'exit'|'enter'|'impact'|'atmo', nextBody }
export function predictPatches(orbit, body, tStart, maxPatches = 4)
// SOI transition helpers for the live sim:
export function toParentFrame(body, pos, vel, t)   // → {body: parent, pos, vel}
export function toChildFrame(child, pos, vel, t)   // → {body: child, pos, vel}
export function checkSoiTransition(body, pos, vel, t)  // → null or {body, pos, vel}
// Maneuver nodes: dv = {prograde, normal, radial} in m/s
export function applyManeuver(orbit, t, dv)        // → Orbit after an impulsive burn at time t
export function maneuverBasis(r, v)                // → {prograde, normal, radial} unit Vector3 (radial = prograde × normal, pointing out)
```
`'impact'` ends a patch at the surface (airless) and `'atmo'` at the top of the atmosphere, when periapsis is below them.

## js/core/parts.js (already written — read it)

Catalog data: `PARTS`, `PART_LIST`, `CATEGORIES`, `partDef(id)`, `engineThrust(def, pAtm)` (N), `engineIsp(def, pAtm)`, `G0`.
Part shapes (for the mesh builder): `capsule, probe, tank, monotank, engine, srb, decoupler, radialdec, adapter, leg, nose,
fin, heatshield, chute, chute_radial, battery, solar, gyro, rcs, antenna, sci_small, sci_jar, pip`.

## js/core/craft.js — the design the builder edits

```js
export class Craft {
  name; parts: CraftPart[]; stages: number[][]   // stages[0] fires FIRST; each is a list of part ids
  // CraftPart: { id:int, type:string, pos:{x,y,z}, rot:number (yaw rad), parent:int|null,
  //              node:'root'|'top'|'bottom'|'radial'|'outer', sym:int (symmetry group id, 0 = none) }
  get root()
  getPart(id) / children(part) / subtree(part)   // subtree includes the part itself
  nodeFree(part, 'top'|'bottom')
  // Placement. All return the array of created parts (N copies under symmetry), or [] if not allowed.
  setRoot(type)
  attachStack(type, targetId, 'top'|'bottom')        // new part sits ON TOP of / hangs BELOW the target
  attachRadial(type, targetId, y, angle, symmetry=1) // y in craft coords, angle = yaw about the target's axis
  attachOuter(type, targetId)                        // stack part mounted on a radial decoupler's outer face
  // If the target belongs to a symmetry group, the attachment is mirrored onto every member.
  removePart(id)            // removes its subtree and symmetric counterparts; returns removed parts
  radiusAt(part, y)         // surface radius of a stack part at craft-space height y
  bounds()                  // {minY, maxY, maxR}
  autoStage()               // rebuilds this.stages
  moveToStage(partId, stageIndex) / insertStage(index) / removeEmptyStages()
  validate()                // → {ok, errors:[], warnings:[]} (no command part, no engine, no chute...)
  cost() / mass()           // funds; kg wet
  stats(body = SYSTEM.home) // → [{stage, dvVac, dvAtm, twr, burnTime, startMass, endMass, thrust}] in firing order
  toJSON() / static fromJSON(o) / clone()
}
export function stockCrafts()   // → Craft[]: a few ready-made designs (see below)
```
Geometry rules: every part's axis is vertical; a part has a centre `pos` and yaw `rot`. Stack parts connect
top/bottom nodes (`pos.y ± h/2`). A radial part attached to target T at angle `a` and height `y` has
`pos = T.axis + outward(a)·(radiusAt(T,y) + rw/2)`, `rot = a`, where `outward(a) = (cos a, 0, −sin a)`.
A stack part on a radial decoupler D's outer node: `pos = D.pos + outward(D.rot)·(D.rw/2 + part.r)`, same y, `rot = D.rot`.
Parts with `topOnly` can only attach via their bottom node on top of a target (node 'top').
Symmetry N places copies at `a + k·2π/N` about the TARGET's axis, all sharing a new `sym` id.

Auto-staging: depth(part) = number of decouplers on the path from the control part (first command part, else root)
to the part, counting the part itself if it is a decoupler. Firing order: [engines of max depth D], then for
k = D…1: [decouplers of depth k + engines of depth k−1], then [all parachutes]. Drop empty groups.
Exception: liquid engines of depth k−1 whose section is directly connected (through radial decouplers only)
to boosters of depth k may stay in their own group — keep it simple and deterministic.

Fuel rules (shared with vessel.js): an engine draws `fuel` evenly from all tanks in its SECTION
(the set of parts connected to it without crossing a decoupler part). Solid boosters burn their own `solid`.

Stock crafts (must fly; used by tests and offered to the player as examples):
- `Hopper I`: pod_acorn + chute on top, srb_ember below. Suborbital hop.
- `Skylark II`: crewed two-stage orbital rocket (chute, pod_acorn, heatshield_m, separators, fins). Design it so total
  vacuum dv ≥ 3600 m/s and liftoff TWR 1.3–1.9
  (upper: tank + eng_sparrow; lower: tanks + eng_goshawk, optionally radial srb_ember boosters). Must reach Verda orbit.
- `Pell Runner`: three-stage vessel with ≥ 5600 m/s vacuum dv, legs on the last stage, able to land on Pell.

## js/core/vessel.js and js/core/world.js — the live simulation

```js
export class Vessel {
  id; name; type: 'ship'|'debris'|'eva'|'flag'
  parts: Map<id, VPart>      // VPart: {id, def, pos:Vector3 (craft coords), rot, links:int[], res:{...current amounts},
                             //         ignited, flameout, deployed ('stowed'|'armed'|'semi'|'full'|'cut' for chutes; bool-ish for legs/solar),
                             //         temp, crew: string[], sym, destroyed}
  stages: number[][]; stageIndex   // next stage to fire
  body; pos; vel; q; w         // w = angular velocity in LOCAL frame (rad/s)
  landed: bool; splashed: bool; surface: {dir (body-fixed unit), qRel}  // when landed
  onRails: bool; orbit: Orbit  // orbit is refreshed whenever needed (getOrbit(t))
  ctrl: { pitch, yaw, roll, throttle (0..1), tx, ty, tz (RCS translate), sas: bool, sasMode: 'hold'|'prograde'|'retrograde'|'normal'|'antinormal'|'radialIn'|'radialOut'|'maneuver'|'target', rcs: bool }
  nodes: [{t, dv:{prograde, normal, radial}}]   // maneuver nodes
  // derived (kept up to date by the sim): mass (kg), com (Vector3 craft coords), inertia (Vector3 diag),
  // thrust (N, current), maxThrust (N at current pressure), altitude, radarAlt, surfaceVel (Vector3), airspeed,
  // verticalSpeed, dynamicPressure, mach-ish, gForce, situation ('prelaunch'|'landed'|'splashed'|'flying'|'suborbital'|'orbit'|'escape'),
  // deltaV remaining estimate, resources totals {fuel:{amount,max},...}
  static fromCraft(craft, {crew: string[]})   // crew names fill command seats in order
  activateNextStage()        // → list of events
  getOrbit(t)
  toJSON() / static fromJSON(o)
}
export class World {
  ut; vessels: Vessel[]; active: Vessel; warpIndex; WARP_RATES = [1,2,3,4, 5,10,50,100,1000,10000,100000]  // first 4 = physics warp
  flags: []; events: EventEmitter-like  on(type, fn) / emit(type, data)
  constructor({ut = 0})
  launch(craft, {crew}) → Vessel            // places it landed on the pad at SYSTEM.launchSite, situation 'prelaunch'
  step(realDt)                              // advances ut by realDt × warp, sub-stepping physics at ≤ 0.02 s
  setWarp(index) → actual index (clamped by rules: no rails warp in atmosphere or under thrust; altitude limits)
  maxWarpIndex()                            // currently allowed
  warpTo(ut)                                // auto-warp that slows down and stops at the time
  stage()                                   // active vessel next stage
  evaStart(vessel, partId) → Vessel(eva) / evaBoard(evaVessel, targetVessel) / plantFlag(evaVessel, name)
  switchTo(vessel)
  runExperiment(vessel, partId) → result    // see career science
  recover(vessel) → summary                 // only when landed/splashed on the home body
  toJSON() / static fromJSON(o)
}
```
Events emitted (type, payload): `stage {vessel, stage}`, `decouple {vessel, debris}`, `explosion {pos (world rel. body), body, size, partName}`,
`destroyed {vessel, reason}`, `crewLost {name}`, `landed {vessel, speed}`, `splashed`, `liftoff`, `soi {vessel, from, to}`,
`situation {vessel, from, to}`, `flameout {vessel, part}`, `chute {vessel, part, state}`, `warp {index, rate, reason}`, `message {text}`.

Physics model (per sub-step, active and nearby vessels ≤ 2.5 km; others ride on rails):
- Gravity of the current SOI body only (patched conics). Semi-implicit Euler or better at dt ≤ 0.02 s.
- Thrust along local +Y from each ignited engine with propellant; `engineThrust(def, pressureAtm) × throttle`
  (solids ignore throttle). Mass flow `thrust/(isp·G0)`. Thrust offset from the CoM produces torque.
- Aerodynamics per part using air-relative velocity (atmosphere co-rotates with the body):
  exposed top faces (node free) take axial drag `q·πr²·drag.top·|cosα|` when the flow comes from the nose side,
  exposed bottoms likewise from the tail side, sides `q·(2r·h)·drag.side·sinα`; fins give a lift-like force along
  their plane normal `q·area·(v̂·n)·1.6`. Forces act at part positions → restoring/overturning torque emerges.
  Parachutes (docs/PARACHUTES.md, `js/core/parachute.js`): each open canopy is a second body on a line from its pack,
  with drag on its own velocity and the inertia of the air it carries; the line tension is solved with the rigid body.
  'armed' → 'drogue' (a main pack's built-in `chute.drogue`, Mach < 3) → 'semi' (the main, reefed) when the air can fill
  it, Mach < maxMach and the predicted opening load is inside the line strength (else `part.chuteWait` says why it
  waits; a slow craft skips the drogue); → 'full' below fullAlt above the ground; 'cut' when the line load stays over
  `strength`, and on touchdown, when the picture topples and deflates the canopy (`chuteDown`, `js/render/partmesh.js`). The drawn canopy (`js/render/canopy.js`) is built from the same `chuteShape` the physics flies.
- Attitude: rigid body with diagonal inertia. Torque sources: reaction wheels (`torque`, uses elec 0.02 EC/s per kN·m at full),
  engine gimbal, control fins (∝ dynamic pressure), RCS (mono). SAS is a PD controller that feeds the same actuators.
- Heating (docs/HEATING.md): Sutton-Graves flux `k·sqrt(ρ)·v³` for a 1 m nose, `k` from the world's gas; each part meets
  `HEAT_SCALE · flux / sqrt(R)` times an attitude factor and its shadow exposure, `R` its own nose radius, and its skin
  follows a heat balance with radiation and the air's total temperature as a ceiling. Heat shields hold 2,000 K and lose
  ablator by heat times area; a part above `maxTemp` explodes. `HEAT_SCALE` (20) is set so a bare Acorn capsule survives
  a shallow re-entry from low Verda orbit (≈2300 m/s) but a 3000+ m/s return needs a shield.
- Ground: bodies are perfect spheres (flat terrain). Touching down slower than the lowest part's `tolerance`
  lands; faster destroys the contacting parts (and everything if > 2.2× tolerance). Water (ocean biome) is ×1.5 tolerance → 'splashed'.
  Landed vessels are pinned to the rotating surface until thrust exceeds weight.
- Decoupling/explosions split the part graph; the piece with the controlling command part stays the vessel,
  the rest become debris vessels with a small separation impulse.
- Rails (warp index ≥ 4, or unloaded vessels): Kepler propagation, SOI transitions at predicted patch boundaries,
  warp drops automatically before atmosphere entry / impact / SOI change / maneuver node (warpTo).
  Unloaded debris below the atmosphere/surface periapsis is removed.

## js/core/career.js

```js
export class Career {
  mode: 'career'|'science'|'sandbox'; funds; science; reputation; ut
  tech: Set<string>; milestones: Set<string>; roster: [{name, status:'available'|'assigned'|'away'|'lost', flights, trait}]
  scienceLog: {key: pointsEarned}; crafts: {name: craftJSON}; flightState: worldJSON|null; settings
  static newGame(mode) / static load(storage = localStorage) / save(storage) / static hasSave(storage)
  isPartUnlocked(partId); canAfford(cost); spend(cost); earn(funds, science, rep)
  unlockTech(nodeId) → {ok, reason}
  availableCrew(); hire() → {ok, cost}
  // Science: situation ids 'landed'|'splashed'|'flyingLow'|'flyingHigh'|'spaceLow'|'spaceHigh'
  scienceValue(experimentId, bodyId, situation) → {key, full, remaining}
  creditScience(experimentId, bodyId, situation, fraction = 1) → points
  onEvent(type, payload, world) → [{milestoneId, title, funds, science}]   // feeds milestone completion from World events
}
export const TECH_TREE  // [{id, name, cost, requires:[], x, y (layout grid), parts:[partIds — derived from parts.js `tech`]}]
export const MILESTONES // [{id, title, desc, funds, science, rep}]
export const EXPERIMENTS // {id: {name, base, situations:[...], needsCrew?, eva?}}
export function situationOf(vessel) → situation id
```
Tech ids used by parts.js: start, basic_rocketry, general_construction, survivability, stability, propulsion, electrics,
heavy, landing, command2, miniature, advanced_propulsion. Sandbox mode: everything unlocked, infinite funds.

## Rendering modules (js/render)

- `partmesh.js`: `buildPartMesh(def, {ghost=false}) → THREE.Group` centred on the part centre, axis +Y; radial parts
  have "outward" = +X with their mount face at x = −rw/2. `setPartState(group, {deployed, throttle, ignited, temp})` animates
  legs/solar/chute canopy/engine glow. `buildPipMesh()`; `renderPartThumbnail(renderer, def, size) → dataURL`.
- `planetgfx.js`: `createBodyVisual(body, {quality}) → {group, update(t, sunDir)}` (textured sphere from `body.surfaceColorAt`,
  atmosphere halo, star glow), `createTerrainPatch(body)` (high-detail local ground around the camera, in body-fixed coords,
  recentred as the vessel moves; see flight notes), `createStarfield()`, `createLaunchPad()`, `skyColor(body, alt, sunElevation)`.
- `fx.js`: exhaust plumes, smoke puffs, explosions, re-entry glow.

## Screens (js/ui)

`main.js` owns one `WebGLRenderer` (`logarithmicDepthBuffer: true`, antialias) on `<canvas id="gl">`, a DOM overlay root
`<div id="ui">`, the `Career`, and a screen stack. Every screen module exports `createXScreen(app)` returning
`{ enter(params), exit(), update(dt), render(), resize(w, h) }`. `app = { renderer, uiRoot, career, input, audio, goto(name, params), toast(text), save() }`.
Screens: `hub` (space centre menu), `builder`, `flight` (includes map view toggle), `research`, `missions`, `crew`, `tracking`.

Input (`js/ui/input.js`): `input.down(code)` (KeyboardEvent.code), `input.pressed(code)` (edge, cleared each frame),
mouse buttons/drag/wheel callbacks. Must work with a Mac keyboard and a Logitech MX mouse: wheel zoom (smooth, handles
high-resolution wheels), right-drag to orbit the camera (context menu suppressed), middle-drag to pan, mouse
back/forward buttons must not navigate the page.

Flight keys: W/S pitch, A/D yaw, Q/E roll, Shift/Ctrl throttle up/down, Z full, X cut, Space stage, T SAS, R RCS,
G legs, U solar panels, M map, comma/period time warp down/up, slash stop warp, V camera mode, [ ] switch vessel,
F5 or Shift+K quicksave, F9 or Shift+L quickload, Esc pause menu, H/N/I/K/J/L RCS translate, C toggles navball speed mode.

## Testing

- `npm test` → `node --test tests/unit/` (pure sim: orbit maths, patched conics, craft staging/dv, vessel physics,
  full scripted flights: launch → orbit, Pell transfer, re-entry and landing; career logic).
- `npm run test:e2e` → Playwright (Chromium is preinstalled in CI; `require('playwright')` works) drives the real game in a
  browser: loads a stock craft, launches, flies with scripted key presses, opens the map, places a maneuver node, checks HUD
  values and that there are no console errors. The game exposes `window.__sw = { app, world, career }` for tests.

## Additions (round 2: targeting and docking)

Everything below is additive; old fields and private names keep working.

### Public accessors (use these instead of private fields)

| old (private)        | new (public, read-only)                                             |
|----------------------|---------------------------------------------------------------------|
| `vessel._list`       | `vessel.partList` (array of live parts)                             |
| `vessel._engines`    | `vessel.engines`                                                    |
| `vessel._legs`       | `vessel.legParts`                                                   |
| `vessel._solar`      | `vessel.solarParts`                                                 |
| `vessel._rcs`        | `vessel.rcsParts`                                                   |
| `vessel._chutes`     | `vessel.chuteParts`                                                 |
| `vessel._commands`   | `vessel.commandParts`                                               |
| —                    | `vessel.dockPorts` (parts whose def has `dock`)                     |
| `vessel._bound`      | `vessel.boundRadius` (m, bounding sphere about the CoM)             |
| `vessel._baseR`      | `vessel.baseRadius`, `vessel._baseH` → `vessel.baseHeight`          |
| `vessel._hot`        | `vessel.isHot`                                                      |
| `vessel._stamp`      | `vessel.motionStamp`; `vessel.structureStamp` increments whenever the part set changes (stage, break, dock, undock) — rebuild meshes on it |
| `vessel._rcsThrust`  | `vessel.rcsThrust`                                                  |
| `world._remove(v)`   | `world.removeVessel(v)` (also clears `world.active` if it was `v`)  |

### Targeting

- `world.setTarget(vessel, target) → bool` — `target` is a Vessel, a Body, a vessel id (number), a body id (string) or `null`.
  Stored as `vessel.targetId` (serialised). Emits `target {vessel, target}`.
- `world.getTarget(vessel) → Vessel | Body | null`.
- `vessel.targetInfo` (refreshed every step, `null` without a target):
  `{ name, kind: 'vessel'|'body', id, distance (m), relSpeed (m/s), closing (m/s, + = approaching), relVel (Vector3, own − target),
  dir (unit Vector3 to the target), relPos (Vector3) }`, all in the vessel's body-inertial axes. Bodies are valid targets.
- A target that disappears is cleared: `target {vessel, target: null}` and, for the active vessel, `message {text: 'Target lost'}`.
- SAS modes added to `SAS_MODES`: `target`, `antiTarget`, `relPrograde` (along own − target velocity), `relRetrograde`.
  Relative modes hold attitude when the relative speed is below 0.02 m/s.
- `closestApproach(orbitA, orbitB, tStart, tEnd, samples = 0) → { t, distance, relSpeed }` in `trajectory.js`
  (both orbits around the same body; sampled, then golden-section refined).

### Map view (`js/ui/mapview.js`)

- A plain click on a vessel or body marker selects it (`map.select(obj|null)`, `map.selection`); the selection panel
  (`.map-sel`) has **Set as target** (`[data-map="set-target"]`, calls `world.setTarget(world.active, obj)`, falling back
  to `active.targetId = obj.id` on worlds without it) and **Focus**. Clicking empty space deselects.
- The target panel (`.map-target`) shows distance, relative speed (from `targetInfo` when present), the closest approach
  on the current trajectory and "After burn" for the last planned one; **Clear target** is `[data-map="clear-target"]`.
- The target's orbit / trajectory is drawn in orchid (`#e879f9`) with a ring on its marker.
- Closest-approach markers (`Closest approach 2.30 km · 4.1 m/s in 12m 07s`) are placed on the active vessel's current
  trajectory and on every planned (non-zero) maneuver chain: for vessel targets around the same body, and for body
  targets orbiting the same parent when the chain does not enter that body's SOI (then the SOI markers apply).
  Search window: from now (or the node) to one period of the longer orbit, the patch end, or the next node.
- `map.debug()` gained `target`, `selection`, `approaches[] {chain, t, distance, relSpeed, x, y, visible}`, `vessels[]`.
- `tests/map-preview.html?target=1` adds "Harbor Station"; the fake world implements `setTarget/getTarget`.

### Docking

- Parts (`parts.js`): `dock_m` "Latch Ring M" (1.25 m, tech `command2`) and `dock_s` "Latch Ring S" (0.625 m, tech
  `miniature`); `def.dock = { size: 'M'|'S' }`, `shape: 'dock'` (mesh in `partmesh.js`: white collar, amber capture
  ring, teal guide petals). A port is usable on whichever stack face is free; only equal sizes mate.
- Per-part state: `part.flip` (bool: the part is upside-down in the craft frame — orientation = yaw(`rot`) · flipX(π);
  renderers must honour it), `part.dockedTo` (id of the mated port or `null`), `part.dockName` / `dockType` (name and type of
  the absorbed vessel, restored on undock), `part._face` (+1 / −1 free face along local Y, 0 = none).
- `DOCKING` (exported from `world.js`): `CAPTURE 0.25 m`, `ASSIST 0.6 m`, `MAX_SPEED 1.5 m/s`, `MAX_ANGLE 15°`,
  `ASSIST_K`, `ASSIST_C`, `REARM 1.0 m`, `UNDOCK_SPEED 0.3 m/s`.
- Each physics step, free ports of different loaded, non-landed vessels are compared: within `ASSIST` with facing axes
  (< `MAX_ANGLE`) and closing speed < `MAX_SPEED` a soft spring/damper pulls them together; within `CAPTURE` they dock.
- Docking merges the second vessel into the main one (the active vessel, else a ship, else the heavier):
  `vessel.absorb(other, myPort, otherPort) → { idMap, portId, otherPortId }` re-expresses the other vessel's parts in
  the main craft frame (ids are offset past the main vessel's max id), conserves linear and angular momentum, appends
  stages, merges science, and marks `other.dead = true; other.absorbedInto = main`.
  Event: `dock { vessel, absorbed, parts: [mainPortId, absorbedPortNewId], idMap }`. Other vessels targeting the
  absorbed one are retargeted.
- `world.undock(vessel, partId) → Vessel | null` splits at that port (the side without the control part becomes a new
  vessel named after `dockName`), pushes the halves apart at `UNDOCK_SPEED`; event `undock { vessel, other, parts }`.
  The pair cannot re-capture until the ports have been more than `REARM` apart. `vessel.undockPort(partId, pushSpeed)`
  is the low-level call; `vessel.dockedPairs → [[portA, portB], …]`.
- Resources flow through mated ports like any stack joint (engines of the merged vessel can draw from both sides).
  `vessel.transferResource(fromPartId, toPartId, resource, amount = Infinity) → amount moved` works between any two
  parts of one vessel (not solid fuel, ablator or EVA fuel).
- Helpers: `vessel.portWorld(port, outPos, outAxis)` (port face position / outward axis, body-inertial),
  `vessel.pointVelocity(x, y, z, out)`.
- `toJSON/fromJSON` carry `flip`, `dockedTo`, `dockName`, `dockType`, `dockReady`, `targetId`; a docked assembly
  round-trips and can be undocked after loading.
- `world.removeVessel(v)`; an unloaded vessel destroyed on rails (atmosphere / impact) now emits
  `message { text, vessel, reason, kind: 'removed' }`.

### Autopilot (`autopilot.js`, used by tests and available to the game)

- `planRendezvous(world, vessel, target, opts) → { node, dv, approach } | null` — Hohmann-style phasing plan
  (near-circular, near-coplanar orbits around the same body).
- `rendezvous(world, vessel, target, opts = { distance: 100, useWarp: true, maxApproachSpeed: 12, offset: 15000 })` —
  phasing wait, transfer burn, mid-course correction, braking (SAS `relRetrograde`), closed-loop approach; ends at
  about `distance` metres with < 0.3 m/s relative speed. `c.result = { distance, relSpeed, dvUsed }`.
- `dockingApproach(world, vessel, target, opts = { portId, targetPortId, standoff, maxSpeed: 3, timeout: 3600 })` —
  RCS translation in the target port's frame (phases clear → forward → align → final) while SAS points the own port at
  the target port; finishes on the `dock` event. Needs RCS. `c.result = { portId, time }`.

### Stock crafts (`craft.js`)

- "Latch Target" (uncrewed station core with a `dock_s` on the nose) and "Latch Chaser" (crewed, `dock_s` nose, RCS,
  2 radial Ember boosters, ≈ 4.7 km/s vacuum Δv). "Mote Sounder" was rebuilt so it flies straight and lands under its chute.

### Tests

- `tests/unit/docking.test.js` (parts, accessors, closest approach, targeting, SAS modes, capture rules, merge
  invariants, undock, save/load, transfer, rendezvous, docking approach, second launch, Mote Sounder).
- `tests/unit/flights.test.js` "flight 4": launch the station, launch the chaser, rendezvous, dock, save/load,
  transfer fuel, undock, deorbit and land (prints the flight log).
- `tests/e2e/mapview.mjs` section 12: target selection and closest-approach markers.

### Known limits

- No vessel–vessel collision: ports that meet too fast or misaligned pass through each other.
- The capture assist acts on the centres of mass only (no torque); alignment is the pilot's / autopilot's job.
- No "control from here": a port's axis is always ± the craft Y axis, and the control part stays as built.
- `estimateDeltaV` ignores flipped engines; the absorbed vessel's maneuver nodes are dropped; landed vessels do not dock.

## Additions (second pass: worlds)

### The system (`js/core/bodies.js`)

19 bodies. The first release's eight keep their ids, names and numbers exactly. `SYSTEM.bodies` order:

| id | parent | radius (m) | surface g | orbit a (m), e, i° | atmosphere (height, scale, rho0) | character |
|---|---|---|---|---|---|---|
| helion | — | 2.2e8 | — | — | — | star |
| sear | helion | 1.5e5 | 2.0 | 3.4e9, 0.06, 3.5 | — | tidally locked lava world: molten sea under permanent noon |
| cindra | helion | 2.5e5 | 2.8 | 6.2e9, 0.18, 6 | — | scorched, cratered |
| murk | helion | 5.4e5 | 8.4 | 9.9e9, 0.015, 2.2 | 110000, 6500, 60 (≈ 49 atm) | crushing ochre atmosphere, shield volcanoes |
| verda | helion | 6.4e5 | 9.6 | 1.36e10, 0, 0 | 72000, 5800, 1.22, **oxygen** | home, oceans (`seaLevel` −3 m) |
| pell | verda | 2.1e5 | 1.6 | 1.25e7, 0, 0 | — | grey maria and cratered uplands |
| ost | verda | 7.0e4 | 0.5 | 4.4e7, 0.08, 5.5 | — | small ice moon with rifts |
| rusk | helion | 3.6e5 | 3.2 | 2.05e10, 0.05, 1.5 | 45000, 6500, 0.25 | red desert: dunes, mesas, canyon maze |
| dray | rusk | 3.2e4 | 0.22 | 5.5e6, 0.02, 1 | — | lumpy grooved moonlet |
| thal | helion | 5.2e6 | 8.5 | 6.8e10, 0.04, 1.2 | 400000, 40000, 3.0 | teal/violet gas giant |
| tiv | thal | 4.0e5 | 2.2 | 3.2e7, 0.01, 0.5 | — | sulfur flats, vent cones, flat brimstone lakes |
| marn | thal | 3.1e5 | 2.9 | 9.0e7, 0.02, 1.8 | 38000, 5200, 0.85, **oxygen** | cold moon with air: lichen steppe, frozen lakes |
| slate | thal | 2.6e5 | 1.5 | 2.3e8, 0.03, 3 | — | dark, canyon chains, 1.4 km fault scarps |
| nock | thal | 8.5e3 | 0.05 | 6.5e8, 0.28, 31 | — | tiny captured rock |
| orrin | helion | 4.3e6 | 7.2 | 1.3e11, 0.05, 2.4 | 350000, 36000, 2.2 | ringed amber gas giant (`ring`) |
| brim | orrin | 2.4e5 | 1.35 | 2.6e7, 0.01, 0.3 | — | ice-shell ocean moon (`ocean`, open leads of water) |
| quell | helion | 1.4e5 | 0.75 | 2.3e11, 0.21, 12 | — | distant dwarf, mutually locked with Nym |
| nym | quell | 5.5e4 | 0.2 | 3.2e6, 0, 0 | — | Quell's companion |
| wend | helion | 6.5e3 | 0.03 | 4.4e10, 0.70, 24 | — | comet (`comet: true`); crosses the orbits of Rusk and Thal but never comes within 3 SOI radii of another body's path |

New `Body` fields and methods (all pure, allocation-free, deterministic):

```js
body.atmo.oxygen        // bool: jets work (Verda and Marn only)
body.seaLevel           // m relative to radius; liquid surface of an ocean world (Verda −3, Brim 0)
body.ring               // null | { inner, outer } metres from the centre, in the equatorial (XZ) plane
body.comet              // bool
body.blurb              // one-line description for tracking station / map
body.minElevation, body.maxElevation   // bounds of terrainHeight over the whole body (0, 0 for star and gas giants)
body.tidal              // bool (existing)
body.sites, body.launchSite            // home world only, else null

body.terrainHeight(dirBodyFixed, lod = 0) → metres above body.radius
    // The single source of truth for the ground: physics and the terrain renderer both call it.
    // dir need not be normalised. lod (metres) drops relief finer than that, for coarse meshes; physics uses 0.
    // 0 for the star and gas giants. Sea bed is below seaLevel on ocean worlds. About 2 to 6 µs per call.
body.surfaceHeight(dir) → max(terrain, seaLevel) on ocean worlds, else terrainHeight
body.isWater(dir)       → ocean && terrainHeight < seaLevel   (agrees with biomeAt(dir).water except within metres of a shore)
body.terrainNormal(dir, out?, eps = 2) → outward unit normal of the ground, body-fixed, central differences over eps metres
```

Launch sites on the home world (`SYSTEM.sites === SYSTEM.home.sites`, `SYSTEM.launchSite === sites.pad`):

```js
sites.pad    = { lat: 0, lon: 0, dir: (1,0,0), name }
sites.runway = { lat, lon, dir,            // the WEST threshold, where a vessel starts its roll: 1500 m west, 850 m south of the pad
                 heading: 90, length: 1600, width: 60, name,
                 center: { lat, lon, dir } }   // 700 m west, 850 m south of the pad
```

Guarantees around the base (tested in `tests/unit/bodies.test.js`): `terrainHeight` is exactly 0 everywhere within 3 km
of the pad (so the pad and runway sit at `radius`, as before); the shore runs north–south 3.1 to 3.5 km east of the pad,
with a beach that slopes at most 1 in 4 into the sea; open water east of that for at least 50 km; dry land rising into
hills (about 200 m by 10 km) to the west, north and south. In the space-centre local frame (+X east, +Z south) a
point (x, z) metres from the pad is `home.dirFromLatLon(-z / R, x / R)`.

### World graphics (`js/render/planetgfx.js` and its neighbours)

`planetgfx.js` is the public face; every export of the first release still works (`createBodyVisual`,
`createTerrainPatch`, `createStarfield`, `skyColor`, `createLaunchPad`, `createFlagMesh`, `bakeBodyTexture`,
`bakeBodyTextureAsync`, `clearBakeCache`). New modules behind it:

| file | what |
|---|---|
| `worlds.js` | `createWorldRenderer`: the whole outside world for a scene with a floating origin |
| `terrain.js`, `terrainmesh.js` | chunked level-of-detail terrain (quadtree on a cube-sphere) built from `Body.terrainHeight` |
| `globe.js` | `createBodyVisual`: a whole body on a unit sphere (maps, clouds, ocean glint, rings, atmosphere shell, star glare) |
| `atmosphere.js` | the scattering model, as GLSL (`ATMO_GLSL`) and as the same maths in JS (`skyAt`, `sunTransmit`, `skyColor`) |
| `sky.js` | `createStarfield`: point stars + galactic band and nebulae (baked once into a cube map) |
| `scatter.js` | instanced rocks, grass tufts and trees near the camera. Boulder placement comes from `js/core/boulders.js`, which the physics also collides with ([BOULDERS.md](BOULDERS.md)) |
| `bodytex.js`, `bodybake.js` | baked colour / relief / glow / cloud / ring maps per body, cached, made by workers |
| `workpool.js`, `terrainworker.js` | pool of module workers (falls back to time-sliced work on the main thread) |
| `worldstyle.js` | per-body look: rock colour, strata, lava glow, clouds, water colours, snow line, clutter |
| `worldshaders.js` | terrain, globe and atmosphere-shell shaders, the tiling detail texture |
| `surfacefeatures.js` | walking-scale craters, cracks and ripples per world, drawn by the terrain shader ([WORLDS.md](WORLDS.md)) |

All shaders light themselves from a sun direction (no scene lights needed), include the logarithmic-depth,
tone-mapping and colour-space chunks, and so follow the renderer contract whether they draw to the canvas or into the
post chain's HDR target.

#### `createWorldRenderer` (flight scene, and any scene that wants the real planet)

```js
import { createWorldRenderer } from '../render/planetgfx.js';      // alias: createWorldView

const worlds = createWorldRenderer({
  renderer,            // the game's WebGLRenderer
  scene,               // Scene or Group to add to (flight: the `far` scene)
  camera,              // the PerspectiveCamera that draws it
  system: SYSTEM,
  quality: 'high',     // 'low' | 'medium' | 'high'  (grid 32/32/40 per chunk, map size, clutter density; no clutter on low)
  farLimit: 5e7,       // bodies farther than this from the camera are drawn at this distance, proportionally smaller
  scatter: true,       // rocks / grass / trees near the camera
});

// every frame, after the camera has been positioned:
const info = worlds.update({
  ut,                  // universal time (s): positions and rotations of all bodies
  dt,                  // REAL seconds since the last frame (animates water and grass; independent of time warp)
  body,                // the Body whose SOI the camera is in: it gets terrain, ocean, clouds, sky
  origin,              // Vector3: where the scene origin is, relative to `body`'s centre, inertial axes, metres.
                       //   With a floating origin this is simply the followed vessel's position (anchor.pos).
  orient,              // optional Quaternion, inertial axes → scene axes (omit when the scene is inertial, as in flight)
  sync,                // optional ms of chunk building allowed on this thread; by default 350 ms on the first frame
                       //   at a body or after the camera jumps, 0 otherwise (workers do the rest)
});
```

`worlds.info` (also the return value of `update`), all in scene axes and linear colour:

```js
{ body, altitude,                   // camera height above the datum radius (m)
  sunDir: Vector3,                  // unit vector from the body toward the star
  sunElevation,                     // rad above the camera's horizon
  sunColor: Color,                  // direct sunlight at the camera after the air: white in space, orange at sunset.
                                    //   Multiply the vessel's sun light colour by it.
  skyZenith: Color, skyHorizon: Color, skyLum,   // sky radiance at the camera (0 in vacuum and at night)
  ambient: Color,                   // suggested hemisphere / ambient colour for vessels
  starOpacity,                      // 0 in daylight … 1 in space
  chunks, drawn, triangles, pending, drawCalls,  // terrain cost this frame
  busy }                            // true while chunks for this view or this body's maps are still being made
```

Other members: `worlds.group` (everything it added), `worlds.get(body) → { vis, terrain, clouds, scatter }`,
`worlds.frameAt(body, dirBodyFixed, ut, height = 0) → { origin, orient }` (a ground-fixed scene: origin on the surface
point, +Y up, +X east, +Z south; spread it into `update`), `worlds.settle(ms)`, `worlds.dispose()`.

What it draws: stars and galaxy (faded by sky brightness), the star with glare (reddened by the air it is seen
through), every body as a globe when it is more than a pixel across and as a lit point otherwise, and for `body`:
terrain chunks, the ocean (in the terrain shader: vertices below `seaLevel` are raised to it, so the water surface is
exactly where `surfaceHeight` says), cloud deck, clutter, and the atmosphere shell (limb glow from space, the sky from
inside, aerial perspective on the ground).

Draw order uses `renderOrder`: stars −11/−10 (no depth), globes −5, terrain 0, glare and points 1, clouds 2,
atmosphere shell 3 (transparent, drawn after the opaque ground), rings 4. Keep vessel geometry in a later pass or scene.

Integration notes for the flight scene:

- Replace the legacy stars, haze dome, body visuals and terrain patch with one `createWorldRenderer` on the `far`
  scene; call `update({ ut, dt, body: anchor.body, origin: anchor.pos })`.
- The ground the player sees is `body.radius + body.terrainHeight(dir)`; the vessel shadow catcher should be placed at
  that height and tilted to `body.terrainNormal(dir)`.
- No terrain shadow map: chunks do not receive the vessel's shadow themselves (the catcher disc does that).
- Clutter is never placed within 3.08 km of the pad on the home world; that ground belongs to `basegfx.js`.
- `far` scene lights are no longer needed by anything this module draws.
- Gas giants and the star have no terrain: the globe is the body (`worlds.get(body).terrain === null`).

#### `createBodyVisual(body, { quality })` (map view, tracking station, hub sky)

Same contract as before (unit sphere; the caller sets `group.scale` and `group.position` and calls
`update(ut, sunDirWorld)`), now self-lit with baked maps, ocean glint, animated cloud deck with shadows, night side with
a little fill, lava glow, rings with planet shadow (`vis.rings`), a scattering atmosphere shell (`vis.atmosphere`) and
the star's glare. Extra members: `setSunTint(color)`, `setOpacity(o)`. `setTextureSize(w, h)` still returns a
Promise and now asks the worker pool for maps of at least that size.

#### Atmosphere helpers

```js
skyAt(body, altitude, sunElevation, out?) → { zenith: [r,g,b], horizon: [r,g,b], sun: [r,g,b], lum }   // linear
sunTransmit(body, posUnit, sunDir, out?)  → [r,g,b]    // colour of direct sunlight at a point (unit-sphere space)
skyColor(body, altitude, sunElevation, out?) → THREE.Color   // as in the first release, now from the same model
atmoParams(body) → { top, hs, betaR, betaE, betaM, g, ms, tint, tau } | null     // betaR scatters, betaE extinguishes
```

#### Preview

`node tests/e2e/preview_worlds.mjs [filter] [--size=1024x768] [--quick]` renders every body from orbit, low orbit, 5 km and
eye height at noon and low sun, the Verda sky at day / dusk / night and the base site, into `tests/out/worlds_*.png`,
and prints draw calls and triangles per view. The page behind it is `tests/worlds-preview.html`
(`?body=verda&view=ground&sun=6`; views: orbit, low, air, ground, base, coast, sky).

## Additions (second pass: core)

For the UI and render code. Everything from earlier rounds still works unchanged; this section lists what is
new in `vessel.js, world.js, craft.js, autopilot.js, career.js, contracts.js`. Unit tests: `tests/unit/secondpass.test.js`
(features) and `tests/unit/flights.test.js` flights 5-7 (aeroplane circuit, rover drive, Verda → Rusk → Dray landing).

### Frames for aeroplanes and rovers
Parts are still built along the stack axis (+Y = nose). A wheeled vehicle travels along **+Y**, its top is **+Z**
and its right side **+X**; wheels therefore hang toward **−Z**. In craft terms a radial angle `a` points outward
along `(cos a, 0, −sin a)`, so `a = π/2` is the belly (wheels), `a = −π/2` the back (rudder, solar tiles) and
`a = 0 / π` the right / left wing roots. `World.vehicleFrame(dir, headingDeg)` gives the quaternion that sets such a
vehicle on the ground pointing along a compass heading. Control axes are unchanged: `ctrl.pitch` + = nose toward
+Z (nose up for an aeroplane), `ctrl.roll` + = right wing down, `ctrl.yaw` + = nose right.

### New control inputs (`vessel.ctrl`)
`brake` (bool: wheel brakes; the parking brake is on after a runway launch), `drive` (−1…1, powered wheels;
when 0 the throttle-less W/S keys should write it), `steer` (−1…1; when 0 the wheels follow `yaw`), `lights` (bool,
mirror of `setLights`). `vessel.driveInput()` is what the wheels actually use.

### Vessel: wings, wheels, deployables
- Lift: every part with `def.wing` (and fins) lifts with `wingCoefficients(aoa, slope, stall)` → `[CL, CD]`, stalls,
  and control surfaces (`wing.control`) deflect with pitch/roll/yaw according to where they sit. Helpers (exported):
  `flightAngles(v)` → `{pitch, heading, roll, aoa, slip, track, climb, speed}` (rad, m/s; for the HUD's attitude
  indicator), `stallSpeed(v)`, `wingLoading(v)` → `{area, k}`, `liftArea(def)`, `liftSlope(def)`.
  `vessel.ctrlAccel` = `{x, y, z}` rad/s² of control authority at full command (autopilot gain scheduling).
- Wheels: `vessel.wheelParts`; each has `deployed` (gear down), `_steer` (rad, current steering angle), `_spin`
  (rad/s), `_load` (N). The tyre's lowest point (suspension unloaded) in the craft frame is `(pos.x, pos.y, pos.z − ext)`
  with `ext = max(wheel.radius, −outward.z × def.rw / 2)` — draw the wheel so its bottom is there, axle along X,
  rolling along Y, whatever the radial angle the part was attached at; suspension travel is `wheel.travel` (default
  0.6 × radius).
  `vessel.wheelsOnGround`, `setGear(down)/toggleGear()/gearDown/hasGear` (legs and retractable wheels together),
  `setBrakes(on)/toggleBrakes()` (wheel brakes + air brakes: the B key). Braking force is capped at
  `TUNING.WHEEL_BRAKE_MU` × wheel load so a hard stop does not somersault the vehicle. A hull part of a vehicle
  rolling on its wheels that brushes the ground is judged mostly by its sink rate (a scrape, not a crash).
- Engines: `engineProp(def)` → `'fuel' | 'solid' | 'xenon'`; jets (`engine.type === 'jet'`) use
  `jetFactor(def, body, alt, mach)` and only run where `hasOxygen(body)`; ion engines burn `xenon` and
  `engine.elecUse` EC/s; `xenon` is a normal resource (`vessel.resources.xenon`, `transferResource`, save/load,
  `Craft.stats()`, `vessel.deltaV`). Jets add no vacuum delta-v; `Craft.stats()[i].jetThrust` reports them.
- Deployables: `solarParts` (tracking panels turn to the sun, fixed ones (`solar.fixed`) take cosine losses;
  `setSolar/toggleSolar/solarOut`; output scales with `vessel.sunScale` = (home orbit radius / distance)², zero when
  `!vessel.sunlit`), generators (`def.generator.rate`, always on), `lightParts` + `setLights/toggleLights/lightsOn`
  (lamps draw charge; `p.deployed` = lit), `airbrakeParts` + `setAirbrakes/airbrakesOut`, `labParts`,
  `antennaParts`, `ladderParts`. `vessel.sunDir` (unit, inertial) is there for the renderer.
- Science lab: `processLabs(dt)` runs inside `simulate` (and on rails): a crewed, powered lab works through
  `vessel.science`; each record gets `lab` (0…1 progress) and at 1 a `bonus` (extra fraction of its value, paid by
  `career.creditRecord`). Event `labDone {vessel, record}`.
- Events new in the stream: `splashed {vessel, speed}` (water landing, like `landed`), `rollout {vessel}` (a wheeled
  vehicle drove off: the ground equivalent of `liftoff`), `actionGroup {vessel, group, count}`,
  `action {vessel, part, action}` (group actions the World carries out: `runExperiment`, `undock`), `labDone`,
  `transmit {vessel, record}`, `ladder {vessel (the Pip), on, part, grabbed}`.
- `landed` vs `grounded`: `grounded` is true while anything touches the ground or water; after ~1 s of quiet the
  vessel is pinned and `landed` becomes true (`pinToGround`), which is when high time warp is allowed and when it
  rides the planet's rotation exactly. Any thrust, drive input, released brake on a slope or collision wakes it
  (`wake()`). `vessel.situation` reads `'landed'`/`'splashed'` in both states. `vessel.surface.slope` is the local
  ground slope (rise/run), `surface.vehicle` true for a vehicle on its wheels. `vessel.launchSite` is `'pad'` or
  `'runway'`; `vessel.stranded` marks a rescue target.

### Action groups
`ACTION_GROUPS` = `'1'…'9', 'gear', 'lights', 'brakes', 'abort'`. `partActions(def)` → `[{id, label}]` a part offers
(`toggleEngine, activateEngine, shutdownEngine, deployChute, cutChute, decouple, toggleLegs, toggleGear,
toggleSolar, toggleLight, toggleAirbrake, runExperiment, undock`).
- In the builder: `craft.actionGroups` (saved in `toJSON`), `craft.actionsOf(partId)`, `craft.groupActions(group)` →
  `[{partId, action}]`, `craft.setAction(group, partId, action, symmetry = true)` → bool,
  `craft.clearAction(group, partId, action?)`, `craft.clearGroup(group)`. Removing a part prunes its bindings.
- In flight: `world.fireGroup(name, vessel = active)` → number of actions done (use this one: it also carries out
  `runExperiment`/`undock`); `vessel.fireGroup`, `vessel.doAction(partId, action)`, `vessel.setGroupAction(group,
  partId, action | null)`. Named groups with nothing bound have defaults: gear → legs + gear, lights → all lamps,
  brakes → wheel + air brakes, abort → throttle 0 and every liquid engine off. Groups survive staging, docking
  (merged) and save/load.

### World
- `world.sites` → `{pad, runway}` from `SYSTEM.sites`; `world.launch(craft, {crew, site: 'pad' | 'runway'})`: on the
  runway the vessel stands on its wheels at the west threshold facing east (heading 90°), parking brake on.
  `stockSite(craft)` (craft.js) says where a stock design belongs. `world.recover(v)` now returns `summary.site`
  (nearest site) and measures `distance` from it; a stopped vehicle counts as landed.
- Science and comms: `world.runExperiment` refuses experiments that make no sense (`experimentAllowed`) and
  stores `biome` on surface/low-flight records. `world.canTransmit(v)` → `{ok, reason: null | 'antenna' | 'power'
  | 'range', distance, range, rate}`, `world.transmit(v, recordOrIndex)` → the record (removed from the vessel,
  `TRANSMIT_EC` charge spent) or null; credit it with `career.creditRecord(rec, 0.5, crew)`. Range = the better of
  the vessel's best antenna (`antennaRange(def)`) and `world.commGroundRange` (set it from
  `career.limitOf('tracking')`). `vessel.commLink / commRange / commDistance` are refreshed every step;
  `world.homeDistance(v)`.
- EVA: works on every solid body (walk, jump, jetpack via `ctrl.tx/ty/tz` + `ctrl.rcs`, flags, samples).
  Ladders: `world.ladderNear(pip)` → `{vessel, part} | null` (show a "grab" prompt), `world.evaGrab(pip)`,
  `world.evaLetGo(pip)`; while `pip.ladder` is set, `ctrl.ty` (or `tz`) climbs up/down at `TUNING.LADDER_SPEED`.
- `world.spawnStranded({bodyId, alt, name})` → a dead pod with one Pip in orbit (rescue contracts spawn theirs
  automatically). `World.vehicleFrame(dir, headingDeg)`.

### Craft (builder helpers)
`craft.centerOfMass(fuel = 1)` → `{x, y, z, mass}` (pass 0 for empty tanks), `craft.centerOfLift()` →
`{x, y, z, area, liftZ, liftX}` or null, `craft.centerOfThrust(stage = null)` → `{x, y, z, thrust, dir}` or null:
draw the three markers; for a stable aeroplane the lift marker sits a little behind the mass marker (with both
full and empty tanks). `validate()` warns when a winged craft has its lift ahead of its mass and when ion engines have no
xenon; a winged craft is not told off for a thrust-to-weight below 1. `craft.js` now imports `vessel.js` (for the lift helpers).
`stockCrafts()` returns sixteen designs: the seven of the first pass plus **Kite Trainer** (jet trainer),
**Skimmer** (rocket plane), **Trundle Scout** (rover), **Trundle Lander** (rover on a descent stage and launcher),
**Colossus** (heavy lifter with a tanker payload), **Farwind** (three-stage interplanetary ship with a crewed
lander), **Whisper Probe** (ion probe), **Hearthstone Core** (station core) and **Moonstep** (two-seat lander for
small moons, no launcher). A design whose parts are missing from `PARTS` is skipped.

### Autopilot (`autopilot.js`)
All are controllers for `AP.fly(world, ctl, opts)` or for the UI to tick (`ctl.update()` once per step; `ctl.done`,
`ctl.failed`, `ctl.log`, `ctl.phase`), like the existing ones.
- Aeroplanes: `runwayFrame(site?, {reverse})`, `siteCoords(frame, vessel, ut)` → `{along, cross, alt}`,
  `planeTakeoff(world, v, {altitude, heading, climb, speed})`, `planeCruise(world, v, {altitude, heading | waypoint,
  speed | throttle, duration | distance | until})`, `planeLand(world, v, {site, reverse, slope, speed, final, aim})`
  (`ctl.touchdown` = `{speed, sink, along}`), and the inner loops `planeHold(v, st, {pitch | climb | altitude, bank |
  heading, speed | throttle}, dt)` / `planeAttitude` if the UI wants a "wing leveller".
- Rovers: `roverDrive(world, v, {distance, heading, speed, brakeAtEnd})` (`ctl.driven`).
- Interplanetary: `transferWindow(from, to, t0)` → `{t, wait, tof, phase, phaseNow, synodic, vInfDepart,
  vInfArrive, outward, dir, ejectionDv(r0), ejectionAngle(r0), captureDv(r0)}` for two bodies sharing a parent
  (planet → planet or moon → moon); show `wait` and `phaseNow` vs `phase` in the map view.
  `planInterplanetary(world, v, target, {periapsis, planar, slack})` adds the ejection node (it scans whole orbits
  around the window, then targets with delta-v and a normal component); `planar: true` leaves the target's orbital
  tilt to a cheaper mid-course burn: `planCorrection(world, v, target, {periapsis, seek: true, horizon})` (the old
  function, which now also closes a near miss and may use the normal direction). `planMatchPlane(world, v, target)`
  adds a node at the cheaper plane crossing (needed before `planHohmannToMoon` when arriving from another planet).
  `predictAerobrake(world, v)` → `{enters, periapsis, speedIn, speedOut, dv, outcome: 'none' | 'capture' | 'flyby' |
  'landing', apoapsis, maxQ, maxG}` (one pass, drag only; cheap enough for a map-view readout).
  The recipe that flight 7 proves: ascent → `planInterplanetary(planar)` → eject → coast 40 % of the way →
  `planCorrection(seek)` → capture at periapsis → `planMatchPlane(moon)` → circularise → `planHohmannToMoon` →
  `planCorrection` → circularise → `hoverslamLanding`.
- `hoverslamLanding` now holds a hover until sideways drift is gone in weak gravity and cuts the engine at first contact.

### Career (`career.js`, `SAVE_VERSION` 3)
- Saves of version 2 migrate on load (`Career.migrate`): they get every facility at its top level so nothing an
  old program could do is taken away; science logs and milestones carry over.
- Tech tree: a node for every `tech` id used in `parts.js` (27 nodes; each has `x, y, tier, parts`); a unit test fails
  if a part's tech is missing from the tree or a node unlocks nothing.
- Science: situations are unchanged (`landed, splashed, flyingLow, flyingHigh, spaceLow, spaceHigh`). Surface and
  low-flight science is per biome: `scienceKey(exp, body, situation, biome)`, `career.scienceValue(exp, body,
  situation, biome)` → `{key, full, earned, remaining, next, valid}`, `career.creditScience(exp, body, situation,
  fraction, crew, biome, bonus)`, `career.recordValue(rec)`, `career.creditRecord(rec, fraction, crew)` (use these
  two for stored records: they honour `rec.biome` and the lab `rec.bonus`). `BIOME_SITUATIONS`,
  `biomeSciMult(body, biome)`, `experimentAllowed(experimentId, body)`. Six new experiments are in `EXPERIMENTS`.
- Milestones are generated for every body from `SYSTEM`: ids `${bodyId}_${kind}` with `kind` in `MILESTONE_KINDS`
  (`flyby, orbit, landing, return, flag`; no landing on gas giants); the first-pass ids are kept.
  `milestoneFor(kind, body)`, `milestonesOf(body)`; each `{id, title, desc, funds, science, rep, bodyId, kind}`.
- Facilities (career mode only; sandbox and science mode have no limits): `FACILITIES` (`pad, hangar, runway,
  tracking, lab, crew`), `FACILITY_IDS`, `career.facilityLevel(id)` (1-based), `career.limitOf(id)`,
  `career.facilityLimits()` → `{maxMass (t), maxParts, maxRunwayMass (t), commRange (m), scienceBonus, maxCrew}`,
  `career.facilityInfo(id)` → `{id, name, desc, level, max, cost (null at the top), value, next, unit, limit}`,
  `career.upgradeFacility(id)` → `{ok, reason?: 'funds' | 'max' | 'unknown', cost}`, `career.checkLaunch(craft, site)` →
  `{ok}` or `{ok: false, reason: 'mass' | 'parts', limit, value}` (call it before `payLaunch`).
  `career.hire()` can now fail with `reason: 'quarters'`.

### Contracts (`contracts.js`)
New types alongside the old ones: `tourists` (carry N passengers to a situation and bring them home), `rescue`
(a stranded Pip is spawned in orbit when the contract is accepted; recover a vessel with them aboard and they
join the roster),
`rover` (objective kind `drive`: cover a distance on wheels on a body), `station` (objective kind `station`: a
docked-together vessel holding an orbit with the asked seats, power and an antenna), and `flag`/`satellite`/`explore` for every body of
the system. `capability(career)` gained `seats`, `wheels`, `docking`. Objective labels are ready to print.

## Additions (second pass: space centre and career screens)

### The Flight Center model (`js/render/basegfx.js`, `js/render/baseenv.js`)
`createBase()` returns, besides what it did before:
- `setDoor(id, open)`: `'hangar'` (the assembly building's high-bay door lifts) or `'spaceplane'` (the hangar doors
  fold back); `open` 0..1, the door glides there. Both start closed. The hub opens the door of the building that is
  hovered, focused or being entered.
- `setDisplay(mode)` / `display`: `'none'` (default: the pad is empty and the crawler is parked half-way along the
  crawlerway), `'rollout'` (a show rocket rides the crawler from the assembly building to the pad at walking pace,
  is handed to the pad, and the crawler drives home) or `'pad'` (the rocket stands on the pad at once). **The flight
  scene must leave this at `'none'`**: the pad is where the player's vessel stands. The hub asks for `'rollout'`
  when the program has a saved design and no flight in progress; the title screen shows `'pad'`.
- Named objects for tests and tools: `crawler`, `showRocket` (groups), `pips` (an `InstancedMesh` of walking Pips;
  absent at `quality: 'low'`), `door` meshes inside `building:hangar` and `building:spaceplane`, `traffic`, `cars`,
  the vegetation of `js/render/flora.js` (`trees:<species>:lod0 | lod1`, `trees:impostors`, `trees:blots`,
  `trees:driver`, `grass:near | far`; see "Additions (round 4: environment realism)").
- A contact-shade skirt (`ao` bucket, multiply-blended, not tone-mapped) is laid on the ground round every building.
- `baseenv.js` puts the sea at −3 m, the same as `SYSTEM.home.seaLevel`.

### Building interiors (`js/ui/interior.js`)
Research Lab, Mission Control, Crew Quarters, Flight School and Administration are screens "at" their building:
`interiorFrame(app, { name, building, title, code, subtitle, onBack, backLabel })` gives a screen root with the live
Flight Center behind it (the shared `getBaseView(app)` camera parks at that building and sways), a header with the
back button (`[data-action="back"]`, Esc), a plaque, a status lamp (`setStatus(text, tone)`) and the stats bar, and
`page` to fill with `.sw-ipanel` instrument panels (styles: the `.sw-interior` block of `css/career.css`). The screen
forwards `update(dt)`, `render()`, `resize(w, h)` and calls `dispose()` on exit. Without WebGL the frame is opaque
and everything still works. `partIcon(app, defOrId, size)` returns a small canvas with the real part mesh
(`partmesh.renderPartThumbnail`, cached, drawn a few per frame; `partIconsPending()` for tests).

### Administration (`js/ui/admin.js`, screen `admin`)
Registered by `js/ui/hub.js` (`app.screens.admin`). Facilities panel: one row per facility (`.sw-fac[data-facility]`)
with level pips, the limit now and after, and `[data-action="upgrade"]` (confirm → `career.upgradeFacility`; a
tracking upgrade is applied to a live `app.world.commGroundRange` at once). Program panel: ledger and
`[data-menu="controls" | "settings" | "save" | "export" | "title"]`. Settings panel: the same rows as the hub's
settings dialog (`settingsRows(app)` exported by `hub.js`): sound, **graphics** (`gfxQuality` low/medium/high,
`gfxShadows`, `gfxBloom` 0..1.5, `gfxLens`, `gfxShake` 0..1.5 as `[data-setting]` controls) and game options.
The key reference is one table, `CONTROL_GROUPS` / `controlsGrid()` in `js/ui/careerui.js`, shown by the hub's
Controls dialog and the Flight School's Controls page.

### Career effects
- `world.commGroundRange` is set from `career.limitOf('tracking')` when a flight starts (`js/ui/flight.js`), when the
  Tracking Station loads the world, and when the facility is upgraded.
- The launch dialog of the hub refuses a craft that `career.checkLaunch` rejects (too heavy for the pad or runway,
  too many parts for the hangar level) and says what to upgrade.
- Facility levels (career): pad 60 t / 250 t / no limit; hangar 45 / 120 parts / no limit. Every stock craft that a
  new program can afford fits level 1.
- `tourists` contracts carry `guests` (the number of seats to fill).

### Map view additions (`js/ui/mapview.js`)
- Focus bar: **Inner** (`[data-map="inner"]`, `map.focusInner()`) frames the star with the home world and its
  neighbouring orbits.
- Transfer panel: **Plan burn** (`[data-map="plan-transfer"]`, `map.planTransfer()`) asks the core planner for the
  departure burn (`planHohmannToMoon` for a moon of the body being orbited, `planInterplanetary` for a planet
  sharing the parent) and adds and selects the node. Shown only for the active vessel in a closed orbit with node
  editing on. The planet search can take a second or two; the button reads "Planning…" meanwhile.
- Labels keep clear of any element marked `data-map-avoid` beside the map root (the Tracking Station marks its side
  list and its detail card), as they already did for the map's own panels.
- Body visuals are created with `createBodyVisual(body, { quality: 'low', nightFill: 0.3 })`; a visual that does not
  know the option gets `setNightFill(0.3)` or, failing that, its `uFill` uniform lifted.

## Additions (second pass: flight integration)

What the flight screen and the simulation gained when the round-2 pieces were joined up. Files: `js/main.js`,
`js/ui/{flight, flightscene, flightcam, hud, navball}.js`, `js/render/fx.js`, `js/core/{vessel, world, autopilot}.js`.

### Launch sites and the clock
- `app.launch(craft, { crew, site })` and `app.goto('flight', { craft, crew, paid, site })`: `site` is `'pad'` or
  `'runway'` (default: `craft.site`, else the pad). The flight screen passes it to `world.launch`; on the runway it
  hands over the place the space-centre model draws (`createBase().runwayAnchor`), which `world.launch` accepts as a
  site record `{ dir (body-fixed), heading (deg) }` in place of a site name. Revert to launch returns to that site.
- Both launch paths (the hub's launch dialog through `app.launch`, and the builder's Launch button) ask
  `career.checkLaunch(craft, site)` first and refuse with a toast that names the limit.
- The mission clock (`vessel.launchUt`, HUD "T+") starts on the core event `rollout` as well as on `liftoff`.
- A new program starts at `NEW_GAME_UT` (16 950 s, exported by `main.js`): mid-morning at the space centre, so the
  pad has shadows. `Career.newGame()` itself still returns `ut = 0`; saves keep their own clock and need no migration.

### Part orientation, mass offset, pylons (`vessel.js`)
- `Vessel.fromCraft` copies the optional craft-part fields `flip`, `pitch`, `roll`. A part's attitude in craft axes
  is `Ry(rot) · Rx(flip ? π : 0) · Rz(pitch) · Rx(roll)` (same as `craft.js partQuat`). A tilted part
  (`part._tilt`) thrusts along its own +Y axis (side force and all three torques are applied), lifts along its own
  normal, and is drawn with that orientation by the flight scene. Wheels are the exception: they always stand
  upright under the craft. `flip / pitch / roll` are saved with the vessel.
- `def.comY` shifts the part's mass along its own axis; a capsule therefore floats and falls heat shield down.
- A pylon (`shape: 'pylon'`, ids `pylon_s`, `pylon_m`) is `attach.outer` without `def.decoupler`. Every place that
  separates, stages or offers a "decouple" action tests `def.decoupler`, never `attach.outer`.
- `vessel.transferCrew(name, partId)` moves a Pip to a free seat in another part (HUD: the ⇄ button on a portrait).
- `vessel.tailStrikeMargin(gearDown = false)` → radians the nose can still rise before something aft of the main
  gear touches the ground. `planeTakeoff`, the flare of `planeLand` and the manual pitch key use it. A scrape while
  rolling on the wheels costs the part that touched; only a hard slam (normal speed) breaks the whole craft.

### World and autopilot
- `world.maxWarpIndex()`: an automatic warp to a set time (`warpTo`, a maneuver, a transfer window) is not held back by a
  low orbit, as long as the orbit is closed and clear of the air and the ground (on rails it is exact at any rate).
- `planReturnFromMoon(world, vessel, { periapsis })` → `{ node, dv, periapsis, exitUt, arrivalUt, patches }` or null:
  the burn that leaves a moon against its motion so the path dips to the parent.

### Flight screen (`flight.js`)
- Guidance programs, shown by the HUD's **Autopilot** panel (`hud.togglePanel('guide')`, toolbar button
  `[data-tool="guide"]`, rows `[data-program="<id>"]`): `actions.programs()` → `[{ id, name, note, ok, why, on, plan }]`
  for the moment, `actions.runProgram(id)` starts one (or stops the running one). Ids that fly: `takeoff`, `hold`,
  `land` (aeroplanes), `drive` (rovers), `ascent`, `node` (warp to the next maneuver and burn it), `landhere`
  (airless worlds), `deorbit`. Ids that only add a maneuver node (`plan: true`): `circ`, `circlow`, `capmoon`,
  `transfer` (moon: `planHohmannToMoon`; planet: `planInterplanetary`), `plane`, `correct`, `return`. Any steering
  key hands control back. `state.assistKind` / `state.assistName` say what is running.
- Keys on wheels: W / S drive (the core reads `ctrl.pitch` as drive when the wheels carry the vehicle), A / D steer,
  B brakes while held (the BRK lamp locks them), G gear, U lamps and solar panels, 1–9 and Backspace action groups
  (`world.fireGroup`). Aeroplanes use the normal attitude keys.
- The map's first look stands on the craft's side of its world (`map.setView({ yaw })`), so a fresh suborbital arc
  is never hidden behind the planet.

### Flight scene (`flightscene.js`)
- `createBase()` is adopted with `setDisplay('none')` (the pad is the player's) at quality `'low'` when the graphics
  setting is low or a software rasteriser is detected, else `'high'`. `scene.softGL` / `scene.qualityName`: under
  software GL the scene runs a reduced `'soft'` profile unless `settings.gfxForce` is set, and the pause menu's
  Graphics page shows "Reduced (automatic)".
- Part state is driven every frame through `partmesh.setPartState` with `deployed, throttle, ignited, flameout,
  temp` and, where the part has them, `gimbal {x, z}`, `control` (surface deflection), `steer`, `spin`, `compress`
  (suspension), `light`. One plume per bell: `partmesh.nozzleExits(def)` → `fx.createPlume(def, exit)`.
  Debris is drawn with `quality: 'low'` meshes.
- Ground as drawn: within 25 m of the ground (and away from the space centre's own slab) a vessel is nudged by
  `worlds.heightAt(body, dir) − body.terrainHeight(dir)` (at most 2 m) so landers, rovers and Pips stand on the
  triangles on screen. The shadow catcher sits on that ground under the active vessel.
- Ground as drawn, on the space centre (round 3): the model stacks its paving above the terrain (terrain 0, slabs
  +3 to +7 cm, pad deck and markings up to +9 cm) because `polygonOffset` does nothing once the fragment shader
  writes depth, which it always does with the logarithmic depth buffer. Within 3 km of the pad a vessel below 25 m
  is lifted onto the topmost paving under it (`deckUnder`: one ray against the model's `slab / asphalt / concrete /
  mark` meshes, cached while the vessel stands still); `view.deck` is that height, `view.lift` what was applied.
  The engine light pool and the lamp pool lie `view.deck` + 6 to 7 cm up; the flat shadow catcher is not drawn on
  paving (the model receives the shadow itself). Flags are moved to the drawn terrain like vessels. The launch
  site is placed BEFORE the vessels each frame so these lookups use this frame's model matrix.
- `render()`: never call `renderer.setViewport()` while a render target is bound: it takes CSS pixels and
  multiplies by the pixel ratio. Set `rt.viewport` and bind the target (round 3: on a ratio-2 display the far scene
  was drawn at twice the size while the near scene was not).
- Under an open parachute the camera aim rises and backs off so the canopy stays in frame (`cam.goal`,
  `cam.setDist(d)`, `cam.lift` in `flightcam.js`); the pilot's own zoom returns when the canopy is gone.
- `fs.onWorldEvent('decouple')` puts a ring of sparks and a puff at the separation plane.
- Exhaust trail: the puff rate follows surface speed (capped at 170 per second, at most 30 per frame) and the
  puffs of one frame are spread back along that frame's path, so the trail is a continuous column at any frame
  rate; solid and liquid smoke is near white.
- `scene.worlds` is the world renderer in use; `scene.settleTerrain(ms)` makes the next `update` build pending
  terrain chunks synchronously for up to `ms` (used by `tests/e2e/preview_flight.mjs` before a capture; not used
  in play).

### Craft additions used by flight and the builder (`craft.js`)
- Part fields: `flip` (stack part mounted end for end), `pitch`, `roll` (radians; surface parts). Helpers:
  `partQuat(p)` → `[x, y, z, w]`, `partAxis(p)` → the part's +Y in craft axes, `isTilted(p)`, `closedNode(p)`.
- Craft fields saved in `toJSON`: `desc` (free text), `site` (`'pad' | 'runway'`: where the design rolls out),
  `subassemblies` (`[{ asm, x, y, z, yaw }]`: loose pieces lying in the hall; the builder strips them at launch).
- Public assembly methods: `assemblyOf(partId)`, `detachSubtree(partId)` → `{ asm, count, mirror, from }`,
  `attachAssembly(asm, specs)`, `reroot(partId)` → `{ ok, why }`, `moveSubtree(partId, dx, dy, dz)`,
  `rotateSubtree(partId, ang)`, `tiltPart(partId, dPitch, dRoll)`, `symmetryCopies(primary, { mode, n })`,
  `mirrorPartner(part)`; module helpers `assemblyLayout(asm, spec)`, `flipAssembly(asm)`, `isMirrorPair`,
  `groupIsMirror`. An assembly is `{ parts }` with `parts[0]` at the origin; parts carry `_stage` and `_actions`.

### Part-definition additions (`parts.js`)
`comY` (m, mass offset along the part's axis), `lab: { rate, mult, elecUse }` (science lab; `vessel.labParts`,
`processLabs`), `shape: 'pylon'` (fixed hardpoint, see above), `attach.surface` on wings and tail fins.

### World renderer additions (`worlds.js`, `globe.js`, `worldstyle.js`)
- `worlds.heightAt(body, dirBodyFixed, out?)` → metres above `body.radius` of the ground as drawn (sea surface
  where there is sea); `out.spacing` is the grid spacing of the chunk used, `Infinity` when the height function
  answered because nothing is drawn there. It agrees with `body.terrainHeight` to centimetres round the scene
  origin once `worlds.info.busy` is false.
- `createBodyVisual(body, { quality, nightFill })` and `vis.setNightFill(f)`: a floor under the night side's
  brightness (the map uses 0.3 so dark hemispheres stay readable).
- `planetShine(body, ut, out)` → false for bodies that orbit the star; else `out.color` (linear) and `out.dir`
  (unit, inertial, toward the planet): the light a moon's night side gets from its planet.
- `cloudAngle(style, ut)` → rotation of the cloud deck about the spin axis, shared by the globe and the terrain view.

- Terrain round the focus (round 3): `terrain.update(cam, { sync, focus, focusSync })`. Whenever `sync > 0` or
  `focusSync` is set (worlds.js sets it on a camera jump and when the followed vessel changes place by more than
  40 m + 10 % of the altitude in one frame), `refineFocus()` builds on the calling thread every chunk the view
  wants in the nodes the focus stands in or within half their size of, at every level, with no time limit (at most
  four nodes a level: about 270 chunks on the pad, which is the corner of four nodes at every level). Guarantee:
  after such a call no chunk drawn within r of the focus is wider than 2r, whatever the workers are doing. The
  level of detail depends on distances only (`SPLIT` × node size), never on the window size or the pixel ratio.

### Tests
- `npm run test:e2e` → `tests/e2e/run.mjs`: every suite in `tests/e2e` that is not a helper or a `preview_*`
  script, one after another (shell, builder, mapview, flight, docking, interplanetary, the play-through in
  `ONLY=` batches, demo); logs in `tests/out/e2e-<name>.log`. `--previews` adds the capture scripts.
- `tests/e2e/contact.mjs` (+ `contact.page.js`, its in-page half): ground contact measured in the drawn scene.
  For every vessel the lowest drawn vertex of each part against the topmost drawn surface under it (terrain
  triangles via `worlds.heightAt`, the space centre's paving by ray), terrain against every slab, camera height
  above the drawn ground, decals above what they lie on, a depth audit of every material. Sections: `stock soft lod
  warp depth demo worlds splash centre builder` (`node tests/e2e/contact.mjs stock,lod`; `CRAFT=`, `BODIES=`
  narrow it). `__ct.stall(true)` holds the worker pool so "before the chunks arrive" is tested deterministically.
  `runway` section (round 3): an aeroplane from spawn through the Autopilot panel's take-off, by the game's launch
  and by the demo's runway scene, at pixel ratio 1 and 2: the runway mesh under the wheels every frame, wheels on
  the drawn surface, nothing between camera and aeroplane (`__ct.sight`). `OLD_RUNWAY=1` serves bodies.js with the
  old runway record and must fail.
- Ground contact in the core (round 3, `vessel.js`): (1) `_stepFlight(dt, ut)` gets the time at the END of the step
  while `pos` is at its start; the ground (`_groundInfo`, `_contact`) is looked up at `ut − dt`. With `ut` the
  terrain was sampled one step of body rotation away (2 m at Verda's equator), 30 cm of height on a 9° slope.
  (2) Each hull / leg contact point carries `dh`: its true clearance from the terrain under it minus its clearance
  from the plane through the terrain under the CoM; refreshed when the vessel has moved 3 cm or turned ~0.5°.
  A vehicle on three or more wheels keeps the plane fitted over its wheel footprint. (3) The plane's slope for
  other craft is a centred difference one base radius out. `tests/unit/ground_contact.test.js`: at rest on slopes,
  upright or lying, every contact point within 3 cm of the terrain under it.
- Landing legs (round 3): `legs.reach` is where the SOLE of the pad stands (`partmesh.js` puts the pad's hinge 7 cm
  of the strut's scale above it; it used to put the hinge there, so every lander stood 7 cm in the ground), and the
  core adds four contact points on the rim of the pad (`_buildContacts`), so a craft on its side lies on its pads
  instead of through them. `tests/unit/ground_contact.test.js` checks the rim; `contact.mjs worlds` the drawn sole.
- Steering lock (round 3): a steered wheel never turns further than atan(|ry| · 0.55 · μ · g / v²)
  (`TUNING.WHEEL_STEER_GRIP`): held at top speed, the D key turns a rover about 19°/s instead of spinning it.
- Automatic landing (round 3, `autopilot.js planeLand`): the final approach damps the path error
  (`− 0.5 · (γ + slope)`); the flare's sink target falls with height, its nose-up limit is the geometric
  tail-strike angle measured in `init`, and power carries a craft whose nose is at that limit.
  `tests/unit/plane_landing.test.js`.
- One runway (round 3): `SYSTEM.sites.runway` (threshold, `start` 100 m in, `center`, length 2000) IS the strip the
  model draws (`BASE_LAYOUT.runwayX / runwayZ`, `runwayAnchor`); `World.launch(…, {site: 'runway'})` stands the
  craft at `runway.start`. `tests/unit/runway_site.test.js` holds core and model together.
- Wheels: the drawn strut closes by the core's actual compression (`compress` is in units of 0.3 R and may pass 1).
- `tests/e2e/retina.mjs`: device pixel ratio 1 and 2, four graphics profiles: a marker in the far scene and one in
  the near scene must be captured where the camera projects them. `REVERT=1` serves flightscene.js with the
  viewport fix undone and must fail.
- `tests/unit/terrain_focus.test.js`: the `refineFocus` guarantee with the worker pool silent.
- `tests/e2e/interplanetary.mjs`: the stock Farwind flies Verda → Rusk → Dray, lands, a Pip plants a flag, and the
  ship returns to Verda's sphere of influence, using only the Autopilot panel's programs and the game's own warp.
- `tests/e2e/flight.mjs` gained the runway section (Kite Trainer take-off, turn, program landing; Trundle Scout
  drive, steer, lamps, brakes). `tests/e2e/preview_flight.mjs` captures runway, take-off, rover (runway and Pell),
  separation and the arrival at Rusk and Dray besides the first-pass views.

## Additions (round 3: missions)

Missions are two things, shown together: the **flight program** (a fixed chain, tracked in every game mode) and
**contracts** (paid jobs, career mode only; `js/core/contracts.js`, unchanged in its rules).

### The flight program (`js/core/career.js`)
- `PROGRAM`: ordered steps `{index, id, chapter, how, title, desc, funds, science, rep, bodyId, kind}`. Every step
  **is** a milestone (`id` is a milestone id; title, text and rewards come from `MILESTONES`), so there is one reward
  system and saves need no new field: a step is done when `career.milestones` has its id. Order: first launch, 10 km,
  space, orbit of Verda, crewed return, spacewalk; Pell and Ost (flyby, orbit, landing, return each); leaving
  Verda's sphere; then every other world by rising science value, moons after their planet (no landing on gas
  giants). Flags and the like stay plain milestones outside the chain.
- `programStep(id)`, `career.programStatus()` → `{steps: [{...step, done}], next, done, total, chapter}`,
  `career.nextProgramStep()`, `career.programRewards(step)` (funds and reputation only in career, science not in
  sandbox), `programProgress(id, vessel, ut)` → `{frac, text}` or null (altitude and low-point gauges for the tracker).
- `objectiveProgress(objective, vessel, world)` in `contracts.js` → `{frac, text}`: the live read-out of a contract
  objective (altitude of a `reach`, the window of a part test, orbit numbers with what is wrong, hold seconds,
  distance driven). Pure: it never changes the objective.

### Screens
- **Title menu**: `[data-action="missions"]` → `openTitleMissions(app)` (`hub.js`). A career save is loaded and opened
  in Mission Control; otherwise the `.sw-missions-intro` panel explains missions and offers `[data-action=
  "start-career"]` (and `[data-action="open-missions"]` when a science or sandbox save exists).
  `app.newGame(mode, {to, params})` and `app.continueGame({to, params})` open another screen than the hub.
- **Mission Control** (`missions.js`): the `.sw-program[data-role="program"]` panel sits above the tabs in every mode:
  count, chapter, the next mission (`.sw-program-next[data-program-next]`, with how-to and rewards for the mode), the
  chapter's steps as chips, and `[data-action="program-all"]` for the whole chain. `enter({spotlight: 'program'})`
  lights it up. The Contracts tab says plainly that contracts are career-only. A contract whose deadline ran out
  while the player was at the Flight Center is announced by a toast (hub and Mission Control), not only filed.
- **In flight** (`hud.js`): toolbar button `[data-tool="missions"]` and key `O` (`DEFAULT_KEYS.missions`, remappable)
  toggle the `missions` pop-over (`.fl-pop[data-panel="missions"]`): the next program step and every active contract,
  one line per objective with a tick and a live gauge, the time left, the pay. When a program step is flown the
  flight screen adds a "Next mission: …" toast after the milestone toast.
- Launch dialogs (`openLaunchDialog`): designs made for this site come first; the others are marked ("Runway
  design" / "Pad design", `data-site`) and the info card warns (`[data-role="wrong-site"]`).

### Tests
`tests/unit/program.test.js` (chain order and coverage, modes, save round trip, progress read-outs) and
`tests/e2e/missions.mjs` (title entry, Mission Control program, accept → fly → objective and completion notices →
payment, missed deadline, cancel, sandbox; `only=title,program,contract,deadline,cancel,sandbox`).

## Additions (round 3: performance)

Numbers, method and the Rust question: `docs/RUST_ASSESSMENT.md`.

- **`js/perf.js`** — frame-time recorder, no DOM and no three.js, importable from every layer. Off by default (each
  call is then one branch). `perf.begin(name)` / `perf.end()` time a section into one of the buckets `sim`, `scene`,
  `terrain`, `render`, `hud`, `other`; sections nest and each gets its exclusive time. `perf.count(name, n)` are
  per-frame event counters (`chunksFromWorkers`, `chunksBuiltOnMain`, `textureSwaps`). `main.js` calls
  `perf.frameBegin(now)` / `perf.frameEnd()`; `perf.summary(n)` gives fps, frame-interval percentiles, the buckets,
  draw calls and triangles for the whole frame (`renderer.info`, `autoReset` off while recording), long-frame
  counts, the worst frame with what was in it, heap growth and drops, shader programs first used.
- **`js/ui/perf.js`** — `installPerf(app)` → `app.perf`. **F3** toggles the `.sw-perf` overlay (also `?fps=1`):
  fps, frame/p95/worst, the main-thread split, GPU timer query where the browser has one, draws/triangles, canvas
  size, devicePixelRatio, the drawing-buffer and scene-target sizes, quality and governor level, heap, GPU string.
  It repaints four times a second and takes no pointer events.
- **`js/ui/perfbench.js`** — the **`?perf=1`** benchmark: a throwaway sandbox program (storage is snapshotted and
  restored, nothing is saved), fixed scenes (`centre, builder, pad, ascent, orbit, map, pell, plane, reentry, rover,
  docking, tracking`), `frames` (240) measured frames each after `warm` (45), then a results card with a text table
  and "Copy as text" (`app.perf.results = {text, json}`, `document.body.dataset.perf = 'running' | 'done'`).
  Parameters: `frames, warm, scenes=a,b, hq=1` (force "high" on a software renderer), `gov=1` (leave the governor
  on), `drain=0` (skip the drained-GPU pass), `quality=low|medium|high`. Tools get exact windows through
  `window.__perfHook(sceneId, 'arrive-begin' | 'arrive-end' | 'begin' | 'end', frames)`.
- **`js/ui/governor.js`** — `createGovernor({budgetMs})`: pure logic. `tick(dtMs, {cpuMs, busy, hidden})` returns
  true when `level` changed; `state` = `{scale, shadow, msaa, bloom}`; `lock(n | null)`; `enabled`. Order: render
  scale 1 → 0.85 → 0.72 → 0.6, shadow map half → off, multisampling off, bloom off. Steps down after about a second
  over 1.2 × budget, probes one step up after a calm spell with exponential back-off, ignores hitches, loading
  frames, hidden tabs and frames whose pace the main thread set. The flight scene owns one
  (`flightScene.governor`); setting **`gfxAuto`** (default true; "Automatic quality" in Settings and the flight
  graphics menu) turns it off. Never active on a software renderer.
- **Pixel budget**: `app.pixelRatio(w, h)` = `min(devicePixelRatio, 2)`, lowered so the drawing buffer never
  exceeds 3840 × 2160 pixels. The flight scene's HDR target uses 2 samples per pixel instead of 4 when the
  effective pixel ratio is 1.5 or more.
- **Shader prewarm**: `flightScene.prewarm(renderer)` (awaited at the end of the flight screen's `enter`) compiles
  both scenes' programs through `compileAsync` before the first frame, bounded by a timeout.
- **Body maps** (`bodytex.js`): finished bake levels hand their textures over through one queue (`swapNext`), one
  texture per animation frame over all bodies.
- Transparent part materials (`decal`, `heat`) and plumes are `forceSinglePass`: three.js otherwise draws a
  transparent double-sided mesh twice and re-resolves its program on every draw.
- **Tools** (`tests/tools/`): `perf_run.mjs` (the benchmark headless, with per-scene CPU profiles and thread-tick
  CPU time), `perf_split.mjs` (per-section main-thread cost, allocation per frame, materials re-evaluated),
  `perf_kernels.mjs` (Node timings of chunk generation, map bakes, `world.step`, the planners),
  `prof_callers.mjs` (who calls a function in a `.cpuprofile`).
- **Tests**: `tests/unit/perf.test.js` (recorder arithmetic with a fake clock; governor behaviour) and
  `tests/e2e/perf.mjs` (the benchmark at full quality on a 480 × 300 canvas: main-thread CPU-time, draw-call,
  triangle and main-thread-chunk budgets per scene; late shader compiles; one texture upload per frame; the pixel
  budget, sample count and governor levels at devicePixelRatio 2; the report's contents; the F3 overlay).

## Additions (round 3: interface size)

- **One scale for the whole 2D interface.** `#ui` is drawn at `zoom: var(--sw-ui-scale)`; the 3D canvas is not zoomed.
  `js/ui/dom.js` owns it: `resolveUiScale(setting, w, h)` (Auto = 1 up to 1600 x 900, 1.2 at 1920 x 1080, 1.6 at
  2560 x 1440; a chosen size above 100 % is capped so the interface keeps 1280 x 720 of its own pixels),
  `setUiScale(k)`, `uiScale()`, `uiPx(v)`. `main.js` applies it in `applySettings`, on resize and on every screen
  change (`app.ui.scale`); the demo and the benchmark always run at 1. Setting: `settings.uiScale` (`'auto'` or 0.8 to
  1.75), shown as "Interface size" in Settings and in the flight Graphics dialog.
- **Rules for code that places things.** `getBoundingClientRect()`, pointer events and 3D projections are viewport
  pixels. Anything written to `left/top/translate` of an element under `#ui` must be divided by `uiScale()` (hub pins
  and name plate, HUD pop-over, research node card, map hover card). Viewport units in CSS under `#ui` are written
  `calc(90vw / var(--sw-ui-scale, 1))`. The map's drawing, labels and burn handles live in `.map-vp`, which undoes the
  zoom so they stay in viewport pixels; labels and handles are scaled back up with a transform. Elements appended to
  `body` (tooltip, staging drag ghost) carry the same zoom.
- **Flight Center picking.** Every building gets an invisible pick pillar through its focus point
  (`js/render/basegfx.js`), so the point the camera looks at always picks the building.
- **Starting parts.** The two small liquid tanks and the nose cone moved from the starting node to "Bigger Bells"
  (5 science, which the first two program missions pay), where the first liquid engine is. `tests/unit/program.test.js`
  flies the first three program missions on starting parts.
- **Contract titles.** `ContractBoard._generate` never offers a title already on the board or in the book; when only
  a used title comes up it is numbered ("... II").

## Additions (round 4: environment realism)

Everything is made in code at load: no model or image files. `tests/e2e/realism_probe.mjs` renders the views below
at device pixel ratio 1 and 2 and checks draw calls and triangles against a budget per quality level.

### Trees (`js/render/treegen.js`, `floratex.js`, `flora.js`)

- `treegen.js` is pure (Node-testable, `tests/unit/flora.test.js`). `SPECIES`: oak, maple, birch (broadleaf),
  spruce, pine (conifer), palm. `growSkeleton(id, seed)` grows a trunk and limbs; `buildTree(id, { lod, seed })`
  returns one indexed mesh: bark tubes (uv in metres, `bark` attribute) and alpha-tested leaf cards (`leaf`
  attribute: occlusion toward the crown's interior, sway weight, flutter phase) that sample one cell of a 4 x 2 leaf
  atlas (`ATLAS`, `cellUV`). `lod: 0` is the full tree (300 to 1,900 triangles), `lod: 1` the same skeleton with
  fewer, larger cards (80 to 360). `lodDistances(pixelHeight, fov, detail)` turns "a tree this many pixels tall" into
  distances; `lodBlend` is the cross-fade the shaders use.
- `floratex.js` paints the leaf atlas (sprays, boughs, needle tufts, a frond) and three tileable barks with normal
  maps on canvases, once.
- `flora.js` `createTreeSystem({ trees, detail, planetRadius, shadows })`: per species two `InstancedMesh`es (full,
  reduced) and one impostor mesh for all species. The level that draws an instance is chosen **in the vertex shader**
  from its distance in units of its own size; neighbours hand over with a screen-door dither (complementary pixels),
  so there is no pop and no sorting. The CPU only re-bins instances into the level buffers when the camera has moved
  5 m. Materials are `MeshLambertMaterial` patched in `onBeforeCompile`: wind in the vertex shader (trunk sway by
  height, leaf flutter), bark normal map, two-sided leaves with light coming through against the sun, occlusion
  toward the interior, and a softened shadow term so a crown shading itself never goes black. Leaf edges use
  alpha-to-coverage where the target is multisampled.
- Impostors: 8 yaws x 3 elevations of every species' full mesh are rendered once (first frame it is seen, or
  `prepare(renderer)`) into two atlases, albedo and object-space normals, so impostors are lit by the real sun.
  The bake sets `rt.viewport` / `rt.scissor` (never `renderer.setViewport`) and clears through GL: three
  premultiplies the clear colour by its alpha, which leaves black behind the leaves and darkens every mip level.
- Shadows: full and reduced meshes cast into the scene's shadow map through a matching depth material. Outside the
  shadow light's box (learned each frame from the scene's directional light) and under impostors, a multiply-blended
  blot stretched away from the sun stands in.
- A hidden `trees:driver` mesh learns the camera, the pixel height of the target and the fog from whichever
  renderer draws the group, so the flight scene needs no extra calls.

### Grass and ground

- `createGrass({ mask, planetRadius, detail })`: two rings of instanced tufts that wrap round the camera with
  `mod` (36 m and 150 m cells), thinned with distance and removed where the paved mask says so. The mask is drawn by
  `basegfx.js` from the slab, asphalt, concrete and paint meshes (1 pixel per metre, `base.pavedMask`). No grass at
  low; half at medium.
- `baseenv.js` ground: turf from three scales of painted grass and four channels of noise (lush and dry growth,
  bare-earth patches, wear along paved edges) instead of one tiled colour.
- `worldshaders.js`: inside the space centre's kept zone the terrain's grass is toned to match (less saturated,
  darker), marked `[realism pass]`.

### Space-centre materials (`basegfx.js` `buildMaterials`)

`weather(material, mode, k)` adds, from the position in the centre's own frame: stains and bleached patches that
never tile, a band of ground dirt up the foot of walls, uneven roughness, and worn paint markings. Off at low
quality (`M.grime`).

### Detail levels

- `VEG_LEVELS = low | medium | high | ultra`; `vegLevel(setting, qualityName, drop)`. Setting `gfxVegetation`
  (`'auto'` follows Detail) is on the Settings page and in the flight Graphics dialog.
- `governor.js` `LEVELS[i].detail` is how many vegetation levels the governor takes away (0 until the render scale
  is at its floor: a smaller target already draws fewer full trees, because distances come from pixel height).
  `flightscene.applySettings` passes it to `base.setVegetation(setting, qualityName, drop)`; the space-centre view
  does the same with its own quality steps.
- `base.vegetation` reports `{ level, trees: { trees, full, reduced, impostors, triangles }, grass }`; with
  `?perf=1` the counters `treesFull`, `treesReduced`, `treeImpostors`, `vegTriangles` are recorded per frame.

### Second round

- Broadleaf crowns are built from clumps: every twig carries a run of sprays and ends in three or four crossed ones,
  and the limbs carry large sprays turned inward so no sky shows through the middle. Mature oaks and maples stand
  15 to 25 m; one tree in seven is young. A `bush` species (no trunk, a dome of sprays) is the understory.
- Leaves: the sunlit side is warm and brighter, the shaded side takes more of the sky's light (`TRANSLUCENT_GLSL`),
  so crowns do not go dead at dusk.
- Placement (`basegfx.js`): two noise patterns cut the woods into stands and tree lines with clearings; shrubs stand
  round the feet of trees at the edges of stands (not at low quality). 4,200 trees at medium and above, 1,400 at low.
- Ground (`baseenv.js`): meadow, damp hollows and worn tracks at the scale of the whole centre; kept grass in mowing
  stripes beside runway and roads and a worn verge at the kerb, both read from blurred mip levels of the paved mask.
- `builder.js` `enter()` links the hall's shader programs with `compileAsync` before the first frame is drawn.

### Third round

- `scatter.js` `groveGeometry()`: the home world's scattered broadleaf woods (beyond 3 km of the pad) are built from
  the same oak skeleton (`treegen.js`): its real trunk and limbs, and one small lumpy mass per leaf clump. Solid
  geometry in the scatter shader's own conventions, so no other layer or world changes (only the home world has
  `scatter.trees`). The conifer layer keeps its whorled spruce.
- `worldshaders.js` (marked `[realism pass]`): meadow, damp hollows and worn tracks inside the space centre's kept
  zone, from the same kind of noise as the space-centre view. Mown strips and the verge are not there: the terrain
  shader has no paved mask.
- `basegfx.js`: `rocks` (one `InstancedMesh` of lumpy field stones), tall-grass and weed patches (small `bush`
  instances), denser understory; glass mirrors the sky at a glancing angle where the scene has fog; asphalt has its
  own weathering (aggregate grain near the camera, patched rectangles, seams) instead of broad stains.
- Grass rings hold 32,000 and 25,600 tufts; medium draws 31 %, high 70 %, ultra all of them.

### Not done

Rubber streaks on the runway's touchdown zones; contact darkening under trees beyond the blob shadows; mown strips
in the flight terrain.

## Additions (interstage trusses)

A stage is never stood on the bell of the engine above it. Wherever a stack part sits on the nozzle end of a rocket
engine (`wantsInterstage(def)` in `parts.js`: shape `engine`, not a jet; solid boosters are their own wall), an open
lattice ring as tall as that engine joins the rim of the part below to the engine's mount ring. It is not a catalog
part and nothing is saved in a design: it is derived from the part tree.

- `Craft.interstages()` → `[{ owner, engine, dir, h, r0, r1, mass, x, z, y0, y1 }]`. `owner` is the part under the
  engine (usually a separator) and carries the truss; `dir` +1 = it stands up from the owner. Mass is
  `interstageMass(h, r0, r1)` = wall area × `INTERSTAGE.kgPerM2`, and is counted in `mass()`, `dryMass()`,
  `centerOfMass()` and `stats()`. There is no cost.
- `Vessel.fromCraft` copies each truss onto the owner part as `part.truss = [{ side, h, r0, r1, mass }]` (`side` ±1
  along the part's OWN axis, so it survives docking's change of frame). It is saved with the vessel, counted in
  `part.mass`, and goes wherever the owner goes: a stack separator leaves the stage it drops half a second after staging
  (`Vessel.ringDue`, `_shedRing`), so the truss ends up on the ring, a third piece. Once the engine it wrapped is gone, the open rim gets a bounding contact and a ring of contact
  samples (`_buildContacts`).
- Drawing: `partmesh.setPartInterstages(group, trusses)` hangs one merged mesh (one draw call) per truss on the
  owner's mesh group; `flightscene.js` calls it when it builds a part, `builder.js` on every `syncMeshes()`.
- Capture script: `node tests/e2e/preview_interstage.mjs` → `tests/out/interstage/*.png`. Tests:
  `tests/unit/interstage.test.js`.

## Additions (round 5: realism pass 3)

Spec and task list: `docs/REALISM_PASS_SPEC.md`, `docs/REALISM_PASS_PLAN.md`. Everything is still made in code; no
asset files were added. Nothing in `js/core` changed.

### Ambient occlusion (`js/render/ao.js`, `post.js`)

- `createAO(pass)`: a half-resolution pass over the scene target's depth texture (12 spiral taps, normal rebuilt from
  depth, height-over-distance-squared estimate) and a 4x4 depth-aware blur. Two extra draw calls per frame.
- The scene target of the post chain carries a `DepthTexture` while occlusion is on (`post.setAO(on)`); three r170
  resolves the multisampled depth into it. Depth is logarithmic: distance = `exp2(d * log2(far + 1)) - 1`.
- A half-resolution pixel sits on the border of four depth texels: depth is read with `texelFetch` and positions are
  rebuilt from the centre of the texel that was read (`aoSnap`), or lines of false shade appear.
- Flight: on at "high" only, behind the "Ambient occlusion" setting (`gfxAO`) and the governor's first three levels
  (`LEVELS[n].ao` in `governor.js`). The composite multiplies it in before bloom, and leaves the sky, the distance
  (`maxDist`) and anything bright enough to glow alone.
- Hangars and space centre: `createPostChain(renderer, { display: true })`. In this mode the scene target is flagged
  `isXRRenderTarget` with an sRGB-tagged texture, which makes three r170 tone-map and colour-convert each material
  into it exactly as it does for the canvas; the composite only multiplies the occlusion in. The picture is otherwise
  unchanged (materials with `toneMapped: false` and the background keep their colours). This relies on how r170
  picks a program's tone mapping and output colour space; re-check it when three is updated. `builder.js` uses it
  at quality "high"; `baseview.js` at its two best quality steps, with a radius that grows to building size
  (`params.grow`, `growMax`). From the overview distance the effect is close to invisible.
- With the post chain in use `renderer.info` is reset once per frame by the hangar, so its counts cover the shadow
  pass too (three's own automatic reset happens after the shadow pass).

### Live reflections (`js/render/envprobe.js`, `flightscene.js`)

- `createEnvProbe(renderer, { size: 64 })`: a 64 px half-float cube map of the far scene from the vessel's position,
  filtered with `PMREMGenerator.fromCubemap` into one reused target. The first refresh draws six faces at once,
  later ones one face per frame. `probe.update(scene, position, { force, near, far })` returns true when the
  filtered map changed.
- At "high" it replaces both the painted sky map on the near scene and the parts' studio map
  (`setPartEnvironment`), at intensity 1 and with no rotation (the cube is in scene axes). The studio map is put
  back when the flight scene is disposed or quality drops.
- Refresh triggers (in `update()`): another body, the sun or the local vertical turned 2 degrees, height changed by a
  fifth (at least 50 m), or 20 s passed. A refresh frame draws one face of the far scene on top of the normal
  frame (about 150 draw calls on the pad); `realism_probe.mjs` measures a frame between refreshes. The first refresh runs in `prewarm()` before programs are compiled, because
  swapping the materials' environment map during `compileAsync` throws inside three.
- `settings.gfxReflect === false` turns it off (used by `tests/e2e/env_probe.mjs`; there is no menu row).

### Terrain, rocks, water

- `worldshaders.js` `triGradV`: the 37 m and 530 m relief layers are sampled twice with offsets that change from
  patch to patch (slow hashed noise over the globe) and cross-faded, which removes the visible repeat from a few
  hundred metres up. `tests/e2e/tiling_probe.mjs` measures it as the strongest autocorrelation peak of a top-down
  picture (limit 0.2; Pell from 300 m went from 0.32 to 0.12).
- `scatter.js`: boulders throw a soft shadow (`shade_boulders`, the trees' shadow layer with its own dimensions in
  `uShadowDims`; darker on airless worlds), lie buried to different depths, and are stretched differently per
  instance (`stretch`). The shadow layer is created last so the seeds of every other layer are unchanged.
- Sea (`TERRAIN_FS`, OCEAN): the bed is seen through per-colour absorption (red goes first) instead of a flat mix,
  bare-earth patches are not drawn under water, the surf band is narrower, wave faces turned to the light are
  brighter, and the water's edge widens with distance to hide the coarse shoreline. `tests/e2e/preview_water.mjs`
  captures it.
- Already present before this pass, so not redone: slope rock blending, the fine grain layer, Fresnel and sun
  glitter on water.

### Tests and probes

`tests/unit/perf.test.js` (governor keeps occlusion for three levels); `tests/e2e/ao_probe.mjs`, `env_probe.mjs`,
`tiling_probe.mjs` (checks), `preview_water.mjs` (captures).

### Not done

Shallow sea seen from several kilometres up shows the sandy bed inside the fine-terrain radius and the baked blue map
outside it (a stepped ring); it was there before this pass. Frame rate and final look on a real GPU are unmeasured:
every check ran on the software rasteriser.

## Additions (structural dynamics)

`js/core/structure.js` (joint loads, strength, failure, flex; `vessel.structure`) and
`js/core/loadcases.js` (`analyzeCraft`, the assembly building's reference load cases). World events
`structure` and `stress`. UI: `js/ui/stress.js`, `js/ui/builder/loads.js`, `js/ui/builder/loadfx.js`.
The contract is [STRUCTURE.md](STRUCTURE.md).

## Additions (aerodynamic breakup)

Air ratings (`AIR_RATING`, `airRating` in `js/core/parts.js`), judged in the aerodynamics loop of
`js/core/vessel.js` (`TUNING.AERO_FAIL`, `vessel.airUtil`, `vessel.airLoads()`); thin roots for fins and
wings in `js/core/structure.js` (`rootSection`, the `root` argument of `jointUtilisation`); the debris
limit in `js/core/world.js` (`MAX_DEBRIS`). A torn-off part raises the `structure` event with
`mode: 'airflow'`. Words: `js/ui/stress.js`. The contract is [AERO_BREAKUP.md](AERO_BREAKUP.md).

## Additions (reusable boosters, part 1: two vessels at once)

`World.isTrackable`, `world.tracked`, `world.trackedInFlight()`, `world.release()`, `MAX_TRACKED` and
`world.stage(vessel)` in `js/core/world.js`: a ship that can be controlled and is coming down (or is
under thrust, or has a guidance program) keeps full physics at any distance from the active vessel,
and holds rails warp off while it is in flight. `vessel.released`, `vessel.program`. In
`js/ui/flight.js` a program that never warps (`PARKABLE`) stays with its vessel when the player
switches away (`parked`, `tickParked`), and `hopVessel` (key `\`) steps through the vessels of the
flight. The contract is [BOOSTERS.md](BOOSTERS.md).

## Additions (reusable boosters, part 2: guidance)

`js/core/booster.js` (pure simulation, runs in Node). `predictFall` is a point-mass fall predictor: inverse-square
gravity, drag from `Vessel.axialDragArea` and `machDrag` in air rotating with the body, optional thrust below a height
(the landing burn) and an optional entry burn planned from a heat-flux threshold. `boosterRecovery(world, vessel,
{ target })` is a controller with the same shape as the other programs (`update(dt)`, `phase`, `done`, `failed`,
`log`) and phases flip, boostback, coast, entry, landing, final. It moves only `vessel.ctrl`. `recoverableStage` and
`returnReserve` let `ascentProgram({ recover })` stage when the propellant left equals the return's need.
`Vessel._control` reverses control-surface deflection when the vessel flies tail first and the attitude hold asks for that (retrograde modes, or a held direction more than 90° from the airflow). `flight.js` starts a parked
`boosterRecovery` on the `decouple` event for a dropped ship with a running engine and legs over the home body, and
toasts each new line of its log (`callouts`). The landing target is `SYSTEM.home.sites.landing`.
Tests: `tests/unit/booster_return.test.js`, `tests/verify/checks_booster.mjs` groups 9d to 9f,
`tests/e2e/booster_return.mjs`.

## Additions (reusable boosters, part 3: landing sites)

`Body.decks` is a list of level rectangles that are solid to the physics and are not part of the height field
(`Body.deckAt(dir)` returns the top, or -Infinity). The home world has one, the landing barge (`BARGE` in `bodies.js`,
`SYSTEM.home.sites.barge`). `terrainAt` in `vessel.js`, which every ground contact goes through, returns the deck where
there is one; `Body.surfaceHeight` and `Body.isWater` agree with it. Rendering never sees decks: `Body.terrainHeight` is
unchanged. `Vessel._groundInfo` treats a deck as level (no slope from the drop at its edge) and `_contact` lets a hull
point past the edge keep its real clearance, so a stage half off the deck finds no support there. The Return Pad
(`sites.landing`) is ordinary level ground with paving drawn on it (`buildReturnPad` in `basegfx.js`). The barge model is
`js/render/barge.js`, built the first time the camera is within 60 km and placed by `flightscene.js` at the deck's
position. `mapview.js` marks both sites. `boosterRecovery` reports a touchdown on water as "down in the sea" and failed.
Tests: `tests/unit/barge.test.js`, `tests/verify/checks_booster.mjs` group 9g, `tests/e2e/booster_barge.mjs`.
