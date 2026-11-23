# Starwright roadmap

The next twelve upgrades, in the order we plan to take them. There are no dates. Each one ships
when it is good, and the order will move as people play and tell us what matters most.

Each item says what it is, why it matters when you are flying, what the game does today, and
what building it involves, so you can see where to start. Every one of them is open for a
volunteer to pick up, whole or in part. [Say hello](../../../issues/new/choose) and tell us
which one you want, and read [CONTRIBUTING.md](../CONTRIBUTING.md) first.

1. [Landing legs that work like legs](#1-landing-legs-that-work-like-legs)
2. [Structural dynamics](#2-structural-dynamics)
3. [Aerodynamic breakup](#3-aerodynamic-breakup)
4. [Higher-fidelity worlds](#4-higher-fidelity-worlds)
5. [Reusable boosters](#5-reusable-boosters)
6. [Deeper aerodynamics and re-entry](#6-deeper-aerodynamics-and-re-entry)
7. [Optional n-body gravity](#7-optional-n-body-gravity)
8. [Stations and surface bases](#8-stations-and-surface-bases)
9. [A deeper career](#9-a-deeper-career)
10. [A faster-than-light drive and a second star system](#10-a-faster-than-light-drive-and-a-second-star-system)
11. [Sharing](#11-sharing)
12. [A desktop app and a seat in the cockpit](#12-a-desktop-app-and-a-seat-in-the-cockpit)

---

## 1. Landing legs that work like legs

**Status: built.** How it works, what was checked against what, and what is still open are in
[LANDING_LEGS.md](LANDING_LEGS.md).

**What it is.** Each leg is its own spring and damper with real travel. A lander compresses its
legs on touchdown, comes back up, and settles. Come in too fast and the legs bottom out; faster
still and they break. Come in sideways or leaning and the lander can tip over.

**Why it matters.** The last two metres of a landing are the most tense part of the whole
flight. With real legs, a wide stance and a slow, level descent are things you design and fly
for, and a landing you walk away from feels earned.

**Still open, for anyone who wants it.**

- Give each leg part its own fixed spring rate, so legs too small for a craft sag and bottom out
  under its weight. Today the spring is sized to the craft.
- Let the foot pad swivel to lie flat on a slope, and let the strut close along its hinge.
- Make legs unfold at the speed they are drawn unfolding when the craft is already on the ground.
- A read-out of leg travel used on the last landing.

## 2. Structural dynamics

**Status: built.** How it works, what was checked against what, and what is still open are in
[STRUCTURE.md](STRUCTURE.md).

**What it is.** The joints between parts are real. Each one carries a load the game works out
every physics step, has a strength set by the size of the parts it joins, bends a little, and
breaks when it is asked for too much: a long thin stack snaps when it is turned hard at maximum
dynamic pressure, a heavy payload overloads a small separator, and a side booster tears off a
clamp that is too small for it. Brace struts now do real work.

**Why it matters.** Structure is half of rocket design. Struts, wide stages and gentle steering
through max Q only mean something if a rocket can fail without them. It also makes failures
readable: the assembly building tells you which joint is closest to its limit and in which
moment of the flight, and in flight you can watch the load rise before it gives way.

**Still open, for anyone who wants it.**

- Let the bend feed back into the flight. Today a bent stack is drawn bent but still thrusts
  straight, so a wobbly rocket is not yet harder to steer.
- Struts between any two points, placed by hand in the assembly building. Today a brace strut
  works when its tip reaches another part, which covers side boosters.
- Loads on a vessel standing on the ground (a rocket on the pad, a lander on a slope).
- Wings that carry their load along the span, so a hard pull-up can fold one.
- Per-part materials: a strength and stiffness for each part instead of one for each size.

## 3. Aerodynamic breakup

**Status: built.** How it works, what was checked against what, and what is still open are in
[AERO_BREAKUP.md](AERO_BREAKUP.md).

**What it is.** A rocket that goes sideways or tumbles in thick air comes apart: side boosters
are ripped from their clamps, antennas and open solar panels are stripped, nose cones go, a fin
caught face on tears off at its root, and the pieces fly on as debris with a push and a tumble
of their own. A clean climb loses nothing.

**Why it matters.** A flip past max Q is the most dramatic thing that can happen on the way up,
and it should look like it. It also teaches: you see what the air did, in what order, and why
a steady hand through the dense part of the climb matters.

**How it is done.** Two mechanisms, kept apart on purpose. Fins and wings now sit on a thin
root and fail under the lift and drag they really carry. Thin, exposed parts (antennas, open
panels, nose cones, booster clamps) carry a rated dynamic pressure, the way every part carries
a maximum temperature, because flutter, buckling and sway-brace failure are not things a
rigid-body load can show. The world keeps at most 24 loose pieces so the frame rate holds.

**Still open, for anyone who wants it.**

- Fins usually hold in a tumble, because the computed load on them is honest and modest. A
  flutter model for fins and wings would make them go the way thin panels do.
- Shielding: a booster in the lee of the core sees the same flow as one in front.
- A dish is judged like a mast, on flow across the stack axis, not on which way it faces.
- Pieces have the drag of their parts and no lift of their own shape, so they do not flutter
  down like a panel.
- Stock rockets with only fins and a strong stack (Skylark II, Hopper) cannot be made to flip
  at all, so they have nothing to shed.

## 4. Higher-fidelity worlds

**Status: first pass built.** Walking-scale craters, ice plates, lava crust and wind ripples
on every world but the home world, eight kinds of loose rock, a high cloud or dust layer on
three worlds, and dawn and dusk light on the clouds. All of it is drawn on top of the ground;
the height the physics uses did not change. How it works, what was checked against what, and
what is still open are in [WORLDS.md](WORLDS.md).

**What it is.** Sharper terrain and textures, better atmospheres, clouds and lighting, and more
on the ground: rocks and craters at walking scale, weather and haze, surfaces that look
different on every world all the way from orbit down to the dust under a rover's wheels.

**Why it matters.** Arriving somewhere is the reward for every transfer burn. The closer the
ground looks to a real place, the more it feels like you went there.

**Today.** All nineteen bodies have procedural terrain with level of detail that refines as you
approach, generated in the browser with no image files. Worlds with air have atmospheric
scattering, and the home world has vegetation. Since the first pass, each world also has
surface features and rocks of its own close up. They are drawn, not built: a rover does not
feel a drawn crater.

**Still open, for anyone who wants it.** Put craters, dunes and canyons into the height
function itself, so they can be driven over and landed in (this changes physics and needs the
independent checks re-run). Weather and ground haze. The high cloud layer on distant globes.
Bigger and clustered rocks. The same feature code for Verda's beaches and bare mountains. All
of it has to stay procedural and stay inside the frame budget on a laptop graphics card. This
is a good place for artists who can write shaders.

## 5. Reusable boosters

**What it is.** Fly the first stage back. After separation the booster flips, makes a boostback
burn, steers through the air on its grid fins, relights and lands on its legs, on the pad or
downrange. You fly it yourself or hand it to a guidance program, while the upper stage carries
on to orbit.

**Why it matters.** It is the defining spaceflight achievement of the last decade and the
reason many people watch launches at all. In career mode it changes the economics: a recovered
booster is money back.

**Today.** The pieces are close. There are grid fins (the Lattice Vane), air brakes, throttle
control, landing legs, and a guidance program that already performs a powered landing on
airless moons. What is missing is following two vessels at once: a stage you leave behind
in the atmosphere is removed once the ship you are flying is out of range of it.

**Building it.** Keep a dropped stage under full physics while the other one flies, with a quick
switch between them. Write boostback, entry and landing guidance that works in air. Add
recovery credit in career mode for stages landed intact. Item 1 makes the touchdown worth
watching.

**Where it stands.** The first of three parts is built: a dropped stage with a guidance ring
keeps flying under full physics at any distance, one key hops between booster and upper stage,
and the ascent assist takes the upper stage to orbit while you fly the booster. Still to come:
guidance that flies the return and lands it, a landing zone and a barge at sea, a stock reusable
rocket, and recovery pay. [What is built, what was measured and what was checked.](BOOSTERS.md)

## 6. Deeper aerodynamics and re-entry

**What it is.** Lift on capsules and bodies, so you can steer a re-entry by rolling. A speed of
sound that changes with altitude. Winds. Heating that depends on the shape and attitude of the
vessel, and parts that shield the parts behind them.

**Why it matters.** Ascent and re-entry are where a design meets the air. Better aerodynamics
means spaceplanes that fly like aircraft, capsules that can aim for a landing site, and
re-entries where your attitude decides whether you live.

**Today.** Drag is computed per part with a transonic rise. Wings and control surfaces have
real lift, stall and induced drag, and spaceplanes fly. Atmospheres are exponential with one
scale height, a hard top and a constant speed of sound. Capsules have no lift. Heating follows
the Sutton-Graves law, and heat shields ablate.
[docs/PHYSICS_VERIFICATION.md](PHYSICS_VERIFICATION.md) lists these limits with measurements.

**Building it.** Add body lift, a temperature profile per atmosphere, occlusion so shielded
parts stay cool, and optional winds. Every change needs a matching check in the verification
suite, so the numbers stay honest. This is the item for people who know aerodynamics.

## 7. Optional n-body gravity

**What it is.** A switch that lets every body pull on your ship at once. That brings Lagrange
points, halo orbits, low-energy transfers and orbits that slowly drift. It starts as an overlay
in the map, showing where the true path leaves the simple one, and grows into a flight mode.

**Why it matters.** It is the difference between the textbook and the real solar system, and
it is the feature players of this genre have asked for longest. Parking a telescope at L2 is a
mission you cannot fly today.

**Today.** The game uses patched conics: one body pulls on you at a time, and bodies run on
fixed rails. That is why orbits are exact at any time warp. The verification suite already
contains an independent n-body integrator and measures how far the two models differ, so the
reference to test against exists.

**Building it.** An integrator that stays accurate and fast under high time warp, a map that
can draw paths that are not conic sections, and a planner that still helps you. It must stay
optional, because the simple model is easier to learn and is what the tutorials teach.

## 8. Stations and surface bases

**What it is.** Somewhere to go and stay. Mine a resource on a moon, refine it into propellant,
store it, and refuel ships in orbit or on the ground. Stations and bases that grow one launch
at a time.

**Why it matters.** It turns single flights into a program. A fuel depot at Pell changes every
mission beyond it, and a base gives you a reason to return to a world you have already landed
on.

**Today.** Docking, undocking and fuel transfer between docked vessels work, vessels persist
between flights, and the tracking station follows all of them. There are no resources to
gather and no drills or refineries.

**Building it.** New parts (drill, refinery, storage, a surface docking connector), resource
maps for each world, processing that keeps running while you are away, and career missions
that ask for it.

## 9. A deeper career

**What it is.** More to do and more reasons to do it: new mission types, experiments particular
to each world, crew who train into specialists, and a program whose story builds from the first
hop to the outer planets.

**Why it matters.** Sandbox is for building. Career is what keeps you playing for months,
because every flight pays for the next.

**Today.** Career mode has funds, science and reputation, a 27-node tech tree, a board with
thirteen kinds of contract, a 71-mission flight program, twelve experiments, and crew who earn
experience. It is complete, and it is still a first pass at balance.

**Building it.** Mission design and balancing more than code. Write contracts, tune costs and
rewards, add experiments and the reasons to carry them, and play it through again and again.
This is one of the best items for someone who does not program.

## 10. A faster-than-light drive and a second star system

**What it is.** A late-game part for the assembly building, the Longstride drive (a working
name), that you earn rather than buy. Fit it to a ship, fly far from any planet, and it carries
the ship to a second star system with worlds nobody has landed on.

**Why it matters.** Helion's system can be finished: every world landed on, every crew brought
home. The drive is the reward for that, and it opens a new map with new flying problems, for
example a double star whose planets do not keep simple orbits, and a heavy world with thick air
that is easy to reach and very hard to leave.

**The rules it must keep.** This is the one deliberately fictional thing in a game that is
otherwise honest physics, so it is fenced in:

- It only moves a ship from one system to the other. It is not an engine and gives no thrust.
- It works only far from any planet or moon, outside every sphere of influence but the star's.
- It is heavy and it uses a great deal of propellant, so a ship that carries it has to be
  designed around it.
- The ship arrives with the velocity it left with. Everything after the jump (capture,
  landing, the trip home) is ordinary orbital mechanics, flown the ordinary way.
- It is earned by achievements, for example landing on every world and returning a crew from
  the farthest one.
- The game says plainly that it is fiction, and it stays out of the independent physics
  checks, which go on covering everything that is real.

**Today.** Not started. There is one star system, and nothing travels faster than its engines
push it.

**Building it.** The body table and the map assume a single star, so the first job is letting
the game hold two systems and switch between them. Then the part and its unlock rule, the
jump itself (conditions, cost, what the player sees), and the new system: its star or stars,
its worlds, their terrain and skies. World design is most of the work, and it builds on
[higher-fidelity worlds](#4-higher-fidelity-worlds).

## 11. Sharing

**What it is.** Export a craft to a file or a link and hand it to someone else. Later, add
community-made parts and scenarios without editing the game's own files.

**Why it matters.** This genre lives on what its players make. A rocket somebody else designed
is a lesson, and a parts pack can make the game new again.

**Today.** Craft are stored as plain JSON in the browser, and a whole saved game can be
exported and imported. Parts are plain data in `js/core/parts.js` with procedural models.
There is no way to share one craft, and adding a part means editing the source.

**Building it.** Craft export and import first, which is small and a good first contribution.
Then a format for part and scenario packs that the game loads at start, with checks so a bad
pack cannot break a save.

## 12. A desktop app and a seat in the cockpit

**What it is.** Three things that make it feel like a finished game: an app for Mac and Windows
that you double-click, with no terminal window and no browser tab; a view from inside the
capsule, with the instruments in front of you and the world through the window; and fuller
sound, with engines you feel, the quiet of vacuum, and music.

**Why it matters.** A game is easier to love when it starts like one. And riding a launch from
the seat is a different experience from watching it from outside.

**Today.** The game runs in a browser tab, from the hosted page or from a small local server
started by a launcher script. The camera has four outside views and none inside. Sound is synthesised in the browser:
engine rumble, wind and effects, with a simple ambient pad on the menus.

**Building it.** Wrap the existing game in a desktop shell, with signed installers so the
operating system does not warn about it. Model capsule interiors and working instruments.
Extend the sound engine. Three separate jobs, for three different kinds of volunteer.
