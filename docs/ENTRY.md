# Flying an entry: trim, bank and the path through the air

How a capsule in Starwright makes lift on the way down, how the pilot steers with it, and how
the game predicts where the entry ends. This is step C of roadmap item 6
([the specification](REENTRY_SPEC.md), [the science behind it](REENTRY_SCIENCE.md)). Step B
([AERODYNAMICS.md](AERODYNAMICS.md)) made the air force on a body depend on its shape and
attitude. A capsule held at an angle to the air has lifted since then. This step lets it hold
that angle by itself, turn the lift where the pilot wants it, and see the result before
flying it.

Nothing here changes a flight unless the player switches it on. A capsule with Entry trim off
is balanced, rests shield first at no angle, and enters ballistically exactly as before.

The code is `js/core/vessel.js` (`_solveTrim`, `bankAttitude`, the Bank hold branch of the
attitude hold), `js/core/entry.js` (the predictor), and the Entry box of `js/ui/hud.js`. The
independent references are `tests/verify/ref_entry.mjs` and the meshes of
`tests/verify/ref_aero.mjs`.

## 1. Entry trim

Real capsules are built with their centre of mass a few centimetres off the axis. The air
force on the rounded heat shield then has no moment about the centre of mass only when the
capsule sits at an angle to the flow, so it settles there and stays. At that angle the force
on the shield has a part across the flow: lift.

In the game this is a switch on the capsule, **Entry trim**, off by default. Switching it on
moves ballast inside the capsule sideways, along the vessel's own +x axis. The shift is chosen
so that the vessel rests at **18 degrees** to the air with its wide end leading.

### How far the ballast moves

Take the stack parts on the capsule's axis, moving at the trim angle $\alpha_t$ above Mach 4,
where the force is Newtonian ([AERODYNAMICS.md](AERODYNAMICS.md), section 3). Each part's
table gives its force along the axis $F_{y,i}$, across it $F_{x,i}$, and its moment about its
own centre $M_i$. With the part at height $y_i$ and the centre of mass at height $y_c$ and
sideways offset $e$, the moment about the centre of mass is

$$M(e) = \sum_i \left[ M_i - (y_i - y_c)\,F_{x,i} \right] - e \sum_i F_{y,i}$$

Setting it to zero gives the offset:

$$e = \frac{\sum_i \left[ M_i - (y_i - y_c)\,F_{x,i} \right]}{\sum_i F_{y,i}}$$

Parts in the shadow of the heat shield count for a tenth, as they do in flight. The capsule's
own mass point is moved far enough to put the whole vessel's centre of mass at $e$, and it
enters the moment of inertia by the parallel-axis rule. The ballast cannot move further than
half the capsule's radius, so a capsule still bolted to a heavy stack trims at less than 18
degrees. $e$ is worked out again whenever the mass changes (ablator burning away, a stage
dropped).

| capsule and shield | shift of the centre of mass | lift over drag at trim |
| --- | --- | --- |
| Acorn Capsule on Ablative Shield M | 28 mm (4.3 % of the shield's radius) | 0.27 |
| Hearth Command Module on Ablative Shield L | 61 mm (4.7 %) | 0.27 |

For comparison, Apollo's command module flew with its centre of mass a few percent of its
radius off the axis and a lift over drag near 0.3 (approximate, from memory).

### A correction to the specification

The specification (C2) gave the offset as $(R_c - x_{cg})\tan\epsilon$ with $\epsilon$ the
trim angle. That is not right, and the game does not use it. On a spherical cap every element
of force points at the centre of curvature, so the net force passes through that centre, but
it does not point along the flow. It points close to the capsule's own axis, at the angle
$\arctan(C_N / C_A)$ from it:

$$C_A = \cos^2\alpha\,\frac{1 + \cos^2\varphi}{2} + \sin^2\alpha\,\frac{\sin^2\varphi}{4}, \qquad C_N = \sin\alpha\cos\alpha\,\frac{\sin^2\varphi}{2}$$

For the 25 degree cap at 18 degrees that angle is 1.8 degrees, not 18. The centre of mass
must lie on that line, so the offset is about a tenth of what the specification's formula
gives: centimetres, as on real capsules, where the formula gave a third of a metre. The same
1.8 degrees is why the lift over drag is $\tan(18° - 1.8°) = 0.29$ for the bare cap. The
check group 11a compares the closed form with the triangle meshes at 5, 18 and 30 degrees.

## 2. Bank hold

Lift across the flow can point anywhere round the velocity: up, down, or to either side. The
angle is the **bank**: 0 degrees is lift straight up, 180 is straight down, and a positive
bank puts the lift to the right of the path looking along it. A capsule steers an entry with
nothing else. Lift up stretches the path and lowers the g; lift down shortens it and raises
the g; a bank to one side moves the landing point sideways.

**Bank hold** is a new attitude-hold mode. It steers all three axes to the trim attitude,
turned about the air-relative velocity so the lift points at the commanded bank. The roll
keys (Q and E) no longer roll the capsule directly: they turn the commanded bank at 20
degrees a second, and the hold does the flying. It uses the same reaction wheels and
thrusters as the other hold modes and spends the same charge and monopropellant.

Without Entry trim, Bank hold keeps whichever end is leading into the wind at no angle and
holds the roll, which is all a ballistic capsule needs.

The target attitude is built from two pairs of directions. In the vessel's own axes the trim
solution gives the direction of motion $\hat u_b = (\sin\alpha_t, \cos\alpha_t, 0)$ and the
unit lift direction $\hat l_b$ across it. In the world, $\hat u$ is the velocity through the
air, $\hat h$ is straight up with its part along $\hat u$ removed, and $\hat r = \hat u \times \hat h$ is the right-hand side. The commanded lift direction is

$$\hat L = \cos b\,\hat h + \sin b\,\hat r$$

The hold steers to the attitude that carries $\hat u_b$ to $\hat u$ and $\hat l_b$ to $\hat L$.

## 3. The instruments

An **Entry** box opens under the resources while the vessel is in an atmosphere above Mach 3,
while Bank hold is on, or while a capsule with Entry trim is on a path into the air.

| line | what it shows |
| --- | --- |
| TRIM, BANK | The two switches. TRIM shows only on a vessel with a capsule that has it. |
| Bank | The bank now, from the lift the air is really making, and the commanded bank under Bank hold. |
| Lift / drag | The air force of the last step, split across and along the airflow. |
| Heat flux | The heating flux now, in kW/m². |
| Peaks ahead | The peak g and peak heat flux the predictor finds on the present path. |
| This path | "down in 6m 12s", or "skips back out to space". |

Above Mach 3 the attitude ball carries a yellow arrow head, the **lift marker**: the direction
the air is pushing the vessel across its path. Entry trim is also an action for action groups.

## 4. The entry predictor

`predictEntry` flies a point mass from the vessel's present state to the ground, or back out
of the top of the air. The forces are gravity, drag against the air-relative velocity, and
lift across it:

$$\mathbf{a} = -\frac{\mu}{r^3}\,\mathbf{r} \;-\; \frac{q\,C_D A(\mathrm{Ma})}{m}\,\hat u \;+\; \frac{L}{D}\,\frac{q\,C_D A(\mathrm{Ma})}{m}\left(\cos b\,\hat h + \sin b\,\hat r\right)$$

- $C_D A(\mathrm{Ma})$ is the vessel's own table of drag area against Mach number for the end
  that leads (`Vessel.axialDragTable`), times the share of it the vessel shows at its trim
  angle (0.88 for the Acorn).
- $L/D$ is the trim solution's figure with Entry trim on, zero without. It fades out between
  Mach 1.5 and Mach 0.7, where a falling capsule has little lift left to steer with.
- $b$ is the commanded bank under Bank hold, else the bank the vessel has now.
- The air turns with the world. The world's own density and speed of sound are used.

It is integrated with the classical fourth-order Runge-Kutta method: steps of up to 20 s above
the air, a second in thin air, half a second where the deceleration is above 5 m/s², a
quarter second below 3 km, and never more than a twentieth of a scale height up or down in
one step. The end is found by stepping back along the last step to the exact crossing. One
prediction of a whole entry takes under a millisecond. The flight screen makes one twice a
second and shares it with the map.

The result is one of four endings: it lands, it skips out, it never meets the air, or time
runs out. With it come the time to the end, the place, the peak deceleration (drag and lift
together) and the peak heat flux $K\sqrt{\rho}\,v^3$, the game's own heating law.

**On the map** the path through the air is drawn in amber from the top of the atmosphere to
a cross where it comes down, labelled with the time, the peaks and the latitude and
longitude. The impact point of the airless orbit, which used to be all the map showed, is
hidden while the entry path is there. A path that skips out is followed by the dashed orbit
it leaves on.

## 5. What it does in flight

The Acorn Capsule on its heat shield (1,110 kg), flown in the game's own flight model from
the top of Verda's air, with the prediction made at the top beside it:

| entry | bank | peak g flown | predicted | peak heat flux flown | predicted | ends |
| --- | --- | --- | --- | --- | --- | --- |
| low orbit, 2,300 m/s at 1.5° | no trim | 3.13 | 3.11 | 94 kW/m² | 96 | 740 km downrange, 4.7 km from the predicted point |
| | lift up | 1.83 | 1.78 | 82 | 84 | 852 km, 8.0 km |
| | 60° right | 2.42 | 2.41 | 91 | 94 | 793 km, 6.4 km |
| | lift down | 5.29 | 5.19 | 119 | 121 | 694 km, 3.4 km |
| from Pell, 3,300 m/s at 12° | lift up | 0.91 | 0.87 | 199 | 200 | skips out at 2,681 m/s (2,708 predicted) |
| from Pell, 3,300 m/s at 14° | lift up | 2.53 | 2.43 | 287 | 291 | down |
| | lift down | 8.33 | 8.13 | 343 | 348 | 260 km, 3.3 km |

Lift up takes 42 % off the peak g of an orbital return and adds 112 km of range; lift down
adds 69 % and takes 46 km off. The pattern is the specification's (2.75, 1.55 and 4.5 g for
a lighter capsule): the Acorn on its shield has a ballistic coefficient of about 500 kg/m²
where the specification's table assumed 300, so every figure is a little higher.

Coming home from Pell at 12 degrees with the lift up, the capsule skips back out of the
atmosphere with 2.7 km/s left. With no trim it is captured at that angle (2.9 g). The entry
corridor is real: too shallow with the lift up and the crew goes round again.

**Grazing entries are sensitive, and the prediction says so less well.** For a path that
only just stays in the air, a small difference in drag high up moves the landing point a long
way. The untrimmed 12 degree return from Pell came down 69 km from its predicted point, and
the 14 degree lift-up return 26 km, where the steeper entries are within 3 to 8 km. The
prediction is refreshed twice a second, so it closes in as the capsule comes down.

## 6. Verification

Chapter 11 of the independent checks (`tests/verify/checks_entry.mjs`, 107 checks), in four
groups. All run in the fast subset and in `npm test`.

| group | what is compared | checks |
| --- | --- | --- |
| 11a | The trim. For two capsules the reference finds, from its own triangle meshes, the angle at which the Newtonian moment about the game's centre of mass is zero: 18 degrees within 0.5. The centre of mass against the shifted masses; the moment of inertia against the parallel-axis rule; the lift over drag against the meshes; off again leaves the vessel exactly as it was. A spherical cap worked by hand at three angles against the meshes. | 20 |
| 11b | Bank hold flown at Mach 6.5 at four bank angles: where the lift really points, taken from the vessel's acceleration, within 1 degree; the angle to the air within 0.5; the lift over drag against the meshes within 2 %. Released at trim with no hold, the capsule stays within 1.5 degrees for 30 s. | 18 |
| 11c | The predictor against an independent integrator (adaptive extrapolation, order 16, tolerance 1e-10) on seven entries with a drag table, lift and bank: the same ending, the time within 0.02 s, the place within 5 m, the speed within 0.01 %, the peaks within 0.3 %. Against Allen and Eggers' closed forms for a steep ballistic entry: speed at peak deceleration $e^{-1/2}$ and at peak heating $e^{-1/6}$ of the entry speed, within 0.02. | 45 |
| 11d | Six entries flown in the game's flight model against the prediction made at the top of the air: the ending, the peak g within 6 %, the peak heat flux within 5 %, the landing point within 3 % of the path or 12 km, the speed of a skip within 2 %. | 24 |

`tests/e2e/entry.mjs` flies one entry in the real game in a browser: the Entry box, the two
switches, the roll key turning the bank, the lift marker, the read-outs, the label on the
map, and the landing against the prediction (15 checks).

## 7. What it leaves out

- **No guidance.** Nothing flies the bank for you toward a chosen landing site. The
  instruments and the map prediction are there to fly it by hand. A guided entry is open
  question 8 of the specification.
- **The predictor is a point mass with a held attitude.** It does not know about a tumbling
  capsule, engines, parachutes or winds. The last kilometres under a parachute are short and
  nearly straight down, so the landing point moves little, but the time to the ground is
  longer than predicted once the parachute opens.
- **The trim is solved for Mach 4 and above.** Lower down the old face-and-side force is mixed
  back in and the free trim angle drifts; Bank hold keeps the attitude with the reaction
  wheels. Below Mach 1.5 the lift fades and the capsule is, in effect, falling.
- **Little damping.** Newtonian theory has no pitch damping of its own. A trimmed capsule
  released with no hold swings about its trim angle for a long time before it settles. Real
  capsules are only weakly damped too, and fly with their thrusters holding them.
- **Only capsules.** Entry trim is offered on crewed capsules with a wide base. A lifting
  body, a spaceplane belly first, or a Shearwater-class ship flying belly first are steps D
  and beyond.
- **The ballast shift is free.** It takes no time, costs nothing, and can be switched at any
  moment. Mars Science Laboratory did it by throwing weights overboard.
