# Starwright: Aerodynamics and Re-entry Build Specification (Roadmap Item 6)

23 November 2026. Written for Jerry Smith. The companion science document is [REENTRY_SCIENCE.md](REENTRY_SCIENCE.md).

> **Build status.** Part A (the air: gas, temperature, speed of sound, Mach number, the taper at the top) is built, except A5 (parts cooling toward the air temperature), which moves to the heating step, part E, so that the first step changes as little as possible. Parts B to G are not built. The verification checks are chapter 10 of the suite (`tests/verify/checks_aero.mjs`); chapter 10 was already taken by the booster checks. The open questions in section 12 stand at their defaults.

## 1. Summary

This specification turns roadmap item 6 into seven pieces of work that can each be built, verified and merged on its own, and it changes nothing below Mach 0.7, so landings, parachutes, aircraft handling and rovers fly exactly as they do today. No game code has been written. The science behind every requirement is in the companion document, The Mathematics and Science of Aerodynamics and Re-entry, referred to here as the science document.

### What gets built

| Part | What the player gets | Science document |
| --- | --- | --- |
| A. Atmosphere | A speed of sound that changes with altitude and from world to world, and a Mach number that is true everywhere | Section 2 |
| B. Body forces | Drag that depends on shape as well as Mach number; hypersonic forces from Newtonian theory; parts shielding the parts behind them | Sections 4, 5, 11 |
| C. Capsule lift | A capsule that trims at an angle, flies with a lift-to-drag ratio near 0.3 and is steered by rolling; an entry prediction on the map | Sections 6, 7 |
| D. Lifting surfaces | Wings and fins that lose lift at supersonic speed as real ones do; grid fins with their transonic weakness | Sections 4, 11 |
| E. Heating | Heating that depends on a part's size, shape and attitude and on whether it is in another part's shadow; ablation by area | Sections 8, 10 |
| F. Plasma and blackout | A glow and a radio blackout where the physics supports them | Section 9 |
| G. Winds | Winds aloft, off by default | Section 2 |

### Rules the work is built under

1. **Nothing changes below Mach 0.7.** Every new force law is blended in between Mach 0.7 and its full value at higher speed. A regression check holds the low-speed forces equal to today's to nine figures. The one exception is that Mach 0.7 itself moves to a lower airspeed once the sound speed is true (part A).
2. **Every physics change has a matching check** in the independent verification suite, against a closed form or the reference integrator. Section 9 lists them. The checks become chapter 10 of the suite.
3. **Every pull request flies the stock fleet before and after** and reports what moved: staging altitude, max Q, delta-v to orbit, booster landing error, heat shield use. Today a folded-leg drag error moved a staging event from 20 km to 15 km while every test stayed green, so these are reported as numbers, not as pass or fail.
4. **Every pull request is flown in the real game on your Mac** against a short written flight card, and the result is reported beside the test numbers.
5. **The cost stays inside the frame.** The whole of item 6 may add at most 0.2 ms to a physics step of about 1.5 ms (section 10).
6. **What is modelled, simplified and left out is stated** in the game's documents and in the built-in science reference, as it is now.
7. Each constant lives in `TUNING` or the part data, so the science reference reads it at draw time and cannot drift from the flight code.

### What stays as it is

The density law of each world, patched-conic orbits, the structure and breakup models themselves, the parachute model, wheels, legs and ground contact, and all behaviour at low speed.

### Two findings that shape the plan

The game already gives a tilted capsule lift, measured at 0.20 lift-to-drag at 20 degrees against a Newtonian value of 0.33, with nothing checking it. So part C is mostly correction and verification, not invention. And a physically true heating law would make the home world's entries nearly harmless, because they are at 2.35 km/s. That is a choice about the game and not about the physics, and it is the first open question in section 13.

## 2. Part A: atmosphere

Each world gets a gas and a temperature profile, and the speed of sound is computed from them; the density law is left exactly as it is, so no trajectory changes through density.

| ID | Requirement |
| --- | --- |
| A1 | Each world with an atmosphere carries a gas: ratio of specific heats gamma and molar mass M. Defaults: Verda and Marn air (1.40, 0.02896), Murk and Rusk carbon dioxide (1.29, 0.04401), Thal and Orrin hydrogen and helium (1.45, 0.0023). |
| A2 | Each world carries a temperature profile T(h), piecewise linear in altitude. It is stored as fractions of the isothermal temperature T\_iso = M g H / R that the world's existing scale height implies, at altitudes given in scale heights. |
| A3 | Speed of sound is a(h) = sqrt(gamma R T(h) / M), provided by one function, `body.soundSpeed(alt)`. The constant `TUNING.SOUND_SPEED` is deleted, and a test fails if anything still refers to it. |
| A4 | Mach number everywhere is airspeed divided by a(h): the flight model, the instruments, jet engine limits, the booster guidance's fall prediction and the science reference's calculators. |
| A5 | The ambient temperature that parts cool toward inside an atmosphere is T(h). In vacuum it stays 290 K. |
| A6 | Density rho0 exp(-h/H) and the pressure readout are unchanged. |
| A7 | In the top 8 % of each atmosphere's height, density is multiplied by a smooth taper that reaches zero at the top, so drag and heating start and stop without a step. |

### Default temperature profile

The default has the shape of Earth's standard atmosphere, scaled to each world's scale height. Because T\_iso = M g H / R, the sound speed is a(h) = sqrt(gamma g H) x sqrt(T / T\_iso).

| Altitude (scale heights) | T / T\_iso | Verda altitude (km) | Verda temperature (K) | Verda sound speed (m/s) |
| --- | --- | --- | --- | --- |
| 0 | 1.18 | 0 | 229 | 303 |
| 1.5 to 2.8 | 0.88 | 8.7 to 16.2 | 171 | 262 |
| 6.5 to 7.0 | 1.10 | 37.7 to 40.6 | 213 | 293 |
| 12 and above | 0.76 | 69.6 and above | 147 | 243 |

Today's value is 320 m/s everywhere. A per-world profile can replace the default later without code changes.

### What moves

- On Verda the Mach number at a given airspeed rises by 6 to 22 %. The transonic drag rise begins at 183 to 212 m/s in place of 224 m/s and peaks at 288 to 333 m/s in place of 352 m/s. Ascent drag loss rises slightly; the amount is to be measured on the stock fleet, and I expect tens of metres per second at most.
- Jet engines are limited by true Mach number. A limit of Mach 2.5 becomes about 655 m/s at height, against 800 m/s today.
- On Rusk and Marn the Mach number roughly doubles. On Thal and Orrin it halves.
- The taper changes density only where it is already under 1.4e-5 kg/m3 on Verda. On Rusk and Marn it softens the upper 3 to 4 km, which will shift a high aerobraking pass slightly.

### Stated inconsistency

Density stays an isothermal exponential while sound speed uses a layered temperature. A fully hydrostatic model would derive density from the temperature layers, and would change the density at some altitudes by 20 to 30 %, moving every ascent and entry. The default is to keep the exponential and say so in the documents (open question 3).

## 3. Part B: body forces

The force on every stack part becomes a blend of today's model at low speed and a Newtonian model at high speed, with a drag curve that depends on how blunt the part is and a rule for parts that sit in another part's shadow.

| ID | Requirement |
| --- | --- |
| B1 | The single Mach multiplier is replaced by two curves, one for blunt faces and one for slender ones. Each face's own coefficient c (0.12 for a nose cone to 0.9 for a flat face, already in the part data) sets the mix: bluntness b = clamp((c - 0.2) / 0.5, 0, 1). Flanks and radially mounted parts use the blunt curve. Both curves equal 1 at and below Mach 0.7. |
| B2 | The wake-side fraction (today a constant 0.25 of the lee face's drag area) stays 0.25 up to Mach 1 and falls as 0.25 / Ma^2 above it. |
| B3 | For each stack part a table of Newtonian coefficients C\_A, C\_N and C\_m against angle of attack (0 to 180 degrees in 5 degree steps) is computed once, by integrating C\_p,max sin^2(theta) over the part's surface of revolution, with shadowed surface contributing zero. Faces covered by a stack neighbour are excluded, as today. C\_p,max(Ma) comes from the Rayleigh pitot formula. |
| B4 | The force on a stack part is F = (1 - w) F\_classic + w F\_Newton, with w rising smoothly from 0 at Mach 1.5 to 1 at Mach 4. F\_classic is today's formula with B1 and B2 applied. |
| B5 | Heat shields and capsule bases are spherical segments with a half-angle `capPhi` in the part data (default 25 degrees). Nose cones carry a tip radius. These feed B3 and the heating in part E. |
| B6 | Each part gets an exposure e between 0 and 1 each step from a shadow rule: walking downstream along the stack, the widest disc passed casts a tube along the wind direction; a part wholly inside the tube has e = 0, wholly outside e = 1, and partly inside in proportion. The tube fades out between 2 and 4 diameters behind the disc, where a real wake closes. |
| B7 | Above Mach 1.5 a shadowed part keeps 10 % of its force. Below Mach 0.7 shadow has no effect on forces. Between, the effect is blended. |
| B8 | Pitch damping keeps today's empirical term, because Newtonian theory supplies none. |

### Default drag curves

Multiplier on the low-speed drag coefficient, linear between the points.

| Mach number | 0.7 | 0.9 | 1.1 | 1.5 | 2.5 | 4 | 8 and above |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Blunt | 1.00 | 1.25 | 1.55 | 1.65 | 1.60 | 1.55 | 1.55 |
| Slender | 1.00 | 1.40 | 1.90 | 1.60 | 1.10 | 0.90 | 0.80 |
| Today, all parts | 1.00 | 1.50 | 2.00 | 1.86 | 1.50 | 1.50 | 1.50 |

These defaults are my reading of the general shape of published curves and are to be calibrated in the pull request against Hoerner's charts and against the Newtonian limit of B3, which the blunt curve must meet at Mach 4. They are tunables, not physics constants, and the documents will say so.

### What moves

- A slender rocket has less drag above Mach 2 than today, by up to a third of its nose drag. Ascents gain a little delta-v and stage a little higher.
- A capsule heat shield first has about the same drag as today at high Mach number (its coefficient is 1.48 today and about 1.5 by B3), minus a base contribution of about 9 % that B2 removes.
- A capsule held at 20 degrees has a lift-to-drag ratio of 0.30 to 0.34 above Mach 4 in place of 0.20.
- Parts tucked behind a wider part stop adding supersonic drag.

### Belly-first vehicles

The refuelling-mission work needs a long cylinder flying at 60 to 90 degrees angle of attack and steered by flaps that change drag. B3 covers this without special cases: the table runs through 90 degrees, where a cylinder's Newtonian cross-flow coefficient is (2/3) C\_p,max = 1.23, and below Mach 1.5 today's flank drag takes over down to subsonic terminal fall. A flap is a flat plate, and its hypersonic force is C\_p,max sin^2 of its angle to the wind when it is on the windward side and zero in shadow, which the existing post-stall plate model and B6 together provide. The flap parts themselves belong to that work.

## 4. Part C: capsule lift and steering

A capsule gets a switchable trim angle, a way to hold a bank, the instruments to fly an entry by hand and a prediction of where the entry ends.

| ID | Requirement |
| --- | --- |
| C1 | Lift on a capsule comes from part B, with no separate lift law. Target: lift-to-drag 0.30 to 0.34 at 20 degrees above Mach 4, checked against the closed form for a spherical cap. |
| C2 | Capsules carry an action, Entry trim, off by default. When on, the capsule's centre of mass moves sideways by y = (R\_c - x\_cg) tan(epsilon) for a target trim angle of 18 degrees, where R\_c is the shield's radius of curvature. The shift enters both the centre of mass and the moment of inertia. The capsule then settles at its trim angle on its own. |
| C3 | A new attitude-hold mode, Bank hold, keeps the vessel at its trim attitude and at a commanded bank angle about the velocity vector. Roll keys change the commanded bank. It uses the same reaction wheels and thrusters as the existing hold modes and spends the same resources. |
| C4 | While in an atmosphere above Mach 3, the flight display shows bank angle, a lift-vector marker on the attitude ball, lift-to-drag now, g now, heat flux now, and the predicted peak g and peak heat flux for the present path with the present bank held. |
| C5 | The map draws the path inside the atmosphere for the active vessel: where it lands, or the orbit it leaves on if it skips out. The path is integrated from the entry equations with the vessel's present drag area, lift-to-drag and bank, refreshed twice a second. Today the map's path stops at the top of the atmosphere. |
| C6 | With Entry trim off, a capsule flies exactly as part B alone gives: it trims at zero and enters ballistically. Existing saves and scenarios load with it off. |

### Why a switch

A real capsule's offset is built in. A fixed offset in the game would put a small sideways imbalance on every rocket that carries a capsule and would change every existing capsule flight. Real practice offers a precedent for switching: Mars Science Laboratory flew to Mars balanced, threw off two 75 kg weights before entry to move its centre of mass, and threw off six more before the parachute to re-centre it (approximate, from memory). The switch is the game's version of that.

### Expected behaviour, from the reference integration

| Entry | Ballistic | L/D 0.3, lift up | L/D 0.3, lift down |
| --- | --- | --- | --- |
| From low Verda orbit, 1.5 degrees at 72 km | 2.75 g | 1.55 g | 4.5 g |
| From Pell, 3,300 m/s, 12 degrees | 2.3 g, captured | Skips out | 5.8 g, captured |
| From Pell, 3,300 m/s, 14 degrees | 4.3 g | 2.6 g | 8.0 g |

These are for a ballistic coefficient of 300 kg/m2 with no rotation, and are the numbers a flight in the real game will be compared with.

### Not included by default

An autopilot that modulates bank to reach a chosen landing site, as Apollo's guidance did. The instruments and the map prediction are enough to fly to a site by hand. It is open question 8.

## 5. Part D: wings, fins and grid fins

Lifting surfaces keep today's behaviour below Mach 1 and lose lift and gain drag above it as linear supersonic theory says they must.

| ID | Requirement |
| --- | --- |
| D1 | Above Mach 1 the lift-curve slope is the smaller of today's value and 4 / sqrt(Ma^2 - 1). For a wing (3.6 per radian) the cap takes hold above Mach 1.49; for a fin (1.6 per radian) above Mach 2.69. The join is continuous by construction. |
| D2 | Above Mach 1 the drag-due-to-lift factor K is the larger of today's 0.07 and sqrt(Ma^2 - 1) / 4, which is the flat-plate result C\_D = C\_L x alpha. |
| D3 | Profile drag of wings and fins follows the slender curve of B1. |
| D4 | Stall and the post-stall flat-plate model are unchanged. The post-stall normal force coefficient (1.8) already agrees with the Newtonian value (1.84) to 2 %. |
| D5 | Wings and fins take the exposure of B6 and B7, so a fin in the body's shadow at high angle of attack loses its force above Mach 1.5. |
| D6 | The Lattice Vane (grid fin) gets a transonic penalty: between Mach 0.8 and 1.3, lift slope is reduced by up to 40 % and drag raised by up to 100 %, greatest at Mach 1.0. Outside that band it behaves as now. |

### What moves

| Mach number | Wing slope today | Wing slope under D1 | Fin slope today | Fin slope under D1 |
| --- | --- | --- | --- | --- |
| 1.5 | 3.6 | 3.58 | 1.6 | 1.6 |
| 2 | 3.6 | 2.31 | 1.6 | 1.6 |
| 3 | 3.6 | 1.41 | 1.6 | 1.41 |
| 4 | 3.6 | 1.03 | 1.6 | 1.03 |
| 5 | 3.6 | 0.82 | 1.6 | 0.82 |

Winged craft have less lift and more drag when supersonic, as real ones do. Fins on a returning booster lose up to half their authority above Mach 3, and grid fins dip through Mach 1, which falls just before the landing burn. The booster guidance has to be re-measured with this in place (section 8).

The D6 numbers are illustrative. Published grid-fin data vary widely with the lattice geometry, and I have no single curve to cite. They are tunables and will be labelled as a game model of a real effect.

## 6. Part E: heating

Heat flux on a part depends on the part's own radius, its attitude and its exposure; skin temperature follows from a heat balance with thermal mass and radiation; ablation is by area.

| ID | Requirement |
| --- | --- |
| E1 | Flux on part j is q\_j = S x k x sqrt(rho / R\_j) x v\_j^3 x f\_j x e\_j. k is the Sutton-Graves constant for the world's gas (1.7415e-4 for air, 1.9027e-4 for carbon dioxide; the hydrogen-helium value is to be read from the Sutton-Graves report at build time). v\_j is the part's own airspeed, as now. |
| E2 | R\_j is the effective nose radius: the radius of curvature for a heat shield or capsule base (r / sin(capPhi)); three times the face radius for a flat face; the tip radius for a nose cone; the part's own radius for a flank; half the thickness, with a floor of 2 cm, for radial parts and for the edges of fins and wings. |
| E3 | f\_j is the attitude factor: for a leading face, the cosine of the angle between its normal and the wind to the power 1.5; for a flank or an edge, the swept-cylinder factor (1/sqrt 2) sin(alpha)^1.2; for a lee face, 0.03. |
| E4 | e\_j is the shadow exposure of B6, with a floor of 0.03. A part behind the heat shield and inside its shadow receives 3 % of what it would in the open. |
| E5 | S is one declared heating scale (open question 1). At S = 1 the flux is physical. The default sets S so that the stock Acorn capsule's shield reaches the same peak temperature as today on a reference entry. S appears in Settings and in the science reference as the model's one deliberate departure from physics. |
| E6 | Each part's temperature obeys C dT/dt = A \[ q - epsilon sigma (T^4 - T\_env^4) \], with C the heat capacity of its skin (mass x 900 J/(kg K) x a skin fraction, default 0.2), A its heated area, epsilon 0.85. The step is linearised implicit so that it is stable at 20 ms and under physics warp. This replaces the present fitted law (290 K + 0.30 (flux x exposure)^0.75 with fixed time constants). Part temperature limits are unchanged. |
| E7 | A heat shield with ablator left holds its face at an ablation temperature (default 2,700 K) and loses mass at S q A / Q\*, with Q\* one constant set so that the M shield uses the same ablator as today on the reference entry. Loss is proportional to area, so shields of every size lose the same fraction for the same heating. The 0.3 temperature factor is removed; what protects the parts behind a shield is its shadow. |
| E8 | A shield may be non-ablating: no ablator, a high temperature limit and high emissivity. It survives by radiating, under E6, and needs no special case. |
| E9 | A flank's heating depends on which side faces the wind. A part may declare a protected side (a direction across its axis and an arc); flux on the flank is taken on the windward side, and the part's limit is the protected one only when the wind falls within the arc. |
| E10 | The flight results show peak flux, peak temperature, total heat load at the hottest part, and ablator used. |

### What moves

- Small exposed parts are heated hardest. An antenna 4 cm thick in the open stream receives about 4.7 times the flux of a 0.9 m nose, and burns off first. Today it receives 0.6 times.
- Parts inside the shield's shadow are safe. Parts that reach past it are not.
- Large shields run cooler than small ones at the same speed and altitude, by the square root of their radius of curvature.
- A capsule flying at its trim angle exposes one side of its afterbody, and the shield's windward shoulder runs hotter than its centre.
- Hot parts cool by radiation in vacuum at a physical rate, in place of a fixed 30 s time constant.
- E9 and E8 together are what a tile-covered, belly-first vehicle needs, and are included at the request of the refuelling-mission work.

### The scale factor, plainly

Physical flux on a Verda orbital entry peaks near 50 kW/m2 on a 1 m nose, which is a radiative equilibrium temperature of about 1,000 K. Every part in the game has a limit of 1,300 K or more. At S = 1 a capsule could come home from orbit with no shield at all, and only a steep return from Pell (up to 260 kW/m2, 1,500 K) would threaten tanks. Today's fitted law destroys a 2,000 K part at about 100 kW/m2; physics says 770 kW/m2. So today's game is about eight times harsher than physics at this scale, and S is where that choice is made in the open.

## 7. Parts F and G: plasma, blackout and winds

Both are small, both are optional, and both come last.

### Part F: plasma and radio blackout

| ID | Requirement |
| --- | --- |
| F1 | An ionisation index I = (v^2 / 2) / h\_ion is computed for a vessel in an atmosphere, with h\_ion = 10 MJ/kg (a speed of about 4.5 km/s). It uses the physical speed, not the heating scale. |
| F2 | The existing glow stays and is driven by heat flux, as now. In the documents and the science reference it is described as heated air and a hot shield. A second, brighter sheath is drawn only where I is 1 or more. |
| F3 | Where I is 1 or more and heat flux is above a threshold, the vessel is in blackout: the display says so and science transmissions pause. Control of the vessel is not taken away. |
| F4 | The science reference states which entries in the Helion system reach I = 1: none at Verda, Murk, Rusk or Marn from their own orbits; all entries at Thal and Orrin. |

### Part G: winds

| ID | Requirement |
| --- | --- |
| G1 | Each world may carry a wind profile w(h): a steady east-west jet, zero at the surface, peaking at two scale heights with a width of one scale height. Default peak on Verda 30 m/s. |
| G2 | Air velocity for every aerodynamic force, the fall prediction and the map prediction becomes v - omega x r - w(h). |
| G3 | Winds are deterministic (a function of altitude only), so a flight repeats exactly and checks are repeatable. No gusts. |
| G4 | A Settings switch, Winds aloft, is off by default. |

With winds on, a rocket passing the jet at 300 m/s meets a crosswind angle of attack of up to 6 degrees near max Q. That loads fin roots and long stacks through the existing structure model with no further work, and it is the reason the switch starts off.

## 8. Effect on what is already live

Every aerodynamic force in the game is booked through one loop, so the new model reaches structure, breakup and guidance without separate work, and for the same reason each of them must be re-measured.

| Live feature | How the new model reaches it | What is re-measured and reported |
| --- | --- | --- |
| Structural loads (`docs/STRUCTURE.md`) | Joint loads are computed from the same per-part forces | The 300 structure checks; peak joint use of every stock design on ascent (3 to 60 % today) |
| Aerodynamic breakup (`docs/AERO_BREAKUP.md`) | Fin-root loads follow fin lift, which falls above Mach 2.7. Air ratings use cross-flow dynamic pressure, which gains the shadow exposure of B6. | The 113 breakup checks; the peak figures in the document (52 % fin root, 60 % air rating); the Colossus flip at max Q, re-flown |
| Reusable boosters (`docs/BOOSTERS.md`) | The fall prediction uses the Mach drag function, the sound speed, the axial drag area and the axial heat ratio. All four change. | The prediction is moved to the new functions in the same pull request as each change. Landing error on the Return Pad and on the barge; entry-burn heat margin; fuel left |
| Grid fins and steering vanes | D1 and D6 | Control margin through Mach 1 on a booster descent |
| Folding legs | Radial parts on the blunt curve; unchanged below Mach 0.7 | Staging altitude and max Q of the booster designs, legs folded |
| Two-ended stage separation | Ring and interstage debris are small blunt parts | That three pieces still separate cleanly at 20 kPa |
| Ascent autopilot | Drag on the way up changes under A and B | For every stock rocket: reaches orbit or not, delta-v used, staging altitude, max Q, before and after |
| Parachutes | Unchanged model; deployment speed limits are in m/s | Capsule descent time and touchdown speed |
| Jet aircraft | True Mach number limits the engines | Top speed and ceiling of the stock aircraft |
| The 15 scenarios, Flight School, Demo Tour | Any that pass through air | Each loads and completes; lesson text that quotes a Mach number is corrected |
| Saves | New part fields take defaults; Entry trim loads off | An old save loads and flies |
| Science reference chapters 9, 10 and 12 | They print `TUNING` constants that this work replaces | Rewritten in the same pull request. The unit test that flies real vessels against the printed formulas fails until they are, which is the intended tripwire. |
| README and manual | The Aerodynamics section and controls | Updated with each pull request |

### The known inertia defect

C2 changes the function that computes centre of mass and inertia, where the known defect lives (a capsule's ballast offset is in the centre of mass but not in the inertia, up to 9 % too much inertia on small craft). The default is to add the new sideways offset correctly to both and to leave the old defect for its own pull request, because fixing it changes landings.

## 9. Verification

Each requirement is tested three ways: against a closed form or an independent integrator in the verification suite, against today's behaviour on the stock fleet, and by a flight in the real game on your Mac. The suite's checks go in a new file, `tests/verify/checks_aero.mjs`, as chapter 10, with the reference side in `tests/verify/ref.mjs` written independently of the game code as the other chapters are.

### Chapter 10 checks

| ID | Check | Compared against | Tolerance |
| --- | --- | --- | --- |
| V1 | Sound speed at each profile node, every world | sqrt(gamma R T / M) computed in the reference | 1e-9 relative |
| V2 | Isothermal identity: with a flat profile, a = sqrt(gamma g H) | Closed form | 1e-9 relative |
| V3 | Sound speed in air at 288.15 K through the game's function | 340.29 m/s (U.S. Standard Atmosphere 1976) | 0.01 m/s |
| V4 | Mach readout, drag Mach and guidance Mach agree with airspeed / a(h) at 20 altitudes | Reference | 1e-9 |
| V5 | Density is continuous and smooth across the taper, and unchanged below it | rho0 exp(-h/H) below; no step at the top | Exact below; step under 1e-9 |
| V6 | Forces below Mach 0.7 on ten vessels in thirty states | Values recorded from today's `main` | 1e-9 relative |
| V7 | C\_p,max at Mach 2, 3, 5, 10 and the limit | Rayleigh pitot formula: 1.657, 1.756, 1.809, 1.832, 1.839 | 1e-3 |
| V8 | Newtonian table of a sphere-capped part | C\_D = C\_p,max / 2 | 0.5 % |
| V9 | Newtonian table of a flat-faced cylinder, end on and broadside | C\_p,max and (2/3) C\_p,max | 0.5 % |
| V10 | Newtonian table of a cone at zero angle | C\_p,max sin^2(half-angle) | 0.5 % |
| V11 | Spherical cap at five angle and half-angle pairs | Closed form for C\_A and C\_N (science document section 6): 1.4925 and 0.0512 at 20 and 24.6 degrees | 0.5 % |
| V12 | Capsule lift-to-drag at 5, 10, 20, 30 degrees above Mach 4, in the flight model | tan(alpha - epsilon) from V11, less the measured afterbody contribution | 5 % |
| V13 | Trim angle of a capsule with Entry trim on, released at Mach 6 | tan(epsilon) = y\_cg / (R\_c - x\_cg) | 0.5 degrees |
| V14 | Lift direction follows bank: vertical and lateral parts at bank 0, 45, 90, 180 degrees | L cos(sigma), L sin(sigma) | 1 % |
| V15 | Steep ballistic entry (30 degrees, capsule with constant drag coefficient forced): speeds at peak g and peak heating | Allen-Eggers 0.607 and 0.846 of entry speed | 0.02 of entry speed |
| V16 | Same entry: peak deceleration | v\_E^2 sin(gamma) / (2 e H) and the reference integrator | 3 % against the formula, 0.5 % against the integrator |
| V17 | Shallow ballistic entry from circular orbit on Verda | Chapman: 0.277 g sqrt(r/H) = 27.9 m/s2 at 0.43 v\_c; reference integrator 26.5 to 27.7 | 5 % against Chapman, 0.5 % against the integrator |
| V18 | Lifting entry, lift up and lift down, L/D from V12 | Reference integrator with the same L/D (1.55 g and 4.5 g for L/D 0.3) | 1 % |
| V19 | Corridor: Pell return at 10, 12, 14 degrees, ballistic | Reference integrator: leaves, captured, captured | Same outcome; peak g within 1 % |
| V20 | Map entry prediction against the flight that follows | The game's own flight | Landing point within 2 km; peak g within 3 % |
| V21 | Flux on a part of radius R at a fixed state | S k sqrt(rho / R) v^3 | 1e-6 relative |
| V22 | Flux ratio between two shields of different radius | sqrt(R2 / R1) | 1e-6 |
| V23 | Equilibrium temperature at constant flux | (q / (epsilon sigma))^0.25: 1,009 K at 50 kW/m2 with S = 1 | 1 K |
| V24 | Warm-up and cool-down curve of a part at constant flux | Reference integration of the heat balance | 1 % |
| V25 | Total heat load on a steep entry | k v\_E^2 sqrt(pi beta H / (R\_n sin(gamma))) and the integrator | 3 % and 0.5 % |
| V26 | Ablator used on the same entry by shields of three sizes | Same fraction for each; mass = S Q A / Q\* | 1 % |
| V27 | Exposure of a part fully inside, half inside and outside a shadow, at 0, 10, 20 degrees | Geometry computed in the reference | 1e-6 |
| V28 | Wing and fin lift slope at Mach 1.5, 2, 3, 4, 5 | min(slope, 4 / sqrt(Ma^2 - 1)) | 1e-6 |
| V29 | Drag due to lift of a wing at Mach 2 and 3 | C\_L x alpha | 1 % |
| V30 | Ionisation index and blackout onset | (v^2 / 2) / h\_ion; critical density (f / 8.98)^2 quoted in the reference text | 1e-9 |
| V31 | Winds: crosswind angle of attack and drift of a dropped capsule through the jet | Reference integrator with the same wind | 1 % |

The existing chapters stay in force. Chapter 4c (heating) is rewritten for the new law, and its present results (flux within 0.4 %, peaks at 0.87 and 0.62 of entry speed) become the baseline it must still meet on the steep entry.

### Stock fleet report

Run before and after each pull request, on every stock rocket and booster design, and printed as a table in the pull request: reaches orbit; delta-v used; staging altitudes; max Q and its altitude; peak joint use; peak fin-root and air-rating use; anything torn off; booster landing error and fuel left; capsule peak g, peak temperature and ablator used on the standard return. A change is acceptable when it is explained by the physics in that pull request, not when it is small.

### Flight cards, flown in the real game on your Mac

| Pull request | Flown | Looked for |
| --- | --- | --- |
| A | Skylark II and Colossus to orbit on the autopilot | Mach readout against speed and altitude from the table in section 2; staging altitude and max Q against the fleet report |
| B | Acorn capsule de-orbited and held at 20 degrees | Lift-to-drag on the display near 0.3; drag and descent time against the reference |
| C | Orbital return three ways: trim off, lift up, lift down. Then a Pell return at 12 and 14 degrees. | 2.75, 1.55 and 4.5 g; the corridor outcomes of section 4; landing point against the map prediction |
| E | Same returns with an antenna and a science part mounted inside and outside the shield's shadow | Outside burns, inside survives; shield temperature and ablator against the fleet report |
| D | A booster return to the pad and to the barge | Lands; control through Mach 1; error against the fleet report |
| F, G | An entry at Thal; a launch with winds on | Blackout shown and ended; crosswind angle and fin-root load |

Each card is run through the game's own page in your Chrome, with your saved games backed up and restored, and the frame rate is read at the same time.

## 10. Frame-time budget

The whole of item 6 may add at most 0.2 ms to a physics step for a 100-part vessel, against about 1.5 ms today in a 16.7 ms frame. Every piece is a table lookup or one pass over the parts.

| Piece | Work per physics step | Where the heavy work goes |
| --- | --- | --- |
| Sound speed | One profile lookup and one square root per vessel | Nothing heavy |
| Drag curves | Two table lookups per vessel | Nothing heavy |
| Newtonian forces | Three interpolations per stack part | The pressure integration (about 30,000 surface samples per part type) runs once when a part type is first used |
| Shadow exposure | One pass down each stack; one distance test per radial part | The stack order is rebuilt only on staging, docking or breakup |
| Heating | One square root and one fourth power per heated part, only while heat flux is above the present threshold | Nothing heavy |
| Map prediction | About 400 integration steps twice a second, spread over several frames | Runs only while the map is open or the vessel is in an atmosphere |

Measured with a step-timing harness added to the verification suite in the cloud, and with the game's own benchmark page (`?perf=1`) on your Mac, before and after each pull request. A pull request that exceeds its share is reworked before it is offered for merging.

## 11. Build order

Seven pull requests in this order, each complete on its own: code, chapter 10 checks, stock fleet report, flight card on your Mac, science reference text, documents and a What's New entry. Each waits for your word before it merges.

1. **A, atmosphere.** Sound speed, true Mach number, the taper. First because every later part depends on Mach number. Moves the transonic drag rise.
2. **B, body forces.** Drag curves by shape, base drag, Newtonian tables, shadow for forces. Makes capsule lift correct. Moves ascent drag above Mach 2.
3. **C, capsule steering.** Entry trim, Bank hold, instruments, map prediction. The first part a player sees and uses.
4. **E, heating.** Nose radius, attitude, shadow, heat balance, ablation by area. Needs the shadow from B and waits on open question 1.
5. **D, lifting surfaces.** Supersonic lift and drag of wings and fins, grid fins, and the booster guidance re-measured. Placed after heating because it is the one most likely to disturb booster landings.
6. **F, plasma and blackout.** Small.
7. **G, winds.** Optional, off by default.

At the end the roadmap entry is marked done, `docs/PHYSICS_VERIFICATION.md` gains the chapter 10 results and its limits list is brought up to date, and a new `docs/AERODYNAMICS.md` holds the model as built.

The science reference gains chapters on hypersonic flight, capsule lift and entry, and heating, written from the science document, with every constant read from the flight code and an entry-corridor calculator. They arrive with the pull requests whose physics they describe.

## 12. What is simplified and what is left out

The model after item 6 is an engineering model of the kind used for first-pass entry design, not a flow solution, and these are its limits.

### Simplified

| Subject | The simplification | Consequence |
| --- | --- | --- |
| Density | One scale height per world; not derived from the temperature layers | Sound speed and density are not hydrostatically consistent |
| Pressure | Scaled from density | Verda's surface pressure by its own density law is 67.9 kPa |
| Drag against Mach number | Two tuned curves mixed by bluntness | Right in shape; individual parts are not wind-tunnel accurate |
| Hypersonic forces | Modified Newtonian, per part, perfect gas with gamma fixed | Good for blunt bodies above Mach 4; overstates capsule L/D by about 10 %; poor for slender bodies at small angles |
| Interference between parts | A shadow tube only | No shock from one part striking another, no channel flow between boosters |
| Shadow at low speed | Not applied to forces below Mach 0.7 | A part behind another keeps its full subsonic drag |
| Flat-face heating | A flat face is treated as a sphere of three times its radius | Approximate; to be set against a published correlation at build time |
| Heating around a body | Fixed attitude factors, laminar | No turbulent heating, no hot shoulder computed from geometry |
| Part temperature | One temperature per part | No gradient through a part, no conduction between parts |
| Ablation | One heat of ablation; face held at one temperature | No char, no recession of shape |
| Wings | Lift acts at the part's centre at all speeds | Right for supersonic flight; a quarter chord too far aft for subsonic, as today |
| Grid fins | A tuned transonic dip | A game model of a real effect |
| Heating scale | One declared factor S | At the default, heating is harsher than physics by a stated amount |

### Left out

- **Real-gas chemistry in the forces.** Gamma is fixed for each world. At Verda's speeds the error is negligible; at Thal's it is a few per cent in drag.
- **Radiative heating.** It matters only above about 10 km/s in air. Entries at Thal and Orrin from interplanetary space would have it and will be understated.
- **Rarefied flow.** Verda's whole atmosphere is continuum flow for anything a metre across.
- **Boundary-layer transition and turbulent heating.**
- **Shock interaction heating** between parts.
- **Flex feeding back into the airflow.** The structure model draws flex but the air does not feel it, as now.
- **Gusts, weather and wind that varies with place.**
- **Dynamic instability of capsules** in the transonic range. Capsules keep today's damping.
- **Supersonic parachute behaviour.**
- **Orbital decay** from thin air above the atmosphere's top.

## 13. Open questions

Nine questions are yours to decide, and each carries the default I will build on if you say nothing. The first is the only one that changes what kind of game this is.

| No. | Question | Default | The alternative and what it costs |
| --- | --- | --- | --- |
| 1 | How severe should heating be on the home world? | Keep today's difficulty through one declared heating scale S, shown in Settings and the science reference as the model's one departure from physics. | S = 1, physically true for a tenth-scale world. Orbital returns need no heat shield and only steep returns from Pell are dangerous. More honest, less game. A Settings choice between the two is also possible. |
| 2 | Should capsule trim be a switch or built in? | A switch, Entry trim, off by default, so existing flights do not change. | Always offset, as on real capsules. Every capsule rocket carries a small imbalance and every existing capsule entry changes. |
| 3 | Should density follow the temperature layers? | No. Keep one scale height per world and state the inconsistency. | Fully hydrostatic layers. Physically consistent; density changes by 20 to 30 % at some altitudes, and every ascent, entry, stock design and scenario has to be re-tuned. |
| 4 | Which gas does each world have? | Verda and Marn air; Murk and Rusk carbon dioxide; Thal and Orrin hydrogen and helium. | Your own choices. Only gamma and the heating constant depend on it. |
| 5 | How should the atmosphere end? | A smooth taper over the top 8 % of its height. | Leave the step (a jolt on Rusk and Marn), or raise their tops to where density is negligible, which moves their lowest orbit and their scenarios. |
| 6 | Should Verda show a plasma? | Keep the present glow, described as hot air and a hot shield. Draw a true plasma sheath and blackout only where the physics gives one (Thal and Orrin). Blackout pauses science transmission and never removes control. | A plasma everywhere, labelled as a visual convention; or blackout that also cuts probe control, which is realistic and frustrating. |
| 7 | Winds? | Built last, off by default. | Leave out of item 6, or on by default, which makes every launch a little harder and lands boosters further off. |
| 8 | An autopilot that steers an entry to a chosen landing site? | Not in item 6. Instruments and the map prediction only. | Add bank-modulation guidance, as Apollo had. About one more pull request, and a good fit with the booster guidance already built. |
| 9 | Where should these two documents live? | In the repository as `docs/REENTRY_SCIENCE.md` and `docs/REENTRY_SPEC.md`, through a pull request you approve, when you have read them. | Keep them as working documents outside the repository until the work is done. |

Two smaller points need no decision but are worth your eye. The drag curves of section 3 and the grid-fin numbers of section 5 are tunables calibrated to published shapes, not derived, and will be labelled so. And the refuelling-mission work has asked this model for three things (a cylinder flying belly first, heating by windward side with a non-ablating shield, and flaps that steer by drag); all three are covered in sections 3 and 6 and add no extra pull request here.
