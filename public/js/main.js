// Wildwood browser client: connects to the server, keeps the local copy of the
// world up to date, moves the player and runs the frame loop.
import {
  PROTOCOL, ITEMS, ITEM_IDS, OBJ_IDS, OBJECTS, MOB_IDS, MOBS, HAND, RECIPES, PLAYER_R, PLAYER_SPEED, INTERACT_RANGE,
  blocksPlayer, PF_ARMOR, PF_SHIELD, PF_MOVING, MF_ANGRY, MF_MOVING,
} from '../shared/defs.js';
import { World, placementSpot, placementError, angleDiff } from '../shared/physics.js';
import { S } from './state.js';
import { local, session } from './store.js';
import { Net } from './net.js';
import { loadImages, itemIcon, OBJ_SPRITES } from './assets.js';
import { Terrain } from './terrain.js';
import { initRenderer, render, screenToWorld, spritesReady } from './render.js';
import { burst, floatText, updateFx, clearFx } from './fx.js';
import { play, setMuted, unlockAudio } from './audio.js';
import { input, initInput, releaseAll } from './input.js';
import * as ui from './ui.js';

const NEVER = -1e9;
const RECIPE_IDS = RECIPES.map((r) => r.id);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

let joinInfo = null;
let reconnects = 0;
let lastFrame = performance.now();
let lastSent = 0;
let sentX = 0;
let sentY = 0;
let sentAim = 0;
let hintTimer = 0;
let pingTimer = 0;
let snapSeq = 0;
let gainStack = 0;
let gainStackAt = 0;
let lastGrowl = 0;
let lastDenyToast = 0;

function token() {
  let t = session.get('wildwood.token');
  if (!t) {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    t = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    session.set('wildwood.token', t);
  }
  return t;
}

const send = (msg) => S.net && S.net.send(msg);

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------
function onPlay(name, skin) {
  unlockAudio();
  joinInfo = { name, skin };
  S.phase = 'connecting';
  ui.setJoinState('connecting', '');
  connect();
}

function connect() {
  if (!S.net) S.net = new Net({ onOpen, onMessage, onClose });
  S.net.connect();
}

function onOpen() {
  send(['join', joinInfo.name, joinInfo.skin, token()]);
}

function onClose() {
  if (S.phase === 'playing' || S.phase === 'reconnecting') {
    S.phase = 'reconnecting';
    releaseAll();
    reconnects++;
    ui.showLost(true, reconnects > 8 ? 'The server does not answer. Still trying…' : 'Trying to reconnect…');
    setTimeout(connect, Math.min(5000, 800 + reconnects * 400));
  } else if (S.phase === 'connecting') {
    S.phase = 'menu';
    ui.setJoinState('error', 'Could not reach the server. Please try again.');
  }
}

function onMessage(msg) {
  try {
    switch (msg.t) {
      case 's': onSnapshot(msg); break;
      case 'e': for (const ev of msg.ev) onEvent(ev); break;
      case 'init': onInit(msg); break;
      case 'pong': {
        const rtt = performance.now() - msg.c;
        S.ping = S.ping ? S.ping * 0.7 + rtt * 0.3 : rtt;
        break;
      }
      case 'full':
        S.phase = 'menu';
        S.net.close(true);
        ui.setJoinState('error', 'The forest is full right now. Please try again later.');
        break;
      default: break;
    }
  } catch (err) {
    console.error('error while handling', msg && msg.t, err);
  }
}

// ---------------------------------------------------------------------------
// world state from the server
// ---------------------------------------------------------------------------
const decodeInv = (wire) => wire.map((s) => (s ? { id: ITEM_IDS[s[0]], n: s[1] } : null));

function setTod(tod) {
  S.todBase = tod;
  S.todAt = performance.now();
  S.tod = tod;
}

function updateHeld() {
  const me = S.me;
  const s = me.inv[me.sel];
  me.held = s ? s.id : null;
}

function countItem(id) {
  let n = 0;
  for (const s of S.me.inv) if (s && s.id === id) n += s.n;
  return n;
}

function addObj(w, isNew) {
  const type = OBJ_IDS[w[1]];
  const def = OBJECTS[type];
  const o = { id: w[0], type, x: w[2], y: w[3], r: def.r, state: w[4] };
  let i = 5;
  if (def.hp) o.hpPct = w[i++];
  if (def.maxFuel) o.fuelPct = w[i++];
  if (isNew) o.bornT = S.now;
  S.world.addObject(o);
  if (def.fire) S.fires.add(o);
  if (type === 'tent') S.tents.add(o);
}

function removeObj(id) {
  const o = S.world.removeObject(id);
  if (!o) return;
  S.fires.delete(o);
  S.tents.delete(o);
  if (S.hint && S.hint.obj === o) S.hint = null;
}

function onInit(m) {
  if (m.v !== PROTOCOL) {
    // the server was updated while this page was open
    S.net.close(true);
    location.reload();
    return;
  }
  const tiles = new Uint8Array(m.tiles.length);
  for (let i = 0; i < tiles.length; i++) tiles[i] = m.tiles.charCodeAt(i) - 48;
  S.world = new World(m.w, m.h, tiles);
  S.terrain = new Terrain(S.world);
  S.fires = new Set();
  S.tents = new Set();
  for (const o of m.objs) addObj(o, false);
  S.roster = new Map(m.players.map(([id, name, skin]) => [id, { name, skin }]));
  S.spawn = { x: m.spawn[0], y: m.spawn[1] };
  S.dayLength = m.dayLength;
  S.day = m.day;
  setTod(m.tod);
  S.serverOffset = m.n - performance.now();
  S.haveOffset = true;
  S.renderDelay = S.net.transport === 'poll' ? 250 : 110;
  S.others.clear();
  S.mobs.clear();
  S.drops.clear();
  S.arrows.clear();
  S.bubbles.clear();
  S.board = [];
  S.ghost = null;
  S.hint = null;
  clearFx();
  const you = m.you;
  const info = S.roster.get(m.id) || { name: joinInfo.name, skin: joinInfo.skin };
  S.me = {
    id: m.id, name: info.name, skin: info.skin, x: you.x, y: you.y, epoch: you.epoch,
    hp: you.hp, hunger: you.hunger, warmth: you.warmth, alive: you.alive, sel: you.sel, inv: decodeInv(you.inv),
    aim: 0, bits: 0, flags: 0, moving: false, walkT: 0, useT: NEVER, hurtT: NEVER, held: null,
  };
  sentX = you.x;
  sentY = you.y;
  updateHeld();
  S.phase = 'playing';
  reconnects = 0;
  ui.showLost(false);
  ui.hideDeath();
  ui.showGame(true);
  ui.refreshInventory();
  if (!you.resumed) {
    ui.addChat('', 'Welcome to the Wildwood. Press H for help, Enter to chat.', 'sys');
    if (!local.get('wildwood.help') && !S.touch) ui.showHelp(true);
  }
}

function pushSample(e, t, x, y) {
  const buf = e.buf;
  if (buf.length && buf[buf.length - 1].t >= t) return;
  buf.push({ t, x, y });
  if (buf.length > 10) buf.shift();
}

/** Position of an entity at server time t (interpolated between snapshots). */
function sample(e, t) {
  const buf = e.buf;
  const n = buf.length;
  if (!n) return;
  if (n === 1 || t <= buf[0].t) {
    e.x = buf[0].x;
    e.y = buf[0].y;
    return;
  }
  for (let i = n - 1; i >= 1; i--) {
    const a = buf[i - 1];
    if (t < a.t) continue;
    const b = buf[i];
    // beyond the newest snapshot: keep going for a moment, then wait
    const k = Math.min((t - a.t) / (b.t - a.t), i === n - 1 ? 1 + 100 / (b.t - a.t) : 1);
    e.x = a.x + (b.x - a.x) * k;
    e.y = a.y + (b.y - a.y) * k;
    return;
  }
}

function sync(map, list, create, update) {
  const seq = ++snapSeq;
  for (const w of list) {
    let e = map.get(w[0]);
    if (!e) {
      e = create(w);
      map.set(w[0], e);
    }
    update(e, w);
    e.seen = seq;
  }
  for (const [id, e] of map) if (e.seen !== seq) map.delete(id);
}

function onSnapshot(s) {
  const me = S.me;
  if (!me || !S.world) return;
  const off = s.n - performance.now();
  if (!S.haveOffset || Math.abs(off - S.serverOffset) > 350) S.serverOffset = off;
  else S.serverOffset += (off - S.serverOffset) * 0.06;
  S.haveOffset = true;
  setTod(s.d);
  S.day = s.y;
  const t = s.n;

  const [hp, hunger, warmth, bits] = s.me;
  me.hp = hp;
  me.hunger = hunger;
  me.warmth = warmth;
  if (bits !== me.bits) {
    me.bits = bits;
    me.flags = (bits & 1 ? PF_ARMOR : 0) | (bits & 2 ? PF_SHIELD : 0);
    ui.refreshCraft();
  }

  sync(
    S.others, s.p,
    (w) => {
      const info = S.roster.get(w[0]);
      return { id: w[0], buf: [], x: w[1], y: w[2], aim: w[3] / 100, aimT: w[3] / 100, skin: info ? info.skin : 0, walkT: 0, useT: NEVER, hurtT: NEVER, held: null, flags: 0, hp: 100, moving: false };
    },
    (e, w) => {
      pushSample(e, t, w[1], w[2]);
      e.aimT = w[3] / 100;
      e.held = w[4] >= 0 ? ITEM_IDS[w[4]] : null;
      e.flags = w[5];
      e.hp = w[6];
    },
  );
  sync(
    S.mobs, s.m,
    (w) => ({ id: w[0], type: MOB_IDS[w[1]], buf: [], x: w[2], y: w[3], flags: 0, hp: 100, walkT: Math.random() * 3, speed: 0, hurtT: NEVER, atkT: NEVER, angryT: NEVER }),
    (e, w) => {
      pushSample(e, t, w[2], w[3]);
      if (w[4] & MF_ANGRY && !(e.flags & MF_ANGRY)) {
        e.angryT = S.now;
        if (MOBS[e.type].dmg && S.now - lastGrowl > 1500) {
          lastGrowl = S.now;
          play('growl', e.x, e.y);
        }
      }
      e.flags = w[4];
      e.hp = w[5];
    },
  );
  sync(
    S.drops, s.i,
    (w) => ({ id: w[0], item: ITEM_IDS[w[1]], x: w[2], y: w[3], n: w[4], bornT: S.now }),
    (e, w) => {
      e.n = w[4];
    },
  );
  sync(
    S.arrows, s.a,
    (w) => ({ id: w[0], buf: [], x: w[1], y: w[2], ang: w[3] / 100 }),
    (e, w) => {
      pushSample(e, t, w[1], w[2]);
    },
  );
}

const HIT_FX = {
  tree: ['wood', 'chop'],
  rock: ['stone', 'mine'],
  bush: ['leaf', 'rustle'],
  build: ['wood', 'chop'],
  fixed: ['stone', 'mine'],
};

function onEvent(ev) {
  const me = S.me;
  const now = S.now;
  switch (ev[0]) {
    case 'inv':
      me.inv = decodeInv(ev[1]);
      updateHeld();
      ui.refreshInventory();
      break;
    case 'tp':
      me.x = ev[1];
      me.y = ev[2];
      me.epoch = ev[3];
      break;
    case 'spawn':
      me.x = ev[1];
      me.y = ev[2];
      me.epoch = ev[3];
      me.alive = true;
      me.hp = 100;
      ui.hideDeath();
      play('dawn');
      break;
    case 'dead':
      me.alive = false;
      S.ghost = null;
      S.hint = null;
      releaseAll();
      ui.showDeath(ev[1], ev[2], ev[3]);
      play('death');
      break;
    case 'o+':
      addObj(ev.slice(1), true);
      break;
    case 'o-':
      removeObj(ev[1]);
      break;
    case 'ou': {
      const o = S.world.objects.get(ev[1]);
      if (!o) break;
      const def = OBJECTS[o.type];
      if (o.state !== ev[2]) {
        if (ev[2] === 0 && def.kind !== 'build') o.bornT = now; // grown back
        o.state = ev[2];
      }
      if (def.hp) o.hpPct = ev[3];
      if (def.maxFuel) o.fuelPct = ev[4];
      break;
    }
    case 'hit': {
      const [, kind, id, x, y, dmg] = ev;
      if (kind === 0) {
        const o = S.world.objects.get(id);
        if (!o) break;
        o.shakeT = now;
        const def = OBJECTS[o.type];
        const [part, snd] = HIT_FX[def.kind];
        burst(part, x, y, def.kind === 'tree' ? 26 : 16);
        if (def.kind === 'tree') burst('leaf', o.x, o.y, OBJ_SPRITES[o.type].h * 0.6, 0.8);
        if (def.kind === 'bush' && o.state === 0) burst('berry', x, y, 16, 0.6);
        play(snd, x, y);
        if (dmg > 0) floatText(o.x, o.y - 50, `-${dmg}`, '#ffd9a0', { size: 13 });
      } else if (kind === 1) {
        const m = S.mobs.get(id);
        if (m) m.hurtT = now;
        burst('blood', x, y, 18);
        floatText(x + (Math.random() - 0.5) * 16, y - 44, `-${dmg}`, '#ffffff', { size: 15 });
        play('hit', x, y);
      } else {
        burst('blood', x, y, 26);
        if (id === me.id) {
          me.hurtT = now;
          S.cam.shake = Math.min(16, 6 + dmg * 0.5);
          ui.hurtFlash(Math.min(1, 0.45 + dmg / 30));
          floatText(me.x, me.y - 70, `-${dmg}`, '#ff6a5e', { size: 17 });
          play('hurt');
        } else {
          const p = S.others.get(id);
          if (p) p.hurtT = now;
          play('hit', x, y);
        }
      }
      break;
    }
    case 'fx': {
      const [, name, x, y, idx] = ev;
      if (name === 'break') {
        const rock = OBJ_IDS[idx] === 'rock';
        burst(rock ? 'rubble' : 'splinter', x, y, 20);
        burst('dust', x, y, 6);
        play('crash', x, y);
      } else if (name === 'fall') {
        const spr = OBJ_SPRITES[OBJ_IDS[idx]];
        burst('leaf', x, y, spr.h * 0.6, 4);
        burst('leaf', x, y, spr.h * 0.35, 3);
        burst('splinter', x, y, 24, 0.7);
        play('crash', x, y);
      } else if (name === 'build') {
        burst('dust', x, y, 6, 2);
        play('build', x, y);
      } else if (name === 'fuel') {
        burst('spark', x, y - 4, 26, 10);
        play('fire', x, y);
      } else if (name === 'fireout') {
        burst('smoke', x, y, 24, 6);
      } else if (name === 'eat') {
        burst('crumbs', x, y, 34);
        play('eat', x, y);
      } else if (name === 'pdie') {
        burst('puff', x, y, 22, 1.4);
        burst('blood', x, y, 22, 1.5);
      } else if (name === 'mdie') {
        burst('puff', x, y, 16);
        if (MOB_IDS[idx] === 'rabbit') play('squeak', x, y);
        else play('hit', x, y);
      }
      break;
    }
    case 'toast': {
      const text = ev[1];
      ui.toast(text);
      if (!/placed|Spawn point|burning well/.test(text) && now - lastDenyToast > 300) {
        lastDenyToast = now;
        play('deny');
      }
      break;
    }
    case 'pj':
      S.roster.set(ev[1], { name: ev[2], skin: ev[3] });
      break;
    case 'pl':
      S.roster.delete(ev[1]);
      S.others.delete(ev[1]);
      S.bubbles.delete(ev[1]);
      break;
    case 'sys':
      ui.addChat('', ev[1], ev[2] ? 'sys death' : 'sys');
      break;
    case 'chat':
      ui.addChat(ev[2], ev[3]);
      S.bubbles.set(ev[1], { text: ev[3], until: now + 4500 + ev[3].length * 45 });
      if (ev[1] !== me.id) play('chat');
      break;
    case 'gain': {
      const id = ITEM_IDS[ev[1]];
      if (now - gainStackAt > 500) gainStack = 0;
      gainStackAt = now;
      floatText(me.x, me.y - 84 - gainStack * 17, `+${ev[2]}`, '#fff6c9', { icon: itemIcon(id), size: 15, life: 1.2 });
      gainStack = (gainStack + 1) % 4;
      if (ev[3]) play('pickup');
      break;
    }
    case 'crafted':
      ui.flashRecipe(ev[1]);
      S.stats.crafted[RECIPE_IDS[ev[1]]] = true;
      play('craft');
      break;
    case 'placed':
      S.stats.placed[OBJ_IDS[ev[1]]] = true;
      break;
    case 'ate':
      S.stats.ate = true;
      burst('crumbs', me.x, me.y, 34);
      play('eat');
      break;
    case 'sw': {
      const p = S.others.get(ev[1]);
      if (p) {
        p.useT = now;
        p.aimT = ev[2] / 100;
        p.aim = p.aimT;
        play(ev[3] ? 'bow' : 'swing', p.x, p.y);
      }
      break;
    }
    case 'matk': {
      const m = S.mobs.get(ev[1]);
      if (m) {
        m.atkT = now;
        if (now - lastGrowl > 500) {
          lastGrowl = now;
          play('growl', m.x, m.y);
        }
      }
      break;
    }
    case 'phase': {
      const [, phase, day] = ev;
      S.day = day;
      if (phase === 'dusk') ui.toast('The sun is setting - get to a fire!', 'big');
      else if (phase === 'night') {
        ui.toast('Night has fallen', 'big');
        play('howl');
      } else if (phase === 'day') {
        S.stats.dawns++;
        ui.toast(`Day ${day}`, 'big');
        play('dawn');
      }
      break;
    }
    case 'lb':
      S.board = ev[1];
      ui.refreshBoard();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// playing
// ---------------------------------------------------------------------------
function heldItem() {
  const s = S.me.inv[S.me.sel];
  return s ? ITEMS[s.id] : null;
}

/** The spot in the world the player points at. */
function targetPoint() {
  const me = S.me;
  if (S.touch && performance.now() > (S.touchAimUntil || 0)) {
    return { x: me.x + Math.cos(me.aim) * 80, y: me.y + Math.sin(me.aim) * 80 };
  }
  return screenToWorld(input.mx, input.my);
}

/** Touch screens have no mouse: aim at whatever is worth hitting. */
function autoAim() {
  const me = S.me;
  const item = heldItem();
  const bow = item && item.kind === 'bow';
  const reach = bow ? 480 : (item && item.kind === 'tool' ? item.reach : HAND.reach) + 26;
  let best = null;
  let bestD = Infinity;
  for (const m of S.mobs.values()) {
    const d = Math.hypot(m.x - me.x, m.y - me.y) - MOBS[m.type].r;
    if (d < reach + 30 && d < bestD) {
      bestD = d;
      best = m;
    }
  }
  if (!best && !bow) {
    S.world.grid.query(me.x, me.y, reach, (o) => {
      const def = OBJECTS[o.type];
      if (def.kind === 'fixed' || def.kind === 'build') return;
      if (o.state === 1) return;
      const d = Math.hypot(o.x - me.x, o.y - me.y) - o.r;
      if (d < reach && d < bestD) {
        bestD = d;
        best = o;
      }
    });
  }
  if (best) me.aim = Math.atan2(best.y - me.y, best.x - me.x);
}

function updateGhost() {
  const me = S.me;
  const item = heldItem();
  if (!me.alive || !item || item.kind !== 'build') {
    S.ghost = null;
    return;
  }
  const t = targetPoint();
  const type = item.obj;
  const def = OBJECTS[type];
  const spot = placementSpot(me.x, me.y, t.x, t.y, type);
  let err = placementError(S.world, S.spawn, type, spot.x, spot.y);
  if (!err && !def.gate) {
    const rr = (def.r + PLAYER_R + 1) ** 2;
    if ((spot.x - me.x) ** 2 + (spot.y - me.y) ** 2 < rr) err = 'You are standing there.';
    for (const p of S.others.values()) if ((spot.x - p.x) ** 2 + (spot.y - p.y) ** 2 < rr) err = 'Someone is standing there.';
  }
  if (!err) {
    for (const m of S.mobs.values()) {
      if ((spot.x - m.x) ** 2 + (spot.y - m.y) ** 2 < (def.r + MOBS[m.type].r) ** 2) err = 'An animal is in the way.';
    }
  }
  S.ghost = { type, x: spot.x, y: spot.y, ok: !err, err };
}

function updateHint() {
  const me = S.me;
  if (!me.alive) {
    S.hint = null;
    return;
  }
  let best = null;
  let bestD = Infinity;
  S.world.grid.query(me.x, me.y, INTERACT_RANGE, (o) => {
    if (o.type !== 'campfire' && o.type !== 'tent') return;
    const d = Math.hypot(o.x - me.x, o.y - me.y) - o.r;
    if (d < INTERACT_RANGE && d < bestD) {
      bestD = d;
      best = o;
    }
  });
  if (!best) {
    S.hint = null;
    return;
  }
  const key = S.touch ? 'Tap E:' : '[E]';
  if (best.type === 'tent') {
    S.hint = { obj: best, text: `${key} respawn at this tent` };
    return;
  }
  const fuel = Math.round(best.fuelPct ?? 0);
  if (fuel >= 99) S.hint = { obj: null, text: '' };
  else if (countItem('wood') > 0) S.hint = { obj: best, text: `${key} add wood  ·  fire ${fuel}%` };
  else S.hint = { obj: best, text: `Fire ${fuel}% - bring wood to feed it` };
  if (!S.hint.text) S.hint = null;
}

function tryUse(fresh) {
  const me = S.me;
  const now = S.now;
  const item = heldItem();
  const kind = item ? item.kind : 'hand';
  let cd;
  if (kind === 'food') cd = 350;
  else if (kind === 'build') cd = 230;
  else if (kind === 'tool' || kind === 'bow') cd = item.cd * 1000;
  else cd = HAND.cd * 1000;
  if (now - me.useT < cd) return;
  if (kind === 'food' && !fresh) return; // one bite per click
  if (S.touch && performance.now() > (S.touchAimUntil || 0) && kind !== 'build') autoAim();
  const t = targetPoint();
  if (kind === 'build') {
    updateGhost();
    const g = S.ghost;
    if (!g) return;
    if (!g.ok) {
      if (fresh) {
        ui.toast(g.err);
        play('deny');
      }
      return;
    }
  } else if (kind === 'bow') {
    if (countItem('arrow') < 1) {
      if (fresh) {
        ui.toast('No arrows! Craft some.');
        play('deny');
      }
      return;
    }
    play('bow');
  } else if (kind !== 'food') {
    play('swing');
  }
  me.useT = now;
  send(['u', round2(me.aim), Math.round(t.x), Math.round(t.y)]);
}

function update(dt) {
  const me = S.me;
  const now = S.now;
  S.tod = (S.todBase + (performance.now() - S.todAt) / 1000 / S.dayLength) % 1;

  if (me.alive) {
    // --- walk
    let ix = (input.right ? 1 : 0) - (input.left ? 1 : 0) + input.joyX;
    let iy = (input.down ? 1 : 0) - (input.up ? 1 : 0) + input.joyY;
    const len = Math.hypot(ix, iy);
    if (len > 1) {
      ix /= len;
      iy /= len;
    }
    if (len > 0.05) {
      me.x += ix * PLAYER_SPEED * dt;
      me.y += iy * PLAYER_SPEED * dt;
      S.world.collide(me, PLAYER_R, blocksPlayer);
      me.moving = true;
      me.walkT += dt * Math.min(1, len);
    } else {
      me.moving = false;
    }

    // --- aim
    if (S.touch && performance.now() > (S.touchAimUntil || 0)) {
      if (len > 0.2) me.aim = Math.atan2(iy, ix);
    } else {
      const m = screenToWorld(input.mx, input.my);
      me.aim = Math.atan2(m.y - (me.y - 12), m.x - me.x);
    }

    // --- act
    const fresh = input.clicked;
    input.clicked = false;
    if (input.fire || input.space || input.touchUse || fresh) tryUse(fresh);
    updateGhost();
    hintTimer -= dt;
    if (hintTimer <= 0) {
      hintTimer = 0.12;
      updateHint();
    }

    // --- tell the server (20 times per second at most)
    if (now - lastSent >= 50) {
      if (Math.abs(me.x - sentX) > 0.05 || Math.abs(me.y - sentY) > 0.05 || Math.abs(angleDiff(me.aim, sentAim)) > 0.04) {
        lastSent = now;
        sentX = me.x;
        sentY = me.y;
        sentAim = me.aim;
        send(['m', round1(me.x), round1(me.y), round2(me.aim), me.epoch]);
      }
    }
  } else {
    input.clicked = false;
    me.moving = false;
  }

  // --- everybody else: positions between two server snapshots
  const rt = now + S.serverOffset - S.renderDelay;
  for (const e of S.others.values()) {
    sample(e, rt);
    e.moving = (e.flags & PF_MOVING) !== 0;
    if (e.moving) e.walkT += dt;
    e.aim += angleDiff(e.aimT, e.aim) * Math.min(1, dt * 14);
  }
  for (const e of S.mobs.values()) {
    const ox = e.x;
    const oy = e.y;
    sample(e, rt);
    const v = Math.hypot(e.x - ox, e.y - oy) / Math.max(dt, 0.001);
    e.speed += (v - e.speed) * Math.min(1, dt * 6);
    if (e.flags & MF_MOVING) e.walkT += dt;
  }
  for (const e of S.arrows.values()) sample(e, rt);

  pingTimer -= dt;
  if (pingTimer <= 0) {
    pingTimer = 2;
    send(['p', Math.round(performance.now())]);
  }
}

function frame(t) {
  const dt = Math.min(0.05, Math.max(0, (t - lastFrame) / 1000));
  lastFrame = t;
  S.now = t;
  S.time = t / 1000;
  if ((S.phase === 'playing' || S.phase === 'reconnecting') && S.me) {
    if (S.phase === 'playing') update(dt);
    updateFx(dt);
    render(dt);
    ui.updateHud(dt);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// actions (from keys and from the HUD)
// ---------------------------------------------------------------------------
const playing = () => S.phase === 'playing' && !!S.me;

function select(i) {
  const me = S.me;
  if (!playing() || i === me.sel) return;
  me.sel = i;
  me.useT = Math.max(me.useT, S.now - 250); // tiny delay before the new item can be used
  updateHeld();
  send(['sel', i]);
  ui.refreshInventory();
  play('click');
}

function toggleSound() {
  setMuted(!S.muted);
  ui.setSoundButton();
  if (!S.muted) play('click');
}

ui.initUI({
  select,
  craft(i, times) {
    if (!playing() || !S.me.alive) return;
    for (let n = 0; n < times; n++) send(['c', i]);
  },
  drop(slot, all) {
    if (playing() && S.me.alive && S.me.inv[slot]) send(['d', slot, !!all]);
  },
  swap(a, b) {
    if (playing()) send(['sw', a, b]);
  },
  respawn() {
    if (playing() && !S.me.alive) send(['r']);
  },
  toggleSound,
});

initInput({
  isPlaying: () => playing() && !ui.helpIsOpen(),
  select,
  cycle(dir) {
    if (playing()) select((S.me.sel + dir + 8) % 8);
  },
  interact() {
    if (playing() && S.me.alive) send(['e']);
  },
  dropSelected(all) {
    if (playing() && S.me.alive && S.me.inv[S.me.sel]) send(['d', S.me.sel, !!all]);
  },
  chatOpen() {
    if (!playing()) return;
    releaseAll();
    ui.setChatOpen(true);
  },
  chatSend(text) {
    const msg = text.trim();
    if (msg && playing()) send(['chat', msg]);
    ui.setChatOpen(false);
  },
  chatClose() {
    ui.setChatOpen(false);
  },
  help() {
    ui.showHelp(!ui.helpIsOpen());
  },
  sound: toggleSound,
  respawn() {
    if (playing() && !S.me.alive) send(['r']);
  },
  escape() {
    ui.hideTooltip();
  },
});

// "H" and "Escape" must also work while the help screen is open
window.addEventListener('keydown', (e) => {
  if (!ui.helpIsOpen()) return;
  if (e.code === 'Escape' || e.code === 'KeyH' || e.code === 'Enter') {
    e.preventDefault();
    e.stopImmediatePropagation();
    ui.showHelp(false);
  }
}, true);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
initRenderer(document.getElementById('game'));
ui.initJoin(onPlay);
requestAnimationFrame(frame);

loadImages(ui.setLoading).then(
  async () => {
    spritesReady();
    S.phase = 'menu';
    let text = '';
    try {
      const res = await fetch(new URL('api/status', location.href), { cache: 'no-store' });
      const st = await res.json();
      text = `${st.players} survivor${st.players === 1 ? '' : 's'} in the forest · day ${st.day}`;
    } catch {
      /* the status line is optional */
    }
    ui.setJoinState('ready', text);
    // ?autojoin=Name starts right away (used by automated tests)
    const auto = new URLSearchParams(location.search).get('autojoin');
    if (auto) onPlay(auto, Number(new URLSearchParams(location.search).get('skin') || 0));
  },
  (err) => {
    console.error(err);
    ui.setJoinState('error', 'Could not load the game files. Please reload the page.');
    document.getElementById('play').disabled = true;
  },
);
