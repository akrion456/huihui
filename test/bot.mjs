// A headless game client. Used by the smoke test and by `npm run bots`
// (a few computer-controlled survivors that walk around and gather things).
import WebSocket from 'ws';
import { World } from '../public/shared/physics.js';
import {
  OBJ_IDS, ITEM_IDS, ITEM_INDEX, OBJECTS, ITEMS, HAND, RECIPES, PLAYER_R, PLAYER_SPEED, blocksPlayer,
} from '../public/shared/defs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Bot {
  /**
   * @param {string} base  e.g. http://localhost:3000
   * @param {string} name
   * @param {{transport?: 'ws'|'poll', token?: string, skin?: number}} opts
   */
  constructor(base, name, opts = {}) {
    this.base = base.replace(/\/$/, '');
    this.name = name;
    this.transport = opts.transport || 'ws';
    this.token = opts.token || `bot-${Math.random().toString(36).slice(2, 12)}`;
    this.skin = opts.skin ?? Math.floor(Math.random() * 4);
    this.events = [];
    this.waiters = [];
    this.me = null;
    this.world = null;
    this.players = new Map();
    this.near = { p: [], m: [], i: [], a: [] };
    this.snapshots = 0;
    this.closed = false;
    this.outbox = [];
  }

  // ------------------------------------------------------------ transport
  async connect() {
    const ready = this.waitFor((e) => e[0] === 'init', 8000);
    if (this.transport === 'ws') {
      this.ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws');
      await new Promise((resolve, reject) => {
        this.ws.once('open', resolve);
        this.ws.once('error', reject);
      });
      this.ws.on('message', (d) => this._onMessage(JSON.parse(d.toString())));
      this.ws.on('close', () => {
        this.closed = true;
      });
    } else {
      this.sid = null;
      this._pollLoop();
    }
    this.send(['join', this.name, this.skin, this.token]);
    await ready;
    return this;
  }

  async _pollLoop() {
    while (!this.closed) {
      const m = this.outbox;
      this.outbox = [];
      try {
        const res = await fetch(this.base + '/api/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ s: this.sid, m }),
        });
        if (!res.ok) {
          this.closed = true;
          break;
        }
        const data = await res.json();
        this.sid = data.s;
        for (const msg of data.m) this._onMessage(msg);
      } catch {
        this.closed = true;
        break;
      }
      await sleep(60);
    }
  }

  send(msg) {
    if (this.closed) return;
    if (this.transport === 'ws') {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.transport === 'ws') {
      this.ws.close();
    } else if (this.sid) {
      await fetch(this.base + '/api/poll', { method: 'POST', body: JSON.stringify({ s: this.sid, bye: true }) }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ incoming
  _emit(ev) {
    this.events.push(ev);
    if (this.events.length > 4000) this.events.splice(0, 2000);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.pred(ev)) {
        this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(ev);
      }
    }
  }

  /** Resolves with the first future event matching pred. */
  waitFor(pred, timeout = 5000, label = '') {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.name}: timeout waiting for ${label || pred.toString()}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  _onMessage(msg) {
    if (msg.t === 'init') {
      this.init = msg;
      const tiles = Uint8Array.from(msg.tiles, (c) => c.charCodeAt(0) - 48);
      this.world = new World(msg.w, msg.h, tiles);
      for (const o of msg.objs) this._addObj(o);
      for (const [id, name, skin] of msg.players) this.players.set(id, { name, skin });
      this.me = { id: msg.id, ...msg.you, inv: this._inv(msg.you.inv), aim: 0 };
      this._emit(['init', msg]);
    } else if (msg.t === 's') {
      this.snapshots++;
      this.near = msg;
      this.tod = msg.d;
      if (this.me) {
        [this.me.hp, this.me.hunger, this.me.warmth, this.me.bits] = msg.me;
      }
    } else if (msg.t === 'e') {
      for (const ev of msg.ev) this._onEvent(ev);
    } else if (msg.t === 'pong') {
      this._emit(['pong', msg.c]);
    }
  }

  _inv(wire) {
    return wire.map((s) => (s ? { id: ITEM_IDS[s[0]], n: s[1] } : null));
  }

  _addObj(w) {
    const type = OBJ_IDS[w[1]];
    this.world.addObject({ id: w[0], type, x: w[2], y: w[3], r: OBJECTS[type].r, state: w[4], hp: w[5], fuel: w[6] });
  }

  _onEvent(ev) {
    const me = this.me;
    switch (ev[0]) {
      case 'inv': me.inv = this._inv(ev[1]); break;
      case 'tp': me.x = ev[1]; me.y = ev[2]; me.epoch = ev[3]; break;
      case 'spawn': me.x = ev[1]; me.y = ev[2]; me.epoch = ev[3]; me.alive = true; break;
      case 'dead': me.alive = false; break;
      case 'o+': this._addObj(ev.slice(1)); break;
      case 'o-': this.world.removeObject(ev[1]); break;
      case 'ou': {
        const o = this.world.objects.get(ev[1]);
        if (o) {
          o.state = ev[2];
          o.hp = ev[3];
          if (ev.length > 4) o.fuel = ev[4];
        }
        break;
      }
      case 'pj': this.players.set(ev[1], { name: ev[2], skin: ev[3] }); break;
      case 'pl': this.players.delete(ev[1]); break;
      default: break;
    }
    this._emit(ev);
  }

  // ------------------------------------------------------------ actions
  count(id) {
    return this.me.inv.reduce((n, s) => n + (s && s.id === id ? s.n : 0), 0);
  }

  slotOf(id) {
    return this.me.inv.findIndex((s) => s && s.id === id);
  }

  select(id) {
    const i = id === null ? this.me.inv.findIndex((s) => !s) : this.slotOf(id);
    if (i < 0) return false;
    this.me.sel = i;
    this.send(['sel', i]);
    return true;
  }

  heldStats() {
    const s = this.me.inv[this.me.sel];
    return s && ITEMS[s.id].kind === 'tool' ? ITEMS[s.id] : HAND;
  }

  /** One movement step (dt seconds) towards a point. */
  step(tx, ty, dt) {
    const me = this.me;
    const dx = tx - me.x;
    const dy = ty - me.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return 0;
    const s = Math.min(d, PLAYER_SPEED * dt);
    me.x += (dx / d) * s;
    me.y += (dy / d) * s;
    this.world.collide(me, PLAYER_R, blocksPlayer);
    me.aim = Math.atan2(dy, dx);
    this.send(['m', Math.round(me.x * 10) / 10, Math.round(me.y * 10) / 10, Math.round(me.aim * 100) / 100, me.epoch]);
    return d;
  }

  /** Walks to (x, y); gives up after `timeout` ms. Returns the remaining distance. */
  async walkTo(x, y, stop = 4, timeout = 15000) {
    const end = Date.now() + timeout;
    let last = Date.now();
    let stuck = 0;
    let side = Math.random() < 0.5 ? 1 : -1;
    while (Date.now() < end && !this.closed && this.me.alive) {
      const now = Date.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const before = Math.hypot(x - this.me.x, y - this.me.y);
      if (before <= stop) return before;
      if (stuck > 6) {
        // slide sideways around whatever blocks the way
        const a = Math.atan2(y - this.me.y, x - this.me.x) + side * 1.4;
        for (let i = 0; i < 8; i++) {
          this.step(this.me.x + Math.cos(a) * 100, this.me.y + Math.sin(a) * 100, 0.05);
          await sleep(50);
        }
        stuck = 0;
        side = Math.random() < 0.3 ? -side : side;
        last = Date.now();
        continue;
      }
      this.step(x, y, dt);
      const after = Math.hypot(x - this.me.x, y - this.me.y);
      stuck = before - after < PLAYER_SPEED * dt * 0.25 ? stuck + 1 : 0;
      await sleep(50);
    }
    return Math.hypot(x - this.me.x, y - this.me.y);
  }

  nearest(filter) {
    let best = null;
    let bestD = Infinity;
    for (const o of this.world.objects.values()) {
      if (!filter(o)) continue;
      const d = Math.hypot(o.x - this.me.x, o.y - this.me.y);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  use(aim, tx = this.me.x + Math.cos(aim) * 80, ty = this.me.y + Math.sin(aim) * 80) {
    this.me.aim = aim;
    this.send(['u', Math.round(aim * 100) / 100, Math.round(tx), Math.round(ty)]);
  }

  /** Walks next to an object and hits it until `until()` is true. */
  async harvest(o, until, maxHits = 40) {
    const stats = this.heldStats();
    await this.walkTo(o.x, o.y, o.r + PLAYER_R + 6);
    for (let i = 0; i < maxHits && !until() && this.world.objects.has(o.id) && this.me.alive; i++) {
      if (OBJECTS[o.type].kind !== 'rock' && o.state === 1) break;
      this.use(Math.atan2(o.y - this.me.y, o.x - this.me.x), o.x, o.y);
      await sleep(stats.cd * 1000 + 40);
    }
  }

  async gather(item, amount, timeout = 60000) {
    const kind = { wood: 'tree', stone: 'rock', berries: 'bush' }[item];
    const end = Date.now() + timeout;
    while (this.count(item) < amount && Date.now() < end && this.me.alive && !this.closed) {
      const o = this.nearest((q) => OBJECTS[q.type].kind === kind && q.state === 0);
      if (!o) break;
      await this.harvest(o, () => this.count(item) >= amount);
    }
    return this.count(item) >= amount;
  }

  craft(id) {
    this.send(['c', RECIPES.findIndex((r) => r.id === id)]);
  }

  chat(text) {
    this.send(['chat', text]);
  }
}

export { sleep, ITEM_INDEX };

// ---------------------------------------------------------------------------
// `node test/bot.mjs [count] [url]` : computer-controlled survivors
// ---------------------------------------------------------------------------
async function roam(bot) {
  const say = ['hello!', 'anyone seen berries?', 'wolves at night... stay near the fire', 'need more wood', 'nice forest', 'brb chopping'];
  while (!bot.closed) {
    const me = bot.me;
    if (!me.alive) {
      await sleep(2500);
      bot.send(['r']);
      await sleep(500);
      continue;
    }
    try {
      if (me.hunger < 55) {
        if (bot.count('berries') > 0) {
          bot.select('berries');
          for (let i = 0; i < 4 && bot.count('berries') > 0; i++) {
            bot.use(0);
            await sleep(450);
          }
        } else {
          await bot.gather('berries', 5, 25000);
        }
        continue;
      }
      const night = bot.tod > 0.56;
      if (night) {
        // huddle at the Great Fire
        const [sx, sy] = bot.init.spawn;
        const a = Math.random() * Math.PI * 2;
        await bot.walkTo(sx + Math.cos(a) * 90, sy + Math.sin(a) * 90, 20, 30000);
        await sleep(1500 + Math.random() * 2000);
        continue;
      }
      if (!bot.count('axe') && bot.count('wood') >= 8 && bot.count('stone') >= 4) bot.craft('axe');
      if (!bot.count('spear') && bot.count('wood') >= 12 && bot.count('stone') >= 5) bot.craft('spear');
      bot.select(bot.count('axe') ? 'axe' : null);
      const want = Math.random() < 0.6 ? 'wood' : 'stone';
      if (want === 'stone' && bot.count('pickaxe')) bot.select('pickaxe');
      await bot.gather(want, bot.count(want) + 4 + Math.floor(Math.random() * 6), 20000);
      if (Math.random() < 0.15) bot.chat(say[Math.floor(Math.random() * say.length)]);
      // wander a bit
      const a = Math.random() * Math.PI * 2;
      await bot.walkTo(me.x + Math.cos(a) * 250, me.y + Math.sin(a) * 250, 10, 4000);
    } catch (err) {
      console.error(bot.name, err.message);
      await sleep(1000);
    }
    await sleep(200);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = Number(process.argv[2] || 3);
  const url = process.argv[3] || `http://localhost:${process.env.PORT || 3000}`;
  const names = ['Ash', 'Birch', 'Cedar', 'Fern', 'Hazel', 'Rowan', 'Sage', 'Willow', 'Moss', 'Juniper'];
  for (let i = 0; i < count; i++) {
    const bot = new Bot(url, `${names[i % names.length]}`, { skin: i % 4 });
    bot.connect().then(() => {
      console.log(`${bot.name} joined`);
      roam(bot);
    }, (err) => console.error('bot failed to connect:', err.message));
    await sleep(300);
  }
}
