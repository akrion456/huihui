// Solo mode: there is no game server, the whole game runs inside this page.
//
// For the rest of the client this is just another connection: it has the same
// methods as Net (net.js). Behind it lives the very same simulation the server
// runs (../sim/game.js) and the same messages go back and forth - only the wire
// is missing. That is what lets the game be hosted as plain files, for example
// on GitHub Pages.
//
// The island is kept in the browser's storage, so the game goes on where it
// stopped. Only one survivor lives here, so the world can also stand still
// while nobody is looking (setPaused).
import { Game } from '../sim/game.js';
import { TICK_RATE, DAY_LENGTH } from '../shared/defs.js';
import { local } from './store.js';

const SAVE_KEY = 'wildwood.solo';
const SAVE_EVERY = 10000; // ms
const TOKEN = 'solo-player'; // how the simulation recognises the survivor of this island

/** What a real wire would deliver: a copy, with everything that is not JSON gone. */
const overTheWire = (obj) => JSON.parse(JSON.stringify(obj));

function readSave() {
  const raw = local.get(SAVE_KEY);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    return Game.canLoad(state) ? state : null;
  } catch {
    return null;
  }
}

/** Is the island kept when the page is closed? (not in some private windows and embedded frames) */
export const canSave = local.persistent;

/** For the start screen. @returns {{day: number}|null} the saved island, if there is one */
export function savedGame() {
  const state = readSave();
  return state ? { day: Math.floor(state.time / DAY_LENGTH) + 1 } : null;
}

/** Throws the saved island away; the next game starts on a new one. */
export function forgetSavedGame() {
  local.remove(SAVE_KEY);
}

export class LocalNet {
  /**
   * @param {{onMessage: (msg: object) => void, onOpen: () => void, onClose: () => void, onSaveProblem?: () => void}} handlers
   * @param {{cheats?: boolean, seed?: number}} [options]  seed: which island a new game gets
   */
  constructor(handlers, options = {}) {
    this.h = handlers;
    this.options = options;
    this.transport = 'local';
    this.open = false;
    this.gen = 0; // increases with every connect() and close(); stale callbacks are ignored
    /** @type {Game|null} */
    this.game = null;
    this.conn = null;
    this.inbox = []; // messages from the simulation that the client has not seen yet
    this.flushQueued = false;
    this.timer = 0;
    this.last = 0;

    // the simulation's clock stands still while the game is paused
    this.paused = false;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.clock = () => (this.paused ? this.pausedAt : performance.now()) - this.pausedTotal;

    this.dirty = false; // something happened since the last save
    this.savedAt = 0;
    this.stale = false; // another tab has taken over this island
    this.reloading = false;
    this.warned = false;

    window.addEventListener('pagehide', () => this.save());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save();
      else if (this.stale) this._startOver();
    });
    // The same island open in two tabs: both would save, and the older copy
    // would overwrite the newer one. Whoever saved last goes on; the other tab
    // stops saving and, as soon as somebody looks at it, starts again from the
    // saved island.
    window.addEventListener('storage', (e) => {
      if (e.key !== SAVE_KEY || !this.game) return;
      this.stale = true;
      if (!document.hidden) this._startOver();
    });
  }

  _startOver() {
    if (this.reloading) return;
    this.reloading = true;
    location.reload();
  }

  connect() {
    this.close(true);
    const gen = ++this.gen;
    // like a real connection: "open" is reported later, never from inside connect()
    setTimeout(() => {
      if (gen !== this.gen) return;
      try {
        if (!this.game) this.game = this._createGame();
      } catch (err) {
        console.error('the game could not be started', err);
        this.h.onClose();
        return;
      }
      this.conn = {
        player: null,
        closed: false,
        send: (obj) => this._deliver(gen, obj),
        sendVolatile: (obj) => this._deliver(gen, obj),
        close: () => {},
      };
      this.setPaused(false);
      this.open = true;
      this.last = this.clock();
      this.timer = setInterval(() => this._tick(), 1000 / TICK_RATE);
      this.h.onOpen();
    }, 0);
  }

  _createGame() {
    const opts = { log: () => {}, cheats: !!this.options.cheats, clock: this.clock };
    const state = readSave();
    if (state) {
      try {
        return new Game({ ...opts, state });
      } catch (err) {
        console.warn('the saved island could not be loaded, starting a new one', err);
      }
    }
    const seed = Number.isFinite(this.options.seed) ? this.options.seed : Math.floor(Math.random() * 0x7fffffff);
    return new Game({ ...opts, seed });
  }

  _tick() {
    if (this.paused || !this.open) return;
    const now = this.clock();
    const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    try {
      this.game.tick(dt);
    } catch (err) {
      console.error('error in game tick', err);
    }
    this.dirty = true;
    if (performance.now() - this.savedAt >= SAVE_EVERY) this.save();
  }

  /** Simulation -> client. Handed over right after the current piece of work, never in the middle of it. */
  _deliver(gen, obj) {
    if (gen !== this.gen) return;
    this.inbox.push(overTheWire(obj));
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const list = this.inbox;
      this.inbox = [];
      for (const msg of list) {
        if (gen !== this.gen) return;
        this.h.onMessage(msg);
      }
    });
  }

  /** Client -> simulation. */
  send(msg) {
    if (!this.open) return;
    const m = overTheWire(msg);
    if (m[0] === 'join') m[3] = TOKEN;
    try {
      this.game.handleMessage(this.conn, m);
    } catch (err) {
      console.error('error while handling', m[0], err);
    }
    this.dirty = true;
  }

  /** Stops (or restarts) the world. Used while the help is open or the tab is hidden. */
  setPaused(on) {
    on = !!on;
    if (on === this.paused) return;
    if (on) {
      this.pausedAt = performance.now();
      this.paused = true;
      this.save();
    } else {
      this.pausedTotal += performance.now() - this.pausedAt;
      this.paused = false;
      this.last = this.clock();
    }
  }

  /** Writes the island to the browser's storage. */
  save() {
    if (!this.game || !this.dirty || this.stale) return;
    this.dirty = false;
    this.savedAt = performance.now();
    let kept = false;
    try {
      kept = local.set(SAVE_KEY, JSON.stringify(this.game.exportState()));
    } catch (err) {
      console.error('the island could not be saved', err);
    }
    // the browser's storage is there but refused (full?): say so once
    if (!kept && canSave && !this.warned) {
      this.warned = true;
      if (this.h.onSaveProblem) this.h.onSaveProblem();
    }
  }

  close(silent = false) {
    this.gen++;
    const wasOpen = this.open;
    this.open = false;
    clearInterval(this.timer);
    this.inbox = [];
    if (wasOpen) {
      this.save(); // while the survivor is still in the world
      try {
        this.game.handleClose(this.conn);
      } catch (err) {
        console.error(err);
      }
    }
    this.conn = null;
    if (wasOpen && !silent) this.h.onClose();
  }
}
