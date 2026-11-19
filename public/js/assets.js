// Image loading + everything the renderer needs to know about the sprites.
import { ITEMS } from '../shared/defs.js';

const GENERATED = [
  'tree_pine', 'tree_oak', 'stump', 'rock', 'bush_berry', 'bush_empty', 'wall', 'gate', 'spikes', 'tent',
  'campfire', 'campfire_base', 'campfire_flame',
];
const PLAYERS = [1, 2, 3, 4].flatMap((n) => [0, 1, 2].map((f) => `p${n}_${f}`));
const MOBS = ['rabbit', 'deer', 'boar', 'wolf', 'dire', 'bear'].flatMap((m) => [`${m}_0`, `${m}_1`]);
const ICONS = [
  'axe', 'pickaxe', 'spear', 'bow', 'arrow', 'torch', 'torch_stick', 'wood', 'stone', 'berries', 'meat_raw',
  'meat_cooked', 'hide', 'armor', 'arrow_proj', 'flame', 'ui_heart', 'ui_food', 'ui_warm', 'ui_skull',
];
const DECOR = [
  'decor_grass1', 'decor_grass2', 'decor_flower1', 'decor_flower2', 'decor_flower3', 'decor_flower4',
  'decor_pebbles', 'decor_fern', 'decor_leaves',
];
export const IMAGE_NAMES = [...GENERATED, ...PLAYERS, ...MOBS, ...ICONS, ...DECOR];

/** name -> HTMLImageElement */
export const images = {};

export const assetUrl = (name) => `assets/${name}.png`;

export function loadImages(onProgress) {
  let done = 0;
  return Promise.all(
    IMAGE_NAMES.map(
      (name) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            images[name] = img;
            done++;
            if (onProgress) onProgress(done / IMAGE_NAMES.length);
            resolve();
          };
          img.onerror = () => reject(new Error(`could not load ${name}.png`));
          img.src = assetUrl(name);
        }),
    ),
  );
}

/**
 * name -> picture that is drawn. The files are stored 2-3x larger than they
 * appear on screen; prepareSprites() scales them once to the size that is
 * really needed, so that every frame only does cheap 1:1 copies.
 */
export const sprites = {};
let preparedFor = 0;
const SRC_SCALE = Object.fromEntries(IMAGE_NAMES.map((n) => [n, GENERATED.includes(n) ? 2 : 3]));

function shrink(img, w, h) {
  let src = img;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  // halve step by step: clean edges in every browser
  while (sw >= w * 2 && sh >= h * 2) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(sw / 2);
    c.height = Math.ceil(sh / 2);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    src = c;
    sw = c.width;
    sh = c.height;
  }
  if (sw === w && sh === h) return src;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return c;
}

/** @param {number} k  device pixels per world pixel */
export function prepareSprites(k) {
  if (Math.abs(k - preparedFor) < 0.005) return;
  preparedFor = k;
  silhouettes.clear();
  for (const name of IMAGE_NAMES) {
    const img = images[name];
    if (!img) continue;
    const f = k / SRC_SCALE[name];
    if (f >= 0.9) {
      sprites[name] = img;
      continue;
    }
    sprites[name] = shrink(img, Math.max(1, Math.round(img.naturalWidth * f)), Math.max(1, Math.round(img.naturalHeight * f)));
  }
}

/** height / width of a picture */
export const aspect = (name) => images[name].naturalHeight / images[name].naturalWidth;

const silhouettes = new Map();
/** A one-colour copy of a sprite (hit flashes). Cached. */
export function silhouette(name, color = '#ffffff') {
  const key = `${name}|${color}`;
  let c = silhouettes.get(key);
  if (c) return c;
  const img = sprites[name];
  c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  silhouettes.set(key, c);
  return c;
}

/** Icon image name for an item (buildings use the picture of the building). */
export function itemIcon(id) {
  const it = ITEMS[id];
  return it && it.kind === 'build' ? it.obj : id;
}

// World objects: draw size (world px) and the anchor = the point of the picture
// that sits on the object's position (centre of its collision circle).
// sh = shadow [radiusX, radiusY, offsetY]
export const OBJ_SPRITES = {
  tree_pine: { img: 'tree_pine', w: 130, h: 201, ax: 65, ay: 190, sh: [34, 13, 2], tall: true },
  tree_oak: { img: 'tree_oak', w: 170, h: 182, ax: 85, ay: 171, sh: [44, 15, 2], tall: true },
  stump: { img: 'stump', w: 54, h: 54, ax: 27, ay: 36, sh: [26, 10, 8] },
  rock: { img: 'rock', w: 88, h: 91, ax: 44, ay: 57, sh: [42, 14, 22] },
  bush: { img: 'bush_berry', w: 68, h: 68, ax: 34, ay: 42, sh: [30, 11, 17] },
  bush_empty: { img: 'bush_empty', w: 68, h: 68, ax: 34, ay: 42, sh: [30, 11, 17] },
  wall: { img: 'wall', w: 56, h: 74, ax: 28, ay: 53, sh: [27, 9, 16] },
  gate: { img: 'gate', w: 62, h: 69, ax: 31, ay: 50, sh: [29, 9, 15] },
  spikes: { img: 'spikes', w: 64, h: 59, ax: 32, ay: 38, sh: [26, 9, 12] },
  tent: { img: 'tent', w: 100, h: 150, ax: 50, ay: 116, sh: [46, 15, 24] },
  campfire: { img: 'campfire_base', w: 75, h: 98.5, ax: 37.5, ay: 73.5, sh: [36, 13, 8] },
  bonfire: { img: 'campfire_base', w: 127.5, h: 167.5, ax: 63.75, ay: 125, sh: [60, 21, 13] },
};

// Animals: draw size and where the feet are.
export const MOB_SPRITES = {
  rabbit: { w: 52, h: 54, feet: 50 },
  deer: { w: 92, h: 96, feet: 94 },
  boar: { w: 86, h: 60, feet: 58 },
  wolf: { w: 94, h: 66, feet: 64 },
  dire: { w: 104, h: 73, feet: 71 },
  bear: { w: 120, h: 88, feet: 86 },
};

// Items carried in the hand. gx, gy: grip point inside the 48x48 icon;
// ang: direction the tool points to inside the icon.
export const HELD = {
  axe: { img: 'axe', gx: 12, gy: 35, ang: -Math.PI / 4, size: 40, style: 'swing' },
  pickaxe: { img: 'pickaxe', gx: 12, gy: 36, ang: -Math.PI / 4, size: 40, style: 'swing' },
  spear: { img: 'spear', gx: 17, gy: 31, ang: -Math.PI / 4, size: 50, style: 'thrust' },
  torch: { img: 'torch_stick', gx: 13, gy: 41, ang: -Math.PI / 3, size: 38, style: 'torch', tip: [25.4, 19] },
  bow: { img: 'bow', gx: 32, gy: 16, ang: -Math.PI / 4, size: 42, style: 'bow' },
};

export const PLAYER_SPRITE = { w: 64, h: 84, feet: 80, footY: 8 };
