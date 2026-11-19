// The one shared client-side game state object.
import { local } from './store.js';

export const S = {
  phase: 'loading', // loading | menu | connecting | playing
  net: null, // Net (a game server) or LocalNet (solo game)
  solo: false, // no game server: the game runs in this page
  paused: false, // solo game only: the world stands still
  debug: new URLSearchParams(location.search).has('debug'),

  // world
  world: null, // World (../shared/physics.js) holding trees, rocks, buildings...
  terrain: null,
  spawn: { x: 0, y: 0 },
  fires: new Set(), // campfires + the Great Fire (light sources)
  tents: new Set(),
  tod: 0.1,
  todBase: 0.1,
  day: 1,
  dayLength: 450,
  todAt: 0, // performance.now() when tod was last received
  phaseName: 'day',

  // me
  me: null,
  roster: new Map(), // id -> {name, skin}
  board: [], // [[id, days*10, kills, x, y, alive]]

  // things around me, interpolated from server snapshots
  others: new Map(),
  mobs: new Map(),
  drops: new Map(),
  arrows: new Map(),
  bubbles: new Map(), // player id -> {text, until}

  // timing
  now: 0, // performance.now() of the current frame
  time: 0, // seconds since page load (animations)
  serverOffset: 0, // server clock - performance.now()
  haveOffset: false,
  renderDelay: 110,
  ping: 0,

  cam: { x: 0, y: 0, left: 0, top: 0, w: 1280, h: 720, scale: 1, shake: 0 },
  ghost: null, // build preview {type, x, y, ok}
  hint: null, // interaction hint {text, obj}
  muted: local.get('wildwood.muted') === '1',
  touch: false,
  touchAimUntil: 0, // a tap on the world overrides the automatic aim for a moment
  stats: { ate: false, crafted: {}, placed: {}, dawns: 0 }, // for the "first steps" tips
};

window.__wild = S; // handy for debugging and automated tests
