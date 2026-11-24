# Body aerodynamics above the speed of sound

How Starwright works out the air force on tanks, capsules, engines and heat shields from
Mach 0.7 to orbital speed. This is step B of roadmap item 6
([the specification](REENTRY_SPEC.md), [the science behind it](REENTRY_SCIENCE.md)). Step A
gave every world its own gas, temperature and speed of sound, so the Mach number is a true
one. This step makes the force on a body depend on its shape and attitude at that Mach
number.

Below Mach 0.7 nothing changes. Wings, fins and open panels are not touched here (step D).
Heating still follows the one flux law (step E).

The code is `js/core/aero.js` (curves and tables) and the per-part loop of
`js/core/vessel.js`. The independent reference is `tests/verify/ref_aero.mjs`.

## What was there before

Every body part had three drag areas (leading face, trailing face, side). All three were
multiplied by one curve: 1 below Mach 0.7, 2.0 at Mach 1.1, 1.5 above Mach 2.5. The wake
behind the trailing face always added a quarter of that face. The side force was in
proportion to the sideways part of the flow. That is a fair low-speed model and a poor one
above Mach 2:

- A nose cone and a flat heat shield had the same rise, so a pointed rocket and a capsule
  both carried 1.5 times their low-speed drag for ever.
- A wake cannot pull harder than a vacuum. A quarter of the face at Mach 8 is more suction
  than the air has pressure to give.
- A capsule held at an angle had a lift over drag of 0.20 at 20 degrees. Newtonian theory
  and flight data give about 0.3.
- A stage tucked behind a wide heat shield felt the full stream.

## The model

### 1. Two drag curves

A face reads a curve by how blunt it is. The multipliers on the face's low-speed
coefficient:

| Mach | 0.7 | 0.9 | 1.1 | 1.5 | 2.5 | 4 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| blunt | 1.00 | 1.25 | 1.55 | 1.75 | 1.90 | 1.98 | 2.00 |
| slender | 1.00 | 1.40 | 1.90 | 1.60 | 1.10 | 0.90 | 0.80 |

Straight lines between the columns, the last value above Mach 8. With $c$ the face's
low-speed coefficient, the bluntness is $b = \mathrm{clamp}((c - 0.2) / 0.5,\ 0,\ 1)$ and the
face's multiplier is $(1 - b)\,M_{slender} + b\,M_{blunt}$. A nose cone ($c = 0.12$) is
slender, a flat end or a heat shield ($c \ge 0.7$) is blunt, a capsule's tapered top
($c = 0.35$) is 30 % blunt. The side of a body reads the blunt curve.

The blunt curve was chosen so that it meets the Newtonian value at Mach 4, where the two
models hand over: a flat face of coefficient 0.9 times 1.98 is 1.78, and $C_{p,max}$ at
Mach 4 is 1.79.

### 2. A wake that fades

$$k_{wake} = 0.25 \quad (\mathrm{Ma} \le 1) \qquad k_{wake} = \frac{0.25}{\mathrm{Ma}^2} \quad (\mathrm{Ma} > 1)$$

The base pressure coefficient of a body cannot be lower than $-2 / (\gamma\,\mathrm{Ma}^2)$,
the value for a perfect vacuum behind it. The wake term follows that limit's shape.

### 3. The Newtonian force

Above Mach 1.5 a second force is mixed in, and above Mach 4 it is the only one. A patch of
surface with outward normal $\mathbf{n}$, on a body moving along $\mathbf{u}$:

$$C_p = C_{p,max}\,(\mathbf{n}\cdot\mathbf{u})^2 \ \text{ where } \mathbf{n}\cdot\mathbf{u} > 0, \qquad C_p = 0 \text{ elsewhere}$$

$C_{p,max}$ is the stagnation pressure coefficient behind a normal shock (the Rayleigh pitot
formula), with the world's own ratio of specific heats: 1.657 at Mach 2, 1.792 at Mach 4,
1.827 at Mach 8 and 1.839 in the limit for air.

Each stack part is a frustum with two end faces. For each part the game integrates that
pressure over the flank, over whatever is open of each end (the part outside a covering
neighbour) and, for heat shields and tapered capsules, over a spherical cap of 25 degrees
half-angle on the wide end (`capPhi` in the part data overrides it). The result is a table
per part shape: axial force, normal force and moment about the part's centre, every
2.5 degrees of angle of attack from 0 to 180. Tables are made once per shape and cached.

The mixing weight is $w = 3x^2 - 2x^3$ with $x = (\mathrm{Ma} - 1.5) / 2.5$ clamped to 0..1.
The force on a part is $(1 - w)$ times the face-and-side force plus $w$ times the Newtonian
one.

Worked by hand:

| shape | Newtonian drag coefficient |
| --- | --- |
| flat face, head on | $C_{p,max}$ |
| spherical cap of half-angle $\varphi$, head on | $C_{p,max}\,(1 + \cos^2\varphi)/2$, which is 0.911 $C_{p,max}$ at 25 degrees |
| cylinder across the flow, on length times width | $\tfrac{2}{3}\,C_{p,max}$ |
| cone of half-angle $\delta$, head on, on its base | $C_{p,max}\,\sin^2\delta$ |

### 4. Shadow

A part that lies wholly inside the wake of a wider stack part upstream keeps 10 % of its
force above Mach 1.5. The shelter fades in between Mach 0.7 and Mach 1.5. The wake is a tube
of the caster's radius $r_c$ running back along the motion from the caster's centre. For a
part of radius $r_p$ at distance $d_\perp$ from the tube's axis and $d_\parallel$ behind the
caster:

$$s = \mathrm{clamp}\!\left(1 + \frac{r_c - d_\perp - r_p}{0.5\,r_p},\ 0,\ 1\right) \times \mathrm{fade}\!\left(\frac{d_\parallel}{2 r_c}\right)$$

with fade equal to 1 up to 2 diameters, falling in a straight line to 0 at 4. Only a part at
least 2 % wider than the sheltered one casts a shadow, so a plain stack of equal tanks is not
affected. A radial part uses a quarter of its height as its radius.

## What changes in flight

Measured with the game's own flights, before (step A) and after.

**The capsule.** The Acorn Capsule heat shield first:

| Mach | 0.5 | 1.1 | 2 | 3 | 5 | 8 |
| --- | --- | --- | --- | --- | --- | --- |
| drag coefficient before | 0.99 | 1.98 | 1.66 | 1.48 | 1.48 | 1.48 |
| drag coefficient now | 0.99 | 1.52 | 1.66 | 1.65 | 1.65 | 1.66 |

It slows higher up, so on the steep 2 km/s test entry the peak heat flux falls from 126.7 to
119.2 kW/m² (6 %) and comes 660 m higher; peak deceleration goes from 7.2 to 7.1 g. Held
20 degrees off the flow it now lifts 0.32 times its drag (0.20 before), and the lift points
away from the side it leans to. Left alone it trims at zero angle. Since step C a switch,
Entry trim, moves its centre of mass so that it holds 18 degrees, and Bank hold steers with
the lift ([ENTRY.md](ENTRY.md)).

**Rockets going up.** A pointed rocket has less drag above Mach 1.5 than before, and a folded
solar array no longer counts as a barn door (below). All ten stock rockets that fly to orbit
get there on less propellant: 58 to 145 m/s less for eight of them, 223 m/s for the Latch
Target and 630 m/s for the Whisper Probe, the two that carry the most array for their size.
Maximum dynamic pressure is 5 to 26 % higher, because they are going faster where the air is
thick. Colossus reaches its 80 km apoapsis three seconds sooner, while its solid boosters are
still burning and cannot be throttled, and ends in a 90 by 91 km orbit where it used to end
at 80. The fleet table is in the pull request.

**Long bodies lean more easily at speed.** Under the old law a leaning tank felt a side force
in proportion to the lean. Under Newton's it goes as the square, so at a few degrees there is
almost none. Cones and fins keep theirs. Two consequences were found and dealt with:

- A booster falling engine first can no longer steer by leaning its body alone above
  Mach 1.5. The return guidance now also steers with its entry burn
  (`js/core/booster.js`). Twelve of twelve returns in the sweep still land.
- A rocket coasting engine off above Mach 4 with gear sticking out near its nose (the Trundle
  Lander carrying its rover) is turned by the air harder than its reaction wheels can hold.
  The ascent autopilot used to hold orbital prograde in the coast, a few degrees off the
  wind. It now holds surface prograde while in the atmosphere and does not cut a top-up burn
  while the rocket is still swinging. A player flying by hand should do the same: nose into
  the wind until the air is gone.

**Sheltered parts.** A stage behind a wider heat shield or a wider tank feels a tenth of the
stream above Mach 1.5, until the vessel turns far enough to put it back in the open.

## Found on the way: folded solar arrays

The full verification run failed one older check on this step: the Whisper Probe, flown
straight up at full throttle, tumbled when its upper stage separated at Mach 4.5. The cause
was not new. A radial part's drag area was its height times its width times 0.8, the same
from every direction. For most small parts that is fair. A folded Sunfoil Wing is a flat
package 1.2 m tall, 0.9 m wide and 0.18 m thick, so it was counted as 0.86 m² to the air even
end on, where it shows 0.13 m². Two of them near the nose of the Whisper Probe's upper stage
made 60 kN of drag at staging, against an engine of 65 kN, and a turning moment larger than
everything else on the stage together. Until this step the body's own side force hid it in
that test; on the autopilot's climb the stage already tumbled at separation on `main`.

Solar arrays (every part of shape `solar`) now show each direction of the flow its own face:
height times width from the side they are mounted on (unchanged), width times thickness along
the stack, height times thickness along the curve of the hull. This is the one place where
this step changes a force below Mach 0.7. An opened array is unchanged. Check group 10h
measures all three directions.

The Whisper Probe now flies the straight-up test at under one degree off the wind. On the
autopilot's climb its upper stage still swings wide at separation, because that climb stages
at 10 degrees angle of attack with a small engine; it recovers and reaches orbit as before.
That is the rocket's design and the climb profile, not the air model, and it is left alone
here.

## Verification

Chapter 10 of the independent checks (`tests/verify/checks_aero.mjs`, 198 checks) carries
this step in five groups. The reference types the rules a second time from the
specification and finds the Newtonian force a different way from the game: it cuts each
part's surface into about 42,000 flat triangles and sums the pressure at the exact angle
asked for, where the game integrates rings into a table and interpolates.

| group | what is compared | checks |
| --- | --- | --- |
| 10d | Newtonian closed forms (flat disc, cylinder, cone, spherical cap at four tilts), the game's tables for five part shapes against the triangle mesh, the pitot pressure worked by hand and for three gases | 25 |
| 10e | Force and torque on single parts at Mach 0.5 to 8, every 15 degrees of attitude, game against reference | 40 |
| 10f | The capsule: drag at Mach 8 and lift over drag at 20 degrees against closed forms | 3 |
| 10g | Shadow: a tank behind a wide heat shield at Mach 0.5 to 6 and six attitudes, three equal tanks that must cast none, the rule near, far and ahead of the caster | 29 |
| 10h | Two folded solar arrays on a tank against the bare tank: drag with the flow along each of the package's three axes | 8 |

Older checks that restated the old drag law now use the independent aerodynamics: the
capsule entries of chapter 4, the pod drag in the structure chapter and the booster fall
predictor of chapter 9, which is now compared with the drag measured in the flight at every
Mach number flown.

## What it leaves out

- Shock waves from one part do not strike another. There is no bow-shock stand-off, no
  shock-on-fin heating and no interference drag.
- No skin friction, no flow separation, no Reynolds number.
- The air is an ideal gas at every temperature. Real air above about Mach 6 on Earth loses
  some pressure to chemistry; on Verda orbital entry is Mach 8 at only 2.35 km/s, so the
  effect would be small there.
- Newtonian theory overstates the pressure on slender shapes between Mach 1.5 and 4. The
  slender curve carries those faces until the blend completes.
- The spherical cap is one angle for every heat shield and capsule. Real capsules differ.
- A shadow is a straight tube that keeps a flat 10 %. A real wake narrows, reattaches and
  depends on the Mach number.
- Lift on a leaning body below Mach 1.5 is still the old side force. Lifting bodies at low
  speed are not modelled.
