# Wildwood

A multiplayer, top-down forest survival game for the browser. Everyone who opens
the page lands on the same island: gather wood and stone, craft tools, hunt, cook,
build a camp and get through the nights together.

One Node.js process serves the page and runs the world. No build step, no database.

## Run it

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

On touch screens a stick and buttons appear instead.

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
- **Reconnecting.** Reload the tab within 10 minutes and you keep your character.

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
server/   index.js    web server, WebSocket + HTTP polling transport, 20 Hz loop
          game.js     the simulation: players, animals, crafting, building, day/night
          worldgen.js island generator
shared/   defs.js     all game data (items, recipes, animals, constants)
          physics.js  collision and building rules, used by server and browser
public/   the browser client: canvas renderer, HUD, input, sound
test/     smoke.mjs   end-to-end test; bot.mjs is a headless player
art/      raw/ and svg/ sources of the pictures in public/assets/
tools/    scripts that turn the art sources into sprites
```

- The server decides everything. The browser moves its own player at once for a
  snappy feel; the server checks every step and corrects cheating or lag.
- Messages are JSON over a WebSocket. Where WebSockets are blocked the client
  falls back to plain HTTP polling by itself.
- The game can be embedded in a frame of another site and runs without browser
  storage (it then forgets name and sound setting).

Page parameters: `?autojoin=Name&skin=0..3` skips the start screen,
`?transport=poll` forces HTTP polling, `?debug` draws collision shapes.

## Testing

```bash
npm test             # starts its own server, 39 end-to-end checks with bot players
npm run bots         # three computer-controlled survivors join localhost:3000
```

With `CHEATS=1` these chat commands exist: `/give <item> [n]`, `/tp <x> <y>`,
`/time <0..1>`, `/mob <animal> [distance]`, `/hurt [hp]`,
`/set hp|hunger|warmth <n>`, `/noshield`.

What has been checked so far: the end-to-end test above, and play in headless
Chrome with real keyboard and mouse input: joining, gathering, crafting, eating,
placing and feeding a campfire, cooking, walls, gate, spikes, tent, dying and
coming back, spear, bow, armor, night, chat between two players, and running
inside a frame of another site. Touch controls were played in Chrome's phone
emulation (landscape and portrait).
Not yet checked: real phones and tablets, and browsers other than Chrome.

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
