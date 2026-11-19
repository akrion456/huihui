// Draws one frame of the game onto the canvas.
import {
  OBJECTS, MOBS, ITEMS, PLAYER_R, VIEW_W, VIEW_H, nightAmount, PF_ARMOR, PF_SHIELD, MF_LEFT, MF_MOVING, MF_ANGRY,
} from '../shared/defs.js';
import { S } from './state.js';
import { sprites, prepareSprites, aspect, OBJ_SPRITES, MOB_SPRITES, HELD, PLAYER_SPRITE as PS, silhouette, itemIcon } from './assets.js';
import { drawParticles, drawTexts, burst } from './fx.js';

let canvas;
let ctx;
let dpr = 1;
let lightCv;
let lightCtx;
let holeSprite;
let glowSprite;
let prepTimer = 0;
let loaded = false;
const sorted = [];

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';

export function initRenderer(el) {
  canvas = el;
  ctx = canvas.getContext('2d', { alpha: false });
  lightCv = document.createElement('canvas');
  lightCtx = lightCv.getContext('2d');
  holeSprite = radialSprite(256, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.86)'], [0.75, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]);
  glowSprite = radialSprite(256, [[0, 'rgba(255,170,70,0.55)'], [0.4, 'rgba(255,140,50,0.22)'], [1, 'rgba(255,120,40,0)']]);
  resize();
  window.addEventListener('resize', resize);
}

function radialSprite(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  lightCv.width = Math.ceil(w / 2);
  lightCv.height = Math.ceil(h / 2);
  const cam = S.cam;
  // never show more of the world than VIEW_W x VIEW_H (fair for every screen)
  cam.scale = Math.max(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H, 0.62);
  cam.w = window.innerWidth / cam.scale;
  cam.h = window.innerHeight / cam.scale;
  // scale the pictures to the new size once the window stops changing
  clearTimeout(prepTimer);
  prepTimer = setTimeout(() => {
    if (loaded) prepareSprites(cam.scale * dpr);
  }, 180);
}

/** Call once all pictures are loaded. */
export function spritesReady() {
  loaded = true;
  prepareSprites(S.cam.scale * dpr);
}

/** Converts a mouse position (CSS px) to world coordinates. */
export function screenToWorld(sx, sy) {
  const cam = S.cam;
  return { x: cam.left + sx / cam.scale, y: cam.top + sy / cam.scale };
}

function updateCamera(dt) {
  const cam = S.cam;
  const me = S.me;
  const w = S.world;
  if (me) {
    cam.x = me.x;
    cam.y = me.y - 24;
  }
  let left = cam.x - cam.w / 2;
  let top = cam.y - cam.h / 2;
  if (w) {
    left = w.pxW > cam.w ? clamp(left, 0, w.pxW - cam.w) : (w.pxW - cam.w) / 2;
    top = w.pxH > cam.h ? clamp(top, 0, w.pxH - cam.h) : (w.pxH - cam.h) / 2;
  }
  if (cam.shake > 0.1) {
    left += (Math.random() - 0.5) * cam.shake;
    top += (Math.random() - 0.5) * cam.shake;
    cam.shake *= Math.max(0, 1 - dt * 9);
  } else {
    cam.shake = 0;
  }
  cam.left = left;
  cam.top = top;
}

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------
export function render(dt) {
  updateCamera(dt);
  const cam = S.cam;
  const k = cam.scale * dpr;
  const ox = -Math.round(cam.left * k);
  const oy = -Math.round(cam.top * k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!S.world || !S.terrain) {
    ctx.fillStyle = '#17301c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  S.terrain.draw(ctx, cam, k, ox, oy, S.time); // leaves the world transform set

  collect(dt);

  // shadows first, so that they never cover anything
  ctx.fillStyle = 'rgba(12, 28, 12, 0.2)';
  for (const d of sorted) {
    if (!d.sh) continue;
    ctx.beginPath();
    ctx.ellipse(d.x, d.y + d.sh[2], d.sh[0], d.sh[1], 0, 0, TAU);
    ctx.fill();
  }

  drawGroundMarks();

  for (const d of sorted) d.draw(d.ref, d);

  for (const a of S.arrows.values()) drawArrow(a);
  drawParticles(ctx, cam);
  drawNight(k, ox, oy);

  ctx.setTransform(k, 0, 0, k, ox, oy);
  drawOverlays();
  drawTexts(ctx, sprites);
  if (S.debug) drawDebug();
}

// ---------------------------------------------------------------------------
// what is on screen?
// ---------------------------------------------------------------------------
function collect(dt) {
  sorted.length = 0;
  const cam = S.cam;
  const me = S.me;
  const l = cam.left - 100;
  const r = cam.left + cam.w + 100;
  const t = cam.top - 40;
  const b = cam.top + cam.h + 230;

  // spots that should not be hidden behind a tree top
  const focus = [];
  if (me && me.alive) focus.push(me);
  if (S.ghost) focus.push(S.ghost);
  for (const m of S.mobs.values()) if (m.flags & MF_ANGRY) focus.push(m);

  S.world.grid.queryRect(l - 128, t - 128, r + 128, b + 128, (o) => {
    if (o.x < l || o.x > r || o.y < t || o.y > b) return;
    const def = OBJECTS[o.type];
    let spr = OBJ_SPRITES[o.type];
    if (o.state === 1) {
      if (def.kind === 'tree') spr = OBJ_SPRITES.stump;
      else if (def.kind === 'bush') spr = OBJ_SPRITES.bush_empty;
    }
    if (spr.tall) {
      let target = 1;
      for (const f of focus) {
        if (f.y < o.y + 6 && f.y > o.y - spr.h * 0.9 && Math.abs(f.x - o.x) < spr.w * 0.44) {
          target = 0.36;
          break;
        }
      }
      o.alpha = o.alpha === undefined ? target : o.alpha + (target - o.alpha) * Math.min(1, dt * 9);
    }
    sorted.push({ y: o.y, x: o.x, sh: spr.sh, ref: o, spr, draw: drawObject });
    if (def.fire && o.state === 1) fireParticles(o, def, dt);
  });

  for (const d of S.drops.values()) {
    if (d.x < l || d.x > r || d.y < t || d.y > b) continue;
    sorted.push({ y: d.y - 2, x: d.x, sh: [9, 3.5, 4], ref: d, draw: drawDrop });
  }
  for (const m of S.mobs.values()) {
    if (m.x < l || m.x > r || m.y < t || m.y > b) continue;
    const rad = MOBS[m.type].r;
    sorted.push({ y: m.y + rad * 0.3, x: m.x, sh: [rad * 1.25, rad * 0.45, rad * 0.45], ref: m, draw: drawMob });
  }
  for (const p of S.others.values()) {
    if (p.x < l || p.x > r || p.y < t || p.y > b) continue;
    sorted.push({ y: p.y, x: p.x, sh: [15, 6, PS.footY - 1], ref: p, draw: drawPlayer });
  }
  if (me && me.alive) sorted.push({ y: me.y, x: me.x, sh: [15, 6, PS.footY - 1], ref: me, draw: drawPlayer });
  sorted.sort((a, c) => a.y - c.y);
}

function fireParticles(o, def, dt) {
  const big = o.type === 'bonfire' ? 1.7 : 1;
  const fuel = def.maxFuel ? clamp((o.fuelPct ?? 100) / 100, 0, 1) : 1;
  if (Math.random() < dt * (3 + fuel * 5) * big) burst('spark', o.x + (Math.random() - 0.5) * 16 * big, o.y - 4, 22 * big + Math.random() * 20);
  if (Math.random() < dt * 2.2 * big) burst('smoke', o.x + (Math.random() - 0.5) * 10, o.y - 6, 46 * big + fuel * 20);
}

// ---------------------------------------------------------------------------
// ground level marks: build preview, interaction ring
// ---------------------------------------------------------------------------
function drawGroundMarks() {
  const g = S.ghost;
  if (g) {
    const def = OBJECTS[g.type];
    ctx.lineWidth = 2;
    ctx.strokeStyle = g.ok ? 'rgba(160, 255, 150, 0.9)' : 'rgba(255, 110, 100, 0.9)';
    ctx.fillStyle = g.ok ? 'rgba(120, 255, 120, 0.2)' : 'rgba(255, 80, 70, 0.22)';
    ctx.beginPath();
    ctx.arc(g.x, g.y, def.r, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }
  const h = S.hint;
  if (h && h.obj) {
    const pulse = 0.5 + 0.5 * Math.sin(S.time * 5);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(255, 236, 150, ${0.45 + pulse * 0.4})`;
    ctx.beginPath();
    ctx.ellipse(h.obj.x, h.obj.y + 4, h.obj.r + 12 + pulse * 2, (h.obj.r + 12 + pulse * 2) * 0.55, 0, 0, TAU);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// world objects
// ---------------------------------------------------------------------------
function drawObject(o, d) {
  const spr = d.spr;
  const def = OBJECTS[o.type];
  const now = S.now;
  let rot = 0;
  let sx = 1;
  let sy = 1;
  let dx = 0;
  const since = now - (o.shakeT ?? -1e9);
  if (since < 280) {
    const f = 1 - since / 280;
    const wave = Math.sin(since * 0.05) * f;
    if (spr.tall) rot = wave * 0.045;
    else if (def.kind === 'bush') {
      sx = 1 + wave * 0.07;
      sy = 1 - wave * 0.07;
    } else dx = wave * 2.6;
  }
  const age = now - (o.bornT ?? -1e9);
  if (age < 320) {
    // pop in (something was built or has grown back)
    const u = age / 320;
    const e = 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2);
    sx *= e;
    sy *= e;
  }
  const alpha = spr.tall ? o.alpha ?? 1 : 1;
  const img = sprites[spr.img];
  const plain = rot === 0 && sx === 1 && sy === 1;
  if (alpha < 1) ctx.globalAlpha = alpha;
  if (plain) {
    ctx.drawImage(img, o.x - spr.ax + dx, o.y - spr.ay, spr.w, spr.h);
  } else {
    ctx.save();
    ctx.translate(o.x, o.y + 6);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.drawImage(img, -spr.ax, -spr.ay - 6, spr.w, spr.h);
    ctx.restore();
  }
  if (alpha < 1) ctx.globalAlpha = 1;

  if (def.fire && o.state === 1) drawFlame(o, spr, def);
  if (def.fire && o.state === 0) {
    // burnt out: a little cold smoke only
    if (Math.random() < 0.01) burst('smoke', o.x, o.y - 6, 20, 1);
  }
}

function drawFlame(o, spr, def) {
  const t = S.time;
  const ph = o.id * 1.7;
  const fuel = def.maxFuel ? clamp((o.fuelPct ?? 100) / 100, 0, 1) : 1;
  const size = (def.maxFuel ? 0.55 + 0.45 * Math.sqrt(fuel) : 1) * (1 + 0.03 * Math.sin(t * 5 + ph));
  const fy = 1 + 0.07 * Math.sin(t * 11 + ph) + 0.04 * Math.sin(t * 23 + ph * 2);
  const fx = 1 - 0.05 * Math.sin(t * 11 + ph) + 0.03 * Math.sin(t * 17 + ph);
  const img = sprites.campfire_flame;
  // the flame grows out of the middle of the stone ring
  const baseY = spr.h * (143 / 197) - spr.ay;
  ctx.save();
  ctx.translate(o.x, o.y + baseY);
  ctx.scale(size * fx, size * fy);
  ctx.drawImage(img, -spr.ax, -baseY - spr.ay, spr.w, spr.h);
  ctx.restore();
}

function drawDrop(d) {
  const icon = itemIcon(d.item);
  const age = (S.now - d.bornT) / 1000;
  const pop = age < 0.25 ? 0.4 + (age / 0.25) * 0.6 : 1;
  const bob = Math.sin(S.time * 3 + d.id) * 2.5;
  const big = ITEMS[d.item].kind === 'build' ? 34 : 28;
  const w = big * pop;
  const h = w * aspect(icon);
  const hh = Math.min(h, 36);
  const ww = (w * hh) / h;
  ctx.drawImage(sprites[icon], d.x - ww / 2, d.y - hh + 6 + bob, ww, hh);
  if (d.n > 1) {
    ctx.font = `800 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(20,16,12,0.85)';
    ctx.strokeText(d.n, d.x + 8, d.y + 4);
    ctx.fillStyle = '#fff';
    ctx.fillText(d.n, d.x + 8, d.y + 4);
  }
}

function drawArrow(a) {
  const img = sprites.arrow_proj;
  ctx.fillStyle = 'rgba(12, 28, 12, 0.2)';
  ctx.beginPath();
  ctx.ellipse(a.x, a.y + 4, 12, 3, a.ang, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.translate(a.x, a.y - 16);
  ctx.rotate(a.ang);
  ctx.drawImage(img, -30, -5.5, 40, 11);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// animals
// ---------------------------------------------------------------------------
function drawMob(m) {
  const def = MOBS[m.type];
  const spr = MOB_SPRITES[m.type];
  const now = S.now;
  const moving = (m.flags & MF_MOVING) !== 0;
  const rate = clamp((m.speed || 60) / 20, 3.5, 10);
  const frame = moving ? Math.floor(m.walkT * rate) & 1 : 0;
  const dir = m.flags & MF_LEFT ? -1 : 1;
  let hop = moving ? Math.abs(Math.sin(m.walkT * rate * Math.PI)) * (m.type === 'rabbit' ? 6 : 2) : 0;
  let lunge = 0;
  const atk = now - (m.atkT ?? -1e9);
  if (atk < 220) {
    lunge = Math.sin((atk / 220) * Math.PI) * 10;
    hop += Math.sin((atk / 220) * Math.PI) * 4;
  }
  const name = `${m.type}_${frame}`;
  const img = sprites[name];
  const footY = def.r * 0.45;
  ctx.save();
  ctx.translate(m.x, m.y + footY - hop);
  ctx.scale(dir, 1);
  ctx.drawImage(img, -spr.w / 2 + lunge, -spr.feet, spr.w, spr.h);
  const hurt = now - (m.hurtT ?? -1e9);
  if (hurt < 170) {
    ctx.globalAlpha = 0.75 * (1 - hurt / 170);
    ctx.drawImage(silhouette(name), -spr.w / 2 + lunge, -spr.feet, spr.w, spr.h);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// players
// ---------------------------------------------------------------------------
function drawPlayer(p) {
  const now = S.now;
  const dir = Math.cos(p.aim) < 0 ? -1 : 1;
  // aim inside the mirrored drawing space (the picture always "faces right")
  const la = Math.atan2(Math.sin(p.aim), Math.abs(Math.cos(p.aim)));
  const frame = p.moving ? 1 + (Math.floor(p.walkT * 8.5) & 1) : 0;
  const bob = p.moving ? Math.abs(Math.sin(p.walkT * 8.5 * Math.PI)) * 2.2 : 0;
  const name = `p${p.skin + 1}_${frame}`;
  const img = sprites[name];
  const useAge = (now - (p.useT ?? -1e9)) / 1000;
  const lunge = useAge < 0.2 ? Math.sin((useAge / 0.2) * Math.PI) * 3.5 : 0;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(dir, 1);
  ctx.translate(Math.cos(la) * lunge, Math.sin(la) * lunge * 0.6 - bob);
  const bx = -33;
  const by = PS.footY - PS.feet;
  ctx.drawImage(img, bx, by, PS.w, PS.h);
  if (p.flags & PF_ARMOR) ctx.drawImage(sprites.armor, -14.5, -33.5, 31, 31);
  const hurt = now - (p.hurtT ?? -1e9);
  if (hurt < 200) {
    ctx.globalAlpha = 0.7 * (1 - hurt / 200);
    ctx.drawImage(silhouette(name, '#ff5a4f'), bx, by, PS.w, PS.h);
    ctx.globalAlpha = 1;
  }
  drawHeld(p, la, useAge);
  ctx.restore();

  if (p.flags & PF_SHIELD) {
    // fresh spawn protection
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.35 + 0.25 * Math.sin(S.time * 6)})`;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - 26, 30, 44, 0, 0, TAU);
    ctx.stroke();
  }
}

function drawHeld(p, la, useAge) {
  const id = p.held;
  let hx = 9;
  let hy = -15;
  if (!id) {
    // bare hands: a quick punch
    if (useAge < 0.22) {
      const e = Math.sin((useAge / 0.22) * Math.PI) * 19;
      ctx.fillStyle = '#f2c79a';
      ctx.strokeStyle = '#1f1712';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(hx + Math.cos(la) * e, hy + Math.sin(la) * e, 5.5, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
    return;
  }
  const h = HELD[id];
  if (!h) {
    // food, materials, things to build: simply carried in the hand
    const icon = itemIcon(id);
    let x = hx + 4;
    let y = hy;
    if (useAge < 0.3 && ITEMS[id].kind === 'food') {
      const e = Math.sin((useAge / 0.3) * Math.PI);
      x = lerp(x, 12, e);
      y = lerp(y, -34, e);
    }
    const hh = Math.min(26, 22 * aspect(icon));
    const ww = hh / aspect(icon);
    ctx.drawImage(sprites[icon], x - ww / 2, y - hh / 2, ww, hh);
    return;
  }

  let ang = la;
  let push = 0;
  if (h.style === 'swing' || h.style === 'torch') {
    const rest = h.style === 'torch' ? -1.2 : la - 0.95;
    if (useAge < 0.22) {
      const u = useAge / 0.22;
      ang = la - 1.05 + (1 - (1 - u) * (1 - u)) * 1.95;
    } else if (useAge < 0.38) {
      ang = lerp(la + 0.9, rest, (useAge - 0.22) / 0.16);
    } else {
      ang = rest;
    }
  } else if (h.style === 'thrust') {
    hx = 3;
    hy = -17;
    if (useAge < 0.26) push = Math.sin((useAge / 0.26) * Math.PI) * 20;
  } else if (h.style === 'bow') {
    hx = 4 + Math.cos(la) * 11;
    hy = -18 + Math.sin(la) * 11;
    if (useAge < 0.2) push = -Math.sin((useAge / 0.2) * Math.PI) * 4;
  }
  const k = h.size / 48;
  const px = hx + Math.cos(ang) * push;
  const py = hy + Math.sin(ang) * push;
  const rot = ang - h.ang;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(rot);
  ctx.drawImage(sprites[h.img], -h.gx * k, -h.gy * k, h.size, h.size);
  ctx.restore();
  if (h.tip) {
    // the flame of a torch always burns upwards
    const tx = (h.tip[0] - h.gx) * k;
    const ty = (h.tip[1] - h.gy) * k;
    const fx = px + tx * Math.cos(rot) - ty * Math.sin(rot);
    const fy = py + tx * Math.sin(rot) + ty * Math.cos(rot);
    const s = 1 + 0.1 * Math.sin(S.time * 14 + p.id);
    ctx.drawImage(sprites.flame, fx - 9 * s, fy - 21 * s, 18 * s, 23.5 * s);
  }
}

// ---------------------------------------------------------------------------
// night
// ---------------------------------------------------------------------------
function drawNight(k, ox, oy) {
  const night = nightAmount(S.tod);
  const t = S.time;
  // warm glow around fires (stronger in the dark)
  ctx.globalCompositeOperation = 'lighter';
  for (const o of S.fires) {
    if (!o.state) continue;
    const def = OBJECTS[o.type];
    const R = def.light * 0.62 * (1 + 0.04 * Math.sin(t * 9 + o.id));
    ctx.globalAlpha = 0.16 + night * 0.34;
    ctx.drawImage(glowSprite, o.x - R, o.y - 14 - R, R * 2, R * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (night < 0.004) return;

  const g = lightCtx;
  const w = lightCv.width;
  const h = lightCv.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.clearRect(0, 0, w, h);
  // dusk is purple, deep night is dark blue
  const cr = Math.round(lerp(58, 5, night));
  const cg = Math.round(lerp(30, 9, night));
  const cb = Math.round(lerp(66, 34, night));
  g.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.9 * night})`;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-out';
  const s = k / 2;
  g.setTransform(s, 0, 0, s, ox / 2, oy / 2);
  const hole = (x, y, R, strength) => {
    g.globalAlpha = strength;
    g.drawImage(holeSprite, x - R, y - R, R * 2, R * 2);
  };
  for (const o of S.fires) {
    if (!o.state) continue;
    const def = OBJECTS[o.type];
    const fuel = def.maxFuel ? clamp((o.fuelPct ?? 100) / 100, 0, 1) : 1;
    const R = def.light * (def.maxFuel ? 0.62 + 0.38 * Math.sqrt(fuel) : 1) * (1 + 0.025 * Math.sin(t * 9 + o.id) + 0.015 * Math.sin(t * 23 + o.id));
    hole(o.x, o.y - 14, R, 1);
  }
  const torch = ITEMS.torch.light;
  const me = S.me;
  if (me && me.alive) {
    if (me.held === 'torch') hole(me.x, me.y - 22, torch * (1 + 0.03 * Math.sin(t * 12)), 1);
    else hole(me.x, me.y - 22, 105, 0.6); // your eyes get used to the dark a little
  }
  for (const p of S.others.values()) {
    if (p.held === 'torch') hole(p.x, p.y - 22, torch * (1 + 0.03 * Math.sin(t * 12 + p.id)), 1);
  }
  g.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(lightCv, 0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// names, health bars, speech bubbles (always readable, even at night)
// ---------------------------------------------------------------------------
function bar(x, y, w, h, frac, color) {
  ctx.fillStyle = 'rgba(20, 16, 12, 0.8)';
  ctx.fillRect(x - w / 2 - 1.5, y - 1.5, w + 3, h + 3);
  ctx.fillStyle = color;
  ctx.fillRect(x - w / 2, y, w * clamp(frac, 0, 1), h);
}

function label(text, x, y, color, size = 12.5) {
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(20, 16, 12, 0.8)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawOverlays() {
  const now = S.now;
  const me = S.me;
  const cam = S.cam;
  const inView = (x, y) => x > cam.left - 60 && x < cam.left + cam.w + 60 && y > cam.top - 20 && y < cam.top + cam.h + 120;

  // animals: health + "!" when they start to attack
  for (const m of S.mobs.values()) {
    if (!inView(m.x, m.y)) continue;
    const spr = MOB_SPRITES[m.type];
    const top = m.y + MOBS[m.type].r * 0.45 - spr.feet - 8;
    if (m.hp < 100) bar(m.x, top, 34, 4, m.hp / 100, '#e5484d');
    const since = now - (m.angryT ?? -1e9);
    if (since < 900) {
      const pop = Math.min(1, since / 120);
      ctx.globalAlpha = since > 650 ? 1 - (since - 650) / 250 : 1;
      label('!', m.x, top - 12 - pop * 4, '#ff5148', 22);
      ctx.globalAlpha = 1;
    }
  }

  // buildings: damage and fuel
  if (me) {
    S.world.grid.queryRect(me.x - 330, me.y - 300, me.x + 330, me.y + 300, (o) => {
      const def = OBJECTS[o.type];
      if (def.kind !== 'build') return;
      const spr = OBJ_SPRITES[o.type];
      let y = o.y - spr.ay - 8;
      if ((o.hpPct ?? 100) < 100) {
        bar(o.x, y, 32, 4, o.hpPct / 100, '#9bd13f');
        y -= 8;
      }
      if (def.maxFuel && Math.hypot(o.x - me.x, o.y - me.y) < 230) {
        const f = (o.fuelPct ?? 0) / 100;
        bar(o.x, y, 32, 4, f, f < 0.25 ? '#ff5148' : '#ffb347');
      }
    });
  }

  const drawTag = (p, self) => {
    if (!inView(p.x, p.y)) return;
    const info = S.roster.get(p.id);
    let y = p.y - 78;
    if (!self && p.hp < 100) {
      bar(p.x, y, 36, 4, p.hp / 100, '#e5484d');
      y -= 10;
    }
    if (info) label(info.name, p.x, y, self ? '#fff3c4' : '#ffffff');
    const bub = S.bubbles.get(p.id);
    if (bub) {
      const left = bub.until - now;
      if (left <= 0) {
        S.bubbles.delete(p.id);
      } else {
        ctx.globalAlpha = Math.min(1, left / 400);
        bubble(bub.text, p.x, y - 14);
        ctx.globalAlpha = 1;
      }
    }
  };
  for (const p of S.others.values()) drawTag(p, false);
  if (me && me.alive) drawTag(me, true);

  // build preview picture
  const g = S.ghost;
  if (g) {
    const spr = OBJ_SPRITES[g.type];
    ctx.globalAlpha = 0.6;
    ctx.drawImage(sprites[spr.img === 'campfire_base' ? 'campfire' : spr.img], g.x - spr.ax, g.y - spr.ay, spr.w, spr.h);
    ctx.globalAlpha = 1;
  }
}

function bubble(text, x, y) {
  ctx.font = `600 12.5px ${FONT}`;
  const maxW = 190;
  // wrap into at most 3 lines
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
      if (lines.length === 3) break;
    } else {
      line = test;
    }
  }
  if (lines.length < 3 && line) lines.push(line);
  else if (lines.length === 3 && line) lines[2] = `${lines[2].slice(0, -1)}…`;
  let w = 0;
  for (const ln of lines) w = Math.max(w, Math.min(maxW + 20, ctx.measureText(ln).width));
  const lh = 15;
  const bw = w + 16;
  const bh = lines.length * lh + 9;
  const bx = x - bw / 2;
  const by = y - bh;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.strokeStyle = 'rgba(20, 16, 12, 0.85)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  roundRect(bx, by, bw, bh, 8);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 5, by + bh - 0.5);
  ctx.lineTo(x, by + bh + 6);
  ctx.lineTo(x + 5, by + bh - 0.5);
  ctx.fill();
  ctx.fillStyle = '#1f1712';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((ln, i) => ctx.fillText(ln, x, by + 5 + lh / 2 + i * lh, maxW + 20));
}

function roundRect(x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawDebug() {
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,0,0,0.8)';
  for (const d of sorted) {
    const o = d.ref;
    const r = o.r ?? (o.type && MOBS[o.type] ? MOBS[o.type].r : PLAYER_R);
    ctx.beginPath();
    ctx.arc(o.x, o.y, r, 0, TAU);
    ctx.stroke();
  }
}
