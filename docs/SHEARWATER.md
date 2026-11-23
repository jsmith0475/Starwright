# Shearwater: a Starship-class rocket

A two-stage rocket on methane and liquid oxygen, modelled on SpaceX's Starship (the V3 version:
33 engines under the booster, 6 under the ship, 39 on the stack) and built at five-eighths of
its size to suit Starwright's small worlds. The names are our own: the ship is the
**Shearwater**, the booster is the **Stalwart**, the engine is the **Peregrine**.

It is being built in steps. **Step 1 is in the game: the rocket itself.** It stands on the pad,
flies to orbit on its own two liquids, and hot-stages. The tower that catches it, the propellant
depot, the transfer of propellant in orbit and the ship's belly-first return come next (see
"What is not built yet").

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
| Lift-off mass | 769 t |
| Lift-off thrust to weight | 1.43 |
| Highest air pressure on the way up (max Q) | 19.9 kPa |
| Highest acceleration | 3.1 g |
| Staging | 104 s after lift-off, 29.5 km up, 1,110 m/s |
| Propellant left in the booster at staging | 61 t of 400 t |
| Orbit reached | 80.3 by 79.4 km |
| Propellant left in the ship in orbit | 70 t of 160 t (44 %) |
| Delta-v left in the ship in orbit | 1,500 m/s |
| Delta-v of the ship with full tanks | 2,800 m/s |

The last three rows are the reason for the depot. Leaving low orbit for Pell, braking into
orbit there, leaving again and keeping about 250 m/s for the landing burn at home costs about
2,020 m/s. The ship arrives with 1,500. Filled up in orbit it has 2,800.

## Where this differs from the real thing

- **Size.** Five-eighths scale: 5.6 m across where Starship is 9 m, 75 m tall where it is about
  124 m. Starwright's worlds are about a tenth the size of the real ones, and its other parts
  are near five-eighths of real hardware.
- **Mass.** 769 t at lift-off where the real stack is over 5,000 t. Low orbit of Verda needs
  about 3.8 km/s, not 9.4, so a rocket in real proportions would arrive almost full and the
  depot would have nothing to do.
- **The booster does more of the work.** On Earth the booster gives roughly a quarter of the
  speed to orbit. Here it gives nearer a third, and the ship arrives 44 % full where a real
  Starship arrives nearly empty. The cargo (49 t in the bay, on a 45 t forward section) is
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
| 2 | A launch tower with catch arms, and the booster flying back to be caught by its two pins | next |
| 3 | A propellant depot in low orbit, docking side by side, and a transfer that needs the tanks settled | planned |
| 4 | The ship's return: belly first on its four flaps, the flip, and the catch | planned, after the re-entry model (roadmap item 6) |
| 5 | The whole mission as one scenario, and a Science chapter on orbital refuelling | planned |

Until step 2, the booster has catch pins and no legs, so it is not flown home: after staging it
flies on as its own vessel (press **\\** to hop to it) and comes down in the sea. The four flaps
are fitted and weighed and do not steer yet.

## For people reading the code

- Parts: `js/core/parts.js`, the block headed "The Shearwater stack". `PROP_MIX` holds the
  mixture, `engine.rings` and `engine.modes` describe a cluster, `engineNow(def, mode)` gives the
  figures of the rings that are lit, `decoupler.hot` marks a hot-staging ring, `joint` is the
  end-ring strength.
- Burning two liquids: `propIn`, `propTake` in `js/core/vessel.js`; the delta-v estimates in
  `vessel.js` and `craft.js` treat the pair as one propellant whose mass is the smaller of what
  the two can make up.
- Hot staging: `hotDue` and `finishHotStage` in `vessel.js`.
- The stock design: `shearwater()` in `js/core/craft.js`.
- Checks: `tests/unit/shearwater.test.js`, and group 2e of the independent verification
  (`tests/verify/checks_burns.mjs`): mass flow, mixture ratio and the rocket equation for each
  engine set.
