#!/usr/bin/env node
/*
 * Procedural vector art for everything that is not an AI-generated picture:
 * player characters, animals, item icons, ground decoration and UI icons.
 *
 *   node tools/gen_art.mjs          -> writes SVG files to art/svg/
 *   node tools/rasterize.mjs        -> renders them to PNG in public/assets/
 *
 * The style mirrors the generated scenery: flat colours, one shade tone and a
 * bold dark outline.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'art', 'svg');
mkdirSync(OUT_DIR, { recursive: true });

const INK = '#1f1712';
const SW = 2.2;

// ---------------------------------------------------------------- helpers
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
const tag = (name, o) => `<${name} ${attrs(o)}/>`;
const group = (inner, o = {}) => `<g ${attrs(o)}>${Array.isArray(inner) ? inner.join('') : inner}</g>`;
const rot = (inner, deg, cx, cy) => group(inner, { transform: `rotate(${deg} ${cx} ${cy})` });
const r2 = (n) => Math.round(n * 100) / 100;

const stroke = (w = SW, color = INK) => ({
  stroke: color,
  'stroke-width': w,
  'stroke-linejoin': 'round',
  'stroke-linecap': 'round',
});

/** Shape factories return {tag, a} so they can be drawn outlined, filled or both. */
const S = {
  ellipse: (cx, cy, rx, ry, deg = 0) => ({
    tag: 'ellipse',
    a: { cx, cy, rx, ry, transform: deg ? `rotate(${deg} ${cx} ${cy})` : undefined },
  }),
  circle: (cx, cy, r) => ({ tag: 'circle', a: { cx, cy, r } }),
  rect: (x, y, w, h, rx = 0, deg = 0, ox = x + w / 2, oy = y + h / 2) => ({
    tag: 'rect',
    a: { x, y, width: w, height: h, rx, transform: deg ? `rotate(${deg} ${ox} ${oy})` : undefined },
  }),
  path: (d) => ({ tag: 'path', a: { d } }),
  poly: (pts) => ({ tag: 'polygon', a: { points: pts.map((p) => p.join(',')).join(' ') } }),
};

/** Shape with fill + outline. */
const draw = (shape, fill, w = SW, extra = {}) => tag(shape.tag, { ...shape.a, fill, ...stroke(w), ...extra });
/** Shape with fill only (details inside an outlined body). */
const fill = (shape, color, extra = {}) => tag(shape.tag, { ...shape.a, fill: color, ...extra });
/** Open line (no fill). */
const line = (d, color = INK, w = SW, extra = {}) => tag('path', { d, fill: 'none', ...stroke(w, color), ...extra });
/** A line that itself has an outline (antlers, handles, strings ...). */
const stick = (d, color, w, outline = 1.8) => line(d, INK, w + outline * 2) + line(d, color, w);

/**
 * Several overlapping shapes merged into ONE silhouette: all outlines are
 * drawn first, then all fills, so no outline is visible where parts overlap.
 * parts: [[shape, fill], ...]
 */
const blob = (parts, w = SW) =>
  parts.map(([s]) => tag(s.tag, { ...s.a, fill: INK, ...stroke(w * 2) })).join('') +
  parts.map(([s, c]) => tag(s.tag, { ...s.a, fill: c })).join('');

const files = {};
const svg = (name, w, h, body) => {
  files[name] = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${
    Array.isArray(body) ? body.join('') : body
  }</svg>\n`;
};

// ---------------------------------------------------------------- player
const SKINS = {
  // name: [skin, skinShade, hair, jacket, jacketShade, pants, style]
  p1: { skin: '#f6cfa3', blush: '#f09a86', hair: '#6b4226', jacket: '#d9483b', jacket2: '#a8322a', pants: '#3f5f9a', style: 'short' },
  p2: { skin: '#fbdcb8', blush: '#f4a091', hair: '#f2c14e', jacket: '#3d86d8', jacket2: '#2a62a8', pants: '#5a4a78', style: 'ponytail' },
  p3: { skin: '#b9794f', blush: '#9c5a3c', hair: '#221a18', jacket: '#3fa35b', jacket2: '#2c7a42', pants: '#4a4f57', style: 'curly' },
  p4: { skin: '#e8b98c', blush: '#d98f77', hair: '#c9541f', jacket: '#f0b429', jacket2: '#c48a12', pants: '#35506b', style: 'beanie' },
};

function playerSprite(c, frame) {
  // 64 x 84, feet on y = 80, facing right. frame 0 = stand, 1/2 = walk
  const swing = frame === 1 ? 26 : frame === 2 ? -26 : 0;
  const bob = frame === 0 ? 0 : -1;
  const hip = frame === 0 ? [24, 32] : [26.5, 29.5];
  const leg = (x, deg, shade) =>
    rot(
      [
        draw(S.rect(x, 56, 9, 15, 3.5), shade ? c.pants : c.pants),
        shade ? fill(S.rect(x, 56, 9, 15, 3.5), '#000', { opacity: 0.22 }) : '',
        draw(S.path(`M${x - 1} 70 h9 q5 0 5 4 v2 h-14 z`), '#5a3a22'),
      ],
      deg,
      x + 4.5,
      57,
    );
  const body = [];
  // backpack
  body.push(draw(S.rect(11, 38 + bob, 14, 21, 5), '#8a5a2b'));
  body.push(fill(S.rect(13, 47 + bob, 10, 3, 1.5), '#6b4320'));
  // legs (far one first)
  body.push(leg(hip[0], swing, true));
  body.push(leg(hip[1], -swing, false));
  // torso
  body.push(draw(S.path(`M20 ${44 + bob} q0 -7 8 -7 h10 q8 0 8 7 v13 q0 5 -5 5 h-16 q-5 0 -5 -5 z`), c.jacket));
  body.push(fill(S.path(`M20 ${52 + bob} h26 v5 q0 5 -5 5 h-16 q-5 0 -5 -5 z`), c.jacket2));
  body.push(line(`M37 ${39 + bob} v21`, INK, 1.4, { opacity: 0.55 }));
  body.push(fill(S.circle(40.5, 46 + bob, 1.3), '#fff', { opacity: 0.8 }));
  body.push(fill(S.circle(40.5, 52 + bob, 1.3), '#fff', { opacity: 0.8 }));
  // head
  const hy = 24 + bob;
  if (c.style === 'ponytail') {
    body.push(draw(S.path(`M17 ${hy - 2} q-12 2 -11 16 q1 8 7 9 q-2 -8 2 -14 q3 -5 6 -6 z`), c.hair));
  }
  body.push(draw(S.circle(33, hy, 17), c.skin));
  // ear
  body.push(draw(S.ellipse(21.5, hy + 3, 3, 4), c.skin, 1.8));
  // face
  body.push(fill(S.ellipse(46, hy + 7, 3.6, 2.4), c.blush, { opacity: 0.6 }));
  body.push(fill(S.ellipse(36.5, hy + 2.5, 2.3, 3.4), INK));
  body.push(fill(S.ellipse(45.5, hy + 2.5, 2.1, 3.4), INK));
  body.push(fill(S.circle(37.3, hy + 1.2, 0.9), '#fff'));
  body.push(fill(S.circle(46.2, hy + 1.2, 0.9), '#fff'));
  body.push(line(`M38.5 ${hy + 9.5} q3 2.6 6 0`, INK, 1.6));
  // hair / hat
  if (c.style === 'short') {
    body.push(
      draw(
        S.path(
          `M15.5 ${hy + 2} q-2 -20 17 -21 q15 -1 18.5 12 q-6 -1 -9 -5 q-1 4 -6 5 q1 -3 -1 -5 q-4 6 -11 6 q-3 2 -3.5 7 q-2 2 -5 1 z`,
        ),
        c.hair,
      ),
    );
  } else if (c.style === 'ponytail') {
    body.push(
      draw(
        S.path(
          `M15.5 ${hy + 4} q-3 -22 17 -23 q16 -1 19 13 q-8 1 -14 -5 q-4 7 -14 7 q-2 3 -2 8 q-3 2 -6 0 z`,
        ),
        c.hair,
      ),
    );
    body.push(draw(S.rect(12, hy - 5, 6, 5, 2), '#e0507a', 1.6));
  } else if (c.style === 'curly') {
    body.push(
      blob(
        [
          [S.circle(21, hy - 8, 7.5), c.hair],
          [S.circle(29, hy - 15, 8), c.hair],
          [S.circle(39, hy - 15, 7.5), c.hair],
          [S.circle(46, hy - 9, 6), c.hair],
          [S.circle(17, hy, 6), c.hair],
          [S.circle(33, hy - 10, 9), c.hair],
        ],
        SW,
      ),
    );
  } else if (c.style === 'beanie') {
    body.push(draw(S.path(`M16.5 ${hy + 3} q-1 5 1 8 q4 1 5 -3 q0 -4 1 -6 z`), c.hair, 1.8));
    body.push(draw(S.path(`M15.5 ${hy - 3} q1 -19 17.5 -19 q16 0 18 18 q-18 -5 -35.5 1 z`), '#3c8fb5'));
    body.push(draw(S.path(`M14.5 ${hy - 4} q18 -8 37.5 -1 q1 3 0 6 q-19 -6 -37 1 q-1.500 -3 -0.500 -6 z`), '#e9edf0'));
    body.push(draw(S.circle(33, hy - 22.5, 3.6), '#e9edf0', 1.8));
  }
  return group(body, { transform: 'translate(0 4)' });
}

for (const [name, c] of Object.entries(SKINS)) {
  for (let f = 0; f < 3; f++) svg(`${name}_${f}`, 64, 84, playerSprite(c, f));
}

// ---------------------------------------------------------------- animals
/** A leg: rounded bar rotated around its top, with a hoof/paw at the bottom. */
function leg(x, y, w, len, deg, color, foot, footH = 4) {
  return rot(
    [draw(S.rect(x - w / 2, y, w, len, w / 2.4), color), draw(S.rect(x - w / 2 - 0.5, y + len - footH, w + 1.5, footH, 1.6), foot, 1.8)],
    deg,
    x,
    y + 1,
  );
}
const shade = (shape, op = 0.2) => fill(shape, '#000', { opacity: op });

function rabbit(frame) {
  // 50 x 46, feet on y = 44
  const k = frame === 1 ? 1 : 0;
  const fur = '#b78a5c';
  const fur2 = '#8f6740';
  const b = [];
  b.push(draw(S.circle(8, 29, 5.2), '#f4ece0'));
  // ears
  b.push(rot([draw(S.ellipse(32, 8, 3.8, 10), fur2), fill(S.ellipse(32, 9, 1.7, 6.5), '#e8a59a')], -24 - k * 10, 33, 16));
  b.push(rot([draw(S.ellipse(37, 7.5, 3.8, 10), fur), fill(S.ellipse(37, 8.5, 1.7, 6.5), '#f0b3a8')], -6 - k * 10, 36, 16));
  // far front leg
  b.push(leg(33, 30, 5, 13, k ? -38 : 6, fur2, fur2, 3));
  b.push(
    blob([
      [S.ellipse(24, 29, 15, 10.5), fur],
      [S.ellipse(15, 30, 11, 10), fur],
      [S.circle(37, 21, 9.5), fur],
    ]),
  );
  b.push(fill(S.ellipse(25, 35, 10, 4), '#e6cfae'));
  // hind foot + near front leg
  b.push(rot(draw(S.ellipse(15, 40.5, 9, 3.6), '#e6cfae'), k ? 28 : 0, 9, 38));
  b.push(leg(37, 30, 5, 13, k ? -50 : -6, fur, '#e6cfae', 3));
  b.push(line('M13 27 q3 -5 9 -3', INK, 1.4, { opacity: 0.45 }));
  // face
  b.push(fill(S.ellipse(42.5, 24.500, 4, 3), '#e6cfae'));
  b.push(fill(S.ellipse(39.5, 19.5, 1.9, 2.5), INK));
  b.push(fill(S.circle(40.1, 18.7, 0.7), '#fff'));
  b.push(draw(S.ellipse(46, 22.5, 1.6, 1.2), '#e88a8a', 1.2));
  return group(b, { transform: 'translate(1 6)' });
}
svg('rabbit_0', 52, 54, rabbit(0));
svg('rabbit_1', 52, 54, rabbit(1));

function deer(frame) {
  // 92 x 96, feet on y = 94
  const a = frame === 1 ? 20 : -20;
  const fur = '#c68e55';
  const fur2 = '#9c6b3b';
  const hoof = '#3a2a20';
  const b = [];
  b.push(leg(26, 62, 5.5, 32, a * 0.8, fur2, hoof));
  b.push(leg(55, 62, 5.5, 32, -a * 0.8, fur2, hoof));
  b.push(draw(S.path('M15 50 q-8 -3 -8 5 q2 5 9 2 z'), '#f6eee0'));
  // antlers
  b.push(stick('M70 22 q-3 -9 -10 -14 M66 14 q4 -3 4 -9 M62.5 10 q-5 0 -8 -4', '#e3cfa6', 2.4));
  b.push(stick('M76 21 q2 -9 9 -13 M79.500 13 q-1 -4 1 -8 M82.500 10 q4 0 6 -3', '#e3cfa6', 2.4));
  b.push(
    blob([
      [S.ellipse(40, 57, 27, 14.5), fur],
      [S.path('M52 50 q9 -8 13 -24 l13 4 q-2 20 -10 31 z'), fur],
      [S.ellipse(75, 27, 11, 8, 14), fur],
      [S.ellipse(82, 31, 6.5, 5, 14), fur],
    ]),
  );
  b.push(fill(S.path('M17 62 q22 12 46 0 q-4 10 -23 10 q-17 0 -23 -10 z'), '#ecd3ad'));
  b.push(fill(S.path('M62 44 q4 6 2 16 q6 -6 8 -17 z'), '#ecd3ad'));
  for (const [x, y] of [
    [26, 50],
    [34, 47],
    [43, 49],
    [31, 55],
    [48, 54],
  ])
    b.push(fill(S.circle(x, y, 1.9), '#f4e3c3'));
  b.push(leg(22, 64, 6, 30, -a, fur, hoof));
  b.push(leg(58, 64, 6, 30, a, fur, hoof));
  // ear, face
  b.push(rot([draw(S.ellipse(64, 20, 4, 7.5), fur), fill(S.ellipse(64, 20.5, 1.8, 4.5), '#eab9a0')], -58, 66, 24));
  b.push(fill(S.ellipse(74, 25, 2, 2.7), INK));
  b.push(fill(S.circle(74.6, 24.200, 0.8), '#fff'));
  b.push(draw(S.ellipse(87.2, 31, 2.4, 2), INK, 1));
  b.push(line('M80 35 q3 1.500 5 0', INK, 1.3));
  return b;
}
svg('deer_0', 92, 96, deer(0));
svg('deer_1', 92, 96, deer(1));

function boar(frame) {
  // 86 x 60, feet on y = 58
  const a = frame === 1 ? 22 : -22;
  const fur = '#74523c';
  const fur2 = '#553a2a';
  const hoof = '#2a1f1a';
  const b = [];
  b.push(leg(26, 40, 7, 18, a * 0.8, fur2, hoof));
  b.push(leg(52, 40, 7, 18, -a * 0.8, fur2, hoof));
  b.push(line('M11 28 q-7 -2 -6 4 q1 4 5 2', INK, 2.2));
  // bristles
  b.push(
    draw(
      S.path('M14 22 l3 -8 l4 6 l3 -9 l4 7 l4 -9 l4 8 l4 -9 l4 8 l5 -8 l3 9 l5 -6 l2 9 z'),
      fur2,
    ),
  );
  b.push(
    blob([
      [S.ellipse(36, 33, 27, 17), fur],
      [S.ellipse(62, 35, 15, 13), fur],
      [S.rect(68, 32, 14, 13, 5), '#b08672'],
    ]),
  );
  b.push(fill(S.path('M12 38 q22 16 48 6 q-8 8 -25 8 q-16 0 -23 -14 z'), '#000', { opacity: 0.16 }));
  b.push(leg(22, 42, 7.5, 16, -a, fur, hoof));
  b.push(leg(48, 42, 7.5, 16, a, fur, hoof));
  // ear
  b.push(draw(S.path('M52 25 l3 -11 l8 8 z'), fur2));
  // tusk
  b.push(draw(S.path('M69 46 q1 -8 7 -11 q-1 7 -3 11 z'), '#f7efd9', 1.6));
  // snout details
  b.push(fill(S.ellipse(79.500, 36.5, 1.2, 1.8), INK));
  b.push(fill(S.ellipse(79.500, 41, 1.2, 1.8), INK));
  // eye
  b.push(fill(S.circle(64.5, 30, 2.6), '#fff'));
  b.push(fill(S.circle(65.3, 30.4, 1.5), INK));
  b.push(line('M60 26.500 l7 2.200', INK, 2));
  return b;
}
svg('boar_0', 86, 60, boar(0));
svg('boar_1', 86, 60, boar(1));

function wolf(frame, pal) {
  // 94 x 66, feet on y = 64
  const a = frame === 1 ? 24 : -24;
  const { fur, fur2, belly, eye } = pal;
  const paw = fur2;
  const b = [];
  // tail
  b.push(draw(S.path(`M18 30 q-12 2 -16 ${frame === 1 ? 13 : 17} q9 4 16 -3 q5 -5 6 -10 z`), fur));
  b.push(fill(S.path(`M3 ${frame === 1 ? 42 : 46} q5 3 10 -1 q-5 -1 -8 -4 z`), belly));
  b.push(leg(28, 40, 6.5, 24, a * 0.8, fur2, paw));
  b.push(leg(56, 40, 6.5, 24, -a * 0.8, fur2, paw));
  // ears
  b.push(draw(S.path('M60 20 l1 -13 l9 9 z'), fur2));
  if (pal.mane) {
    b.push(draw(S.path('M22 26 l4 -8 l4 6 l4 -8 l4 7 l5 -8 l3 8 l5 -7 l3 8 l5 -6 l1 9 z'), fur2));
  }
  b.push(
    blob([
      [S.ellipse(40, 36, 25, 12.5), fur],
      [S.path('M52 30 q6 -8 14 -12 l8 14 q-6 12 -16 14 z'), fur],
      [S.circle(69, 26, 10.5), fur],
      [S.path('M70 20 l19 7 q2 3 -1 6 l-16 4 z'), fur],
    ]),
  );
  b.push(fill(S.path('M18 40 q20 10 44 0 q-6 9 -22 9 q-15 0 -22 -9 z'), belly));
  b.push(fill(S.path('M60 34 q4 6 0 13 q8 -3 12 -11 z'), belly));
  b.push(fill(S.path('M74 31 l14 -1.500 q0 2 -1.500 3 l-12 3 z'), belly));
  b.push(leg(24, 42, 7, 22, -a, fur, belly));
  b.push(leg(60, 42, 7, 22, a, fur, belly));
  b.push(draw(S.path('M65 18 l3 -13 l8 11 z'), fur));
  b.push(fill(S.path('M68 14 l1.200 -5 l3.500 5 z'), '#000', { opacity: 0.3 }));
  // teeth, nose, eye
  b.push(draw(S.path('M77 34.500 l2 3.500 l1.800 -3.200 l2 3 l1.500 -3.500 z'), '#fff', 1));
  b.push(draw(S.ellipse(89, 28, 2.6, 2.2), INK, 1));
  b.push(draw(S.path('M68.500 25 q4.500 -4 9.500 0.500 q-5 3.500 -9.500 -0.500 z'), eye, 1.3));
  b.push(fill(S.circle(73.8, 25.200, 1.3), INK));
  b.push(line('M67 20.500 l11 2.800', INK, 2.2));
  return b;
}
const WOLF = { fur: '#8f97a1', fur2: '#69717b', belly: '#d5d9de', eye: '#ffd83d' };
const DIRE = { fur: '#3f3a47', fur2: '#28242e', belly: '#6a6474', eye: '#ff4433', mane: true };
svg('wolf_0', 94, 66, wolf(0, WOLF));
svg('wolf_1', 94, 66, wolf(1, WOLF));
svg('dire_0', 94, 66, wolf(0, DIRE));
svg('dire_1', 94, 66, wolf(1, DIRE));

function bear(frame) {
  // 120 x 88, feet on y = 86
  const a = frame === 1 ? 16 : -16;
  const fur = '#80532f';
  const fur2 = '#5e3b20';
  const b = [];
  b.push(draw(S.circle(11, 46, 5.5), fur2));
  b.push(leg(34, 56, 15, 28, a * 0.8, fur2, fur2, 5));
  b.push(leg(74, 56, 15, 28, -a * 0.8, fur2, fur2, 5));
  // ears
  b.push(draw(S.circle(84, 30, 6), fur2));
  b.push(
    blob([
      [S.ellipse(46, 50, 37, 24), fur],
      [S.ellipse(66, 42, 24, 22), fur],
      [S.circle(92, 46, 16.500), fur],
      [S.ellipse(104, 52, 10, 8), '#c2946a'],
    ]),
  );
  b.push(fill(S.path('M12 58 q30 22 70 6 q-10 12 -36 12 q-24 0 -34 -18 z'), '#000', { opacity: 0.16 }));
  b.push(leg(28, 58, 16, 26, -a, fur, fur2, 5));
  b.push(leg(80, 58, 16, 26, a, fur, fur2, 5));
  b.push(draw(S.circle(95, 30, 6), fur));
  b.push(fill(S.circle(95, 30.500, 2.800), '#c2946a'));
  // face
  b.push(draw(S.ellipse(111.5, 48.500, 3.4, 2.800), INK, 1));
  b.push(line('M103 55 q4 3 9 0.500', INK, 1.6));
  b.push(draw(S.path('M104.500 56 l1.500 3 l1.500 -2.600 z'), '#fff', 0.9));
  b.push(fill(S.circle(97, 42.5, 2.9), '#fff'));
  b.push(fill(S.circle(97.8, 43, 1.7), INK));
  b.push(line('M92 38.500 l8 2.500', INK, 2.2));
  return b;
}
svg('bear_0', 120, 88, bear(0));
svg('bear_1', 120, 88, bear(1));

// ---------------------------------------------------------------- items (48 x 48)
// Tools are drawn pointing straight up and then turned 45 degrees so that
// their "business end" points to the upper right corner of the icon.
const tilt = (inner, deg = 45, tx = 0, ty = 0, sc = 1) =>
  group(rot(inner, deg, 24, 24), { transform: `translate(${tx} ${ty}) translate(24 24) scale(${sc}) translate(-24 -24)` });
const WOODC = '#a8713d';
const WOOD2 = '#7c4f27';
const STONEC = '#9aa3ad';
const STONE2 = '#6f7882';
const STONE3 = '#c3cad1';
const ROPE = '#e2c48a';

const handle = (y0, y1, w = 5) => [
  draw(S.rect(24 - w / 2, y0, w, y1 - y0, w / 2), WOODC),
  fill(S.rect(24 + w / 2 - 1.800, y0 + 2, 1.2, y1 - y0 - 4, 0.6), WOOD2, { opacity: 0.7 }),
];
const binding = (y) => [draw(S.rect(20.2, y, 7.6, 6.5, 1.5), ROPE, 1.6), line(`M20.500 ${y + 3.200} h7`, INK, 1, { opacity: 0.5 })];

svg(
  'axe',
  48,
  48,
  tilt([
    ...handle(6, 47),
    draw(S.path('M21 7 q10 -5 20 -3 q4 9 0 19 q-10 0 -20 -5 z'), STONEC),
    fill(S.path('M36 5 q3 0 5 0 q4 8 0 17 q-3 0 -5 -1 q3 -8 0 -16 z'), STONE3),
    fill(S.path('M22 17 q9 4 18 5 l1 -3 q-10 0 -19 -5 z'), STONE2),
    ...binding(10.5),
  ], 45, -4.5, -1),
);

svg(
  'pickaxe',
  48,
  48,
  tilt([
    ...handle(7, 47),
    draw(S.path('M3 19 q21 -22 42 0 l-4 2 q-17 -13 -34 0 z'), STONEC),
    fill(S.path('M10 15 q14 -11 28 0 l1 -2.500 q-15 -11 -30 0 z'), STONE3),
    ...binding(8.5),
  ]),
);

svg(
  'spear',
  48,
  48,
  tilt([
    draw(S.rect(22.2, 2, 3.6, 54, 1.8), WOODC),
    draw(S.path('M24 -9 l6 11 l-6 7 l-6 -7 z'), STONEC),
    fill(S.path('M24 -9 l6 11 l-6 7 z'), STONE2),
    draw(S.rect(20.8, 6, 6.4, 5, 1.4), ROPE, 1.6),
  ], 45, 0, 0, 0.93),
);

svg(
  'bow',
  48,
  48,
  tilt(
    [
      line('M15 2 L15 46', '#e9e4d8', 1.3),
      line('M15 2 L15 46', INK, 0.5),
      stick('M15 2 Q40 24 15 46', WOODC, 3.6, 1.7),
      draw(S.rect(24, 19.500, 6.5, 9, 2), ROPE, 1.6),
      stick('M13.500 2.500 l3 -1', WOOD2, 1.6, 1.2),
      stick('M13.500 45.500 l3 1', WOOD2, 1.6, 1.2),
    ],
    -45,
    6,
    -6,
    0.96,
  ),
);

const arrowBody = [
  draw(S.rect(22.900, 6, 2.2, 36, 1), '#d9b98a', 1.6),
  draw(S.path('M24 -1 l5 9 l-5 -2 l-5 2 z'), STONEC, 1.7),
  draw(S.path('M24 33 l5.500 4 v7 l-5.500 -4 l-5.500 4 v-7 z'), '#e0483e', 1.6),
];
svg('arrow', 48, 48, tilt(arrowBody));
// projectile: 44 x 14, pointing right
svg('arrow_proj', 50, 14, group(arrowBody, { transform: 'translate(46.500 -17) rotate(90)' }));

const flame = (cx, cy, s = 1) =>
  group(
    [
      draw(S.path('M0 -15 q9 8 8 15 q0 8 -8 8 q-8 0 -8 -8 q0 -5 3 -8 q1 3 3 3 q-1 -5 2 -10 z'), '#f2681d'),
      fill(S.path('M0 -7 q5 5 5 9 q0 5 -5 5 q-5 0 -5 -5 q0 -3 2 -5 q1 2 2 2 q-1 -3 1 -6 z'), '#ffc42e'),
      fill(S.path('M0 1 q2.500 2 2.500 4 q0 2.500 -2.500 2.500 q-2.500 0 -2.500 -2.500 q0 -2 2.500 -4 z'), '#fff3a0'),
    ],
    { transform: `translate(${cx} ${cy}) scale(${s})` },
  );

svg('torch', 48, 48, tilt([...handle(18, 47, 4.6), draw(S.rect(20, 14, 8, 9, 2), '#4a3626'), flame(24, 12, 1)], 30, -4, 4.500, 0.9));
// held torch without the flame (the game animates the flame itself)
svg('torch_stick', 48, 48, tilt([...handle(18, 47, 4.6), draw(S.rect(20, 14, 8, 9, 2), '#4a3626')], 30, -4, 4.500, 0.9));
svg('flame', 26, 34, flame(13, 21.500, 1.15));

svg('wood', 48, 48, [
  rot(
    [
      draw(S.rect(5, 23, 36, 13, 5), WOOD2),
      fill(S.rect(8, 25, 28, 3, 1.5), '#96633a'),
      draw(S.ellipse(39, 29.500, 4.6, 6.5), '#e8c68f'),
      line('M39 26 a2.200 3.500 0 1 0 0.100 0', '#b98a4e', 1.1),
    ],
    -14,
    24,
    29,
  ),
  rot(
    [
      draw(S.rect(4, 13, 37, 14, 5.500), WOODC),
      fill(S.rect(8, 15.500, 28, 3, 1.5), '#c48a52'),
      line('M12 22 h9 M24 23 h7', WOOD2, 1.4),
      draw(S.ellipse(39, 20, 5, 7), '#f0d39e'),
      line('M39 16 a2.500 4 0 1 0 0.100 0', '#b98a4e', 1.1),
      fill(S.circle(39, 20, 0.9), '#b98a4e'),
    ],
    -14,
    24,
    20,
  ),
]);

svg('stone', 48, 48, [
  draw(S.poly([[8, 30], [12, 16], [25, 8], [38, 14], [42, 28], [34, 40], [17, 41]]), STONEC),
  fill(S.poly([[12, 16], [25, 8], [38, 14], [27, 20], [15, 24]]), STONE3),
  fill(S.poly([[8, 30], [15, 24], [20, 33], [17, 41]]), STONE2, { opacity: 0.55 }),
  fill(S.poly([[34, 40], [42, 28], [31, 30], [20, 33], [17, 41]]), STONE2, { opacity: 0.85 }),
  line('M27 20 l4 10 M15 24 l5 9', INK, 1.1, { opacity: 0.45 }),
]);

const berry = (x, y, r) => [draw(S.circle(x, y, r), '#d92b33'), fill(S.path(`M${x - r * 0.9} ${y + r * 0.2} a${r} ${r} 0 0 0 ${r * 1.8} 0 a${r} ${r * 1.6} 0 0 1 ${-r * 1.8} 0 z`), '#a81a26', { opacity: 0.7 }), fill(S.circle(x - r * 0.35, y - r * 0.4, r * 0.24), '#fff', { opacity: 0.9 })];
svg('berries', 48, 48, [
  line('M24 20 q0 -8 6 -13', '#4d7a2b', 2.6),
  line('M24 20 q0 -8 6 -13', INK, 0.1),
  draw(S.path('M29 8 q9 -7 15 0 q-7 7 -15 0 z'), '#58a83a'),
  line('M30 8 q7 -2 12 0', '#2f6e22', 1.1),
  ...berry(15.5, 30, 8.5),
  ...berry(32.5, 30, 8.5),
  ...berry(24, 20.5, 8.5),
]);

const meat = (c1, c2, c3, cooked) => [
  // bone
  stick('M19 31 L9 41', '#f6f0e2', 4, 1.7),
  draw(S.circle(6.5, 39.500, 3.600), '#f6f0e2'),
  draw(S.circle(10, 43, 3.600), '#f6f0e2'),
  fill(S.circle(8.5, 41.200, 3), '#f6f0e2'),
  draw(S.path('M16 30 q-6 -10 2 -19 q9 -9 20 -4 q9 5 6 16 q-3 10 -14 13 q-9 1 -14 -6 z'), c1),
  fill(S.path('M17 30 q5 5 13 4 q11 -3 14 -13 q1 -4 0 -7 q-1 10 -9 15 q-8 5 -18 1 z'), c2),
  cooked
    ? line('M22 13 l12 12 M29 10 l9 9 M18 20 l10 10', c3, 2)
    : fill(S.path('M22 14 q6 -5 13 -2 q4 2 4 7 q-2 -4 -7 -5 q-5 -1 -10 0 z'), c3),
  fill(S.ellipse(24, 13, 3, 1.6, -30), '#fff', { opacity: cooked ? 0.35 : 0.5 }),
];
svg('meat_raw', 48, 48, meat('#e2566a', '#b8384f', '#f7a7b0', false));
svg('meat_cooked', 48, 48, meat('#b0652c', '#834519', '#6b3411', true));

svg('hide', 48, 48, [
  draw(
    S.path(
      'M24 5 q4 3 8 3 l9 -3 l-2 10 q-2 6 0 12 l5 13 l-11 -3 q-4 6 -9 7 q-5 -1 -9 -7 l-11 3 l5 -13 q2 -6 0 -12 l-2 -10 l9 3 q4 0 8 -3 z',
    ),
    '#b98450',
  ),
  fill(S.path('M24 11 q7 2 9 9 q1 9 -3 15 q-3 4 -6 5 q-3 -1 -6 -5 q-4 -6 -3 -15 q2 -7 9 -9 z'), '#d6a56e'),
  line('M19 19 l2 3 M27 17 l2 3 M22 27 l2 3 M29 26 l1 3 M18 30 l1 3', '#8c5e33', 1.4),
]);

svg('armor', 48, 48, [
  draw(S.path('M10 12 l9 -6 q5 6 10 0 l9 6 l4 11 l-7 3 v17 q-11 4 -22 0 v-17 l-7 -3 z'), '#a8733f'),
  fill(S.path('M13 26 v17 q11 4 22 0 v-17 l-2 1 v12 q-9 3 -18 0 v-12 z'), '#7f5229'),
  draw(S.path('M19 6 q5 6 10 0 l4 3 q-1 6 -9 8 q-8 -2 -9 -8 z'), '#e8d6b4', 1.8),
  line('M24 18 v24', INK, 1.3, { opacity: 0.6 }),
  line('M21 23 h6 M21 29 h6 M21 35 h6', '#e2c48a', 1.6),
]);

// ---------------------------------------------------------------- UI icons
svg('ui_heart', 32, 32, [
  draw(S.path('M16 28 q-13 -9 -13 -17 q0 -7 6.500 -7 q4 0 6.500 4 q2.500 -4 6.500 -4 q6.500 0 6.500 7 q0 8 -13 17 z'), '#e23d4b'),
  fill(S.ellipse(10, 10.500, 3, 2, -30), '#fff', { opacity: 0.55 }),
]);
svg('ui_food', 32, 32, group(meat('#b0652c', '#834519', '#6b3411', true), { transform: 'scale(0.667)' }));
svg('ui_warm', 32, 32, flame(16, 20, 1.12));
svg('ui_skull', 32, 32, [
  draw(S.path('M16 3 q12 0 12 11 q0 6 -4 8 v5 q0 2 -2 2 h-12 q-2 0 -2 -2 v-5 q-4 -2 -4 -8 q0 -11 12 -11 z'), '#f1ece0'),
  fill(S.ellipse(11, 15, 3.2, 3.8), INK),
  fill(S.ellipse(21, 15, 3.2, 3.8), INK),
  fill(S.path('M16 19 l2 4 h-4 z'), INK),
  line('M13 25 v4 M16 25 v4 M19 25 v4', INK, 1.3),
]);

// ---------------------------------------------------------------- ground decoration
const G1 = '#74bd4c';
const G2 = '#2f6f24';
const blade = (x, y, h, lean, w, c) =>
  tag('path', {
    d: `M${r2(x - w)} ${y} q${r2(lean * 0.3)} ${r2(-h * 0.6)} ${r2(w + lean)} ${-h} q${r2(-lean * 0.2 + w * 0.6)} ${r2(h * 0.5)} ${r2(w - lean)} ${h} z`,
    fill: c,
    ...stroke(1.3, G2),
  });
svg('decor_grass1', 30, 24, [blade(8, 22, 14, -5, 2.6, G1), blade(22, 22, 13, 5, 2.6, G1), blade(15, 22, 19, 1, 3, '#8fd45f')]);
svg('decor_grass2', 34, 28, [
  blade(7, 26, 13, -6, 2.4, G1),
  blade(27, 26, 14, 6, 2.4, G1),
  blade(12, 26, 21, -3, 2.800, '#8fd45f'),
  blade(21, 26, 23, 3, 2.800, '#80c855'),
]);
const flower = (petal, center) => [
  line('M14 27 q-1 -7 0 -13', '#3c8a2c', 2),
  tag('path', { d: 'M14 23 q-6 -1 -7 -6 q6 0 7 6 z', fill: '#58a63c', ...stroke(1.1, G2) }),
  ...[0, 72, 144, 216, 288].map((d) => rot(tag('ellipse', { cx: 14, cy: 6.5, rx: 3.3, ry: 4.4, fill: petal, ...stroke(1.1, '#3a2c22') }), d, 14, 11.500)),
  tag('circle', { cx: 14, cy: 11.5, r: 2.800, fill: center, ...stroke(1.1, '#3a2c22') }),
];
svg('decor_flower1', 28, 28, flower('#ffffff', '#ffcf3d'));
svg('decor_flower2', 28, 28, flower('#ffd84a', '#e8842a'));
svg('decor_flower3', 28, 28, flower('#f08ab8', '#ffe27a'));
svg('decor_flower4', 28, 28, flower('#8fb6ff', '#fff2a8'));
svg('decor_pebbles', 30, 18, [
  tag('ellipse', { cx: 10, cy: 11, rx: 7.5, ry: 5, fill: '#9aa3ad', ...stroke(1.3, '#4a5058') }),
  tag('ellipse', { cx: 8.5, cy: 9.500, rx: 3.500, ry: 1.600, fill: '#c3cad1' }),
  tag('ellipse', { cx: 22.5, cy: 12.5, rx: 5, ry: 3.6, fill: '#868f99', ...stroke(1.3, '#4a5058') }),
  tag('ellipse', { cx: 21.5, cy: 11.500, rx: 2.2, ry: 1, fill: '#b4bcc4' }),
]);
const frond = (deg) =>
  rot(
    tag('path', {
      d: 'M17 26 q-2 -10 0 -22 q2 3 1.500 6 l4 -2 l-3.500 5 l4.500 -1 l-4.500 5 l4 0 l-4.500 4.500 q-0.500 3 -1 4.500 z M17 26 q-0.500 -1.500 -1 -4.500 l-4.500 -4.500 l4 0 l-4.500 -5 l4.500 1 l-3.500 -5 l4 2 q-0.500 -3 1.500 -6',
      fill: '#3f8f3a',
      ...stroke(1.2, '#225c26'),
    }),
    deg,
    17,
    26,
  );
svg('decor_fern', 34, 28, [frond(-52), frond(52), frond(-18), frond(20)]);
svg('decor_leaves', 30, 18, [
  tag('path', { d: 'M3 10 q5 -7 12 -3 q-5 7 -12 3 z', fill: '#c9842f', ...stroke(1.1, '#6d4517') }),
  tag('path', { d: 'M16 13 q6 -5 11 0 q-6 5 -11 0 z', fill: '#a8672a', ...stroke(1.1, '#6d4517') }),
  tag('path', { d: 'M5 10 l8 -2 M18 13 l7 0', fill: 'none', ...stroke(0.9, '#6d4517') }),
]);

// ---------------------------------------------------------------- write
for (const [name, content] of Object.entries(files)) writeFileSync(join(OUT_DIR, name + '.svg'), content);
console.log(`wrote ${Object.keys(files).length} svg files to ${OUT_DIR}`);
