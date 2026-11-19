// The solo game without a browser: public/js/local.js (the "connection" that
// runs the simulation inside the page) against a made-up page.   node test/solo.mjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
function ok(cond, what) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
}

// ---- the few things of a browser page that local.js and store.js touch
const makeStorage = () => {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
};
const storage = makeStorage();
const listeners = {};
const listen = (target) => (type, fn) => {
  (listeners[`${target}.${type}`] ||= []).push(fn);
};
const fire = (name, event = {}) => {
  for (const fn of listeners[name] || []) fn(event);
};
let reloads = 0;
globalThis.window = { localStorage: storage, sessionStorage: makeStorage(), addEventListener: listen('window') };
globalThis.document = { hidden: false, addEventListener: listen('document') };
globalThis.location = { reload: () => reloads++ };
/** As if the page had been loaded again: the old page's listeners are gone, the storage stays. */
const newPage = () => {
  for (const name of Object.keys(listeners)) delete listeners[name];
  document.hidden = false;
};

const { LocalNet, savedGame, forgetSavedGame, canSave } = await import('../public/js/local.js');
const KEY = 'wildwood.solo';

/** A client: collects what the "connection" delivers. */
function client(options) {
  const c = { opened: 0, closed: 0, init: null, snaps: [], events: [] };
  c.net = new LocalNet({
    onOpen: () => c.opened++,
    onClose: () => c.closed++,
    onMessage: (m) => {
      if (m.t === 'init') c.init = m;
      else if (m.t === 's') c.snaps.push(m);
      else if (m.t === 'e') c.events.push(...m.ev);
    },
  }, options);
  return c;
}
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(10);
  return cond();
};

console.log('a new island');
ok(canSave === true && savedGame() === null, 'nothing saved yet');
const a = client({ seed: 12345 });
a.net.connect();
ok(a.opened === 0 && a.net.open === false, 'connect() returns before the connection is open');
ok(await until(() => a.opened === 1), 'then it opens');
a.net.send(['join', 'Ann', 1, 'the-token-of-this-tab']);
ok(a.init === null, 'send() returns before the answer arrives');
ok(await until(() => a.init), 'then the world arrives');
ok(a.init.objs.length === 879 && a.init.you.resumed === false && a.net.game.seed === 12345, 'island 12345 with its 879 objects');
const me = [...a.net.game.players.values()][0];
ok(me.name === 'Ann' && me.token === 'solo-player', 'the survivor is known as the one of this island');
const before = a.snaps.length;
await sleep(1000);
const got = a.snaps.length - before;
ok(got >= 14 && got <= 24, `about 20 snapshots per second (${got})`);
ok(a.snaps.every((s, i) => i === 0 || s.n > a.snaps[i - 1].n), 'their clock runs forward');
ok(a.transport === undefined && a.net.transport === 'local', 'transport "local"');
a.net.send(['m', a.init.you.x + 20, a.init.you.y, 0, a.init.you.epoch]);
ok(Math.abs(me.x - (a.init.you.x + 20)) < 15, 'a move reaches the simulation at once');
ok(a.net.inbox.every((m) => m !== null) && JSON.stringify(a.init).length > 10000 && !Object.isFrozen(a.init), 'messages are plain copies');

console.log('pause');
a.net.setPaused(true);
await sleep(60);
const t0 = a.net.game.time;
const n0 = a.net.game.now();
const s0 = a.snaps.length;
const lastN = a.snaps[a.snaps.length - 1].n;
await sleep(400);
ok(a.net.game.time === t0 && a.snaps.length === s0, 'the world stands still');
ok(a.net.game.now() === n0, 'and so does its clock');
a.net.setPaused(false);
ok(await until(() => a.snaps.length > s0), 'it goes on');
const gap = a.snaps[s0].n - lastN;
ok(gap > 0 && gap < 150, `without a jump in time (${gap} ms after a 400 ms pause)`);

console.log('saving');
const saved1 = JSON.parse(storage.getItem(KEY));
ok(saved1 && saved1.v === 1 && saved1.seed === 12345 && !!saved1.players['solo-player'], 'pausing saved the island');
ok(savedGame() && savedGame().day === 1, 'the start screen can show "day 1"');
a.net.send(['m', me.x + 15, me.y, 0, me.epoch]);
document.hidden = true;
fire('document.visibilitychange');
const saved2 = JSON.parse(storage.getItem(KEY));
ok(Math.abs(saved2.players['solo-player'].x - me.x) < 0.01 && saved2.players['solo-player'].x !== saved1.players['solo-player'].x, 'hiding the page saves again');
document.hidden = false;
fire('document.visibilitychange');
const raw = storage.getItem(KEY);
fire('window.pagehide');
ok(storage.getItem(KEY) === raw, 'nothing happened since: no needless write');
const pos = { x: me.x, y: me.y, time: a.net.game.time };

console.log('coming back');
a.net.close(true);
const s1 = a.snaps.length;
await sleep(200);
ok(a.snaps.length === s1 && a.closed === 0, 'a closed game is silent');
newPage();
const b = client({ seed: 777 }); // the seed only counts for a new island
b.net.connect();
await until(() => b.opened === 1);
b.net.send(['join', '', 3, 'another-token']);
await until(() => b.init);
const me2 = [...b.net.game.players.values()][0];
ok(b.net.game.seed === 12345 && b.init.you.resumed === true, 'the same island, the survivor continues');
ok(Math.abs(b.init.you.x - pos.x) < 0.5 && Math.abs(b.init.you.y - pos.y) < 0.5, 'at the same place');
ok(me2.name === 'Ann' && me2.skin === 3, 'no name typed: the old name is kept');
ok(b.net.game.time >= pos.time && b.net.game.time < pos.time + 0.5, 'time went on where it stopped');

console.log('the same island in another tab');
const mine = storage.getItem(KEY);
fire('window.storage', { key: 'something.else' });
ok(b.net.stale === false, 'other keys do not matter');
storage.setItem(KEY, mine.replace('"seed":12345', '"seed":12346')); // the other tab saved
document.hidden = true;
fire('window.storage', { key: KEY });
ok(b.net.stale === true && reloads === 0, 'a hidden tab only remembers that it is out of date');
b.net.send(['m', me2.x + 10, me2.y, 0, me2.epoch]);
b.net.save();
fire('window.pagehide');
ok(JSON.parse(storage.getItem(KEY)).seed === 12346, 'and never saves over the newer island');
document.hidden = false;
fire('document.visibilitychange');
fire('window.storage', { key: KEY });
ok(reloads === 1, 'when it is looked at again it starts over, once');
b.net.close(true);

console.log('throwing the island away, unreadable saves');
forgetSavedGame();
ok(storage.getItem(KEY) === null && savedGame() === null, 'forgotten');
for (const junk of ['{not json', '{"v":99,"seed":1,"time":5,"objects":[]}', 'null', '[]', '{"v":1,"seed":1,"time":-5,"objects":[]}']) {
  storage.setItem(KEY, junk);
  if (savedGame() !== null) ok(false, `"${junk}" is not offered to continue`);
}
ok(savedGame() === null, 'unreadable saves are not offered');
newPage();
const c = client();
c.net.connect();
await until(() => c.opened === 1);
c.net.send(['join', 'Cy', 0, null]);
await until(() => c.init);
ok(c.init.you.resumed === false && c.init.objs.length > 600 && Number.isInteger(c.net.game.seed), `a new island instead (seed ${c.net.game.seed})`);
c.net.setPaused(true);
ok(JSON.parse(storage.getItem(KEY)).seed === c.net.game.seed, 'which replaces the unreadable save');
c.net.close();
ok(c.closed === 1, 'close() reports the end');

console.log(failed ? `\n${failed} of ${passed + failed} checks FAILED` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
