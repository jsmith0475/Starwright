# Scenarios

Scenarios are ready-made games: a finished rocket in the assembly building, a ship already in orbit, a lander
standing on a moon. They are on the title menu beside New Game, Flight School and the demo tour. Pick a card,
press Start, and you are there with a short brief and a list of objectives.

## Rules of a scenario game

- It is an ordinary `Career` in **sandbox** mode (every part unlocked, nothing costs funds) with one extra field,
  `career.scenario = { id, name, done: [objective ids], marks, startedUt, complete }`.
- It is saved in **its own slot**, `starwright.scenario.v1` (`SCENARIO_SAVE_KEY` in `js/core/career.js`).
  `Career.save()` picks the slot by itself, so nothing a scenario does can write over the player's own program in
  `starwright.save.v1`. Quicksaves made in a scenario go to `starwright.scenario.quicksave.v1`.
- There is one scenario slot. Starting a scenario while another is in the slot asks first; the picker offers
  Resume and Restart for the one in progress, and the menu entry says which one that is.
- The in-flight Missions panel (O) shows the scenario's goal and objectives in place of the flight program and
  contracts, and flight-program notices ("Milestone", "Next mission") are not shown in a scenario game.
- Importing a save file from Settings while a scenario is being played says which saved game it replaces: an
  ordinary program replaces the player's own save (the scenario stays in its slot); a scenario file replaces the
  scenario slot (the player's program is not affected).
- Objectives are ordered and sticky: each is ticked the first time its test passes after the ones before it, and
  stays ticked. They are checked while flying (a few times a second) and shown in the panel on the left under the vessel name (folded to its title on a short window);
  a notice appears when one completes. Nothing is locked behind them; a scenario is a place to start, not a rail.

## The scenarios

| id | Name | World | Where you start | Difficulty | Goal |
|---|---|---|---|---|---|
| `first-orbit` | First Orbit | Verda | Assembly building, Larkspur | Easy | Orbit Verda and bring Juno home |
| `pell-expedition` | Pell Expedition | Verda | Assembly building, Pellfarer | Medium | Fly to Pell, land, come home |
| `long-haul` | The Long Haul | Verda | Assembly building, Wayfarer (crew of three) | Hard | Reach orbit of Rusk |
| `pad-hop` | Light the Candle | Verda | Launch pad, Pipsqueak | Easy | Hop above the air and land safely |
| `station-run` | Station Run | Verda | Launch pad, Tern; Hollin Station is in a 150 km orbit | Hard | Launch, rendezvous, dock |
| `morning-orbit` | Morning Orbit | Verda | 95 km orbit, Larkspur | Easy | Raise the orbit above 200 km |
| `hollin-approach` | Hollin Approach | Verda | 120 m from Hollin Station, Tern, target set | Medium | Dock |
| `pell-descent` | Above Pell | Pell | 30 km orbit, Pellfarer lander with its transfer stage | Medium | Land on Pell |
| `pell-homecoming` | Pell Homecoming | Pell | Landed, lander three-quarters full | Medium | Lift off and return to Verda |
| `ost-outpost` | Ost Outpost | Ost | Landed, Ostrider with Bram and Tilly | Easy | Walk, plant a flag, fly back to orbit |
| `murk-tracks` | Tracks on Murk | Murk | Landed, Pebble rover | Easy | Drive 1 km |
| `pell-overland` | Pell Overland | Pell | Landed, Pebble rover at the start of a clear run | Easy | Drive 1 km in one sixth of home gravity |
| `rusk-arrival` | Rusk Arrival | Rusk | Inbound on an open path, closest approach 90 km | Hard | Plan and fly the capture burn |
| `tiv-survey` | Under the Giant | Tiv (moon of Thal) | 60 km orbit, Wayfarer lander | Hard | Land and plant a flag |
| `topping-up` | Topping Up | Verda | 100 km orbit, Shearwater 42 % full, 150 m from the depot Deepwell | Medium | Dock side by side, fill the tanks to 95 %, undock |
| `belly-first` | Belly First | Verda | 100 km orbit, Shearwater unloaded, 16 % propellant | Hard | Fall belly first below 30 km, be caught by the tower arms |
| `fire-and-silk` | Fire and Silk | Verda | Sub-orbital, falling from 120 km, capsule only | Easy | Survive re-entry, land under the parachute |

Every craft is built from the parts in `js/core/parts.js`. The unit tests check each one for validity, staging,
crew and delta-v, and fly every goal to its end on the autopilot, so each scenario is known to be winnable with
the fuel aboard.

## Where the code is

| File | What |
|---|---|
| `js/core/scenarios.js` | Pure logic, no DOM. The catalog (`SCENARIOS`), the craft, `buildScenario(id)`, objectives (`checkScenario`, `scenarioStatus`), the save slot helpers. |
| `js/ui/scenarios.js` | The picker, the brief on arrival, the objectives panel. Installed at boot as `app.scenarios`. |
| `js/ui/hub.js` | One line: the title menu entry. |
| `js/core/career.js` | `career.scenario` is saved and loaded; `save()` chooses the slot. |
| `tests/unit/scenarios.test.js` | Builds, checks and flies every scenario headlessly. |
| `tests/e2e/scenarios.mjs` | Browser test: menu, picker, every scenario started, vessel where the card says, save slots. |

`buildScenario(id)` returns `{ scenario, career, world, vessel, vessels, craft, crew, site, start: { screen, params } }`.
The world is already stored in `career.flightState`, so the UI only has to adopt the career and go to
`start.screen` with `start.params`: the builder with the design loaded, or the flight screen (resuming the stored
world, or launching the design on top of it for pad starts).

For other UI (a missions list, for instance) the hook is `app.scenarios.status()`, which is
`scenarioStatus(career)`: `{ id, name, goal, objectives: [{ id, text, done }], done, total, complete }`, or
`null` when the game is not a scenario.

## Adding a scenario

1. **Craft.** Reuse one of the builders in `js/core/scenarios.js` (`larkspur`, `pellfarer`, `wayfarer`, `tern`,
   `hollin`, `ostrider`, `pebble`, `pipsqueak`) or write another the same way: a `Craft`, parts added by id,
   stages set by hand. List it in `SCENARIO_CRAFT` so the tests validate it.
2. **Definition.** Add an entry to `DEFS`:

   ```js
   {
     id: 'my-scenario', name: 'Shown On The Card', world: 'pell', situation: 'In orbit of Pell',
     difficulty: 'Medium',            // Easy | Medium | Hard
     start: 'flight',                 // 'builder' | 'launch' | 'flight'
     goal: 'One line: what to do.',
     brief: 'Two sentences for the arrival panel: where you are and what you have.',
     tips: ['Up to three short hints.'],
     objectives: [
       { id: 'landed', text: 'Land on Pell', test: T.landed('pell') },
     ],
     build(ctx) {
       const b = body('pell');
       const st = orbitState(b, { pe: 30000 }, ctx.world.ut);
       const v = ctx.world.spawn(pellfarer({ launcher: false }), { crew: ['Juno'], body: b, pos: st.pos, vel: st.vel, q: st.q });
       return readyInSpace(v);        // first stage lit at zero throttle, solar panels out
     },
   }
   ```

   - `ctx.hangar(craft, crew)` starts in the assembly building; `ctx.pad(craft, crew)` starts on the pad.
   - In space use `orbitState` (closed orbits, also sub-orbital arcs with `atAp`) or `arrivalState` (open
     incoming paths), then `world.spawn`.
   - On the ground use `flatSpot(body, nearDirection)` to find level terrain and `placeLanded(world, craft,
     body, dir, { crew, vehicle })`. That is the same kinematic placement the game uses for a parked vessel
     (`vessel.surface` plus `syncLanded`), so the lowest point of the craft is on the terrain exactly.
   - Objective tests are `(world, career) => boolean`. The ready ones are in `T`: `orbit`, `landed`, `home`,
     `above`, `off`, `soi`, `docked`, `near`, `eva`, `flag`, `drove`. Always pass `world.ut` to
     `vessel.getOrbit(t)`.
3. **Unit test.** Add the id to the `EXPECT` table in `tests/unit/scenarios.test.js` (vessel count, body,
   situation, crew, minimum delta-v), and a flown proof that the goal can be met with the fuel aboard.
4. **Browser test.** Nothing to add: `tests/e2e/scenarios.mjs` walks the catalog. Run
   `ONLY=my-scenario node tests/e2e/scenarios.mjs` and look at `tests/out/scenarios-my-scenario-dpr1.png`.

Things learned the hard way:

- Rovers work on every world now (see `tests/unit/rover.test.js`), but the ground decides how far: use
  `driveRoute(body, near, { length })` to find a start point and heading with a gentle kilometre ahead, and park
  the rover with `placeLanded(..., { vehicle: true, heading: route.heading })`, which stands it square to the slope.
  The cruise control (`roverDrive`) caps its speed for the local gravity and stops short of ground that is too steep.
- A landed craft whose engine is already lit must not be staged again at lift-off; the ascent program checks
  for a live liquid engine before it stages.
- Give objectives that an uncrewed vessel could satisfy (a station already in orbit) a crewed-ship test, or the
  first objective is ticked the moment the scenario starts.
