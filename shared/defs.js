// Game data shared by the server (authoritative simulation) and the browser.
// Everything here is plain data + tiny pure helpers.

export const PROTOCOL = 1;

export const TILE = 64; // world pixels per terrain tile
export const MAP_W = 100; // tiles
export const MAP_H = 100;
export const GRID = 48; // building grid for walls, gates and spikes

export const TICK_RATE = 20; // server simulation + snapshot rate (Hz)
export const VIEW_W = 1400; // largest world area a client shows
export const VIEW_H = 900;

export const DAY_LENGTH = 450; // seconds for a full day/night cycle
export const START_TOD = 0.08; // time of day when the server boots

export const PLAYER_R = 14;
export const PLAYER_SPEED = 205;
export const PLAYER_MAX_HP = 100;
export const INV_SIZE = 16;
export const PLACE_RANGE = 170;
export const INTERACT_RANGE = 70;
export const PICKUP_RANGE = 36;
export const SPAWN_SAFE_RADIUS = 220; // nothing can be built around the Great Fire

// ------------------------------------------------------------------ terrain
export const T_WATER = 0;
export const T_SAND = 1;
export const T_GRASS = 2;
export const T_FOREST = 3;
export const T_DIRT = 4;

// ------------------------------------------------------------------ time of day
// tod runs 0..1 : 0 = sunrise. Darkness ramps up at dusk and down at dawn.
export const TOD_DUSK = 0.56;
export const TOD_NIGHT = 0.64;
export const TOD_DAWN = 0.92;

const smooth = (t) => t * t * (3 - 2 * t);

/** 0 = full daylight ... 1 = deep night */
export function nightAmount(tod) {
  if (tod < TOD_DUSK) return 0;
  if (tod < TOD_NIGHT) return smooth((tod - TOD_DUSK) / (TOD_NIGHT - TOD_DUSK));
  if (tod < TOD_DAWN) return 1;
  return 1 - smooth((tod - TOD_DAWN) / (1 - TOD_DAWN));
}

export function phaseOf(tod) {
  if (tod < TOD_DUSK) return 'day';
  if (tod < TOD_NIGHT) return 'dusk';
  if (tod < TOD_DAWN) return 'night';
  return 'dawn';
}

/** "06:00" style clock text (sunrise = 06:00). */
export function clockText(tod) {
  const mins = Math.floor(((tod * 24 + 6) % 24) * 60);
  const h = Math.floor(mins / 60);
  const m = Math.floor((mins % 60) / 10) * 10;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ items
// kind: res | food | tool | bow | ammo | build
export const HAND = { name: 'Hands', dmg: 5, chop: 1, mine: 1, reach: 62, cd: 0.4 };

export const ITEMS = {
  wood: { name: 'Wood', kind: 'res', desc: 'Building material and fuel for fires.' },
  stone: { name: 'Stone', kind: 'res', desc: 'Used for tools and weapons.' },
  hide: { name: 'Hide', kind: 'res', desc: 'Animal skin. Hunt animals to get it.' },
  berries: { name: 'Berries', kind: 'food', food: 9, heal: 0, desc: 'Click to eat. A small snack.' },
  meat_raw: { name: 'Raw Meat', kind: 'food', food: 10, heal: -4, desc: 'Eating it raw hurts. Cook it at a fire!' },
  meat_cooked: { name: 'Cooked Meat', kind: 'food', food: 38, heal: 12, desc: 'Click to eat. Filling and healing.' },
  axe: { name: 'Axe', kind: 'tool', dmg: 12, chop: 3, mine: 1, reach: 74, cd: 0.42, desc: 'Chops trees 3x faster.' },
  pickaxe: { name: 'Pickaxe', kind: 'tool', dmg: 10, chop: 1, mine: 3, reach: 74, cd: 0.42, desc: 'Mines rocks 3x faster.' },
  spear: { name: 'Spear', kind: 'tool', dmg: 24, chop: 1, mine: 1, reach: 104, cd: 0.5, desc: 'Long reach, strong against beasts.' },
  torch: { name: 'Torch', kind: 'tool', dmg: 9, chop: 1, mine: 1, reach: 70, cd: 0.45, light: 240, desc: 'Light in the dark. Keeps you a bit warmer.' },
  bow: { name: 'Bow', kind: 'bow', cd: 0.65, desc: 'Shoots arrows at whatever you aim at.' },
  arrow: { name: 'Arrow', kind: 'ammo', dmg: 20, desc: 'Ammunition for the bow.' },
  campfire: { name: 'Campfire', kind: 'build', obj: 'campfire', desc: 'Warmth, light and cooking. Wolves fear it. Feed it wood.' },
  wall: { name: 'Wood Wall', kind: 'build', obj: 'wall', desc: 'Keeps beasts out.' },
  gate: { name: 'Gate', kind: 'build', obj: 'gate', desc: 'Players can walk through, beasts cannot.' },
  spikes: { name: 'Spikes', kind: 'build', obj: 'spikes', desc: 'Hurts every beast that touches it.' },
  tent: { name: 'Tent', kind: 'build', obj: 'tent', desc: 'You respawn here when you die.' },
};
export const ITEM_IDS = Object.keys(ITEMS);
export const ITEM_INDEX = Object.fromEntries(ITEM_IDS.map((id, i) => [id, i]));
export const MAX_STACK = 999;
export const stackSize = (id) => (ITEMS[id].kind === 'tool' || ITEMS[id].kind === 'bow' ? 1 : MAX_STACK);

// ------------------------------------------------------------------ crafting
// near: 'fire' -> must stand next to a burning fire
export const RECIPES = [
  { id: 'axe', out: 'axe', n: 1, cost: { wood: 8, stone: 4 } },
  { id: 'pickaxe', out: 'pickaxe', n: 1, cost: { wood: 8, stone: 4 } },
  { id: 'spear', out: 'spear', n: 1, cost: { wood: 12, stone: 5 } },
  { id: 'torch', out: 'torch', n: 1, cost: { wood: 6 } },
  { id: 'campfire', out: 'campfire', n: 1, cost: { wood: 12, stone: 6 } },
  { id: 'cook', out: 'meat_cooked', n: 1, cost: { meat_raw: 1 }, near: 'fire' },
  { id: 'bow', out: 'bow', n: 1, cost: { wood: 14, hide: 2 } },
  { id: 'arrow', out: 'arrow', n: 6, cost: { wood: 4, stone: 2 } },
  { id: 'wall', out: 'wall', n: 1, cost: { wood: 8 } },
  { id: 'gate', out: 'gate', n: 1, cost: { wood: 14 } },
  { id: 'spikes', out: 'spikes', n: 1, cost: { wood: 10, stone: 4 } },
  { id: 'tent', out: 'tent', n: 1, cost: { wood: 20, hide: 6 } },
  { id: 'armor', equip: 'armor', name: 'Hide Armor', cost: { hide: 8 }, desc: 'Worn at once. -35% damage, half as cold at night. Lost on death.' },
];

export const ARMOR_FACTOR = 0.65;
export const FIRE_COOK_RANGE = 130;
export const FUEL_PER_WOOD = 60;

// ------------------------------------------------------------------ world objects
// kind: tree | rock | bush | build | fixed
//  r       collision radius          amount  resource units before it is used up
//  regrow  [min,max] seconds         hp      structure health
export const OBJECTS = {
  tree_pine: { kind: 'tree', r: 15, amount: 12, gives: 'wood', regrow: [100, 170] },
  tree_oak: { kind: 'tree', r: 17, amount: 16, gives: 'wood', regrow: [110, 180] },
  rock: { kind: 'rock', r: 30, amount: 20, gives: 'stone', regrow: [200, 300] },
  bush: { kind: 'bush', r: 19, amount: 5, gives: 'berries', regrow: [80, 130] },
  campfire: { kind: 'build', r: 20, hp: 120, fire: true, fear: 150, warm: 210, light: 300, fuel: 200, maxFuel: 480 },
  wall: { kind: 'build', r: 26, hp: 220, snap: true },
  gate: { kind: 'build', r: 26, hp: 220, snap: true, gate: true },
  spikes: { kind: 'build', r: 24, hp: 140, snap: true, spike: 7 },
  tent: { kind: 'build', r: 34, hp: 160 },
  bonfire: { kind: 'fixed', r: 30, fire: true, fear: 250, warm: 310, light: 430 },
};
export const OBJ_IDS = Object.keys(OBJECTS);
export const OBJ_INDEX = Object.fromEntries(OBJ_IDS.map((id, i) => [id, i]));

/** Does this object stop a walking player? (Players walk through gates.) */
export const blocksPlayer = (o) => !OBJECTS[o.type].gate;
/** Does this object stop an animal? */
export const blocksMob = () => true;

// ------------------------------------------------------------------ animals
// ai: flee | neutral | hostile | territorial
// drops: [item, min, max]
export const MOBS = {
  rabbit: { name: 'Rabbit', ai: 'flee', r: 11, hp: 12, speed: 55, run: 182, sense: 150, drops: [['meat_raw', 1, 1]] },
  deer: { name: 'Deer', ai: 'flee', r: 17, hp: 36, speed: 50, run: 232, sense: 240, drops: [['meat_raw', 2, 2], ['hide', 1, 2]] },
  boar: { name: 'Boar', ai: 'neutral', r: 19, hp: 60, speed: 45, run: 192, sense: 0, dmg: 10, atkCd: 1.1, drops: [['meat_raw', 2, 3], ['hide', 1, 1]] },
  wolf: { name: 'Wolf', ai: 'hostile', r: 16, hp: 45, speed: 60, run: 214, sense: 330, leash: 700, dmg: 9, atkCd: 1.0, fearsFire: true, drops: [['meat_raw', 1, 1], ['hide', 1, 1]] },
  dire: { name: 'Dire Wolf', ai: 'hostile', r: 19, hp: 110, speed: 65, run: 222, sense: 420, leash: 900, dmg: 16, atkCd: 1.1, drops: [['meat_raw', 2, 2], ['hide', 2, 2]] },
  bear: { name: 'Bear', ai: 'territorial', r: 27, hp: 260, speed: 45, run: 186, sense: 250, leash: 560, dmg: 24, atkCd: 1.3, drops: [['meat_raw', 4, 5], ['hide', 3, 4]] },
};
export const MOB_IDS = Object.keys(MOBS);
export const MOB_INDEX = Object.fromEntries(MOB_IDS.map((id, i) => [id, i]));

// ------------------------------------------------------------------ misc
export const SKIN_COUNT = 4;
export const NAME_MAX = 14;
export const CHAT_MAX = 120;

// entity flag bits used in snapshots
export const PF_MOVING = 1;
export const PF_ARMOR = 2;
export const PF_SHIELD = 4;
export const MF_LEFT = 1;
export const MF_MOVING = 2;
export const MF_ANGRY = 4;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
