# Rendering, parts and site contracts

The conventions that the renderer, the parts catalog, the physics core and the space centre share. Read this
with `docs/ARCHITECTURE.md`; where the two differ, this file wins.

## Ground rules

- **Original work only.** Starwright has its own name, crew ("Pips"), part names, planet names, logos, art
  and UI styling. Do not copy any existing game's names, characters, textures, models, icons, music, text or
  exact visual design, and do not download or embed any existing game's assets or screenshots. Genre
  conventions are fine and wanted: a 3D space centre with clickable buildings, an assembly building with
  attachment nodes, symmetry and a staging stack, a flight HUD with navball, altimeter, staging column and
  resource gauges, a map view with orbit lines and maneuver nodes, time warp, a tracking station, and the
  genre's standard keys.
- All art is procedural (three.js geometry, canvas-generated textures, shaders). No network at run time.
  No build step: plain ES modules. Three.js r170 is vendored at `js/lib/three.module.min.js`.
- `js/core` stays pure (no DOM, no three.js) and Node-testable.
- `npm test` must stay green. Never weaken or skip a test to get there; update a test only when the
  behaviour it checks was changed on purpose. Browser suites live in `tests/e2e/` (helpers in
  `tests/e2e/server.mjs`); their timing checks can flake on a busy machine, so rerun a timing failure once
  on its own before believing it.
- Headless Chromium uses software GL, and screenshots from the e2e suites are deliberately low quality.
  Judge visuals from the `tests/e2e/preview_*.mjs` scripts, which force full quality, at 1440x900 and
  1024x768.
- Performance target: 60 fps on a recent laptop GPU. Budget draw calls (merge static geometry, use
  instancing), keep shadow maps to one cascade of at most 2048, and cache texture bakes.
- Input: keyboard and a mouse with a wheel, right button and middle button. No key that the browser or the
  operating system reserves.

## Renderer contract (set once in `js/main.js`)

- `renderer.outputColorSpace = SRGBColorSpace`, `renderer.toneMapping = ACESFilmicToneMapping`,
  exposure about 1.0, `renderer.shadowMap.enabled = true` with `PCFSoftShadowMap`, logarithmic depth stays on.
- Author all materials for that: `MeshStandardMaterial`/`MeshPhysicalMaterial` with real roughness/metalness,
  colour textures marked sRGB, lights in physically plausible ratios (one sun directional light with
  shadows, hemisphere/ambient fill, optional image-based lighting from a small procedural environment map).
- Custom shaders must include three's tonemapping/colorspace chunks and the logdepthbuf chunks.
- Use the same settings in your own preview scripts so what you judge is what ships.

## Visual identity

UI chrome keeps the Starwright identity (slate panels #141a22 / #1d2631, teal #39d0c0, amber #ffb347,
rounded system fonts) but must read as a game HUD: compact, instrument-like, not big rounded web cards.
The 3D world should look grounded and rich: weathered painted metal, panel lines, decals, concrete, grass,
haze, long shadows.

## Part-definition fields (the contract between the parts catalog and the physics core)

Existing schema stays (see `js/core/parts.js`). Additions:

- Lifting surfaces: `wing: { area /*m²*/, control: false | 'pitch' | 'roll' | 'yaw' | 'auto', sweep? }` on
  radial parts with `shape: 'wing' | 'elevon' | 'tailfin'`. The existing `fin: { area, control }` stays valid
  and is treated as a small wing.
- Wheels: `wheel: { radius, drive /*kN max drive force*/, brake /*kN*/, steer: bool, maxSpeed /*m/s*/,
  elecUse /*EC/s at full drive*/ }`, `shape: 'wheel'`. Landing gear for planes: same with `drive: 0` and
  `retract: true`.
- Engines: `engine.type` gains `'ion'` (propellant resource `xenon` in kg plus `engine.elecUse` EC/s),
  `'nuclear'` (uses `fuel`, high isp, heavy) and `'jet'` (uses `fuel`, only runs where the body's
  atmosphere has oxygen, thrust falls with altitude and speed: `engine.jet = { maxAlt, maxMach }`).
- Air intakes are not modelled; a jet engine is self-sufficient.
- New resources: `xenon` (kg). Tanks carry it as `res: { xenon }`.
- Size classes: `SIZES` gains `XL: 1.875` (3.75 m diameter). Existing S/M/L unchanged.
- Bodies: `body.atmo.oxygen` is `true` only where jets work (Verda, and at most one other world).
- Plane parts: `shape: 'fuselage'` tanks (stack attach, may carry `res.fuel`), `shape: 'cockpit'` command
  pods, `shape: 'intake'` nose cones (cosmetic).
- Rover/utility: `shape: 'rover_body'` probe-core chassis, `shape: 'ladder'`, `shape: 'light'`
  (`light: { range }`), `shape: 'antenna'` variants, `shape: 'drill'` is out of scope.

## Launch sites

`SYSTEM` home body gets a second site: a runway. `body.launchSite` stays the pad; add `body.sites =
{ pad: {...}, runway: { lat, lon, dir, heading /*deg, 90 = east*/, length, name } }`. The runway lies
about 1.2 km south-west of the pad on flat ground, heading east. Vessels launched from the runway start
horizontal on their wheels. `world` launch API gains an option `{ site: 'pad' | 'runway' }` (default pad).

## Space-centre ground layout (shared by hub, flight and terrain)

Local frame at the pad: origin at pad centre on the ground, +Y up, +X east, +Z south (so north is -Z).
The base sits on a flat coastal plain: terrain within 3 km of the pad is flattened to the pad altitude
(guaranteed by `Body.terrainHeight`), ocean to the east beyond about 2.5 km.
`js/render/basegfx.js` exports:

```js
createBase({ quality = 'high', interactive = false }) -> {
  group,                 // THREE.Group in the local frame above
  buildings,             // [{ id, name, blurb, object3d, focus: Vector3, radius }] ids below
  padAnchor, runwayAnchor, // Object3D where vessels stand
  update(dt, { sunDir, timeOfDay }),   // animates lights, dishes, flags, vehicles
  dispose(),
}
```

Building ids: `hangar` (Vehicle Assembly Building), `pad` (Launch Pad), `runway` (Runway), `spaceplane`
(Spaceplane Hangar), `tracking` (Tracking Station), `research` (Research Lab), `missions` (Mission Control),
`crew` (Crew Quarters), `school` (Flight School), `admin` (Administration; opens settings/save menu).
The flight scene uses the same `createBase` so the pad you see from the hub is the pad you launch from.
