# Physics verification

This document records an independent check of Starwright's spaceflight physics: what model the game uses, how it
was tested against physics rather than against its own tests, what was wrong and is now fixed, and what the model
cannot do.

Run it yourself:

    npm run verify                         full report, about 6 minutes (node tests/verify/run.mjs)
    node tests/verify/run.mjs --fast       the quick subset, about 40 s
    node tests/verify/run.mjs --only 3f    one group
    npm test                               the unit suite, which includes tests/unit/physics_verify.test.js

Last full run: **861 checks passed, 0 failed, 129 informational rows.** Unit suite: 305 tests, 0 failures.

## 1. The model the game uses

**Patched conics.** At any moment a vessel feels the gravity of exactly one body, the one whose sphere of influence
(SOI) it is in. Nothing else pulls on it.

- **Coasting on rails** (time warp 5x and above, and every vessel that is not being flown): the exact Kepler orbit
  about that one body, evaluated in closed form (`js/core/orbit.js`). No step error at any warp rate.
- **Physics stepping** (1x, physics warp 2x to 4x, any time an engine runs or there is air): a kick-drift-kick
  leapfrog in `Vessel._stepFlight`, 20 ms steps under thrust or in air, 100 ms coasting in vacuum, with gravity of
  the same single body.
- **Bodies** are on fixed Kepler rails about their parent, using the parent's GM only. A moon's own mass does not
  enter its orbit, and a planet does not recoil from its moons. GM = surface gravity x radius squared.
- **SOI radius** is the Laplace value a (m/M)^(2/5). On crossing it the state is re-expressed relative to the new
  body (position and velocity of the body subtracted or added) and the vessel continues on a new conic.
- **Atmosphere**: exponential density rho0 exp(-h/H) cut off at a fixed top, co-rotating with the body; quadratic
  drag per part with a transonic rise; heating flux K sqrt(rho / R) v^3 (Sutton and Graves) part by part, and a heat balance for each skin.

Consequences, all measured in section 4: no Lagrange points, no tidal perturbation of orbits, no orbital decay or
precession, and transfers that differ from real n-body gravity by an amount a small correction burn covers.

## 2. How it was checked

`tests/verify/ref.mjs` is an independent reference. It imports nothing from the game's maths. It reads the body
table from `js/core/bodies.js` as text and has its own:

- order-16 Gragg-Bulirsch-Stoer extrapolation integrator with adaptive step,
- universal-variable Kepler propagator (Stumpff functions), elements-to-state and state-to-elements,
- ephemeris of all bodies from their elements,
- brute-force patched-conic propagator (`refPatched`) that finds SOI crossings by conservative stepping and
  bisection to 1e-7 s, with no knowledge of how the game searches,
- restricted and full n-body right-hand sides,
- textbook formulas: vis-viva, Hohmann, ejection burn, flyby turn angle, rocket equation, Clohessy-Wiltshire.

The check modules drive the real game (`World`, vessels, rails, physics stepping at 1x and physics warp, rails warp at
every level, the autopilot, the map predictor) and compare. Every row of the report has expected, actual, error,
tolerance and PASS/FAIL; INFO rows are measurements that are not judged.

## 3. Results

| Group | What | Checks | Representative numbers (worst error) |
|---|---|---|---|
| 1a | Circular speed and period, every body | 76 | relative error <= 3e-16 |
| 1b | Kepler propagation: circular, elliptic (e up to 0.999), near-parabolic, hyperbolic (e = 5), all inclinations, up to 100 orbits, vs integrator and universal variables | 72 | position 3e-13 relative |
| 1c | Kepler's equation edge cases (792 M, e pairs), apsides, period, time to apsis, frame handedness | 11 | 9e-16 rad |
| 1d | Energy and angular momentum at every warp level and across warp changes | 59 | rails, 200 orbits, any rate 5x to 100 000x: velocity error 1.2e-10 m/s; physics 1x: 3e-5 m/s after 2 orbits; physics 2x-4x: 7.7e-4 m/s |
| 1e | Low-orbit drift over 10 orbits; physics/rails hand-over | 12 | 1x: 0.06 m position, 1.4e-8 m semi-major axis; 4x: 1.5 m position, 5e-8 m semi-major axis; hand-over 1.4e-5 m, 2e-7 m/s |
| 2a | Rocket equation, mass flow, throttle | 18 | burn to depletion 2751.01 m/s vs 2751.01 expected (7e-6 m/s) after fix 1 |
| 2b | Thrust and Isp at sea level | 6 | 5e-8 relative |
| 2c | Staging: mass bookkeeping, delta-v readout | 13 | masses exact; readout 3735.16 m/s vs delivered, 2e-5 m/s |
| 2d | Maneuver nodes: predicted orbit vs the orbit after flying the burn | 45 | prediction vs reference 2e-9 m; achieved after an 8 s burn 0.007 m; after a 44 s, 800 m/s burn the apoapsis is 36 km off the impulsive prediction (finite burn over 7.5 deg of orbit, budget 82 km) |
| 3a | Body positions vs elements up to 133 years; Kepler III against parent GM; SOI vs Laplace; hierarchy | 170 | positions 1e-15 relative; SOI equals Laplace exactly |
| 3b | SOI crossing of a moving moon at every warp, as flown and background vessel, and under physics stepping | 62 | position continuity 1e-3 m, velocity 1e-7 m/s, crossing time 3e-6 s; same at 5x and 100 000x |
| 3c | 1440 aimed encounters with all 18 bodies plus 240 random orbits, flown and in the background, vs brute force | 10 | 0 skipped, late or mis-ordered after fixes 2 and 3; 320 flights at the four small moons (SOI < 1000 km), 0 missed; time error 4e-5 s |
| 3d | Map prediction (`predictPatches`) of 152 aimed encounters | 3 | 0 missed; time 1.3e-5 s; periapsis 4e-8 relative |
| 3e | Hohmann transfer, low Verda orbit to Pell: helper and planner vs textbook, then flown | 25 | helper: phase 110.626 deg, burn 862.414 m/s, time 26 984.9 s, all equal to the textbook to 1e-12; flown arrival matches the post-burn map to 1e-9 m |
| 3f | Verda to Rusk: window, textbook ejection flown, planner flown, flyby | 47 | window v-infinity 815.999 m/s exact; planner flight: ejection 1030.4 m/s (the optimum), arrival 947 m/s after 72.1 days (Hohmann 930 m/s, 71.1 days); map vs reference vs flight agree to 1e-5 s and 1e-5 m at 100 000x; flyby turn 37.8406 deg and heliocentric speed change 314.222 m/s equal to the hyperbola formula to 1e-9 |
| 3j | Transfer planner quality: all 72 ordered planet pairs against the patched-conic optimum (section 5, fix 4) | 91 | ejection burn within 1.5 % of the minimum for 53 of the 55 major pairs that have a window (Quell to Cindra 1.9 %; Quell to Orrin 6 %, which is 13 m/s); 12 of 14 Verda pairs within tolerance on total cost, arrival speed and time |
| 3g | Gravity assist at Pell | 7 | turn 88.4427 deg (3.5e-9 deg error), speed change 358.566 m/s (3.5e-8) |
| 3h | Rendezvous: relative motion and closest approach | 8 | vs exact two-orbit solution 4e-7 m; vs Clohessy-Wiltshire 0.4 m over 600 s (linearisation); predicted closest approach 177 034 m, off by 6e-9 m, time by 1e-5 s |
| 3i | Rotating surface | 15 | pad speed 203.094 m/s exact; landed vessel co-rotates to 1e-7 m in 1000 s; orbit of a vessel released from the surface frame 1e-6 m |
| 4a | Density and pressure vs scale height, six atmospheres | 31 | exact |
| 4b | Capsule drop vs integrated reference; terminal velocity | 10 | altitude 0.9 m after a 5.4 km fall, speed 0.04 m/s; drag force 3e-4 relative |
| 4c | Re-entry heating | 17 | flux law within 0.4 %; peak flux 126.7 kW/m2 vs 126.6 reference; peak deceleration 70.71 vs 70.66 m/s2; peak heating before peak deceleration, at 0.87 and 0.62 of top speed (Allen-Eggers 0.85 and 0.61) |
| 4d | GM/R^2 and free fall on every body | 18 | 2e-10 relative |
| 4e | Vertical hop on Pell, Ost, Dray at 1x, 4x and on rails | 27 | apex 1e-4 m, flight time 8e-4 s |
| 5 | Model honesty (section 4) | 8 | |

Notes on rows that are loose on purpose:

- **Finite burns.** The map predicts an impulsive burn. A real burn takes time. For the Pell injection (27 s burn)
  the flown periapsis at Pell is 121 km from the plan; Pell periapsis moves 216 km per m/s of burn error, so this
  is a 0.56 m/s effect, and the map shows the true value as soon as the burn ends. This is expected behaviour, not
  an error.
- **Textbook interplanetary numbers assume the SOI is infinitely far away.** At Verda's real SOI edge the ship
  still has sqrt(v_inf^2 + 2GM/r_soi) = 870 m/s, not the textbook 816 m/s. The game matches the exact
  patched-conic reference (aphelion within 0.5 %, the residual being the finite burn), and differs from the
  simplified textbook by 2.6 % in aphelion. The game is right; the textbook shortcut is coarse in a system this
  small.

### Structural loads (chapter 7 of the checks)

The joint loads of structural dynamics are verified the same way, in `tests/verify/ref_structure.mjs`
and `checks_structure.mjs`: a separately written multibody reference, closed-form rods and rings,
live flights, failure timing, brace struts. 300 checks pass, 0 fail; the loads agree with the
reference to about 1e-14. The checks also found that the vessel's moment of inertia is taken about
part centres and not mass points (up to 9 % too large on small capsule ships), which is reported
and not yet fixed. Model, results and that defect: [STRUCTURE.md](STRUCTURE.md).

### Aerodynamic breakup (chapter 8 of the checks)

`tests/verify/checks_breakup.mjs`: the thin roots of fins and wings against line loads integrated
round the rectangle; the dynamic pressure the game reads on every rated part against the vessel's
state, the body's rotation and its atmosphere; the force of an open solar panel against a flat
plate; which part is torn off and on which physics step against the damage rule replayed from the
state; conservation of mass, momentum and mass centre across a tear-off; stock rockets on a clean
climb and in a flip at max Q; the limit on loose pieces. 113 checks pass, 0 fail. The air ratings
themselves are stated limits, like a part's maximum temperature, and the checks verify that the
game applies them as documented, not that they are the right numbers for a real antenna.
Model and results: [AERO_BREAKUP.md](AERO_BREAKUP.md).

### The air and the forces on bodies at speed (chapter 10 of the checks)

`tests/verify/checks_aero.mjs`, the first two steps of the re-entry work
([REENTRY_SPEC.md](REENTRY_SPEC.md) parts A and B, science in [REENTRY_SCIENCE.md](REENTRY_SCIENCE.md),
the body model in [AERODYNAMICS.md](AERODYNAMICS.md)). The reference has its own atmosphere in
`tests/verify/ref.mjs`, with the gas constants and the temperature profile typed a second time, and
its own body aerodynamics in `tests/verify/ref_aero.mjs`: the curves and rules typed a second time,
and the Newtonian force summed over a part's surface cut into about 42,000 flat triangles at the
exact angle asked for (the game integrates rings into a table every 2.5 degrees and interpolates).
198 checks pass, 0 fail.

| Group | What | Checks | Representative numbers |
|---|---|---|---|
| 10a | Isothermal temperature M g H / R, temperature and speed of sound at 201 heights on six atmospheres, and a^2 = gamma g H (T / T_iso) with no gas constant in it; Verda worked by hand | 40 | 4e-16 relative; Verda 303.29 m/s at the surface against 303.28 by hand |
| 10b | Mach readout in flight against airspeed over the reference speed of sound: pole and equator, Verda, Rusk and Murk, and an airless moon | 9 | 2e-15 relative |
| 10c | The taper: plain exponential below 92 % of the top, the cubic fade above, pressure fading with density, no rise with height, no kink where it starts, and a capsule crossing the top at 2,320 m/s | 44 | largest step-to-step change in air deceleration 2.3e-4 m/s2, where the old edge switched on 2.7e-2 m/s2 at once |
| 10d | Newtonian closed forms (flat disc, cylinder across the flow, cone, spherical cap at four tilts), the game's tables for five part shapes against the triangle mesh, the pitot pressure by hand and for three gases | 25 | flat disc 1.1e-4 relative; C_p,max game against reference 1e-15 |
| 10e | Force and torque on single parts (a tank, a nose cone, the capsule, a heat shield, an adapter) at Mach 0.5 to 8 and every 15 degrees of attitude, from one step of the game against the reference | 40 | see the run |
| 10f | The capsule: drag coefficient at Mach 8 against C_p,max (1 + cos^2 25 deg) / 2, and lift over drag held 20 degrees off at Mach 5 and 8 against the closed form for its cap | 3 | lift over drag 0.322 against 0.324; before this step the game gave 0.20 |
| 10g | Shadow: a tank behind a wide heat shield at Mach 0.5, 1.1, 2 and 6 and six attitudes, three equal tanks that must cast none, and the rule near, far and ahead of the caster | 29 | see the run |
| 10h | Two folded solar arrays on a tank against the bare tank: drag with the flow along the stack, straight at the big face and along the curve of the hull | 8 | 2e-10 relative; a folded Sunfoil Wing shows 0.130 m2 end on where it was counted as 0.864 |

What moved in the game, measured on the stock rockets flown by the same ascent autopilot before
and after: every rocket that reached orbit still does, on 1 to 10 m/s less propellant (the
Whisper Probe, a very light probe on a large engine, 293 m/s less); staging altitudes moved by
under 300 m; the height at which each rocket passes Mach 1 fell by 400 to 900 m; the twelve
booster returns of `tests/tools/booster_sweep.mjs` still land inside their targets with about
10 m/s more left. `tests/tools/fleet_report.mjs` prints these numbers for any checkout.

What step B moved, measured the same way against step A: all ten rockets that fly to orbit
use less propellant (58 to 145 m/s for eight of them, 223 m/s for the Latch Target and 630 m/s
for the Whisper Probe), from the lower drag of pointed shapes above Mach 1.5 and from folded
solar arrays now showing the air their edge; maximum dynamic pressure is 5 to 26 % higher;
Colossus ends in a 90 by 91 km orbit where it used to end at 80, because it reaches its
apoapsis three seconds sooner with its solid boosters still burning; the capsule's peak heat
flux on the steep 2 km/s test entry falls from 126.7 to 119.2 kW/m2; the twelve booster returns
still land inside their targets. The checks of chapters 4, 7 and 9 that restated the old drag
law now use the independent aerodynamics, and the booster fall predictor is compared with the
drag measured in the flight at every Mach number flown (worst difference 1.2 %).

### Entry: trim, bank and the path through the air (chapter 11 of the checks)

`tests/verify/checks_entry.mjs`, step C of the re-entry work ([ENTRY.md](ENTRY.md)). 107 checks
pass, 0 fail.

- **The trim.** The game moves a capsule's centre of mass so that it rests at 18 degrees to the
  air. The reference takes that centre of mass and finds, from its own triangle meshes, the angle
  at which the Newtonian moment about it is zero: 18 degrees within 0.5 for both capsules. The
  centre of mass and the moment of inertia are checked against the shifted masses, and a
  spherical cap is worked by hand (force angle $\arctan(C_N / C_A)$, no moment about the centre
  of curvature) against the meshes.
- **Bank hold.** Flown at Mach 6.5 at four bank angles, the lift is taken from the vessel's
  own acceleration, not from anything the hold reports: it points within 1 degree of the
  commanded bank, at 18 degrees within 0.5 to the air, with the lift over drag of the meshes
  within 2 %.
- **The predictor.** `tests/verify/ref_entry.mjs` flies the same point mass with the adaptive
  extrapolation integrator of the reference (order 16, tolerance 1e-10) and the reference's own
  atmosphere. On seven entries with a drag table, lift and bank the game's fixed-step
  Runge-Kutta predictor gives the same ending, the time within 0.02 s, the place within 5 m and
  the peaks within 0.3 %. A steep fast ballistic entry meets its peak deceleration and peak
  heating at Allen and Eggers' $e^{-1/2}$ and $e^{-1/6}$ of the entry speed, within 0.02.
- **Predicted against flown.** Six entries flown in the game's own flight model, each against
  the prediction made at the top of the air: the same ending (one of them a skip back out to
  space), peak g within 6 %, peak heat flux within 5 %, the landing point within 3 % of the
  path length.

One thing the specification had wrong was found here: its formula for the offset (C2) was too
large by a factor of about ten. The game solves the offset from the Newtonian force, and the
check above is what shows the result is right.

### Heating by shape (chapter 14 of the checks)

`tests/verify/checks_heat.mjs`, step E of the re-entry work ([HEATING.md](HEATING.md)). 67 checks
pass, 0 fail. Every constant of the model is typed there a second time, and the air is the
reference's own.

- **Constants and geometry.** The hydrogen and helium heating constant is worked from Sutton and
  Graves' constants for the two gases by their mixing rule, and the same conversion gives back
  the published constant for air. Nose radii, flank radii and skin heat capacities of a
  four-part stack are worked by hand against the game's.
- **The flux law.** A capsule and a tank are held at 11 attitudes from nose first to tail
  first; the flux on a flat end goes as one over the square root of its radius (2.000 between
  a narrow and a wide tank); a capsule in its shield's wake keeps 3 %; an antenna that reaches
  out of the wake does not; an antenna on a hull flying side on meets the whole stream to
  windward and the floor to leeward.
- **The heat balance.** Entries are flown in the game and the state recorded each step. The
  reference then works the flux from its own air and integrates the skin's balance with
  fourth-order Runge-Kutta in steps an eighth as long. The bare capsule from low orbit agrees
  within 0.024 % all the way down; the same capsule from Pell is destroyed, and the reference
  passes the limit on the same flight; three shielded entries lose the ablator the reference
  says within 0.01 kg, with the face never past 2,000 K and the capsule behind it under 400 K.
- **Limits.** A fall at 1,200 m/s heats nothing past the air's total temperature. A skin at
  1,500 K in vacuum cools as the reference says for a minute (within 0.003 %). The steady
  estimate the booster's entry burn is planned from equals the balance solved by bisection.
  A tiled side holds at 250 K over the steel's limit with its belly to the wind, and fails
  with its back to it.

The specification's law, built as written, burned antennas and solar panels off eight stock
rockets on the climb. The wall factor $(1 - T/T_0)$ of Sutton and Graves' full law removes
that: air at 1,000 m/s cannot heat anything past about 700 K. With it the declared scale came
out at 20, not the 8 the specification expected.

## 4. Model honesty: patched conics against n-body gravity

"n-body" here means the ship feels every body, and Verda recoils from its moons as real gravity requires.

**(a) Low Verda orbit, 120 km, inclined 30 degrees, 30 days (1235 orbits)**

| Day | n-body minus game, total | along-track | radial | out-of-plane |
|---|---|---|---|---|
| 1 | 1.75 km | -1.74 km | -0.01 km | 0.19 km |
| 10 | 17.7 km | -17.6 km | -0.20 km | -2.5 km |
| 30 | 52.8 km | -52.6 km | -1.8 km | -4.2 km |

The orbit keeps its size and shape (semi-major axis changes by 3 m, apsides by 15 to 20 m, inclination by 17
arcseconds in 30 days). The difference is a slow slide along the track, 0.7 degrees of phase after a month. Pell's
tide is 5.5e-5 m/s2 against Verda's 6.8 m/s2 (8e-6); Helion's tide alone accounts for 0.5 km. For a player this is
invisible, except that a rendezvous planned a month ahead would need a small phasing correction.

**(b) Verda to Pell transfer** (848.6 m/s burn from 120 km; patched conics give a 31.4 km periapsis at Pell 9.14 h
later)

| Model | Position difference at the SOI edge | Closest approach to Pell | Shift | Time shift |
|---|---|---|---|---|
| Patched conics (the game) | 0 | 31.4 km | 0 | 0 |
| n-body, Verda + Pell | 387 km | 138.4 km | +107 km | -1375 s |
| n-body, + Helion + Ost | 386 km | 134.1 km | +103 km | -1377 s |

Pell's periapsis moves 189 km per m/s of departure burn, so the whole n-body effect equals a 0.54 m/s error at
departure. It is about the size of the finite-burn error of the same transfer (121 km). A real mission would fix
either with a few m/s mid-course.

**(c) Lagrange points of Verda and Pell** (mass ratio 0.0176; L4 and L5 would be stable, the limit is 0.0385)

| Case | Three-body problem | The game |
|---|---|---|
| Ship exactly at L4, 30 days | stays (6e-5 m) | stays (5e-7 m), but so does a ship at any phase angle |
| Ship 10 km outside L4, 30 days | circles the point, never more than 307 km away | drifts away steadily: 6875 km and growing |
| Ship 20 degrees ahead of Pell, 30 days | carried 99 000 km along a tadpole path | frozen in place (0.000 km) |
| Ship 1 m from L1 | 11 m after 6 h, 79 km after 24 h (unstable, but cheap to hold) | L1 is 2121 km from Pell, inside the 2503 km SOI, where Verda's pull is switched off: the ship falls into a 124 x 1911 km orbit around Pell and is 2571 km from L1 after 6 h |

There are no Lagrange points in the game. The game follows its own model exactly in all these cases (checked to
1e-9 m).

**A warning for any future n-body mode.** Adding the moons' pull to the ship while leaving Verda on its rail (no
recoil) is worse than patched conics: it adds 144 km of error to the 30-day low orbit and turns the Pell transfer
above into an impact (closest approach 115 km below the surface).

**Recommendation on an optional n-body mode.** It is feasible but it is not a switch. The integrator is the small
part: a symplectic step (Kepler drift about the dominant body plus kicks from the others, including the recoil
terms) for vessels, perhaps 300 to 500 lines, cheap enough at run time for dozens of vessels at 100 000x. The cost
is everything that today relies on orbits being closed-form conics: the map and its encounter prediction, maneuver
nodes, the transfer and rendezvous planners and the autopilot, apsis readouts, background vessels on rails, SOI
events and "stable orbit" contract conditions. Each would need numerically propagated trajectories with caching
and new tests; that is several weeks of work and it would make high orbits near moons unstable, which changes
gameplay. The body system would also have to be made self-consistent first (moons' periods currently ignore their
own mass: Pell 0.89 %, Nym 2.0 % off). Suggested order if it is ever wanted: (1) keep patched conics as the
default; (2) offer n-body only as a display overlay of the predicted path on the map, which needs the integrator
and nothing else; (3) only then consider flying in it.

## 5. Bugs found and fixed

**Fix 1: thrust used the mass at the start of each step** (`js/core/vessel.js`, `_stepFlight`).
Acceleration was thrust divided by the mass before the step's propellant was burned, a first-order error that made
every burn fall short of the rocket equation by dt/2 x ve x mdot x (1/m_dry - 1/m_wet).

| Burn | Before | After | Rocket equation |
|---|---|---|---|
| Single stage to depletion, full throttle | 2750.78 m/s (-0.234) | 2751.01 m/s | 2751.01 m/s |
| Same at 50 % throttle | -0.117 m/s | 2e-6 m/s | |
| Two-stage, first / second stage | -0.25 / -0.19 m/s | 1e-5 m/s | |

Now the mass at mid-step is used. For a bare solid booster the old shortfall reached about 0.1 %.
Regression test: "a burn to depletion delivers the rocket-equation delta-v".

**Fix 2: encounters missed or found late** (`js/core/trajectory.js`, `findPatchEnd`, new `sampleEncounters`;
`js/core/world.js`, `_predict`).
The search for the next SOI entry (a) stopped at the first outward crossing of 1.5x the outermost moon's orbit, so
an encounter on the inbound leg of a long orbit was never looked for; (b) took 300 evenly spaced samples whatever
the orbit, too few for fast eccentric passes; (c) did not search a hyperbolic approach from outside. The world
also assumed a prediction without an encounter stayed valid for one period.

| Measure | Before | After |
|---|---|---|
| Aimed encounters whose first SOI entry the map missed | 36 of 3984 | 0 |
| Game flights at Nock that skipped the moon entirely | 2 of 57 | 0 |
| Late SOI entries seen in flight | Dray 5067 s and 3531 s late, Brim 1822 s late | within 4e-5 s |
| Cost per prediction (same machine, same cases) | 1.3 to 1.9 ms | 0.7 to 1.1 ms |

The sampler now steps by a fraction of the local dynamical time of the ship and of each moon in reach, and jumps
exactly over stretches of the orbit outside every moon's band of radii.

**Fix 3: fast hyperbolic passes** (same function, found by the final full run).
A 13 km/s pass through Verda's SOI crosses the whole moon system in less than one dynamical time, so the sampler
of fix 2 stepped over Pell: a 370 s clip of Pell's SOI was missed (1 flight in 1440). On a hyperbola the step is
now also limited to a fraction of r / speed. After: 0 of 1440.
Regression test for fixes 2 and 3: "encounters the old search missed are predicted and flown on time" (Ost, Dray,
Nock, Brim, Nym and the fast Pell graze, as map prediction, as the flown vessel and as a background vessel).

**Fix 4: the interplanetary planner did not plan the cheap transfer** (`js/core/autopilot.js`, `planInterplanetary`).
Two causes. (a) The first guess used the textbook burn sqrt(v_inf^2 + 2GM/r), which forgets that v-infinity is wanted
at the edge of a finite SOI, so the ship left too fast. (b) The search then closed the remaining miss, measured in
three dimensions, by burning harder, which turned a Hohmann transfer into a fast one with a high arrival speed. Now
the burn subtracts 2GM/r_soi, the miss is judged in the departure planet's orbital plane (timing and burn size
cannot fix the tilt of the target's orbit; the mid-course correction does), the burn stays within 2.5 % of the
minimum, and a direct hit is taken only when it is cheaper overall than a mid-course fix.

Planner alone, impulsive, same recipe before and after (ejection from a low orbit, correction at 40 % of the way;
total = ejection + correction + capture into low orbit):

| Transfer | Ejection before | after | optimum | Arrival speed before | after | Hohmann | Time / Hohmann before | after | Total before | after | optimum |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Verda to Rusk | 1094 | 989 | 989 | 2287 | 939 | 930 | 0.61 | 1.02 | 3090 | 1884 | 1658 |
| Verda to Murk | 999 | 973 | 973 | 1836 | 1148 | 896 | 0.76 | 0.88 | 2328 | 2133 | 1817 |
| Verda to Cindra | 1597 | 1412 | 1412 | 6029 | 3482 | 3613 | 0.71 | 0.94 | 7131 | 5423 | 4483 |
| Verda to Orrin | 2587 | 2339 | 2305 | 3485 | 1977 | 1642 | 0.45 | 0.70 | 5608 | 4690 | 4350 |
| Verda to Thal | 1960 | 1921 | 1902 | 2033 | 1890 | 1853 | 0.74 | 0.82 | 4493 | 4394 | 4320 |
| Rusk to Verda | 631 | 576 | 576 | 1957 | 1067 | 993 | 0.83 | 0.92 | 2231 | 1817 | 1558 |
| Sear to Verda | 6078 | 4774 | 4774 | 6896 | 3139 | 3378 | 0.53 | 1.06 | 14116 | 7819 | 7184 |
| Cindra to Verda | 3504 | 3016 | 3016 | 5241 | 1790 | 1925 | 0.52 | 1.20 | 10325 | 5487 | 4429 |

(all m/s). The gap that remains between "after" and "optimum" is the cost of the target's orbital tilt, which a
coplanar Hohmann figure does not contain (Rusk: 226 m/s of the 221 m/s correction). Over all pairs with a complete
plan the mean total is 1.20 times the coplanar optimum (before: 1.29); the old planner was more than 4 % and 20 m/s
off the minimum ejection burn on 14 of 55 major pairs, the new one on none.
Planning takes about as long as before. Flown end to end with a real ship (group 3f): ejection 1030.4 m/s,
arrival 947 m/s after 72.1 days; before: 1127.9 m/s, 2254 m/s, 44.7 days.
Regression test: "the transfer planner stays close to the minimum-energy transfer".

**Fix 5: maneuver burns stopped 0.15 m/s short** (`executeNode`). A mid-course burn 44 days before arrival turns
0.13 m/s left over into 650 km at the target: flight 7 was promised a 395 km periapsis at Rusk and got -258 km
(an impact course). The cut-off is now 0.03 m/s: 390 km against 395 km promised.

**Fix 6: the landing autopilot let a tall lander touch down leaning** (`hoverslamLanding`). This is why
"flight 7: Farwind" fell over on Dray when its arrival changed. In weak gravity the program leans up to 20 degrees to
kill sideways drift, and it went down the last metres still leaning 17 degrees; the 24 m lander pivoted over its
first leg and slowly toppled (tilt at rest 0.916 rad). It also climbed back to hover height whenever a brushing leg
disturbed the drift reading, hopping six times. Now, once the drift is small, it stands upright below 12 m and waits
there until it is upright; from 5 m it is committed and goes straight down; and it touches down no harder than a fall
from one metre in local gravity (0.66 m/s on Dray instead of 1.5). Result: tilt at rest 0.001 rad, one touchdown.
The test was not changed.

No existing test encoded wrong physics; none was changed.

## 6. Known limits and open items

- **Transfer planner, remaining limits** (group 3j lists every pair). Transfers from Quell: the correction does not
  converge (Quell to Verda arrives at 6367 m/s against 3603) and three pairs get no correction at all; Quell is a
  near-binary with Nym and has a tiny SOI. Thal to Verda arrives 28 % fast. Transfers to or from Wend (the comet,
  very eccentric and inclined) are plane-change dominated, and five get no complete plan. A few pairs between other
  planets are 10 to 30 % dearer than the old planner happened to find (Cindra to Thal, Thal to Cindra, Orrin to
  Quell, Sear to Cindra). Targets with tilted orbits are reached by a mid-course plane change, which is not the
  cheapest possible strategy (leaving when the target is near the line of nodes is).
- **Pell transfer planner aims at the leading edge of Pell's SOI** (phase angle 98.8 degrees against the
  centre-to-centre 110.6). Measured, not changed: the departure burn is exactly the Hohmann burn, the capture burn
  is 245.9 m/s against 240.9 for a centre hit, 4.9 m/s or 0.44 % of the trip, and no encounter is missed. It
  leaves one phase window earlier and gives a prograde pass.
- **Separator springs** add 1.23 m/s to the upper stage. The delta-v readout deliberately does not count it: the
  readout is what the engines can deliver (rocket equation), which is the convention players expect, and the push
  depends on what is being dropped. The readout's tooltip now says so.
- **Bodies are not a self-consistent system.** Moons' periods ignore their own mass (Pell 0.885 %, Nym 2.0 %,
  Tiv 0.076 %, Marn 0.061 % longer than two-body). Harmless under patched conics; other code depends on the
  current values, so they were left alone.
- **Laplace SOI larger than the Hill sphere** for Pell (10 %) and Nym (17 %), as for the real Moon. Not an error.
- **Wend** (the comet) crosses the radial bands of Verda, Rusk and Thal. Bodies do not interact, so nothing
  happens, but a ship can meet it there.
- **Near-circular orbits** (1e-10 < e < 1e-6) carry a constant 1.6 mm phase offset from `Orbit.fromState`.
- **Atmosphere**: pressure is density scaled, not hydrostatic (Verda's rho0 g H is 67.9 kPa for "1 atmosphere");
  density is one exponential and does not follow the temperature profile; the top 8 % of each atmosphere fades
  smoothly to zero (it used to step: 4e-6 of the surface value on Verda, 1e-3 on Rusk). The speed of sound follows
  each world's gas and temperature (chapter 10); the temperature profile is one shape scaled to every world.
- **Body forces above Mach 1.5** are Newtonian impact pressure on each part's own surface, blended in from the
  face-and-side law between Mach 1.5 and 4. Shock waves from one part do not strike another, there is no skin
  friction or separation, the gas is ideal at any temperature, and a part behind a wider one keeps a flat 10 %.
  Wings, fins and panels still use the single drag-rise curve.
- **Drag integration** is first order in the speed-dependent force at 20 ms: 0.9 m over a 5.4 km fall.
- **Physics warp** uses 100 ms steps when coasting in vacuum: 1.5 m of along-track error per 10 low orbits,
  with energy conserved to 5e-8 m of semi-major axis.
- **Clohessy-Wiltshire** differs from the game by 0.4 m over 600 s at 100 m range. That is the linearisation of
  the equations, not the game; the game matches the exact solution to 4e-7 m.

## 7. What a genre veteran will notice

For someone who knows Kerbal Space Program or similar games:

- **It is the same model.** Patched conics, bodies on rails, single-body gravity, Laplace spheres of influence,
  exact rails under time warp. Orbits never decay or precess, and the map's conics are what you will fly.
- **No Lagrange points, no n-body effects.** You cannot park at L1 or L4, there are no halo orbits, low-energy
  transfers or weak-stability captures, and nothing perturbs a station left in orbit for a century.
- **The system is small**, about a tenth of real scale. Low orbit is 2.2 km/s and takes 35 minutes; the moon is
  9 hours away; Rusk is 71 days away for about 1 km/s. Finite-SOI effects are therefore large: leaving Verda with
  the textbook burn overshoots by 2.6 % in aphelion, which the planner now accounts for.
- **SOI crossings are exact and warp-safe.** Encounters are found to 1e-5 s at any warp, including grazes of
  30 km moons at 100 000x; the old habit of dropping out of warp "to be safe" is not needed.
- **Moons are massless for their own orbit and planets do not wobble.** Pell's period is 0.9 % longer than a
  two-body calculation with its mass gives. You will only see it if you compute periods by hand.
- **Burns are finite and the map is impulsive**, as in the genre. A 44 s injection lands 120 km off at Pell;
  split long burns or correct mid-course. The autopilot centres burns on the node and ends within 0.03 m/s.
- **The delta-v readout is engines only**, vacuum Isp, all stages; it matches the rocket equation to 1e-5 m/s.
  Separator push is not counted.
- **Inclined targets are reached by a mid-course plane change.** The transfer planner gives the minimum-energy
  ejection in the home planet's plane and expects a correction about 40 % of the way; it does not search
  porkchop plots or wait for the line of nodes. Expect 200 to 350 m/s of correction for Rusk and Murk.
- **Atmospheres are simple.** Exponential density with one scale height, a tapered top, a speed of sound from each world's gas and temperature,
  body forces by shape above Mach 1.5 (a tilted capsule lifts but does not yet hold its tilt), no winds. Heating follows the Sutton-Graves law on each part's own nose radius, scaled 20 times (declared, and switchable to 1 in Settings); peak heating comes before peak g, where
  it should. Aerobraking works and is predictable.
- **Rotation is right.** The pad gives 203 m/s eastward for free, tidally locked moons keep one face to their
  planet, and a ship let go on the surface is on the orbit its surface velocity implies.
- **Physics warp is trustworthy for coasting.** Energy is conserved to centimetres of semi-major axis over ten
  orbits at 4x; only the phase slips, by about 1.5 m.
