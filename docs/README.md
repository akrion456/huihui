# Wildwood

A top-down forest survival game for the browser: gather wood and stone, craft
tools, hunt, cook, build a camp and get through the nights.

There are two ways to play, and both are the same game:

- **Solo, straight from a web page.** Nothing to install, no server. The whole
  game runs in the browser.
- **Together, on a server.** One Node.js process serves the page and runs one
  shared island for everyone who opens it.

No build step, no database.

## Play it in the browser

**https://akrion456.github.io/huihui/**

That address is the GitHub Pages site of this repository. It works once Pages is
switched on (see [Hosting](#hosting-on-github-pages)).

- You get an island of your own; every new game makes a different one.
- The island is saved in the browser by itself: every ten seconds and whenever
  you leave the page. Come back later, press **CONTINUE** and go on where you
  stopped. "Start a new island" on the start screen throws the old one away.
- The save lives in that browser on that device. Another browser or another
  device starts fresh, and so does a private window after it is closed.
- The world waits while the help is open or the tab is in the background.

## Run a server to play together

Needs Node.js 18 or newer (developed and tested on Node 22).

```bash
npm install
npm start          # http://localhost:3000
```

Open the address in a few tabs, or from other computers on the same network, to
play together. One server holds one shared world for up to 40 players.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | port to listen on |
| `HOST` | `0.0.0.0` | address to bind |
| `SEED` | `12345` | world seed: same seed, same island |
| `DAY_LENGTH` | `450` | seconds for a full day and night |
| `START_TOD` | `0.08` | time of day at start, 0..1 (0 is sunrise, about 0.64 is nightfall) |
| `CHEATS` | off | `1` enables the test commands below |

`npm run dev` restarts the server when a file changes.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` or arrows | move |
| mouse | aim; hold the button (or `Space`) to hit, eat, shoot or place |
| `1`-`8`, mouse wheel, click a slot | select an item |
| drag a slot | rearrange; drag out of the bar to drop |
| `Q` / right-click a slot | drop one (with `Shift`: the whole stack) |
| click a recipe | craft (with `Shift`: five at once) |
| `E` | add wood to a campfire, or claim a tent |
| `Enter` | chat |
| `H` / `M` / `R` | help / sound on-off / respawn |

On touch screens a stick and buttons appear instead: drag on the left side to
walk, hold **ACT** to hit, eat, shoot or build, tap the world to do it right
there, tap slots and recipes. The help in the game (`?` button) lists them.

## How the game works

- **Day and night.** A full cycle takes 7.5 minutes. Nights are dark and cold:
  away from a fire you slowly freeze. A torch or hide armor halves that.
- **Hunger.** A full belly lasts about a day. Berries are a snack; cook meat at a fire.
- **Wolves.** A few roam far from the camp by day. At night a pack hunts every
  survivor, and it grows as the days pass. Wolves keep their distance from a
  burning fire unless you attack them. From day 3 dire wolves join in, and they
  do not fear fire.
- **Fire.** The Great Fire in the middle of the island never goes out. Campfires
  you build burn down and must be fed wood.
- **Building.** Walls and gates keep beasts out (players walk through gates),
  spikes hurt every beast that touches them, a tent is where you come back after
  dying. Beasts that cannot reach you chew through buildings.
- **Death.** Everything you carry drops where you fell. You return at your tent,
  or at the Great Fire.
- **Together.** Survivors cannot hurt each other. Trees, bushes and rocks grow back.
- **Reconnecting.** On a server: reload the tab within 10 minutes and you keep
  your character. Solo: the island and your character are saved, see above.

| Craft | Cost | |
| --- | --- | --- |
| Axe | 8 wood, 4 stone | chops trees 3x faster |
| Pickaxe | 8 wood, 4 stone | mines rocks 3x faster |
| Spear | 12 wood, 5 stone | long reach, the best melee weapon |
| Torch | 6 wood | light in the dark |
| Campfire | 12 wood, 6 stone | warmth, light, cooking |
| Cooked meat | 1 raw meat | only next to a burning fire |
| Bow | 14 wood, 2 hide | shoots arrows |
| Arrows (6) | 4 wood, 2 stone | |
| Wood wall | 8 wood | |
| Gate | 14 wood | |
| Spikes | 10 wood, 4 stone | |
| Tent | 20 wood, 6 hide | respawn point |
| Hide armor | 8 hide | 35% less damage, lost on death |

Animals: rabbits and deer run away, boars fight back when attacked, bears defend
their territory, wolves and dire wolves hunt.

## How it is built

```
public/           everything a browser needs; this folder is the whole web site
  index.html, css/, assets/
  js/             the client: canvas renderer, HUD, input, sound
    net.js        connection to a game server (WebSocket, or HTTP polling)
    local.js      the solo game: runs the simulation in the page, saves the island
  sim/game.js     the simulation: players, animals, crafting, building, day/night
  sim/worldgen.js island generator
  shared/defs.js  all game data (items, recipes, animals, constants)
  shared/physics.js  collision and building rules
server/index.js   web server, WebSocket + HTTP polling transport, 20 Hz loop
index.html        sends visitors of the GitHub Pages site on to public/
.nojekyll         tells GitHub Pages to publish the files as they are
test/             smoke.mjs, save.mjs, solo.mjs (see Testing); bot.mjs is a headless player
art/              raw/ and svg/ sources of the pictures in public/assets/
tools/            scripts that turn the art sources into sprites
```

- The simulation (`public/sim/`) decides everything. It uses nothing that only
  Node.js or only a browser has, so the same file runs in both places: the
  server imports it for the shared world, the page imports it for the solo game.
- When the page starts it asks its host for `api/status`. A game server answers,
  and the page connects to it. A plain web host answers "no such file", and the
  page plays solo. To the rest of the client that makes no difference: it talks
  to a "connection" either way, and the same messages go back and forth.
- The browser moves its own player at once for a snappy feel; the simulation
  checks every step and corrects cheating or lag.
- With a server, messages are JSON over a WebSocket. Where WebSockets are blocked
  the client falls back to plain HTTP polling by itself.
- `Game.exportState()` returns a world as JSON and `new Game({ state })` continues
  it. The solo game keeps that in the browser's `localStorage`. Animals are not
  saved; the island is repopulated when a save is loaded.
- The game can be embedded in a frame of another site and runs without browser
  storage (it then forgets name, sound setting and, when played solo, the island).

Page parameters: `?autojoin=Name&skin=0..3` skips the start screen, `?solo` plays
solo even when a server is there, `?seed=123` chooses the island of a new solo
game, `?cheats` enables the test commands below in a solo game,
`?transport=poll` forces HTTP polling, `?debug` draws collision shapes.

## Hosting on GitHub Pages

The solo game needs nothing but the files, so GitHub can host it for free:
repository **Settings → Pages → Build and deployment → Source: "Deploy from a
branch" → Branch: `main`, folder `/ (root)` → Save**. A minute later the game is
at `https://<user>.github.io/<repository>/`, and every push to `main` updates it.

Any other host for static files works the same way: publish the `public/` folder.

## Testing

```bash
npm test             # all three scripts below
npm run bots         # three computer-controlled survivors join localhost:3000
```

| Script | What it checks |
| --- | --- |
| `test/smoke.mjs` | starts its own server; 39 end-to-end checks with bot players over WebSocket and polling |
| `test/save.mjs` | plays a short game against the simulation, saves, loads, and compares; damaged saves (46 checks) |
| `test/solo.mjs` | the solo connection (`local.js`) against a made-up page: pause, saving, two tabs (34 checks) |

With `CHEATS=1` on a server, or `?cheats` in a solo game, these chat commands
exist: `/give <item> [n]`, `/tp <x> <y>`, `/time <0..1>`, `/mob <animal> [distance]`,
`/hurt [hp]`, `/set hp|hunger|warmth <n>`, `/noshield`.

What has been checked so far, besides the scripts above, by playing in headless
Chrome with real keyboard, mouse and touch input:

- On a server: joining, gathering, crafting, eating, placing and feeding a
  campfire, cooking, walls, gate, spikes, tent, dying and coming back, spear,
  bow, armor, night, chat between two players, polling.
- Solo, served as plain files under `/huihui/` the way GitHub Pages does it:
  gathering, crafting every recipe, eating, placing a campfire, tent, wall,
  spikes and gate, cooking, feeding the fire, the bow, a night with cold and
  wolves, a spear fight, dying and coming back at the tent. Also saving, closing
  the page and continuing, starting a new island, the pause, the same island
  open in two tabs, blocked and full browser storage, and running inside a
  sandboxed frame of another site.
- Touch controls in Chrome's phone emulation, landscape and portrait, both modes.

Not yet checked: real phones and tablets, browsers other than Chrome, and the
published GitHub Pages address itself (it could not be reached from the
development machine).

## Art

- Scenery and buildings (13 sprites: trees, stump, rock, berry bush, campfire,
  wall, gate, spikes, tent) come from 10 AI-generated pictures in `art/raw/`.
  `tools/process_art.py` cuts them out and scales them.
- Survivors, animals, item and UI icons and ground decoration (53 sprites) are
  drawn by code: `tools/gen_art.mjs` writes SVG files to `art/svg/` and
  `tools/rasterize.mjs` renders them to PNG.
- Ground, water and shores are painted by the client at run time; sounds are
  synthesised, so there are no audio files.

The finished sprites are committed, so the tools are only needed to change the art.
Each script explains its requirements in its first lines.
