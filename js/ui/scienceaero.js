// Starwright — the science reference, chapters on the game's own aerodynamics, structural loads and aerodynamic
// breakup (js/ui/sciencetext.js places them after "Flight through air"; the markup is described there).
// Every constant in the text is read from the flight code when the chapter is drawn (ctx.aero below), so the
// reference cannot drift from js/core/vessel.js, js/core/structure.js and js/core/parts.js. The same mathematics is
// set out for developers in README.md (Aerodynamics), docs/STRUCTURE.md and docs/AERO_BREAKUP.md.
// Pure data and string work: imported by the unit tests in Node.
import { TUNING, wingCoefficients } from '../core/vessel.js';
import { STRUCT, rootSection } from '../core/structure.js';
import { AIR_RATING, PARTS } from '../core/parts.js';
import { MAX_DEBRIS } from '../core/world.js';
import * as AERO from '../core/aero.js';

const DEG = 180 / Math.PI;

/**
 * The single transonic drag multiplier that wings, fins and open panels still use (js/core/vessel.js `_stepFlight`),
 * as a function of Mach number. Bodies use the two curves of js/core/aero.js (`dragRise`).
 */
export function machRise(mach) {
  const P = TUNING.MACH_PEAK, H = TUNING.MACH_HIGH;
  return mach <= 0.7 ? 1 : mach < 1.1 ? 1 + (mach - 0.7) * 2.5 * (P - 1) : mach < 2.5 ? P + (mach - 1.1) / 1.4 * (H - P) : H;
}

/** What the reference calls each class of air-rated part (keys of parts.js AIR_RATING). */
const RATED_NAMES = {
  solar: 'Sunfoil panel, open', solar_wing: 'Sunfoil Wing, open', solar_grand: 'Sunfoil Grand Array, open',
  antenna: 'whip antenna', antenna_dish: 'dish antenna', antenna_bigdish: 'large dish',
  nose: 'nose cone', fairing: 'shroud nose (fairing)', radialdec: 'radial release clamp, pin or truss',
};

/** The numbers of the flight model the chapters quote, read from the game's own code. */
export function aeroModel() {
  const rated = Object.entries(AIR_RATING).map(([key, r]) => ({ key, name: RATED_NAMES[key] || key, q: r.q, open: r.flow === 'open' }))
    .sort((a, b) => (a.open === b.open ? a.q - b.q : a.open ? -1 : 1));
  /** Seconds a part lasts at dynamic pressure q against a rating (Infinity at or under it). */
  const tearTime = (q, rating) => q > rating ? STRUCT.AIR_FAIL_TIME / (q / rating - 1) : Infinity;
  /** Strength of a plain ring joint of radius r: pull apart (N), crush (N), bend (N·m). */
  const ring = r => ({ r, pull: STRUCT.LINE_T * 2 * Math.PI * r, crush: STRUCT.LINE_C * 2 * Math.PI * r, bend: STRUCT.LINE_T * Math.PI * r * r });
  /** A fin or wing part: its root, the flat-wise moment the root stands, and the face-on force per pascal. */
  const fin = id => {
    const d = PARTS[id], w = d.fin || d.wing, sec = rootSection(d.h, d.t);
    const factor = STRUCT.MOUNT_FACTOR[d.fin ? 'fin' : d.shape] || 1;
    const cd90 = wingCoefficients(Math.PI / 2)[1];
    return { name: d.name, h: d.h, t: d.t, width: d.rw, area: w.area, sec, factor, capM: STRUCT.LINE_T * factor * sec.zFlap, cd90, arm: d.rw / 2 };
  };
  return { TUNING, STRUCT, PARTS, MAX_DEBRIS, AERO, rated, machRise, wingCoefficients, rootSection, tearTime, ring, fin, DEG };
}

export const AERO_CHAPTERS = [
  {
    id: 'aeromodel', title: 'The air on every part: Starwright\'s flight model',
    lead: 'There is no single drag number for a rocket. The flow, the force and its lever arm are worked out part by part, and stability, control and max Q all fall out of one sum.',
    body: c => {
      const { home, sig, int, km, TAU } = c, A = c.aero, T = A.TUNING, at = home.atmo;
      const vrot = TAU * home.radius / home.rotPeriod;
      const tank = A.PARTS.tank_m400, face = Math.PI * tank.r * tank.r * tank.drag.top, side = 2 * tank.r * tank.h * tank.drag.side;
      const q0 = 20000;
      const fin = A.PARTS.fin, a5 = 5 / DEG, cf = A.wingCoefficients(a5, T.FIN_LIFT, T.FIN_STALL, [0, 0]);
      const rho8 = at.rho0 * Math.exp(-8000 / at.scale), q8 = 0.5 * rho8 * 300 * 300;
      const plateMax = T.WING_CD0 + T.WING_PLATE_CD;
      const AE = A.AERO, row = ys => ys.map(y => y.toFixed(2)).join(' | ');
      const phi = T.CAP_PHI / DEG, capCd = (1 + Math.cos(phi) ** 2) / 2;
      // lift over drag of a spherical cap held 20 degrees off, from its Newtonian axial and normal coefficients
      const al = 20 / DEG, capCA = Math.cos(al) ** 2 * capCd + Math.sin(al) ** 2 * Math.sin(phi) ** 2 / 4, capCN = Math.sin(phi) ** 2 / 2 * Math.sin(al) * Math.cos(al);
      const capLD = (capCA * Math.sin(al) - capCN * Math.cos(al)) / (capCA * Math.cos(al) + capCN * Math.sin(al));
      const pod = A.PARTS.pod_acorn, podLow = pod.drag.bottom + AE.WAKE * pod.drag.top;
      return String.raw`
## One model, summed over the parts

The last chapter gave the textbook forces on a body in air. This one sets out exactly what Starwright computes. Every part of a vessel meets the air on its own, ${Math.round(1 / T.DT_MAX)} times a second while in an atmosphere, in five steps:

- **The air.** Its density at the vessel's height, and the speed of the vessel through air that turns with the planet.
- **The flow at each part.** A part away from the centre of mass also moves with the vessel's spin, so a tumbling rocket sees different air at its nose and at its tail.
- **The force on each part,** by kind: bodies (tanks, capsules, engines) take drag on their end faces and on their sides, wings and fins take lift and drag from an angle of attack, small attached parts take plain drag.
- **The sum.** Each force is applied where its part is, so the forces add to one net force and one net torque about the centre of mass. Nothing else decides whether a rocket flies straight.
- **What follows.** The same per-part forces feed the loads in the joints (next chapter), the limits that tear thin parts off (the chapter after), and re-entry heating.

## The air, and the wind of the planet's spin

Density is the exponential of chapter 9, cut off at a fixed top:

$$ \rho(h) = \rho_0\,e^{-h/H} \quad (h < h_{top}), \qquad \rho = 0 \text{ above} $$

The atmosphere turns with its planet. With $\mathbf{Ω}$ the planet's spin and $\mathbf{r}$ the position from its centre, the velocity that matters to the air is not the orbital velocity $\mathbf{v}_{orb}$ but

$$ \mathbf{v} = \mathbf{v}_{orb} - \mathbf{Ω}\times\mathbf{r} $$

> example: On ${home.name}'s equator the ground and the air move east at $2\pi R / T_{rot} = ${int(vrot)}$ m/s. A rocket on the pad has that orbital speed and an airspeed of zero. A capsule coming back from an eastward orbit meets the air ${int(vrot)} m/s slower than its orbital speed says, and one from a westward orbit ${int(vrot)} m/s faster.

## The flow at each part

A vessel turning at angular velocity $\mathbf{ω}$ carries a part at position $\mathbf{r}_i$ from its centre of mass through the air at its own velocity, and each part has its own dynamic pressure:

$$ \mathbf{v}_i = \mathbf{v} + \mathbf{ω}\times\mathbf{r}_i, \qquad q_i = \tfrac{1}{2}\rho\,|\mathbf{v}_i|^2 $$

Flying straight, every part sees the same flow. In a tumble they do not: a nose cone 15 m from the centre of mass of a ship spinning at 1 rad/s moves 15 m/s across the flow that the middle of the ship sees. This one term is what damps a rocket's wobble (below) and what makes the far ends of a tumbling ship the first to go.

## Bodies: end faces and sides

A tank, capsule or engine is treated as a body of revolution. Let $\theta$ be the angle between its axis and the flow at that part. It has three drag areas, each a real area times a coefficient for the shape: the end face that meets the wind $A_w$, the end face in the lee $A_l$, and the side $A_s$. Along its axis:

$$ F_{axial} = -\,q_i\,\left(M_w\,A_w + k_{wake}\,M_l\,A_l\right)\cos\theta $$

The leeward face adds a fraction $k_{wake}$ of its area, ${AE.WAKE} at low speed: that is base drag, the suction of the wake. $M_w$ and $M_l$ are the drag rise of each face with Mach number (below); both are 1 below Mach 0.7. Across its axis, with $\mathbf{v}_{i,\perp}$ the part of the flow at right angles to the axis:

$$ \mathbf{F}_{side} = -\,q_i\,M_{blunt}\,A_s\,\frac{\mathbf{v}_{i,\perp}}{|\mathbf{v}_i|} $$

Only the exposed part of an end face counts. A tank in the middle of a stack has both faces covered by its neighbours and adds side area only, a tank wider than the one above it shows a ring of face, and the sloping flank of a cone counts toward the end it faces. A pointed nose has a low coefficient (${A.PARTS.nose_m.drag.top} for the ${A.PARTS.nose_m.name}), a flat end a high one (${tank.drag.top}).

A blunt face that leads also gets a small righting moment (its centre of pressure shifts toward the windward edge) and resists pitching. That is why a capsule settles heat shield first.

Small attached parts (antennas, lights, legs, ladders) take plain drag on one small area, straight against the flow at that part.

> example: A bare ${tank.name} (${tank.h} m long, ${(2 * tank.r).toFixed(2)} m wide) has a face area of $${sig(face, 3)}$ m² and a side area of $${sig(side, 3)}$ m² after their coefficients. At a dynamic pressure of ${q0 / 1000} kPa below Mach 0.7, flying end on it feels $${sig(q0 * face * (1 + T.BASE_DRAG) / 1000, 3)}$ kN of drag. Broadside it feels $${sig(q0 * side / 1000, 3)}$ kN.

## The drag rise: blunt and slender

Near the speed of sound shock waves form and drag climbs steeply. What happens next depends on the shape. A blunt face keeps a strong shock standing ahead of it and its drag stays high for good. A pointed one sweeps its shock back into a thin cone and its drag falls again. So a body face reads one of two curves, each a multiplier on the face's low-speed coefficient against the Mach number $\mathrm{Ma} = v / c_s$:

${AE.DRAG_MACH.map((m, i) => `- Mach ${m}: blunt $${AE.DRAG_BLUNT[i].toFixed(2)}$, slender $${AE.DRAG_SLENDER[i].toFixed(2)}$`).join('\n')}

Both are 1 below Mach 0.7, run in straight lines between these points and hold their last value above Mach 8. A face whose coefficient is 0.2 or less (a nose cone) reads the slender curve, one of 0.7 or more (a flat end, a heat shield) the blunt curve $M_{blunt}$, and one in between a mix in proportion. The side of a body always reads the blunt curve: a cylinder across the flow is a blunt shape.

The wake changes too. The suction behind a body can never be more than the whole pressure of the air around it, and measured against the dynamic pressure that limit shrinks as the square of the Mach number. So

$$ k_{wake} = ${AE.WAKE} \quad (\mathrm{Ma} \le 1), \qquad k_{wake} = \frac{${AE.WAKE}}{\mathrm{Ma}^2} \quad (\mathrm{Ma} > 1) $$

At Mach 5 the wake behind a capsule adds one percent of the lee face, not a quarter.

## Above Mach ${AE.NEWTON_FROM}: the air as a stream of particles

At several times the speed of sound the shock lies close against the body, and Newton's old picture of the air becomes a good one: a stream of particles that hit the surface and give up the part of their momentum that is normal to it. A patch of surface whose outward normal $\mathbf{n}$ makes an angle with the direction of motion $\mathbf{u}$ feels the pressure coefficient

$$ C_p = C_{p,max}\,(\mathbf{n}\cdot\mathbf{u})^2 \quad \text{where it faces the flow}, \qquad C_p = 0 \text{ in the lee} $$

$C_{p,max}$ is the pressure at the stagnation point behind a normal shock, from the Rayleigh pitot formula. For air it is $${sig(AE.pitotCp(2, 1.4), 3)}$ at Mach 2, $${sig(AE.pitotCp(4, 1.4), 3)}$ at Mach 4 and $${sig(AE.pitotCp(8, 1.4), 3)}$ at Mach 8, and it tends to 1.839. The game adds this pressure up over the real surface of every body part: its flank, whatever is open of each end, and the rounded face of a heat shield or capsule (a spherical cap of ${T.CAP_PHI}° half-angle). Below Mach ${AE.NEWTON_FROM} only the face-and-side law above is used, above Mach ${AE.NEWTON_FULL} only this one, and between the two are mixed smoothly.

Three things follow, and each can be worked by hand:

- **A flat face** head on has $C_D = C_{p,max}$, and **a rounded heat shield** $C_D = C_{p,max}\,(1 + \cos^2\varphi)/2$, which is $${sig(capCd, 3)}\,C_{p,max}$ for the ${T.CAP_PHI}° cap.
- **A cylinder across the flow** has $C_D = \tfrac{2}{3}\,C_{p,max}$ on its length times its width. At an angle of attack $\alpha$ its side force goes as $\sin^2\alpha$, not as $\sin\alpha$: a tank leaning a few degrees feels almost no side force. Cones and noses keep a side force in proportion to the lean. A long rocket is therefore less steady above Mach ${AE.NEWTON_FULL} than below Mach 1, and its nose and fins decide which way it wants to turn.
- **A capsule held at an angle lifts**, and away from the side it leans to, the opposite of a wing: the pressure on the heat shield pushes along the shield's own axis. Held 20° off, the ${T.CAP_PHI}° cap gives a lift of $${sig(capLD, 2)}$ times its drag.

> example: The ${pod.name} falling heat shield first. Below Mach 0.7 its drag coefficient on its base area is $${pod.drag.bottom} + ${AE.WAKE} \times ${pod.drag.top} = ${sig(podLow, 3)}$. At Mach 8 it is $${sig(capCd, 3)} \times ${sig(AE.pitotCp(8, 1.4), 4)} = ${sig(capCd * AE.pitotCp(8, 1.4), 3)}$, and the wake adds almost nothing.

## Shadow

Above the speed of sound a part cannot feel the air that a wider part ahead of it has already pushed aside. A part that lies wholly inside the wake of a wider body part upstream keeps ${AE.SHADOW_KEEP * 100}% of its force above Mach ${AE.SHADOW_FULL}; the shelter fades in from Mach ${AE.SHADOW_FROM}. The wake is a tube the width of the part that casts it, running back along the motion. It is whole for ${AE.SHADOW_NEAR} of that part's diameters and has closed by ${AE.SHADOW_FAR}. A part whose windward edge stands half its own radius out of the tube is in the open again. This is why a stage behind a wide heat shield feels little, and why it stops being true the moment the vessel turns sideways.

> game: What this model leaves out. Shock waves from one part do not strike another, there is no skin friction or flow separation, and the air stays an ideal gas however hot it gets. Newton's law is good to a few percent for blunt shapes above Mach 4 and overstates the drag of slender ones, which is why slender faces keep their own curve below that. Wings, fins and open panels still use one simpler curve $M$ (1 below Mach 0.7, ${T.MACH_PEAK.toFixed(1)} at Mach 1.1, ${T.MACH_HIGH} above Mach 2.5); their supersonic behaviour is a later step. Below Mach 0.7 nothing in this chapter differs from the low-speed law.

## The speed of sound

The speed of sound is not one number. It follows from the gas and its temperature, $c_s = \sqrt{\gamma R T / M_{gas}}$, with $\gamma$ the ratio of specific heats, $R$ the gas constant and $M_{gas}$ the molar mass. Hydrostatics ties a world's temperature to the scale height it already has, $T_{iso} = M_{gas}\, g\, H / R$, so for air that is all at one temperature $c_s = \sqrt{\gamma g H}$: a heavy gas or a shallow atmosphere means slow sound, and the same speed is a higher Mach number.

> example: ${home.name}'s air (γ 1.40) with $g = ${sig(home.surfaceG, 3)}$ m/s² and $H = ${int(at.scale)}$ m gives $\sqrt{\gamma g H} = ${int(at.aIso)}$ m/s. The temperature profile warms the surface and cools the middle layer, so sound travels at ${int(home.soundSpeed(0))} m/s on the ground, ${int(home.soundSpeed(2 * at.scale))} m/s at ${km(2 * at.scale)} and ${int(home.soundSpeed(at.height))} m/s at the top. A rocket at ${int(home.soundSpeed(2 * at.scale))} m/s is at Mach 1 up there and only Mach ${sig(home.soundSpeed(2 * at.scale) / home.soundSpeed(0), 2)} on the pad.

> game: Each world has its own gas: air on ${home.name} and Marn, carbon dioxide on Murk and Rusk, hydrogen and helium on Thal and Orrin. The temperature profile has one shape for every world (warm ground, cold middle, a warm layer above, as on Earth) scaled to that world's own $T_{iso}$. Every Mach number in this chapter is the true one for that gas at that height.

## Wings and fins

A lifting surface of area $S$ feels only the flow in the plane of its chord and its normal. With $v_c$ the flow along the chord and $v_n$ the flow through the surface, the angle of attack is

$$ \alpha = \arctan\frac{-v_n}{v_c} $$

While the flow is attached, lift grows in proportion to it and drag follows the polar of chapter 9:

$$ C_L = a\,\alpha, \qquad C_D = ${T.WING_CD0} + ${T.WING_K}\,C_L^2 $$

The lift-curve slope $a$ is ${T.WING_SLOPE} per radian for a wing and ${T.FIN_LIFT} for a fin, which is short and stubby. Lift acts at right angles to the flow and drag along it:

$$ L = \tfrac{1}{2}\rho v^2\,S\,C_L, \qquad D = \tfrac{1}{2}\rho v^2\,S\,C_D\,M(\mathrm{Ma}) $$

Here $M(\mathrm{Ma})$ is the one drag-rise curve that lifting surfaces and open panels keep: 1 below Mach 0.7, a straight line up to ${T.MACH_PEAK.toFixed(1)} at Mach 1.1, down to ${T.MACH_HIGH} at Mach 2.5 and level above.

Past the stall the flow separates and the surface behaves as a flat plate:

$$ C_L = ${T.WING_PLATE}\,\sin 2\alpha, \qquad C_D = ${T.WING_CD0} + ${T.WING_PLATE_CD}\,\sin^2\alpha $$

The stall angle is ${(T.WING_STALL * DEG).toFixed(0)}° for a wing and ${(T.FIN_STALL * DEG).toFixed(0)}° for a fin. The game blends smoothly from the attached formulas to the flat plate between 0.85 and 1.35 times that angle, so there is no jump. The flat plate holds at every angle: broadside, a surface makes no lift and its full plate drag, $C_D = ${sig(plateMax, 4)}$. A wing flying backwards still lifts, at half its slope.

> example: A ${fin.name} ($S = ${fin.fin.area}$ m²) at 5° to the flow at ${q0 / 1000} kPa: $C_L = ${T.FIN_LIFT} \times ${sig(a5, 3)} = ${sig(cf[0], 3)}$, so the lift is $${sig(q0 * fin.fin.area * cf[0] / 1000, 3)}$ kN, with $${sig(q0 * fin.fin.area * cf[1], 3)}$ N of drag. Four of them at the foot of a rocket are a strong hand on the tail.

## Control surfaces

A steering vane, elevon or canard works by changing its own angle of attack. With the pilot's command $u$ between −1 and 1:

$$ \alpha_{eff} = \alpha + \tau\,\delta_{max}\,u $$

The full throw $\delta_{max}$ is ${(T.CTRL_DEFLECT * DEG).toFixed(0)}°. An all-moving surface has $\tau = 1$. A hinged flap on a fixed wing turns only part of the surface and counts for $\tau = ${T.CTRL_TAU}$. Control authority is therefore proportional to dynamic pressure: fins steer hard at max Q and not at all in vacuum, where the engine gimbal and the reaction wheels take over.

## The sum, and why a rocket flies straight

The forces on the parts add to the force and the torque that move the vessel:

$$ \mathbf{F} = \sum_i \mathbf{F}_i, \qquad \mathbf{τ} = \sum_i \mathbf{r}_i\times\mathbf{F}_i $$

That is the whole model. There is no stability rule in the code. To see why a rocket with fins still flies straight, tip it a small angle $\beta$ off the flow and let it turn at rate $\omega$. Part $i$, a distance $\ell_i$ behind the centre of mass, sees a sideways flow $v\beta + \omega\ell_i$, and to first order feels a side force $q\,k_i$ times that flow over $v$. Here $k_i$ is its side area $M A_s$ for a body, or $S\,a$ for a fin. Taking moments about the centre of mass:

$$ \tau = -\,q\left(\sum_i k_i\,\ell_i\right)\beta \;-\; \frac{q}{v}\left(\sum_i k_i\,\ell_i^2\right)\omega $$

The first term is a spring. It pulls the nose back into the flow when $\sum k_i \ell_i$ is positive, which says that the **centre of pressure**, the area-weighted middle of the side forces, lies behind the centre of mass:

$$ \ell_{cp} = \frac{\sum_i k_i\,\ell_i}{\sum_i k_i} > 0 $$

Fins at the tail add a large $k$ at a large $\ell$. A heavy engine at the bottom with an empty tank above moves the centre of mass back toward them and takes the margin away, and with the centre of pressure ahead the spring pushes the wrong way and the rocket swaps ends. The second term is a damper, always opposing the turn, and it comes entirely from the $\mathbf{ω}\times\mathbf{r}_i$ term in the flow. Together they make a weathervane that swings at a frequency rising with the square root of the dynamic pressure, for a vessel of moment of inertia $I$:

$$ \omega_n = \sqrt{\frac{q\,\sum_i k_i\,\ell_i}{I}} $$

> game: These last three formulas are an explanation, not code. The game only ever evaluates the per-part forces and the two sums, at whatever angle the vessel is at, stalled fins and all. In the Assembly Hangar the CoM and CoL markers show the centre of mass and the centre of lift of the wings and fins. Keep the lift behind the mass.

## What follows from the same sum

- **Max Q is a place, not a script.** $q$ peaks during the climb because speed rises while density falls. At 8 km and 300 m/s above ${home.name} it is $\tfrac{1}{2}\times${sig(rho8, 3)}\times 300^2 = ${sig(q8 / 1000, 3)}$ kPa. Every force in this chapter is proportional to it, so that is where a hard turn does the most.
- **Loads.** The force on each part is booked to that part, so the game knows what every joint is carrying (next chapter).
- **Breakup.** The flow across each thin part is compared with what it is rated for (the chapter after).
- **Debris flies.** A torn-off booster keeps the drag of its own parts and tumbles on under this same model.

Heating uses the flux law of chapter 9 on the vessel's speed, and each part's skin moves toward an equilibrium temperature set by how squarely it faces the flow (its exposure $x$, from 0 to 1):

$$ \dot{q} = ${sig(T.HEAT_FLUX_K, 3)}\,\sqrt{\rho}\;v^3, \qquad T_{eq} = ${T.AMBIENT_T} + ${T.HEAT_K.toFixed(2)}\,(\dot{q}\,x)^{${T.HEAT_EXP}} $$

with $\dot{q}$ in W/m² and $T$ in kelvin. A leading face has an exposure up to 1, a flank at most ${T.SIDE_EXPOSURE}, and nothing heats below ${int(T.HEAT_MIN_FLUX)} W/m².

## What the model leaves out

- One scale height per atmosphere, no weather and no wind.
- One temperature profile shape for every world. The density stays a single exponential and does not follow the temperature profile; the top 8% of each atmosphere fades smoothly to nothing in place of a step.
- Below Mach 1.5 capsules, tanks and debris make no lift of their own shape beyond the side force above; from there up the Newtonian pressure gives a tilted capsule lift, but it cannot yet hold a tilt by itself.
- Below Mach 0.7 parts do not shield each other from the flow, and above it only a part wholly behind a wider body part is sheltered: a booster beside the core feels the same air as one in front. (For heating, a covered end face is protected.)
- No shock or boundary-layer model beyond the flux law, and no flutter or buckling. Thin parts carry a stated air rating instead (two chapters on).

> game: What has been checked independently: density and pressure against the scale height on all six atmospheres, a capsule drop against a separately integrated reference (0.9 m apart after a 5.4 km fall), terminal velocity, and a re-entry whose peak heat flux came out at 126.7 kW/m² against a reference of 126.6. The method is in the project's physics verification document.
`;
    },
  },
  {
    id: 'structure', title: 'Loads in the structure: joints that carry, bend and break',
    lead: 'A rocket is parts bolted together. Newton\'s second law, applied to the piece on the far side of each joint, says exactly what that joint must carry.',
    body: c => {
      const { sig, int, G0 } = c, A = c.aero, S = A.STRUCT;
      const sizes = [['S', 0.3125], ['M', 0.625], ['L', 1.25], ['XL', 1.875]].map(([n, r]) => ({ n, ...A.ring(r) }));
      const M = sizes[1], comp = 200e3, nPre = comp / (2 * Math.PI * M.r), bendPre = (S.LINE_T + nPre) * Math.PI * M.r * M.r;
      const mUp = 5000, gs = 3, load = mUp * gs * G0;
      const MN = x => sig(x / 1e6, 2), kNpm = x => int(x / 1000);
      return String.raw`
## A rigid body that knows its own loads

A vessel in Starwright flies as one rigid body: the trajectory is that of its total mass, force and torque, which is why adding structural loads changed no orbit. On top of that, every physics step, the game asks of each joint between two parts: for the vessel to be moving as it is, what must be passing through here? For a rigid body that question has an exact answer.

## The free-body cut

Cut the vessel at a joint and look at the piece on the far side from the command pod, the set of parts $S$. Each part $i$ in it has mass $m_i$, sits at $\mathbf{r}_i$ from the vessel's centre of mass, and feels its own outside force $\mathbf{F}_i$: its drag, lift, thrust, parachute pull or ground contact. The vessel turns at $\mathbf{ω}$ with angular acceleration $\mathbf{α}$, and its centre of mass accelerates at $\mathbf{f}$ beyond what gravity alone would give (the **specific force**, total non-gravitational force over total mass). So part $i$ accelerates, gravity aside, at

$$ \mathbf{a}_i = \mathbf{f} + \mathbf{α}\times\mathbf{r}_i + \mathbf{ω}\times(\mathbf{ω}\times\mathbf{r}_i) $$

The three terms are the push on the whole ship, the whip of an angular acceleration and the centrifugal pull of a spin. The piece $S$ can only move this way if the joint supplies whatever its own outside forces do not:

$$ \mathbf{F}_J = \sum_{i \in S}\left(m_i\,\mathbf{a}_i - \mathbf{F}_i\right) $$

The moment the joint carries, taken about the joint's own position $\mathbf{p}$, follows the same way, with $\mathbf{T}_i$ the torque of part $i$'s outside forces about the centre of mass and $\mathbf{I}_i$ the part's own inertia:

$$ \mathbf{M}_J = \sum_{i \in S}\left(\mathbf{r}_i\times m_i\mathbf{a}_i + \mathbf{I}_i\mathbf{α} + \mathbf{ω}\times\mathbf{I}_i\mathbf{ω} - \mathbf{T}_i\right) - \mathbf{p}\times\mathbf{F}_J $$

This is Newton's second law and Euler's equation for the piece, nothing more. It is not an approximation of the rigid vessel.

## Only differences load a joint

Gravity pulls on every kilogram alike, so it appears nowhere above: a ship coasting in orbit, or falling freely, has no load in any joint. What loads a joint is a force that acts on one side and has to be passed to the mass on the other.

> example: A ${int(mUp / 1000)} t upper stage rides on a booster pulling ${gs} g. Nothing pushes on the upper stage but the joint beneath it, so that joint carries $m f = ${int(mUp)} \times ${sig(gs * G0, 3)} = ${int(load / 1000)}$ kN of compression. At burn-out the rocket is lightest, $f$ is highest, and this load peaks.

The same reasoning explains a surprise. A side booster caught in a cross-wind is pushed sideways, but so is the core. The clamp between them carries only the difference between the two drag decelerations, which is small. Steady air load alone does not rip boosters off (next chapter).

## The joint as a thin ring

A joint is modelled as a thin bolted ring of radius $r$, the radius of the smaller of the two faces that meet. Resolve the joint's force and moment along and across its axis: axial force $N$ (tension positive), shear $V$, twist $M_t$ and bending $M_b$. What matters to a ring of bolts is the load per metre of rim. An axial force spreads evenly round the circumference $2\pi r$. A bending moment loads one side in tension and the other in compression, and for a thin ring, whose second moment of area is $\pi r^3$ per unit of wall thickness, the peak is $M_b / \pi r^2$. So the peak line loads in tension and compression are

$$ n_t = \frac{N}{2\pi r} + \frac{M_b}{\pi r^2}, \qquad n_c = -\frac{N}{2\pi r} + \frac{M_b}{\pi r^2} $$

Shear peaks on the sides of the ring at $V / \pi r$, and a twist adds Bredt's shear flow for a closed section, torque over twice the enclosed area:

$$ q_s = \frac{V}{\pi r} + \frac{M_t}{2\pi r^2} $$

Each is compared with what the joint allows, and the largest ratio is the joint's **utilisation**, the percentage on the Structure read-out:

$$ u = \max\left(\frac{n_t}{c_T},\; \frac{n_c}{c_C},\; \frac{q_s}{c_S}\right) $$

> game: A plain joint allows $c_T = ${kNpm(S.LINE_T)}$ kN/m in tension, $c_C = ${kNpm(S.LINE_C)}$ kN/m in compression and $c_S = ${kNpm(S.LINE_S)}$ kN/m in shear. Compression is carried four times better because the faces bear on each other and the bolts only have to carry tension. A separator is weaker (${S.FACTOR.decoupler} of this) and a docking port weaker still (${S.FACTOR.dock}). Side mounts for boosters are thrust fittings and far stronger (${S.MOUNT_FACTOR.radialdec} for a release clamp, ${S.MOUNT_FACTOR.pylon} for a pylon).

## Width is strength

Put the allowables into the ring formulas and a plain joint of each stack size stands:

${sizes.map(z => String.raw`- **${z.n}** ($r = ${z.r.toFixed(2)}$ m): pull apart ${MN(z.pull)} MN, crush ${MN(z.crush)} MN, bend ${MN(z.bend)} MN·m.`).join('\n')}

Pulling and crushing strength grow with the radius, bending strength with its square: a joint twice as wide stands four times the bending. Tall thin rockets snap, and the cure is width or a brace strut, which shares the bending of every joint between its two ends.

> example: Thrust protects a stack. An M joint with no axial load opens on its tension side at ${MN(M.bend)} MN·m of bending. Put ${int(comp / 1000)} kN of compression through it and the bolts start $${int(nPre / 1000)}$ kN/m in credit, so it takes $(${kNpm(S.LINE_T)} + ${int(nPre / 1000)}) \times \pi r^2 = ${MN(bendPre)}$ MN·m to open it. A stack that is bent with the engine off has no such help.

## Breaking takes time

Each joint keeps a damage number $D$ from 0 to 1. Over its limit, damage grows in proportion to the overload. Under it, the joint recovers:

$$ \frac{dD}{dt} = \frac{u - 1}{${S.FAIL_TIME}\ \text{s}} \quad (u > 1), \qquad \frac{dD}{dt} = -\frac{1}{${S.HEAL_TIME}\ \text{s}} \quad (u \le 1) $$

At $D = 1$ the joint breaks and the far side becomes a vessel of its own, through the same code as staging. A steady overload $u$ therefore lasts

$$ t_{break} = \frac{${S.FAIL_TIME}\ \text{s}}{u - 1} $$

At 110 % a joint holds for ${sig(S.FAIL_TIME / 0.1, 2)} s, at 200 % for ${S.FAIL_TIME} s. A spike at touchdown or staging does nothing lasting, and a gross overload breaks at once.

## Flex

Each joint is also drawn bent, by an angle proportional to the bending it carries, through a damped spring so that it wobbles before it settles:

$$ \ddot{\theta} + 2\zeta\omega_0\,\dot{\theta} + \omega_0^2\,\theta = \omega_0^2\,\frac{M_b}{k_b} $$

The stiffness $k_b$ is set so that a squat joint at its bending limit is bent by ${(S.FLEX_AT_LIMIT * DEG).toFixed(1)}°, and up to ${S.FLEX_SLENDER_MAX} times that between long slender parts. The damping ratio $\zeta$ is ${S.FLEX_ZETA}, and the natural frequency $\omega_0$ comes from that stiffness and the inertia of the two sides, typically 1 to 3 Hz.

> game: The Structure read-out in flight shows the most strained joint and what is straining it, and clicking it colours every joint on the vessel. In the Assembly Hangar the same solver runs your design through reference cases stage by stage: ignition at full thrust, controls hard over, a turn of 15° to the airflow at 30 kPa, and burn-out. **Structural failures** in Settings turns breaking off: the loads are still measured and shown.

## Limits of the model

- The loads are those of a rigid vessel. A real structure rings when it is hit, which can double a sudden load. That is not modelled.
- The bend is drawn but not fed back: a bent stack still thrusts and drags as if it were straight.
- Gravity is taken as uniform across the vessel. The tidal stretch of a 50 m ship in low orbit is about a newton.
- A side mount is a ring with the perimeter of its footprint. Fins and wings are the exception (next chapter), and a wing fails at its root only: it does not fold in the middle.
- Brace struts share load in proportion to capacity. That is not a solved truss.
- A vessel standing on the ground reports no loads. They start when it is moving freely.
- A known defect: the rotational inertia of a small capsule ship is up to 9 % too high (under 1 % for a large rocket), so it turns slightly slowly and its loads do not quite close. It is recorded in the project's structure document and has its own fix pending.
`;
    },
  },
  {
    id: 'breakup', title: 'Aerodynamic breakup: what the airflow tears off',
    lead: 'A rocket that goes sideways in thick air sheds fins, boosters, antennas and nose cones. Two mechanisms do it, one computed and one rated, and the game says which is which.',
    body: c => {
      const { sig, int } = c, A = c.aero, S = A.STRUCT, T = A.TUNING;
      const f = A.fin('fin_broad'), small = A.fin('fin');
      const perPa = x => x.area * x.cd90 * x.arm;      // flat-wise root moment per pascal, face on, below Mach 0.7
      const kPa = x => sig(x / 1000, 2), kNpm = x => int(x / 1000);
      const cross = x => S.LINE_T * x.factor * x.sec.zEdge;
      const rated = A.rated, nose = rated.find(r => r.key === 'nose'), clamp = rated.find(r => r.key === 'radialdec');
      const md = 50, big = 4000, dvS = Math.min(S.DEBRIS_PUSH, S.DEBRIS_PUSH_MAX / md), dvB = Math.min(S.DEBRIS_PUSH, S.DEBRIS_PUSH_MAX / big);
      return String.raw`
## Why loads alone are not enough

The last chapter gives the load in every joint, and it is honest about what that load is. Fly a stock rocket broadside at maximum dynamic pressure and the free-body loads put booster clamps, nose cones and antennas at 1 to 40 % of their strength. Two reasons: only the *difference* in drag deceleration between a booster and its core loads the clamp, and a clamp is a thrust fitting, sized so that a booster can push a rocket.

Real boosters do not come off because a steady side load beats the bolts either. They come off because sway braces fail, panels flutter and thin shells buckle, which are failures a rigid-body load cannot show. So Starwright uses two mechanisms. Fins and wings fail under their real, computed load at a realistically thin root. Thin exposed parts carry a stated **air rating**, the same kind of number as a part's maximum temperature.

## Fins and wings: the thin root

A fin is held on along its root chord: a long thin rectangle, $h$ along the rocket and $t$ thick. Treated as a line of fasteners round that rectangle, its perimeter, enclosed area and section moduli are

$$ P = 2(h + t), \qquad A = h\,t $$

$$ Z_{flap} = h\,t + \frac{t^2}{3}, \qquad Z_{edge} = h\,t + \frac{h^2}{3} $$

$Z_{flap}$ resists the moment $M_c$ that folds the fin flat against the hull, which is what lift produces. $Z_{edge}$ resists the moment $M_e$ in the plane of the fin, which is what drag produces. Because $h$ is so much larger than $t$, a fin is many times stronger edge-on than flat-on. The line loads follow the ring formulas of the last chapter with these sections in place of the circle:

$$ n_t = \frac{N}{P} + \frac{|M_c|}{Z_{flap}} + \frac{M_e}{Z_{edge}}, \qquad q_s = \frac{2V}{P} + \frac{M_t}{2\,h\,t} $$

with $n_c$ the same as $n_t$ but for the sign of $N$. The allowable line loads are those of every other joint, times ${S.MOUNT_FACTOR.fin} for a rocket fin, ${S.MOUNT_FACTOR.wing} for a wing or tail fin with a spar carried through the body, and ${S.MOUNT_FACTOR.elevon} for an elevon hung along its whole span. The load is the real one: the lift and drag of the previous chapters, less what the fin's own mass needs.

> example: A ${f.name} has a root $${f.h} \times ${f.t}$ m, so $Z_{flap} = ${sig(f.sec.zFlap, 3)}$ m² and it stands a flat-wise moment of $${kNpm(S.LINE_T * f.factor)} \times ${sig(f.sec.zFlap, 3)} = ${sig(f.capM / 1000, 3)}$ kN·m. Face on to the flow it is a flat plate with $C_D = ${sig(f.cd90, 4)}$ over ${f.area} m², acting ${f.arm} m out from the root: ${sig(perPa(f), 3)} N·m for every pascal. The two meet at ${kPa(f.capM / perPa(f))} kPa. In flight the fin holds a little longer, to 9 or 10 kPa on a rocket of a few tonnes, because the same air is pushing the whole ship sideways and part of the force on the fin goes into moving the fin's own ${Math.round(A.PARTS.fin_broad.mass * 1000)} kg along with it. Edge-wise the same root stands ${sig(cross(f) / 1000, 3)} kN·m, ${Math.round(cross(f) / f.capM)} times as much.

Flown straight, a fin is at a few degrees to the flow and a few per cent of this. The small ${small.name} (root $${small.h} \times ${small.t}$ m) reaches its limit face on at about ${kPa(small.capM / perPa(small))} kPa. A single fin with no partner opposite does better still, because it spins the rocket about its long axis instead of bending its own root. Fins set in an X share a side load two and two, each at half the dynamic pressure through its face, and a stalled fin cannot make more than its flat-plate force. So fins mostly survive a tumble, and a large one caught square at max Q does not. That is what the numbers say, and it has been left alone.

## Air ratings

Thin, exposed parts carry a rated dynamic pressure. Most are judged on the **flow across** the part, the dynamic pressure of the component of the airflow at right angles to the part's own axis, which for most parts is the axis of the rocket:

$$ q_{cross} = \tfrac{1}{2}\rho\left(v_i^2 - v_{i,axial}^2\right) = q_i\,\sin^2\theta $$

with $\theta$ the angle between the axis and the flow at that part. Nose first, $q_{cross}$ is zero however fast the rocket goes, so a clean climb never touches these ratings. At 30° off the flow it is a quarter of the full dynamic pressure, at 45° half, and broadside all of it. Because $v_i$ includes the spin term $\mathbf{ω}\times\mathbf{r}_i$, the ends of a tumbling ship see the most.

${rated.map(r => `- **${r.name[0].toUpperCase() + r.name.slice(1)}:** ${r.q / 1000} kPa, ${r.open ? 'on the whole airflow from any direction, only while open' : 'on the flow across it'}.`).join('\n')}

Tanks, engines, capsules, legs and fixed solar tiles have no rating. They are judged by their joints. A clamp left on a dropped booster holds nothing, has nothing to sway, and is not judged.

> game: The rating is on each part's card in the Assembly Hangar as "Air limit". In flight the Structure read-out shows it when it is the highest number on the vessel, and the message when a part goes gives both numbers, for example "The Whip Antenna was torn off by the airflow: 18 kPa across it, rated for 12 kPa".

## How long it takes

The damage rule is the one for joints, with its own time constant. With $q$ the pressure the part is judged on and $q_r$ its rating:

$$ \frac{dD}{dt} = \frac{q/q_r - 1}{${S.AIR_FAIL_TIME}\ \text{s}} \quad (q > q_r), \qquad t_{tear} = \frac{${S.AIR_FAIL_TIME}\ \text{s}}{q/q_r - 1} $$

Under its rating a strained part recovers in ${S.HEAL_TIME} s. At twice its rating a part lasts ${S.AIR_FAIL_TIME} s, and 10 % over, ${sig(A.tearTime(1.1, 1), 2)} s. A brief excursion heals.

> example: A rocket is pitched 60° off the flow at 20 kPa. Across each part that is $20 \times \sin^2 60^\circ = 15$ kPa. A side booster's clamp (rated ${clamp.q / 1000} kPa) is at ${Math.round(15000 / clamp.q * 100)} % and goes in ${sig(A.tearTime(15000, clamp.q), 2)} s. A nose cone (rated ${nose.q / 1000} kPa) is exactly at its limit and stays on. Broadside, the nose cone is at ${Math.round(20000 / nose.q * 100)} % and lasts ${sig(A.tearTime(20000, nose.q), 2)} s.

[[calc:airflow]]

## An open panel is a flat plate

An open solar panel is no longer a little extra drag. With $\mathbf{n}$ the normal to its face, $v_n$ the flow through the face and $A$ its span times its height:

$$ \mathbf{F} = -\tfrac{1}{2}\rho\,${T.WING_PLATE_CD}\,A\,v_n\,|v_n|\;M(\mathrm{Ma})\;\mathbf{n} $$

applied at the middle of the span. It slows and turns the vessel, and it loads the panel's joint. Retract panels before entering an atmosphere.

## What happens to the pieces

A torn-off part, with everything attached beyond it, becomes a debris vessel with the position, velocity and spin it had. It is pushed clear at a relative speed $\Delta v$ of at most ${S.DEBRIS_PUSH} m/s, limited to an impulse of ${int(S.DEBRIS_PUSH_MAX)} N·s, and the push is shared by mass so that total momentum is unchanged. For a piece of mass $m_d$ leaving a ship of mass $m_s$:

$$ \Delta v_d = \Delta v\,\frac{m_s}{m_s + m_d}, \qquad \Delta v_s = -\Delta v\,\frac{m_d}{m_s + m_d}, \qquad m_d\,\Delta v_d + m_s\,\Delta v_s = 0 $$

> example: A ${md} kg antenna leaves at nearly the full ${sig(dvS, 2)} m/s and the ship does not notice. A ${int(big / 1000)} t booster is limited by the impulse to $${int(S.DEBRIS_PUSH_MAX)} / ${int(big)} = ${sig(dvB, 2)}$ m/s between the two.

The piece is also given a tumble of up to ${S.DEBRIS_SPIN} rad/s, less for one with a large moment of inertia. It then flies under the same aerodynamics as everything else, and its own parts can tear off in turn: a booster ripped from a core usually loses its nose cone a moment later.

## What this is, and is not

- An air rating is a stated limit, not a computed stress. It stands in for flutter and buckling, which are not modelled.
- Cross-flow uses the part's own axis. A dish is treated like a mast, judged on flow across the rocket's axis and not on which way the dish faces.
- Parts shield nothing. A booster in the lee of the core sees the same flow as one in front.
- There are no dynamics of the break itself. A part is on, and then it is off.
- Debris has the drag of its parts and no lift of its own shape, and the world keeps at most ${A.MAX_DEBRIS} loose pieces in flight, dropping the lightest first.
- A wing still fails only at its root.

> game: The ratings and the fin factor were set by flying every stock rocket. On a clean climb, straight up or on the ascent autopilot, nothing is torn off the ship: the highest readings are 52 % on a fin root and 60 % on an air rating. Pitched hard over at max Q and held, the rockets with side boosters lose all of them, then antennas and dishes, and the loose boosters lose their noses. **Structural failures** in Settings switches all of it off, with everything still measured and shown.
`;
    },
  },
];
