// Saving and continuing a world (used by the solo game in the browser).
// Plays a short session against the simulation, saves it, loads the save into
// a new simulation and checks that nothing was lost.   node test/save.mjs
import { Game } from '../public/sim/game.js';
import { ITEMS, ITEM_INDEX, OBJECTS, INV_SIZE, PLAYER_R } from '../public/shared/defs.js';
import { placementSpot, placementError } from '../public/shared/physics.js';

let failed = 0;
let passed = 0;
function ok(cond, what) {
  if (cond) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failed++;
    console.log(`  FAIL ${what}`);
  }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// a clock we control: every tick is exactly 50 ms
let clockMs = 0;
const clock = () => clockMs;
const quiet = () => {};

/** A player without a network: talks to the simulation like the solo game does. */
class Tester {
  constructor(game, name, token) {
    this.game = game;
    this.events = [];
    this.init = null;
    this.conn = {
      player: null,
      send: (o) => this.receive(o),
      sendVolatile: (o) => this.receive(o),
    };
    this.msg(['join', name, 2, token]);
  }

  receive(o) {
    const m = JSON.parse(JSON.stringify(o)); // exactly what would arrive over the wire
    if (m.t === 'init') this.init = m;
    else if (m.t === 'e') this.events.push(...m.ev);
  }

  get p() {
    return this.conn.player;
  }

  msg(m) {
    this.game.handleMessage(this.conn, JSON.parse(JSON.stringify(m)));
  }

  run(seconds) {
    for (let i = 0; i < Math.round(seconds * 20); i++) {
      clockMs += 50;
      this.game.tick(0.05);
    }
  }

  say(text) {
    this.msg(['chat', text]);
  }

  count(item) {
    return this.p.inv.reduce((n, s) => n + (s && s.id === item ? s.n : 0), 0);
  }

  hold(item) {
    const slot = this.p.inv.findIndex((s) => s && s.id === item);
    if (slot < 0) throw new Error(`no ${item} in the inventory`);
    this.msg(['sel', slot]);
  }

  /** Teleports next to an object (cheat) and faces it. */
  goTo(o, gap = 6) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = o.x + Math.cos(a) * (o.r + PLAYER_R + gap);
      const y = o.y + Math.sin(a) * (o.r + PLAYER_R + gap);
      if (this.game.world.isWater(x, y)) continue;
      this.say(`/tp ${x.toFixed(1)} ${y.toFixed(1)}`);
      if (Math.hypot(this.p.x - o.x, this.p.y - o.y) < o.r + PLAYER_R + gap + 12) return;
    }
    throw new Error('cannot stand next to the object');
  }

  /** Hits an object until `done()` is true. */
  hit(o, done, max = 60) {
    for (let i = 0; i < max && !done(); i++) {
      this.run(0.5);
      this.msg(['u', Math.atan2(o.y - this.p.y, o.x - this.p.x), o.x, o.y]);
    }
    if (!done()) throw new Error('hitting had no effect');
  }

  /** Places the building item, somewhere free around the player. */
  build(item) {
    this.hold(item);
    const type = ITEMS[item].obj;
    const p = this.p;
    for (const dist of [80, 110, 140]) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const tx = p.x + Math.cos(a) * dist;
        const ty = p.y + Math.sin(a) * dist;
        const spot = placementSpot(p.x, p.y, tx, ty, type);
        if (placementError(this.game.world, this.game.spawn, type, spot.x, spot.y)) continue;
        const before = this.game.nextObjId;
        this.run(0.25);
        this.msg(['u', a, tx, ty]);
        if (this.game.nextObjId > before) return this.game.world.objects.get(before);
      }
    }
    throw new Error(`no room to build a ${item}`);
  }
}

const nearestOf = (game, x, y, pred) => {
  let best = null;
  let bestD = Infinity;
  for (const o of game.world.objects.values()) {
    if (!pred(o)) continue;
    const d = Math.hypot(o.x - x, o.y - y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
};

const TOKEN = 'solo-player';
const SEED = 4242;

// ---------------------------------------------------------------------------
console.log('a short game');
const game = new Game({ seed: SEED, cheats: true, log: quiet, clock, startTod: 0.3 });
const ann = new Tester(game, 'Ann', TOKEN);
ok(!!ann.init && ann.init.you.resumed === false, 'joined a new world');
ann.say('/noshield');
for (const [item, n] of [['axe', 1], ['pickaxe', 1], ['wood', 80], ['stone', 9], ['berries', 7], ['campfire', 1], ['tent', 1], ['wall', 3], ['spikes', 1], ['spear', 1]]) {
  ann.say(`/give ${item} ${n}`);
}
ann.run(0.2);

// a camp away from the Great Fire
const sx = game.spawn.x;
const sy = game.spawn.y;
ann.say(`/tp ${sx + 330} ${sy + 40}`);
const fire = ann.build('campfire');
const tent = ann.build('tent');
const wall1 = ann.build('wall');
const wall2 = ann.build('wall');
const spikes = ann.build('spikes');
ok(fire.type === 'campfire' && tent.type === 'tent' && wall1.type === 'wall' && spikes.type === 'spikes', 'built a campfire, a tent, two walls and spikes');
ok(ann.p.tent === tent.id, 'the tent is the respawn point');

// damage a wall, feed the fire
ann.hold('spear');
ann.goTo(wall1);
ann.hit(wall1, () => wall1.hp < OBJECTS.wall.hp - 20);
ann.goTo(fire, 10);
const fuelBefore = fire.fuel;
ann.msg(['e']);
ann.msg(['e']);
ok(fire.fuel > fuelBefore, 'fed the campfire');

// a stump, an empty bush and a rock that is used up
const tree = nearestOf(game, ann.p.x, ann.p.y, (o) => OBJECTS[o.type].kind === 'tree');
ann.hold('axe');
ann.goTo(tree);
ann.hit(tree, () => tree.state === 1);
const tree2 = nearestOf(game, ann.p.x, ann.p.y, (o) => OBJECTS[o.type].kind === 'tree' && o.state === 0);
ann.goTo(tree2);
ann.hit(tree2, () => tree2.amount <= OBJECTS[tree2.type].amount - 6);
const bush = nearestOf(game, ann.p.x, ann.p.y, (o) => o.type === 'bush');
ann.goTo(bush);
ann.hit(bush, () => bush.state === 1);
const rock = nearestOf(game, ann.p.x, ann.p.y, (o) => o.type === 'rock');
const rockPos = { x: rock.x, y: rock.y };
ann.hold('pickaxe');
ann.goTo(rock);
ann.hit(rock, () => !game.world.objects.has(rock.id));
ok(tree.state === 1 && bush.state === 1 && game.regrow.size === 2, 'a tree and a bush are used up');
ok(tree2.state === 0 && tree2.amount < OBJECTS[tree2.type].amount, 'another tree is half chopped');
ok(game.rockGraves.length === 1, 'a rock is used up');

// something on the ground: drop 5 berries, then walk away from them
const berries = ann.count('berries');
ann.hold('berries');
for (let i = 0; i < 5; i++) ann.msg(['d', ann.p.sel, false]);
ann.say(`/tp ${fire.x + 60} ${fire.y}`);
ann.run(3);
ok(game.drops.size === 5 && ann.count('berries') === berries - 5, 'five berries lie on the ground');

// let some time pass (hunger, fire burning down, time of day)
ann.say('/set hp 61');
ann.run(45);
const p1 = ann.p;
const before = {
  time: game.time, day: game.day, phase: game.phase, objects: game.world.objects.size, fuel: fire.fuel, wallHp: wall1.hp,
  x: p1.x, y: p1.y, hp: p1.hp, hunger: p1.hunger, warmth: p1.warmth, sel: p1.sel, inv: JSON.stringify(game.invWire(p1)),
  tiles: game.tileString, lived: game.time - p1.bornAt,
  treeDue: tree.regrowAt - game.time, graveDue: game.rockGraves[0].at - game.time,
  dropCount: game.drops.size, // five berries, and meat if an animal ran into the spikes meanwhile
  drops: [...game.drops.values()].map((d) => `${d.item}x${d.n}@${Math.round(d.x)},${Math.round(d.y)}`).sort().join(' '),
};
ok(p1.alive && p1.hp > 50 && p1.hunger < 95, 'the survivor is alive and a little hungry');

// ---------------------------------------------------------------------------
console.log('save and load');
const json = JSON.stringify(game.exportState());
ok(json.length < 200 * 1024, `the save is small (${(json.length / 1024).toFixed(1)} KB)`);
const game2 = new Game({ state: JSON.parse(json), cheats: true, log: quiet, clock, seed: 1 });
ok(game2.seed === SEED && game2.tileString === before.tiles, 'same island');
ok(near(game2.time, before.time, 0.06) && game2.day === before.day && game2.phase === before.phase, 'same day and time of day');
ok(game2.world.objects.size === before.objects, `same number of objects (${before.objects})`);
let same = 0;
for (const o of game.world.objects.values()) {
  const c = game2.world.objects.get(o.id);
  if (c && c.type === o.type && c.x === o.x && c.y === o.y && c.state === o.state && c.r === o.r && (c.amount ?? 0) === (o.amount ?? 0)
    && near(c.hp ?? 0, o.hp ?? 0, 0.06) && (c.fuel === o.fuel || near(c.fuel, o.fuel, 0.06))) same++;
}
ok(same === before.objects, 'every tree, rock and building is as it was');
const fire2 = game2.world.objects.get(fire.id);
ok(fire2 && fire2.state === 1 && near(fire2.fuel, before.fuel, 0.06) && game2.fires.has(fire2), 'the campfire burns with the same fuel');
ok(game2.fires.size === game.fires.size && game2.spikes.size === 1, 'fires and spikes are active');
ok(near(game2.world.objects.get(wall1.id).hp, before.wallHp, 0.06) && before.wallHp < OBJECTS.wall.hp, 'the damaged wall is still damaged');
const tree2b = game2.world.objects.get(tree2.id);
ok(tree2b.amount === tree2.amount, 'the half chopped tree is still half chopped');
const treeB = game2.world.objects.get(tree.id);
ok(game2.regrow.size === 2 && game2.regrow.has(treeB) && near(treeB.regrowAt - game2.time, before.treeDue, 1), 'stump and bush will still grow back');
ok(game2.rockGraves.length === 1 && near(game2.rockGraves[0].at - game2.time, before.graveDue, 1), 'the rock will still come back');
const drops2 = [...game2.drops.values()].map((d) => `${d.item}x${d.n}@${Math.round(d.x)},${Math.round(d.y)}`).sort().join(' ');
ok(drops2 === before.drops && game2.drops.size === before.dropCount && /berriesx1@/.test(drops2), 'the berries still lie on the ground');
ok(game2.mobs.size > 40, `the island has animals again (${game2.mobs.size})`);
let close = 0;
for (const m of game2.mobs.values()) if (['wolf', 'bear', 'boar'].includes(m.type) && Math.hypot(m.x - before.x, m.y - before.y) < 900) close++;
ok(close === 0, 'no dangerous animal appeared next to the survivor');

const ann2 = new Tester(game2, 'Ann', TOKEN);
const p2 = ann2.p;
ok(ann2.init.you.resumed === true, 'the survivor continues');
ok(near(p2.x, before.x, 0.01) && near(p2.y, before.y, 0.01), 'at the same place');
ok(near(p2.hp, before.hp, 0.01) && near(p2.hunger, before.hunger, 0.01) && near(p2.warmth, before.warmth, 0.01), 'with the same health, hunger and warmth');
ok(JSON.stringify(game2.invWire(p2)) === before.inv && p2.sel === before.sel, 'with the same things in the same slots');
ok(p2.tent === tent.id, 'and the same tent');
ok(near(game2.time - p2.bornAt, before.lived, 0.1), 'days survived keep counting');
ok(ann2.init.objs.length === before.objects && ann2.init.day === before.day, 'the client is told about the whole world');

// saving twice gives the same save
const again = JSON.parse(JSON.stringify(new Game({ state: JSON.parse(json), log: quiet, clock }).exportState()));
const first = JSON.parse(json);
for (const s of [again, first]) for (const pl of Object.values(s.players)) delete pl.savedAt;
ok(JSON.stringify(again) === JSON.stringify(first), 'loading and saving again changes nothing');

// ---------------------------------------------------------------------------
console.log('the loaded world keeps working');
const wall3 = ann2.build('wall');
ok(wall3 && wall3.id >= game.nextObjId && !game.world.objects.has(wall3.id), 'new buildings get fresh ids');
// wait at the campfire, through the evening and into the night, until things grow back
ann2.say(`/tp ${fire.x + 60} ${fire.y}`);
const grown = () => treeB.state === 0 && treeB.amount === OBJECTS[treeB.type].amount;
for (let i = 0; i < 400 && !(grown() && game2.rockGraves.length === 0); i++) {
  ann2.run(1);
  for (const what of ['hp', 'hunger', 'warmth']) ann2.say(`/set ${what} 100`);
  if (fire2.fuel < 200 && ann2.count('wood') > 0) ann2.msg(['e']);
}
ok(ann2.p.alive && fire2.state === 1, 'the survivor waited at the fire');
ok(grown(), 'the stump grew back into a tree');
const rockBack = nearestOf(game2, rockPos.x, rockPos.y, (o) => o.type === 'rock');
ok(game2.rockGraves.length === 0 && rockBack && rockBack.x === rockPos.x && rockBack.y === rockPos.y, 'the rock came back');

// ---------------------------------------------------------------------------
console.log('dying, then loading');
ann2.say(`/tp ${tent.x + 60} ${tent.y + 60}`);
ann2.say('/give wood 10');
ann2.run(0.2);
ann2.say('/hurt 999');
ann2.run(0.2);
ok(!ann2.p.alive, 'the survivor died');
const game3 = new Game({ state: JSON.parse(JSON.stringify(game2.exportState())), log: quiet, clock });
ok(game3.drops.size >= 3, 'the lost things lie on the ground');
const ann3 = new Tester(game3, 'Ann', TOKEN);
ok(ann3.init.you.resumed === false && ann3.p.alive && ann3.p.inv.every((s) => !s), 'a new survivor starts with empty hands');
const tent3 = game3.world.objects.get(tent.id);
ok(ann3.p.tent === tent.id && Math.hypot(ann3.p.x - tent3.x, ann3.p.y - tent3.y) < 140, 'next to the tent');

// ---------------------------------------------------------------------------
console.log('damaged saves');
const throws = (state) => {
  try {
    // eslint-disable-next-line no-new
    new Game({ state, log: quiet, clock });
    return false;
  } catch {
    return true;
  }
};
ok(throws({ v: 99, seed: 1, time: 0, objects: [] }), 'a save from an unknown version is refused');
ok(throws({}) && throws({ v: 1, seed: 'x', time: 0, objects: [] }) && throws({ v: 1, seed: 1, time: 0 }), 'nonsense is refused');
const odd = JSON.parse(json);
odd.objects.push([999990, 'flying_castle', 100, 100, 0, 0, 0, 0, 0]);
odd.objects.push([999991, 'wall', null, 'x', 0, 0, 50, 0, 0]);
odd.rockGraves.push(['rock', null, 5, 10], ['rock', 3000, 3000, null]);
odd.objects.push([fire.id, 'wall', 500, 500, 0, 0, 50, 0, 0]); // same id twice
odd.drops.push(['unobtainium', 3, 3300, 3300, 100]);
odd.players[TOKEN].inv[INV_SIZE - 1] = { id: 'unobtainium', n: 2 };
odd.players[TOKEN].inv[INV_SIZE - 2] = { id: 'wood', n: 1e9 };
odd.players[TOKEN].hp = 1e9;
odd.players.broken = { name: 'x' };
const game4 = new Game({ state: odd, log: quiet, clock });
const ann4 = new Tester(game4, 'Ann', TOKEN);
ok(game4.world.objects.size === before.objects && game4.world.objects.get(fire.id).type === 'campfire' && game4.rockGraves.length === 1, 'unknown, doubled and misplaced objects are skipped');
ok(game4.drops.size === before.dropCount, 'unknown things on the ground are skipped');
ok(ann4.init.you.resumed && ann4.p.inv[INV_SIZE - 1] === null && ann4.p.inv[INV_SIZE - 2].n <= 999 && ann4.p.hp <= 100, 'unknown items are dropped and numbers are kept in range');
ok(ITEM_INDEX.wood >= 0 && !game4.sessions.has('broken'), 'a broken survivor entry is skipped');
ann4.run(5);
ok(ann4.p.alive, 'and the game runs on');

console.log(failed ? `\n${failed} of ${passed + failed} checks FAILED` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
