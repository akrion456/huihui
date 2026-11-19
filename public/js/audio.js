// Tiny synthesised sound effects (WebAudio) - no audio files needed.
import { S } from './state.js';
import { local } from './store.js';

let ac = null;
let master = null;
let noiseBuf = null;

function ctx() {
  if (S.muted) return null;
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ac = new AC();
    } catch {
      return null;
    }
    master = ac.createGain();
    master.gain.value = 0.5;
    master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac.state === 'running' ? ac : null;
}

/** Browsers only allow sound after a click / key press. */
export function unlockAudio() {
  ctx();
}

export function setMuted(m) {
  S.muted = m;
  local.set('wildwood.muted', m ? '1' : '0');
  if (master) master.gain.value = m ? 0 : 0.5;
}

function tone(a, { type = 'sine', f0, f1 = f0, dur, vol, at = 0, attack = 0.004 }) {
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.03);
}

function noise(a, { filter = 'bandpass', freq, q = 1, dur, vol, at = 0, f1 = freq }) {
  const t = a.currentTime + at;
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = a.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (f1 !== freq) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.03);
}

const SOUNDS = {
  chop(a, v) {
    noise(a, { freq: 520, q: 1.4, dur: 0.09, vol: 0.5 * v });
    tone(a, { f0: 190, f1: 85, dur: 0.1, vol: 0.5 * v });
  },
  mine(a, v) {
    noise(a, { freq: 2300, q: 2.5, dur: 0.06, vol: 0.4 * v });
    tone(a, { type: 'triangle', f0: 980, f1: 620, dur: 0.07, vol: 0.28 * v });
  },
  rustle(a, v) {
    noise(a, { filter: 'highpass', freq: 2600, dur: 0.11, vol: 0.16 * v });
  },
  swing(a, v) {
    noise(a, { freq: 900, f1: 2400, q: 0.8, dur: 0.1, vol: 0.07 * v });
  },
  hit(a, v) {
    noise(a, { filter: 'lowpass', freq: 700, dur: 0.1, vol: 0.5 * v });
    tone(a, { f0: 150, f1: 60, dur: 0.12, vol: 0.45 * v });
  },
  hurt(a, v) {
    tone(a, { type: 'sawtooth', f0: 250, f1: 105, dur: 0.2, vol: 0.22 * v });
    noise(a, { filter: 'lowpass', freq: 500, dur: 0.12, vol: 0.35 * v });
  },
  pickup(a, v) {
    tone(a, { f0: 620, f1: 980, dur: 0.08, vol: 0.2 * v });
  },
  eat(a, v) {
    for (let i = 0; i < 3; i++) noise(a, { freq: 900 + i * 150, q: 2, dur: 0.05, vol: 0.28 * v, at: i * 0.085 });
  },
  craft(a, v) {
    tone(a, { type: 'triangle', f0: 520, dur: 0.09, vol: 0.2 * v });
    tone(a, { type: 'triangle', f0: 780, dur: 0.14, vol: 0.2 * v, at: 0.08 });
  },
  build(a, v) {
    tone(a, { f0: 130, f1: 70, dur: 0.14, vol: 0.5 * v });
    noise(a, { freq: 400, q: 1, dur: 0.1, vol: 0.3 * v });
  },
  crash(a, v) {
    noise(a, { filter: 'lowpass', freq: 1500, f1: 300, dur: 0.32, vol: 0.5 * v });
    tone(a, { f0: 110, f1: 45, dur: 0.28, vol: 0.4 * v });
  },
  bow(a, v) {
    tone(a, { type: 'triangle', f0: 340, f1: 150, dur: 0.12, vol: 0.2 * v });
    noise(a, { filter: 'highpass', freq: 3000, dur: 0.08, vol: 0.09 * v });
  },
  deny(a, v) {
    tone(a, { type: 'square', f0: 130, dur: 0.1, vol: 0.09 * v });
  },
  fire(a, v) {
    noise(a, { filter: 'lowpass', freq: 900, f1: 2600, dur: 0.3, vol: 0.2 * v });
  },
  growl(a, v) {
    tone(a, { type: 'sawtooth', f0: 95, f1: 70, dur: 0.3, vol: 0.14 * v, attack: 0.05 });
    noise(a, { filter: 'lowpass', freq: 320, dur: 0.3, vol: 0.2 * v });
  },
  squeak(a, v) {
    tone(a, { type: 'triangle', f0: 880, f1: 520, dur: 0.14, vol: 0.14 * v });
  },
  howl(a, v) {
    const t = a.currentTime;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(290, t);
    o.frequency.linearRampToValueAtTime(520, t + 0.5);
    o.frequency.linearRampToValueAtTime(500, t + 1.2);
    o.frequency.linearRampToValueAtTime(330, t + 1.9);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.13 * v, t + 0.3);
    g.gain.linearRampToValueAtTime(0.11 * v, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 2.1);
  },
  dawn(a, v) {
    [523, 659, 784, 1047].forEach((f, i) => tone(a, { type: 'triangle', f0: f, dur: 0.3, vol: 0.14 * v, at: i * 0.13 }));
  },
  death(a, v) {
    [392, 330, 262, 196].forEach((f, i) => tone(a, { type: 'triangle', f0: f, dur: 0.34, vol: 0.2 * v, at: i * 0.2 }));
  },
  chat(a, v) {
    tone(a, { f0: 880, dur: 0.05, vol: 0.08 * v });
  },
  click(a, v) {
    tone(a, { type: 'triangle', f0: 420, dur: 0.04, vol: 0.1 * v });
  },
};

/**
 * Plays a sound. If a world position is given the volume drops with the
 * distance to the player.
 */
export function play(name, x, y) {
  const a = ctx();
  if (!a) return;
  let v = 1;
  if (x !== undefined && S.me) {
    const d = Math.hypot(x - S.me.x, y - S.me.y);
    if (d > 760) return;
    v = Math.max(0.12, 1 - d / 760);
  }
  try {
    SOUNDS[name](a, v);
  } catch {
    /* sound is never worth crashing for */
  }
}
