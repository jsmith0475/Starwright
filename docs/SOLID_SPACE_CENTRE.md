# The solid space centre

Until November 2026 the only solid things at the Flight Center were the ground, the sea, the barge deck, boulders and
(from PR 47) the Catch Tower's column and arms. A rocket that fell back onto the pad passed through its launch mount,
and a craft could fly through the assembly building. Now the space centre is solid.

## What is solid

| Solid now | How it is shaped |
|---|---|
| Every building (assembly building, spaceplane hangar, tracking station, research lab, mission control, crew quarters, flight school, administration, the runway's buildings) | the boxes, drums, balls and rods the drawing is made of |
| The launch pad: service tower, hammerhead crane, lightning masts, floodlight towers, flame trench walls, propellant spheres and tanks, water tower, pipe runs, the ops bunker | the same |
| The launch mount under the rocket on the pad (planned for each rocket by `js/render/padfit.js`) | the ring, legs and braces as drawn |
| The scenery: water tower, warehouses, fuel tanks, gatehouse, lamp posts, the parked crawler | the same |
| The Tall Bay beside the Catch Tower | its body, door frame and low wing |
| The Catch Tower's column and arms | `js/core/tower.js` (PR 47) |

Not solid: trees and grass, cars and trucks, walking Pips, fences, paving and markings, lamp heads, the mount's clamps
and the service tower's swing arms (they swing away at lift-off), the dish antennas' moving parts beyond the ball they
sweep.

## Where the shapes come from

The physics does not keep a second model of the space centre. `recordSiteSolids()` in `js/render/basegfx.js` runs the
drawing's own builders through a kit that keeps only solid shapes (a lattice mast becomes one box per quarter of its
height), and `tests/tools/site_solids.mjs` writes them to `js/core/sitesolids.js` (1,417 shapes). A unit test fails if
the drawing changes and that file was not written again:

    node tests/tools/site_solids.mjs

The launch mount is planned and recorded the same way at run time, from the same `planPadFit` the drawing uses.

## What happens on contact

`js/core/structures.js` tries every part of a vessel near the space centre as balls (the Catch Tower's `eachBall`) and
uses the same contact rule as the tower (`strikeSteel` in `js/core/tower.js`), which follows the ground's rule
(`Vessel._groundContact`):

- If the body part pressed deepest meets the solid faster than `TUNING.CRASH_ALL` (2.2) times its crash tolerance, the
  whole vessel is lost (reason `structure`).
- Otherwise every touching part met faster than its own tolerance breaks off and soaks up some of the speed, and what
  is left goes on and meets the solid with whatever touches next.
- A slower touch stops the vessel against the solid and sets it back out of it.

What hangs on the side (fins, flaps, legs) only breaks off: it cannot make the whole vessel lost on its own. This rule
now applies to the Catch Tower too.

The rocket a mount was fitted round rests on the deck inside it, so the mount is not solid to that rocket until it has
climbed clear of it (or moved 40 m away). Falling back, it meets the ring.

The game says what happened: "Struck the Vehicle Assembly Building: the Tail Fin broke off", or "Scraped the launch
pad with the Acorn Capsule".

## Checked

- Unit tests: `tests/unit/structures.test.js` (shapes match the drawing; nothing within 10 m of the pad axis below 90 m;
  the runway and Return Pad are clear; every stock craft leaves its site untouched; a Skylark II falling back from
  15 m loses its fins and engine on the mount and from 30 m is lost; a capsule hitting the assembly building at
  40 m/s is lost and at 3 m/s is stopped outside the wall).
- In the real game: `tests/e2e/preview_structures.mjs` (groups `fallback`, `bump`, `crash`) flies the same cases in the
  browser and prints what the game said.
- Cost: on a Shearwater lift-off (the worst case: tall, many parts, next to the service tower) no measurable change
  in the physics step time.

## Limits

- A vessel that comes to rest on a roof is held there by repeated small pushes, not by the ground's "landed" state; it
  will keep a slight jitter and cannot be recovered from there.
- The shapes are the drawing's primitives, not its exact triangles: a dome is taken as a whole ball, a tapering
  lattice mast as four boxes, a dish antenna as the ball it can sweep.
- Hitting the service tower's swing arms before they swing away is not caught (they are not solid).
- Vessels do not yet collide with each other.
- The hammerhead crane's jib on the service tower was shortened from 4 m to 11 m off the pad's axis, so the drawing
  keeps the stated rule that nothing fixed comes within 10 m of it (a Shearwater on the pad would have struck it).
