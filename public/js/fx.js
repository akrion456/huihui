// Particles and floating texts.
const particles = [];
const texts = [];
const MAX_PARTICLES = 700;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const KINDS = {
  wood: { colors: ['#a8713d', '#7c4f27', '#c99a5b'], n: 6, size: [3, 6], speed: [40, 120], up: [90, 190], life: [0.35, 0.6], shape: 'rect' },
  stone: { colors: ['#9aa3ad', '#6f7882', '#c3cad1'], n: 6, size: [3, 6], speed: [40, 130], up: [80, 180], life: [0.35, 0.6], shape: 'rect' },
  leaf: { colors: ['#3f9a3c', '#5dbb4a', '#2f7d33'], n: 5, size: [4, 7], speed: [20, 70], up: [40, 120], life: [0.6, 1.1], shape: 'leaf', drag: 2.2, g: 260 },
  berry: { colors: ['#d92f3c', '#f05a5a', '#3f9a3c'], n: 5, size: [3, 5], speed: [30, 90], up: [70, 150], life: [0.35, 0.6], shape: 'circle' },
  blood: { colors: ['#c8303a', '#e2504f', '#9c1f2c'], n: 7, size: [3, 5], speed: [40, 150], up: [60, 170], life: [0.3, 0.55], shape: 'circle' },
  puff: { colors: ['#ffffff', '#e9e4d8', '#d7d2c4'], n: 9, size: [7, 13], speed: [20, 85], up: [10, 60], life: [0.35, 0.7], shape: 'circle', g: 0, grow: 1.6 },
  dust: { colors: ['#d8c9a0', '#c4b58c'], n: 5, size: [5, 9], speed: [15, 60], up: [5, 30], life: [0.3, 0.55], shape: 'circle', g: 0, grow: 1.4 },
  spark: { colors: ['#ffd45e', '#ff9a3d', '#ff6a2a'], n: 1, size: [2, 4], speed: [4, 22], up: [50, 110], life: [0.5, 1.1], shape: 'circle', g: -30 },
  smoke: { colors: ['#6b665f', '#857f76'], n: 1, size: [6, 10], speed: [3, 14], up: [26, 48], life: [1.1, 1.9], shape: 'circle', g: -8, grow: 1.9, alpha: 0.4 },
  splinter: { colors: ['#a8713d', '#7c4f27', '#c99a5b', '#e2c48a'], n: 14, size: [4, 9], speed: [50, 190], up: [100, 240], life: [0.45, 0.85], shape: 'rect' },
  rubble: { colors: ['#9aa3ad', '#6f7882', '#c3cad1'], n: 14, size: [4, 10], speed: [50, 180], up: [100, 230], life: [0.45, 0.85], shape: 'rect' },
  crumbs: { colors: ['#e9c46a', '#d98b4a', '#d92f3c'], n: 5, size: [2, 4], speed: [20, 60], up: [40, 90], life: [0.3, 0.5], shape: 'circle' },
};

/** Spawns a little burst of particles at (x, y); z = height above the ground. */
export function burst(kind, x, y, z = 14, scale = 1) {
  const k = KINDS[kind];
  const n = Math.max(1, Math.round(k.n * scale));
  for (let i = 0; i < n; i++) {
    if (particles.length >= MAX_PARTICLES) particles.shift();
    const a = rand(0, Math.PI * 2);
    const sp = rand(k.speed[0], k.speed[1]);
    const life = rand(k.life[0], k.life[1]);
    particles.push({
      x: x + rand(-4, 4), y: y + rand(-3, 3), z: z + rand(-4, 4),
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6, vz: rand(k.up[0], k.up[1]),
      g: k.g ?? 520, drag: k.drag ?? 0, grow: k.grow ?? 0, alpha: k.alpha ?? 1,
      size: rand(k.size[0], k.size[1]), color: pick(k.colors), shape: k.shape,
      life, max: life, rot: rand(0, 6.28), vr: rand(-9, 9),
    });
  }
}

/** Text that floats up and fades ("+3", damage numbers). */
export function floatText(x, y, text, color = '#ffffff', opts = {}) {
  if (texts.length > 60) texts.shift();
  texts.push({ x, y, text, color, life: opts.life ?? 1.1, max: opts.life ?? 1.1, icon: opts.icon || null, size: opts.size ?? 15, vy: opts.vy ?? -36 });
}

export function updateFx(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles[i] = particles[particles.length - 1];
      particles.pop();
      continue;
    }
    if (p.drag) {
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d;
      p.vy *= d;
    }
    p.vz -= p.g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (p.z < 0) {
      p.z = 0;
      p.vz = 0;
      p.vx *= 0.5;
      p.vy *= 0.5;
      p.vr = 0;
    }
    p.rot += p.vr * dt;
    if (p.grow) p.size += p.grow * p.size * dt;
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    t.life -= dt;
    t.y += t.vy * dt;
    t.vy *= Math.max(0, 1 - 1.6 * dt);
    if (t.life <= 0) texts.splice(i, 1);
  }
}

export function drawParticles(ctx, cam) {
  const l = cam.left - 20;
  const r = cam.left + cam.w + 20;
  const t = cam.top - 20;
  const b = cam.top + cam.h + 20;
  for (const p of particles) {
    if (p.x < l || p.x > r || p.y < t || p.y - p.z > b) continue;
    const f = p.life / p.max;
    ctx.globalAlpha = Math.min(1, f * 2.5) * p.alpha;
    ctx.fillStyle = p.color;
    const y = p.y - p.z;
    if (p.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(p.x, y, p.size / 2, 0, 6.2832);
      ctx.fill();
    } else {
      ctx.save();
      ctx.translate(p.x, y);
      ctx.rotate(p.rot);
      if (p.shape === 'leaf') {
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size / 2, p.size / 4, 0, 0, 6.2832);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      }
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

export function drawTexts(ctx, images) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const t of texts) {
    const f = t.life / t.max;
    ctx.globalAlpha = Math.min(1, f * 3);
    ctx.font = `800 ${t.size}px system-ui, "Segoe UI", sans-serif`;
    let x = t.x;
    if (t.icon && images[t.icon]) {
      const w = ctx.measureText(t.text).width;
      const s = t.size + 7;
      ctx.drawImage(images[t.icon], x + w / 2 - s / 2 + 2, t.y - s / 2, s, s);
      x -= s / 2;
    }
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(20, 16, 12, 0.85)';
    ctx.strokeText(t.text, x, t.y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, x, t.y);
  }
  ctx.globalAlpha = 1;
}

export function clearFx() {
  particles.length = 0;
  texts.length = 0;
}
