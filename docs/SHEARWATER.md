# Shearwater: a Starship-class rocket

A two-stage rocket on methane and liquid oxygen, modelled on SpaceX's Starship (the V3 version:
33 engines under the booster, 6 under the ship, 39 on the stack) and built at five-eighths of
its size to suit Starwright's small worlds. The names are our own: the ship is the
**Shearwater**, the booster is the **Stalwart**, the engine is the **Peregrine**.

It is being built in steps. **Four are in the game: the rocket, the tower that launches and
catches it, refuelling in orbit, and the ship's return.** The stack stands on the tower's mount,
flies to orbit on its own two liquids and hot-stages, and the booster flies back and is caught by
its two pins. In orbit the ship docks side by side with a propellant depot and is filled up
through a propellant line. The ship comes home flat on its belly, steered by four flaps, flips
upright near 3 km and is caught by the same arms. The whole mission as one scenario comes next
(see "What is not built yet").

## What is new in the game because of it

**Two liquids, burnt in a fixed ratio.** Every other liquid engine in Starwright burns one
"propellant". The Peregrine burns methane (`ch4`) and liquid oxygen (`lox`), 3.6 kg of oxygen to
1 kg of methane, which is the ratio a Raptor runs at. A tank holds both, each with its own
gauge. Run short of either and the engine stops with the other still aboard. That is the whole
point of the mission this rocket is for: a depot has to deliver both.

**Engines in rings.** A cluster is one part with many bells, grouped in rings, and you choose
which rings burn:

| Cluster | Rings | Engine sets |
|---|---|---|
| Peregrine 33 (booster) | 3 centre, 10 inner, 20 on the rim, 340 kN each | All 33, Inner 13, Centre 3 |
| Peregrine 6 (ship) | 3 sea-level at 340 kN, 3 vacuum at 375 kN | All 6, Sea-level 3, Vacuum 3 |

Press **=** in flight to step the lit clusters to their next set. Thrust, propellant flow and
specific impulse are the sums over the engines that are lit, so the Centre 3 of the booster
give 3/33 of its thrust at the same specific impulse, and the Vacuum 3 of the ship give 380 s
where all six together give about 364 s. The inner thirteen of the booster steer and the rim
does not, as on the real one.

**Hot staging.** The ring between the stages is open lattice. When you stage, the ship lights
its six engines while the booster is still attached, and 0.8 s later the ring lets go. The ring
stays on the booster (on the V3 it is part of the booster and comes home with it), so staging
leaves two pieces, not three. The ring is also the booster's guidance core.

**Heavier joints.** The end rings of these parts are twice as strong as a plain part's. Without
that, a 5.6 m stack with 11 MN under it fails the game's own structural check at the engine
mount. The Assembly Building's loads panel shows the result: the worst joint is at 60 % of its
strength, steering hard at lift-off.

## The numbers, measured in flight

Flown by the ascent assist to an 80 km orbit of Verda with two crew and a loaded cargo bay
(`node tests/tools/shearwater_dev.mjs` repeats it):

| | |
|---|---|
| Height | 75 m (ship 32 m, booster 43 m), 5.6 m across |
| Lift-off mass | 772 t |
| Lift-off thrust to weight | 1.43 |
| Highest air pressure on the way up (max Q) | 19.9 kPa |
| Highest acceleration | 3.1 g |
| Staging | 104 s after lift-off, 29.5 km up, 1,110 m/s |
| Propellant left in the booster at staging | 61 t of 400 t |
| Orbit reached | 80.3 by 79.4 km |
| Propellant left in the ship in orbit | 67 t of 160 t (42 %) |
| Delta-v left in the ship in orbit | 1,415 m/s |
| Delta-v of the ship with full tanks | 2,800 m/s |

The last three rows are the reason for the depot. Leaving low orbit for Pell, braking into
orbit there, leaving again and keeping about 250 m/s for the landing burn at home costs about
2,020 m/s. The ship arrives with 1,415. Filled up in orbit it has 2,750.

## The tower and the catch

The **Catch Tower** stands 500 m north-west of the launch pad: a 91 m steel tower (five-eighths of
the real 146 m), a launch mount beside it, and two long arms that ride up and down its face. A
stack with catch pins and no legs is rolled out to this mount, not to the launch pad. The map
marks it.

**What you do.** Launch with the ascent assist, as before. Nothing else: the assist stages early
enough for the booster to get home, and the booster flies itself back while the ship goes on to
orbit. Press **\\** to watch it or take over. To fly it yourself, open Guidance on the booster and
choose **Fly back to the tower**, or do it by hand: the arms take anything that meets the limits
below.

**How the return is flown.** Flip, then a boostback burn on the inner 13 engines until the
predicted end of the fall is on the mount. A long fall engine first, steering on the three grid
fins. A landing burn on the inner 13 that stops the stage about 20 m above the arms and about
8 m east of the mount, on the side away from the tower, so that whatever it misses by it misses
away from the steel. Low down the burn stands the stage upright (at most 20° of lean at
250 m up, shrinking to 1° near the arms), so that it does not come out of the burn still turning.
Then the centre 3 alone: it slides across to the mount leaning at most 7°, waits until it is
steady, and comes down at 1.2 m/s until the arms have it.

Why the care: the stage is 70 m tall and the column stands 4.4 m from its engines. A lean of
5° swings the bottom of the stage 4 m to the side. Before this, a stage that came out of the
burn rotating swung 13 m to one side and back across the mount, and its engines passed through
the column, which was not yet solid.

One thing in this is new, and a booster this heavy needs it. On the way down the guidance aims
the point where the landing burn will *stop* the stage, not the point where it would hit the
ground with no burn. This stage lights 1.9 km up while it still has sideways speed, and stops
well short of its unpowered impact point: aimed the old way it arrived 50 to 70 m off the mount,
aimed this way 4 m.

**What the arms will take.** The base of the stage must come down to 3 m above the mount:

| | Limit |
|---|---|
| Distance from the mount's axis | 2.5 m (the arms swing to meet it) |
| Sink rate | 5 m/s |
| Sideways speed | 2 m/s |
| Lean | 8° |
| Turning rate | 0.25 rad/s |

Inside all five, the arms have it: the stage is held where it is, stood upright, and stays
until its own engines lift it out again. Outside any one of them the arms cannot take it, the
game says which limit it broke, and the stage goes on down onto the mount.

**Measured** (`node tests/tools/tower_dev.mjs`, 80 km orbit, with the drag model of re-entry step B):

| | |
|---|---|
| Staging | 104 s, 29.5 km, 62 t left in the booster |
| Boostback burn | 40 s, from 37 km |
| Landing burn lights | 2,008 m up, 342 m/s |
| Off the mount when the fall is stopped | 12 m east, away from the tower |
| Lean in the hover | 3° at most |
| Caught | 317 s after lift-off, at 1.4 m/s, 0.7 m from the mount's axis |
| Propellant left in the booster | 4.0 t |
| Touches of the tower | none (and none in 8 flights with the booster nudged at staging) |
| Ship in orbit | 42 % full, 1,415 m/s left |

**Honest limits of the catch.**

- The column and the arms are solid steel, simple boxes. A part that touches them is stopped
  against them; met faster than its crash tolerance it breaks off, and faster than 2.2 times
  that the whole vessel is lost (a booster tank takes 7 m/s, so the whole stage goes at about
  15 m/s). The game says which part touched. The launch mount, its clamps and the other
  buildings are not solid yet.
- The arms close only round a stage that is within reach of the mount, and wait open while
  anything wider than the gap between them still has to come down past them (the ship's aft
  flaps hang 10 m below its pins). Round a stage they are catching the arms guide its body
  in rather than strike it; whatever sticks out of it still meets them.
- A stage that misses the catch falls to the mount. The five limits decide the catch itself.
- The pins are not checked one by one. The stage has to carry two; where they sit sets how high
  the arms are drawn, not whether the catch works.
- A stage is taken wherever it is within 2.5 m, and is turned in the arms, the shorter way round, until its two pins lie north and south, one on each rail. The drawn arms move to it.
- The mount is at ground level. There is no flame trench, no water deluge and no damage to the
  pad from 33 engines.
- A caught booster cannot be put back on the mount, refuelled or flown again yet.

## Refuelling in orbit

The ship reaches orbit 42 % full. To go anywhere it has to be filled up, and that is done at a
**propellant depot**: *Deepwell*, an avionics nose on two long steel tanks holding 400 t of liquid
oxygen and methane, with no engines. The scenario **Topping Up** starts with Shearwater 150 m
from it, 100 km up.

**Docking side by side.** Both carry a **Flank Port**: a docking port that looks straight out of
the side of the hull. On the ship it is high on the steel side of the tank, opposite the tiles.
Two Flank Ports latch when their faces meet within 25 cm, slower than 1.5 m/s, facing each
other to within 15°, and with the two hulls parallel to within 15°, nose by nose or nose to
tail. The ships end up 7 m apart, axis to axis. The docking assist (Dock panel) flies it: it
turns the ship so the ports face each other with the hulls parallel, moves to a point 20 m out
on the depot's port axis, and closes at about 0.4 m/s. From 150 m that takes a little over two
minutes. The ship carries four **Squall Thruster Pods** for this, each with 600 kg of its own
monopropellant.

**The propellant line.** Liquid oxygen and methane cross only through a pair of docked Flank
Ports, at 300 kg a second in all, in the proportion the source holds them (3.6 to 1). The old
instant transfer between tanks does not move them.

**Settling.** In free fall a liquid does not sit at the bottom of its tank; it floats about, and a
pump at the outlet would draw gas. So the pump only draws while something pushes the stack
along its axis toward the source tank's nose, at 2 mm/s² or more, which holds the liquid on the
outlet at its aft end. Start the pump from the Fuel panel and it fires the thrusters to give 3
mm/s² itself. Main engines do as well. With no push for 20 seconds the pump gives up and says
why. If the two ships are docked nose to tail, the push has to suit the ship being emptied, and
the pump works that out.

The push is real thrust. Filling the ship moves 93 t in 5 minutes 10 seconds, costs about 260 kg
of monopropellant between the two ships, and adds about 1 m/s to the orbit.

**Measured** (`node tests/e2e/topping_up.mjs`, the scenario in the real game):

| | |
|---|---|
| Docking assist, 150 m to latched | 132 s, about 900 kg of the ship's 3,000 kg of monopropellant |
| Pumped | 93 t at 300 kg/s |
| Push while pumping | 3.0 mm/s² |
| Monopropellant spent settling | 260 kg |
| Orbit afterwards | 100.8 by 99.9 km (from 100 by 100) |
| Ship delta-v, before and after | 1,415 m/s, 2,750 m/s |

**Honest limits of the refuelling.**

- Nothing boils off. Real liquid oxygen and methane warm up and vent; a real depot needs sun
  shields and loses propellant every day. Here a full depot stays full.
- The depot is put in orbit full. The real plan needs something like ten tanker flights to fill
  one; that is not flown here.
- Settling is one number. Either the push is enough and the pump draws at full rate, or it is
  not and nothing flows. There is no sloshing, no slow start, and the liquid does not shift the
  centre of mass sideways.
- A real transfer is planned to be driven by a pressure difference between the tanks, not a
  pump. The effect in the game is the same: a rate, and a need for settled liquid.
- The thrusters burn monopropellant. The real ship's are fed from its main tanks.
- While the two ports are within 3 m and closing slower than 3 m/s the hulls are left to dock.
  Outside that, the ship and the depot are solid to each other like any two craft
  ([SOLID_SPACE_CENTRE.md](SOLID_SPACE_CENTRE.md#craft-against-craft)).
- Docking snaps the pair exactly parallel, as nose docking snaps two rings into line.
- A pump that is running when the game is saved is stopped when it is loaded.
- Ship-to-ship transfer of this kind has not yet been done in space by anyone.

## The ship's return

The ship has no legs, no wings and no parachute. It comes home the way the real one does: flat
on its belly through the air, then upright on its engines for the last kilometre and a half,
and into the same two arms that caught the booster. The scenario **Belly First** starts in a
100 km orbit with the bay empty and 26 t of propellant.

**What you do.** Open the Autopilot panel and pick **Return to the tower**. To fly it by hand,
the **BELLY** button in the SAS row lays the ship flat to the wind and the pitch keys set its
angle to the air between 50 and 88 degrees.

**The four flaps.** Each is a flat plate hinged along the hull. It folds from flat out (0) to
80 degrees up toward the lee side, and the wind pushes on whatever is left facing it. The flaps
do not make lift like a wing. They are drag you can take away, at four corners. Fold the two
forward ones and the nose drops; fold the two on one side and the ship rolls; fold opposite
corners and it yaws. They rest half folded so each can move both ways. The belly hold uses them
whenever the air is thick enough to feel (above about 40 Pa), with the thrusters helping, and
you can see them move.

**What the guidance does.**

1. **Wind tunnel.** Before anything else it flies a copy of the ship, at its present mass, in a
   scratch world: at 50, 70 and 88 degrees to the air and at each Mach number from 0 to 12. That
   gives the drag area and the glide of this ship as loaded today. At 70 degrees the drag area
   is about 206 m2 and the glide ratio 0.29. At 50 degrees it glides 0.66 forward for each metre
   it falls; flat on, nothing.
2. **Braking burn.** It tries 72 places round the orbit, predicts the whole fall from each with
   those figures, and picks the burn (about 58 m/s on the three vacuum engines) whose fall ends
   over the tower. The burn lowers the low point of the orbit to 30 km.
3. **The fall.** The ship meets the air at about 2,100 m/s. Every two seconds the guidance
   predicts three falls from where the ship is now, steep, middling and flat, and picks the
   angle in between that ends at the tower. Sideways error is taken out by rolling the lift
   to one side, with the nose laid along the lean, because a round hull only pushes along its
   own length.
4. **Flat, from 11 km.** The ship lies fully flat and falls nearly straight down at about
   170 m/s, sliding sideways the last few hundred metres by leaning.
5. **The flip.** Near 3 km up all six engines light, the ship swings upright in
   about two and a half seconds, and the landing burn of the booster's guidance takes over:
   stop just above the arms, come down between them. The ship comes in from the west, over the
   column, and a burn that let its sideways error out only as it stopped drifted in over the
   column top and the open arms whenever it lit a little short. So the burn leans to take out the
   sideways offset and speed by the time it is 150 m above the arms, aiming 8 m east of the mount
   (the clear side), and comes straight down from there; the hover slides it the last metres in.
   The arms close only once their carriage has come down to the ship's pins.

**Measured** (`node tests/tools/ship_return_dev.mjs home 0.16` repeats it):

| | |
|---|---|
| Mass leaving orbit | 96 t (67 t of ship, 3 t of thruster propellant, 26 t of methane and oxygen) |
| Braking burn | 58 m/s on the three vacuum engines, 11 seconds |
| Speed meeting the air at 72 km | 2,113 m/s |
| Time from the top of the air to the arms | about 9 minutes |
| Highest g | about 2 |
| Hottest part | 63 % of its limit |
| Speed at the flip | about 170 m/s down, 3 km up |
| Caught | at 1.2 m/s, under 1 m from the centre line |
| Propellant left | 4 to 8 t |

It was flown from four different places round the orbit with every whole per cent of a tank
from 10 to 20, and caught each time without touching the tower.

**What it will not do.**

- **Come home loaded.** With freight in the bay the ship is nose heavy and far too heavy for
  its engines. The program says so and does nothing.
- **Come home with much propellant.** Low in the air the six engines give 1,553 kN, which
  holds up about 100 t with the margin a landing needs. Above about 20 % of a tank the program
  refuses and says how many tonnes too many. At 25 % it will try and lands 600 m short.
- **Come home on fumes.** Under about 10 % there is not enough for both burns.
- **Land anywhere else.** There are no legs. The return goes to the tower.

**Where the weight went.** For the flaps to hold the ship flat its centre of mass has to sit
between the two pairs. The first version carried its weight too far forward and fell nose
first whatever the flaps did. Structure moved aft, into the tank and the engine section, and
the freight, which leaves before the return, took up the difference: 68 t where it was 49 t.
Launch mass and the ascent are unchanged.

## Where this differs from the real thing

- **The belly-first fall is slower.** Verda is small and its orbit slow, so the ship meets the
  air at 2.1 km/s where a real one meets it at 7.5. Peak heating and g are milder for it.
- **The flip is quick and late.** The real ship flips at about 500 m. This one starts near
  3 km because it has less thrust for its weight and stops more slowly.
- **Flaps are flat plates.** Their force is the pressure of the wind on the area facing it, with
  a factor that rises at high Mach. Flow round the hull between them is not modelled.

- **Size.** Five-eighths scale: 5.6 m across where Starship is 9 m, 75 m tall where it is about
  124 m. Starwright's worlds are about a tenth the size of the real ones, and its other parts
  are near five-eighths of real hardware.
- **Mass.** 772 t at lift-off where the real stack is over 5,000 t. Low orbit of Verda needs
  about 3.8 km/s, not 9.4, so a rocket in real proportions would arrive almost full and the
  depot would have nothing to do.
- **The booster does more of the work.** On Earth the booster gives roughly a quarter of the
  speed to orbit. Here it gives nearer a third, and the ship arrives 42 % full where a real
  Starship arrives nearly empty. The cargo (68 t of freight in the bay) is
  chosen so that the ship cannot fly on to Pell and back without refuelling and can when full.
- **One refuelling, not ten or more.** For the same reason.
- **Landing on Pell is out of reach with the cargo aboard.** That needs about 3.1 km/s from low
  orbit and back. Pell orbit is the mission; a landing would need the cargo left behind.
- **Engine out and throttle limits per engine are not modelled.** A set of engines is lit or not.
- **Things the real programme has not done yet.** Catching both stages on one flight and
  passing propellant from one ship to another have not been flown (as of November 2026 a ship
  has been caught once and a booster three times, and only a transfer between two tanks inside
  one ship has been done). The game will let you do both.

## What is not built yet

| Step | What | Status |
|---|---|---|
| 1 | The rocket: two liquids, ring engines, hot staging, flies to orbit | in the game |
| 2 | A launch tower with catch arms, and the booster flying back to be caught by its two pins | in the game |
| 3 | A propellant depot in low orbit, docking side by side, and a transfer that needs the tanks settled | in the game |
| 4 | The ship's return: belly first on its four flaps, the flip, and the catch | in the game |
| 5 | The whole mission as one scenario, and a Science chapter on orbital refuelling | planned |

Unloading the freight is not built: the ship that comes home in the scenario **Belly First** starts with its bay already empty.

## For people reading the code

- Parts: `js/core/parts.js`, the block headed "The Shearwater stack". `PROP_MIX` holds the
  mixture, `engine.rings` and `engine.modes` describe a cluster, `engineNow(def, mode)` gives the
  figures of the rings that are lit, `decoupler.hot` marks a hot-staging ring, `joint` is the
  end-ring strength.
- Burning two liquids: `propIn`, `propTake` in `js/core/vessel.js`; the delta-v estimates in
  `vessel.js` and `craft.js` treat the pair as one propellant whose mass is the smaller of what
  the two can make up.
- Hot staging: `hotDue` and `finishHotStage` in `vessel.js`.
- The tower: `TOWER` and the site in `js/core/bodies.js`, the catch in `js/core/tower.js`, the held state
  (`surface.held`) in `vessel.js`, the return in `boosterRecovery` (`js/core/booster.js`, options `floor`,
  `sets`, `aimBurn`), the drawing in `js/render/tower.js`.
- The stock design: `shearwater()` in `js/core/craft.js`.
- The ship's return: the flap block of the air loop and `bellyAttitude` in `js/core/vessel.js` (`TUNING.FLAP_*`,
  `BELLY_AOA`), `windTunnel` and `shipReturn` in `js/core/shipreturn.js`, `predictEntry` in `js/core/entry.js`,
  the options `thrustScale` and `steerBurn` of `boosterRecovery`; the scenario is `belly-first`.
- Side docking: `dock.side` in `parts.js`, `portLocal` / `portAxisLocal` and the side branch of `absorb` in
  `vessel.js`, `_dockingStep` in `world.js`, the attitude for side ports in `dockingApproach` (`autopilot.js`).
- The pump: `startPump`, `_stepPump`, `_pumpSettle`, `propellantLines` in `vessel.js`; `TUNING.SETTLE_ACCEL`.
  The Fuel panel block is `lineRows` in `js/ui/hud.js`. The depot and the ship alone are `deepwell()` and
  `shearwaterShip()` in `craft.js`; the scenario is `topping-up` in `scenarios.js`.
- Checks: `tests/unit/shearwater.test.js`, `tests/unit/ship_return.test.js`, `tests/unit/tower.test.js`, `tests/unit/sideport.test.js`, and group 2e of the independent verification
  (`tests/verify/checks_burns.mjs`): mass flow, mixture ratio and the rocket equation for each
  engine set.
