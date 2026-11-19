// Wildwood server: serves the browser client, accepts players over WebSocket
// (with a plain HTTP polling fallback for networks that block WebSockets) and
// runs the game simulation.
//
// The simulation itself (public/sim/) and the game rules (public/shared/) live
// inside the web root, because the browser can run them as well: without this
// server the page plays alone ("solo mode", see public/js/local.js).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Game } from '../public/sim/game.js';
import { TICK_RATE } from '../public/shared/defs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SEED = process.env.SEED ? Number(process.env.SEED) : 12345;

const game = new Game({
  seed: SEED,
  // optional tuning, handy for demos and tests: DAY_LENGTH=120 START_TOD=0.5 npm start
  dayLength: process.env.DAY_LENGTH ? Number(process.env.DAY_LENGTH) : undefined,
  startTod: process.env.START_TOD ? Number(process.env.START_TOD) : undefined,
  cheats: process.env.CHEATS === '1',
});

// ----------------------------------------------------------------------------
// static files
// ----------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const MOUNTS = [['/', path.join(ROOT, 'public')]];
const fileCache = new Map(); // absolute path -> { etag, body, gz }

async function serveStatic(req, res, pathname) {
  let rel = pathname;
  let base = null;
  for (const [prefix, dir] of MOUNTS) {
    if (rel.startsWith(prefix)) {
      base = dir;
      rel = rel.slice(prefix.length);
      break;
    }
  }
  if (!base) return false;
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(base, rel));
  if (file !== base && !file.startsWith(base + path.sep)) return false;
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const etag = `"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  let entry = fileCache.get(file);
  if (!entry || entry.etag !== etag) {
    const body = await readFile(file);
    entry = { etag, body, gz: null };
    if (/^(text\/|application\/json|image\/svg)/.test(type) && body.length > 1024) entry.gz = gzipSync(body);
    fileCache.set(file, entry);
  }
  let body = entry.body;
  if (entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = entry.gz;
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

// ----------------------------------------------------------------------------
// connections
// ----------------------------------------------------------------------------
function deliver(conn, msg) {
  try {
    game.handleMessage(conn, msg);
  } catch (err) {
    console.error('error while handling message', msg && msg[0], err);
  }
}

function closeConn(conn) {
  if (conn.closed) return;
  conn.closed = true;
  try {
    game.handleClose(conn);
  } catch (err) {
    console.error('error while closing connection', err);
  }
}

// --- HTTP polling fallback: POST /api/poll  {s: sessionId|null, m: [messages]}
const pollSessions = new Map();
const POLL_TIMEOUT = 10000;

class PollConn {
  constructor() {
    this.id = randomBytes(12).toString('hex');
    this.out = [];
    this.volatile = null;
    this.lastSeen = Date.now();
    this.player = null;
    this.closed = false;
  }

  send(obj) {
    if (this.closed) return;
    this.out.push(JSON.stringify(obj));
    if (this.out.length > 4000) this.close();
  }

  sendVolatile(obj) {
    if (!this.closed) this.volatile = JSON.stringify(obj); // only the newest snapshot matters
  }

  close() {
    pollSessions.delete(this.id);
    closeConn(this);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const c of pollSessions.values()) if (now - c.lastSeen > POLL_TIMEOUT) c.close();
}, 2000).unref();

function handlePoll(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 65536) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      res.writeHead(400).end();
      return;
    }
    let conn = typeof data.s === 'string' ? pollSessions.get(data.s) : null;
    if (!conn) {
      if (data.s) {
        // unknown / expired session: the client has to join again
        res.writeHead(410, { 'Content-Type': 'application/json' }).end('{"gone":true}');
        return;
      }
      conn = new PollConn();
      pollSessions.set(conn.id, conn);
    }
    conn.lastSeen = Date.now();
    if (Array.isArray(data.m)) for (const m of data.m.slice(0, 64)) deliver(conn, m);
    if (data.bye) {
      conn.close();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"m":[]}');
      return;
    }
    const out = conn.out;
    conn.out = [];
    if (conn.volatile) {
      out.push(conn.volatile);
      conn.volatile = null;
    }
    const body = `{"s":"${conn.id}","m":[${out.join(',')}]}`;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  req.on('error', () => {});
}

// ----------------------------------------------------------------------------
// http server
// ----------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    // The game keeps no cookies or logins, so any page may load it. This lets it
    // run embedded in other sites, including sandboxed preview frames (where the
    // browser treats even the game's own files as "another origin").
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/api/poll' && req.method === 'POST') {
      handlePoll(req, res);
      return;
    }
    if (pathname === '/api/status') {
      const body = JSON.stringify({ players: game.players.size, day: game.day, phase: game.phase, animals: game.mobs.size });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, pathname))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  } catch (err) {
    console.error('http error', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// --- WebSocket transport
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  const conn = {
    player: null,
    closed: false,
    alive: true,
    send(obj) {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    },
    sendVolatile(obj) {
      // snapshots are skipped while the socket is congested
      if (ws.readyState === 1 && ws.bufferedAmount < 128 * 1024) ws.send(JSON.stringify(obj));
    },
    close() {
      ws.terminate();
    },
  };
  ws.conn = conn;
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    deliver(conn, msg);
  });
  ws.on('pong', () => {
    conn.alive = true;
  });
  ws.on('close', () => closeConn(conn));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.conn.alive) {
      ws.terminate();
      continue;
    }
    ws.conn.alive = false;
    ws.ping();
  }
}, 15000).unref();

// ----------------------------------------------------------------------------
// game loop
// ----------------------------------------------------------------------------
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  try {
    game.tick(dt);
  } catch (err) {
    console.error('error in game tick', err);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, HOST, () => {
  console.log(`Wildwood is running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
