// Authoritative game simulation: world, players, animals, crafting, building,
// day/night cycle. It only talks to "connections" that have send() and
// sendVolatile(), and uses nothing but plain JavaScript, so it runs in two places:
//  - in Node, behind the web server (server/index.js): the multiplayer game
//  - in the browser itself (public/js/local.js): the solo game, no server needed
import {
  PROTOCOL, TILE, MAP_W, MAP_H, VIEW_W, VIEW_H, DAY_LENGTH, START_TOD,
  PLAYER_R, PLAYER_SPEED, PLAYER_MAX_HP, INV_SIZE, INTERACT_RANGE, PICKUP_RANGE,
  T_WATER, T_SAND, T_GRASS, T_DIRT,
  nightAmount, phaseOf, HAND, ITEMS, ITEM_INDEX, stackSize, RECIPES, ARMOR_FACTOR,
  FIRE_COOK_RANGE, FUEL_PER_WOOD, OBJECTS, OBJ_INDEX, blocksPlayer, blocksMob,
  MOBS, MOB_INDEX, SKIN_COUNT, NAME_MAX, CHAT_MAX, PF_MOVING, PF_ARMOR, PF_SHIELD,
  MF_LEFT, MF_MOVING, MF_ANGRY, clamp,
} from '../shared/defs.js';
import { World, angleDiff, placementSpot, placementError } from '../shared/physics.js';
import { generateWorld } from './worldgen.js';

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

// --- balance -----------------------------------------------------------------
const HUNGER_RATE = 0.23; // per second (a full belly lasts about one day)
const COLD_RATE = 0.85; // warmth lost per second at night, away from any fire
const WARM_RATE_FIRE = 7;
const WARM_RATE_DAY = 2.5;
const STARVE_DMG = 1.2; // hp per second
const FREEZE_DMG = 1.5;
const REGEN = 0.6;
const REGEN_FIRE = 1.6;
const SHIELD_MS = 8000;
const DROP_TTL = 180;
const DEATH_DROP_TTL = 300;
const ARROW_SPEED = 640;
const ARROW_RANGE = 560;
const MAX_STRUCTURES_PER_PLAYER = 150;
const SESSION_KEEP_MS = 10 * 60 * 1000;
const MAX_PLAYERS = 40;
const SAVE_VERSION = 1; // format written by exportState()

// how many animals live on the island during the day
const POPULATION = { rabbit: 26, deer: 16, boar: 12, wolf: 6, bear: 4 };

export class Game {
  /**
   * @param {object} [opts]
   * @param {number} [opts.seed]      which island to generate
   * @param {object} [opts.state]     continue a world saved with exportState() (its seed wins)
   * @param {boolean} [opts.cheats]   chat commands like "/give wood 50" (for testing only)
   * @param {() => number} [opts.clock]  milliseconds, for cooldowns and timestamps. The solo
   *                                  game passes a clock that stands still while it is paused.
   */
  constructor({ seed = 12345, log = console.log, dayLength = DAY_LENGTH, startTod = START_TOD, cheats = false, state = null, clock = null } = {}) {
    if (state) {
      if (!Game.canLoad(state)) throw new Error('this saved world cannot be read');
      seed = state.seed;
    }
    this.log = log;
    this.clock = clock || (() => performance.now());
    this.dayLength = dayLength;
    this.cheats = cheats;
    const gen = generateWorld(seed, MAP_W, MAP_H);
    this.seed = seed;
    this.world = new World(gen.w, gen.h, gen.tiles);
    this.tileString = Array.from(gen.tiles).join('');
    this.spawn = gen.spawn;
    this.nextObjId = 1;
    this.nextEntId = 1;
    this.fires = new Set();
    this.spikes = new Set();
    this.regrow = new Set(); // objects waiting to grow back
    this.rockGraves = []; // used-up rocks waiting to reappear
    this.time = state ? state.time : startTod * dayLength; // seconds since sunrise of day 1
    if (state) this.importObjects(state);
    else for (const o of gen.objects) this.addObject(o.type, o.x, o.y, { silent: true });

    this.players = new Map();
    this.mobs = new Map();
    this.drops = new Map();
    this.arrows = new Map();
    this.sessions = new Map(); // token -> saved player state

    const total = this.time / dayLength;
    this.tod = total - Math.floor(total);
    this.day = Math.floor(total) + 1;
    this.phase = phaseOf(this.tod);
    this.acc = { spawn: 0, lb: 0, fire: 0, spike: 0, night: 0, regrow: 0 };
    this.startedAt = this.clock();

    // where saved survivors stand: no dangerous animal may appear right next to them
    this.keepClear = [];
    if (state) this.importRest(state);
    for (const type of Object.keys(POPULATION)) {
      for (let i = 0; i < POPULATION[type]; i++) this.spawnMobRandom(type, true);
    }
    this.log(`world ready: seed ${seed}, ${this.world.objects.size} objects, ${this.mobs.size} animals${state ? `, continued on day ${this.day}` : ''}`);
  }

  // =========================================================================
  // saving and continuing a world
  // =========================================================================
  /** Is this something exportState() of this version of the game has written? */
  static canLoad(state) {
    return !!state && state.v === SAVE_VERSION && Number.isFinite(state.seed) && Number.isFinite(state.time) && state.time >= 0 && Array.isArray(state.objects);
  }

  /**
   * Everything needed to continue this world later, as plain JSON data. Names
   * are stored instead of index numbers so that a save stays readable when
   * items or objects are added to the game. Animals are not saved: the island
   * is simply repopulated.
   */
  exportState() {
    const r1 = (v) => Math.round(v * 10) / 10;
    const objects = [];
    for (const o of this.world.objects.values()) {
      const def = OBJECTS[o.type];
      objects.push([
        o.id, o.type, o.x, o.y, o.state,
        def.amount ? o.amount : 0,
        def.hp ? r1(o.hp) : 0,
        def.maxFuel ? r1(o.fuel) : 0,
        this.regrow.has(o) ? Math.max(1, Math.round(o.regrowAt - this.time)) : 0,
      ]);
    }
    const players = {};
    for (const [token, saved] of this.sessions) players[token] = saved;
    for (const p of this.players.values()) if (p.token) players[p.token] = this.sessionOf(p);
    return {
      v: SAVE_VERSION,
      seed: this.seed,
      time: this.time,
      nextObjId: this.nextObjId,
      objects,
      rockGraves: this.rockGraves.map((g) => [g.type, g.x, g.y, Math.max(1, Math.round(g.at - this.time))]),
      drops: [...this.drops.values()].map((d) => [d.item, d.n, Math.round(d.x), Math.round(d.y), Math.round(d.dieAt - this.time)]),
      players,
    };
  }

  /** First half of loading a save: the trees, rocks and buildings. */
  importObjects(state) {
    let maxId = 0;
    for (const [id, type, x, y, st, amount, hp, fuel, regrowIn] of state.objects) {
      const def = OBJECTS[type];
      // skip what this version of the game does not know, and what makes no sense
      if (!def || !Number.isInteger(id) || id < 1 || this.world.objects.has(id) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const o = { id, type, x, y, r: def.r, state: st ? 1 : 0 };
      if (def.amount) o.amount = clamp(amount, 0, def.amount);
      if (def.hp) o.hp = hp > 0 ? Math.min(hp, def.hp) : def.hp;
      if (def.fire) {
        o.fuel = def.maxFuel ? clamp(fuel, 0, def.maxFuel) : Infinity;
        this.fires.add(o);
      }
      if (def.spike) this.spikes.add(o);
      if (regrowIn > 0) {
        o.regrowAt = this.time + regrowIn;
        this.regrow.add(o);
      }
      this.world.addObject(o);
      maxId = Math.max(maxId, id);
    }
    this.nextObjId = Math.max(maxId + 1, Number.isInteger(state.nextObjId) ? state.nextObjId : 0);
    for (const [type, x, y, dueIn] of state.rockGraves || []) {
      if (OBJECTS[type] && Number.isFinite(x) && Number.isFinite(y) && dueIn > 0) this.rockGraves.push({ type, x, y, at: this.time + dueIn });
    }
  }

  /** Second half: things lying on the ground and the survivors. */
  importRest(state) {
    for (const [item, n, x, y, ttl] of (state.drops || []).slice(0, 500)) {
      if (!ITEMS[item] || !(n > 0) || !(ttl > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const id = this.nextEntId++;
      this.drops.set(id, { id, item, n, x, y, dieAt: this.time + ttl, lockId: 0, lockUntil: 0 });
    }
    const num = (v, lo, hi, fallback) => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
    for (const [token, saved] of Object.entries(state.players || {})) {
      if (!saved || !Array.isArray(saved.inv) || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) continue;
      const inv = new Array(INV_SIZE).fill(null);
      saved.inv.slice(0, INV_SIZE).forEach((slot, i) => {
        if (slot && ITEMS[slot.id] && slot.n > 0) inv[i] = { id: slot.id, n: Math.min(slot.n, stackSize(slot.id)) };
      });
      if (saved.alive) this.keepClear.push({ x: saved.x, y: saved.y });
      this.sessions.set(token, {
        savedAt: Date.now(), name: String(saved.name || ''), skin: saved.skin | 0, x: saved.x, y: saved.y,
        hp: num(saved.hp, 1, PLAYER_MAX_HP, PLAYER_MAX_HP), hunger: num(saved.hunger, 0, 100, 100), warmth: num(saved.warmth, 0, 100, 100),
        inv, sel: Number.isInteger(saved.sel) ? clamp(saved.sel, 0, INV_SIZE - 1) : 0, armor: !!saved.armor,
        tent: saved.tent | 0, kills: saved.kills | 0, lived: num(saved.lived, 0, Infinity, 0), alive: !!saved.alive,
      });
    }
  }

  /** What is remembered about a survivor who is not connected. */
  sessionOf(p) {
    return {
      savedAt: Date.now(), name: p.name, skin: p.skin, x: p.x, y: p.y, hp: p.hp, hunger: p.hunger,
      warmth: p.warmth, inv: p.inv.map((slot) => (slot ? { id: slot.id, n: slot.n } : null)), sel: p.sel,
      armor: p.armor, tent: p.tent, kills: p.kills, lived: this.time - p.bornAt, alive: p.alive,
    };
  }

  now() {
    return this.clock() - this.startedAt;
  }

  // =========================================================================
  // world objects
  // =========================================================================
  addObject(type, x, y, extra = {}) {
    const def = OBJECTS[type];
    const o = { id: this.nextObjId++, type, x, y, r: def.r, state: 0 };
    if (def.amount) o.amount = def.amount;
    if (def.hp) o.hp = def.hp;
    if (def.fire) {
      o.state = 1; // burning
      o.fuel = def.fuel || Infinity;
      this.fires.add(o);
    }
    if (def.spike) this.spikes.add(o);
    if (extra.owner) o.owner = extra.owner;
    this.world.addObject(o);
    if (!extra.silent) this.emitAll(['o+', ...this.objWire(o)]);
    return o;
  }

  removeObject(o) {
    if (!this.world.removeObject(o.id)) return;
    this.fires.delete(o);
    this.spikes.delete(o);
    this.regrow.delete(o);
    const owner = o.owner && this.players.get(o.owner);
    if (owner) owner.structures = Math.max(0, owner.structures - 1);
    this.emitAll(['o-', o.id]);
  }

  objWire(o) {
    const def = OBJECTS[o.type];
    const w = [o.id, OBJ_INDEX[o.type], o.x, o.y, o.state];
    if (def.hp) w.push(Math.ceil((o.hp / def.hp) * 100));
    if (def.maxFuel) w.push(Math.ceil((o.fuel / def.maxFuel) * 100));
    return w;
  }

  objChanged(o) {
    const def = OBJECTS[o.type];
    const ev = ['ou', o.id, o.state, def.hp ? Math.ceil((o.hp / def.hp) * 100) : 100];
    if (def.maxFuel) ev.push(Math.ceil((o.fuel / def.maxFuel) * 100));
    this.emitAll(ev);
  }

  damageObject(o, dmg, x, y) {
    const def = OBJECTS[o.type];
    if (def.kind !== 'build') return;
    o.hp -= dmg;
    this.emitNear(o.x, o.y, ['hit', 0, o.id, Math.round(x ?? o.x), Math.round(y ?? o.y), Math.round(dmg)]);
    if (o.hp <= 0) {
      this.emitNear(o.x, o.y, ['fx', 'break', o.x, o.y, OBJ_INDEX[o.type]]);
      this.removeObject(o);
    } else {
      this.objChanged(o);
    }
  }

  // =========================================================================
  // events
  // =========================================================================
  emitAll(ev) {
    for (const p of this.players.values()) p.evq.push(ev);
  }

  emitNear(x, y, ev, except = null) {
    const hw = VIEW_W / 2 + 200;
    const hh = VIEW_H / 2 + 240;
    for (const p of this.players.values()) {
      if (p === except) continue;
      if (Math.abs(p.x - x) < hw && Math.abs(p.y - y) < hh) p.evq.push(ev);
    }
  }

  toast(p, text) {
    p.evq.push(['toast', text]);
  }

  // =========================================================================
  // connections / players
  // =========================================================================
  /** Called by the transport for every decoded client message (an array). */
  handleMessage(conn, msg) {
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;
    const p = conn.player;
    const type = msg[0];
    if (type === 'p') {
      conn.send({ t: 'pong', c: msg[1], n: Math.round(this.now()) });
      return;
    }
    if (type === 'join') {
      if (!p) this.join(conn, msg[1], msg[2], msg[3]);
      return;
    }
    if (!p) return;
    switch (type) {
      case 'm': this.onMove(p, msg[1], msg[2], msg[3], msg[4]); break;
      case 'u': this.onUse(p, msg[1], msg[2], msg[3]); break;
      case 'sel': this.onSelect(p, msg[1]); break;
      case 'c': this.onCraft(p, msg[1]); break;
      case 'd': this.onDrop(p, msg[1], msg[2]); break;
      case 'sw': this.onSwap(p, msg[1], msg[2]); break;
      case 'e': this.onInteract(p); break;
      case 'chat': this.onChat(p, msg[1]); break;
      case 'r': this.onRespawn(p); break;
      default: break;
    }
  }

  handleClose(conn) {
    const p = conn.player;
    if (!p) return;
    conn.player = null;
    this.players.delete(p.id);
    if (p.token) this.sessions.set(p.token, this.sessionOf(p));
    this.emitAll(['pl', p.id]);
    this.emitAll(['sys', `${p.name} left the forest.`]);
    this.log(`- ${p.name} left (${this.players.size} online)`);
  }

  join(conn, rawName, rawSkin, rawToken) {
    if (this.players.size >= MAX_PLAYERS) {
      conn.send({ t: 'full' });
      return;
    }
    const token = typeof rawToken === 'string' && /^[\w-]{8,40}$/.test(rawToken) ? rawToken : null;
    // a recent session of the same survivor (page reload, reconnect, a saved solo game)?
    for (const [tok, s] of this.sessions) if (Date.now() - s.savedAt > SESSION_KEEP_MS) this.sessions.delete(tok);
    const saved = token && this.sessions.get(token);

    let name = typeof rawName === 'string' ? rawName : '';
    // eslint-disable-next-line no-control-regex
    const clean = (text) => text.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    name = clean(name) || (saved && clean(saved.name)) || `Survivor${randInt(10, 99)}`;
    const skin = Number.isInteger(rawSkin) ? clamp(rawSkin, 0, SKIN_COUNT - 1) : 0;

    const p = {
      id: this.nextEntId++, conn, name, skin, token,
      x: 0, y: 0, aim: 0, epoch: 1,
      hp: PLAYER_MAX_HP, hunger: 100, warmth: 100, alive: true, deadAt: 0,
      inv: new Array(INV_SIZE).fill(null), sel: 0, armor: false, tent: 0,
      lastUse: 0, kills: 0, bornAt: this.time, shieldUntil: this.now() + SHIELD_MS,
      budget: 120, lastMoveAt: this.now(), movedAt: 0, lastCorrection: 0,
      evq: [], invDirty: false, lastChat: 0, warm: false, canCook: false, structures: 0,
    };

    let resumed = false;
    if (saved) {
      this.sessions.delete(token);
      if (this.world.objects.has(saved.tent)) p.tent = saved.tent;
      if (saved.alive) {
        Object.assign(p, {
          x: saved.x, y: saved.y, hp: saved.hp, hunger: saved.hunger, warmth: saved.warmth,
          inv: saved.inv, sel: saved.sel, armor: saved.armor, kills: saved.kills,
          bornAt: this.time - saved.lived,
        });
        this.world.collide(p, PLAYER_R, blocksPlayer);
        resumed = true;
      }
    }
    if (!resumed) this.placeAtSpawn(p);

    conn.player = p;
    this.players.set(p.id, p);

    const objs = [];
    for (const o of this.world.objects.values()) objs.push(this.objWire(o));
    const players = [];
    for (const q of this.players.values()) players.push([q.id, q.name, q.skin]);
    conn.send({
      t: 'init', v: PROTOCOL, id: p.id, w: this.world.w, h: this.world.h, tiles: this.tileString,
      objs, players, spawn: [this.spawn.x, this.spawn.y], n: Math.round(this.now()),
      tod: this.tod, day: this.day, dayLength: this.dayLength,
      you: { x: p.x, y: p.y, epoch: p.epoch, hp: p.hp, hunger: p.hunger, warmth: p.warmth, sel: p.sel, inv: this.invWire(p), alive: p.alive, resumed },
    });
    for (const q of this.players.values()) if (q !== p) q.evq.push(['pj', p.id, p.name, p.skin]);
    this.emitAll(['sys', resumed ? `${p.name} is back.` : `${p.name} entered the forest.`]);
    this.log(`+ ${p.name} joined (${this.players.size} online)`);
  }

  placeAtSpawn(p) {
    let sx = this.spawn.x;
    let sy = this.spawn.y;
    let radius = [70, 130];
    const tent = p.tent && this.world.objects.get(p.tent);
    if (tent) {
      sx = tent.x;
      sy = tent.y;
      radius = [tent.r + PLAYER_R + 6, tent.r + 60];
    } else {
      p.tent = 0;
    }
    for (let i = 0; i < 30; i++) {
      const a = rand(0, Math.PI * 2);
      const d = rand(radius[0], radius[1]);
      const c = { x: sx + Math.cos(a) * d, y: sy + Math.sin(a) * d };
      if (this.world.isWater(c.x, c.y)) continue;
      this.world.collide(c, PLAYER_R, blocksPlayer);
      p.x = c.x;
      p.y = c.y;
      return;
    }
    p.x = sx;
    p.y = sy + radius[0];
    this.world.collide(p, PLAYER_R, blocksPlayer);
  }

  invWire(p) {
    return p.inv.map((s) => (s ? [ITEM_INDEX[s.id], s.n] : 0));
  }

  // ---------------------------------------------------------------- movement
  onMove(p, x, y, aim, epoch) {
    if (!p.alive || epoch !== p.epoch) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(aim)) return;
    const now = this.now();
    const dt = Math.min(1, (now - p.lastMoveAt) / 1000);
    p.lastMoveAt = now;
    // movement budget: you can never travel faster than your legs allow
    p.budget = Math.min(300, p.budget + dt * PLAYER_SPEED * 1.2);
    let dx = x - p.x;
    let dy = y - p.y;
    let d = Math.hypot(dx, dy);
    let corrected = false;
    if (d > p.budget + 2) {
      const k = p.budget / d;
      dx *= k;
      dy *= k;
      d = p.budget;
      corrected = true;
    }
    p.budget -= d;
    const np = { x: p.x + dx, y: p.y + dy };
    const bx = np.x;
    const by = np.y;
    this.world.collide(np, PLAYER_R, blocksPlayer);
    if (Math.abs(np.x - bx) + Math.abs(np.y - by) > 8) corrected = true;
    if (d > 0.5) p.movedAt = now;
    p.x = np.x;
    p.y = np.y;
    p.aim = aim;
    if (corrected && now - p.lastCorrection > 250) {
      p.lastCorrection = now;
      this.teleport(p, p.x, p.y);
    }
  }

  teleport(p, x, y) {
    p.x = x;
    p.y = y;
    p.epoch++;
    p.budget = 120;
    p.evq.push(['tp', Math.round(x * 10) / 10, Math.round(y * 10) / 10, p.epoch]);
  }

  // ---------------------------------------------------------------- inventory
  countItem(p, id) {
    let n = 0;
    for (const s of p.inv) if (s && s.id === id) n += s.n;
    return n;
  }

  removeItem(p, id, n) {
    // take from the back so that the hotbar order stays stable
    for (let i = p.inv.length - 1; i >= 0 && n > 0; i--) {
      const s = p.inv[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(s.n, n);
      s.n -= take;
      n -= take;
      if (s.n <= 0) p.inv[i] = null;
    }
    p.invDirty = true;
    return n === 0;
  }

  /** @returns how many did NOT fit */
  addItem(p, id, n) {
    const max = stackSize(id);
    for (const s of p.inv) {
      if (n <= 0) break;
      if (s && s.id === id && s.n < max) {
        const add = Math.min(max - s.n, n);
        s.n += add;
        n -= add;
      }
    }
    for (let i = 0; i < p.inv.length && n > 0; i++) {
      if (!p.inv[i]) {
        const add = Math.min(max, n);
        p.inv[i] = { id, n: add };
        n -= add;
      }
    }
    p.invDirty = true;
    return n;
  }

  /** Adds items; whatever does not fit falls on the ground. */
  give(p, id, n, showGain = true) {
    const left = this.addItem(p, id, n);
    if (showGain && n - left > 0) p.evq.push(['gain', ITEM_INDEX[id], n - left]);
    if (left > 0) {
      this.spawnDrop(id, left, p.x + rand(-10, 10), p.y + rand(-10, 10), DROP_TTL, p.id);
      const now = this.now();
      if (now - (p.lastFullToast || 0) > 3000) {
        p.lastFullToast = now;
        this.toast(p, 'Inventory full!');
      }
    }
  }

  onSelect(p, i) {
    if (!Number.isInteger(i) || i < 0 || i >= INV_SIZE) return;
    p.sel = i;
  }

  onSwap(p, a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return;
    if (a < 0 || b < 0 || a >= INV_SIZE || b >= INV_SIZE) return;
    const sa = p.inv[a];
    const sb = p.inv[b];
    if (sa && sb && sa.id === sb.id && stackSize(sa.id) > 1) {
      const move = Math.min(sa.n, stackSize(sa.id) - sb.n);
      sb.n += move;
      sa.n -= move;
      if (sa.n <= 0) p.inv[a] = null;
    } else {
      p.inv[a] = sb;
      p.inv[b] = sa;
    }
    p.invDirty = true;
  }

  onDrop(p, slot, all) {
    if (!p.alive || !Number.isInteger(slot) || slot < 0 || slot >= INV_SIZE) return;
    const s = p.inv[slot];
    if (!s) return;
    const n = all ? s.n : 1;
    s.n -= n;
    if (s.n <= 0) p.inv[slot] = null;
    p.invDirty = true;
    const c = { x: p.x + Math.cos(p.aim) * 38, y: p.y + Math.sin(p.aim) * 38 };
    if (this.world.isWater(c.x, c.y)) {
      c.x = p.x;
      c.y = p.y;
    }
    this.spawnDrop(s.id, n, c.x, c.y, DROP_TTL, p.id);
  }

  onCraft(p, idx) {
    if (!p.alive || !Number.isInteger(idx)) return;
    const r = RECIPES[idx];
    if (!r) return;
    for (const [id, need] of Object.entries(r.cost)) {
      if (this.countItem(p, id) < need) {
        this.toast(p, `Not enough ${ITEMS[id].name.toLowerCase()}.`);
        return;
      }
    }
    if (r.near === 'fire' && !p.canCook) {
      this.toast(p, 'Stand next to a burning fire to cook.');
      return;
    }
    if (r.equip === 'armor') {
      if (p.armor) {
        this.toast(p, 'You already wear hide armor.');
        return;
      }
      for (const [id, need] of Object.entries(r.cost)) this.removeItem(p, id, need);
      p.armor = true;
    } else {
      for (const [id, need] of Object.entries(r.cost)) this.removeItem(p, id, need);
      this.give(p, r.out, r.n, false);
    }
    p.evq.push(['crafted', idx]);
  }

  // ---------------------------------------------------------------- using items
  onUse(p, aim, tx, ty) {
    if (!p.alive) return;
    if (!Number.isFinite(aim)) return;
    const now = this.now();
    const slot = p.inv[p.sel];
    const item = slot ? ITEMS[slot.id] : null;
    p.aim = aim;

    if (item && item.kind === 'food') {
      if (now - p.lastUse < 330) return;
      p.lastUse = now;
      slot.n--;
      if (slot.n <= 0) p.inv[p.sel] = null;
      p.invDirty = true;
      p.hunger = Math.min(100, p.hunger + item.food);
      if (item.heal) p.hp = clamp(p.hp + item.heal, 1, PLAYER_MAX_HP);
      p.evq.push(['ate', ITEM_INDEX[slot.id]]);
      this.emitNear(p.x, p.y, ['fx', 'eat', Math.round(p.x), Math.round(p.y)], p);
      return;
    }

    if (item && item.kind === 'build') {
      if (now - p.lastUse < 180) return;
      p.lastUse = now;
      this.tryPlace(p, slot, tx, ty);
      return;
    }

    if (item && item.kind === 'bow') {
      if (now - p.lastUse < item.cd * 1000 - 70) return;
      p.lastUse = now;
      if (this.countItem(p, 'arrow') < 1) {
        this.toast(p, 'No arrows! Craft some.');
        return;
      }
      this.removeItem(p, 'arrow', 1);
      const id = this.nextEntId++;
      this.arrows.set(id, {
        id, owner: p.id, ang: aim, dist: 0, dmg: ITEMS.arrow.dmg,
        x: p.x + Math.cos(aim) * 22, y: p.y + Math.sin(aim) * 22,
        vx: Math.cos(aim) * ARROW_SPEED, vy: Math.sin(aim) * ARROW_SPEED,
      });
      this.emitNear(p.x, p.y, ['sw', p.id, Math.round(aim * 100), 1], p);
      return;
    }

    // melee swing with a tool or bare hands
    const stats = item && item.kind === 'tool' ? item : HAND;
    if (now - p.lastUse < stats.cd * 1000 - 70) return;
    p.lastUse = now;
    this.emitNear(p.x, p.y, ['sw', p.id, Math.round(aim * 100), 0], p);
    this.melee(p, aim, stats);
  }

  melee(p, aim, stats) {
    const reach = stats.reach;
    let hitMob = false;
    for (const m of this.mobs.values()) {
      const def = MOBS[m.type];
      const dx = m.x - p.x;
      const dy = m.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d - def.r > reach) continue;
      // forgiving cone: everything roughly in front, or standing right on top of you
      const widen = Math.asin(Math.min(1, def.r / Math.max(d, 1)));
      if (d > def.r + 18 && Math.abs(angleDiff(Math.atan2(dy, dx), aim)) > 0.95 + widen) continue;
      hitMob = true;
      this.damageMob(m, stats.dmg, p, aim);
    }
    if (hitMob) return;

    // nothing alive in the way: hit the best world object in front
    let best = null;
    let bestScore = Infinity;
    this.world.grid.query(p.x, p.y, reach, (o) => {
      const dx = o.x - p.x;
      const dy = o.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d - o.r > reach) return;
      const off = Math.abs(angleDiff(Math.atan2(dy, dx), aim));
      const widen = Math.asin(Math.min(1, o.r / Math.max(d, 1)));
      if (off > 1.05 + widen) return;
      const def = OBJECTS[o.type];
      if (def.kind === 'fixed') return;
      if (def.kind === 'tree' && o.state === 1) return; // stump
      // prefer what the player aims at; resources before buildings
      const score = off * 60 + (d - o.r) + (def.kind === 'build' ? 45 : 0) + (def.kind === 'bush' && o.state === 1 ? 60 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    });
    if (best) this.hitObject(p, best, stats);
  }

  hitObject(p, o, stats) {
    const def = OBJECTS[o.type];
    const hx = Math.round(o.x + (p.x - o.x) * 0.3);
    const hy = Math.round(o.y + (p.y - o.y) * 0.3);
    if (def.kind === 'build') {
      this.damageObject(o, stats.dmg, hx, hy);
      return;
    }
    if (def.kind === 'bush' && o.state === 1) {
      this.emitNear(o.x, o.y, ['hit', 0, o.id, hx, hy, 0]);
      const now = this.now();
      if (now - (p.lastBushToast || 0) > 4000) {
        p.lastBushToast = now;
        this.toast(p, 'No ripe berries here yet.');
      }
      return;
    }
    const power = def.kind === 'tree' ? stats.chop : def.kind === 'rock' ? stats.mine : 1;
    const n = Math.min(power, o.amount);
    o.amount -= n;
    this.emitNear(o.x, o.y, ['hit', 0, o.id, hx, hy, 0]);
    this.give(p, def.gives, n);
    if (o.amount > 0) return;
    // used up
    const delay = rand(def.regrow[0], def.regrow[1]);
    if (def.kind === 'rock') {
      this.emitNear(o.x, o.y, ['fx', 'break', o.x, o.y, OBJ_INDEX[o.type]]);
      this.removeObject(o);
      this.rockGraves.push({ type: o.type, x: o.x, y: o.y, at: this.time + delay });
    } else {
      o.state = 1; // stump / empty bush
      o.regrowAt = this.time + delay;
      this.regrow.add(o);
      if (def.kind === 'tree') this.emitNear(o.x, o.y, ['fx', 'fall', o.x, o.y, OBJ_INDEX[o.type]]);
      this.objChanged(o);
    }
  }

  tryPlace(p, slot, tx, ty) {
    const item = ITEMS[slot.id];
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    const res = this.checkPlacement(p, item.obj, tx, ty);
    if (res.error) {
      this.toast(p, res.error);
      return;
    }
    if (p.structures >= MAX_STRUCTURES_PER_PLAYER) {
      this.toast(p, 'You have built too many things.');
      return;
    }
    slot.n--;
    if (slot.n <= 0) p.inv[p.sel] = null;
    p.invDirty = true;
    p.structures++;
    const o = this.addObject(item.obj, res.x, res.y, { owner: p.id });
    this.emitNear(o.x, o.y, ['fx', 'build', o.x, o.y, OBJ_INDEX[o.type]]);
    p.evq.push(['placed', OBJ_INDEX[o.type]]);
    if (item.obj === 'tent') {
      p.tent = o.id;
      this.toast(p, 'Tent placed - you will respawn here.');
    }
  }

  /** Placement rules: shared terrain/object checks plus "nobody stands there". */
  checkPlacement(p, type, tx, ty) {
    const def = OBJECTS[type];
    const { x, y } = placementSpot(p.x, p.y, tx, ty, type);
    const error = placementError(this.world, this.spawn, type, x, y);
    if (error) return { error };
    if (!def.gate) {
      for (const q of this.players.values()) {
        if (q.alive && dist2(x, y, q.x, q.y) < (def.r + PLAYER_R + 1) ** 2) return { error: 'Someone is standing there.' };
      }
    }
    for (const m of this.mobs.values()) {
      if (dist2(x, y, m.x, m.y) < (def.r + MOBS[m.type].r) ** 2) return { error: 'An animal is in the way.' };
    }
    return { x, y };
  }

  onInteract(p) {
    if (!p.alive) return;
    let best = null;
    let bestD = Infinity;
    this.world.grid.query(p.x, p.y, INTERACT_RANGE, (o) => {
      if (o.type !== 'campfire' && o.type !== 'tent') return;
      const d = Math.hypot(o.x - p.x, o.y - p.y) - o.r;
      if (d < INTERACT_RANGE && d < bestD) {
        bestD = d;
        best = o;
      }
    });
    if (!best) return;
    if (best.type === 'tent') {
      p.tent = best.id;
      this.toast(p, 'Spawn point set to this tent.');
      return;
    }
    const def = OBJECTS.campfire;
    if (best.fuel >= def.maxFuel - 5) {
      this.toast(p, 'The fire is burning well.');
      return;
    }
    if (this.countItem(p, 'wood') < 1) {
      this.toast(p, 'You need wood to feed the fire.');
      return;
    }
    this.removeItem(p, 'wood', 1);
    best.fuel = Math.min(def.maxFuel, Math.max(0, best.fuel) + FUEL_PER_WOOD);
    best.state = 1;
    this.objChanged(best);
    this.emitNear(best.x, best.y, ['fx', 'fuel', best.x, best.y]);
  }

  onChat(p, text) {
    if (typeof text !== 'string') return;
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return;
    if (text[0] === '/' && this.cheats) {
      this.cheat(p, text.slice(1).split(' '));
      return;
    }
    const now = this.now();
    if (now - p.lastChat < 400) return;
    p.lastChat = now;
    this.emitAll(['chat', p.id, p.name, text]);
  }

  /** Test helpers, only available when the server runs with CHEATS=1. */
  cheat(p, [cmd, a, b]) {
    if (cmd === 'give' && ITEMS[a]) {
      this.give(p, a, Math.max(1, Number(b) || 1));
    } else if (cmd === 'tp' && Number.isFinite(Number(a)) && Number.isFinite(Number(b))) {
      const c = { x: Number(a), y: Number(b) };
      this.world.collide(c, PLAYER_R, blocksPlayer);
      this.teleport(p, c.x, c.y);
    } else if (cmd === 'time' && Number.isFinite(Number(a))) {
      this.time = (Math.floor(this.time / this.dayLength) + clamp(Number(a), 0, 0.999)) * this.dayLength;
    } else if (cmd === 'mob' && MOBS[a]) {
      const c = { x: p.x + (Number(b) || 160), y: p.y };
      this.world.collide(c, MOBS[a].r, blocksMob);
      this.spawnMob(a, c.x, c.y);
    } else if (cmd === 'hurt') {
      this.hurtPlayer(p, Number(a) || 10, 'wolf', p.x + 30, p.y);
    } else if (cmd === 'set' && ['hp', 'hunger', 'warmth'].includes(a)) {
      p[a] = clamp(Number(b) || 0, 0, 100);
    } else if (cmd === 'noshield') {
      p.shieldUntil = 0;
    } else {
      this.toast(p, 'Unknown command.');
    }
  }

  // ---------------------------------------------------------------- life & death
  hurtPlayer(p, dmg, cause, fromX, fromY) {
    if (!p.alive) return;
    if (this.now() < p.shieldUntil) return;
    if (p.armor) dmg *= ARMOR_FACTOR;
    p.hp -= dmg;
    this.emitNear(p.x, p.y, ['hit', 2, p.id, Math.round(p.x), Math.round(p.y), Math.round(dmg), Math.round(fromX ?? p.x), Math.round(fromY ?? p.y)]);
    if (p.hp <= 0) this.killPlayer(p, cause);
  }

  killPlayer(p, cause) {
    if (!p.alive) return;
    p.alive = false;
    p.hp = 0;
    p.deadAt = this.now();
    const days = (this.time - p.bornAt) / this.dayLength;
    for (const s of p.inv) {
      if (s) this.spawnDrop(s.id, s.n, p.x + rand(-26, 26), p.y + rand(-26, 26), DEATH_DROP_TTL, 0);
    }
    p.inv = new Array(INV_SIZE).fill(null);
    p.invDirty = true;
    p.armor = false;
    p.evq.push(['dead', cause, Math.round(days * 10) / 10, p.kills]);
    this.emitNear(p.x, p.y, ['fx', 'pdie', Math.round(p.x), Math.round(p.y)]);
    const how = {
      hunger: 'starved to death', cold: 'froze to death', wolf: 'was eaten by a wolf', dire: 'was torn apart by a dire wolf',
      bear: 'was mauled by a bear', boar: 'was trampled by a boar',
    }[cause] || 'died';
    this.emitAll(['sys', `${p.name} ${how}.`, 1]);
  }

  onRespawn(p) {
    if (p.alive || this.now() - p.deadAt < 1200) return;
    p.alive = true;
    p.hp = PLAYER_MAX_HP;
    p.hunger = 85;
    p.warmth = 100;
    p.kills = 0;
    p.bornAt = this.time;
    p.shieldUntil = this.now() + SHIELD_MS;
    this.placeAtSpawn(p);
    p.epoch++;
    p.budget = 120;
    p.evq.push(['spawn', Math.round(p.x), Math.round(p.y), p.epoch]);
  }

  tickPlayers(dt) {
    const night = nightAmount(this.tod) > 0.5;
    const now = this.now();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      // fires nearby?
      p.warm = false;
      p.canCook = false;
      for (const f of this.fires) {
        if (!f.state) continue;
        const def = OBJECTS[f.type];
        const d2 = dist2(p.x, p.y, f.x, f.y);
        if (d2 < def.warm * def.warm) p.warm = true;
        if (d2 < FIRE_COOK_RANGE * FIRE_COOK_RANGE) p.canCook = true;
      }
      p.hunger = Math.max(0, p.hunger - HUNGER_RATE * dt);
      if (p.warm) {
        p.warmth += WARM_RATE_FIRE * dt;
      } else if (night) {
        const held = p.inv[p.sel];
        let rate = COLD_RATE;
        if (p.armor) rate *= 0.5;
        if (held && held.id === 'torch') rate *= 0.5;
        p.warmth -= rate * dt;
      } else {
        p.warmth += WARM_RATE_DAY * dt;
      }
      p.warmth = clamp(p.warmth, 0, 100);

      let dmg = 0;
      let cause = '';
      if (p.hunger <= 0) {
        dmg += STARVE_DMG * dt;
        cause = 'hunger';
      }
      if (p.warmth <= 0) {
        dmg += FREEZE_DMG * dt;
        cause = 'cold';
      }
      if (dmg > 0) {
        if (now >= p.shieldUntil) {
          p.hp -= dmg;
          if (p.hp <= 0) this.killPlayer(p, cause);
        }
      } else if (p.hunger > 35 && p.warmth > 25 && p.hp < PLAYER_MAX_HP) {
        p.hp = Math.min(PLAYER_MAX_HP, p.hp + (p.warm ? REGEN_FIRE : REGEN) * dt);
      }
    }
  }

  // =========================================================================
  // drops & arrows
  // =========================================================================
  spawnDrop(item, n, x, y, ttl, lockId) {
    if (this.drops.size > 500) {
      const oldest = this.drops.keys().next().value;
      this.drops.delete(oldest);
    }
    const c = { x, y };
    this.world.collide(c, 6, blocksMob);
    const id = this.nextEntId++;
    this.drops.set(id, { id, item, n, x: c.x, y: c.y, dieAt: this.time + ttl, lockId, lockUntil: this.time + 1.6 });
  }

  tickDrops() {
    for (const d of this.drops.values()) {
      if (this.time > d.dieAt) {
        this.drops.delete(d.id);
        continue;
      }
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (d.lockId === p.id && this.time < d.lockUntil) continue;
        if (dist2(p.x, p.y, d.x, d.y) > PICKUP_RANGE * PICKUP_RANGE) continue;
        const left = this.addItem(p, d.item, d.n);
        const got = d.n - left;
        if (got > 0) {
          p.evq.push(['gain', ITEM_INDEX[d.item], got, 1]);
          d.n = left;
          if (left <= 0) {
            this.drops.delete(d.id);
            break;
          }
        }
      }
    }
  }

  tickArrows(dt) {
    for (const a of this.arrows.values()) {
      const steps = 3;
      let done = false;
      for (let s = 0; s < steps && !done; s++) {
        a.x += (a.vx * dt) / steps;
        a.y += (a.vy * dt) / steps;
        a.dist += (ARROW_SPEED * dt) / steps;
        for (const m of this.mobs.values()) {
          const r = MOBS[m.type].r + 7;
          if (dist2(a.x, a.y, m.x, m.y) < r * r) {
            this.damageMob(m, a.dmg, this.players.get(a.owner) || null, a.ang);
            done = true;
            break;
          }
        }
        if (done) break;
        let wall = false;
        this.world.grid.query(a.x, a.y, 2, (o) => {
          const r = o.r * 0.8;
          if (dist2(a.x, a.y, o.x, o.y) < r * r) wall = true;
        });
        if (wall || a.dist >= ARROW_RANGE || a.x < 0 || a.y < 0 || a.x > this.world.pxW || a.y > this.world.pxH) {
          // arrows that miss can often be picked up again
          if (Math.random() < 0.6 && !this.world.isWater(a.x, a.y)) {
            this.spawnDrop('arrow', 1, a.x - Math.cos(a.ang) * 14, a.y - Math.sin(a.ang) * 14, 90, 0);
          }
          done = true;
        }
      }
      if (done) this.arrows.delete(a.id);
    }
  }

  // =========================================================================
  // animals
  // =========================================================================
  spawnMob(type, x, y, opts = {}) {
    const def = MOBS[type];
    const m = {
      id: this.nextEntId++, type, x, y, hp: def.hp, dir: Math.random() < 0.5 ? -1 : 1,
      state: 'idle', stateT: rand(0.5, 3), thinkT: rand(0, 0.3), target: 0, threat: 0,
      tx: x, ty: y, hx: x, hy: y, kx: 0, ky: 0, atkCd: 0, hurtT: 0, fearless: 0, aggroT: 0,
      stuckT: 0, sx: x, sy: y, detourT: 0, detx: 0, dety: 0, side: Math.random() < 0.5 ? -1 : 1, sideT: rand(2, 5),
      moving: false, night: !!opts.night, scared: false,
    };
    if (opts.target) {
      m.target = opts.target;
      m.state = 'chase';
    }
    this.mobs.set(m.id, m);
    return m;
  }

  /** Finds a free spot for an animal. @returns {{x:number,y:number}|null} */
  findSpot(type, test) {
    const def = MOBS[type];
    const w = this.world;
    for (let i = 0; i < 40; i++) {
      const x = rand(4, w.w - 4) * TILE;
      const y = rand(4, w.h - 4) * TILE;
      const t = w.tileAt(x, y);
      if (t === T_WATER || t === T_SAND) continue;
      if (!test(x, y, t)) continue;
      const c = { x, y };
      if (w.collide(c, def.r + 4, blocksMob) && w.isWater(c.x, c.y)) continue;
      return c;
    }
    return null;
  }

  spawnMobRandom(type, initial = false) {
    const sp = this.spawn;
    const minSpawnDist = { rabbit: 380, deer: 520, boar: 800, wolf: 1500, bear: 1900 }[type] || 500;
    const spot = this.findSpot(type, (x, y, t) => {
      if (dist2(x, y, sp.x, sp.y) < minSpawnDist * minSpawnDist) return false;
      if (type === 'rabbit' && t === T_DIRT) return false;
      if ((type === 'wolf' || type === 'boar') && t === T_GRASS && Math.random() < 0.7) return false;
      if (!initial) {
        for (const p of this.players.values()) if (dist2(x, y, p.x, p.y) < 950 * 950) return false;
      } else if (MOBS[type].dmg) {
        for (const c of this.keepClear) if (dist2(x, y, c.x, c.y) < 950 * 950) return false;
      }
      return true;
    });
    if (!spot) return null;
    return this.spawnMob(type, spot.x, spot.y);
  }

  nearestPlayer(x, y, range) {
    let best = null;
    let bestD = range * range;
    const now = this.now();
    for (const p of this.players.values()) {
      if (!p.alive || now < p.shieldUntil) continue;
      const d = dist2(x, y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  damageMob(m, dmg, by, ang) {
    const def = MOBS[m.type];
    m.hp -= dmg;
    m.hurtT = 0.25;
    const kb = m.type === 'bear' ? 60 : 230;
    m.kx += Math.cos(ang) * kb;
    m.ky += Math.sin(ang) * kb;
    this.emitNear(m.x, m.y, ['hit', 1, m.id, Math.round(m.x), Math.round(m.y), Math.round(dmg)]);
    if (m.hp <= 0) {
      this.mobs.delete(m.id);
      this.emitNear(m.x, m.y, ['fx', 'mdie', Math.round(m.x), Math.round(m.y), MOB_INDEX[m.type]]);
      for (const [item, lo, hi] of def.drops) {
        const n = randInt(lo, hi);
        if (n > 0) this.spawnDrop(item, n, m.x + rand(-14, 14), m.y + rand(-10, 10), DROP_TTL, 0);
      }
      if (by) by.kills++;
      return;
    }
    if (!by) return;
    if (def.ai === 'flee') {
      m.state = 'flee';
      m.threat = by.id;
      m.stateT = 4;
    } else {
      m.state = 'chase';
      m.target = by.id;
      m.aggroT = 16;
      m.fearless = 7; // enraged animals ignore fire
      m.detourT = 0;
    }
  }

  pickWander(m, def) {
    const w = this.world;
    for (let i = 0; i < 5; i++) {
      const a = rand(0, Math.PI * 2);
      const d = rand(50, 210);
      let x = m.x + Math.cos(a) * d;
      let y = m.y + Math.sin(a) * d;
      if (def.ai === 'territorial' && dist2(x, y, m.hx, m.hy) > 280 * 280) {
        x = m.hx + Math.cos(a) * rand(20, 200);
        y = m.hy + Math.sin(a) * rand(20, 200);
      }
      if (w.isWater(x, y) || w.tileAt(x, y) === T_SAND) continue;
      // predators stay away from the camp while they are just strolling around
      if (def.dmg && dist2(x, y, this.spawn.x, this.spawn.y) < 700 * 700) continue;
      m.tx = x;
      m.ty = y;
      m.state = 'wander';
      m.stateT = 7;
      return;
    }
    m.stateT = 1;
  }

  mobThink(m, def) {
    const ai = def.ai;
    if (m.state === 'leave') {
      // night hunters vanish back into the woods once nobody is around
      if (!this.nearestPlayer(m.x, m.y, 820) || m.stateT <= 0) this.mobs.delete(m.id);
      return;
    }
    if (ai === 'flee') {
      if (m.state !== 'flee' || m.stateT < 0.7) {
        const p = this.nearestPlayer(m.x, m.y, def.sense);
        if (p) {
          m.state = 'flee';
          m.threat = p.id;
          m.stateT = 1.5;
        } else if (m.state === 'flee' && m.stateT <= 0) {
          m.state = 'idle';
          m.stateT = rand(0.5, 2);
        }
      }
    } else if (ai === 'neutral') {
      if (m.state === 'chase') {
        const t = this.players.get(m.target);
        if (!t || !t.alive || m.aggroT <= 0 || dist2(m.x, m.y, t.x, t.y) > 620 * 620) {
          m.state = 'idle';
          m.target = 0;
          m.stateT = 1;
        }
      }
    } else {
      // hostile + territorial
      if (ai === 'territorial' && m.state !== 'return' && dist2(m.x, m.y, m.hx, m.hy) > def.leash * def.leash) {
        m.state = 'return';
        m.target = 0;
      } else if (m.state === 'chase') {
        const t = this.players.get(m.target);
        const leash = def.leash * (m.night ? 2.2 : 1);
        if (!t || !t.alive || this.now() < t.shieldUntil || dist2(m.x, m.y, t.x, t.y) > leash * leash) {
          m.state = 'idle';
          m.target = 0;
          m.stateT = 0.4;
        } else {
          const p = this.nearestPlayer(m.x, m.y, def.sense);
          if (p && p !== t && dist2(m.x, m.y, p.x, p.y) < dist2(m.x, m.y, t.x, t.y) * 0.36) m.target = p.id;
        }
      } else if (m.state !== 'return') {
        const night = nightAmount(this.tod) > 0.5;
        let p = this.nearestPlayer(m.x, m.y, def.sense * (night ? 1.3 : 1));
        if (!p && m.night) p = this.nearestPlayer(m.x, m.y, 1700); // hunters smell you from far away
        if (p) {
          m.state = 'chase';
          m.target = p.id;
          m.stuckT = 0;
          m.sx = m.x;
          m.sy = m.y;
        }
      }
    }
    if (m.state === 'idle' && m.stateT <= 0) this.pickWander(m, def);
  }

  tickMob(m, dt) {
    const def = MOBS[m.type];
    m.atkCd -= dt;
    m.stateT -= dt;
    m.hurtT -= dt;
    m.thinkT -= dt;
    if (m.fearless > 0) m.fearless -= dt;
    if (m.aggroT > 0) m.aggroT -= dt;
    m.sideT -= dt;
    if (m.sideT <= 0) {
      m.side = -m.side;
      m.sideT = rand(2, 6);
    }
    if (m.thinkT <= 0) {
      m.thinkT = rand(0.15, 0.3);
      this.mobThink(m, def);
      if (!this.mobs.has(m.id)) return;
    }

    let mx = 0;
    let my = 0;
    let speed = 0;
    let wantsMove = false;
    if (m.state === 'wander') {
      const dx = m.tx - m.x;
      const dy = m.ty - m.y;
      const d = Math.hypot(dx, dy);
      if (d < 8 || m.stateT <= 0) {
        m.state = 'idle';
        m.stateT = rand(1, 4.5);
      } else {
        mx = dx / d;
        my = dy / d;
        speed = def.speed;
      }
    } else if (m.state === 'flee' || m.state === 'leave') {
      const t = this.players.get(m.threat) || this.nearestPlayer(m.x, m.y, 900);
      if (t) {
        const dx = m.x - t.x;
        const dy = m.y - t.y;
        const d = Math.hypot(dx, dy) || 1;
        // run away, drifting a little sideways so they do not move like robots
        mx = dx / d - (dy / d) * 0.25 * m.side;
        my = dy / d + (dx / d) * 0.25 * m.side;
        const l = Math.hypot(mx, my);
        mx /= l;
        my /= l;
        speed = def.run;
      } else if (m.state === 'flee') {
        m.state = 'idle';
        m.stateT = 1;
      }
    } else if (m.state === 'chase') {
      const t = this.players.get(m.target);
      if (t && t.alive) {
        const dx = t.x - m.x;
        const dy = t.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        const reach = def.r + PLAYER_R + 9;
        if (d > reach - 5) {
          mx = dx / d;
          my = dy / d;
          speed = def.run;
          wantsMove = true;
        }
        if (Math.abs(dx) > 4) m.dir = dx < 0 ? -1 : 1;
        if (d <= reach && m.atkCd <= 0) {
          m.atkCd = def.atkCd;
          this.emitNear(m.x, m.y, ['matk', m.id]);
          this.hurtPlayer(t, def.dmg, m.type, m.x, m.y);
        }
      }
    } else if (m.state === 'return') {
      const dx = m.hx - m.x;
      const dy = m.hy - m.y;
      const d = Math.hypot(dx, dy);
      m.hp = Math.min(def.hp, m.hp + 20 * dt);
      if (d < 70) {
        m.state = 'idle';
        m.stateT = 1;
      } else {
        mx = dx / d;
        my = dy / d;
        speed = def.run * 0.8;
      }
    }

    if (m.detourT > 0) {
      m.detourT -= dt;
      if (speed > 0) {
        mx = m.detx;
        my = m.dety;
      }
    }

    const v = { x: mx * speed + m.kx, y: my * speed + m.ky };
    const decay = Math.max(0, 1 - dt * 8);
    m.kx *= decay;
    m.ky *= decay;

    m.scared = false;
    if (def.fearsFire && m.fearless <= 0 && (v.x || v.y || m.state === 'chase')) this.fearFire(m, def, v);

    if (v.x || v.y) {
      const ox = m.x;
      const oy = m.y;
      m.x += v.x * dt;
      m.y += v.y * dt;
      this.world.collide(m, def.r, blocksMob);
      const moved = Math.hypot(m.x - ox, m.y - oy);
      m.moving = moved > 12 * dt;
      if (m.state !== 'chase' && Math.abs(m.x - ox) > 20 * dt) m.dir = m.x < ox ? -1 : 1;
    } else {
      m.moving = false;
    }

    // blocked while hunting? break through buildings or walk around
    if (wantsMove && !m.scared) {
      m.stuckT += dt;
      if (m.stuckT >= 0.5) {
        const progressed = Math.hypot(m.x - m.sx, m.y - m.sy);
        if (progressed < def.run * 0.5 * 0.3) {
          const s = this.nearestStructure(m.x, m.y, def.r + 14);
          if (s) {
            if (m.atkCd <= 0) {
              m.atkCd = def.atkCd;
              this.emitNear(m.x, m.y, ['matk', m.id]);
              this.damageObject(s, def.dmg, (s.x + m.x) / 2, (s.y + m.y) / 2);
            }
          } else if (m.detourT <= 0) {
            const a = Math.atan2(my, mx) + m.side * rand(1.2, 2.0);
            m.detx = Math.cos(a);
            m.dety = Math.sin(a);
            m.detourT = rand(0.45, 0.9);
            m.side = Math.random() < 0.5 ? -1 : 1;
          }
        }
        m.stuckT = 0;
        m.sx = m.x;
        m.sy = m.y;
      }
    } else {
      m.stuckT = 0;
      m.sx = m.x;
      m.sy = m.y;
    }
  }

  /** Wolves do not dare to enter the light of a fire: they circle around it. */
  fearFire(m, def, v) {
    for (const f of this.fires) {
      if (!f.state) continue;
      const R = OBJECTS[f.type].fear + def.r;
      const dx = m.x - f.x;
      const dy = m.y - f.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > (R + 6) * (R + 6)) continue;
      const d = Math.sqrt(d2) || 1;
      const nx = dx / d;
      const ny = dy / d;
      const radial = v.x * nx + v.y * ny;
      if (radial < 0) {
        v.x -= radial * nx;
        v.y -= radial * ny;
      }
      if (d < R - 4) {
        v.x += nx * def.run * 0.9;
        v.y += ny * def.run * 0.9;
      }
      if (m.state === 'chase') {
        v.x += -ny * m.side * def.run * 0.4;
        v.y += nx * m.side * def.run * 0.4;
      }
      m.scared = true;
    }
  }

  nearestStructure(x, y, range) {
    let best = null;
    let bestD = Infinity;
    this.world.grid.query(x, y, range, (o) => {
      if (OBJECTS[o.type].kind !== 'build') return;
      const d = Math.hypot(o.x - x, o.y - y) - o.r;
      if (d < range && d < bestD) {
        bestD = d;
        best = o;
      }
    });
    return best;
  }

  tickMobs(dt) {
    // keep animals from standing inside each other
    const list = [...this.mobs.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const ra = MOBS[a.type].r;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.x - a.x;
        if (dx > 60 || dx < -60) continue;
        const dy = b.y - a.y;
        if (dy > 60 || dy < -60) continue;
        const min = (ra + MOBS[b.type].r) * 0.9;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = ((min - d) / d) * 0.25;
        a.kx -= dx * push * 6;
        a.ky -= dy * push * 6;
        b.kx += dx * push * 6;
        b.ky += dy * push * 6;
      }
    }
    for (const m of list) if (this.mobs.has(m.id)) this.tickMob(m, dt);
  }

  tickSpawns() {
    // daytime population
    const counts = {};
    for (const m of this.mobs.values()) if (!m.night) counts[m.type] = (counts[m.type] || 0) + 1;
    for (const type of Object.keys(POPULATION)) {
      if ((counts[type] || 0) < POPULATION[type]) this.spawnMobRandom(type);
    }
  }

  /** At night packs of wolves hunt every survivor. It gets worse every night. */
  tickNight() {
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (!alive.length) return;
    let wolves = 0;
    let dires = 0;
    for (const m of this.mobs.values()) {
      if (!m.night) continue;
      if (m.type === 'dire') dires++;
      else wolves++;
    }
    const wantWolves = Math.min(40, alive.length * Math.min(2 + Math.floor((this.day - 1) * 0.75), 5));
    const wantDires = Math.min(16, alive.length * Math.min(Math.floor((this.day - 1) / 2), 3));
    const spawnNear = (type) => {
      const p = alive[Math.floor(Math.random() * alive.length)];
      const def = MOBS[type];
      for (let i = 0; i < 14; i++) {
        const a = rand(0, Math.PI * 2);
        const d = rand(800, 930);
        const c = { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
        const t = this.world.tileAt(c.x, c.y);
        if (t === T_WATER) continue;
        let seen = false;
        for (const q of alive) if (Math.abs(q.x - c.x) < VIEW_W / 2 + 60 && Math.abs(q.y - c.y) < VIEW_H / 2 + 60) seen = true;
        if (seen) continue;
        this.world.collide(c, def.r + 2, blocksMob);
        if (this.world.isWater(c.x, c.y)) continue;
        this.spawnMob(type, c.x, c.y, { night: true, target: p.id });
        return;
      }
    };
    if (wolves < wantWolves) spawnNear('wolf');
    if (dires < wantDires) spawnNear('dire');
  }

  // =========================================================================
  // fires, spikes, regrowth
  // =========================================================================
  tickFires(dt) {
    for (const f of this.fires) {
      const def = OBJECTS[f.type];
      if (!def.maxFuel || !f.state) continue;
      const before = Math.ceil((f.fuel / def.maxFuel) * 20);
      f.fuel -= dt;
      if (f.fuel <= 0) {
        f.fuel = 0;
        f.state = 0;
        this.objChanged(f);
        this.emitNear(f.x, f.y, ['fx', 'fireout', f.x, f.y]);
      } else if (Math.ceil((f.fuel / def.maxFuel) * 20) !== before) {
        this.objChanged(f); // tell clients every 5% so the flames shrink
      }
    }
  }

  tickSpikes() {
    for (const s of this.spikes) {
      const def = OBJECTS[s.type];
      let hits = 0;
      for (const m of this.mobs.values()) {
        const r = s.r + MOBS[m.type].r + 5;
        if (dist2(s.x, s.y, m.x, m.y) > r * r) continue;
        this.damageMob(m, def.spike, null, Math.atan2(m.y - s.y, m.x - s.x));
        hits++;
      }
      if (hits) this.damageObject(s, hits * 2, s.x, s.y);
    }
  }

  tickRegrow() {
    for (const o of this.regrow) {
      if (this.time < o.regrowAt) continue;
      o.state = 0;
      o.amount = OBJECTS[o.type].amount;
      this.regrow.delete(o);
      this.objChanged(o);
    }
    for (let i = this.rockGraves.length - 1; i >= 0; i--) {
      const g = this.rockGraves[i];
      if (this.time < g.at) continue;
      // wait until nobody / nothing stands on the spot
      const r = OBJECTS[g.type].r;
      let free = true;
      for (const p of this.players.values()) if (dist2(p.x, p.y, g.x, g.y) < (r + PLAYER_R + 40) ** 2) free = false;
      this.world.grid.query(g.x, g.y, r, (o) => {
        if (dist2(o.x, o.y, g.x, g.y) < (o.r + r) ** 2) free = false;
      });
      if (!free) {
        g.at = this.time + 20;
        continue;
      }
      this.rockGraves.splice(i, 1);
      this.addObject(g.type, g.x, g.y);
    }
  }

  // =========================================================================
  // main loop
  // =========================================================================
  tick(dt) {
    this.time += dt;
    const total = this.time / this.dayLength;
    this.tod = total - Math.floor(total);
    const day = Math.floor(total) + 1;
    const phase = phaseOf(this.tod);
    if (phase !== this.phase || day !== this.day) {
      this.phase = phase;
      this.day = day;
      this.emitAll(['phase', phase, day]);
      if (phase === 'dawn') {
        for (const m of this.mobs.values()) {
          if (!m.night) continue;
          m.state = 'leave';
          m.stateT = 30;
          m.threat = 0;
        }
      }
    }

    this.tickPlayers(dt);
    this.tickMobs(dt);
    this.tickArrows(dt);
    this.tickDrops();
    this.tickFires(dt);

    const acc = this.acc;
    if ((acc.spike += dt) >= 0.5) {
      acc.spike = 0;
      this.tickSpikes();
    }
    if ((acc.regrow += dt) >= 1) {
      acc.regrow = 0;
      this.tickRegrow();
    }
    if ((acc.spawn += dt) >= 2.5) {
      acc.spawn = 0;
      this.tickSpawns();
    }
    if (phase === 'night' && (acc.night += dt) >= 3.5) {
      acc.night = 0;
      this.tickNight();
    }
    if ((acc.lb += dt) >= 1) {
      acc.lb = 0;
      const lb = [];
      for (const p of this.players.values()) {
        lb.push([p.id, Math.round(((this.time - p.bornAt) / this.dayLength) * 10), p.kills, Math.round(p.x), Math.round(p.y), p.alive ? 1 : 0]);
      }
      this.emitAll(['lb', lb]);
    }
    this.flush();
  }

  /** Sends queued events and a world snapshot to every player. */
  flush() {
    const now = this.now();
    const n = Math.round(now);
    const hw = VIEW_W / 2 + 180;
    const hh = VIEW_H / 2 + 230;
    const tod = Math.round(this.tod * 10000) / 10000;
    for (const p of this.players.values()) {
      if (p.invDirty) {
        p.invDirty = false;
        p.evq.push(['inv', this.invWire(p)]);
      }
      if (p.evq.length) {
        p.conn.send({ t: 'e', ev: p.evq });
        p.evq = [];
      }
      const ps = [];
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        if (Math.abs(q.x - p.x) > hw || Math.abs(q.y - p.y) > hh) continue;
        const held = q.inv[q.sel];
        let flags = 0;
        if (now - q.movedAt < 160) flags |= PF_MOVING;
        if (q.armor) flags |= PF_ARMOR;
        if (now < q.shieldUntil) flags |= PF_SHIELD;
        ps.push([q.id, Math.round(q.x), Math.round(q.y), Math.round(q.aim * 100), held ? ITEM_INDEX[held.id] : -1, flags, Math.ceil(q.hp)]);
      }
      const ms = [];
      for (const m of this.mobs.values()) {
        if (Math.abs(m.x - p.x) > hw || Math.abs(m.y - p.y) > hh) continue;
        let flags = 0;
        if (m.dir < 0) flags |= MF_LEFT;
        if (m.moving) flags |= MF_MOVING;
        if (m.state === 'chase') flags |= MF_ANGRY;
        ms.push([m.id, MOB_INDEX[m.type], Math.round(m.x), Math.round(m.y), flags, Math.ceil((m.hp / MOBS[m.type].hp) * 100)]);
      }
      const is = [];
      for (const d of this.drops.values()) {
        if (Math.abs(d.x - p.x) > hw || Math.abs(d.y - p.y) > hh) continue;
        is.push([d.id, ITEM_INDEX[d.item], Math.round(d.x), Math.round(d.y), d.n]);
      }
      const as = [];
      for (const a of this.arrows.values()) {
        if (Math.abs(a.x - p.x) > hw || Math.abs(a.y - p.y) > hh) continue;
        as.push([a.id, Math.round(a.x), Math.round(a.y), Math.round(a.ang * 100)]);
      }
      let bits = 0;
      if (p.armor) bits |= 1;
      if (now < p.shieldUntil) bits |= 2;
      if (p.warm) bits |= 4;
      if (p.canCook) bits |= 8;
      p.conn.sendVolatile({
        t: 's', n, d: tod, y: this.day, p: ps, m: ms, i: is, a: as,
        me: [Math.round(p.hp * 10) / 10, Math.round(p.hunger * 10) / 10, Math.round(p.warmth * 10) / 10, bits],
      });
    }
  }
}
