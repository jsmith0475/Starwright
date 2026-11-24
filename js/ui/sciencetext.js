// Starwright — the text of the science reference (js/ui/science.js draws it).
// Each chapter is { id, title, lead, body(ctx) } where body returns a small markup:
//   ## Heading                 a section heading
//   $$ tex $$                  a displayed, numbered equation (one per line)
//   $tex$                      inline mathematics inside a paragraph
//   - item                     a list item
//   > game: text               "In Starwright": what the game itself does with this
//   > example: text            a worked example with the game's own numbers
//   [[calc:name]]              an interactive calculator (js/ui/science.js CALCS)
// The three chapters on the game's own aerodynamics, structural loads and breakup are in js/ui/scienceaero.js.
//   **bold**, *italic*
// Paragraphs are separated by blank lines. The numbers in the examples are computed from js/core/bodies.js when the
// chapter is drawn (ctx), so the text can never disagree with the worlds the player flies in.
// Pure data and string work: imported by the unit tests in Node.

import { AERO_CHAPTERS, aeroModel } from './scienceaero.js';

const TAU = Math.PI * 2;

/** Numbers and helpers every chapter may use. `SYSTEM` is js/core/bodies.js SYSTEM, `G0` js/core/parts.js G0. */
export function scienceContext(SYSTEM, G0 = 9.80665) {
  const B = SYSTEM.byId, home = SYSTEM.home || B.verda, star = home.parent, moon = home.children[0], far = B.rusk, farMoon = far.children[0];
  const sig = (x, n = 3) => {
    if (!Number.isFinite(x)) return '∞';
    if (x === 0) return '0';
    const mag = Math.floor(Math.log10(Math.abs(x)));
    if (mag >= 6 || mag < -3) { const m = x / Math.pow(10, mag); return `${m.toFixed(Math.max(0, n - 1))} \\times 10^{${mag}}`; }
    const d = Math.max(0, n - 1 - mag);
    return Number(x.toFixed(d)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const int = x => Math.round(x).toLocaleString('en-US');
  const km = (x, d = 0) => (x / 1000).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const dur = s => {
    if (s < 120) return `${s.toFixed(0)} s`;
    if (s < 7200) return `${(s / 60).toFixed(1)} min`;
    if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
    return `${(s / 86400).toFixed(1)} days`;
  };
  const vcirc = (b, alt) => Math.sqrt(b.gm / (b.radius + alt));
  const vesc = (b, alt) => Math.sqrt(2 * b.gm / (b.radius + alt));
  const period = (gm, a) => TAU * Math.sqrt(a * a * a / gm);
  /** Hohmann transfer between circular orbits of radius r1 and r2 about gm. */
  const hohmann = (gm, r1, r2) => {
    const a = (r1 + r2) / 2, v1 = Math.sqrt(gm / r1), v2 = Math.sqrt(gm / r2);
    const vp = Math.sqrt(gm * (2 / r1 - 1 / a)), va = Math.sqrt(gm * (2 / r2 - 1 / a));
    const tof = Math.PI * Math.sqrt(a * a * a / gm);
    const n2 = Math.sqrt(gm / (r2 * r2 * r2));
    return { a, v1, v2, vp, va, dv1: Math.abs(vp - v1), dv2: Math.abs(v2 - va), tof, phase: Math.PI - n2 * tof };
  };
  /** Burn from a circular parking orbit (altitude alt about b) that leaves b with excess speed vinf. */
  const eject = (b, alt, vinf) => { const r = b.radius + alt; return Math.sqrt(vinf * vinf + 2 * b.gm / r) - Math.sqrt(b.gm / r); };
  const parkAlt = home.atmo ? Math.ceil((home.atmo.height + 8000) / 10000) * 10000 : 20000;
  return { SYSTEM, B, G0, home, star, moon, far, farMoon, sig, int, km, dur, vcirc, vesc, period, hohmann, eject, parkAlt, TAU, aero: aeroModel() };
}

export const CHAPTERS = [
  {
    id: 'gravity', title: 'Gravity and the two-body problem',
    lead: 'One law of force, two conserved quantities, and the whole of orbital flight follows.',
    body: c => {
      const { home, sig, km, parkAlt } = c;
      const g80 = home.gm / Math.pow(home.radius + parkAlt, 2);
      return String.raw`
## Newton's law of gravitation

Two point masses $M$ and $m$ a distance $r$ apart attract each other with a force along the line between them:

$$ F = \frac{G M m}{r^2} $$

A sphere whose density depends only on depth pulls on anything outside it exactly as if all its mass sat at its centre (Newton's shell theorem), so a planet can be treated as a point. The constant $G$ and the mass $M$ only ever appear multiplied together, and that product is known far more precisely than either factor. It gets its own symbol, the **gravitational parameter**:

$$ \mu = G M $$

For a spacecraft the mass $m$ cancels out of its own equation of motion: divide the force by $m$ and the acceleration is the same for a bolt and for a space station. With $\mathbf{r}$ the position vector from the centre of the planet to the craft,

$$ \ddot{\mathbf{r}} = -\frac{\mu}{r^3}\,\mathbf{r} $$

This is the **two-body equation**. It is a second-order vector differential equation: give it a position and a velocity at one instant (six numbers) and it fixes the motion for all time. Everything in the next three chapters is the solution of this one equation.

> game: Each world's $\mu$ is set from its surface gravity and radius, $\mu = g_0 R^2$. For ${home.name}, $g_0 = ${sig(home.surfaceG)}$ m/s² and $R = ${km(home.radius)}$ km give $\mu = ${sig(home.gm, 4)}$ m³/s².

> example: Gravity does not switch off in orbit. At ${km(parkAlt)} km above ${home.name} the acceleration is $\mu / r^2 = ${sig(g80)}$ m/s², which is ${(100 * g80 / home.surfaceG).toFixed(0)} % of the surface value. Crews float because they are falling freely around the planet, with the ship falling at the same rate.

## Conservation of energy

Take the dot product of the equation of motion with the velocity $\mathbf{v} = \dot{\mathbf{r}}$. The left side is $\mathbf{v}\cdot\dot{\mathbf{v}} = \frac{d}{dt}\left(\frac{v^2}{2}\right)$. On the right, $\mathbf{r}\cdot\dot{\mathbf{r}} = r\dot{r}$, so the term is $-\frac{\mu}{r^2}\dot{r} = \frac{d}{dt}\left(\frac{\mu}{r}\right)$. Moving everything to one side:

$$ \frac{d}{dt}\left(\frac{v^2}{2} - \frac{\mu}{r}\right) = 0 $$

The quantity in the brackets never changes along a coasting trajectory. It is the **specific orbital energy** (energy per kilogram of spacecraft):

$$ \varepsilon = \frac{v^2}{2} - \frac{\mu}{r} $$

The first term is kinetic energy, the second is gravitational potential energy, measured so that it is zero infinitely far away. A craft with $\varepsilon < 0$ is bound and will come back. With $\varepsilon \ge 0$ it has enough speed to coast away for ever.

## Conservation of angular momentum

Now take the cross product of $\mathbf{r}$ with the equation of motion. The right side is $\mathbf{r}\times\mathbf{r}$ times a number, which is zero. The left side is $\mathbf{r}\times\ddot{\mathbf{r}} = \frac{d}{dt}\left(\mathbf{r}\times\dot{\mathbf{r}}\right)$, because the extra term $\dot{\mathbf{r}}\times\dot{\mathbf{r}}$ vanishes. So

$$ \mathbf{h} = \mathbf{r}\times\mathbf{v} = \text{constant} $$

The **specific angular momentum** $\mathbf{h}$ is fixed in both size and direction. Two consequences:

- The direction is fixed, so $\mathbf{r}$ and $\mathbf{v}$ always lie in the same plane through the centre of the planet. Every orbit is flat. Changing that plane takes an engine burn (chapter 6).
- The size is fixed. In polar coordinates $h = r^2\dot{\theta}$, and the area swept by the radius in a short time is $dA = \tfrac{1}{2} r^2\,d\theta$, so $\frac{dA}{dt} = \frac{h}{2}$. Equal areas in equal times: this is **Kepler's second law**, and it is nothing more than conservation of angular momentum.

A craft is therefore fastest at its lowest point and slowest at its highest, in exact inverse proportion: at the two ends of an orbit, where the velocity is at right angles to the radius, $r_p v_p = r_a v_a = h$.
`;
    },
  },
  {
    id: 'conics', title: 'The shape of an orbit',
    lead: 'Solving the two-body equation gives a conic section. Circles, ellipses, parabolas and hyperbolas are one family.',
    body: c => {
      const { home, sig, km, parkAlt, vcirc, vesc } = c;
      return String.raw`
## Deriving the orbit equation

Write the motion in polar coordinates $(r, \theta)$ in the orbital plane. The radial part of the equation of motion is

$$ \ddot{r} - r\dot{\theta}^2 = -\frac{\mu}{r^2} $$

where $r\dot{\theta}^2$ is the centripetal term. Use $h = r^2\dot{\theta}$ to remove time, and substitute $u = 1/r$. Then $\dot{r} = -h\,\frac{du}{d\theta}$ and $\ddot{r} = -h^2 u^2\,\frac{d^2u}{d\theta^2}$, and the equation becomes linear:

$$ \frac{d^2u}{d\theta^2} + u = \frac{\mu}{h^2} $$

This is the equation of a mass on a spring with a constant push. Its solution is a constant plus a cosine, $u = \frac{\mu}{h^2}\left(1 + e\cos(\theta - \theta_0)\right)$. Measuring the angle from the lowest point of the orbit and turning $u$ back into $r$:

$$ r = \frac{p}{1 + e\cos\nu}, \qquad p = \frac{h^2}{\mu} $$

This is the polar equation of a **conic section** with the planet at one focus (**Kepler's first law**). The angle $\nu$ is the **true anomaly**, $p$ is the semi-latus rectum and $e$ is the **eccentricity**, the single number that picks the shape:

- $e = 0$: a circle.
- $0 < e < 1$: an ellipse, a closed orbit.
- $e = 1$: a parabola, the borderline case of exactly escape speed.
- $e > 1$: a hyperbola, a flyby that never returns.

## Periapsis, apoapsis and the semi-major axis

The closest point, **periapsis**, is at $\nu = 0$ and the farthest, **apoapsis**, at $\nu = \pi$:

$$ r_p = \frac{p}{1 + e}, \qquad r_a = \frac{p}{1 - e} $$

Half the long axis of the ellipse is the **semi-major axis** $a = \tfrac{1}{2}(r_p + r_a)$, which gives $p = a(1 - e^2)$ and the handy forms

$$ r_p = a(1 - e), \qquad r_a = a(1 + e), \qquad e = \frac{r_a - r_p}{r_a + r_p} $$

These distances are measured from the centre of the planet. Flight instruments show *altitudes*, which are the same numbers minus the planet's radius.

## Energy fixes the size

Evaluate the energy at periapsis, where $v_p = h / r_p$, and use $h^2 = \mu a (1 - e^2)$. The eccentricity cancels and what is left depends on the semi-major axis alone:

$$ \varepsilon = -\frac{\mu}{2a} $$

So all orbits with the same long axis have the same energy and (next chapter) the same period, whatever their shape. For a hyperbola $a$ is negative and the energy positive.

## The eccentricity vector

There is a third conserved quantity. The vector

$$ \mathbf{e} = \frac{\mathbf{v}\times\mathbf{h}}{\mu} - \frac{\mathbf{r}}{r} $$

does not change along the orbit. Its length is the eccentricity and it points from the planet to the periapsis. Together $\mathbf{h}$ and $\mathbf{e}$ turn a position and a velocity directly into the orbit's plane, shape and orientation, with no differential equation to solve.

## The six orbital elements

Six numbers describe an orbit completely, the same count as a position plus a velocity:

- $a$ and $e$: size and shape.
- $i$, the **inclination**: the tilt of the orbital plane against the equator, the angle between $\mathbf{h}$ and the planet's spin axis.
- $\Omega$, the **longitude of the ascending node**: where the orbit crosses the equator going north.
- $\omega$, the **argument of periapsis**: the angle in the orbital plane from that node to the periapsis.
- One number for *where the craft is now*: the true anomaly $\nu$, or the mean anomaly at some reference time (chapter 4).

> game: This is exactly how every orbit is stored. A coasting ship is six elements plus an epoch, and its position at any time is computed in closed form from them. The map view draws the conic from the same numbers.

> example: A circular orbit ${km(parkAlt)} km above ${home.name} needs $v = \sqrt{\mu / r} = ${sig(vcirc(home, parkAlt), 4)}$ m/s. Escape from the same height needs $\sqrt{2\mu / r} = ${sig(vesc(home, parkAlt), 4)}$ m/s. The ratio is always $\sqrt{2}$: from any circular orbit, 41 % more speed is enough to leave for good.
`;
    },
  },
  {
    id: 'visviva', title: 'Speed, period and the vis-viva equation',
    lead: 'The one formula a flight planner uses more than any other, and Kepler\'s third law.',
    body: c => {
      const { home, moon, sig, km, dur, parkAlt, vcirc, period } = c;
      const r = home.radius + parkAlt, T = period(home.gm, r);
      const rs = Math.cbrt(home.gm * Math.pow(home.rotPeriod / TAU, 2));
      return String.raw`
## Vis-viva

Set the two expressions for the energy equal, $\frac{v^2}{2} - \frac{\mu}{r} = -\frac{\mu}{2a}$, and solve for the speed:

$$ v^2 = \mu\left(\frac{2}{r} - \frac{1}{a}\right) $$

This is the **vis-viva equation**. It gives the speed at any distance on any orbit, and every burn calculation in this reference is two applications of it: the speed you have, and the speed the orbit you want would have at the same point. Three special cases are worth knowing by heart:

$$ v_{circ} = \sqrt{\frac{\mu}{r}}, \qquad v_{esc} = \sqrt{\frac{2\mu}{r}}, \qquad v_\infty^2 = v^2 - \frac{2\mu}{r} $$

The first has $a = r$. The second has $a \to \infty$. The third is the hyperbolic case: $v_\infty$ is the speed left over once the craft has climbed out of the gravity well, the **hyperbolic excess speed**, and it is what the next sphere of influence sees arriving (chapter 7).

## Kepler's third law

The area of an ellipse is $\pi a b$ with semi-minor axis $b = a\sqrt{1 - e^2}$. The radius sweeps area at the constant rate $h/2$, so one full revolution takes $T = 2\pi a b / h$. Substituting $h = \sqrt{\mu a (1 - e^2)}$ the eccentricity cancels again:

$$ T = 2\pi\sqrt{\frac{a^3}{\mu}} $$

The square of the period is proportional to the cube of the semi-major axis. The average angular rate, the **mean motion**, is

$$ n = \frac{2\pi}{T} = \sqrt{\frac{\mu}{a^3}} $$

> example: At ${km(parkAlt)} km above ${home.name}, $r = ${km(r)}$ km, so $v = ${sig(vcirc(home, parkAlt), 4)}$ m/s and the period is ${dur(T)}. ${moon.name} orbits at $a = ${km(moon.orbit.a)}$ km and takes ${dur(period(home.gm, moon.orbit.a))}.

> example: A **stationary orbit** has the same period as the planet's rotation, so the craft hangs over one spot. Solve for the radius whose period is ${dur(home.rotPeriod)}: $r = \sqrt[3]{\mu T^2 / 4\pi^2} = ${km(rs)}$ km, an altitude of ${km(rs - home.radius)} km above ${home.name}.

> game: The apoapsis, periapsis and orbital period on the flight instruments are these formulas applied to the ship's current position and velocity: the energy gives $a$, the angular momentum gives $e$, and Kepler's third law gives the period.

## Raising and lowering an orbit

Vis-viva explains the most confusing fact of orbital flight: **to catch up with something ahead of you, you slow down**. A retrograde burn lowers $a$, a smaller $a$ means a shorter period, and the craft gains on the target. A prograde burn raises the opposite side of the orbit and makes the lap longer. A burn changes the speed here and the altitude on the far side.

Differentiating vis-viva at fixed $r$ gives the sensitivity of the orbit's size to a small prograde burn $\delta v$:

$$ \delta a = \frac{2 a^2 v}{\mu}\,\delta v $$

The factor $v$ is the first appearance of the Oberth effect (chapter 6): the same burn changes the orbit most where the craft is moving fastest.
`;
    },
  },
  {
    id: 'kepler', title: 'Where am I at time t? Kepler\'s equation',
    lead: 'The shape of an orbit is algebra. Position as a function of time needs an equation with no closed-form solution.',
    body: c => {
      const { home, sig, dur, km } = c;
      return String.raw`
## The problem

The orbit equation gives $r$ as a function of the angle $\nu$, but a clock gives time. Because the craft moves fast near periapsis and slowly near apoapsis, the angle is not proportional to time. Linking the two is **Kepler's problem**.

## Three anomalies

Draw a circle of radius $a$ around the centre of the ellipse and project the craft straight up onto it. The angle to that point, seen from the centre, is the **eccentric anomaly** $E$. Position on the ellipse is simple in terms of $E$:

$$ r = a(1 - e\cos E), \qquad \tan\frac{\nu}{2} = \sqrt{\frac{1 + e}{1 - e}}\,\tan\frac{E}{2} $$

The **mean anomaly** $M$ is the angle of an imaginary craft that moves around at the constant mean rate $n$. It is plain time, rescaled:

$$ M = n\,(t - t_p) $$

with $t_p$ the time of periapsis passage. Applying the equal-areas law to the region swept since periapsis gives the relation between the two:

$$ M = E - e\sin E $$

This is **Kepler's equation**. Going from position to time is direct. Going from time to position means solving it for $E$, and it is transcendental: there is no finite formula.

## Solving it

The function $f(E) = E - e\sin E - M$ is smooth and increasing, because $f'(E) = 1 - e\cos E > 0$ for any ellipse. Newton's method converges quickly:

$$ E_{k+1} = E_k - \frac{E_k - e\sin E_k - M}{1 - e\cos E_k} $$

Starting from $E_0 = M$ (or $\pi$ for very eccentric orbits), four or five steps reach the limit of double precision.

## Hyperbolic orbits

For $e > 1$ the trigonometric functions become hyperbolic ones. With hyperbolic anomaly $F$ and $n = \sqrt{\mu / |a|^3}$:

$$ M = e\sinh F - F, \qquad r = |a|\,(e\cosh F - 1) $$

It is solved the same way. A flyby is a hyperbola about the planet, so this form is used for every arrival at another world.

> game: Starwright solves Kepler's equation with Newton's method kept inside a shrinking bracket, falling back to bisection, so it converges for every eccentricity. This is what "on rails" means: during time warp nothing is integrated step by step. The position at the new time is computed directly, so a ship coasting for a year at maximum warp is exactly where the conic says, with no accumulated error.

## Time between two points

The same equations give the time to go from one true anomaly to another: convert both to $E$, then to $M$, and divide the difference by $n$. Time to periapsis and time to apoapsis on the flight instruments are this calculation. So is the timing of every manoeuvre node.

> example: An orbit about ${home.name} with periapsis at ${km(80000)} km and apoapsis at ${km(2000000)} km altitude has $a = ${km(home.radius + 1040000)}$ km, $e = ${sig((2000000 - 80000) / (2 * home.radius + 2080000), 3)}$ and a period of ${dur(TAU * Math.sqrt(Math.pow(home.radius + 1040000, 3) / home.gm))}. The craft spends most of that time far out: the half of the orbit nearest the planet, from $\nu = -90^\circ$ to $+90^\circ$, takes only a small fraction of the lap.
`;
    },
  },
  {
    id: 'rocket', title: 'The rocket equation',
    lead: 'Why rockets are mostly propellant, why they are built in stages, and what delta-v means.',
    body: c => {
      const { home, sig, int, G0 } = c;
      const isp = 320, ve = isp * G0;
      const dv1 = ve * Math.log(10 / 4);
      const two = 300 * G0 * Math.log(20 / (20 - 12)) + 340 * G0 * Math.log(6 / (6 - 4));
      const one = 320 * G0 * Math.log(20 / 4);
      return String.raw`
## Momentum, not push against anything

A rocket moves by throwing mass backwards. Nothing outside it is needed, which is why it works in vacuum. Consider a rocket of mass $m$ moving at $v$ that expels a small mass $dm_p$ of propellant at exhaust speed $v_e$ relative to itself. Total momentum before and after must be equal:

$$ m\,v = (m - dm_p)(v + dv) + dm_p\,(v - v_e) $$

Multiply out and drop the product of two small quantities. What remains is $m\,dv = v_e\,dm_p$. The rocket's own mass falls by what it throws away, $dm = -dm_p$, so

$$ dv = -v_e\,\frac{dm}{m} $$

## Integrating

Each kilogram of propellant buys a speed change inversely proportional to the mass it still has to push. Integrate from the full mass $m_0$ to the empty mass $m_1$:

$$ \Delta v = -v_e\int_{m_0}^{m_1}\frac{dm}{m} = v_e\,\ln\frac{m_0}{m_1} $$

This is the **Tsiolkovsky rocket equation**. $\Delta v$ ("delta-v") is the total change in speed the rocket can make in free space. It is the currency of spaceflight: every manoeuvre has a price in m/s, and a ship's tanks hold a budget in m/s.

Two things follow from the logarithm. First, the burn time does not appear: a gentle burn and a violent one give the same $\Delta v$. Second, the returns diminish brutally. Inverting the equation,

$$ \frac{m_0}{m_1} = e^{\Delta v / v_e} $$

so each additional $v_e$ of speed multiplies the required launch mass by 2.72.

## Specific impulse

Engine efficiency is quoted as **specific impulse** $I_{sp}$, in seconds: the time one kilogram of propellant could produce one kilogram-force of thrust. It is the exhaust speed in disguise,

$$ v_e = I_{sp}\,g_0, \qquad g_0 = 9.80665\ \text{m/s}^2 $$

where $g_0$ is a fixed conversion constant (standard Earth gravity), the same on every world. Thrust $F$ and propellant flow $\dot{m}$ are tied to it by

$$ F = \dot{m}\,v_e \qquad \Rightarrow \qquad \dot{m} = \frac{F}{I_{sp}\,g_0} $$

An engine's $I_{sp}$ is lower in thick air than in vacuum, because outside pressure pushes back on the nozzle. Engines with long nozzles do best in vacuum, short ones at sea level.

> example: A stage of 10 t with 6 t of propellant and $I_{sp} = ${isp}$ s has $v_e = ${int(ve)}$ m/s and $\Delta v = ${int(ve)} \times \ln(10/4) = ${int(dv1)}$ m/s.

## Why rockets have stages

Tanks and engines are dead weight once empty. Dropping them resets the mass ratio. With stages numbered from the first to burn, each with its own exhaust speed and its own full and empty masses (counting everything still stacked above it):

$$ \Delta v_{total} = \sum_{k} v_{e,k}\,\ln\frac{m_{0,k}}{m_{1,k}} $$

> example: A 20 t rocket that is 16 t propellant in one stage at 320 s reaches ${int(one)} m/s. Split it: a 14 t first stage (12 t propellant, 300 s) under a 6 t second stage (4 t propellant, 340 s) reaches ${int(two)} m/s, because the second stage does not drag the first stage's empty tanks along.

## Thrust-to-weight ratio

Delta-v says how far a rocket can go. Whether it can lift off at all is a separate question:

$$ \mathrm{TWR} = \frac{F}{m\,g} $$

with $g$ the local surface gravity. Below 1 the rocket sits on the pad burning propellant. Around 1.3 to 1.7 is a good launch value on ${home.name}. In orbit a low ratio is fine, the burn only takes longer.

> game: The assembly building computes $\Delta v$ and TWR per stage with exactly these formulas, using each engine's vacuum or sea-level $I_{sp}$. In flight, thrust and mass are integrated every physics step with the mass taken at the middle of the step, and the delta-v the craft actually gains is checked against the rocket equation by the physics verification suite.

[[calc:rocket]]
`;
    },
  },
  {
    id: 'maneuvers', title: 'Manoeuvres: changing an orbit',
    lead: 'The Hohmann transfer, plane changes, and why burns belong at the bottom of a gravity well.',
    body: c => {
      const { home, moon, sig, int, km, dur, parkAlt, hohmann, vcirc } = c;
      const r1 = home.radius + parkAlt, h = hohmann(home.gm, r1, moon.orbit.a);
      const v = vcirc(home, parkAlt);
      return String.raw`
## Impulsive burns

A chemical engine burns for seconds or minutes, an orbit lasts an hour or more. To a good approximation a burn changes the velocity instantly while the position stays put. The craft is then on a new conic that passes through the same point. Burn directions are named relative to the orbit:

- **Prograde / retrograde** (along or against the velocity): changes the energy, and so the altitude of the opposite side.
- **Normal / antinormal** (perpendicular to the orbital plane): tilts the plane.
- **Radial in / out** (toward or away from the planet, in the plane): rotates the orbit within its plane.

## The Hohmann transfer

To move between two circular orbits of radius $r_1$ and $r_2$ in the same plane, the cheapest two-burn route is an ellipse that just touches both: periapsis on one, apoapsis on the other. Its semi-major axis is

$$ a_t = \frac{r_1 + r_2}{2} $$

Vis-viva gives the speed on the transfer ellipse at each end, and the difference from the circular speed there is the burn:

$$ \Delta v_1 = \sqrt{\frac{\mu}{r_1}}\left(\sqrt{\frac{2 r_2}{r_1 + r_2}} - 1\right), \qquad \Delta v_2 = \sqrt{\frac{\mu}{r_2}}\left(1 - \sqrt{\frac{2 r_1}{r_1 + r_2}}\right) $$

The trip takes half the period of the transfer ellipse:

$$ t_{transfer} = \pi\sqrt{\frac{a_t^3}{\mu}} $$

> example: From a parking orbit at ${km(parkAlt)} km to the distance of ${moon.name} ($r_2 = ${km(moon.orbit.a)}$ km): $\Delta v_1 = ${int(h.dv1)}$ m/s, coast for ${dur(h.tof)}, and $\Delta v_2 = ${int(h.dv2)}$ m/s to circularise out there. (To actually arrive *at* ${moon.name} its gravity does part of the second job. See chapter 7.)

## Phase angle

A transfer to a moving target must be timed so both arrive together. During the transfer the target advances by $n_2\,t_{transfer}$, and the craft arrives exactly opposite its starting point. So at departure the target must lead the craft by the **phase angle**

$$ \phi = \pi - n_2\,t_{transfer} = \pi\left(1 - \left(\frac{r_1 + r_2}{2 r_2}\right)^{3/2}\right) $$

> example: For ${moon.name} from low orbit the phase angle is ${(h.phase * 180 / Math.PI).toFixed(0)}°. The right moment comes round once every lap of the parking orbit, about every ${dur(c.period(home.gm, r1))}.

## Plane changes

To rotate the velocity vector through an angle $\Delta i$ without changing its length, the burn is the base of an isosceles triangle:

$$ \Delta v = 2 v\,\sin\frac{\Delta i}{2} $$

It is proportional to the speed, which makes plane changes in low orbit ruinous: at ${int(v)} m/s around ${home.name}, 10° costs ${int(2 * v * Math.sin(5 * Math.PI / 180))} m/s and 60° costs as much as the orbital speed itself. Two rules follow. Do plane changes where the craft is slow, at a high apoapsis. And launch into the right plane in the first place. A plane change is only possible where the two planes cross, at the ascending and descending nodes.

## The Oberth effect

The energy a burn adds is not the same everywhere. From $\varepsilon = \frac{v^2}{2} - \frac{\mu}{r}$, a small prograde burn $\Delta v$ at speed $v$ changes the energy by

$$ \Delta\varepsilon = v\,\Delta v + \frac{\Delta v^2}{2} $$

The first term is proportional to the speed at the moment of the burn. The same engine, the same propellant, the same $\Delta v$, yields more orbital energy when the craft is moving fast, which is deep in a gravity well at periapsis. The propellant's own kinetic energy pays for it: it is left behind lower in the well. This is why interplanetary departures are single burns from low orbit, and why a capture burn is made at the periapsis of the arrival hyperbola.

## Bi-elliptic transfers and other curiosities

When the target orbit is more than about 11.9 times larger than the starting one, three burns through a very high intermediate apoapsis beat the Hohmann transfer, at the cost of a much longer trip. And a transfer that is not tangent at both ends (leaving earlier or later, arriving sooner) always costs more. The general problem of connecting two positions in a given time is **Lambert's problem**. Its solutions, plotted over departure and arrival dates, are the "porkchop plots" used to choose launch windows.

> game: Manoeuvre nodes on the map are impulsive burns in the prograde, normal and radial directions. The predicted path is the conic after the burn, patched through any spheres of influence it meets. When a node is flown, the burn is centred on the node time so that half the delta-v is delivered before it, which is the best finite-burn match to the impulsive plan.
`;
    },
  },
  {
    id: 'transfers', title: 'Going to another world: patched conics',
    lead: 'Spheres of influence, hyperbolic departures, launch windows and capture.',
    body: c => {
      const { home, star, moon, far, farMoon, sig, int, km, dur, parkAlt, hohmann, eject, period } = c;
      const h = hohmann(star.gm, home.orbit.a, far.orbit.a);
      const dvEj = eject(home, parkAlt, h.dv1);
      const peFar = far.atmo ? far.atmo.height + Math.max(40000, far.radius * 0.5) : far.radius * 0.6;
      const dvCap = eject(far, peFar, h.dv2);
      const Th = period(star.gm, home.orbit.a), Tf = period(star.gm, far.orbit.a), syn = 1 / Math.abs(1 / Th - 1 / Tf);
      const hm = hohmann(home.gm, home.radius + parkAlt, moon.orbit.a);
      const vMoon = Math.sqrt(home.gm / moon.orbit.a), vinfM = vMoon - hm.va;
      const capM = eject(moon, 20000, vinfM);
      return String.raw`
## The three-body problem, avoided

With two attracting bodies, a sun and a planet, the motion of a spacecraft has no general closed-form solution. Mission planners have used a practical approximation since the 1960s: at any moment, pretend only one body pulls on the craft, the one that dominates there. Each leg of the journey is then a two-body conic, and the legs are "patched" together where the dominance changes hands. This is the method of **patched conics**.

## The sphere of influence

Where does a planet's dominance end? Not where its pull equals the sun's (for most moons the sun's pull is actually stronger). The fair comparison is: seen from the planet, how big is the sun's *disturbance* compared with the planet's own pull, against the same question seen from the sun. Laplace found the surface where the two ratios are equal. For a planet of gravitational parameter $\mu_p$ orbiting at distance $a_p$ from a primary $\mu_s$ it is very nearly a sphere of radius

$$ r_{SOI} = a_p\left(\frac{\mu_p}{\mu_s}\right)^{2/5} $$

> example: ${home.name}: $r_{SOI} = ${km(home.orbit.a)}\ \text{km} \times (${sig(home.gm / star.gm, 3)})^{0.4} = ${km(home.soi)}$ km. ${moon.name}, deep inside it, has its own sphere of ${km(moon.soi)} km. ${far.name}: ${km(far.soi)} km.

## Leaving a planet

Inside the sphere of influence the departure is a hyperbola about the planet. Far from the planet the craft is left with the excess speed $v_\infty$, which adds to the planet's own orbital velocity around the sun. To start an outward Hohmann transfer the craft must leave *ahead* of the planet with exactly the speed the transfer needs: $v_\infty = \Delta v_1$ of the sun-centred transfer. From vis-viva, the speed needed at a parking orbit of radius $r_{park}$ is $\sqrt{v_\infty^2 + 2\mu_p / r_{park}}$, so the burn is

$$ \Delta v_{eject} = \sqrt{v_\infty^2 + \frac{2\mu_p}{r_{park}}} - \sqrt{\frac{\mu_p}{r_{park}}} $$

This is the Oberth effect earning its keep. The burn is far smaller than $v_\infty$ plus escape speed added separately.

The hyperbola bends the path by half its turning angle, so the burn is made *before* the craft reaches the point directly behind the planet, by the **ejection angle**

$$ \cos\theta_{eject} = \frac{1}{e}, \qquad e = 1 + \frac{r_{park}\,v_\infty^2}{\mu_p} $$

> example: ${home.name} to ${far.name}. Around ${star.name}, the Hohmann ellipse from $${km(home.orbit.a / 1e6, 1)}$ to $${km(far.orbit.a / 1e6, 1)}$ million km needs $v_\infty = ${int(h.dv1)}$ m/s at departure and arrives ${int(h.dv2)} m/s slower than ${far.name}. From a parking orbit at ${km(parkAlt)} km the ejection burn is ${int(dvEj)} m/s. The coast takes ${dur(h.tof)}.

## Launch windows

The phase-angle argument of chapter 6 applies to planets. The target must lead by $\phi = \pi - n_2 t_{transfer}$ at departure: for ${far.name}, ${(h.phase * 180 / Math.PI).toFixed(0)}°. That geometry repeats once every **synodic period**, the time for the faster planet to lap the slower one:

$$ \frac{1}{T_{syn}} = \left|\frac{1}{T_1} - \frac{1}{T_2}\right| $$

> example: ${home.name}'s year is ${dur(Th)} and ${far.name}'s is ${dur(Tf)}, so a window opens every ${dur(syn)}. Miss it and the choice is to wait or to pay much more delta-v.

## Arriving and capturing

At the far end the roles reverse. The craft crosses into the target's sphere of influence with a relative speed $v_\infty$, falls along a hyperbola, and will leave again unless it brakes. The cheapest capture burn is at the periapsis $r_p$ of that hyperbola:

$$ \Delta v_{capture} = \sqrt{v_\infty^2 + \frac{2\mu_p}{r_p}} - \sqrt{\frac{\mu_p}{r_p}\,(1 + e_{target})} $$

with $e_{target} = 0$ for a circular orbit and close to 1 for a long, loosely bound one, which costs far less. How close the hyperbola passes is set long before by the aim: the **impact parameter** $b$, the miss distance the incoming straight line would have, gives

$$ r_p = \frac{\mu_p}{v_\infty^2}\left(\sqrt{1 + \frac{b^2 v_\infty^4}{\mu_p^2}} - 1\right) $$

Weeks out, a change of a few centimetres per second moves $b$ by hundreds of kilometres, which is why a small **mid-course correction** is so much cheaper than fixing things on arrival.

> example: Arriving at ${far.name} at $v_\infty = ${int(h.dv2)}$ m/s with periapsis ${km(peFar)} km up, a burn of ${int(dvCap)} m/s makes the orbit circular. Where the target has air, aiming the periapsis into the upper atmosphere lets drag do the braking for free (aerocapture).

> example: The same mathematics one level down takes a ship to ${moon.name}. The transfer ellipse arrives ${int(vinfM)} m/s slower than ${moon.name} itself, so ${moon.name} overtakes the ship and it enters the sphere of influence at about that speed. Capture into a 20 km circular orbit takes ${int(capM)} m/s.

## Gravity assists

A flyby with no burn leaves the target with the same $v_\infty$ it arrived with, but pointing in a new direction, turned by

$$ \delta = 2\arcsin\frac{1}{e}, \qquad e = 1 + \frac{r_p\,v_\infty^2}{\mu_p} $$

Relative to the planet nothing was gained. Relative to the sun, the velocity is the planet's plus a rotated vector, and that can be a large gain or loss. Passing behind a planet speeds a craft up, passing in front slows it down. The planet pays, by an amount too small to measure.

## What patched conics leave out

The approximation ignores the sun while near a planet and the planet while far from it. The real path is a little different near the boundary, which a small correction burn covers. It also removes some real phenomena entirely: the **Lagrange points**, where the pulls of two bodies and the orbital motion balance, exist only when both bodies act at once.

> game: Starwright uses patched conics throughout, with the Laplace radius above. On crossing a sphere of influence the ship's position and velocity are re-expressed relative to the new body and it continues on a new conic. Bodies themselves run on fixed Kepler orbits. There are no Lagrange points, no tidal drift and no orbital decay. The physics verification document in the docs folder measures how far this departs from full n-body gravity.

[[calc:transfer]]
`;
    },
  },
  {
    id: 'ascent', title: 'Launch: from the pad to orbit',
    lead: 'Orbit is sideways speed. The climb is a fight against gravity and air, and calculus says how to lose least.',
    body: c => {
      const { home, sig, int, km, parkAlt, vcirc } = c;
      const vo = vcirc(home, parkAlt), vrot = TAU * home.radius / home.rotPeriod;
      return String.raw`
## What orbit costs

Reaching space is easy: ${km(home.atmo ? home.atmo.height : 70000)} km straight up. Staying there is the hard part. An orbit at ${km(parkAlt)} km needs ${int(vo)} m/s *horizontally*, and that is where nearly all the propellant goes. A launch is therefore a turn: start vertical to get out of the thick air, end horizontal at orbital speed.

## The equations of motion

For a rocket of mass $m$, thrust $F$ and drag $D$, flying at angle $\gamma$ above the horizontal (the **flight-path angle**), along the direction of flight:

$$ \frac{dv}{dt} = \frac{F - D}{m} - g\sin\gamma $$

and across it, with the thrust along the velocity:

$$ v\,\frac{d\gamma}{dt} = -\left(g - \frac{v^2}{r}\right)\cos\gamma $$

The second equation is the **gravity turn**: once the rocket is tipped slightly off vertical, gravity itself bends the path over, with no steering force and no sideways air load on the vehicle. The term $v^2 / r$ is the centrifugal relief: as horizontal speed approaches orbital speed, the bracket goes to zero and the path stops falling.

## The delta-v budget

Integrate the first equation over the whole ascent:

$$ \Delta v_{rocket} = v_{orbit} + \int_0^T g\sin\gamma\,dt + \int_0^T \frac{D}{m}\,dt + \Delta v_{steering} - v_{rotation} $$

- **Gravity loss**, the first integral. Every second spent thrusting upward costs $g$ m/s that buys no speed. It is reduced by a high thrust-to-weight ratio and by turning toward horizontal early.
- **Drag loss**, the second. It is reduced by climbing slowly through the thick lower air, which is the opposite advice.
- **Steering loss** from thrust not aligned with the velocity.
- **Rotation**: a launch pad on the equator is already moving east. On ${home.name} that is $2\pi R / T_{rot} = ${int(vrot)}$ m/s for free when launching east.

The best ascent is the compromise between the first two. On ${home.name} the losses total roughly 1,000 to 1,500 m/s, so a rocket needs about ${int(Math.round((vo + 1150) / 100) * 100)} m/s of delta-v to reach low orbit.

## Dynamic pressure and max Q

The air load on the vehicle is set by the **dynamic pressure**

$$ q = \tfrac{1}{2}\rho v^2 $$

During ascent $v$ rises while the density $\rho$ falls exponentially with height, so $q$ climbs to a peak and then dies away. The peak is **max Q**, the moment of greatest structural stress. Rockets often throttle down through it.

## Terminal velocity

A falling or rising body stops accelerating when drag equals weight:

$$ v_t = \sqrt{\frac{2 m g}{\rho\,C_d A}} $$

Classic guidance for the lower atmosphere: climbing much faster than the local terminal velocity wastes more to drag than it saves in gravity loss.

## Circularising

The engines usually cut off with the apoapsis at the target height and the periapsis still inside the planet. The craft coasts up, and at apoapsis a horizontal burn adds the difference between its speed there and circular speed (vis-viva, twice). Until that burn the "orbit" intersects the ground.

> game: The ascent autopilot flies this profile: vertical at first, a pitch programme that follows the gravity turn, engine cut-off when the apoapsis reaches the target height, then a circularisation burn planned at apoapsis. The numbers on the flight instruments (apoapsis, periapsis, time to apoapsis) are the conic computed from the current position and velocity, refreshed every frame.
`;
    },
  },
  {
    id: 'atmosphere', title: 'Flight through air: drag, lift and heat',
    lead: 'The exponential atmosphere, the forces on wings, and why re-entry is hot.',
    body: c => {
      const { home, sig, int, km } = c;
      const at = home.atmo;
      const rho = h => at.rho0 * Math.exp(-h / at.scale);
      return String.raw`
## The exponential atmosphere

A layer of air supports the weight of everything above it, $dp = -\rho g\,dh$. For a gas at roughly constant temperature the density is proportional to the pressure, $\rho = p / (R_s T)$, so $\frac{dp}{p} = -\frac{g}{R_s T}\,dh$. Integrating:

$$ \rho(h) = \rho_0\,e^{-h/H}, \qquad H = \frac{R_s T}{g} $$

$H$ is the **scale height**: the climb over which the air thins by a factor $e \approx 2.72$. Half of an atmosphere's mass lies below $H \ln 2$.

> game: Every atmosphere in Starwright is this exponential, cut off at a fixed top, and it rotates with its planet. ${home.name}: $\rho_0 = ${at.rho0}$ kg/m³, $H = ${km(at.scale, 1)}$ km, top at ${km(at.height)} km. At 10 km the density is $${sig(rho(10000), 2)}$ kg/m³, at 30 km $${sig(rho(30000), 2)}$, at 60 km $${sig(rho(60000), 2)}$.

## Drag

A body pushing through air at speed $v$ must shove aside a mass of air proportional to $\rho v$ each second and give it a speed proportional to $v$. The force goes as the square of the speed:

$$ D = \tfrac{1}{2}\rho v^2\,C_d\,A $$

with $A$ a reference area and $C_d$ the **drag coefficient**, which packages the shape. Near the speed of sound shock waves form and $C_d$ rises sharply, the transonic drag rise, before easing off again at higher Mach numbers.

How strongly drag decelerates a body is measured by its **ballistic coefficient**

$$ \beta = \frac{m}{C_d A} $$

A dense, slender craft (high $\beta$) punches through the air. A light, blunt one (low $\beta$) slows down high up, which is exactly what a capsule wants.

## Lift

A wing at a small **angle of attack** $\alpha$ to the airflow produces a force perpendicular to the flow:

$$ L = \tfrac{1}{2}\rho v^2\,C_L\,S, \qquad C_L \approx C_{L\alpha}\,\alpha $$

linear in $\alpha$ up to the **stall**, where the flow separates and lift collapses. Making lift costs drag, the induced drag of the tip vortices:

$$ C_D = C_{D0} + K\,C_L^2 $$

Level flight needs $L = mg$, which gives the **stall speed**, the slowest a wing can carry the weight at its maximum lift coefficient:

$$ v_{stall} = \sqrt{\frac{2 m g}{\rho\,S\,C_{L,max}}} $$

It rises as the air thins. An aircraft flying at constant indicated load must fly faster and faster with altitude, until the engines or the heat give out.

The ratio $L/D$ is the glide ratio: metres forward per metre of height lost with the engines off. It peaks where the two drag terms are equal, at $C_L = \sqrt{C_{D0}/K}$.

> game: Wings use a lift-curve slope of 3.6 per radian up to the stall, the drag polar above with $K = 0.07$, and a flat-plate model beyond the stall. Each part has its own drag, with a transonic rise between Mach 0.7 and 1.1. Lift and drag act at each part's position, so a badly balanced aircraft pitches and stalls for real reasons. The next chapter sets out the whole model, part by part.

## Re-entry heating

A craft in low orbit carries kinetic energy $\tfrac{1}{2}v^2$ per kilogram. At orbital speed around ${home.name} that is ${sig(Math.pow(c.vcirc(home, c.parkAlt), 2) / 2e6, 3)} MJ/kg. Slowing down means getting rid of all of it, and the atmosphere takes it as heat. Almost all goes into the air in the shock wave ahead of the craft, a small fraction into the craft itself. For a blunt body the heat flux at the nose follows the Sutton-Graves relation:

$$ \dot{q} = k\sqrt{\frac{\rho}{R_n}}\;v^3 $$

with $R_n$ the nose radius. The cube of the speed is why re-entry from a transfer orbit is so much harsher than from low orbit, and the $1/\sqrt{R_n}$ is why heat shields are blunt: a rounder nose holds the shock farther off.

## The entry corridor

Deceleration during entry peaks at a height that depends on the scale height and the ballistic coefficient, and its peak value depends on the entry angle $\gamma_e$ and speed, but, remarkably, not on the craft (Allen and Eggers, 1950s):

$$ a_{max} = \frac{v_e^2\,\sin\gamma_e}{2\,e\,H} $$

Steep entries mean crushing g-forces and intense but brief heating. Shallow ones mean gentle forces and a long, hot soak, and too shallow means skipping back out into space. The usable band of periapsis altitudes between the two is the **entry corridor**.

> game: Heating flux is computed as $k\sqrt{\rho / R_n}\,v^3$ with $k = 1.7415 \times 10^{-4}$ for air, on each part's own nose radius, attitude and shadow, and each skin follows a heat balance (chapter 10 has the whole model). Parts have a maximum temperature and fail above it, parts behind a shield are protected by its shadow, and a heat shield ablates. Parachutes add a large drag area once they are open.
`;
    },
  },
  {
    id: 'landing', title: 'Landing without air',
    lead: 'The suicide burn, and the calculus of stopping exactly at the ground.',
    body: c => {
      const { moon, sig, int, km, vcirc } = c;
      const g = moon.surfaceG, a = 3 * g, v0 = 150;
      const hStop = v0 * v0 / (2 * (a - g));
      return String.raw`
## Deorbiting

On a world with no atmosphere every metre per second of orbital speed must be removed by the engine. From a low circular orbit a small retrograde burn drops the periapsis to the surface. The ship then falls along that ellipse, gaining speed, toward a point roughly half a lap later.

## The braking burn

Near the ground treat gravity as constant, $g$, and let the engine give a constant deceleration $a = F/m$ straight up. A ship descending at speed $v$ at height $h$ loses speed at the net rate $a - g$. From $v\,dv = -(a - g)\,dh$, integrating down to zero speed at zero height:

$$ h_{burn} = \frac{v^2}{2\,(a - g)} $$

Light the engine at full thrust exactly at this height and the ship stops exactly at the surface. Any earlier and it hovers, wasting propellant against gravity. Any later and it does not stop in time. This is the **suicide burn**, or more politely the hoverslam.

## Why late is cheap

The total delta-v of a descent is the speed to cancel plus the gravity loss, $g$ times the time the engine fires:

$$ \Delta v = v_0 + g\,t_{burn}, \qquad t_{burn} = \frac{v_0}{a - g} $$

A high thrust-to-weight ratio makes the burn short and the loss small. A cautious descent at a steady hover-like rate can double the cost. In practice a margin is kept: the mass falls during the burn, so the deceleration grows and a constant-thrust burn started at $h_{burn}$ actually stops a little high, which is the safe side.

> example: Descending on ${moon.name} ($g = ${sig(g, 2)}$ m/s²) at ${v0} m/s with an engine that gives $a = ${sig(a, 2)}$ m/s², three times local gravity: start the burn at $h = ${int(hStop)}$ m. It lasts ${(v0 / (a - g)).toFixed(0)} s and costs ${int(v0 + g * v0 / (a - g))} m/s. Low orbital speed there is ${int(vcirc(moon, 15000))} m/s, so the whole landing from orbit runs to a little over that.

## Horizontal speed first

Most of the speed at the start of a descent is horizontal. Thrusting retrograde (against the velocity, wherever it points) kills both components in the right proportion and brings the ship upright by itself as the path steepens: a gravity turn flown backwards. Touchdown wants a few metres per second vertical and nearly zero horizontal, since landing legs tolerate impact far better than sliding.

## Taking off again

Without air there is no reason to climb vertically for long. The cheapest ascent pitches over almost immediately and puts nearly everything into horizontal speed, clearing the terrain by a safe margin.

> game: The landing autopilot does this calculation continuously with the ship's current mass and thrust, using the height of the ground below, and ignites at the last safe moment with a margin. The map's impact marker is the point where the current conic meets the terrain.
`;
    },
  },
  {
    id: 'rendezvous', title: 'Rendezvous and docking',
    lead: 'Meeting another ship in orbit: phasing, then the strange relative motion of two craft close together.',
    body: c => {
      const { home, sig, int, km, dur, parkAlt, period, vcirc } = c;
      const r = home.radius + parkAlt, T = period(home.gm, r), n = TAU / T;
      const dr = 10000, Tlow = period(home.gm, r - dr / 2);
      return String.raw`
## Three steps

- **Same plane.** Match the target's orbital plane at a node (chapter 6), or launch into it.
- **Same place at the same time.** Phasing: adjust the orbit's period so the gap closes.
- **Same velocity.** Cancel the relative speed at closest approach, then creep in.

## Phasing

Two craft in the same circular orbit keep their separation for ever. To close a gap, change the period. From Kepler's third law, a small change in semi-major axis changes the period by

$$ \frac{\delta T}{T} = \frac{3}{2}\,\frac{\delta a}{a} $$

A lower orbit is a faster lap. The chaser drops below the target, gains on it a fixed amount per revolution, then raises its orbit again to arrive alongside.

> example: Around ${home.name} at ${km(parkAlt)} km, lowering one side of the orbit by ${km(dr)} km shortens the lap by ${(T - Tlow).toFixed(1)} s, a gain of ${km(vcirc(home, parkAlt) * (T - Tlow), 1)} km on the target every revolution.

## Relative motion close in

Within a few kilometres it is easier to work in a frame that rides along with the target: $x$ radially outward, $y$ along the orbit, $z$ across the plane. Linearising the two-body equation about the target's circular orbit of mean motion $n$ gives the **Clohessy-Wiltshire equations**:

$$ \ddot{x} - 2n\dot{y} - 3n^2 x = 0 $$

$$ \ddot{y} + 2n\dot{x} = 0 $$

$$ \ddot{z} + n^2 z = 0 $$

The cross-plane motion is a simple oscillation once per orbit. The in-plane motion is coupled by Coriolis terms, and its behaviour defies everyday intuition:

- Thrust *toward* the target along the orbit and the craft rises, slows relative to the target, and falls behind.
- Thrust away from the planet and half an orbit later the craft is back at its starting height, displaced along the orbit.
- A craft left at rest slightly above the target drifts backwards at the steady rate $\dot{y} = -\tfrac{3}{2} n\,x$.

The intuitive "point at it and thrust" only works over times much shorter than an orbit, $n t \ll 1$, where the equations reduce to straight-line motion. That is why the final approach is made slowly but not too slowly, in short pushes, re-aiming often.

> example: At ${km(parkAlt)} km above ${home.name}, $n = ${sig(n, 3)}$ rad/s. A chaser sitting 100 m above its target drifts back at ${(1.5 * n * 100).toFixed(2)} m/s. Over one minute that is ${int(1.5 * n * 100 * 60)} m, over a full orbit ${int(1.5 * n * 100 * T)} m.

## Closing speed

A common rule for the final approach keeps the closing speed proportional to the range, $v \approx d / \tau$, which gives an exponential approach that never arrives too fast. Docking ports want well under a metre per second at contact, aligned and with little sideways drift.

> game: The rendezvous planner sets up a phasing transfer and refines it against the true closest approach of the two orbits. Close in, the docking autopilot nulls the relative velocity with the RCS thrusters, aligns the two ports and closes at a speed that falls with distance. The target marker on the navigation ball shows relative velocity, which is the quantity to cancel.
`;
    },
  },
  {
    id: 'numerics', title: 'How the game computes all this',
    lead: 'Two methods, chosen for what each is good at, and an honest list of what is left out.',
    body: c => {
      const { home, star, sig } = c;
      return String.raw`
## Two regimes

A ship coasting in vacuum obeys the two-body equation exactly, and chapter 4 gives its position at any time in closed form. A ship under thrust or in air does not: thrust and drag change from moment to moment. Starwright uses the right tool for each.

- **On rails.** Coasting ships, and every ship during time warp, are advanced by evaluating their conic at the new time. There is no step size and no error to accumulate. A ship can coast for years at a hundred thousand times normal speed and arrive where the mathematics says.
- **Physics steps.** Under thrust, in an atmosphere, or on the ground, the forces are added up and the motion is integrated numerically in small steps: 20 ms under thrust or in air, 100 ms coasting in vacuum at normal speed.

## Why not simply add velocity times the time step

The obvious method, **explicit Euler**, updates position with the old velocity and velocity with the old acceleration:

$$ \mathbf{r}_{k+1} = \mathbf{r}_k + \mathbf{v}_k\,\Delta t, \qquad \mathbf{v}_{k+1} = \mathbf{v}_k + \mathbf{a}(\mathbf{r}_k)\,\Delta t $$

Applied to an orbit, it steadily *adds* energy. Each step moves along the tangent, which always ends slightly outside the true curve, and the errors never cancel. A circular orbit spirals outward and the apoapsis creeps up for no reason.

## Leapfrog

Starwright uses the **kick-drift-kick leapfrog** (velocity Verlet). Half a velocity update, a full position update, then the other half with the new acceleration:

$$ \mathbf{v}_{k+1/2} = \mathbf{v}_k + \mathbf{a}(\mathbf{r}_k)\,\frac{\Delta t}{2} $$

$$ \mathbf{r}_{k+1} = \mathbf{r}_k + \mathbf{v}_{k+1/2}\,\Delta t $$

$$ \mathbf{v}_{k+1} = \mathbf{v}_{k+1/2} + \mathbf{a}(\mathbf{r}_{k+1})\,\frac{\Delta t}{2} $$

It costs the same single force evaluation per step, but it is second-order accurate (halving the step quarters the error) and, more importantly, **symplectic**: it exactly conserves a quantity very close to the true energy. The orbit's energy wobbles slightly within each lap and does not drift. It is also time-reversible, like the physics it imitates.

> game: Under thrust the mass changes during the step, so the acceleration from the engine uses the mass at the middle of the step. With that, the delta-v gained over a burn matches the rocket equation. The moment a ship stops thrusting in vacuum and time warp is engaged, its state is converted to orbital elements and it goes back on rails.

## Rotation

A ship's attitude is a unit **quaternion** $q$, four numbers that represent a rotation with no singularities (unlike three angles, which lose a degree of freedom when two axes line up, the "gimbal lock"). The attitude follows the angular velocity $\boldsymbol{\omega}$ by

$$ \dot{q} = \tfrac{1}{2}\,q\,\boldsymbol{\omega} $$

and the angular velocity follows the torques through the moment of inertia, Euler's equation $I\dot{\boldsymbol{\omega}} = \boldsymbol{\tau} - \boldsymbol{\omega}\times I\boldsymbol{\omega}$.

## Finding events

A step-by-step simulation can jump straight over a thin event, such as the instant of crossing a sphere of influence or touching the ground. Crossings are found by bracketing the moment the sign of a distance function changes and bisecting to it. Encounters with moons and planets on the map are found by searching the predicted conics for the closest approach and refining it.

## What is left out, on purpose

- **N-body gravity.** Only one body attracts at a time (chapter 7). No Lagrange points, no perturbation of a low orbit by a moon, no slow precession.
- **The planets do not feel each other.** They run on fixed ellipses about their parent, set by the parent's $\mu$ alone.
- **Non-spherical gravity.** Real planets bulge at the equator, which makes real orbits precess. Here every world's field is that of a point.
- **Relativity, radiation pressure, tides.** All far below what a flight in this system could notice.

What is kept is checked. An independent suite compares the game against textbook results: conservation of energy and angular momentum, Kepler's third law, vis-viva, the rocket equation, Hohmann transfers, sphere-of-influence patching and atmospheric flight, 861 checks in all. It is described in docs/PHYSICS_VERIFICATION.md.

## Scale

Starwright's system is deliberately small. ${home.name} has a radius of ${c.km(home.radius)} km and a surface gravity of ${sig(home.surfaceG, 2)} m/s², which makes it far denser than any real rocky planet. Low orbit takes ${c.int(c.vcirc(home, c.parkAlt))} m/s where Earth needs about 7,800. The mathematics is unchanged. Only the numbers are friendlier: an ascent takes minutes and a trip to the moon an afternoon.

## Going further

Everything here is standard astrodynamics. Good next steps are any university text on orbital mechanics (Bate, Mueller and White's *Fundamentals of Astrodynamics* is the classic short one, Curtis's *Orbital Mechanics for Engineering Students* a fuller modern one) and, for flight in air, Anderson's *Introduction to Flight*.
`;
    },
  },
];

// the game's own flight model, structure and breakup follow the textbook chapter on flight through air
CHAPTERS.splice(CHAPTERS.findIndex(c => c.id === 'atmosphere') + 1, 0, ...AERO_CHAPTERS);

/** Split a chapter body into blocks: { type: 'h' | 'p' | 'eq' | 'li' | 'game' | 'example' | 'calc', text }. */
export function parseBody(src) {
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
  for (const raw of String(src).split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    let m;
    if ((m = /^## (.+)$/.exec(line))) { flush(); blocks.push({ type: 'h', text: m[1] }); }
    else if ((m = /^\$\$ (.+) \$\$$/.exec(line))) { flush(); blocks.push({ type: 'eq', text: m[1] }); }
    else if ((m = /^- (.+)$/.exec(line))) { flush(); blocks.push({ type: 'li', text: m[1] }); }
    else if ((m = /^> (game|example): (.+)$/.exec(line))) { flush(); blocks.push({ type: m[1], text: m[2] }); }
    else if ((m = /^\[\[calc:(\w+)\]\]$/.exec(line))) { flush(); blocks.push({ type: 'calc', text: m[1] }); }
    else para.push(line);
  }
  flush();
  return blocks;
}

/** Split running text into spans: { math } | { b } | { i } | { t }. */
export function parseInline(text) {
  const out = [];
  const re = /\$([^$]+)\$|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ math: m[1] });
    else if (m[2] !== undefined) out.push({ b: m[2] });
    else out.push({ i: m[3] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}
