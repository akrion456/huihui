// Procedural forest island: terrain tiles + trees, rocks and berry bushes.
import { TILE, T_WATER, T_SAND, T_GRASS, T_FOREST, T_DIRT, OBJECTS } from '../shared/defs.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value noise in 0..1 */
function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const SIZE = 256;
  const lattice = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const at = (x, y) => lattice[((y & 255) << 8) | (x & 255)];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function fbm(noise, x, y, octaves) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x, y) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / norm;
}

/**
 * @returns {{w:number,h:number,tiles:Uint8Array,objects:Array,spawn:{x:number,y:number},seed:number}}
 */
export function generateWorld(seed, W, H) {
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const nElev = makeNoise(seed * 7 + 1);
  const nMoist = makeNoise(seed * 7 + 2);
  const nRock = makeNoise(seed * 7 + 3);
  const nLake = makeNoise(seed * 7 + 4);
  const tiles = new Uint8Array(W * H);
  const cx = W / 2;
  const cy = H / 2;
  const idx = (x, y) => y * W + x;

  // --- land / water
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) / (W / 2);
      const dy = (y + 0.5 - cy) / (H / 2);
      const d = Math.hypot(dx, dy);
      const elev = 1 - d * d + (fbm(nElev, x * 0.05, y * 0.05, 4) - 0.5) * 0.9;
      const dc = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let t;
      if (elev < 0.2 || x < 3 || y < 3 || x >= W - 3 || y >= H - 3) {
        t = T_WATER;
      } else if (dc > 11 && elev > 0.36 && fbm(nLake, x * 0.075 + 40, y * 0.075 + 40, 3) > 0.685) {
        t = T_WATER; // inland lake
      } else {
        const rock = fbm(nRock, x * 0.085 + 90, y * 0.085, 3);
        const moist = fbm(nMoist, x * 0.06, y * 0.06, 4);
        t = rock > 0.635 ? T_DIRT : moist > 0.47 ? T_FOREST : T_GRASS;
      }
      tiles[idx(x, y)] = t;
    }
  }

  // --- clearing around the spawn point
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dc = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (dc < 6.5 + (fbm(nElev, x * 0.3, y * 0.3, 2) - 0.5) * 3) tiles[idx(x, y)] = T_GRASS;
    }
  }

  // --- keep only land that is connected to the spawn (no unreachable islets)
  const reach = new Uint8Array(W * H);
  const stack = [idx(Math.floor(cx), Math.floor(cy))];
  reach[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const y = (i - x) / W;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = idx(nx, ny);
      if (reach[j] || tiles[j] === T_WATER) continue;
      reach[j] = 1;
      stack.push(j);
    }
  }
  for (let i = 0; i < tiles.length; i++) if (!reach[i]) tiles[i] = T_WATER;

  // --- beaches: any land tile that touches water
  const isWater = (x, y) => x < 0 || y < 0 || x >= W || y >= H || tiles[idx(x, y)] === T_WATER;
  const sand = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (tiles[idx(x, y)] === T_WATER) continue;
      let near = false;
      for (let oy = -1; oy <= 1 && !near; oy++) for (let ox = -1; ox <= 1; ox++) if (isWater(x + ox, y + oy)) { near = true; break; }
      if (near) sand.push(idx(x, y));
    }
  }
  for (const i of sand) tiles[i] = T_SAND;

  // --- scatter trees, rocks and bushes
  const objects = [];
  const cell = 96;
  const buckets = new Map();
  const bkey = (x, y) => Math.floor(x / cell) * 1000 + Math.floor(y / cell);
  const GAP = 38; // free space between two solid things: a player always fits through
  const fits = (x, y, r) => {
    const bx = Math.floor(x / cell);
    const by = Math.floor(y / cell);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const arr = buckets.get((bx + ox) * 1000 + (by + oy));
        if (!arr) continue;
        for (const o of arr) {
          const min = o.r + r + GAP;
          if ((o.x - x) ** 2 + (o.y - y) ** 2 < min * min) return false;
        }
      }
    }
    return true;
  };
  const place = (type, x, y) => {
    const r = OBJECTS[type].r;
    if (!fits(x, y, r)) return false;
    const o = { type, x: Math.round(x), y: Math.round(y), r };
    objects.push(o);
    const k = bkey(x, y);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(o);
    return true;
  };

  const spawn = { x: cx * TILE, y: cy * TILE };
  place('bonfire', spawn.x, spawn.y);

  // a few guaranteed berry bushes and rocks close to the spawn
  const ring = (type, count, r0, r1) => {
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < count; tries++) {
      const a = rnd() * Math.PI * 2;
      const d = (r0 + rnd() * (r1 - r0)) * TILE;
      const x = spawn.x + Math.cos(a) * d;
      const y = spawn.y + Math.sin(a) * d;
      const t = tiles[idx(Math.floor(x / TILE), Math.floor(y / TILE))];
      if (t === T_WATER || t === T_SAND) continue;
      if (place(type, x, y)) placed++;
    }
  };
  ring('bush', 5, 4.5, 9);
  ring('rock', 4, 4.8, 9);
  ring('tree_oak', 5, 4.6, 6.5);
  ring('tree_pine', 3, 4.6, 6.5);

  const order = [];
  for (let i = 0; i < W * H; i++) order.push(i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const i of order) {
    const t = tiles[i];
    if (t === T_WATER || t === T_SAND) continue;
    const tx = i % W;
    const ty = (i - tx) / W;
    const dc = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
    if (dc < 4.5) continue; // keep the camp site open
    const x = (tx + 0.5) * TILE + (rnd() - 0.5) * 44;
    const y = (ty + 0.5) * TILE + (rnd() - 0.5) * 44;
    const roll = rnd();
    if (t === T_FOREST) {
      if (roll < 0.4) place(rnd() < 0.62 ? 'tree_pine' : 'tree_oak', x, y);
      else if (roll < 0.435) place('bush', x, y);
      else if (roll < 0.45) place('rock', x, y);
    } else if (t === T_GRASS) {
      if (roll < 0.075) place(rnd() < 0.3 ? 'tree_pine' : 'tree_oak', x, y);
      else if (roll < 0.115) place('bush', x, y);
      else if (roll < 0.128) place('rock', x, y);
    } else if (t === T_DIRT) {
      if (roll < 0.24) place('rock', x, y);
      else if (roll < 0.31) place('tree_pine', x, y);
      else if (roll < 0.32) place('bush', x, y);
    }
  }

  return { w: W, h: H, tiles, objects, spawn, seed };
}

/** Debug helper: `node public/sim/worldgen.js [seed]` prints the map. */
if (typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] || 12345);
  const w = generateWorld(seed, 100, 100);
  const chars = ['~', '.', ',', '#', ':'];
  const grid = Array.from({ length: w.h }, (_, y) => Array.from({ length: w.w }, (_, x) => chars[w.tiles[y * w.w + x]]));
  for (const o of w.objects) {
    const tx = Math.floor(o.x / TILE);
    const ty = Math.floor(o.y / TILE);
    grid[ty][tx] = o.type.startsWith('tree') ? 'T' : o.type === 'rock' ? 'o' : o.type === 'bush' ? 'b' : '@';
  }
  console.log(grid.map((r) => r.join('')).join('\n'));
  const count = {};
  for (const t of w.tiles) count[chars[t]] = (count[chars[t]] || 0) + 1;
  const oc = {};
  for (const o of w.objects) oc[o.type] = (oc[o.type] || 0) + 1;
  console.log('tiles', count, 'objects', oc, 'total', w.objects.length);
}
