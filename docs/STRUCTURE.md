# Structural dynamics (roadmap item 2)

Until this pass a vessel was one welded rigid body. Now every joint between two parts carries a
computed load, has a strength, bends a little, and breaks when it is asked for too much.

This file is the contract of `js/core/structure.js` and the record of the model behind it.

## The model in one paragraph

The vessel still FLIES as one rigid body: the trajectory code is untouched, so orbits are exactly
what they were. On top of that, every physics step, the game works out what each joint has to
carry for the vessel to move as it does. That is not an approximation: for a rigid body it is
Newton's second law applied to the piece of the vessel on the far side of the joint ("free-body
cut"). The loads are compared with the strength of the joint, a thin bolted ring whose size is
that of the smaller of the two parts it joins. A joint that is over its limit for long enough
breaks, and the vessel comes apart there, through the same code that staging uses.

Flex is a separate, smaller thing: each joint is drawn bent by an angle proportional to the
bending it carries, through a damped spring so that it wobbles. In this version the bend is
shown but does not feed back into the flight forces (a bent stack still thrusts straight).

## Free-body loads

Body axes (craft axes, +Y = nose), origin at the vessel's centre of mass. For every part `i`:

- `m_i` mass, `r_i` position of its mass centre, `I_i` its own inertia (diagonal, the same
  numbers `Vessel._updateMass` sums into the vessel's inertia),
- `F_i` the sum of every non-gravitational force the flight model applies to it this step
  (thrust, drag, lift, parachute, ground contact, buoyancy, thrusters),
- `T_i` the torque of those forces ABOUT THE VESSEL'S CENTRE OF MASS (`r_app × F` for each force
  applied at `r_app`, plus pure couples such as reaction wheels).

The vessel moves with angular velocity `w`, angular acceleration `alpha` and specific force
`f = (sum F_i) / m` (the acceleration of the centre of mass minus gravity). Gravity is the same
for every part (its gradient across a vessel is ignored), so it loads no joint.

The joints form a tree rooted at the control part. For a joint `J` at point `p`, let `S` be the
set of parts on the far side from the root. The force and moment (about `p`) that the root side
exerts on `S` through the joint are

    a_i  = f + alpha × r_i + w × (w × r_i)                (acceleration of part i, less gravity)
    F_J  = sum over S of ( m_i a_i − F_i )
    M_J  = sum over S of ( r_i × m_i a_i + I_i alpha + w × (I_i w) − T_i )  −  p × F_J

## Joint strength (thin ring)

A joint is a ring of radius `r` with unit axis `n` pointing from the root side to the far side.

    axial   N  = −F_J · n            (+ tension, − compression)
    shear   V  = | F_J − (F_J · n) n |
    torsion Mt = | M_J · n |
    bending Mb = | M_J − (M_J · n) n |

    peak tension line load      n_t = max(0,  N / (2 pi r) + Mb / (pi r²))        (N/m)
    peak compression line load  n_c = max(0, −N / (2 pi r) + Mb / (pi r²))
    peak shear flow             q   = V / (pi r) + Mt / (2 pi r²)

    utilisation u = max( n_t / capT, n_c / capC, q / capS )      (1 = at the limit)

`capT`, `capC`, `capS` are allowable line loads in N/m: `STRUCT.LINE_T` (0.3 MN/m),
`LINE_C` (1.2 MN/m: joint faces bear on each other in compression, the bolts carry tension) and
`LINE_S` (0.3 MN/m), times the joint's strength factor: 0.7 for a separator, 0.5 for a docking
port, and for side mounts 6.5 for a booster clamp, 3.5 for a pylon (they are thrust fittings).

Because compression is carried so much better than tension, a stack under thrust is helped by
its own engine: the thrust presses the joints together and bending has to overcome that before
the far side of the ring is pulled apart. An unpowered stack that is bent has no such help.

Joint radius: a coaxial stack joint uses the smaller of the two faces that meet (under an
engine with an interstage truss, the truss: the load runs rim to rim around the bell). A radial
or surface mount uses the ring with the same perimeter as its footprint, `(h + t) / pi`.

Fins and wings are the exception: they sit on a thin rectangular root, weak across its
thickness, with its own section formulas. That, and the air ratings that tear thin parts off in
a cross-flow, are in [AERO_BREAKUP.md](AERO_BREAKUP.md).

What that gives, for a plain joint:

| size | radius | pull apart | crush | bend |
|---|---|---|---|---|
| S | 0.31 m | 0.59 MN | 2.4 MN | 0.09 MN·m |
| M | 0.63 m | 1.2 MN | 4.7 MN | 0.37 MN·m |
| L | 1.25 m | 2.4 MN | 9.4 MN | 1.5 MN·m |
| XL | 1.88 m | 3.5 MN | 14 MN | 3.3 MN·m |

Bending strength goes with the square of the width, which is the whole lesson: twice as wide is
four times as stiff a joint.

The numbers were set by flying the sixteen stock designs. Flown straight at full throttle they
peak between 3 % and 60 % (the big side boosters of Colossus and Farwind are the 55 to 60 %).
Pitched hard over just after maximum dynamic pressure, most survive; the two tallest for their
width (Trundle Lander, Farwind) break in two, and a capsule on four slim S-size tanks
snaps at 133 %.

## Brace struts

A Brace Strut whose outer tip comes within 0.25 m of another part braces that part to the one
it is mounted on. Every joint on the path between the two then shares its load with the strut:
bending is scaled by `capM / (capM + n × STRUT_FORCE × arm)` and forces by
`capF / (capF + n × STRUT_FORCE)`, where `arm` is the distance from the strut's tip to the
joint and `n` the number of struts. The reported `axial`, `shear`, `bending` stay the raw
free-body loads; only the utilisation (and the flex) see the relief. This is load sharing by
capacity, not a solved truss.

## Where the forces come from

`Vessel._stepFlight` books every force to the part it acts on, as it applies it: drag, lift and
parachute pull part by part, ground contact and buoyancy point by point, thrust engine by
engine. Three things the flight model applies as lumps are shared out: the attitude-control
torque goes to the reaction wheels, gimballed engines and thruster blocks in proportion to the
authority each contributes, as pure couples (which is how the flight model applies it: a gimbal
turns the rocket without pushing it sideways); translation thrust goes to the thruster blocks.
Summed over the vessel, the booked forces are exactly what the integrator uses, so Newton's
laws close: `structure.resF` and `resM` hold what is left over at the root, and are checked.

## Failure

Each joint keeps `damage` in 0…1. While `u > 1` it grows at `(u − 1) / STRUCT.FAIL_TIME` per
second; below 1 it heals at `1 / STRUCT.HEAL_TIME`. At 1 the joint breaks: the link between the
two parts is removed and the far side becomes its own vessel. So a 10 % overload has to last
about `10 × FAIL_TIME`, a brief spike (touchdown, staging) does nothing, and a gross overload
breaks at once. Nothing breaks while a vessel is pinned to the ground or on rails.

## Flex

Each joint has a bending stiffness `kb = (bending limit) / (FLEX_AT_LIMIT × slenderness)`:
a joint at its bending limit is bent by 1.7 degrees, times the length-to-diameter of its
neighbours (0.6 to 2), so slender sections visibly bend more before they break. The bend
follows `−M_bending / kb` through a damped oscillator (damping ratio 0.14) whose natural
frequency comes from that stiffness and the reduced inertia of the two sides of the joint,
typically 1 to 3 Hz. The step is the exact solution of the oscillator, so any time step is
stable. `updateFlex()` turns the joint bends into a displacement and rotation of every part,
with the vessel's mass centre and mean attitude left where they are (a free body bends about
its own middle).

The bend is drawn. It does not change thrust direction, drag or the trajectory.

## The assembly building (`js/core/loadcases.js`)

`analyzeCraft(craft)` has no model of its own. It turns the design into a real `Vessel`, puts
it in reference conditions, lets the real flight model take one step of 0.1 ms, and reads the
joint loads. For every stage of the flight: ignition at full thrust; full pitch and full yaw
command; at launch, a hard turn in thick air (15 degrees to the airflow at 30 kPa and 350 m/s,
with the controls hard over, in four directions); and burn-out, when the vessel is lightest
and accelerates hardest. It then stages and repeats. Each joint reports its worst case.

These are reference cases, not a guarantee. A rocket that passes can still be broken by flying
it sideways through the atmosphere.

## Limits of the model

- Loads are those of the rigid vessel. Real structures ring when hit, which can double a
  sudden load; that is not modelled.
- Flex is shown, not fed back (see the roadmap entry).
- A vessel pinned to the ground reports nothing; loads start when it is moving freely.
- Gravity is taken as uniform across the vessel (the tidal stretch of a 50 m ship in low orbit
  is about a newton).
- A side mount is treated as a ring with the perimeter of its footprint. That is fair for
  clamps and legs. Fins and wings use a thin root instead (AERO_BREAKUP.md), still at the root
  only: a wing does not fold in the middle.
- The vessel's rotation uses a diagonal inertia, as the flight model always has. The joint
  loads are those of the motion the game actually produces.

## Found by the verification, not yet fixed

`Vessel._updateMass` takes the centre of mass from where each part's mass really sits (a
capsule's ballast is low, `comY`), but takes the moment of inertia from the part's geometric
centre. For a capsule on a short stack the vessel's inertia is up to 9 % too large (Acorn pod,
M-400 tank, Sparrow engine: 10 396 against 9 467 kg·m²); for a large rocket it is under 1 %.
It has been so since the first version. It means such a craft turns slightly more slowly than
it should, and that the joint loads, which use the true mass points, do not quite close at the
root: on that small ship the leftover moment is 3 % of the largest joint load in a tumbling
burn and a third of it when falling broadside through air (where the loads themselves are
small: 923 N·m); on Ember Twin it is 0.3 %.

Correcting it is one line, and was tried here. It changes how every landing is flown: with
the corrected inertia the stock lander of the "Under the Giant" scenario tips over on
touchdown. So the correction belongs in its own change, with the landing suites run in a
browser, and is left out of this one. `tests/verify` chapter 7 reports the size of the error
and will say when it is gone.

## API (`js/core/structure.js`)

```js
export const STRUCT            // tuning constants
// Pure functions on plain data (what tests/verify checks against an independent reference):
solveJointLoads(bodies, joints, motion) → [{ F:[x,y,z], M:[x,y,z] }]     // one per joint, as defined above
//   bodies: [{ m, r:[x,y,z], I:[Ixx,Iyy,Izz], F:[x,y,z], T:[x,y,z] }]
//   joints: [{ parent, child, p:[x,y,z], n:[x,y,z] }]   indices into bodies; a tree; any order
//   motion: { w:[x,y,z], alpha:[x,y,z], f:[x,y,z] }
jointUtilisation(F, M, n, r, capT, capC, capS, root = null) → { axial, shear, bending, torsion, nT, nC, q, util, mode }
//   root: { h, t, c } for the thin root of a fin or wing (AERO_BREAKUP.md); null for a ring
//   mode: 'tension' | 'compression' | 'shear'

// Live, one per vessel (vessel.structure; null for a one-part vessel):
class Structure {
  joints      // [{ a, b (VParts: a is the root side), kind: 'stack'|'radial'|'outer'|'dock', px,py,pz, nx,ny,nz, r,
              //    capT, capC, capS, axial, shear, bending, torsion, util, mode, damage, peak (highest util seen),
              //    bx,by,bz (current bend, rad, body axes) }]
  maxUtil     // highest utilisation over all joints this step; worst → that joint
  valid       // false until the first solve after a rebuild, and while landed/pinned or on rails
  snapshot()  // → { bodies, joints, motion, loads:[{F,M,util,...}] } plain data of the last solved step
  partFlex(part, outPos, outRot)   // small displacement (m) and rotation vector (rad) of a part, body axes
}
  updateFlex()   // fills the per-part flex; → true when anything is bent
  resF, resM  // what Newton's laws do not close by at the root (N, N·m): should be rounding error
}
// Assembly building (js/core/loadcases.js):
analyzeCraft(craft, { body } = {}) → { joints:[{ a, b (craft part ids), kind, pos:{x,y,z}, r, util, mode, case, cases:{ name: util },
                                                 axial, shear, bending, braced }],
                                       worst, cases:[names], warnings:[text] }
```

`TUNING.STRUCT_FAIL = false` (js/core/vessel.js) keeps the loads and the display but lets
nothing break.

Events: `structure {vessel, debris, joint:{a,b,kind,aName,bName}, mode, util, loads, pos, body}` when a joint
breaks (`loads` holds the joint's radius, strengths and the axial, shear, bending and torsion it carried; a
`decouple` event with `part: null` for the piece that left comes just BEFORE it, in the same step), and
`stress {vessel, util}` when the worst joint first passes `STRUCT.WARN`.

Joints also carry `relB`, `relF` (the share of bending and of force left to the joint after its brace
struts, 1 when unbraced) and `braces`.

## Cost

About 10 microseconds per physics step for a 39-part ship (Farwind), 7 for a 14-part one:
under a thousandth of a frame.
