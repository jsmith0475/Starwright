# Contributing to Starwright

Thank you for wanting to help. Starwright is a volunteer project, and every kind of help counts:
a bug report from a real flight, a test on a browser nobody has tried, a correction to the
physics, a new part, a clearer sentence in the manual.

## Ways to help without writing code

- **Play and report.** [Open an issue](../../issues/new/choose) when something breaks, confuses
  you or feels wrong. Say what you were doing, what you expected, what happened, and your
  system and browser. A screenshot helps. If the game offers a save export (Settings), attach
  it.
- **Test where we have not.** The game has been played in Chrome on a Mac. Reports from
  Windows, Linux, Safari, Firefox and Edge are wanted, including "it just worked".
- **Check the science.** [docs/PHYSICS_VERIFICATION.md](docs/PHYSICS_VERIFICATION.md) says what
  the model does and where it falls short. If you see an error or a better method, tell us.
- **Share ideas.** Craft, missions, scenarios, worlds, lessons for Flight School.

## Setting up to work on the code

There is nothing to install or build.

```sh
git clone https://github.com/jsmith0475/Starwright.git
cd Starwright
./start.sh            # macOS and Linux; on Windows double-click start.bat
```

Edit a file, reload the browser tab, and your change is running. The server sends no-cache
headers, so a plain reload is enough.

To run the tests you need Node 20 or newer:

```sh
npm test              # unit tests and scripted flights, a few seconds to a few minutes
npm run verify        # independent physics verification, about 6 minutes
```

The browser suites in `tests/e2e/` need [Playwright](https://playwright.dev/). Run them one at
a time; several checks are timing-sensitive.

## How the code is organised

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. The short version:

- `js/core/` is the simulation. It has no DOM and no three.js, and it must stay that way so it
  runs in Node for the tests.
- `js/render/` draws things with three.js. `js/ui/` is the screens.
- Plain ES modules, no build step, no new runtime dependencies. All art and sound is generated
  in code; the game ships no image or audio files.

## Ground rules

- **Starwright is original.** Do not add names, characters, art, music, text or data taken from
  Kerbal Space Program or any other game, and do not add real companies' logos or trademarks.
  Genre conventions are welcome; copies are not.
- **Keep the tests green, and never weaken one to get there.** If a test is wrong, say why in
  the pull request. A bug fix should come with a check that fails without the fix.
- **Keep the physics honest.** If you change the flight model, run `npm run verify` and update
  the verification document with what changed.
- **Small pull requests.** One change, explained in plain words: what it does, how you tested
  it, and a screenshot if it changes what the player sees.
- **Be kind.** Assume good intent, criticise the work and not the person, and make newcomers
  welcome. Harassment is not tolerated.

## Making a pull request

1. For anything larger than a small fix, open an issue first so nobody duplicates work.
2. Fork the repository and make a branch.
3. Make your change, run `npm test`, and try it in the game.
4. Open a pull request against `main`.

## License of contributions

Starwright is released under the [MIT License](LICENSE). By submitting a contribution you agree
that it is your own work, or that you have the right to submit it, and that it is licensed under
the same MIT License.
