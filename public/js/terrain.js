// Ground rendering. The tile map is turned into soft, organic looking terrain:
// every chunk of 8x8 tiles is painted once into a small canvas (and cached),
// little plants and pebbles are scattered on top.
import { TILE, T_WATER, T_SAND, T_GRASS, T_FOREST, T_DIRT } from '../shared/defs.js';
import { images, sprites } from './assets.js';

const CH = 8; // tiles per chunk
const CH_PX = CH * TILE; // 512 world px
const SAMPLE = 2; // world px per painted sample
const N = CH_PX / SAMPLE; // samples per chunk side
const MAX_CHUNKS = 60;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  deep: hex('#2f7dbd'),
  mid: hex('#3c8ecd'),
  shallow: hex('#62b4e4'),
  foam: hex('#dff4fb'),
  sand: hex('#ead9a0'),
  sandWet: hex('#d9c489'),
  grassEdge: hex('#5f9a3b'),
  grass: hex('#7db851'),
  forest: hex('#5d9c40'),
  dirtEdge: hex('#84704a'),
  dirt: hex('#ab9466'),
};
export const TILE_COLORS = ['#3c8ecd', '#ead9a0', '#7db851', '#4f8f38', '#ab9466'];

export function hash2(x, y, seed = 0) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise, 0..1, one unit = one lattice cell. */
function vnoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export class Terrain {
  constructor(world) {
    this.world = world;
    const { w, h, tiles } = world;
    this.w = w;
    this.h = h;
    // "is this tile at least ..." maps with a one tile border of water
    const pw = w + 2;
    this.pw = pw;
    const make = (test) => {
      const a = new Float32Array(pw * (h + 2));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (test(tiles[y * w + x])) a[(y + 1) * pw + x + 1] = 1;
      return a;
    };
    this.land = make((t) => t !== T_WATER);
    this.green = make((t) => t === T_GRASS || t === T_FOREST || t === T_DIRT);
    this.woods = make((t) => t === T_FOREST || t === T_DIRT);
    this.dirt = make((t) => t === T_DIRT);
    this.chunks = new Map();
    this.tick = 0;
    this.minimap = this.makeMinimap();
  }

  makeMinimap() {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const g = c.getContext('2d');
    const { tiles } = this.world;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        g.fillStyle = TILE_COLORS[tiles[y * this.w + x]];
        g.fillRect(x, y, 1, 1);
      }
    }
    return c;
  }

  // ------------------------------------------------------------------ chunks
  getChunk(cx, cy) {
    const key = cx * 1000 + cy;
    let ch = this.chunks.get(key);
    if (!ch) {
      ch = this.buildChunk(cx, cy);
      this.chunks.set(key, ch);
      if (this.chunks.size > MAX_CHUNKS) {
        let oldest = null;
        let oldestKey = 0;
        for (const [k, c] of this.chunks) {
          if (!oldest || c.used < oldest.used) {
            oldest = c;
            oldestKey = k;
          }
        }
        this.chunks.delete(oldestKey);
      }
    }
    ch.used = this.tick;
    return ch;
  }

  buildChunk(cx, cy) {
    const size = N + 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    const img = g.createImageData(size, size);
    const px = img.data;
    const { land, green, woods, dirt, pw } = this;
    const maxTx = this.w;
    const maxTy = this.h;
    const x0 = cx * CH_PX;
    const y0 = cy * CH_PX;
    const K = 22; // edge sharpness
    const sat = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
    let o = 0;
    for (let sy = 0; sy < size; sy++) {
      const wy = y0 + (sy - 0.5) * SAMPLE;
      const v = wy / TILE - 0.5;
      let tj = Math.floor(v);
      const fv = v - tj;
      // clamp into the padded maps (index 0 and h+1 are the water border)
      const j0 = tj < -1 ? 0 : tj >= maxTy ? maxTy + 1 : tj + 1;
      tj += 1;
      const j1 = tj < -1 ? 0 : tj >= maxTy ? maxTy + 1 : tj + 1;
      for (let sx = 0; sx < size; sx++) {
        const wx = x0 + (sx - 0.5) * SAMPLE;
        const u = wx / TILE - 0.5;
        let ti = Math.floor(u);
        const fu = u - ti;
        const i0 = ti < -1 ? 0 : ti >= maxTx ? maxTx + 1 : ti + 1;
        ti += 1;
        const i1 = ti < -1 ? 0 : ti >= maxTx ? maxTx + 1 : ti + 1;
        const a = j0 * pw + i0;
        const b = j0 * pw + i1;
        const c = j1 * pw + i0;
        const d = j1 * pw + i1;
        const w00 = (1 - fu) * (1 - fv);
        const w10 = fu * (1 - fv);
        const w01 = (1 - fu) * fv;
        const w11 = fu * fv;
        let vL = land[a] * w00 + land[b] * w10 + land[c] * w01 + land[d] * w11;

        let r = C.deep[0];
        let gr = C.deep[1];
        let bl = C.deep[2];
        if (vL > 0) {
          // wobble the borders a little so the coast does not look like a grid
          const wob = (vnoise(wx / 46, wy / 46, 11) - 0.5) * 0.3 + (vnoise(wx / 17, wy / 17, 12) - 0.5) * 0.1;
          const shade = vnoise(wx / 150, wy / 150, 13) - 0.5; // large light/dark patches
          vL += wob * 4 * vL * (1 - vL);
          let al = sat((vL - 0.03) * 9 + 0.5);
          r += (C.mid[0] - r) * al;
          gr += (C.mid[1] - gr) * al;
          bl += (C.mid[2] - bl) * al;
          al = sat((vL - 0.24) * K + 0.5);
          if (al > 0) {
            r += (C.shallow[0] - r) * al;
            gr += (C.shallow[1] - gr) * al;
            bl += (C.shallow[2] - bl) * al;
            al = sat((vL - 0.41) * K + 0.5);
            r += (C.foam[0] - r) * al;
            gr += (C.foam[1] - gr) * al;
            bl += (C.foam[2] - bl) * al;
            al = sat((vL - 0.47) * K + 0.5);
            r += (C.sandWet[0] - r) * al;
            gr += (C.sandWet[1] - gr) * al;
            bl += (C.sandWet[2] - bl) * al;
            al = sat((vL - 0.6) * 10 + 0.5);
            if (al > 0) {
              const k = 1 + shade * 0.05;
              r += (C.sand[0] * k - r) * al;
              gr += (C.sand[1] * k - gr) * al;
              bl += (C.sand[2] * k - bl) * al;
            }
            let vG = green[a] * w00 + green[b] * w10 + green[c] * w01 + green[d] * w11;
            if (vG > 0) {
              vG += wob * 4 * vG * (1 - vG);
              al = sat((vG - 0.45) * K + 0.5);
              r += (C.grassEdge[0] - r) * al;
              gr += (C.grassEdge[1] - gr) * al;
              bl += (C.grassEdge[2] - bl) * al;
              al = sat((vG - 0.52) * K + 0.5);
              if (al > 0) {
                const k = 1 + shade * 0.11;
                r += (C.grass[0] * k - r) * al;
                gr += (C.grass[1] * k - gr) * al;
                bl += (C.grass[2] * k - bl) * al;
              }
              let vF = woods[a] * w00 + woods[b] * w10 + woods[c] * w01 + woods[d] * w11;
              if (vF > 0) {
                vF += wob * 4 * vF * (1 - vF);
                al = sat((vF - 0.5) * 5 + 0.5); // soft transition into the woods
                const k = 1 + shade * 0.1;
                r += (C.forest[0] * k - r) * al;
                gr += (C.forest[1] * k - gr) * al;
                bl += (C.forest[2] * k - bl) * al;
                let vD = dirt[a] * w00 + dirt[b] * w10 + dirt[c] * w01 + dirt[d] * w11;
                if (vD > 0) {
                  vD += wob * 4 * vD * (1 - vD);
                  al = sat((vD - 0.4) * K + 0.5);
                  r += (C.dirtEdge[0] - r) * al;
                  gr += (C.dirtEdge[1] - gr) * al;
                  bl += (C.dirtEdge[2] - bl) * al;
                  al = sat((vD - 0.47) * K + 0.5);
                  if (al > 0) {
                    const kd = 1 + shade * 0.09;
                    r += (C.dirt[0] * kd - r) * al;
                    gr += (C.dirt[1] * kd - gr) * al;
                    bl += (C.dirt[2] * kd - bl) * al;
                  }
                }
              }
            }
          }
        }
        px[o] = r;
        px[o + 1] = gr;
        px[o + 2] = bl;
        px[o + 3] = 255;
        o += 4;
      }
    }
    g.putImageData(img, 0, 0);
    return { canvas, cx, cy, used: this.tick, decor: this.scatter(cx, cy), waves: this.waves(cx, cy) };
  }

  /** Little plants, flowers and pebbles of one chunk. */
  scatter(cx, cy) {
    const out = [];
    const w = this.world;
    const add = (name, tx, ty, n) => {
      const img = images[name];
      const x = tx * TILE + 9 + hash2(tx, ty, 21 + n) * 46;
      const y = ty * TILE + 12 + hash2(tx, ty, 31 + n) * 44;
      out.push({ name, x: x - img.naturalWidth / 6, y: y - img.naturalHeight / 3, w: img.naturalWidth / 3, h: img.naturalHeight / 3, flip: hash2(tx, ty, 41 + n) < 0.5 });
    };
    for (let ty = cy * CH; ty < (cy + 1) * CH; ty++) {
      for (let tx = cx * CH; tx < (cx + 1) * CH; tx++) {
        const t = w.tile(tx, ty);
        if (t === T_WATER) continue;
        // keep the rim of a terrain patch clean
        if (w.tile(tx + 1, ty) !== t || w.tile(tx - 1, ty) !== t || w.tile(tx, ty + 1) !== t || w.tile(tx, ty - 1) !== t) continue;
        const h = hash2(tx, ty, 1);
        const h2 = hash2(tx, ty, 2);
        if (t === T_GRASS) {
          if (h < 0.34) add(h < 0.17 ? 'decor_grass1' : 'decor_grass2', tx, ty, 0);
          else if (h < 0.47) add(`decor_flower${1 + Math.floor(h2 * 4)}`, tx, ty, 0);
          else if (h < 0.5) add('decor_pebbles', tx, ty, 0);
          if (h2 < 0.2) add('decor_grass1', tx, ty, 1);
        } else if (t === T_FOREST) {
          if (h < 0.26) add('decor_fern', tx, ty, 0);
          else if (h < 0.46) add('decor_leaves', tx, ty, 0);
          else if (h < 0.58) add('decor_grass2', tx, ty, 0);
          else if (h < 0.62) add(`decor_flower${1 + Math.floor(h2 * 4)}`, tx, ty, 0);
          if (h2 < 0.16) add('decor_leaves', tx, ty, 1);
        } else if (t === T_DIRT) {
          if (h < 0.36) add('decor_pebbles', tx, ty, 0);
          else if (h < 0.46) add('decor_grass1', tx, ty, 0);
        } else if (t === T_SAND) {
          if (h < 0.1) add('decor_pebbles', tx, ty, 0);
        }
      }
    }
    out.sort((a, b) => a.y + a.h - (b.y + b.h));
    return out;
  }

  /** Spots in open water where little waves twinkle. */
  waves(cx, cy) {
    const out = [];
    const w = this.world;
    for (let ty = cy * CH; ty < (cy + 1) * CH; ty++) {
      for (let tx = cx * CH; tx < (cx + 1) * CH; tx++) {
        if (tx < -4 || ty < -4 || tx > this.w + 4 || ty > this.h + 4) continue;
        if (hash2(tx, ty, 5) > 0.3) continue;
        let open = true;
        for (let oy = -1; oy <= 1 && open; oy++) for (let ox = -1; ox <= 1; ox++) if (w.tile(tx + ox, ty + oy) !== T_WATER) open = false;
        if (!open) continue;
        out.push({ x: tx * TILE + 10 + hash2(tx, ty, 6) * 30, y: ty * TILE + 14 + hash2(tx, ty, 7) * 36, ph: hash2(tx, ty, 8) * 6.28, len: 14 + hash2(tx, ty, 9) * 12 });
      }
    }
    return out;
  }

  visible(cam) {
    const list = [];
    const cx0 = Math.floor(cam.left / CH_PX);
    const cx1 = Math.floor((cam.left + cam.w) / CH_PX);
    const cy0 = Math.floor(cam.top / CH_PX);
    const cy1 = Math.floor((cam.top + cam.h) / CH_PX);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) list.push(this.getChunk(cx, cy));
    return list;
  }

  /**
   * Paints the ground. Expects an identity transform; k = device px per world px,
   * (ox, oy) = device px position of the world origin.
   */
  draw(ctx, cam, k, ox, oy, time) {
    this.tick++;
    const list = this.visible(cam);
    ctx.imageSmoothingEnabled = true;
    for (const ch of list) {
      const x0 = Math.round(ch.cx * CH_PX * k + ox);
      const y0 = Math.round(ch.cy * CH_PX * k + oy);
      const x1 = Math.round((ch.cx + 1) * CH_PX * k + ox);
      const y1 = Math.round((ch.cy + 1) * CH_PX * k + oy);
      ctx.drawImage(ch.canvas, 1, 1, N, N, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.setTransform(k, 0, 0, k, ox, oy);
    // waves
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = '#ffffff';
    for (const ch of list) {
      for (const wv of ch.waves) {
        const s = Math.sin(time * 1.3 + wv.ph);
        if (s < 0) continue;
        ctx.globalAlpha = s * 0.38;
        const dx = Math.sin(time * 0.6 + wv.ph) * 5;
        ctx.beginPath();
        ctx.moveTo(wv.x + dx, wv.y);
        ctx.quadraticCurveTo(wv.x + dx + wv.len / 2, wv.y - 4, wv.x + dx + wv.len, wv.y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // plants and pebbles
    const l = cam.left - 40;
    const r = cam.left + cam.w + 40;
    const t = cam.top - 40;
    const b = cam.top + cam.h + 40;
    for (const ch of list) {
      for (const d of ch.decor) {
        if (d.x < l || d.x > r || d.y < t || d.y > b) continue;
        const img = sprites[d.name];
        if (d.flip) {
          ctx.save();
          ctx.translate(d.x + d.w, d.y);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, d.w, d.h);
          ctx.restore();
        } else {
          ctx.drawImage(img, d.x, d.y, d.w, d.h);
        }
      }
    }
  }
}
