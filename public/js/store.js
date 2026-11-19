// Remembered settings (name, sound on/off, ...).
//
// Browser storage is not always there: in private windows, with site data
// blocked, or when the game runs inside a frame of another page (an embedded
// preview, an itch.io style portal) even *reading* window.localStorage can
// throw. The game must still start then - it simply forgets its settings when
// the page is closed.
function open(kind) {
  try {
    const s = window[kind];
    const probe = '__wildwood_probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function wrap(kind) {
  const real = open(kind);
  const memory = new Map();
  return {
    /** @returns {string|null} */
    get(key) {
      if (real) {
        try {
          return real.getItem(key);
        } catch {
          /* fall through to memory */
        }
      }
      return memory.has(key) ? memory.get(key) : null;
    },
    set(key, value) {
      memory.set(key, String(value));
      if (real) {
        try {
          real.setItem(key, String(value));
        } catch {
          /* storage full or denied: memory has it */
        }
      }
    },
    persistent: !!real,
  };
}

/** survives closing the browser */
export const local = wrap('localStorage');
/** lives as long as the tab */
export const session = wrap('sessionStorage');
