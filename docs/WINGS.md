# Wings and fins above the speed of sound

Step D of the re-entry work ([REENTRY_SPEC.md](REENTRY_SPEC.md), section 5). Slower than Mach 0.7
nothing changes. Faster, a lifting surface loses lift, pays more drag for the lift it keeps, and
can be hidden from the flow by the body it is mounted on.

## The model

| | Below Mach 1 | Above Mach 1 |
| --- | --- | --- |
| Lift-curve slope | 3.6 per radian for a wing, 1.6 for a fin | the smaller of that and 4 / sqrt(Ma^2 - 1) |
| Drag due to lift, C_D = C_D0 + K C_L^2 | K = 0.07 | the larger of 0.07 and 1 / slope (the capped slope): C_L times the angle, faded in over Mach 1 to 1.2 |
| Profile drag C_D0 = 0.012 | times the slender drag curve of step B (1 below Mach 0.7) | the same curve |
| Stall and the flat plate past it | as before | as before |
| Shadow | none | the rule of step B: a tenth of the force when wholly in the lee of a wider part, from Mach 1.5 |

The cap is Ackeret's result for a thin flat plate in supersonic flow. With the capped slope the
drag due to lift is C_L times the angle of attack, which is what a force square to a flat plate
gives. The cap takes hold at Mach 1.49 for a wing and Mach 2.69 for a fin, and the curves meet
there, so nothing jumps.

| Mach number | Wing slope | Fin slope |
| --- | --- | --- |
| 1.5 | 3.58 | 1.6 |
| 2 | 2.31 | 1.6 |
| 3 | 1.41 | 1.41 |
| 4 | 1.03 | 1.03 |
| 5 | 0.82 | 0.82 |

Before this step, every surface's whole drag was multiplied by one drag-rise curve that peaked at
2.0 at Mach 1.1. Now only the profile drag rises, on the slender curve (peak 1.9 at Mach 1.05),
and the drag due to lift follows the table above.

## The Lattice Vane

A grid fin's cells choke near the speed of sound. Between Mach 0.8 and 1.3 the Lattice Vane
loses up to 40 % of its lift slope and gains up to 100 % in drag, most at Mach 1.0. The effect is
real. The numbers are the game's own: published grid-fin data vary widely with the lattice, and
there is no single curve to cite. They are tunables (`TUNING.GRID_*`).

## Steering

Control surfaces work by changing their own angle of attack, so their authority follows the
slope. The attitude hold is told how much authority it has at the present Mach number, so it does
not over-steer when the fins weaken. A booster coming down on Lattice Vanes has 51 % of its
low-speed authority at Mach 5, 88 % at Mach 3, all of it at Mach 2, and 60 % for a moment at
Mach 1.

The hold's gain also comes from what the surfaces really give. Before step D it planned with the
angular acceleration it limits itself to (`TUNING.MAX_ANG_ACC`, 2 rad/s²), while the surfaces gave
whatever the air gave them. A falling booster's Lattice Vanes gave about forty times that in roll,
and the hold slammed them from stop to stop every step between Mach 2.9 and 1.2. The stage shook
±0.4 rad/s about its axis and the vanes dragged hard over. With the drag that lift costs above
Mach 1, that showed as 5 % more drag than the fall predictor's table. Now the hold plans with the
authority the craft reports to its guidance (`ctrlAccel`), and the vanes move smoothly.

A booster's last metres changed too. With weaker vanes above Mach 1 a returning stage comes out of
its landing burn a little further from the pad and still sliding. The final descent used to brake
with at most 8 degrees of lean below twelve metres, and needed a hundred metres to stop a 10 m/s
slide: it hovered past the pad and back on propellant it did not have. It now leans up to 14
degrees at any height until it commits to touchdown.

## Stability of finned rockets

Fins lose their grip above Mach 1, while the push of the air on a nose cone does not. So a rocket
stabilized only by small fins far aft can become unstable at high Mach. The test dart (a tank,
a nose cone and four fins) restores itself at Mach 0.6 and 3, and no longer does at Mach 4 and 5.
This is what real sounding rockets meet, and why their fins are large. The stock rockets fly
attitude-held, and none of them changed its flight because of it (fleet report in the pull request).

## Code

- `js/core/vessel.js`: `machSlope`, `machInduced`, `gridChoke`, and `wingCoefficients(a, slope, stall, out, mach, rise, choke)`.
  The force loop of `_stepFlight` passes the Mach number, the slender rise and the vane's choke,
  and multiplies by the part's shadow. `axialDragTable` does the same, so the booster's fall
  prediction follows.
- Checks: `tests/verify/checks_wings.mjs` (chapter 15), `tests/unit/wings.test.js`.

## What it leaves out

- Sweep. A swept or delta wing behaves at supersonic speed as if the Mach number were lower. The
  game's wings carry a sweep angle for their looks only.
- Wave drag from thickness. Only the lift's share of the drag follows Ackeret; the profile drag
  follows the slender curve.
- The shift of the centre of pressure from the quarter chord to the half chord. Each surface's
  force acts at the part's centre at every speed.
