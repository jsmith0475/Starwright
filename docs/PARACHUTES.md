# Parachutes

How a parachute is flown and drawn. Code: `js/core/parachute.js` (numbers, no engine), the canopy step in
`js/core/vessel.js` (`_updateChutes`, `_chuteForces`), the cloth and lines in `js/render/canopy.js`.
Checks: `tests/verify/checks_parachute.mjs` against the independent `tests/verify/ref_parachute.mjs` (chapter 11).

## Why this was rebuilt

Until November 2026 a parachute was a drag area that grew on a timer, pushing on the pack against the craft's
velocity, and the picture was a 7 m dome scaled by that timer with lines scaled by a different rule. The line tops and
the skirt were two formulas that did not agree, so the lines stopped short of the canopy. The picture was also a
quarter of the size its drag implied.

Now there is one description of the canopy, `chuteShape`, and both the physics and the picture are built from it.
The upper end of each drawn line is not calculated at all: it is copied from the hem vertex on its seam.

## The canopy a part's numbers imply

A parachute part states drag as before (`area`, `semiArea`, times `CHUTE_CD` 1.6), so descent rates did not change.
Everything else follows from treating it as a flat round canopy:

| quantity | rule | Canopy Parachute |
|---|---|---|
| nominal diameter D0 | drag area = 0.8 x cloth area | 32.7 m |
| open diameter | 0.67 D0 | 21.9 m |
| suspension lines | 1.0 D0, on a riser of 0.1 D0 | 32.7 m |
| cloth from skirt to apex | D0 / 2, at every stage of filling | 16.4 m |
| top of the canopy above the pack | | 43.6 m |

The Grand Canopy M is a cluster of three such canopies (22.3 m each) leaning apart from one confluence. The Streamer
Drogue is 8.9 m across on 13.4 m lines. A canopy making less than its full drag (reefed, or still filling) is narrower,
and because its cloth keeps its length it is taller: reefed, it is a long sock.

## How it flies

Each open canopy is a second body: a point at the end of a rigid line from the pack.

- **Drag** acts on the canopy's own velocity through the air, so the canopy trails where the air puts it and the craft
  hangs under it. A capsule that opens its parachute while still moving sideways swings in under the canopy as the
  sideways speed dies, and that swing is damped by the canopy's drag, not by a made-up term.
- **The air it carries.** An inflated canopy moves about 1.5 times the air of the half ellipsoid it encloses. That air
  has inertia and no weight. Fully open on Verda's ground it is about 3.5 t under a Canopy Parachute, three times the
  mass of the capsule, which is why opening fully is a jolt and not only a change of speed. That air goes round with
  the planet, so its inertia is counted against the turning atmosphere.
- **The line** pulls on the craft along itself with whatever tension keeps pack and canopy that far apart. The tension
  of all open canopies is solved together with the rigid body in each step, implicitly in the speed along each line
  (a canopy can stop a light craft in less than a step). A line cannot push.
- **Two canopies** side by side press on each other instead of passing through, so they lean apart, and each line
  carries its drag divided by the cosine of the lean.
- The pull is applied at the pack, off the centre of mass where the pack is, and is booked to the structure, so a
  parachute can break a joint (docs/STRUCTURE.md).

## Opening in stages

1. **Armed.** The parachute stays packed until the air is thick enough to fill it (0.02 atm), the craft is under the
   Mach number the parachute is built for (1.5 for mains, 3 for drogues), and the sequencer's own forecast of the
   opening load on the mass it carries is under 80 % of the line strength. While it waits, the flight screen says
   which of the three it is waiting for.
2. **Reefed.** The mouth fills over 3 nominal diameters of travel, and a reefing line pays out from 3 % to all of the
   reefed drag area over 6 seconds. This is what turns one sharp shock into a pull spread over seconds.
3. **Fully open**, below `fullAlt` (900 m for mains) above the ground, once the reefed stage is all the way out, or
   sooner if the mouth has filled and the forecast load of opening fully is inside the margin (a parachute opened low
   and slow). The canopy opens over 4 nominal diameters of travel.

Height for step 3 is above the ground under the craft. It used to be height above the sea, so on high ground a
parachute stayed reefed all the way down.

Typical line loads on Verda: an Acorn capsule (1.2 t) opening at 160 m/s and 5 km feels 2.8 g in the reefed stage and
2.1 g opening fully; opening at 330 m/s it feels 4.9 g. A drogue opened at 500 m/s and 15 km gives 7.3 g.

## Limits

Each parachute has a line strength (`strength`, kN: 500 for the Canopy Parachute, 1500 for the Grand Canopy M, 1200
for the Streamer Drogue). Line load over the strength tears the canopy away within a quarter of a second
(`TUNING.CHUTE_FAIL`). The sequencer keeps an armed parachute shut while opening would do that, so tearing takes a
craft far too heavy for its parachute, or a change after opening.

## Honest limits

- The stock parachutes are strong for their size, and the Mach limit is generous. With real limits (a main opening
  under about Mach 0.5 and a few kPa of dynamic pressure) the stock capsules, which fall at 135 to 180 m/s near the
  ground, would need a drogue on every flight, and Hopper I, the first tutorial rocket, could not land at all: it
  comes down nose first on its fins at Mach 1.4 and opens there, a jolt of about 18 g, the same as before this change.
- A canopy is a point with one drag area. There is no canopy breathing in the physics, no glide, no line twist, no
  wake of the craft on the canopy, and a cluster loses no drag to its neighbours.
- Filling follows a fixed law of distance and time. It does not depend on the air.
- The lines are rigid and do not stretch, so there is no snatch load when they come taut.

## What checks it

Chapter 11 of `npm run verify` (182 checks). The reference shares no code with the game: it types the constants a
second time and flies a point mass under a point canopy in a plane with Runge-Kutta at 1 ms. It compares the canopy
geometry at every stage, that every drawn line ends on the hem (to a micrometre) and the drawn canopy is as wide as
the flown one, steady sinking speed and line load under every parachute part and on every world with air, the
reefed and full openings (peak load within 0.2 %), the swing after a sideways opening, the Mach and strength limits,
tearing, two canopies side by side, and 20 ms steps against 5 ms.

Writing it found four faults in the first version of the model, all fixed: the carried air was being dragged round
the planet's axis (2 to 5 % too slow a descent for a light capsule), two leaning canopies lost drag they should not,
the sequencer's load forecast ignored gravity (up to 40 % low for a heavy craft), and full opening went by height
above the sea.
