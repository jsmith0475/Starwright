# Aerodynamic breakup

A rocket that goes sideways or tumbles in thick air sheds parts: side boosters are ripped from
their clamps, antennas and open solar panels are stripped, nose cones go, a fin caught face on
at high speed tears off at its root, and the pieces fly on as debris. A clean climb loses
nothing.

This is roadmap item 3. It builds on [structural dynamics](STRUCTURE.md) and uses its joints,
its damage rule and its break-up code. Read that document first for the free-body loads.

## Why loads alone were not enough

Structural dynamics works out what every joint must carry for the vessel to move the way it
does. Before this change, a flip or a tumble at maximum dynamic pressure (20 to 30 kPa) put
fins, panels, nose cones and booster clamps at 1 to 40 % of their strength. Two reasons:

- **Only differences load a joint.** A side booster in a cross-flow is pushed sideways, but so
  is the core. The clamp carries only the difference between the booster's drag deceleration
  and the core's, and that is small.
- **The game's joints are strong for good reason.** A clamp is a thrust fitting (strength
  factor 6.5), sized so that a booster can push a core.

So a rigid-body load cannot rip a booster off, and that is honest: real boosters do not come
off because the steady side load beats the bolts. They come off because the sway braces fail,
panels flutter, and thin shells buckle. Those are failure modes a rigid-body load does not
show. The game therefore uses two mechanisms, and says which is which.

## Mechanism 1: fins and wings fail at a thin root (computed load)

A fin or a wing is held on by its root: a long, thin rectangle, `h` along the stack axis and
`t` thick. It used to be treated as a ring with the same perimeter, which is far too stiff
across the thin direction. Now the joint is that rectangle.

    perimeter            P     = 2 (h + t)
    enclosed area        A     = h t
    flat-wise section    zFlap = h t + t² / 3        (bending about the chord: the weak way)
    edge-wise section    zEdge = h t + h² / 3        (bending in the plane of the fin)

    peak tension line load      n_t = max(0,  N / P + |Mc| / zFlap + Me / zEdge)
    peak compression line load  n_c = max(0, −N / P + |Mc| / zFlap + Me / zEdge)
    peak shear flow             q   = 2 V / P + Mt / (2 h t)

    utilisation u = max( n_t / capT, n_c / capC, q / capS )

`Mc` is the bending moment about the chord (lift tries to fold the fin flat against the hull),
`Me` the moment about the axis normal to the fin. The section moduli are those of a thin-walled
rectangular line of fasteners; the shear flow from twist is Bredt's formula for a closed
section. The allowable line loads are the same `STRUCT.LINE_T`, `LINE_C`, `LINE_S` as every
other joint, times a factor for the class of part (`STRUCT.MOUNT_FACTOR`): 0.7 for a fin, 3 for
a wing or a tail fin, 4 for an elevon.

The load is the real one: the lift and drag the flight model already applies to that fin, less
what its own mass needs. Nothing is added. What that gives:

- Flown straight, no fin root on a stock rocket passes 3 % of its strength. On the ascent
  autopilot, which tips the rocket over through the dense air, the highest is 52 %.
- Face on to the flow at high dynamic pressure, a large fin tears off. Farwind loses a Broad
  Fin in a flip at max Q.
- Fins mostly hold in a tumble. Four fins in an X share a side load two and two, and a fin
  stalls: past its stall angle the flat-plate force is what it is. That is what the numbers
  say, and it has been left alone.

## Mechanism 2: air ratings (a stated limit, like the temperature limit)

Thin, exposed parts carry a rated dynamic pressure, the way every part carries a maximum
temperature. It stands for the failure modes a rigid-body load cannot show.

| part | rating | judged on |
|---|---|---|
| Sunfoil solar panel, open | 3 kPa | the whole airflow, only while open |
| solar wing, open | 2.5 kPa | the whole airflow, only while open |
| grand solar array, open | 2 kPa | the whole airflow, only while open |
| whip antenna | 12 kPa | flow across it |
| dish antenna | 10 kPa | flow across it |
| large dish | 8 kPa | flow across it |
| radial release clamp or truss (a side booster's mount) | 12 kPa | flow across it |
| fairing | 12 kPa | flow across it |
| nose cone | 15 kPa | flow across it |

Fixed solar tiles, tanks, engines, capsules, legs and everything else have no rating: they are
judged by their joints. The table is `AIR_RATING` in `js/core/parts.js`; a part can override it
with an `air` field, or opt out with `air: null`. The Assembly Hangar shows the rating on the
part card as "Air limit".

**Flow across a part** is the dynamic pressure of the component of the airflow at right angles
to the part's own axis, which for most parts is the stack axis:

    q_cross = ½ ρ (v² − v_axial²)

`v` is the velocity of the air relative to that part, including the vessel's spin about its
mass centre (a part far from the centre of a tumbling ship sees more). Nose first, `q_cross` is
zero however fast the rocket goes, so a clean climb does not touch these ratings. At 30° off
the flow it is a quarter of the full dynamic pressure, broadside all of it.

**An open panel** is judged on the whole dynamic pressure `½ ρ v²`, from any direction, and only
while it is open. Stowed, it has no load.

**A clamp that holds nothing** (left on a dropped booster) has nothing to sway and is not judged.

### How long it takes

The same damage rule as a joint, with its own time constant:

    while q > rated:   damage += (q / rated − 1) · dt / AIR_FAIL_TIME        (AIR_FAIL_TIME = 0.25 s)
    otherwise:         damage −= dt / HEAL_TIME
    at damage = 1 the part's joint is cut.

At twice its rating a part lasts a quarter of a second; 10 % over, two and a half seconds. A
brief excursion heals. `vessel.airLoads()` reports every rated part's pressure, rating,
utilisation and damage.

## The force on an open panel

An open solar panel used to add a little drag. It is now a flat plate:

    F = −½ ρ C_D A v_n |v_n| n,      C_D = 1.8,   A = span × height

with `n` the normal to the panel's face and `v_n` the airflow through the face, applied at the
middle of the span. It is real force: it slows and turns the vessel, and it loads the panel's
joint. Below Mach 0.7 the factor is exactly this; above, the game's usual Mach rise applies.

## What happens to the pieces

A torn-off part goes through the same code as a broken joint: the part and everything attached
beyond it become a debris vessel with the position, velocity and spin it had. Two things are
added so the pieces separate:

- **A push apart**, at most 1.2 m/s relative speed and at most 1500 N·s, shared by mass so the
  total momentum is unchanged. The ship barely notices; a 50 kg antenna leaves smartly.
- **A tumble** of up to 2.5 rad/s about each axis, less for pieces with a large moment of
  inertia.

The debris then flies under the same aerodynamics as everything else, and its own parts can
tear off in turn: a booster ripped from a core usually loses its nose cone a moment later.

**The limit.** The world keeps at most 24 loose pieces in flight (`MAX_DEBRIS` in
`js/core/world.js`). When a new one would pass that, the lightest is removed. Light debris
(under 1000 kg) that later burns up or hits the ground far away goes without a message.

## What the player sees

- A message: "The Whip Antenna was torn off by the airflow: 18 kPa across it, rated for 12 kPa",
  or for a panel "... 4.5 kPa on it while open, rated for 3 kPa". Fins use the joint wording:
  "The Broad Fin broke away from the ...: bent too far".
- The Structure read-out shows the air rating when it is the highest number on the vessel
  ("Radial Release Clamp: airflow, 84 %"), and the hull groans from 75 %.
- Sparks and a separation sound at the break, as for any joint.
- **Structural failures** off in Settings switches this off too: everything is still measured
  and shown, nothing comes off. In code, `TUNING.AERO_FAIL = false` switches off the air
  ratings alone.

## Tuning: the stock rockets

The ratings and the fin factor were set by flying every stock rocket.

- **Clean climbs lose nothing.** Straight up at full throttle through max Q (26 to 54 kPa),
  no rated part of the ship reads above 1 % and no fin root above 3 %. On the ascent autopilot
  every stock rocket reaches orbit with nothing torn off the ship; the highest readings are
  52 % on a fin root and 60 % on an air rating. That 60 % is Whisper Probe, whose upper stage
  tumbles briefly after staging at 26 km; it did so before this change.
- **Dropped boosters shed their nose cones** as they tumble away. That is debris breaking up,
  not the ship.
- **Pitched hard over at max Q and held:** Ember Twin, Latch Chaser, Colossus, Farwind and
  Hearthstone lose every side booster, then antennas and dishes, and the loose boosters lose
  their noses. Farwind also loses a Broad Fin. The tall thin stacks (Trundle, Whisper, Pell
  Runner, Colossus) still snap in two as before.
- **What does not come apart:** Skylark II and Hopper cannot be flipped at all with their
  control authority (they reach 17° off the flow), and a rocket with only fins and no rated
  parts loses little besides a stack joint. Fins usually stay on.

## Limits of the model

- An air rating is a stated limit, not a computed stress. It is the same kind of number as a
  part's maximum temperature.
- Cross-flow uses the part's own axis. A dish is treated like a mast: it is judged on flow
  across the stack axis, not on which way the dish faces.
- Parts shield nothing: a booster in the lee of the core sees the same flow as one in front.
- There is no flutter and no dynamics of the break itself; a part is on, and then it is off.
- Debris has the drag of its parts and no lift of its own shape.
- Wings still carry their load at the root only. A wing does not fold in the middle
  (see the structural dynamics entry in the roadmap).
- The vessel's rotational inertia defect described in STRUCTURE.md is untouched by this work.

## What was checked

Chapter 8 of the independent verification (`tests/verify/checks_breakup.mjs`, with the thin-root
reference in `tests/verify/ref_structure.mjs`). The reference shares no code with the game.

| group | what is compared | agreement |
|---|---|---|
| 8a | thin-root utilisation against line loads fitted and integrated round the rectangle by Gauss-Legendre quadrature, 400 random cases plus one by hand | 1e-14 |
| 8b | the pressure the game reads on every rated part, against the vessel's public state before the step (position, velocity, attitude, spin, the body's rotation and atmosphere), eight attitudes and spins per craft | 1e-15 |
| 8c | the force and moment of an open panel, from the difference between two identical probes with one panel open, against the flat-plate formula | 3e-9 |
| 8d | which part is torn off and on which physics step, against the damage rule replayed from the state; a brief gust heals; nothing breaks with failures off | same step, same parts |
| 8e | mass, momentum and mass centre of ship plus pieces against an unbroken twin in a second world; push and spin within their limits | 1e-12 |
| 8f | stock rockets: clean climbs lose nothing and stay under half of every limit; a flip at max Q strips every side booster | pass |
| 8g | 40 antennas on one core, broadside: all torn off, never more than 24 loose pieces | exact |

Chapter 7 (structures) was extended so that its live-flight and failure-timing checks use the
thin-root reference for fins and wings. Unit tests: `tests/unit/breakup.test.js`.

One thing the checks caught while they were being written: the test set-up had the air turning
the wrong way round the planet. The game and the reference, computed separately, agreed with
each other and disagreed with the set-up, which was the part that was wrong.

All 1,274 checks of the verification pass (861 orbital and flight, 300 structural, 113 here), and
the 428 unit tests. In a browser, `tests/e2e/breakup.mjs` launches the stock Colossus from the
menus, pitches it over at 20 kPa and watches two booster trusses, the antenna, two nose cones
and two fins come off, with the messages on screen.

## Cost

Two to three microseconds more per physics step on the largest stock rockets (Farwind 35 to 38,
Colossus 21 to 23, whole world step, Node on a cloud machine): about a five-thousandth of a
frame. The debris limit bounds the worst case.

## API

```js
// js/core/parts.js
AIR_RATING                      // { shape or shape_variant: { q (Pa), flow: 'cross' | 'open' } }
airRating(def) → { q, flow } | null

// js/core/structure.js
rootSection(h, t) → { per, area, zFlap, zEdge }
jointUtilisation(F, M, n, r, capT, capC, capS, root = null)    // root: { h, t, c:[unit chord] } for a thin root
structure.jointOf(part)          // the joint that holds a part on
// joints of a fin or wing carry rh, rt (root length and thickness, m); 0 on every other joint

// js/core/vessel.js
TUNING.AERO_FAIL                 // false: ratings are read and shown, nothing is torn off
vessel.airUtil, vessel.airWorst  // highest pressure / rating this step, and that part
vessel.airLoads() → [{ part, name, q, rated, open, util, damage }]

// js/core/world.js
MAX_DEBRIS, SCRAP_MASS
```

Events: a torn-off part raises the usual `decouple` and `structure` events, with
`mode: 'airflow'` and `air: { part, name, q, rated, open }` on the `structure` event. A `stress`
event with `air: true` is raised when the highest air reading first passes `STRUCT.WARN`.
