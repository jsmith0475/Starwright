# Starwright: The Mathematics and Science of Aerodynamics and Re-entry

23 November 2026. Written for Jerry Smith. The build specification that follows from it is [REENTRY_SPEC.md](REENTRY_SPEC.md).

## 1. Summary

Re-entry on Starwright's worlds is hypersonic in its aerodynamics but mild in its chemistry, and that one fact shapes everything the game should model. Verda is about a tenth of Earth's size, so low orbit is 2.35 km/s. A capsule returning from orbit meets the air at about Mach 8 with 2.8 MJ of energy per kilogram of air it stops. An Earth capsule arrives at 7.8 km/s with 30 MJ/kg. Fully dissociating air takes about 30 MJ/kg and ionising it takes far more, so a real plasma sheath belongs only to the gas giants Thal and Orrin (6.4 to 9 km/s) and not to Verda.

Six results carry most of the design. Each is derived in the section named.

| Result | What it says | Section |
| --- | --- | --- |
| Speed of sound | a = sqrt(gamma R T / M). It depends on temperature and gas only, so it changes with altitude and from world to world. | 2 |
| Mach number independence | Above about Mach 5 the force coefficients of a blunt body stop changing with Mach number. Newtonian theory gives them in closed form. | 5 |
| Capsule lift | A blunt body's force acts along its own axis. Offsetting the centre of mass tilts the body about 20 degrees and gives a lift-to-drag ratio near 0.3, steered by rolling. | 6 |
| Allen-Eggers | On a ballistic entry, peak deceleration is v\_E^2 sin(gamma) / (2 e H) at 0.607 of entry speed, whatever the vehicle's mass. | 7 |
| Heating law | Stagnation heat flux goes as sqrt(rho / R\_n) v^3. Blunt noses run cooler; small radii run hot. Peak heating comes at 0.846 of entry speed, before peak g. | 8 |
| Plasma threshold | A radio signal is cut off when electron density passes n = (f / 8.98)^2. That needs shock temperatures the home world's entry speeds do not reach. | 9 |

Section 13 measures today's game against this science, with numbers taken from the code on `main` at commit ec6ab6a. Two findings there were not in the existing documentation. A capsule held at an angle already produces lift in the game (measured lift-to-drag 0.20 at 20 degrees), but it trims at zero angle so a player never gets it for free. And the scale height the game uses for Verda implies an air temperature of 194 K and a sound speed of 279 m/s, not the constant 320 m/s the game uses.

Figures for real flights are quoted from memory of the standard references and marked approximate. Every equation and closed-form value was recomputed for this document. The companion document, the build specification, turns this into what the game should do.

## 2. The atmosphere as a gas

Density, pressure, temperature and sound speed are tied together by two equations, so a model may choose only some of them freely. A column of gas at rest carries its own weight, and the gas obeys the ideal gas law:

```math
\frac{dp}{dh} = -\rho g, \qquad p = \rho \frac{R}{M} T
```

Here R = 8.314 J/(mol K) and M is the molar mass (0.02896 kg/mol for air). Where temperature is constant the two combine into the exponential law the game already uses, and they fix the scale height:

```math
\rho(h) = \rho_0 \, e^{-h/H}, \qquad H = \frac{R T}{M g}
```

So a scale height is a statement about temperature. Earth's is 8.4 km at 288 K and averages about 7.2 km over the altitudes where entry happens.

### Temperature layers

A real atmosphere is not isothermal. In a layer where temperature changes linearly with height at a lapse rate L (K/m, negative when it cools upward), the hydrostatic equation integrates to a power law in place of the exponential:

```math
T = T_b + L (h - h_b), \qquad p = p_b \left( \frac{T}{T_b} \right)^{-g M / (R L)}
```

The U.S. Standard Atmosphere 1976 is built from seven such layers. The ones that matter for flight are these.

| Altitude (km) | Temperature (K) | Sound speed (m/s) | What is there |
| --- | --- | --- | --- |
| 0 | 288.2 | 340 | Sea level |
| 11 to 20 | 216.7 | 295 | Tropopause and lower stratosphere, where max Q usually falls |
| 47 to 51 | 270.7 | 330 | Stratopause, warmed by ozone |
| 86 | 186.9 | 274 | Mesopause, the coldest point |

### Speed of sound

Sound is a pressure wave travelling isentropically, which gives

```math
a = \sqrt{\gamma \frac{R}{M} T}
```

with gamma the ratio of specific heats (1.40 for cold air). Pressure and density cancel out. Sound speed depends on the temperature and on the gas, and on nothing else. Two consequences follow. On one world it varies by about 20 % with altitude, so the same airspeed is a higher Mach number in the cold stratosphere. Between worlds it varies far more:

| Atmosphere | gamma | M (kg/mol) | Typical T (K) | Sound speed (m/s) |
| --- | --- | --- | --- | --- |
| Air (Earth) | 1.40 | 0.0290 | 217 to 288 | 295 to 340 |
| Carbon dioxide (Mars, Venus cloud tops) | 1.29 | 0.0440 | 210 | 226 |
| Hydrogen and helium (gas giant at 1 bar) | 1.45 | 0.0023 | 165 | about 930 |

A probe entering a hydrogen atmosphere at 9 km/s is at Mach 10. The same speed in carbon dioxide is Mach 40.

### Winds

Aerodynamic force depends on velocity relative to the air. The air turns with the planet and moves over it, so

```math
\mathbf{v}_{air} = \mathbf{v} - \boldsymbol{\omega} \times \mathbf{r} - \mathbf{w}(h)
```

with w the wind. On Earth the jet stream peaks at 30 to 70 m/s near 10 to 12 km, close to where a rocket passes max Q. A crosswind w\_c on a rocket at speed v adds an angle of attack of about w\_c / v. The structural load of that scales with the product of dynamic pressure and angle of attack, which is why launch vehicles are flown to a q-alpha limit and why upper-level wind is a launch constraint. For an entering capsule wind matters only near the ground, as drift under the parachute.

### What this means for a model

Given a temperature profile T(h) and a surface pressure, hydrostatics fixes density and pressure, and the gas fixes sound speed. A model that sets density, pressure and sound speed independently will not be self-consistent. Section 13 shows where today's game stands on this.

## 3. Flow regimes

Three dimensionless numbers say which physics applies at each point of a flight. An entry passes through nearly all of the regimes they define, from the top down.

```math
\mathrm{Ma} = \frac{v}{a}, \qquad \mathrm{Re} = \frac{\rho v L}{\mu}, \qquad \mathrm{Kn} = \frac{\lambda}{L} \approx \sqrt{\frac{\gamma \pi}{2}} \, \frac{\mathrm{Ma}}{\mathrm{Re}}
```

L is a body length, mu the viscosity and lambda the mean free path between molecular collisions. Viscosity of air follows Sutherland's law, mu = 1.458e-6 T^1.5 / (T + 110.4) Pa s, and depends on temperature only.

**Mach number** compares speed with the speed at which the air can pass a warning ahead.

| Regime | Mach number | What happens |
| --- | --- | --- |
| Subsonic | below 0.8 | Air is warned and parts smoothly. Density changes are small below 0.3. |
| Transonic | 0.8 to 1.2 | Patches of supersonic flow end in shocks. Drag rises steeply, the centre of pressure moves, controls buffet. |
| Supersonic | 1.2 to 5 | Shock and expansion waves attached to the body. Wave drag. Disturbances cannot travel upstream. |
| Hypersonic | above about 5 | Shock lies close to the body, gas behind it is hot enough to change chemically, heating dominates the design. |

The boundaries are conventions. Hypersonic flow has no sharp onset; it is where the effects in section 5 can no longer be ignored.

**Reynolds number** compares inertia with viscosity. It decides whether the boundary layer is laminar or turbulent, which changes skin friction and can multiply heating several times. High in the atmosphere Re is low and the boundary layer is laminar; transition comes lower down, usually after peak heating on a capsule.

**Knudsen number** says whether the air is a fluid at all.

| Regime | Kn | Model |
| --- | --- | --- |
| Continuum | below 0.01 | Ordinary fluid dynamics |
| Slip | 0.01 to 0.1 | Fluid dynamics with slip at the wall |
| Transitional | 0.1 to 10 | Neither; molecular simulation |
| Free molecular | above 10 | Molecules hit the body one at a time; drag coefficient about 2 to 2.2 on any shape |

On Earth the mean free path is 66 nm at sea level, about 1 cm at 86 km and about 10 cm near 100 km (approximate, from the standard atmosphere). A capsule a few metres across is in continuum flow below about 90 km. Above that the forces are too small to matter for an entry and matter only for slow orbital decay.

Verda's atmosphere ends at 72 km, where the game's density is 5e-6 kg/m3. That is Earth's density at about 86 km. So the whole of Verda's modelled atmosphere is continuum flow for anything a metre or more across, and a rarefied-gas model would add nothing.

## 4. From subsonic to supersonic

Below Mach 1 a body's drag is friction and separation; above it, most of the drag is the energy carried away in shock waves, and the two regimes obey different laws.

### Dynamic pressure

Every aerodynamic force is a coefficient times an area times the dynamic pressure

```math
q = \tfrac{1}{2} \rho v^2 = \tfrac{1}{2} \gamma \, p \, \mathrm{Ma}^2
```

On ascent q rises with speed and falls with thinning air, and peaks at max Q. For most rockets that falls between Mach 1 and 2, in the transonic drag rise, which is why that minute of flight sets the structural design.

### Compressibility and the transonic rise

As Mach number rises toward 1, pressure differences on a body grow by the Prandtl-Glauert factor:

```math
C_p = \frac{C_{p,0}}{\sqrt{1 - \mathrm{Ma}^2}}
```

The formula is a linearisation and fails near Mach 1, where it predicts infinity. What really happens is that the flow over the thickest part of the body reaches Mach 1 first (at the critical Mach number, typically 0.7 to 0.85). A local supersonic pocket forms and ends in a shock. The shock thickens or separates the boundary layer and drag climbs to a peak just above Mach 1.

### Shock waves

Across a normal shock at upstream Mach number Ma the jumps are exact for a perfect gas:

```math
\frac{p_2}{p_1} = 1 + \frac{2\gamma}{\gamma + 1} (\mathrm{Ma}^2 - 1), \qquad \frac{\rho_2}{\rho_1} = \frac{(\gamma + 1) \mathrm{Ma}^2}{(\gamma - 1) \mathrm{Ma}^2 + 2}
```

Pressure rises without limit, but density saturates at (gamma + 1)/(gamma - 1), which is 6 for air. A shock inclined at wave angle beta turns the flow through an angle theta given by

```math
\tan \theta = 2 \cot \beta \, \frac{\mathrm{Ma}^2 \sin^2 \beta - 1}{\mathrm{Ma}^2 (\gamma + \cos 2\beta) + 2}
```

The weakest possible wave is a Mach wave at angle arcsin(1/Ma). Bringing the flow to rest raises its temperature to the stagnation value:

```math
\frac{T_0}{T} = 1 + \frac{\gamma - 1}{2} \mathrm{Ma}^2
```

| Ma | p2/p1 | rho2/rho1 | T2/T1 | T0/T |
| --- | --- | --- | --- | --- |
| 1.5 | 2.5 | 1.86 | 1.32 | 1.45 |
| 2 | 4.5 | 2.67 | 1.69 | 1.80 |
| 3 | 10.3 | 3.86 | 2.68 | 2.80 |
| 5 | 29.0 | 5.00 | 5.80 | 6.00 |
| 7.5 | 65.5 | 5.51 | 11.9 | 12.3 |
| 10 | 116.5 | 5.71 | 20.4 | 21.0 |

These are perfect-gas values with gamma = 1.4, recomputed here and tabulated in NACA Report 1135. Above about Mach 5 the real temperatures are much lower than the table, because the energy goes into chemistry (section 5).

### Lift and drag of thin surfaces at supersonic speed

Linear (Ackeret) theory gives the pressure on a surface inclined at a small angle theta to a supersonic stream, and from it the lift and wave drag of a flat plate at angle of attack alpha:

```math
C_p = \frac{2\theta}{\sqrt{\mathrm{Ma}^2 - 1}}, \qquad C_L = \frac{4\alpha}{\sqrt{\mathrm{Ma}^2 - 1}}, \qquad C_{D,w} = \frac{4\alpha^2}{\sqrt{\mathrm{Ma}^2 - 1}}
```

Three things follow that a pilot will recognise. The lift-curve slope falls as Mach number rises: 4.0 per radian at Mach 1.41, 2.3 at Mach 2, 1.4 at Mach 3. Drag due to lift is lift times alpha, with no leading-edge suction to recover. And the centre of pressure sits at mid-chord, not the quarter-chord of subsonic flight, so the aircraft's neutral point moves aft through the transonic range.

### How drag coefficient changes with Mach number depends on shape

| Shape | Subsonic | Peak near Mach 1.1 to 1.5 | Mach 3 | Hypersonic limit |
| --- | --- | --- | --- | --- |
| Sphere | 0.47 | about 1.0 | 0.95 | 0.92 |
| Blunt capsule, heat shield first | about 1.0 | about 1.6 | 1.5 | 1.5 |
| Slender cone-cylinder rocket | 0.25 to 0.35 | 0.5 to 0.6 | 0.3 | 0.2 or less, set by nose angle |

Values are approximate, in the style of Hoerner's collected data. The pattern is what matters. A blunt body's coefficient rises through Mach 1 and stays high. A slender body's coefficient peaks and then falls well below its peak, roughly as 1/sqrt(Ma^2 - 1) for the wave part, toward a small constant. One multiplier applied to every part cannot represent both.

## 5. Hypersonic flow: what is different

Hypersonic flight differs from ordinary supersonic flight in kind: the air stops behaving as a perfect gas, the shock wraps tightly around the body, and the force coefficients stop depending on Mach number. Anderson's textbook lists five features, and each has a consequence for a model.

| Feature | Physics | Consequence |
| --- | --- | --- |
| Thin shock layer | Density ratio across the shock is 6 or more, so the shock lies close to the surface | Pressure on a surface depends almost only on its angle to the stream (Newtonian flow) |
| Entropy layer | The curved bow shock on a blunt nose leaves a layer of hot, slow gas along the body | Heating and boundary-layer transition downstream of the nose change |
| Viscous interaction | The boundary layer is thick and pushes the outer flow | Matters for slender bodies at very high altitude |
| High temperature | Kinetic energy becomes heat: vibration, dissociation, ionisation | Lower temperature and thinner shock layer than a perfect gas; changed pressures and trim |
| Low density | High speed happens at high altitude | Laminar flow, eventually slip and free molecular flow |

### The energy available

The gas that is brought to rest on the body has total enthalpy

```math
h_0 = h + \frac{v^2}{2} \approx \frac{v^2}{2}
```

This one number, energy per kilogram of air, decides the chemistry. Compare it with what the chemistry costs. Breaking all the oxygen molecules in a kilogram of air takes 3.6 MJ. Breaking the nitrogen as well takes 29.5 MJ in total. Stripping one electron from every atom takes roughly another 95 MJ.

| Entry | Speed (km/s) | h0 (MJ/kg) | What the air does |
| --- | --- | --- | --- |
| Verda, from low orbit | 2.35 | 2.8 | Vibration excited; oxygen barely begins to dissociate |
| Verda, return from Pell | 3.3 | 5.5 | Oxygen dissociated; nitrogen intact |
| Earth, from low orbit | 7.8 | 30 | Oxygen gone, nitrogen largely dissociated, about 1 % or less ionised |
| Earth, lunar return | 11.0 | 61 | Fully dissociated, several per cent ionised, the gas radiates strongly |
| Thal, from low orbit | 6.4 | 21 | Real dissociation and ionisation (in a hydrogen atmosphere the thresholds differ) |
| Thal, arriving from Verda | 9 or more | 41 or more | Plasma and radiative heating |

Because the energy goes into chemistry, real temperatures are far below perfect-gas ones. At Apollo's lunar-return speed (Mach 36) the perfect-gas shock temperature would be 58,000 K; the real equilibrium value is about 11,600 K. At 2.35 km/s the correction is small: the perfect-gas stagnation temperature is about 2,900 K and the real one is a few hundred kelvin lower.

Onset temperatures at one atmosphere, for reference: vibration is excited from about 800 K, oxygen dissociates between 2,500 and 4,000 K, nitrogen between 4,000 and 9,000 K, and ionisation becomes significant above 9,000 K. At the low pressures of high altitude each threshold is lower by some hundreds of kelvin.

### Mach number independence

As Mach number grows, the shock relations of section 4 approach limits in which Mach number no longer appears. Pressure coefficient, lift and drag coefficients and the shape of the shock all freeze. For blunt bodies the limit is reached by about Mach 4 to 5, for slender ones later. This is why one set of coefficients serves a capsule from Mach 25 down to Mach 5.

### Newtonian theory

Newton imagined a stream of particles that lose their momentum normal to a surface and keep the tangential part. That is wrong for ordinary flow and nearly right for a thin hypersonic shock layer. The pressure coefficient on a surface inclined at angle theta to the stream is

```math
C_p = C_{p,\max} \sin^2 \theta \quad (\text{windward}), \qquad C_p = 0 \quad (\text{in shadow})
```

Newton's own value is C\_p,max = 2. Lees' modified form uses the true pressure at the stagnation point behind a normal shock:

```math
C_{p,\max} = \frac{2}{\gamma \mathrm{Ma}^2} \left\{ \left[ \frac{(\gamma + 1)^2 \mathrm{Ma}^2}{4 \gamma \mathrm{Ma}^2 - 2(\gamma - 1)} \right]^{\gamma/(\gamma - 1)} \frac{1 - \gamma + 2 \gamma \mathrm{Ma}^2}{\gamma + 1} - 1 \right\}
```

For gamma = 1.4 this gives 1.657 at Mach 2, 1.756 at Mach 3, 1.809 at Mach 5, 1.832 at Mach 10 and 1.839 in the limit. Integrating over a shape gives closed-form coefficients:

| Shape | Newtonian result | Value with C\_p,max = 1.839 |
| --- | --- | --- |
| Flat face normal to the stream | C\_D = C\_p,max | 1.84 (measured about 1.7) |
| Sphere | C\_D = C\_p,max / 2 | 0.92 |
| Cylinder across the stream | C\_D = (2/3) C\_p,max | 1.23 |
| Cone of half-angle theta\_c, nose first | C\_D = C\_p,max sin^2(theta\_c) | 0.055 at 10 degrees |
| Flat plate at angle of attack alpha | C\_N = C\_p,max sin^2(alpha), L/D = cot(alpha) | L/D = 1.19 at 40 degrees |

Two features of these results are opposite to subsonic experience. Lift grows as the square of the angle of attack, not linearly, so a thin wing gives little lift until it is steeply inclined. And any surface in the body's shadow feels nothing at all, so a fin or flap on the lee side is dead.

### What real-gas chemistry changes in the forces

Dissociation lowers the effective gamma from 1.4 toward 1.1 to 1.2. The density ratio across the shock rises from 6 to between 10 and 20, the shock layer thins, and C\_p,max moves toward 2. The effect on drag is a few per cent. The effect on pitching moment can be larger: on the first Space Shuttle entry the body flap had to deflect about twice the predicted angle to hold trim, an error traced to real-gas effects that perfect-gas wind tunnels had not reproduced. At Verda's entry speeds gamma stays close to 1.4 and none of this applies.

## 6. Blunt bodies and capsule lift

A capsule has no wings, yet it flies: the pressure on a blunt heat shield acts almost along the capsule's own axis, so tilting the axis away from the direction of travel tilts the force, and the sideways part of that force is lift. Every crewed capsule since Gemini has used this to steer.

### Force on a tilted blunt face

Take the angle of attack alpha as the angle between the capsule's axis and its velocity, zero when the heat shield meets the air squarely. For a flat face, Newtonian theory gives a pure pressure force along the axis:

```math
C_A = C_{p,\max} \cos^2 \alpha, \qquad C_D = C_{p,\max} \cos^3 \alpha, \qquad C_L = C_{p,\max} \cos^2 \alpha \, \sin \alpha, \qquad \frac{L}{D} = \tan \alpha
```

The lift points to the side the apex (the small end) is tilted toward. Tilt the apex up and the capsule is pushed up.

A real shield is a spherical segment. For a cap of half-angle phi (the angle its rim subtends at the centre of curvature), integrating the Newtonian pressure gives axial and normal coefficients, valid while the whole cap faces the stream (alpha below 90 degrees minus phi):

```math
C_A = C_{p,\max} \left[ \cos^2 \alpha \, \frac{1 + \cos^2 \phi}{2} + \sin^2 \alpha \, \frac{\sin^2 \phi}{4} \right], \qquad C_N = C_{p,\max} \, \frac{\sin^2 \phi}{2} \, \sin \alpha \cos \alpha
```

The normal force swings the resultant back toward the velocity by a small angle epsilon, so

```math
\tan \varepsilon = \frac{C_N}{C_A}, \qquad \frac{L}{D} = \tan(\alpha - \varepsilon)
```

The limits check. A flat face (phi = 0) recovers tan(alpha). A hemisphere at zero angle gives C\_A = C\_p,max / 2, the sphere's drag. I derived these two expressions for this document and confirmed them by integrating the Newtonian pressure numerically over the cap; they agree to four figures at five combinations of alpha and phi.

> Worked example. Apollo's shield had a radius of curvature of 4.69 m and a base radius of 1.96 m, so phi = 24.6 degrees. At alpha = 20 degrees the formulas give C\_A = 1.49, C\_N = 0.051, epsilon = 2.0 degrees and L/D = 0.33. Flight values were about 0.30. Newtonian theory overstates it slightly, as expected.

### Trim: how the angle is set

Every pressure force on a spherical surface points through the sphere's centre of curvature, so the resultant does too. The capsule is in moment balance when that line also passes through the centre of mass. With the centre of mass a distance x\_cg behind the shield's apex and y\_cg off the axis, and R the radius of curvature:

```math
\tan \varepsilon(\alpha_{trim}) = \frac{y_{cg}}{R - x_{cg}}
```

A capsule with its centre of mass on the axis trims at zero and flies a ballistic path. Move the centre of mass a few per cent of the diameter sideways and it trims at 15 to 25 degrees. For Apollo the numbers above give an offset of about 0.13 m, close to the roughly five inches the real vehicle carried (approximate). The trim is stable whenever the centre of mass is ahead of the centre of curvature, which it always is.

The angle of attack is therefore fixed by how the capsule was loaded. The crew cannot change it in flight. What they can change is which way the lift points.

### Steering by bank

Rolling the capsule about its velocity vector by a bank angle sigma rotates the lift vector around the direction of flight:

```math
L_{vertical} = L \cos \sigma, \qquad L_{lateral} = L \sin \sigma
```

Lift up (sigma = 0) stretches the entry, lowers peak g and extends range. Lift down (sigma = 180 degrees) steepens it and shortens range. A bank to one side turns the ground track, and the guidance reverses the bank from side to side to cancel the turn while holding the vertical component it wants. Rolling continuously averages the lift to zero and gives a ballistic entry, which is Soyuz's backup mode.

| Vehicle | Hypersonic L/D | Trim angle | Notes |
| --- | --- | --- | --- |
| Mercury | 0 | 0 | Ballistic, about 8 g from orbit |
| Gemini | about 0.2 | small | First capsule to steer by roll |
| Soyuz | about 0.3 | about 20 degrees | About 4 g nominal, 8 to 9 g ballistic |
| Apollo | about 0.3 | about 20 degrees | About 6 to 7 g from the Moon |
| Mars Science Laboratory | 0.24 | 16 degrees | Guided entry at Mars |
| Space Shuttle | about 1.0 | 40 degrees | Wings; about 1.5 g; cross-range near 2,000 km |

Values are approximate, from memory of the standard references.

### Stability

A blunt capsule is statically stable heat shield first when its centre of mass is close to the shield, which is why capsules carry their heavy equipment low. Dynamic stability is weaker. In the low supersonic and transonic range most capsules oscillate with growing amplitude, and a drogue parachute is deployed near Mach 1.5 to 0.7 to hold them steady.

## 7. Entry trajectory mechanics

An entry is a trade between three things that cannot all be small at once: peak deceleration, peak heating rate and total heat absorbed. The entry angle sets the trade, and lift widens the range of angles that work.

### Equations of motion

For flight in a vertical plane over a spherical, non-rotating planet, with speed v, flight-path angle gamma (positive above the horizon), radius r and bank angle sigma:

```math
\frac{dv}{dt} = -\frac{D}{m} - g \sin \gamma, \qquad v \frac{d\gamma}{dt} = \frac{L \cos \sigma}{m} - \left( g - \frac{v^2}{r} \right) \cos \gamma, \qquad \frac{dh}{dt} = v \sin \gamma
```

The term v^2/r is the centrifugal relief: at orbital speed it cancels gravity. Drag is written with the ballistic coefficient beta, the mass carried per unit of drag area:

```math
\frac{D}{m} = \frac{\rho v^2}{2 \beta}, \qquad \beta = \frac{m}{C_D S}
```

A heavy, slender body (high beta) penetrates deep before it slows. A light, blunt one (low beta) slows high up in thin air.

### Steep ballistic entry: Allen and Eggers

If the entry is steep enough that gravity and the planet's curvature can be ignored during the short deceleration, the path is a straight line at the entry angle gamma\_E, and the speed follows from the density alone:

```math
v = v_E \exp \left( -\frac{\rho H}{2 \beta \sin \gamma_E} \right)
```

Differentiating gives the deceleration and its maximum:

```math
a_{\max} = \frac{v_E^2 \sin \gamma_E}{2 e H} \quad \text{at} \quad \rho = \frac{\beta \sin \gamma_E}{H}, \quad v = e^{-1/2} v_E = 0.607 \, v_E
```

Peak deceleration does not depend on the vehicle at all. Mass and shape decide only the altitude at which it happens. With a heating rate that goes as sqrt(rho) v^3 (section 8) the same solution gives peak heating earlier and higher:

```math
\dot{q}_{\max} = k \, v_E^3 \sqrt{\frac{\beta \sin \gamma_E}{3 e H R_n}} \quad \text{at} \quad \rho = \frac{\beta \sin \gamma_E}{3 H}, \quad v = e^{-1/6} v_E = 0.846 \, v_E
```

and the heat absorbed per unit area at the stagnation point over the whole entry:

```math
Q = k \, v_E^2 \sqrt{\frac{\pi \beta H}{R_n \sin \gamma_E}}
```

Read the three together. A steeper entry raises peak g in proportion to sin(gamma) and peak heating as its square root, but lowers the total heat as one over its square root, because the heating is over sooner. A blunter nose (larger R\_n) lowers both heating numbers. That is Allen's blunt-body principle, and it is why capsules are blunt.

### Shallow entry from orbit: Chapman

Allen and Eggers fails for a shallow entry from orbit, where gravity and curvature steer the path. Chapman's analysis covers that case. For a ballistic vehicle spiralling in from a decaying circular orbit of radius r, the peak deceleration is

```math
a_{\max} \approx 0.277 \, g \sqrt{\frac{r}{H}} \quad \text{at} \quad v \approx 0.43 \, v_c
```

again independent of the vehicle. For Earth sqrt(r/H) is about 30 and the result is 8.3 g, which is what Mercury capsules felt. Peak heating comes at about 0.80 of orbital speed.

I integrated the equations of motion above numerically to test both results. For Earth the integration gives 8.2 g at 0.43 of orbital speed for ballistic coefficients of 100, 300 and 1,000 kg/m2. For Verda, with r = 640 km and H = 5.8 km:

| Verda, entry from 72 km at orbital speed 2,350 m/s | Peak deceleration | At speed | Peak heating at speed |
| --- | --- | --- | --- |
| Chapman's formula | 27.9 m/s2 (2.84 g) | 0.43 v\_c | 0.80 v\_c |
| Integration, entry angle 0.05 to 3 degrees, beta 100 to 1,000 | 26.5 to 27.7 m/s2 | 0.42 to 0.43 v\_c | 0.78 to 0.82 v\_c |
| Allen-Eggers at 1.5 degrees (not valid this shallow) | 4.6 m/s2 | 0.61 v\_E | 0.85 v\_E |

So a return from low Verda orbit peaks near 2.8 g whatever the capsule, and the Allen-Eggers formula should be used only for steep entries. The numbers 0.607 and 0.846 belong to steep entries and 0.43 and 0.80 to shallow ones.

### Lifting entry

With lift held upward the vehicle can settle into an equilibrium glide, where lift plus centrifugal relief carries the weight and the path angle stays small. Setting d(gamma)/dt = 0 gives the deceleration along the glide:

```math
\frac{a}{g} = \frac{1 - v^2 / v_c^2}{L/D}
```

Deceleration grows as the vehicle slows and approaches g divided by L/D. Even a modest L/D helps greatly. In the integration for Verda at beta = 300 and an entry angle of 1.5 degrees, peak deceleration is 2.75 g ballistic, 1.55 g with L/D = 0.3 held lift up, and 4.5 g with the same lift held down. Peak stagnation heating changes from 52 kW/m2 to 42 and 64 (for a 1 m nose radius). The range covered in an equilibrium glide is approximately

```math
s \approx \frac{r}{2} \, \frac{L}{D} \, \ln \frac{1}{1 - v_E^2 / v_c^2}
```

### The entry corridor

Arriving faster than orbital speed, the vehicle must lose enough energy on the first pass to be captured. Too shallow and it leaves the atmosphere again (the overshoot boundary). Too steep and the g load or heating exceeds limits (the undershoot boundary). The band of entry angles between is the corridor. Apollo's was about 5.3 to 7.7 degrees below the horizon at 122 km, with 6.5 degrees the target (approximate). Lift widens it: lift down holds a shallow entry in, lift up softens a steep one.

Verda's corridor is at much steeper angles, because the planet is small compared with its atmosphere (r/H is 110, against 900 for Earth) and a pass through the air is short. From the same integration, for a return from Pell at 3,300 m/s at the 72 km interface with beta = 300:

| Entry angle (degrees) | Ballistic | L/D 0.3, lift up | L/D 0.3, lift down |
| --- | --- | --- | --- |
| 10 | Passes through and leaves | Leaves | Leaves |
| 11 | Leaves, slowed to 2,615 m/s | Leaves | Captured, 4.5 g |
| 12 | Captured, 2.3 g | Leaves | Captured, 5.8 g |
| 14 | Captured, 4.3 g | Captured, 2.6 g | Captured, 8.0 g |
| 18 | Captured, 8.3 g | Captured, 6.0 g | Captured, 11.6 g |

These figures use the game's density law and no rotation. They are estimates of what the finished model should show, and they are the reference a verification run would be compared against.

## 8. Aerodynamic heating

A vehicle in orbit carries far more kinetic energy than it would take to vaporise it, and it survives entry because nearly all of that energy is left in the air and only a small fraction reaches the skin. How small that fraction is depends on shape, and the shape that minimises it is blunt.

### Where the energy goes

Allen's argument: the vehicle's kinetic energy is removed by drag, and heat enters through skin friction, so the fraction of the energy that ends up in the vehicle is about

```math
\frac{Q_{body}}{\tfrac{1}{2} m v_E^2} \approx \frac{1}{2} \, \frac{C_f}{C_D}
```

with C\_f an average skin-friction coefficient. A slender body has low drag, mostly friction, and takes up to half the energy. A blunt body has high pressure drag that heats the air through a strong shock standing off the surface, and takes of the order of 1 %.

### Stagnation-point convective heating

Fay and Riddell solved the boundary-layer equations at the stagnation point of a blunt body in dissociated air:

```math
\dot{q}_w = 0.763 \, \mathrm{Pr}^{-0.6} (\rho_e \mu_e)^{0.4} (\rho_w \mu_w)^{0.1} \sqrt{\frac{du_e}{dx}} \, (h_{0} - h_w) \left[ 1 + (\mathrm{Le}^{0.52} - 1) \frac{h_D}{h_0} \right]
```

Subscripts e and w are the boundary-layer edge and the wall, Pr and Le the Prandtl and Lewis numbers, h\_D the energy held in dissociation. The velocity gradient is where the nose radius enters. From Newtonian pressure,

```math
\frac{du_e}{dx} = \frac{1}{R_n} \sqrt{\frac{2 (p_e - p_\infty)}{\rho_e}}
```

so heating goes as one over the square root of the nose radius. Sutton and Graves reduced the full calculation to an engineering correlation for any gas mixture:

```math
\dot{q}_s = k \sqrt{\frac{\rho}{R_n}} \, v^3
```

In SI units k = 1.7415e-4 for air and 1.9027e-4 for a carbon dioxide atmosphere, with the flux in W/m2. The formula is for a cold wall; a hot wall receives less by the factor (1 - h\_w/h\_0). An older correlation of the same family is Detra, Kemp and Riddell's, with speed to the power 3.15.

> Worked example. A capsule with a 1 m nose radius at 1,990 m/s where the density is 1.8e-3 kg/m3 (38 km on Verda): flux = 1.7415e-4 x sqrt(1.8e-3) x 1990^3 = 58 kW/m2. The same capsule at 7 km/s at Earth's 60 km (3.1e-4 kg/m3) receives 1.05 MW/m2, eighteen times more.

### Around the body

Heating is highest at the stagnation point and falls away from it. On a hemisphere in laminar flow Lees' solution falls roughly as the cosine of the angle from the stagnation point to the power 1.5: about 0.6 of the peak at 45 degrees and under 0.1 at 90 degrees. On a capsule at an angle of attack the stagnation point moves toward the windward shoulder, and the small radius of the shoulder can make it the hottest place on the shield. Surfaces in the wake receive a few per cent of the stagnation value.

| Surface | Scaling relative to a sphere of radius R at the same conditions |
| --- | --- |
| Stagnation point, sphere radius r | sqrt(R / r) |
| Leading edge, cylinder radius r, swept by angle Lambda | about sqrt(R / 2r) x cos(Lambda)^1.2 to 1.5 |
| Flat surface inclined to the flow, laminar | rho^0.5 v^3.2 x^-0.5, falling with distance x from the leading edge |
| Flat surface, turbulent | rho^0.8 v^3.4 x^-0.2, several times the laminar value low in the atmosphere |
| Lee side and wake | 1 to 5 % of stagnation |

The first row is the important one for a parts-based game. An antenna or a fin edge with a 2 cm radius that sees the free stream is heated nearly seven times as hard as a 0.9 m capsule nose. Small things burn off first.

Where one body's shock strikes another body, heating is amplified locally by up to an order of magnitude (Edney's shock-interaction patterns). The best-known case is the X-15 flight of October 1967 that carried a dummy ramjet: the shock from the ramjet burned through its own pylon.

### Radiative heating

Above about 10 km/s in air the shock layer is hot enough to radiate, and the radiation reaches the body. Tauber and Sutton's correlation has the form

```math
\dot{q}_{rad} = C \, R_n^{\,a} \, \rho^{\,b} \, f(v)
```

with b = 1.22 for Earth and f(v) a steeply rising tabulated function. Radiative heating grows with nose radius, the opposite of convective heating, so very fast entries favour a smaller nose than slow ones. It was roughly a third of Apollo's peak heating at lunar-return speed and nearly all of the Galileo probe's at Jupiter (approximate). At Verda's speeds it is zero for practical purposes. At Thal and Orrin it is real.

### Peak rate and total load are different threats

Peak heat flux sets the surface temperature and decides which material survives. Total heat load, the time integral, sets how much material is needed. A steep entry is high rate and low load. A shallow lifting entry is low rate and high load, which is why the Shuttle, with its long glide, needed insulation over its whole underside but never saw Apollo's peak flux.

## 9. Plasma

The glowing sheath of re-entry is air heated past the point where its atoms lose electrons, and it exists only when the energy per kilogram is high enough; below about 4 to 5 km/s in air there is essentially none.

### How the gas ionises

Behind the bow shock the energy of section 5 is shared among the gas's modes in order of cost. Molecules vibrate, then break apart, then ionise. At orbital entry speeds the first electrons come from a reaction that needs only 2.8 eV, far less than stripping an atom directly:

```math
\mathrm{N} + \mathrm{O} \rightarrow \mathrm{NO}^+ + e^-
```

At lunar-return speeds and above, atoms ionise directly (14.5 eV for nitrogen, 13.6 eV for oxygen). In equilibrium the degree of ionisation of each species follows the Saha equation:

```math
\frac{n_e \, n_i}{n_n} = \frac{2 g_i}{g_n} \left( \frac{2 \pi m_e k T}{h^2} \right)^{3/2} \exp \left( -\frac{E_i}{k T} \right)
```

Here n\_e, n\_i and n\_n are the number densities of electrons, ions and neutrals, g the statistical weights and E\_i the ionisation energy. The exponential makes ionisation a threshold effect: nothing, then a great deal, over a narrow range of temperature. In practice the gas behind a fast shock is often not in equilibrium, and the electron density is computed from reaction rates, but Saha gives the scale.

### Why radio stops

Free electrons respond to a radio wave and re-radiate it. The gas has a natural frequency of electron oscillation, the plasma frequency:

```math
\omega_p = \sqrt{\frac{n_e e^2}{\varepsilon_0 m_e}}, \qquad f_p \approx 8.98 \sqrt{n_e} \ \mathrm{Hz} \quad (n_e \ \text{in m}^{-3})
```

A signal below the plasma frequency cannot propagate through the sheath; it is reflected and absorbed. Blackout begins when the electron density around the antenna passes the critical value for the link's frequency.

| Link | Frequency | Critical electron density (per m3) |
| --- | --- | --- |
| UHF | 400 MHz | 2.0e15 |
| GPS L1 | 1.575 GHz | 3.1e16 |
| S-band (Apollo) | 2.29 GHz | 6.5e16 |
| X-band | 8.4 GHz | 8.8e17 |

Higher frequencies get through more plasma, which is one of the standard remedies. Others are placing the antenna on the lee side where the sheath is thin, and relaying upward through the wake: the Shuttle had long blackouts until it began transmitting up to relay satellites through the hole in its wake.

| Entry | Speed (km/s) | Blackout |
| --- | --- | --- |
| Mercury and Gemini, from orbit | 7.8 | about 4 minutes |
| Apollo, lunar return | 11.0 | about 3 minutes |
| Shuttle before relay satellites | 7.8 | up to about 16 minutes |
| Mars Pathfinder | 7.5 | about 30 seconds |

Durations are approximate. NASA's RAM flight experiments of the 1960s measured electron densities directly on a blunt body at 7.6 km/s and are the reference data set.

### The glow

The light is emission from excited molecules and atoms in the shock layer (nitrogen bands in the violet and near ultraviolet, atomic oxygen and nitrogen lines in the red and infrared), plus products of the ablating shield. Its brightness rises very steeply with speed, tracking the radiative heating of section 8.

### What applies to Starwright

| Case | h0 (MJ/kg) | Perfect-gas stagnation temperature | Real physics |
| --- | --- | --- | --- |
| Verda from low orbit, 2.35 km/s | 2.8 | about 2,900 K | No plasma. A real vehicle would show a faint glow at most. |
| Verda from Pell, 3.3 km/s | 5.5 | about 5,600 K (real value lower) | Dissociated oxygen, trace electrons, no blackout. |
| Thal or Orrin from orbit, 5.4 to 6.4 km/s | 14 to 21 | well above ionisation thresholds | A true plasma sheath and blackout. |
| Thal from interplanetary space, 9 km/s or more | 41 or more | far above | Strong ionisation and radiative heating. |

So an honest model has two choices for the home world: show no plasma on Verda, or show one and say plainly that it is a visual convention borrowed from full-scale worlds. The specification puts that choice to you.

## 10. Thermal protection

There are three ways to deal with the heat that reaches the skin: radiate it away, soak it up, or let it carry material off. Which one works is decided by the peak flux and the total load of section 8.

### Radiate it: equilibrium temperature

A surface that conducts nothing inward settles at the temperature where it radiates what it receives:

```math
\varepsilon \sigma T_w^4 = \dot{q} \quad \Rightarrow \quad T_w = \left( \frac{\dot{q}}{\varepsilon \sigma} \right)^{1/4}
```

with sigma = 5.670e-8 W/(m2 K4) and epsilon the emissivity (0.8 to 0.9 for dark, oxidised or coated surfaces). The fourth root is forgiving: sixteen times the flux doubles the temperature.

| Heat flux | Equilibrium temperature (emissivity 0.85) | What survives |
| --- | --- | --- |
| 50 kW/m2 | 1,010 K | Steel, titanium and nickel alloys |
| 150 kW/m2 | 1,330 K | Nickel superalloys at their limit; ceramic tiles |
| 500 kW/m2 | 1,800 K | Shuttle tile limit is about 1,530 K, carbon-carbon about 1,920 K |
| 5 MW/m2 | 3,190 K | Nothing reusable. Ablators only. |

Every Verda entry in section 7 falls in the first three rows. On real numbers, a return from low Verda orbit could be flown on bare metal.

### Soak it up: heat sink

A mass of material with areal density rho times thickness delta and specific heat c warms by

```math
\Delta T = \frac{Q}{\rho \, c \, \delta}
```

for a heat load Q per unit area. This works for short, modest loads (the first Mercury suborbital flights used a beryllium heat sink) and becomes too heavy for orbital entry.

### Carry it off: ablation

An ablator chars, melts or vaporises, and the gases it gives off thicken the boundary layer and block part of the incoming convective heat. The recession is described by an effective heat of ablation Q\*, the energy disposed of per kilogram of material lost:

```math
\dot{m} = \frac{\dot{q}}{Q^*}, \qquad Q^* \approx h_v + \eta \, (h_0 - h_w)
```

with h\_v the heat needed to decompose and vaporise the material, and eta a blowing factor of about 0.4 to 0.7. Q\* is of the order of 10 to 30 MJ/kg for charring ablators and rises with the enthalpy of the flow, so ablators become more efficient as the entry becomes more severe (approximate). Under the ablating surface the bondline temperature is held down by the low conductivity of the char and virgin material, and that, not the surface temperature, is what protects the structure.

The mass of ablator a real shield loses is small: of the order of a kilogram per square metre for an orbital entry. The shield is thick because of insulation and margin, not because most of it burns away.

## 11. Effects of Mach number on parts

Mach number changes what each part of a vehicle feels in five ways: how hot it gets, how hard it is pressed, where the force acts, whether its controls still work, and whether it is in clean air at all.

### Temperature

Air brought to rest in a boundary layer recovers most of its stagnation temperature. The adiabatic wall (recovery) temperature is

```math
T_r = T \left( 1 + r \, \frac{\gamma - 1}{2} \mathrm{Ma}^2 \right), \qquad r = \mathrm{Pr}^{1/2} \approx 0.85 \ \text{(laminar)}, \quad \mathrm{Pr}^{1/3} \approx 0.89 \ \text{(turbulent)}
```

| Mach number | Recovery temperature in 217 K air (turbulent) | Consequence |
| --- | --- | --- |
| 1 | 256 K | None |
| 2 | 372 K | Aluminium's practical limit (Concorde's nose ran near 400 K) |
| 3 | 565 K | Titanium or steel (the SR-71 flew here) |
| 5 | 1,180 K | Superalloys; sustained flight needs active cooling |
| 8 | 2,690 K | No structural metal. Exposure must be brief or protected. |

This is the temperature a thin skin drifts toward in sustained flight. In a short entry the skin does not reach it, and the flux of section 8 is the better measure.

### Pressure

The highest pressure anywhere on a body is at a stagnation point: C\_p,max times q, about 1.8 q above Mach 3 (section 5). Surfaces that face the stream squarely, such as an open air brake, a deployed leg or a solar panel, carry that full pressure. Surfaces at an angle carry the sine-squared fraction of it. Chapter 12 of the game's built-in science reference already treats these as air ratings.

### Where the force acts

The centre of pressure of a wing or fin moves from about 25 % of the chord in subsonic flow to about 50 % in supersonic flow. For an aircraft that is a nose-down trim change through the transonic range. For a finned rocket there is a second effect. A fin's lift-curve slope falls as 4/sqrt(Ma^2 - 1) (section 4), while the destabilising lift of the nose stays roughly constant at about 2 per radian referred to the body's cross-section (slender-body theory). So a rocket's static margin shrinks as Mach number rises. A design that is comfortably stable at Mach 1.5 can be marginal at Mach 4.

### Controls

| Speed range | What happens to a control surface |
| --- | --- |
| Transonic | Shocks on the surface move with deflection. Effectiveness drops, hinge moments jump, and the surface can buzz. |
| Supersonic | A trailing-edge flap cannot influence the flow ahead of it, so it changes less lift than in subsonic flight. All-moving surfaces replace flaps. |
| Hypersonic | Force depends on the angle to the stream (Newtonian). A surface in the body's shadow does nothing. Windward flaps work well. |

The Shuttle's rudder sat in the shadow of the wing and body at its 40 degree entry attitude and was not used in the hypersonic part of entry; yaw came from reaction jets.

Grid fins behave differently from flat fins. Each cell of the lattice is a small duct. Around Mach 1 the flow in the cells chokes: a shock stands ahead of the lattice, drag jumps and control power dips. Roughly between Mach 0.8 and 1.3 a grid fin is at its worst. Below and above that band it is effective, with small hinge moments because its chord is short. That is why grid fins suit a booster that must be controlled from Mach 5 down through landing, and why the transonic passage is the phase to watch.

### Clean air, wake and shielding

In supersonic flow a disturbance cannot travel upstream, so a part affects only what lies inside the Mach cone behind it, and a part behind a larger body lives in that body's wake.

The base of a body feels a suction that subsonically is a steady fraction of dynamic pressure. Supersonically the suction cannot exceed a vacuum, which bounds the base pressure coefficient:

```math
C_{p,base} \ge -\frac{2}{\gamma \mathrm{Ma}^2}, \qquad \text{typically} \quad C_{p,base} \approx -\frac{1}{\mathrm{Ma}^2}
```

So the base suction is about 0.25 q at Mach 2 and 0.03 q by Mach 6, against a forebody drag coefficient near 1.5 for a blunt body. Base drag fades away in exactly the regime of entry.

Behind a blunt heat shield the flow separates at the shoulder and closes to a narrow neck one to two diameters downstream. Inside that region dynamic pressure and heating are a few per cent of the free-stream values. A part mounted behind the shield and inside its shadow is protected. A part that reaches out past the shadow meets the full stream, at a small radius, and by section 8 is heated harder than the shield itself. Tilting the capsule to fly at an angle of attack exposes one side of the afterbody.

Where a shock from one part falls on another (a strut ahead of a tank, a side booster's nose shock on the core) both pressure and heating rise locally. This is a real cause of damage and beyond what a real-time game can resolve; it is listed as left out.

### Other Mach effects worth knowing

- **Buffet and acoustic load** peak in the transonic range near max Q. Fairings and protruding parts take their worst vibration there.
- **Parachutes** inflate unreliably above about Mach 2; supersonic chutes for Mars are qualified near Mach 2.2 (approximate).
- **Engines pointed into the stream**, as on a booster entering tail first, are shielded by their own exhaust while they fire. An entry burn reduces both speed and the heating that follows, as the game's booster guidance already assumes.

## 12. Results to check a model against

A model of this physics can be tested against exact formulas first, then against an independent numerical integration, and only then compared with flight data, which carries its own uncertainty.

### Closed-form values

| Quantity | Formula | Check value |
| --- | --- | --- |
| Sound speed in air at 288.15 K | sqrt(gamma R T / M) | 340.3 m/s |
| Layered atmosphere | Hydrostatic integral of section 2 | U.S. Standard Atmosphere 1976 tables |
| Stagnation temperature ratio at Mach 2 | 1 + 0.2 Ma^2 | 1.800 |
| Normal shock at Mach 3 | Section 4 | p2/p1 = 10.33, rho2/rho1 = 3.857 |
| Stagnation pressure coefficient | Rayleigh pitot formula, section 5 | 1.657 at Mach 2, 1.809 at Mach 5, 1.839 in the limit |
| Sphere drag, hypersonic | C\_p,max / 2 | 0.92 |
| Flat plate, supersonic | 4 alpha / sqrt(Ma^2 - 1) | Slope 2.309 per radian at Mach 2 |
| Flat face at angle alpha, hypersonic | L/D = tan(alpha) | 0.364 at 20 degrees |
| Spherical cap, phi = 24.6 degrees, alpha = 20 degrees | Section 6 | C\_A = 1.4925, C\_N = 0.0512, L/D = 0.326 |
| Trim of a spherical-segment capsule | tan(epsilon) = y\_cg / (R - x\_cg) | Offset ratio 0.0343 for the case above |
| Steep ballistic entry | Allen-Eggers | Peak g at 0.607 v\_E, peak heating at 0.846 v\_E, a\_max = v\_E^2 sin(gamma) / (2 e H) |
| Shallow ballistic entry from orbit | Chapman | 0.277 g sqrt(r/H) at 0.43 v\_c; 27.9 m/s2 on Verda |
| Equilibrium glide | a/g = (1 - v^2/v\_c^2) / (L/D) | Approaches 3.3 g for L/D 0.3 |
| Stagnation heating | Sutton-Graves | k = 1.7415e-4 in air; flux scales as R\_n^-0.5 |
| Total stagnation heat load, steep entry | k v\_E^2 sqrt(pi beta H / (R\_n sin(gamma))) | Follows from Allen-Eggers |
| Radiative equilibrium | (q / (epsilon sigma))^0.25 | 1,009 K at 50 kW/m2, emissivity 0.85 |
| Critical electron density | (f / 8.98)^2 | 6.5e16 per m3 at 2.29 GHz |

### Flight data

| Flight | Conditions | Result | Use |
| --- | --- | --- | --- |
| Mercury orbital flights | 7.8 km/s, ballistic, about 1.5 degrees | About 8 g | Chapman's ballistic result |
| Apollo lunar returns | 11.0 km/s, 6.5 degrees at 122 km, L/D about 0.3 | About 6 to 7 g, range about 2,000 to 2,500 km | Lifting entry and corridor |
| Apollo 4 | Flight-derived aerodynamics | Trim angle about 1.5 degrees lower and L/D about 10 % higher than the wind tunnel | How well L/D can be predicted |
| Soyuz | 7.8 km/s, L/D about 0.3 | About 4 g guided, 8 to 9 g ballistic | The value of lift |
| Space Shuttle | Angle of attack 40 degrees | L/D about 1, about 1.5 g | Winged entry; STS-1 trim anomaly |
| RAM C flights | 7.6 km/s blunt cone | Measured electron density through blackout | Plasma |

All flight figures are approximate and from memory, except the Apollo 4 comparison, which is quoted from the abstract of the NASA report in the sources. They should be read from the linked reports before any is used as a test value. The specification relies on the closed forms and an independent integrator for its pass and fail checks, and uses flight data only as a sanity comparison.

## 13. Today's game measured against this science

The game's drag and heating laws have the right form, and its entries already put peak heating before peak g as they should; the gaps are in what the laws depend on. Everything below was read from the code on `main` (commit ec6ab6a, mostly `js/core/vessel.js` and `js/core/bodies.js`) or measured by running that code.

| Subject | What the game does today | What the science says | Size of the gap |
| --- | --- | --- | --- |
| Density | rho0 exp(-h/H), one scale height per world, cut to zero at a fixed top | Correct for an isothermal atmosphere | Small on Verda. On Rusk and Marn the density at the cut-off is still a thousandth of the surface value, so the air switches on with a jolt. |
| Pressure | Scaled from density | Hydrostatic: rho0 g H at the surface | Verda's surface pressure is 67.9 kPa by its own density law, labelled as one atmosphere. |
| Temperature | None. A fixed ambient of 290 K is used for part temperatures. | Fixed by the scale height: T = M g H / R | Verda's scale height implies 194 K for air. |
| Sound speed | 320 m/s on every world at every height | sqrt(gamma R T / M), which for an isothermal layer equals sqrt(gamma g H) | See the next table. |
| Transonic drag | One multiplier for every part: 1 below Mach 0.7, 2.0 at Mach 1.1, 1.5 above Mach 2.5 | Blunt bodies keep a high coefficient; slender ones fall well below their peak | Slender rockets carry about half again too much drag above Mach 2.5. |
| Base drag | Lee-side faces add a constant 25 % of their drag area at all speeds | Fades as 1/Ma^2 above Mach 1 | Overstated in the hypersonic range. |
| Capsule lift | None by design; capsules trim at zero angle | L/D about 0.3 at a 20 degree trim set by an offset centre of mass | See the measurement below. |
| Wing and fin lift | Constant lift-curve slope (3.6 per radian for wings, 1.6 for fins) at every Mach number | Slope falls as 4/sqrt(Ma^2 - 1), then Newtonian | At Mach 3 a wing gives about 2.5 times the lift it should. |
| Grid fins | The Lattice Vane is an ordinary control fin with a higher temperature limit | Transonic choking, low hinge moment, high drag | No difference in behaviour from a flat fin. |
| Heating rate | 1.83e-4 sqrt(rho) v^3 for every part | Sutton-Graves: 1.7415e-4 sqrt(rho / R\_n) v^3 | The game's constant equals Sutton-Graves at a nose radius of 0.91 m. Size and shape of the part do not enter. |
| Exposure | Stack faces by uncovered area; flanks 0.35 at 90 degrees; every radial part 0.6 wherever it is mounted | Shadowed parts receive a few per cent; exposed small parts receive more than the nose | A part hidden behind the shield and a part out in the stream are heated the same. |
| Skin temperature | 290 K + 0.30 (flux x exposure)^0.75, approached with a 22 s lag | Radiative equilibrium goes as flux^0.25 | A 2,000 K part fails at about 100 kW/m2 in the game. Its radiative equilibrium limit would be about 770 kW/m2. The game is roughly eight times harsher, which is what makes a 2.35 km/s entry dangerous at all. |
| Ablation | 6e-6 kg of ablator per J/m2 of heat load, whatever the shield's size | Mass loss per area = flux / Q\*, with Q\* of 10 to 30 MJ/kg | The game's equivalent Q\* is 0.22 MJ/kg on the M shield and 2.0 MJ/kg on the largest. A large shield loses a smaller fraction than a small one for the same heating. |
| Plasma | A visual glow and sound driven by heating. No effect on radio. | No real plasma below about 4 to 5 km/s | The glow on Verda is a convention. |
| Wind | None. The air turns with the planet, correctly. | Winds aloft, shear near max Q | Not modelled. |
| Map prediction | The predicted path stops at the top of the atmosphere | Aerobraking passes and landing points can be integrated | A player cannot plan an aerobrake on the map. |

### Sound speed consistent with each world's own density law

Because a^2 = gamma R T / M and H = R T / (M g), an isothermal atmosphere has a = sqrt(gamma g H). The molar mass cancels, so only gamma needs to be chosen for each world.

| World | g (m/s2) | H (km) | Assumed gas, gamma | Consistent sound speed (m/s) | Mach number at orbital entry: consistent / today |
| --- | --- | --- | --- | --- | --- |
| Verda | 9.6 | 5.8 | Air, 1.40 | 279 | 8.4 / 7.3 |
| Murk | 8.4 | 6.5 | Carbon dioxide, 1.29 | 265 | 7.3 / 6.1 |
| Rusk | 3.2 | 6.5 | Carbon dioxide, 1.29 | 164 | 6.2 / 3.2 |
| Marn | 2.9 | 5.2 | Air, 1.40 | 145 | 6.2 / 2.8 |
| Thal | 8.5 | 40 | Hydrogen and helium, 1.45 | 702 | 9.1 / 20 |
| Orrin | 7.2 | 36 | Hydrogen and helium, 1.45 | 613 | 8.7 / 17 |

The gas assigned to each world is my assumption from its description in the game, and is an open question in the specification. On Rusk and Marn the instruments read about half the true Mach number. On the gas giants they read double.

### Measurement: the game already produces capsule lift

The documentation says capsules have no lift. That is true of a capsule left alone, because it trims at zero angle. But the per-part drag model applies a face force along the capsule's axis and a smaller flank force across it, and the two do not line up with the velocity when the capsule is tilted. I placed an Acorn capsule at 35 km over Verda's pole at 1,500 m/s, heat shield first, held it at a fixed tilt and read the force from one physics step.

| Tilt (degrees) | Lift-to-drag in the game | Newtonian flat face, tan(alpha) | Newtonian Apollo-shaped cap |
| --- | --- | --- | --- |
| 0 | 0.000 | 0 | 0 |
| 5 | 0.050 | 0.087 | 0.08 |
| 10 | 0.099 | 0.176 | 0.16 |
| 20 | 0.197 | 0.364 | 0.33 |
| 30 | 0.288 | 0.577 | - |

The lift points the right way (toward the side the apex is tilted) and is a little over half of the Newtonian value. A player who holds a capsule off-axis with reaction wheels is already steering an entry, without the game saying so and without any check covering it. The work for item 6 is therefore less about adding lift than about making it correct, giving the capsule a trim angle, and verifying it.

### What is already right

- Aerodynamic velocity is taken relative to the rotating air, part by part, including the vessel's own spin.
- The heating law has the Sutton-Graves form, and the existing verification finds peak heating and peak deceleration at 0.87 and 0.62 of entry speed on a steep entry, against Allen and Eggers' 0.85 and 0.61.
- Wings have a real stall, induced drag and post-stall flat-plate behaviour.
- Structural loads and aerodynamic breakup take their forces from the same per-part model, so any change to the aerodynamics flows through to them automatically. That is a strength and also the reason every change has to be re-checked against stock designs.

## 14. Sources

Primary reports, free to read on the NASA Technical Reports Server unless noted.

| Source | Used for |
| --- | --- |
| [Allen and Eggers, NACA Report 1381 (1958), A Study of the Motion and Aerodynamic Heating of Ballistic Missiles Entering the Earth's Atmosphere at High Supersonic Speeds](https://ntrs.nasa.gov/citations/19930091020) | Ballistic entry solution, peak deceleration and heating, the blunt-body principle |
| [Chapman, NACA TN 4276 (1958), An Approximate Analytical Method for Studying Entry into Planetary Atmospheres](https://ntrs.nasa.gov/citations/19930085059) (reissued as NASA TR R-11) | Shallow and lifting entry, the 0.277 sqrt(r/H) result |
| [Sutton and Graves, NASA TR R-376 (1971), A General Stagnation-Point Convective-Heating Equation for Arbitrary Gas Mixtures](https://ntrs.nasa.gov/citations/19720003329) | Stagnation heating correlation and its constants |
| Fay and Riddell (1958), Theory of Stagnation Point Heat Transfer in Dissociated Air, Journal of the Aeronautical Sciences 25(2), 73-85, [doi 10.2514/8.7517](https://doi.org/10.2514/8.7517) | Stagnation-point heating theory |
| [Tauber and Sutton (1991), Stagnation-Point Radiative Heating Relations for Earth and Mars Entries, Journal of Spacecraft and Rockets 28](https://ntrs.nasa.gov/citations/19910048758) | Radiative heating correlation |
| [Ames Research Staff, NACA Report 1135 (1953), Equations, Tables, and Charts for Compressible Flow](https://ntrs.nasa.gov/citations/19930091059) | Isentropic, normal-shock and oblique-shock relations |
| [U.S. Standard Atmosphere, 1976 (NOAA, NASA, USAF)](https://ntrs.nasa.gov/citations/19770009539) | Temperature layers, density, sound speed, mean free path |
| [Graves and Harpold, NASA TN D-6725 (1972), Apollo Experience Report: Mission Planning for Apollo Entry](https://ntrs.nasa.gov/citations/19720013191) | Entry corridor, bank-angle guidance |
| [Hillje, NASA TN D-5399 (1969), Entry Aerodynamics at Lunar Return Conditions Obtained from the Flight of Apollo 4](https://ntrs.nasa.gov/citations/19690029435) | Flight-derived trim angle and L/D |
| [Lee and Goodrich, NASA TN D-6792 (1972), The Aerothermodynamic Environment of the Apollo Command Module During Superorbital Entry](https://ntrs.nasa.gov/citations/19720016296) | Apollo heating measurements |
| [NASA conference proceedings on the entry plasma sheath (1971), with N. D. Akey's overview of the RAM reentry measurements program](https://ntrs.nasa.gov/citations/19710011626) | RAM C flight plasma measurements |

Textbooks, for the derivations.

- J. D. Anderson, Hypersonic and High-Temperature Gas Dynamics, 2nd edition, AIAA, 2006. Newtonian theory, Mach number independence, real-gas effects, the Shuttle trim anomaly.
- J. D. Anderson, Modern Compressible Flow, 3rd edition, McGraw-Hill, 2003. Shock relations and linear supersonic theory.
- N. X. Vinh, A. Busemann and R. D. Culp, Hypersonic and Planetary Entry Flight Mechanics, University of Michigan Press, 1980. Entry equations, equilibrium glide, corridor.
- F. J. Regan and S. M. Anandakrishnan, Dynamics of Atmospheric Re-Entry, AIAA, 1993. Capsule aerodynamics and stability.
- S. F. Hoerner, Fluid-Dynamic Drag, published by the author, 1965. Drag coefficient against Mach number by shape, base drag.
- L. Lees (1956), Laminar Heat Transfer over Blunt-Nosed Bodies at Hypersonic Flight Speeds, Jet Propulsion 26(4), 259-269. Heating distribution around a blunt body.

How the sources were used. I confirmed that each linked report exists and matches its title, and read the abstracts. I did not open the full text of every report, so constants and flight figures quoted from memory are marked approximate in the text. The RAM C flight results are also in NASA TN D-5615 by Akey and Cross, which I could not find a direct link for. The mathematics in sections 2 to 8 was recomputed for this document, and the Newtonian capsule formulas, Chapman's result and the corridor tables were checked by numerical integration.
