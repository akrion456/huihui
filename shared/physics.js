// World container + collision code. The exact same code runs on the server
// (animals, validation) and in the browser (the local player moves instantly
// on the client and the server only double-checks).
import { TILE, T_WATER, GRID, PLACE_RANGE, SPAWN_SAFE_RADIUS, OBJECTS } from './defs.js';

export class SpatialGrid {
  constructor(cell = 128) {
    this.cell = cell;
    this.cells = new Map();
    this.maxR = 0;
  }

  _key(cx, cy) {
    return (cx + 1024) * 4096 + (cy + 1024);
  }

  insert(o) {
    const k = this._key(Math.floor(o.x / this.cell), Math.floor(o.y / this.cell));
    let arr = this.cells.get(k);
    if (!arr) this.cells.set(k, (arr = []));
    arr.push(o);
    if (o.r > this.maxR) this.maxR = o.r;
  }

  remove(o) {
    const k = this._key(Math.floor(o.x / this.cell), Math.floor(o.y / this.cell));
    const arr = this.cells.get(k);
    if (!arr) return;
    const i = arr.indexOf(o);
    if (i >= 0) {
      arr[i] = arr[arr.length - 1];
      arr.pop();
    }
    if (!arr.length) this.cells.delete(k);
  }

  /** Calls fn(o) for every object that may touch the circle (x, y, r). */
  query(x, y, r, fn) {
    const c = this.cell;
    const pad = r + this.maxR;
    const x0 = Math.floor((x - pad) / c);
    const x1 = Math.floor((x + pad) / c);
    const y0 = Math.floor((y - pad) / c);
    const y1 = Math.floor((y + pad) / c);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const arr = this.cells.get(this._key(cx, cy));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) fn(arr[i]);
      }
    }
  }

  /** Calls fn(o) for every object whose centre lies inside the rectangle (+pad). */
  queryRect(x0, y0, x1, y1, fn) {
    const c = this.cell;
    const cx0 = Math.floor(x0 / c);
    const cx1 = Math.floor(x1 / c);
    const cy0 = Math.floor(y0 / c);
    const cy1 = Math.floor(y1 / c);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const arr = this.cells.get(this._key(cx, cy));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) fn(arr[i]);
      }
    }
  }
}

export class World {
  /**
   * @param {number} w      width in tiles
   * @param {number} h      height in tiles
   * @param {Uint8Array} tiles  terrain type per tile
   */
  constructor(w, h, tiles) {
    this.w = w;
    this.h = h;
    this.tiles = tiles;
    this.pxW = w * TILE;
    this.pxH = h * TILE;
    this.objects = new Map(); // id -> {id, type, x, y, r, state, ...}
    this.grid = new SpatialGrid(128);
  }

  tile(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return T_WATER;
    return this.tiles[ty * this.w + tx];
  }

  tileAt(x, y) {
    return this.tile(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  isWater(x, y) {
    return this.tileAt(x, y) === T_WATER;
  }

  addObject(o) {
    this.objects.set(o.id, o);
    this.grid.insert(o);
  }

  removeObject(id) {
    const o = this.objects.get(id);
    if (!o) return null;
    this.objects.delete(id);
    this.grid.remove(o);
    return o;
  }

  /**
   * Pushes the circle (p.x, p.y, r) out of blocking objects, water and the
   * world border. Mutates p, returns true if anything was touched.
   * @param {(o: object) => boolean} blocks  which objects are solid for this mover
   */
  collide(p, r, blocks) {
    let hit = false;
    for (let it = 0; it < 3; it++) {
      let moved = false;
      this.grid.query(p.x, p.y, r, (o) => {
        if (!blocks(o)) return;
        const dx = p.x - o.x;
        const dy = p.y - o.y;
        const min = r + o.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) return;
        const d = Math.sqrt(d2);
        if (d < 1e-3) {
          p.x += min;
        } else {
          const k = (min - d) / d;
          p.x += dx * k;
          p.y += dy * k;
        }
        moved = true;
      });
      if (this._pushOutOfWater(p, r)) moved = true;
      if (!moved) break;
      hit = true;
    }
    if (p.x < r) p.x = r;
    else if (p.x > this.pxW - r) p.x = this.pxW - r;
    if (p.y < r) p.y = r;
    else if (p.y > this.pxH - r) p.y = this.pxH - r;
    return hit;
  }

  _pushOutOfWater(p, r) {
    let hit = false;
    const tx0 = Math.floor((p.x - r) / TILE);
    const tx1 = Math.floor((p.x + r) / TILE);
    const ty0 = Math.floor((p.y - r) / TILE);
    const ty1 = Math.floor((p.y + r) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (this.tile(tx, ty) !== T_WATER) continue;
        const rx = tx * TILE;
        const ry = ty * TILE;
        const cx = p.x < rx ? rx : p.x > rx + TILE ? rx + TILE : p.x;
        const cy = p.y < ry ? ry : p.y > ry + TILE ? ry + TILE : p.y;
        const dx = p.x - cx;
        const dy = p.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const k = (r - d) / d;
          p.x += dx * k;
          p.y += dy * k;
        } else {
          // centre is inside the water tile: leave through the closest dry side
          const opts = [
            [p.x - rx, -1, 0],
            [rx + TILE - p.x, 1, 0],
            [p.y - ry, 0, -1],
            [ry + TILE - p.y, 0, 1],
          ].sort((a, b) => a[0] - b[0]);
          const best = opts.find((o) => this.tile(tx + o[1], ty + o[2]) !== T_WATER) || opts[0];
          p.x += best[1] * (best[0] + r);
          p.y += best[2] * (best[0] + r);
        }
        hit = true;
      }
    }
    return hit;
  }
}

/** Smallest signed difference between two angles (radians). */
export function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Where does a building end up when a player standing at (px, py) points at
 * (tx, ty)? The target is kept within arm's reach and walls snap to a grid.
 */
export function placementSpot(px, py, tx, ty, type) {
  const def = OBJECTS[type];
  let dx = tx - px;
  let dy = ty - py;
  const d = Math.hypot(dx, dy);
  if (d > PLACE_RANGE) {
    dx *= PLACE_RANGE / d;
    dy *= PLACE_RANGE / d;
  }
  let x = px + dx;
  let y = py + dy;
  if (def.snap) {
    x = Math.floor(x / GRID) * GRID + GRID / 2;
    y = Math.floor(y / GRID) * GRID + GRID / 2;
  } else {
    x = Math.round(x);
    y = Math.round(y);
  }
  return { x, y };
}

/**
 * Terrain and object rules for building at (x, y). Returns an error text or
 * null. Used by the server (the judge) and by the client (ghost preview).
 */
export function placementError(world, spawn, type, x, y) {
  const def = OBJECTS[type];
  for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (world.isWater(x + ox * def.r * 0.8, y + oy * def.r * 0.8)) return "You can't build on water.";
  }
  const sx = x - spawn.x;
  const sy = y - spawn.y;
  if (sx * sx + sy * sy < SPAWN_SAFE_RADIUS * SPAWN_SAFE_RADIUS) return 'Too close to the Great Fire.';
  let blocked = false;
  world.grid.query(x, y, def.r, (o) => {
    const od = OBJECTS[o.type];
    const both = od.kind === 'build';
    const min = both && od.snap && def.snap ? GRID - 2 : (o.r + def.r) * (both ? 0.92 : 1);
    const dx = x - o.x;
    const dy = y - o.y;
    if (dx * dx + dy * dy < min * min) blocked = true;
  });
  return blocked ? 'Something is in the way.' : null;
}
