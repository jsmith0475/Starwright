# Boulders you can hit

Before this change the rocks on every world were a picture. A rover drove through them, a lander
stood with a leg inside one, and a Pip walked out the far side. Now every boulder you can see is a
solid thing, and the one the physics hits is the one that is drawn.

## One field, used twice

`js/core/boulders.js` decides where every boulder is. It has no drawing code in it. The renderer
(`js/render/scatter.js`) asks it for the boulders of each ground cell and draws exactly those, and
the physics (`js/core/vessel.js`) asks it for the boulders near a vessel and collides with exactly
those. Nothing is stored: a cell's boulders are worked out from the world's seed and the cell's
place on the globe, so they are the same every time, on every machine and after every reload.

- The globe is cut into cells about 64 m across on a cube-sphere grid.
- Each cell holds a fixed number of boulders set by the world's style (`ROCK_FIELD`).
- Each boulder has a place, a size, a turn, a lean, how deep it sits, and a kind (worn, angular,
  slab, shard, ice, clinker, clod, ventifact).
- There are none within about 3 km of the home pad or below the waterline.

The placement is the same as it was when the renderer chose it alone. The rocks did not move.

## The solid shape

Each boulder collides as a rounded box (a superellipsoid) fitted to its drawn model: three
half-widths taken from the model's bounding box, and a squareness that depends on the kind. Worn
rocks are close to an ellipsoid; slabs and angular blocks have nearly flat tops and sides.

`boulderProbe` gives the distance from a point to that surface and the direction out of it. That
is all the contact code needs.

## What touches a boulder

- **Wheels.** The hub is tested against the rock grown by the tyre radius, so a wheel rolls up
  and over a low stone and is stopped by a tall one. On a steep rock face the tyre grips less.
- **Legs, hulls and everything else.** A point that comes down on top of a boulder stands on it:
  the rock is ground there. A point that runs into the side of one is pushed back out along the
  rock's own surface. Hitting one fast breaks parts by the same rule as hitting the ground.
- **Pips on foot** are stopped at knee height and can walk away again.

## The autopilots know about them

- **Landing.** A boulder under the footprint makes a site unfit (`assessSite().boulder`,
  see [LANDING_SITES.md](LANDING_SITES.md)). In sweeps of 24 landings each on Pell, Nock, Dray and
  Ost with the boulders solid, 96 of 96 stand.
- **Rover cruise control.** It looks 16 m or more ahead for boulders tall enough to stop a wheel,
  picks the nearest open lane, turns harder the closer the rock is, and slows so that it can stop
  short. Brought up against one with no room to turn, it backs off a few metres and goes round. It
  does not back off on a steep slope, where reversing downhill is how a rover goes over.
  `c.driven` is now the distance from where the drive began, so going round a rock is not counted
  as progress.
- **Scenario start routes** for rovers prefer a first 320 m without a boulder on the line.

## Limits, stated plainly

- Pebbles, grass and trees are still pictures. Only boulders are solid.
- The solid shape is a rounded box, not the drawn mesh. A shard's point and a slab's overhang are
  approximated, so on a large rock the place a wheel stops can be visibly off the drawn surface.
- Boulders are looked up one cube face at a time. A vessel right at the seam between two faces
  does not feel a boulder that sits just across it.
- Landing legs treat a rock top as ground. A foot does not slide off a sloping top the way a real
  one might.
- The lowest graphics setting used to draw no boulders. It now draws them (without pebbles, grass
  and trees), because a rock you can hit has to be a rock you can see.
- `BOULDERS.solid = false` turns the collision off. Tests use it to compare with and without.

## Tests

`tests/unit/boulders.test.js`: the grid matches the renderer's, the shapes match the models, the
field is the same every time, a rover is stopped by a metre-high rock and rolls over a low stone,
a lander stands on one leaning, a Pip is blocked, and the landing autopilot does not choose
ground with a boulder on it.
