// Keyboard, mouse and touch.
import { S } from './state.js';
import { unlockAudio } from './audio.js';

export const input = {
  up: false, down: false, left: false, right: false,
  mx: window.innerWidth / 2, my: window.innerHeight / 2, // pointer position (CSS px)
  fire: false, // primary button held on the game canvas
  space: false,
  clicked: false, // set once per press, cleared by the game
  joyX: 0, joyY: 0, // touch joystick, -1..1
  touchUse: false,
};

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};

const typing = (e) => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

export function releaseAll() {
  input.up = input.down = input.left = input.right = false;
  input.fire = input.space = input.touchUse = false;
  input.joyX = input.joyY = 0;
}

/**
 * @param {object} a  callbacks: select(i), cycle(dir), interact(), dropSelected(all), chatOpen(),
 *                    chatSend(text), chatClose(), help(), sound(), escape(), respawn(), isPlaying()
 */
export function initInput(a) {
  const canvas = document.getElementById('game');
  const chatInput = document.getElementById('chat-input');

  window.addEventListener('keydown', (e) => {
    unlockAudio();
    if (e.target === chatInput) {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        a.chatSend(chatInput.value);
      } else if (e.code === 'Escape') {
        e.preventDefault();
        a.chatClose();
      }
      e.stopPropagation();
      return;
    }
    if (typing(e) || !a.isPlaying()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const dir = KEYMAP[e.code];
    if (dir) {
      input[dir] = true;
      e.preventDefault();
      return;
    }
    if (e.repeat) {
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
      return;
    }
    if (/^Digit[1-8]$/.test(e.code)) {
      a.select(Number(e.code.slice(5)) - 1);
    } else if (/^Numpad[1-8]$/.test(e.code)) {
      a.select(Number(e.code.slice(6)) - 1);
    } else {
      switch (e.code) {
        case 'Space':
          input.space = true;
          input.clicked = true;
          e.preventDefault();
          break;
        case 'KeyE': case 'KeyF': a.interact(); break;
        case 'KeyQ': a.dropSelected(e.shiftKey); break;
        case 'Enter': case 'NumpadEnter': case 'KeyT':
          e.preventDefault();
          a.chatOpen();
          break;
        case 'KeyH': a.help(); break;
        case 'KeyM': a.sound(); break;
        case 'KeyR': a.respawn(); break;
        case 'Escape': a.escape(); break;
        case 'Tab': e.preventDefault(); break;
        default: break;
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    const dir = KEYMAP[e.code];
    if (dir) input[dir] = false;
    if (e.code === 'Space') input.space = false;
  });

  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });

  // ---- mouse
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    input.mx = e.clientX;
    input.my = e.clientY;
  });
  canvas.addEventListener('pointerdown', (e) => {
    unlockAudio();
    if (e.pointerType === 'touch') {
      // tapping the world: aim there and act
      S.touch || enableTouch();
      input.mx = e.clientX;
      input.my = e.clientY;
      S.touchAimUntil = performance.now() + 900;
      input.fire = true;
      input.clicked = true;
      return;
    }
    if (e.button !== 0) return;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    input.mx = e.clientX;
    input.my = e.clientY;
    input.fire = true;
    input.clicked = true;
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && input.fire) {
      input.mx = e.clientX;
      input.my = e.clientY;
      S.touchAimUntil = performance.now() + 900;
    }
  });
  const up = (e) => {
    if (e.pointerType === 'touch' || e.button === 0) input.fire = false;
  };
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener(
    'wheel',
    (e) => {
      if (!a.isPlaying() || typing(e)) return;
      if (e.target !== canvas) return;
      a.cycle(e.deltaY > 0 ? 1 : -1);
    },
    { passive: true },
  );

  // ---- touch controls
  function enableTouch() {
    if (S.touch) return;
    S.touch = true;
    document.body.classList.add('touch');
    document.getElementById('touch').classList.remove('hidden');
  }
  window.addEventListener('touchstart', enableTouch, { passive: true, once: true });

  const zone = document.getElementById('stick-zone');
  const base = document.getElementById('stick-base');
  const knob = document.getElementById('stick-knob');
  let stickId = null;
  let sx = 0;
  let sy = 0;
  const setKnob = (dx, dy) => {
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  zone.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    const r = zone.getBoundingClientRect();
    sx = e.clientX;
    sy = e.clientY;
    base.style.left = `${sx - r.left - 56}px`;
    base.style.bottom = 'auto';
    base.style.top = `${sy - r.top - 56}px`;
    setKnob(0, 0);
    e.preventDefault();
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - sx;
    let dy = e.clientY - sy;
    const d = Math.hypot(dx, dy);
    const max = 46;
    if (d > max) {
      dx *= max / d;
      dy *= max / d;
    }
    setKnob(dx, dy);
    input.joyX = Math.abs(dx) < 6 ? 0 : dx / max;
    input.joyY = Math.abs(dy) < 6 ? 0 : dy / max;
  });
  const stickEnd = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    input.joyX = input.joyY = 0;
    setKnob(0, 0);
  };
  zone.addEventListener('pointerup', stickEnd);
  zone.addEventListener('pointercancel', stickEnd);

  const useBtn = document.getElementById('t-use');
  useBtn.addEventListener('pointerdown', (e) => {
    unlockAudio();
    input.touchUse = true;
    input.clicked = true;
    e.preventDefault();
  });
  const useEnd = () => {
    input.touchUse = false;
  };
  useBtn.addEventListener('pointerup', useEnd);
  useBtn.addEventListener('pointercancel', useEnd);
  useBtn.addEventListener('pointerleave', useEnd);
  document.getElementById('t-e').addEventListener('click', () => a.interact());
  document.getElementById('t-chat').addEventListener('click', () => a.chatOpen());
}
