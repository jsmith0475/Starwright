<h1 align="center">Starwright</h1>

<p align="center"><b>Build it. Launch it. Bring the Pips home.</b></p>

<h3 align="center">Made for people who love Kerbal Space Program and SpaceX.</h3>

<p align="center">
A full 3D rocket-building and orbital-flight game that runs in your browser.<br>
Real orbital mechanics. A solar system of nineteen bodies. No account, no download store, no cost.
</p>

<p align="center"><b>Built with AI, and said plainly:</b> directed by one person, written by 20+ Claude AI agents and independently reviewed by Grok AI agents. <a href="#how-it-was-built">How it was built</a>.</p>

<h2 align="center"><a href="https://jsmith0475.github.io/Starwright/">▶ Play Starwright now</a></h2>

<p align="center">In your browser. Nothing to install.</p>

<p align="center"><sub>An independent, original game. Not affiliated with or endorsed by the makers of Kerbal Space Program or by SpaceX.</sub></p>

<!--
  TRAILER. The animated preview below links to the 60-second trailer in media/.
  To get a real inline video player here on github.com: edit this file on github.com, drag
  media/starwright-trailer.mp4 into the editor, and put the link GitHub gives you on its own
  line in place of the <p> block below. The file is under GitHub's 10 MB limit for that.
-->
<p align="center">
  <a href="media/starwright-trailer.mp4">
    <img src="media/trailer-preview.gif" width="100%" alt="Starwright trailer: liftoff from the pad, a gravity turn over the coast, a landing on the moon Pell, a rover on Rusk, a docking, and a ringed gas giant">
  </a>
  <br>
  <a href="media/starwright-trailer.mp4"><b>▶ Watch the 60-second trailer (with sound)</b></a>
</p>

<p align="center">
  <a href="#play-in-one-step"><b>Play</b></a> ·
  <a href="#your-first-orbit">First orbit</a> ·
  <a href="#for-the-people-who-do-the-math">The physics</a> ·
  <a href="#aerodynamics">Aerodynamics</a> ·
  <a href="docs/MANUAL.md">Manual</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#come-build-it-with-us"><b>Volunteer</b></a>
</p>

---

Nobody handed you a rocket. You bolt one together in the assembly building, part by part and
stage by stage. You roll it to the pad, light it, and find out. If the staging is wrong it comes
apart at two kilometres. If it is right, you tip east over the coast, the sky goes black, and
there is a planet under you and a map full of orbits to plan.

**Starwright is for KSP lovers and SpaceX lovers.** If you ever lost a weekend to Kerbal Space
Program, or you never miss a launch and watch booster landings with a spreadsheet open, this
game was made for you. It is an original game in that tradition, with its own worlds, its own
crew and its own art, built so that anyone can open it and fly.

## Why this exists

We all loved Kerbal Space Program. We all played it, and it was awesome. It taught a generation
what an orbit really is, why you burn sideways to stay up, and how good it feels when a rocket
you built yourself finally makes it.

Then we waited for version 2. It kind of came out: it reached early access in 2023, and the
year after, the studio building it was closed and the updates stopped.

Starwright is not going to bring KSP back, and it is not trying to replace it. But it might be a
way to enjoy some of that same excitement of spaceflight and orbital dynamics, in a game that
you own. It is open source, it runs on your own machine, and nobody can switch it off.

To the people who made KSP: thank you. This exists because of what you started.

## How it was built

Starwright was not written by hand, and it would be wrong to let anyone think so.

It is the result of an extensive collaboration between one person and teams of AI agents. Jerry
Smith directed the project: what to build, what it should feel like, what was not good enough,
and when it was ready. More than 20 Claude agents, working in parallel teams, wrote most of the code, the
tests, the physics checks and these documents. A separate team of Grok agents, run by Jerry
independently of the Claude agents, reviewed the work. Every build was played and judged by a
human, and sent back when it fell short.

If you are curious what a person and a group of AI agents can build together, this repository is
one honest answer, and the full source is here to read.

"Teams" means teams of AI agents. Nobody at Anthropic or xAI, the companies that make Claude and
Grok, worked on Starwright, and it is not affiliated with or endorsed by either of them.

## What you get

| | |
|---|---|
| [![A capsule and upper stage on the build floor of the assembly building](media/shot-assembly.jpg)](media/shot-assembly.jpg) | [![A two-stage rocket in a gravity turn over the coast](media/shot-launch.jpg)](media/shot-launch.jpg) |
| **Build anything.** 186 parts: capsules and probe cores, liquid, solid, jet, ion and nuclear engines, wings, wheels, docking rings, science gear. Symmetry, staging and a live delta-v budget for every stage. | **Fly it yourself.** Staging, a gravity turn through real drag and heating, a navball and a flight computer that helps when you ask and stays out of the way when you do not. |
| [![The map view with a transfer orbit and an encounter with the moon](media/shot-map.jpg)](media/shot-map.jpg) | [![A lander descending on its engine toward the grey surface of Pell](media/shot-moon.jpg)](media/shot-moon.jpg) |
| **Plan the burn.** Drop a maneuver node on your orbit, drag the handles, and watch the encounter appear before you spend a drop of fuel. Time warp to 100,000×. | **Land on a moon.** Then step outside, plant a flag, take a sample and get everyone home through re-entry. |
| [![A six-wheeled rover driving across the red surface of Rusk](media/shot-rover.jpg)](media/shot-rover.jpg) | [![The tracking station showing a world and the list of bodies in the Helion system](media/shot-system.jpg)](media/shot-system.jpg) |
| **Not only rockets.** Rovers, spaceplanes off a runway, space stations assembled by docking, fuel pumped from tanker to ship. | **A whole solar system.** A star, eight planets, nine moons and a comet, each with its own terrain, gravity and sky. |
| [![A tall rocket in a hard turn with coloured stress bands at its joints and the Structure read-out at 82 percent](media/shot-structure.jpg)](media/shot-structure.jpg) | [![A heavy rocket flipped across the airflow just after both side boosters were torn off, with the game's messages naming the cause](media/shot-aero.jpg)](media/shot-aero.jpg) |
| **Structures that carry load.** Every joint between two parts bears a computed load: thrust, weight, drag and bending. Tall thin stacks flex, and a hard turn in thick air snaps them. A stress overlay shows the load in flight, and the assembly building names the weak joint before you launch. [How it works.](docs/STRUCTURE.md) | **Air that behaves like air.** Every part meets the airflow on its own, so drag, stability and lift come from the shape you built. Fins keep a rocket pointed, wings stall, drag climbs through the speed of sound, and at max Q the air can tear parts off. [The framework and the math.](#aerodynamics) |
| [![Standing on Rusk at sunrise: red mud cracked into plates, wind-cut stones and streaks of high dust in the sky](media/shot-terrain-rusk.jpg)](media/shot-terrain-rusk.jpg) | [![Standing on Brim: grey ice floes with dark water in the leads between them, under a black sky](media/shot-terrain-brim.jpg)](media/shot-terrain-brim.jpg) |
| **Ground of its own on every world.** Step out on Rusk and you stand on cracked mud pans, wind ripples and wind-cut stones under a sky streaked with dust. Every landable world has its own ground at walking scale and its own kinds of rock. [What each world has.](docs/WORLDS.md) | **Ice that broke and froze again.** Brim is a sea of floes with dark water in the leads. Ost and Quell are plates of old ice with blue in the cracks. |
| [![Standing on Ost at low sun: pale ice plates with blue cracks and blocks of ice lying on them](media/shot-terrain-ost.jpg)](media/shot-terrain-ost.jpg) | [![Sear's lava sea from five kilometres up: dark crust plates with bright glowing cracks between them](media/shot-terrain-sear.jpg)](media/shot-terrain-sear.jpg) |
| **Craters down to a hand's width.** Pell, Nock, Nym, Dray, Cindra and Slate are pocked at every size from 150 metres to a few centimetres, with bright rims and dark floors. | **A lava sea with a crust.** Sear's molten sea carries dark plates with the glow coming up between them, and some plates are still dull red. |

And around the flying:

- **Career, Science and Sandbox modes.** Funds, science and reputation, a 27-node tech tree, a
  contract board, and a crew of Pips who gain experience.
- **A flight program of 71 missions** from a first hop to the far edge of the system, so there
  is always a next goal.
- **15 ready-made scenarios.** Skip to the good part: already in orbit, 120 metres from a
  station, on final descent to a moon, or falling from 120 km in a bare capsule.
- **Flight School.** Eight illustrated lessons from a first hop to rendezvous, most with a
  **Try it** button.
- **Rockets that bend and break.** Every joint between two parts carries a computed load. Tall
  thin stacks wobble, and a hard turn in thick air snaps them. A read-out and a stress overlay
  (the `;` key) show the load in flight, and the assembly building tells you which joint will
  give way before you launch (the `L` key). Wider parts, shorter stacks and brace struts are the
  cure. A switch in Settings turns the breaking off.
- **Rockets that come apart in the air.** Flip or tumble in thick air and the side boosters are
  ripped from their clamps, antennas and open solar panels are stripped, nose cones go, and
  the pieces fly on as debris. A clean climb loses nothing.
- **Boosters that fly back and land.** Give the first stage a guidance ring, grid fins and legs
  and it is no longer thrown away. The ascent assist lets it go early with enough propellant to
  return, and it flies itself home under full physics: flip, boostback burn, an entry burn if it
  needs one, steering on the fins, a landing burn, and down on its legs while the upper stage
  goes on to orbit. It lands on the Return Pad beside the launch site, or on the barge
  *Patient Tide* 40 km out to sea. Press `\` to watch it or take over. See
  [reusable boosters](docs/BOOSTERS.md) for how it is flown and what is not built yet.
- **A 39-engine rocket on methane and oxygen.** The stock *Shearwater* is modelled on SpaceX's
  Starship at five-eighths size: 33 engines under the booster, 6 under the ship, two real
  liquids burnt 3.6 to 1, rings of engines you switch in flight, and hot staging. It launches
  from a **Catch Tower**, and its booster flies back and is caught by the tower's arms on two
  pins, with no legs. These are the first two steps of an orbital refuelling mission. See [Shearwater](docs/SHEARWATER.md) for the numbers,
  where it differs from the real one, and what is not built yet.
- **Three pieces at separation.** A stack separator fires at both ends: the upper stage goes
  on, the stage below falls back clean, and half a second later the ring between them is thrown clear as a piece of its own, with
  mass and momentum shared out exactly.
- **Landing legs with real suspension** that compress and settle on touchdown, and long
  **folding legs** for a booster: flat against the tank all the way up and back, swung out a few
  seconds before it lands.
- **A self-running demo tour** if you just want to watch the game fly itself for six minutes:
  [start it in your browser](https://jsmith0475.github.io/Starwright/?demo=1).

<p align="center">
  <a href="media/structure-breakup.mp4">
    <img src="media/structure-breakup-preview.gif" width="100%" alt="Two flights recorded in the game: a tall thin rocket is turned hard at 30 kPa and its stack bends and snaps in two, then a heavy rocket is flipped across the airflow at 20 kPa and both side boosters are torn off">
  </a>
  <br>
  <a href="media/structure-breakup.mp4"><b>▶ Watch a stack snap and the airflow strip a rocket (27 seconds, silent)</b></a>
  <br>
  <sub>Real gameplay recorded in Chrome, slowed to half speed at each break. How it works: <a href="docs/STRUCTURE.md">structure</a>, <a href="docs/AERO_BREAKUP.md">breakup</a>.</sub>
</p>

<p align="center">
  <a href="media/booster-return.mp4">
    <img src="media/booster-return-preview.gif" width="100%" alt="One flight recorded in the game: the stages part 21 km up and the ring that joined them is thrown clear as a third piece, the booster flips and burns back toward the launch site, falls, lights its engine at 993 m, swings its legs out and lands on the Return Pad">
  </a>
  <br>
  <a href="media/booster-return.mp4"><b>▶ Watch a booster fly itself home (45 seconds, silent)</b></a>
  <br>
  <sub>Real gameplay, one flight recorded in Chrome: three pieces at separation, boostback, landing burn at 993 m, touchdown at 1.7 m/s, 0 m from the mark. <a href="docs/BOOSTERS.md">How it works and what was checked.</a></sub>
</p>

<p align="center">
  <a href="media/shot-booster.jpg"><img src="media/shot-booster.jpg" width="100%" alt="A dropped first stage 28 km above the coast, flown as its own vessel named Test Returner booster, while the upper stage climbs to orbit out of view"></a>
  <br>
  <sub>A dropped first stage, flown as its own ship 28 km up while the upper stage flies itself to orbit. <a href="docs/BOOSTERS.md">How it works and what was checked.</a></sub>
</p>

<p align="center">
  <img src="media/shot-centre.jpg" width="100%" alt="The Starwright space centre from the air: assembly building, launch pad, runway and tracking station on a green coastal plain">
</p>

## Play in one step

**Easiest of all: play in your browser.** Nothing to install.

### ▶ [Play Starwright now](https://jsmith0475.github.io/Starwright/)

<p align="center">
  <a href="https://jsmith0475.github.io/Starwright/"><img src="media/shot-title.jpg" width="100%" alt="The Starwright front menu over the launch pad at first light: Play (Continue, New Game, Missions, Scenarios), Learn and tour (Flight School, Science, Demo tour), Options (Settings, Controls) and About (About, What's New)"></a>
  <br>
  <sub>The front menu, in four groups: play, learn and tour, options, about. The arrow keys walk it.</sub>
</p>

Prefer your own copy that works offline? One step puts Starwright on your machine and starts it.

### macOS

Open **Terminal** (press `Cmd`+`Space`, type *Terminal*, press `Return`), paste this, press
`Return`:

```sh
curl -fsSL https://raw.githubusercontent.com/jsmith0475/Starwright/main/install.sh | sh
```

### Windows 10 and 11

Open **PowerShell** (press the `Windows` key, type *PowerShell*, press `Enter`), paste this,
press `Enter`:

```powershell
irm https://raw.githubusercontent.com/jsmith0475/Starwright/main/install.ps1 | iex
```

### Linux

In a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/jsmith0475/Starwright/main/install.sh | sh
```

### What that one step does

1. Downloads the game into a `Starwright` folder in your home folder.
2. Adds a **Starwright** shortcut (Desktop on macOS and Windows, applications menu on Linux).
3. Starts the game. A small window opens saying *Starwright is running*, and your browser opens
   on the title screen.

After that, double-click the shortcut whenever you want to play. Leave the small window open
while you play and close it when you are done.

Nothing is installed system-wide, nothing asks for a password, and the game never touches the
network once it is on your machine. To update, run the same line again. Your saved games live
in the browser and are kept. To uninstall, delete the `Starwright` folder and the shortcut.

<details>
<summary><b>Rather not paste a command? Download and double-click instead.</b></summary>

1. Click the green **Code** button at the top of this page, then **Download ZIP**.
2. Unzip it anywhere.
3. Double-click the launcher for your system:

| System | Double-click | The first time |
|---|---|---|
| macOS | `start.command` | macOS may say the file is from an unidentified developer. Right-click it, choose **Open**, then **Open**. |
| Windows | `start.bat` | Windows may show *Windows protected your PC*. Click **More info**, then **Run anyway**. |
| Linux | run `./start.sh` in a terminal | |

Your browser opens at <http://localhost:8642/>.

</details>

<details>
<summary><b>Something not working?</b></summary>

- **The game has to be served, not opened.** Double-clicking `index.html` shows a blank page,
  because browsers do not load JavaScript modules from a file. Use the launcher.
- **macOS or Linux says Python is missing.** The launcher uses Python 3 to serve the game. On
  a Mac, run `xcode-select --install` once in Terminal. On Linux, install `python3` from your
  package manager. Node.js works too if you have it.
- **Port 8642 is in use.** Start on another port: `STARWRIGHT_PORT=8700 ./start.sh`, or
  `start.bat -Port 8700` on Windows. Saves are tied to the port, so pick one and keep it.
- **Blank or slow picture.** Starwright needs WebGL 2 and a reasonably recent graphics card.
  Use a current Chrome or Edge, and turn the quality down in **Settings**.
- **Still stuck?** [Open an issue](../../issues/new/choose) and say what system and browser
  you are on. That report is a real contribution.

</details>

## Your first orbit

Starwright is played with a keyboard and a mouse with a wheel.

1. On the title screen choose **Scenarios**, then **First Orbit**. A finished rocket is waiting
   in the assembly building. Press **Launch**.
2. Press `Z` for full throttle and `Space` to light the engine.
3. At about 1 km, tip east with `D`. Aim for roughly 45° by 10 km and nearly flat by 40 km.
4. Press `Space` again each time a stage runs dry.
5. Open the map with `M`. Burn until the high point of your path (the apoapsis) is about 80 km,
   then cut the engine with `X`.
6. Click your orbit near the apoapsis to add a maneuver node. Drag the prograde handle until the
   low point is above 72 km, the top of the atmosphere. Burn at the node.

You are in orbit. Everything else in the game is a variation on what you just did.

| Keys | |
|---|---|
| `W` `A` `S` `D` `Q` `E` | Pitch, yaw, roll |
| `Shift` / `Ctrl` | Throttle up / down (`Z` full, `X` cut) |
| `Space` | Launch, next stage |
| `T` / `R` | SAS / RCS |
| `M` | Map and maneuver nodes |
| `.` / `,` | Time warp faster / slower |
| `F5` / `F9` | Quicksave / quickload |

The [player's manual](docs/MANUAL.md) has every key, rendezvous and docking step by step, fuel
transfer, career mode and contracts.

## For the people who do the math

Starwright does not fake its orbits, and it shows its work.

- **The model.** Patched conics with bodies on rails and Laplace spheres of influence: the model
  genre veterans already know how to fly. Coasting and time warp use the exact Kepler solution,
  so an orbit does not drift at any warp rate. Powered and atmospheric flight is integrated
  with a 20 ms leapfrog step.
- **Checked against independent physics.** A separate reference implementation with its own
  high-order integrator and its own Kepler solver, sharing none of the game's maths, flies the
  same cases and compares: **861 checks, 0 failures.** Read the method, the numbers and the
  bugs it found in [docs/PHYSICS_VERIFICATION.md](docs/PHYSICS_VERIFICATION.md), or run it
  yourself with `npm run verify`.
- **Structures from first principles.** The vessel flies as one rigid body, and each step the
  game works out what every joint must carry for it to move that way: Newton's second law on
  the piece beyond the joint, compared with the strength of a thin bolted ring. A separately
  written multibody reference and closed-form cases check it: **300 more checks, 0 failures**,
  agreeing to about one part in 10¹⁴. The model, its numbers, its limits and one defect the
  checks found are in [docs/STRUCTURE.md](docs/STRUCTURE.md).
- **Breakup with its assumptions stated.** Fins and wings fail at a thin root under the lift
  they really carry. Antennas, open panels, nose cones and booster clamps carry a rated dynamic
  pressure, like a temperature limit, because flutter and buckling are not things a rigid-body
  load can show. **113 more checks, 0 failures**, on the airflow each part sees, the step on
  which it goes, and what a tear-off conserves: [docs/AERO_BREAKUP.md](docs/AERO_BREAKUP.md).
- **Honest about its limits.** No n-body gravity, so no Lagrange points and no halo orbits.
  Atmospheres are exponential with a hard top. The system is about a tenth of real scale: low
  orbit is about 2.2 km/s and takes 35 minutes, and the moon is nine hours away. The
  verification document lists what the model cannot do, with measurements.
- **A science reference in the game.** Fifteen chapters and 99 equations, from the two-body
  problem and the vis-viva equation through the rocket equation, patched conics, re-entry
  heating and rendezvous, to the game's own aerodynamics, structural loads and aerodynamic
  breakup, with worked examples computed from the game's own worlds and flight code and
  three calculators. It is on the title menu under **Science**.
- **Two vessels flown at once.** A dropped booster and its upper stage are both integrated
  with the same 20 ms step however far apart they get. **15 more checks, 0 failures**: mass and
  momentum are shared out exactly at separation, a booster 5 km from the ship being flown
  follows the independent two-body reference to 5 micrometres over 100 seconds, and the same
  launch watched from the upper stage, from the booster, or switching every five seconds comes
  out identical to the last bit. See [docs/BOOSTERS.md](docs/BOOSTERS.md).
- **A booster that predicts its own fall.** The return program integrates the stage's fall four
  times a second (gravity, drag in air that turns with the planet, the drag rise at Mach 1) and
  steers the predicted impact point onto the target. **20 more checks, 0 failures**: against a
  separate integrator with its own atmosphere, over a 63 km fall, the impact point agrees within
  0.1% of the distance, the speed within 0.13%, and the predictor is 2.4 m from the reference.
  The landing burn stops within 0.03% of the rocket equation. 312 of 312 varied returns landed
  within 0.3 m at 1.75 m/s.
- **A deck at sea that is solid.** The landing barge is a level rectangle the physics stands a
  stage on, tips it off the edge of, or lets it miss. **12 more checks, 0 failures**: a stage
  flown down onto the deck stands at the same height, to 0.15 mm, as the same flight ended on
  level ground, and ten of ten returns from varied separations landed within 3 cm of the middle.

<p align="center">
  <img src="media/shot-science.png" width="100%" alt="The in-game science reference open on chapter 1, gravity and the two-body problem, with numbered equations">
</p>

## Aerodynamics

Every part of a vessel meets the air on its own. There is no single drag number for the rocket:
each physics step (20 ms in air) the game works out the airflow at each part, the force that
flow puts on it, and where on the vessel that force acts. Drag, stability, lift, control
authority, heating and breakup all fall out of the same per-part sum.

<p align="center">
  <a href="media/structure-breakup.mp4">
    <img src="media/aero-breakup-preview.gif" width="100%" alt="A heavy rocket with two side boosters is flipped across the airflow at 20 kPa. Both boosters are torn off at 23 kPa against a 12 kPa rating and fly on as debris">
  </a>
  <br>
  <sub>Real gameplay: Colossus flipped across the airflow at 20 kPa. <a href="media/structure-breakup.mp4">Full clip</a>.</sub>
</p>

### The framework

1. **The air.** Density falls exponentially with height up to a hard top, and the atmosphere
   turns with the planet, so airspeed is measured against moving air.
2. **The flow at each part.** A part away from the centre of mass moves with the spin of the
   vessel, so a tumbling rocket sees different air at its nose and its tail.
3. **The force on each part,** by kind: bodies (tanks, capsules, engines) take drag on their
   end faces and their sides, wings and fins take lift and drag from an angle of attack, and
   small attached parts take plain drag.
4. **The sum.** Each force is applied at its part, so the forces add to one net force and one
   net torque about the centre of mass. Nothing else decides whether a rocket flies straight.
5. **What follows.** The same per-part loads feed the joint loads
   ([docs/STRUCTURE.md](docs/STRUCTURE.md)), the air ratings
   ([docs/AERO_BREAKUP.md](docs/AERO_BREAKUP.md)) and re-entry heating.

### The math

Air density at altitude $h$, with surface density $\rho_0$ and scale height $H$ (on the home
world Verda: 1.22 kg/m³, 5.8 km, top at 72 km):

$$\rho(h) = \rho_0 e^{-h/H}$$

The flow at part $i$, at position $\mathbf{r}_i$ from the centre of mass of a vessel moving at
$\mathbf{v}$ through the air and turning at $\boldsymbol{\omega}$, and its dynamic pressure:

$$\mathbf{v}_i = \mathbf{v} + \boldsymbol{\omega} \times \mathbf{r}_i \qquad q_i = \tfrac{1}{2} \rho |\mathbf{v}_i|^2$$

A body part with windward face area $A_w$, leeward face area $A_l$ and side area $A_s$ (each
already multiplied by its drag coefficient), with $\theta$ the angle between its axis and the
flow. The wake behind the leeward face adds a quarter of that face:

$$F_\text{axial} = - q_i M(\mathrm{Ma}) (A_w + 0.25 A_l) \cos\theta \qquad \mathbf{F}_\text{side} = - q_i M(\mathrm{Ma}) A_s \frac{\mathbf{v}_{i,\perp}}{|\mathbf{v}_i|}$$

$M$ is the transonic drag rise, read at the true Mach number. The speed of sound follows from each world's gas and temperature, $c_s = \sqrt{\gamma R T / M_{gas}}$ (303 m/s on Verda's ground, 262 m/s in its cold layer):

| Mach | below 0.7 | 0.7 to 1.1 | 1.1 to 2.5 | above 2.5 |
| --- | --- | --- | --- | --- |
| $M$ | 1 | rises in a straight line to 2.0 | falls in a straight line to 1.5 | 1.5 |

A wing or fin of area $S$ at angle of attack $\alpha$, with lift-curve slope $a$ (3.6 per
radian for a wing, 1.6 for a fin). While the flow is attached:

$$C_L = a \alpha \qquad C_D = 0.012 + 0.07 C_L^2 \qquad L = \tfrac{1}{2} \rho v^2 S C_L \qquad D = \tfrac{1}{2} \rho v^2 S C_D M$$

Past the stall (16° for a wing, 26° for a fin) it blends smoothly into a flat plate, so a wing
still makes force at any angle, including backwards:

$$C_L = 0.9 \sin 2\alpha \qquad C_D = 0.012 + 1.8 \sin^2\alpha$$

Control surfaces work by adding to $\alpha$, up to 20° of throw. The totals that fly the vessel:

$$\mathbf{F} = \sum_i \mathbf{F}_i \qquad \boldsymbol{\tau} = \sum_i \mathbf{r}_i \times \mathbf{F}_i$$

Re-entry heating uses the Sutton-Graves form, with heat flux in W/m²:

$$\dot{q} = 1.83 \times 10^{-4} \sqrt{\rho} v^3$$

### What it gives you in flight

- **Stability is not scripted.** Fins at the tail put drag and lift behind the centre of mass,
  so the rocket weathervanes into the flow. Put the weight at the back and it swaps ends.
- **Max Q is real.** Dynamic pressure peaks on the way up, and that is where a hard turn snaps a
  stack or strips a rocket.
- **Wings stall.** Pull too hard and lift falls away while drag climbs.
- **Debris flies.** A torn-off booster keeps the drag of its own parts and tumbles on.

### Checked against

The independent verification covers density and pressure against scale height on six
atmospheres (exact), a capsule drop against an integrated reference (0.9 m after a 5.4 km
fall), terminal velocity, and re-entry (peak heat flux 126.7 kW/m² against a reference of
126.6, with peak heating ahead of peak deceleration as Allen and Eggers predict). Numbers and
method are in [docs/PHYSICS_VERIFICATION.md](docs/PHYSICS_VERIFICATION.md).

### What it leaves out

One scale height per atmosphere, a constant speed of sound, and no winds. Capsules and tanks
make no lift of their own shape, and neither does debris. There is no shock heating model
beyond the flux law, and no flutter or buckling: thin parts carry a stated air rating instead.
Deeper aerodynamics and re-entry is [roadmap item 6](docs/ROADMAP.md#6-deeper-aerodynamics-and-re-entry).

## Under the hood

<p align="center">
  <a href="media/architecture.png"><img src="media/architecture.png" width="100%" alt="Starwright technology and architecture. Screens and input (js/ui) send controls down to the physics core (js/core); the core's state comes up to be drawn by three.js r170 on WebGL 2 (js/render). The core is pure simulation: orbits on patched conics, a flight model on 20 ms steps, structure and breakup, guidance, the world, parts and career; n-body gravity is not built. It is checked three ways: unit tests, browser tests and an independent reference with 1,321 checks and 0 failures. Directed by Jerry Smith, written by 20+ Claude agents, reviewed independently by Grok agents. Shipped by pull request to GitHub Pages as static files with no build step"></a>
</p>

- Plain JavaScript modules. No framework, no bundler, no build step, no install. The only
  dependency is a vendored copy of [three.js](https://threejs.org/) r170.
- Everything you see and hear is generated in the browser: terrain, textures, part models and
  sound. The game ships no image or audio assets.
- The simulation in `js/core/` has no DOM access, so the same code runs the game in the browser
  and the tests in Node.

```
index.html, css/     page and styles
js/core/             simulation: orbits, bodies, parts, craft, vessel physics, world,
                     autopilot, career, contracts, scenarios
js/render/           three.js part models, worlds, terrain, atmosphere and effects
js/ui/               screens: space centre, assembly, flight, map, tracking, research,
                     missions, crew, Flight School, science reference, demo tour
docs/                architecture, manual, physics verification, parts and scenarios
tests/               unit tests, browser tests, physics verification
media/               trailer, clips and screenshots for this page
```

### Tests

The unit tests need Node 20 or newer and nothing else:

```sh
npm test            # 478 tests, including scripted flights flown by the autopilot
npm run verify      # the independent physics verification, about 6 minutes
```

The browser suites in `tests/e2e/` drive the real game in Chromium and need
[Playwright](https://playwright.dev/). Run them one at a time, for example
`node tests/e2e/flight.mjs`. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the modules
and the conventions.

## Where it stands

Starwright is version 0.1: playable from the first launch to the outer planets, and young.

- It has been played and tuned in **Chrome on a Mac**, where it runs at 60 frames a second on a
  recent MacBook Pro. Safari, Firefox and Edge have not been checked yet.
- The **Windows and Linux launchers and installers are new** and need people on those systems
  to try them and report back.
- There is no gamepad or touch support.
- Saves live in one browser on one machine. Settings can export a save to a file and import it.

## Roadmap

The next twelve upgrades, in the order we plan to take them. There are no dates: each one ships when
it is good. **[Read the full roadmap](docs/ROADMAP.md)** for what each one is, why it matters,
what the game does today, and what building it involves.

1. **[Landing legs that work like legs.](docs/ROADMAP.md#1-landing-legs-that-work-like-legs)**
   **Built.** Each leg is a spring and damper: a lander compresses, settles, bottoms out or
   breaks its legs if you come in too fast, and tips over if you come in crooked.
   [How it works and what was checked.](docs/LANDING_LEGS.md)
2. **[Structural dynamics.](docs/ROADMAP.md#2-structural-dynamics)** **Built.** Every joint
   carries a computed load, bends, and breaks when a rocket is too tall, too thin or flown too
   hard. The assembly building shows which joint is closest to its limit.
   [How it works and what was checked.](docs/STRUCTURE.md)
3. **[Aerodynamic breakup.](docs/ROADMAP.md#3-aerodynamic-breakup)** **Built.** A rocket that
   flips or tumbles in thick air has its side boosters, antennas, open panels and nose cones
   torn off, and the pieces fly on as debris. A clean climb loses nothing.
   [How it works and what was checked.](docs/AERO_BREAKUP.md)
4. **[Higher-fidelity worlds.](docs/ROADMAP.md#4-higher-fidelity-worlds)** **First pass
   built.** Every world has ground of its own at walking scale (craters, ice plates, lava
   crust, wind ripples), rocks that belong to it, a high cloud or dust layer where there is
   air, and proper dawn and dusk light on the clouds. The ground the physics stands on did not
   move. [How it works, what was checked, and what is still open.](docs/WORLDS.md)
5. **[Reusable boosters.](docs/ROADMAP.md#5-reusable-boosters)** **Three parts built.** Flip,
   boost back, steer on the grid fins and land the first stage on its legs while the upper stage
   flies on to orbit. Today a first stage with a guidance ring, fins and legs flies itself back
   and lands on the Return Pad or on a barge at sea, and one key hops between it and the upper
   stage. A stock reusable rocket, a recovery plan and recovery pay come next. [What is built and what was checked.](docs/BOOSTERS.md)
6. **[Deeper aerodynamics and re-entry.](docs/ROADMAP.md#6-deeper-aerodynamics-and-re-entry)**
   Lift on capsules so you can steer a re-entry, winds, and heating that depends on shape.
   **First step built:** a true speed of sound on every world. [The science](docs/REENTRY_SCIENCE.md) and [the build specification](docs/REENTRY_SPEC.md).
7. **[Optional n-body gravity.](docs/ROADMAP.md#7-optional-n-body-gravity)** Lagrange points,
   halo orbits and low-energy transfers, starting as an overlay in the map.
8. **[Stations and surface bases.](docs/ROADMAP.md#8-stations-and-surface-bases)** Mine a moon,
   refine propellant, and refuel ships far from home.
9. **[A deeper career.](docs/ROADMAP.md#9-a-deeper-career)** More missions, more science at
   every world, and crew who train into specialists.
10. **[A faster-than-light drive and a second star system.](docs/ROADMAP.md#10-a-faster-than-light-drive-and-a-second-star-system)**
    A part you earn by finishing the home system, which carries a ship to a new star with new
    worlds. The one fictional element, labelled as such; everything after the jump is real
    orbital mechanics.
11. **[Sharing.](docs/ROADMAP.md#11-sharing)** Trade craft with other players, and add
    community-made parts and scenarios.
12. **[A desktop app and a seat in the cockpit.](docs/ROADMAP.md#12-a-desktop-app-and-a-seat-in-the-cockpit)**
    A double-click app for Mac and Windows, a view from inside the capsule, and fuller sound.

Want one of these to happen sooner? Pick it and help build it. See the next section.

## Come build it with us

Starwright is open source and it is looking for volunteers. The game got this far quickly, and
it will get much further with people who love this kind of game looking at it from every angle.
You do not have to be a programmer.

**If you play:**
- Fly it and tell us what broke, what confused you and what felt wrong. Bug reports from real
  flights are the most valuable thing you can give.
- Try it on Windows, Linux, Safari or Firefox and report what happens.
- Share a craft, a mission idea or a scenario worth adding.

**If you know rockets, orbits or aerodynamics:**
- Read [docs/PHYSICS_VERIFICATION.md](docs/PHYSICS_VERIFICATION.md) and tell us where the
  model should be better. Lift on capsules, winds, a porkchop transfer planner and an optional
  n-body mode are all open.
- Check the numbers on the parts. If an engine's specific impulse or a tank's mass ratio makes
  you wince, say so.

**If you write code:**
- Browser support, performance on modest graphics cards, gamepad support, new parts, new
  scenarios, and whatever your first flight makes you want to fix.

**If you draw, write or compose:**
- Part models and textures are procedural and can always look better. So can the sound. The
  manual and Flight School need editors, and none of it is translated yet.

Every item on the [roadmap](#roadmap) is open for someone to pick up, whole or in part.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Then
[open an issue](../../issues/new/choose) to report a bug, suggest something, or simply say hello
and what you would like to work on.

## Credits and license

Starwright is an original game. It is inspired by the rocket-building and orbital-flight genre
and by the games and real space programs that made people love it. Its worlds, crew, art, sound
and code are its own: it uses no characters, art, music or code from any other game, and it is
not affiliated with or endorsed by the makers of Kerbal Space Program or by SpaceX.

It was directed by Jerry Smith, written by 20+ Claude AI agents and independently reviewed
by Grok AI agents; see
[How it was built](#how-it-was-built). It is not affiliated with or endorsed by Anthropic or xAI.

Starwright's code is released under the [MIT License](LICENSE). Rendering uses
[three.js](https://threejs.org/), also MIT licensed; its license is in
[js/lib/LICENSE-three.txt](js/lib/LICENSE-three.txt).

The leaves and bark of the trees are built from public-domain scans: Leaf Set 010, 014, 016, 019
and 022 and Bark 001, 004 and 014 from [ambientCG](https://ambientcg.com) by Lennart Demes,
released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The small files
made from them are in `media/flora/` (see [media/flora/README.md](media/flora/README.md));
`tools/flora_assets.py` rebuilds them.

The MIT License covers the game's code. The trailer in `media/`, including its voice-over and
music, is not offered under the MIT License: you are welcome to watch and link to it, and all
other rights in it are reserved.
