// Connection to the game server. WebSocket first; if that cannot be opened
// (some proxies block it) the same messages travel over plain HTTP polling.

import { session } from './store.js';

const WS_OPEN_TIMEOUT = 4500;
const POLL_INTERVAL = 55;

export class Net {
  /**
   * @param {{onMessage: (msg: object) => void, onOpen: () => void, onClose: () => void}} handlers
   */
  constructor(handlers) {
    this.h = handlers;
    this.transport = null; // 'ws' | 'poll'
    this.open = false;
    this.ws = null;
    this.sid = null;
    this.outbox = [];
    this.gen = 0; // increases with every connect(); stale callbacks are ignored
    const forced = new URLSearchParams(location.search).get('transport');
    this.forcePoll = forced === 'poll' || session.get('wildwood.poll') === '1';
    window.addEventListener('pagehide', () => this._bye());
  }

  connect() {
    this.close(true);
    const gen = ++this.gen;
    if (this.forcePoll || typeof WebSocket === 'undefined') {
      this._startPoll(gen);
      return;
    }
    const url = new URL('ws', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
    url.hash = '';
    let ws;
    try {
      ws = new WebSocket(url.href);
    } catch {
      this._startPoll(gen);
      return;
    }
    this.ws = ws;
    let opened = false;
    const fallback = () => {
      if (gen !== this.gen || opened) return;
      // never got through: use polling from now on
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.forcePoll = true;
      session.set('wildwood.poll', '1');
      this._startPoll(gen);
    };
    const timer = setTimeout(fallback, WS_OPEN_TIMEOUT);
    ws.onopen = () => {
      if (gen !== this.gen) return;
      opened = true;
      clearTimeout(timer);
      this.transport = 'ws';
      this.open = true;
      this.h.onOpen();
    };
    ws.onmessage = (e) => {
      if (gen !== this.gen) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.h.onMessage(msg);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (gen !== this.gen) return;
      clearTimeout(timer);
      if (!opened) {
        fallback();
        return;
      }
      this.open = false;
      this.ws = null;
      this.h.onClose();
    };
  }

  _startPoll(gen) {
    this.transport = 'poll';
    this.sid = null;
    this.outbox = [];
    this.pollUrl = new URL('api/poll', location.href);
    this.pollUrl.search = '';
    this.pollUrl.hash = '';
    this.open = true;
    this.h.onOpen();
    this._pollLoop(gen);
  }

  async _pollLoop(gen) {
    let failures = 0;
    while (gen === this.gen && this.open) {
      const m = this.outbox;
      this.outbox = [];
      const started = performance.now();
      try {
        const res = await fetch(this.pollUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ s: this.sid, m }),
          cache: 'no-store',
        });
        if (gen !== this.gen) return;
        if (res.status === 410) failures = 99; // the server forgot this session
        if (!res.ok) throw new Error(`poll ${res.status}`);
        const data = await res.json();
        if (gen !== this.gen) return;
        this.sid = data.s;
        failures = 0;
        for (const msg of data.m) this.h.onMessage(msg);
      } catch {
        if (gen !== this.gen) return;
        if (++failures >= 3 || this.sid === null) {
          this.open = false;
          this.h.onClose();
          return;
        }
        this.outbox = m.concat(this.outbox);
      }
      const wait = POLL_INTERVAL - (performance.now() - started);
      await new Promise((r) => setTimeout(r, Math.max(8, wait)));
    }
  }

  send(msg) {
    if (!this.open) return;
    if (this.transport === 'ws') {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
    }
  }

  _bye() {
    if (this.transport === 'poll' && this.open && this.sid && navigator.sendBeacon) {
      navigator.sendBeacon(this.pollUrl, JSON.stringify({ s: this.sid, bye: true }));
    }
  }

  close(silent = false) {
    this.gen++;
    const wasOpen = this.open;
    this.open = false;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    } else if (this.transport === 'poll' && wasOpen && this.sid) {
      fetch(this.pollUrl, { method: 'POST', body: JSON.stringify({ s: this.sid, bye: true }), keepalive: true }).catch(() => {});
    }
    this.sid = null;
    if (wasOpen && !silent) this.h.onClose();
  }
}
