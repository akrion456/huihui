// End-to-end smoke test: starts a real server and plays the game with headless
// clients (WebSocket and the HTTP polling fallback).   npm test
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, sleep } from './bot.mjs';
import { OBJ_IDS, ITEM_INDEX, PLAYER_R, SPAWN_SAFE_RADIUS } from '../shared/defs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;

let failed = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failed++;
    console.log(`  FAIL ${label}`);
  }
};

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + '/api/status');
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not start:\n' + serverLog);
}

async function main() {
  await waitForServer();

  console.log('static files');
  for (const f of ['/', '/js/main.js', '/shared/defs.js', '/assets/tree_pine.png']) {
    const res = await fetch(BASE + f);
    ok(res.ok, `GET ${f} -> ${res.status}`);
  }
  ok((await fetch(BASE + '/%2e%2e/package.json')).status === 404, 'encoded path traversal -> 404');

  console.log('join');
  const a = await new Bot(BASE, 'Alice', { skin: 0 }).connect();
  ok(a.init.tiles.length === a.init.w * a.init.h, 'init carries the full tile map');
  ok(a.world.objects.size > 500, `world has ${a.world.objects.size} objects`);
  ok(a.me.alive && a.me.hp === 100, 'player starts alive with full health');
  const [sx, sy] = a.init.spawn;
  ok(Math.hypot(a.me.x - sx, a.me.y - sy) < 200, 'spawned next to the Great Fire');
  await sleep(300);
  ok(a.snapshots >= 3, `receiving snapshots (${a.snapshots})`);

  console.log('second player + chat');
  const b = await new Bot(BASE, 'Bob', { skin: 1 }).connect();
  await sleep(300);
  ok(a.players.has(b.me.id), 'Alice was told that Bob joined');
  ok(b.players.has(a.me.id), 'Bob knows Alice from init');
  ok(a.near.p.some((p) => p[0] === b.me.id), 'Alice sees Bob in snapshots');
  const heard = a.waitFor((e) => e[0] === 'chat' && e[3] === 'hello forest', 3000, 'chat');
  b.chat('hello forest');
  ok(!!(await heard.catch(() => null)), 'chat message arrives');

  console.log('movement');
  const x0 = a.me.x;
  await a.walkTo(a.me.x + 120, a.me.y + 40, 4, 4000);
  await sleep(200);
  const seen = b.near.p.find((p) => p[0] === a.me.id);
  ok(seen && Math.hypot(seen[1] - a.me.x, seen[2] - a.me.y) < 12 && Math.abs(a.me.x - x0) > 50, 'Bob sees Alice at her new position');
  const tp = a.waitFor((e) => e[0] === 'tp', 3000, 'tp');
  a.send(['m', a.me.x + 3000, a.me.y, 0, a.me.epoch]);
  const corr = await tp.catch(() => null);
  ok(!!corr && Math.abs(corr[1] - a.me.x) < 400, 'speed hack is corrected by the server');

  console.log('gathering + crafting');
  ok(await a.gather('wood', 22, 40000), `gathered wood (${a.count('wood')})`);
  ok(await a.gather('stone', 10, 40000), `gathered stone (${a.count('stone')})`);
  a.craft('axe');
  await a.waitFor((e) => e[0] === 'crafted', 3000, 'crafted').catch(() => null);
  await sleep(150);
  ok(a.count('axe') === 1 && a.count('wood') === 14 && a.count('stone') === 6, 'crafted an axe (materials were consumed)');
  a.select('axe');
  const before = a.count('wood');
  const tree = a.nearest((o) => o.type.startsWith('tree') && o.state === 0);
  await a.harvest(tree, () => a.count('wood') >= before + 3, 1);
  await sleep(300);
  ok(a.count('wood') === before + 3, 'the axe chops 3 wood per hit');
  a.craft('spear'); // needs 12 wood + 5 stone
  await sleep(300);
  ok(a.count('spear') === 1, 'crafted a spear');
  a.craft('tent'); // no hides
  const t = await a.waitFor((e) => e[0] === 'toast', 2000, 'toast').catch(() => null);
  ok(t && /Not enough/.test(t[1]), 'crafting without materials is refused');

  console.log('building');
  await a.gather('wood', 14, 40000);
  await a.gather('stone', 6, 40000);
  a.craft('campfire');
  await sleep(300);
  ok(a.count('campfire') === 1, 'crafted a campfire');
  a.select('campfire');
  // too close to the Great Fire?
  if (Math.hypot(a.me.x - sx, a.me.y - sy) < SPAWN_SAFE_RADIUS + 200) {
    const ang = Math.atan2(a.me.y - sy, a.me.x - sx);
    await a.walkTo(sx + Math.cos(ang) * (SPAWN_SAFE_RADIUS + 260), sy + Math.sin(ang) * (SPAWN_SAFE_RADIUS + 260), 30, 12000);
  }
  let placed = null;
  for (let i = 0; i < 12 && !placed; i++) {
    const ang = (i / 12) * Math.PI * 2;
    const added = a.waitFor((e) => e[0] === 'o+' && OBJ_IDS[e[2]] === 'campfire', 700, 'o+').catch(() => null);
    a.use(ang, a.me.x + Math.cos(ang) * 70, a.me.y + Math.sin(ang) * 70);
    placed = await added;
  }
  ok(!!placed, 'placed a campfire');
  await sleep(200);
  ok(a.count('campfire') === 0, 'campfire item was used up');
  ok((a.me.bits & 4) !== 0, 'standing at the fire counts as warm');
  const fire = placed && b.world.objects.get(placed[1]);
  ok(!!fire && fire.state === 1, 'Bob sees the burning campfire too');
  if (placed) {
    const fueled = a.waitFor((e) => e[0] === 'ou' && e[1] === placed[1], 2000, 'ou').catch(() => null);
    const w = a.count('wood');
    a.send(['e']);
    await fueled;
    await sleep(150);
    ok(a.count('wood') === w - 1, 'feeding the fire costs one wood');
  }

  console.log('items');
  a.select('wood');
  const slot = a.slotOf('wood');
  const had = a.count('wood');
  a.send(['d', slot, false]);
  await sleep(300);
  ok(a.count('wood') === had - 1, 'dropped one wood');
  const lying = a.near.i.find((d) => d[1] === ITEM_INDEX.wood);
  ok(!!lying, 'the dropped wood lies on the ground');
  await sleep(1700); // the dropper cannot grab it back at once
  if (lying) await a.walkTo(lying[2], lying[3], 6, 3000);
  await sleep(300);
  ok(a.count('wood') === had, 'walking over an item picks it up');
  await a.gather('berries', 2, 30000);
  if (a.count('berries') > 0) {
    const hungerBefore = a.me.hunger;
    a.select('berries');
    a.use(0);
    await sleep(400);
    ok(a.me.hunger > hungerBefore, 'eating berries restores hunger');
  } else {
    ok(false, 'found berries');
  }

  console.log('HTTP polling fallback');
  const c = await new Bot(BASE, 'Carol', { transport: 'poll' }).connect();
  await sleep(600);
  ok(c.snapshots >= 3, `polling client receives snapshots (${c.snapshots})`);
  await c.walkTo(c.me.x + 60, c.me.y, 4, 3000);
  await sleep(300);
  const carol = b.near.p.find((p) => p[0] === c.me.id);
  ok(!!carol && Math.hypot(carol[1] - c.me.x, carol[2] - c.me.y) < 14, 'polling client can move');
  await c.close();
  await sleep(300);
  ok(!b.players.has(c.me.id), 'polling client leaves cleanly');

  console.log('reconnect');
  const inv = JSON.stringify(a.me.inv);
  const pos = [a.me.x, a.me.y];
  await a.close();
  await sleep(300);
  ok(!b.players.has(a.me.id), 'Bob was told that Alice left');
  const a2 = await new Bot(BASE, 'Alice', { token: a.token }).connect();
  ok(a2.init.you.resumed === true, 'session is resumed with the same token');
  ok(JSON.stringify(a2.me.inv) === inv, 'inventory survived the reconnect');
  ok(Math.hypot(a2.me.x - pos[0], a2.me.y - pos[1]) < PLAYER_R * 2, 'position survived the reconnect');

  await a2.close();
  await b.close();
}

main()
  .catch((err) => {
    failed++;
    console.error(err);
  })
  .finally(() => {
    server.kill();
    if (failed) {
      console.log(`\n${failed} check(s) failed`);
      if (process.env.VERBOSE) console.log(serverLog);
      process.exit(1);
    }
    console.log('\nall checks passed');
    process.exit(0);
  });
