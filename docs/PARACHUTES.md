# Parachutes

How a parachute is flown and drawn. Code: `js/core/parachute.js` (numbers, no engine), the canopy step in
`js/core/vessel.js` (`_updateChutes`, `_chuteForces`), the cloth and lines in `js/render/canopy.js`.
Checks: `tests/verify/checks_parachute.mjs` against the independent `tests/verify/ref_parachute.mjs` (chapter 13).

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

1. **Armed.** The parachute stays packed until the air is thick enough to fill it, the craft is under the Mach number
   the canopy is built for, and the sequencer's own forecast of the opening load on the mass it carries is under 80 %
   of the line strength. While it waits, the flight screen says which of the three it is waiting for.
2. **Drogue.** Every main pack carries a small drogue (`chute.drogue`: 3.4 m across in the Canopy Parachute). It is a
   ribbon canopy made for fast thin air: out under Mach 3 in as little as 0.0002 atm (49 km on Verda). It flies as a
   canopy like any other, on its own short lines, and holds the craft steady and slows it. When the main's own
   conditions are met (0.02 atm, under Mach 0.4, load inside the margin) and the drogue has been out 2 seconds, the
   drogue is let go and pulls the main out. A craft already slow enough when armed skips the drogue.
3. **Reefed.** The mouth fills over 3 nominal diameters of travel, and a reefing line pays out from 3 % to all of the
   reefed drag area over 6 seconds. This is what turns one sharp shock into a pull spread over seconds.
4. **Fully open**, below `fullAlt` (900 m for mains) above the ground, once the reefed stage is all the way out, or
   sooner if the mouth has filled and the forecast load of opening fully is inside the margin (a parachute opened low
   and slow). The canopy opens over 4 nominal diameters of travel.

Height for step 4 is above the ground under the craft. It used to be height above the sea, so on high ground a
parachute stayed reefed all the way down.

Typical line loads on Verda: an Acorn capsule (1.2 t) opening at 160 m/s and 5 km feels 2.8 g in the reefed stage and
2.1 g opening fully. A Streamer Drogue opened at 500 m/s and 15 km gives 7.3 g.

Hopper I, the first tutorial rocket, has no decoupler and falls from 92 km nose first on its fins. Its drogue opens at
49 km at Mach 2.9, where the air is so thin that the pull is small, and the worst of the whole descent is 4.0 g. The
main comes out at 12 km once it is under Mach 0.4. Before the drogue, the main itself opened at Mach 1.4: about 18 g.

## Limits

| | opens under | air needed | lines hold |
|---|---|---|---|
| Canopy Parachute (main) | Mach 0.4 | 0.02 atm | 150 kN |
| Radial Parachute (main) | Mach 0.4 | 0.02 atm | 135 kN |
| Grand Canopy M (three mains) | Mach 0.4 | 0.02 atm | 450 kN |
| the drogue in each of those | Mach 3 | 0.0002 atm | as its main |
| Streamer Drogue | Mach 3 | 0.0002 atm | 400 kN |

Line load over the strength tears the canopy away within a quarter of a second (`TUNING.CHUTE_FAIL`). The sequencer
keeps an armed parachute shut while opening would do that. Opening fully at 900 m is not held back, so a craft far
too heavy for its parachute tears it there: a Canopy Parachute holds up to about 3.7 t, which is also about the mass
it can set down at under 10 m/s. Until November 24 the mains were rated Mach 1.5 and 500 kN, which no cloth canopy is.

## After touchdown

On the ground or the sea the lines are let go and the canopy is no longer flown. The picture keeps it: it topples to
one side over about three seconds, loses its air and lies beside the craft (`chuteDown` in `js/render/partmesh.js`).
This is drawing only. A canopy torn away in flight is simply gone.

## Honest limits

- The drogue is part of the pack and cannot be staged or cut on its own, and it weighs nothing extra. The main waits
  for Mach 0.4 and no longer; a real sequencer would also wait for a height, so a capsule can spend minutes under its
  reefed main from 12 km.
- The collapsed canopy on the ground is a picture. It does not drag in wind or water and it passes through terrain.
- A canopy is a point with one drag area. There is no canopy breathing in the physics, no glide, no line twist, no
  wake of the craft on the canopy, and a cluster loses no drag to its neighbours.
- Filling follows a fixed law of distance and time. It does not depend on the air.
- The lines are rigid and do not stretch, so there is no snatch load when they come taut.

## What checks it

Chapter 13 of `npm run verify` (261 checks). The reference shares no code with the game: it types the constants a
second time and flies a point mass under a point canopy in a plane with Runge-Kutta at 1 ms. It compares the canopy
geometry at every stage, that every drawn line ends on the hem (to a micrometre) and the drawn canopy is as wide as
the flown one, steady sinking speed and line load under every parachute part and on every world with air, the
reefed and full openings (peak load within 0.2 %), the swing after a sideways opening, the Mach and strength limits,
tearing, two canopies side by side, 20 ms steps against 5 ms, and the drogue each pack carries: its size and
descent against the reference, the order drogue, reefed, full, and that the main is never loaded past its lines.

Writing it found four faults in the first version of the model, all fixed: the carried air was being dragged round
the planet's axis (2 to 5 % too slow a descent for a light capsule), two leaning canopies lost drag they should not,
the sequencer's load forecast ignored gravity (up to 40 % low for a heavy craft), and full opening went by height
above the sea.
