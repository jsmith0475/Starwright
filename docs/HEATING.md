# Heating by shape

How Starwright heats each part of a vessel in fast air: by the part's own size, the way it
faces the wind, and what stands in front of it. This is step E of the re-entry work
([REENTRY_SPEC.md](REENTRY_SPEC.md), part E; the mathematics is in
[REENTRY_SCIENCE.md](REENTRY_SCIENCE.md)). The code is in `js/core/vessel.js` (`_stepFlight`,
`axialHeatRatio`), the gas constants in `js/core/bodies.js`.

## What was there before

One flux for the whole vessel, $1.83\times10^{-4}\sqrt{\rho}\,v^3$, and a fitted rule that moved
each skin toward $290 + 0.30\,(\dot q\,x)^{0.75}$ kelvin with fixed time constants of 22 and
30 seconds. The exposure $x$ was 1 for a leading face, at most 0.35 for a flank and a flat
0.6 for anything mounted on the side. It did not know how big a part was, a part behind a
heat shield was protected by a factor on the shield and not by the shield, and every shield
lost ablator at the same rate whatever its size.

## The model

**1. Reference flux.** Sutton and Graves' law for the foremost point of a nose of radius
$R_n$, worked once each step for a nose of 1 m:

$$\dot q_{ref} = k\sqrt{\rho}\;v^3$$

| Gas | Worlds | $k$ (kg^0.5/m) |
| --- | --- | --- |
| Air | Verda, Marn | 1.7415e-4 |
| Carbon dioxide | Murk, Rusk | 1.9027e-4 |
| Hydrogen and helium | Thal, Orrin | 6.88e-5 |

The first two are the published constants. The third is worked from Sutton and Graves'
constants for hydrogen (0.0395) and helium (0.0797 kg/(s m^1.5 atm^0.5)) by their mixing rule,
$1/K^2 = \sum c_i / K_i^2$ over mass fractions, for a mixture of the game's molar mass (25 %
helium by mass), and $k = K / (2\sqrt{101325})$. The same conversion returns the air value.

**2. Each part's share.**

$$\dot q_j = S\;\dot q_{ref}\;\frac{f_j\,e_j}{\sqrt{R_j}}$$

| Surface | Effective nose radius $R_j$ | Attitude factor $f_j$ |
| --- | --- | --- |
| Heat shield or capsule base | radius of curvature of its 25 degree cap, $r/\sin 25°$ | $\cos^{1.5}$ of the angle between its normal and the wind |
| Flat end | 3 face radii | the same |
| Tapered end (nose cone) | 0.3 of the base radius, or the part's stated `tipR` | the same |
| Flank of a stack part | the part's own radius | $\tfrac{1}{\sqrt2}\sin^{1.2}\alpha$, the swept cylinder |
| Part on the side of a hull | half its thickness, at least 2 cm; a side tank or booster its own radius | 1 with its side to the wind, 0.25 with the air running along the hull |
| Anything in the lee | | 0.03 |

A part takes the largest of its faces. $e_j$ is the shadow exposure of step B
([AERODYNAMICS.md](AERODYNAMICS.md)): 1 in the open, falling to a floor of 0.03 for a part
wholly inside the wake of a wider part upstream.

**3. The heat balance.** Each skin has a heat capacity and radiates:

$$c_j\,\frac{dT}{dt} = \dot q_j\left(1 - \frac{T}{T_0}\right) - \varepsilon\sigma\,(T^4 - T_{env}^4) - h\,(T - T_{env}), \qquad T_0 = T_{air} + \frac{v^2}{2c_p}$$

- $c_j$ is the heat capacity of the skin per square metre: 20 % of the part's dry mass (all of
  it for a small fitting on the side) at 900 J/(kg K), spread over its surface, kept between
  4 and 40 kJ/(m² K).
- $\varepsilon = 0.85$. $T_{env}$ is the air temperature inside an atmosphere and 290 K in
  space. $h = 40\sqrt{\rho}$ W/(m² K) is a small still-air cooling term.
- $T_0$ is the total temperature of the oncoming air, with $c_p = \gamma R / ((\gamma - 1)M)$
  of the world's gas. The air cannot heat a wall past its own temperature, so the flux falls
  as the skin nears $T_0$ and turns to cooling beyond it.
- The step is linearised implicit, stable at the 20 ms physics step and under physics warp.

**4. Ablation.** A shield with ablator left is held at 2,000 K and loses mass at
$\dot m = \dot q_j A / Q^*$, with $A$ the area of its face and $Q^* = 1.35$ MJ/kg. The old
factor of 0.3 on a shield's temperature is gone. What protects the capsule behind a shield is
the shield's shadow.

**5. Tiles.** A part may carry tiles on one side (`tiles` in the part data; the side is the
vessel's own -z, the belly). When the wind falls within 60 degrees of that side, the flank
answers to the tiles' limit of 2,400 K; from any other side, to the part's own. No ablator
is involved: tiles survive by radiating. The Shearwater's tank is the first part to use it.

## The scale, plainly

$S = 20$. This is the model's one deliberate departure from physics.

Verda is a small world. Its orbital speed is 2.3 km/s where Earth's is 7.8, and heating goes
with the cube of speed. At $S = 1$ a bare Acorn Capsule coming home from low orbit peaks at
541 K against a limit of 2,000 K, and coming home from Pell at 654 K. Nothing would ever
burn and a heat shield would be decoration.

$S$ was set so that the bare capsule reaches the same peak on the low-orbit entry as under
the old rule (1,709 K then, 1,728 K now), and $Q^*$ so that the M shield loses the same
ablator on that entry (84.0 kg then, 80.7 kg now). **Settings has a switch, "Heating at
physical strength", that sets $S = 1$.**

The specification expected $S$ near 8. It came out at 20 because of the wall factor
$(1 - T/T_0)$, which the specification did not have and which the build needed: without it,
every small part on the side of a climbing rocket burned off at Mach 3. See "What the build
found" below.

## What moves

Entries flown in the game's own flight model, base or shield first, no lift. Temperatures are
peaks, with the share of the part's limit in brackets.

| Entry | Before | After |
| --- | --- | --- |
| Bare Acorn, low orbit (2,300 m/s, 1.5°) | 1,709 K (0.85) | 1,728 K (0.86) |
| Bare Acorn, from Pell (3,300 m/s, 14°) | destroyed at 42.5 km | destroyed at 42.1 km |
| Acorn on Shield M, low orbit: shield face | 748 K | 1,785 K |
| Acorn on Shield M, low orbit: ablator used | 84.0 of 200 kg | 80.7 of 200 kg |
| Acorn on Shield M, from Pell: ablator used | 114.5 of 200 kg | 143.0 of 200 kg |
| Acorn on Shield M, from Pell at 8° (skips out): ablator used | 29.8 kg | 54.6 kg |
| Hearth on Shield L, low orbit: ablator used | 93.3 of 800 kg (12 %) | 267.4 of 800 kg (33 %) |
| Capsule behind a shield | 297 to 377 K | 290 to 303 K |
| Whip Antenna on the capsule's side, low orbit | burns at 34.8 km | burns at 60.4 km |
| Whip Antenna, from Pell | burns at 44.5 km | burns at 55.1 km |
| Sunfoil Tile flat on the capsule's side, low orbit | 1,365 K (0.91) | 968 K (0.65) |
| Sunfoil Tile, from Pell | burns at 42.1 km | 1,298 K (0.87), survives |

- **Small parts in the open are heated hardest.** The antenna reaches past the shield's edge.
  With the air running along the hull it meets 1.55 times the flux on the shield, and far
  more when the capsule turns its side to the wind. It is the first thing to go.
- **Parts in the shield's shadow are safe.** The solar tile lies flat inside the shadow and
  now comes home from Pell.
- **A shield's face runs hot.** It sits near 1,800 K and is held at 2,000 K when the heating
  would take it past that, where the old rule kept it under 800 K.
- **Shields of every size lose a like share.** The L shield used 12 % of its ablator where
  the M shield used 42 %. Now it is 33 % against 40 %: the larger shield is a little better
  off, by the square root of its radius.
- **The stock rockets' climbs** stay close to before: on the eleven that reach orbit the
  hottest part peaks at 0.26 to 0.68 of its limit, where it was 0.34 to 0.66, and nothing is
  lost on any of them. Delta-v to orbit is the same to within 1 m/s.

### The booster

The returning booster plans its entry burn from the steady answer of the same balance
(`Vessel.axialHeatRatio`), now with the wall factor. Slower returns need no entry burn any
more: a fall from 80 km at 1,900 m/s is predicted to peak at 68 % of a limit, under the 80 %
at which a burn is planned, and flown it peaks at 51 %. The burn on a faster return ends near
1,550 to 1,600 m/s in place of running down to 300 m/s. That left a long fast fall after the burn, in which each metre per
second of error became 200 m on the ground. Two changes to the burn bring it back to the
target:

- the aim counts on half of the burn's reserve being used, so the cut-off can come early or
  late;
- past the planned speed the throttle eases as the predicted fall closes on the target, and
  the prediction is refreshed every 0.04 s.

A return from 80 km at 2,000 m/s: entry burn from 1,866 to 1,554 m/s, down 0 m from the
target, hottest part at 0.60 of its limit.

## What the build found

1. **The specification's law burned rockets on the way up.** Radiative equilibrium goes with
   the fourth root of flux, so a scale large enough to burn a capsule at 2,300 m/s also cooked
   antennas and solar panels at Mach 3 on the climb (eight of the stock rockets lost parts).
   The fix is physical: the wall factor $(1 - T/T_0)$ that Sutton and Graves' law carries in
   its full form. Air at 1,000 m/s has a total temperature near 700 K and cannot burn
   anything.
2. **A part on a hull's side with the air running along the hull stands in the hull's own
   slowed air.** It takes 0.25 of the stream there. Without this, one stock rocket still
   lost its solar panels on the climb and the rest ran at 0.7 to 0.9 of a limit.
3. **The heat capacity is per area of skin.** The specification wrote the balance with the
   whole skin's heat capacity against the heated area alone, which gave time constants of
   several minutes and capsules that never warmed up. Spread over the part's own surface the
   skin answers in tens of seconds, as the old rule's 22 did.
4. **The ablation temperature is 2,000 K, not 2,700 K.** At 2,700 K a healthy shield would
   stand at 0.79 of its limit and the flight screen would call it "Heating" all the way down.
5. **The reference flux is for a 1 m nose with the published constant.** The old constant,
   1.83e-4, was the same law on a 0.9 m nose. The flux shown on the flight screen is 5 %
   lower than before for that reason alone.

## On the flight screen

The Entry box gains three rows. **Hottest part** names the part closest to its limit and how
close. **So far** keeps the record of this heating: the peak against the limit and the heat
taken by the hottest part in MJ/m². **Ablator lost** is the shield's loss in kilograms. The record is saved with the
vessel and starts again when heating next begins.

The entry prediction (peaks ahead, the path on the map) now lets the shield lose ablator as
the flight does, so a capsule that sheds 140 kg on the way down is predicted with that mass
gone.

## Verification

Chapter 14 of the independent checks, `tests/verify/checks_heat.mjs`: 67 checks, 0 failing.
Every constant of the model is typed there a second time and the air is the reference's own.

| Group | What is checked | Checks |
| --- | --- | --- |
| 14a | The hydrogen and helium constant from the two gases by the mixing rule; the air constant from $K = 0.1113$; $c_p$ of every atmosphere; nose radii, flank radii and skin heat capacities of a four-part stack | 25 |
| 14b | Flux on a capsule and a tank at 11 attitudes from nose first to tail first; flux as $1/\sqrt{R}$ between a narrow and a wide tank (2.000); a capsule in its shield's wake; an antenna reaching out of it; an antenna on a hull flying side on, windward and leeward | 9 |
| 14c | Skin temperature on entries flown in the game against the balance integrated by the reference with fourth-order Runge-Kutta: the bare capsule from low orbit (worst difference 0.024 % all the way down), from Pell (destroyed, and the reference passes the limit on the same flight), and three shielded entries (ablator lost within 0.01 kg, face never past 2,000 K, capsule under 400 K); the flight record | 22 |
| 14d | A fall at 1,200 m/s stays under the air's total temperature; total temperature all the way down; a minute of cooling in vacuum from 1,500 K; the steady estimate against the balance solved by bisection; the tiled side | 11 |

Game tests: `tests/unit/heating.test.js` (9 tests). The booster's entry burn test now starts
at 2,000 m/s, because the old start at 1,900 m/s no longer needs a burn.

## What is simplified, and what is left out

- One temperature per part. A capsule has no hot shoulder and cool centre.
- The wall factor uses a constant $c_p$ for each gas. Real air at these temperatures breaks
  apart and its total temperature is lower than the figure used.
- No radiative heating from the shock layer. It matters above about 9 km/s, which nothing in
  this system reaches except at the gas giants.
- No heat conducted from one part to the next.
- A part on the side of a hull uses one number, 0.25, for the hull's slowed air.
- Engines do not heat the parts around them.
- Winds, wings at speed and plasma are steps G, D and F.
