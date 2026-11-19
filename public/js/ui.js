// Everything that is HTML: bars, hotbar, crafting, chat, minimap, screens.
import { ITEMS, RECIPES, OBJECTS, INV_SIZE, SKIN_COUNT, clockText, phaseOf, nightAmount } from '../shared/defs.js';
import { S } from './state.js';
import { local } from './store.js';
import { assetUrl, itemIcon } from './assets.js';
import { play } from './audio.js';

const $ = (id) => document.getElementById(id);
let actions = null;
const slots = [];
const recipeEls = [];
const canCraft = [];
let lastBars = [-1, -1, -1];
let hudTimer = 0;
let mapTimer = 0;
let tipIndex = 0;
let tipDoneAt = 0;
let drag = null;
let dragGhost = null;
let tooltipFor = null;
let vigFlash = 0;
let vigShown = 0;
let vigColor = '';
let lastHint = '';

// ---------------------------------------------------------------------------
// start screen
// ---------------------------------------------------------------------------
export function initJoin(onPlay) {
  const nameEl = $('name');
  nameEl.value = local.get('wildwood.name') || '';
  let skin = Number(local.get('wildwood.skin') || Math.floor(Math.random() * SKIN_COUNT)) % SKIN_COUNT;
  const box = $('skins');
  for (let i = 0; i < SKIN_COUNT; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `skin${i === skin ? ' sel' : ''}`;
    b.innerHTML = `<img src="${assetUrl(`p${i + 1}_0`)}" alt="survivor ${i + 1}">`;
    b.addEventListener('click', () => {
      skin = i;
      box.querySelectorAll('.skin').forEach((el, j) => el.classList.toggle('sel', j === i));
      play('click');
    });
    box.appendChild(b);
  }
  const start = (e) => {
    e.preventDefault();
    if ($('play').disabled) return;
    const name = nameEl.value.trim();
    local.set('wildwood.name', name);
    local.set('wildwood.skin', String(skin));
    onPlay(name, skin);
  };
  // The form's "submit" event alone is not enough: when the game is shown inside
  // a sandboxed frame of another page, the browser may never send it.
  $('play').addEventListener('click', start);
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) start(e);
  });
  $('join-card').addEventListener('submit', start);
  if (!S.touch) nameEl.focus();
}

export function setLoading(frac) {
  $('progress').firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}

let playLabel = 'PLAY';

export function setJoinState(state, text, label) {
  const btn = $('play');
  const status = $('status');
  status.classList.toggle('err', state === 'error');
  if (label) playLabel = label;
  if (state === 'ready' || state === 'error') {
    btn.disabled = false;
    btn.textContent = playLabel;
    $('progress').classList.add('hidden');
  } else if (state === 'connecting') {
    btn.disabled = true;
    btn.textContent = 'Entering the forest…';
  }
  if (text !== undefined) status.textContent = text || '\u00a0';
}

let disarmTimer = 0;

/**
 * Start screen of the solo game. With a saved island the player can go on with
 * it or throw it away; throwing away needs a second click.
 * @param {{hasSave: boolean, canSave: boolean, onNewIsland: () => void}} o
 */
export function setSoloMenu({ hasSave, canSave, onNewIsland }) {
  document.body.classList.add('solo');
  $('tagline').textContent = 'Gather, craft, build and survive the nights.';
  $('solo-note').textContent = `Solo game: the world waits while this help is open.${canSave ? ' Your island is saved in this browser.' : ''}`;
  const btn = $('new-island');
  const disarm = () => {
    clearTimeout(disarmTimer);
    btn.classList.remove('armed');
    btn.textContent = 'Start a new island';
  };
  disarm();
  btn.classList.toggle('hidden', !hasSave);
  btn.onclick = () => {
    play('click');
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = `${S.touch ? 'Tap' : 'Click'} again to delete the old island`;
      disarmTimer = setTimeout(disarm, 5000); // changed your mind? it forgets the first click
      return;
    }
    disarm();
    onNewIsland();
  };
}

export function showGame(show) {
  $('join').classList.toggle('hidden', show);
  $('hud').classList.toggle('hidden', !show);
  if (show && document.activeElement) document.activeElement.blur();
}

// ---------------------------------------------------------------------------
// HUD setup
// ---------------------------------------------------------------------------
export function initUI(a) {
  actions = a;
  initHotbar();
  initCraft();
  $('respawn').addEventListener('click', () => actions.respawn());
  $('help-close').addEventListener('click', () => showHelp(false));
  $('btn-help').addEventListener('click', () => showHelp($('help').classList.contains('hidden')));
  $('btn-sound').addEventListener('click', () => actions.toggleSound());
  $('btn-sound').classList.toggle('off', S.muted);
  $('help').addEventListener('pointerdown', (e) => {
    if (e.target === $('help')) showHelp(false);
  });
}

function slotIndexAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const slot = el && el.closest ? el.closest('.slot') : null;
  return slot ? Number(slot.dataset.i) : -1;
}

function initHotbar() {
  const bar = $('hotbar');
  for (let i = 0; i < INV_SIZE; i++) {
    const el = document.createElement('div');
    el.className = `slot${i >= 8 ? ' back' : ''}`;
    el.dataset.i = i;
    el.innerHTML = `${i < 8 ? `<span class="key">${i + 1}</span>` : ''}<img alt="" hidden><span class="count"></span>`;
    bar.appendChild(el);
    slots.push({ el, img: el.querySelector('img'), count: el.querySelector('.count'), id: null, n: 0 });
    el.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && !drag) showSlotTip(i, el);
    });
    el.addEventListener('pointerleave', () => hideTooltip(el));
  }
  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const i = slotIndexAt(e.clientX, e.clientY);
    if (i >= 0) actions.drop(i, e.shiftKey);
  });
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const i = slotIndexAt(e.clientX, e.clientY);
    if (i < 0) return;
    e.preventDefault();
    drag = { from: i, x: e.clientX, y: e.clientY, active: false };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  });
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 7) return;
    const s = S.me && S.me.inv[drag.from];
    if (!s) return;
    drag.active = true;
    hideTooltip();
    dragGhost = document.createElement('img');
    dragGhost.id = 'drag-ghost';
    dragGhost.src = assetUrl(itemIcon(s.id));
    document.body.appendChild(dragGhost);
  }
  dragGhost.style.left = `${e.clientX}px`;
  dragGhost.style.top = `${e.clientY}px`;
  const over = slotIndexAt(e.clientX, e.clientY);
  slots.forEach((sl, i) => sl.el.classList.toggle('over', i === over && i !== drag.from));
}

function onDragEnd(e) {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  if (!drag) return;
  const d = drag;
  drag = null;
  slots.forEach((sl) => sl.el.classList.remove('over'));
  if (!d.active) {
    if (e.type === 'pointerup') actions.select(d.from);
    return;
  }
  if (dragGhost) dragGhost.remove();
  dragGhost = null;
  if (e.type !== 'pointerup') return;
  const to = slotIndexAt(e.clientX, e.clientY);
  if (to >= 0) {
    if (to !== d.from) actions.swap(d.from, to);
  } else {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.id === 'game') actions.drop(d.from, true);
  }
}

function initCraft() {
  const box = $('recipes');
  RECIPES.forEach((r, i) => {
    const b = document.createElement('button');
    b.className = 'recipe';
    b.type = 'button';
    const icon = r.equip ? 'armor' : itemIcon(r.out);
    b.innerHTML = `<img src="${assetUrl(icon)}" alt="">${r.n > 1 ? `<span class="n">×${r.n}</span>` : ''}`;
    b.addEventListener('pointerenter', (e) => {
      showRecipeTip(i, b);
      if (e.pointerType !== 'mouse') setTimeout(() => hideTooltip(b), 2600);
    });
    b.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') hideTooltip(b);
    });
    b.addEventListener('click', (e) => {
      b.blur();
      if (!canCraft[i]) {
        play('deny');
        showRecipeTip(i, b);
        return;
      }
      actions.craft(i, e.shiftKey ? 5 : 1);
    });
    box.appendChild(b);
    recipeEls.push(b);
    canCraft.push(false);
  });
}

// ---------------------------------------------------------------------------
// tooltip
// ---------------------------------------------------------------------------
function placeTooltip(anchor, html) {
  const tip = $('tooltip');
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  tooltipFor = anchor;
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let x = a.right + 10;
  let y = a.top;
  if (x + t.width > window.innerWidth - 6) {
    // no room on the right: show it above
    x = Math.max(6, Math.min(window.innerWidth - t.width - 6, a.left + a.width / 2 - t.width / 2));
    y = a.top - t.height - 10;
  }
  y = Math.max(6, Math.min(window.innerHeight - t.height - 6, y));
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
}

export function hideTooltip(anchor) {
  if (anchor && tooltipFor !== anchor) return;
  tooltipFor = null;
  $('tooltip').classList.add('hidden');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function countItem(id) {
  let n = 0;
  if (S.me) for (const s of S.me.inv) if (s && s.id === id) n += s.n;
  return n;
}

function recipeTipHtml(i) {
  const r = RECIPES[i];
  const name = r.name || ITEMS[r.out].name;
  const desc = r.desc || ITEMS[r.out].desc;
  let html = `<b class="name">${esc(name)}${r.n > 1 ? ` ×${r.n}` : ''}</b><div class="desc">${esc(desc)}</div><div class="cost">`;
  for (const [id, need] of Object.entries(r.cost)) {
    const have = countItem(id);
    html += `<span class="${have >= need ? 'ok' : 'no'}"><img src="${assetUrl(itemIcon(id))}" alt="">${Math.min(have, 999)}/${need} ${esc(ITEMS[id].name)}</span>`;
  }
  html += '</div>';
  if (r.near === 'fire') {
    const ok = S.me && S.me.bits & 8;
    html += `<div class="req ${ok ? 'ok' : 'no'}">${ok ? '✓ Fire nearby' : '✗ Stand next to a burning fire'}</div>`;
  }
  if (r.equip === 'armor' && S.me && S.me.bits & 1) html += '<div class="req no">You already wear it</div>';
  return html;
}

function showRecipeTip(i, el) {
  placeTooltip(el, recipeTipHtml(i));
  el.dataset.tip = `r${i}`;
}

function showSlotTip(i, el) {
  const s = S.me && S.me.inv[i];
  if (!s) return;
  const it = ITEMS[s.id];
  placeTooltip(el, `<b class="name">${esc(it.name)}</b><div class="desc">${esc(it.desc)}</div><div class="desc" style="margin:0">Drag to move · right-click to drop</div>`);
}

// ---------------------------------------------------------------------------
// inventory + crafting state
// ---------------------------------------------------------------------------
export function refreshInventory() {
  const me = S.me;
  if (!me) return;
  for (let i = 0; i < INV_SIZE; i++) {
    const s = me.inv[i];
    const sl = slots[i];
    const id = s ? s.id : null;
    const n = s ? s.n : 0;
    if (id !== sl.id) {
      if (id) {
        sl.img.src = assetUrl(itemIcon(id));
        sl.img.hidden = false;
      } else {
        sl.img.hidden = true;
      }
    }
    if (id && (id !== sl.id || n > sl.n)) {
      sl.el.classList.remove('bump');
      void sl.el.offsetWidth; // restart the animation
      sl.el.classList.add('bump');
    }
    if (n !== sl.n || id !== sl.id) sl.count.textContent = n > 1 ? n : '';
    sl.id = id;
    sl.n = n;
    sl.el.classList.toggle('sel', i === me.sel);
  }
  refreshCraft();
}

export function refreshCraft() {
  const me = S.me;
  if (!me) return;
  RECIPES.forEach((r, i) => {
    let ok = true;
    for (const [id, need] of Object.entries(r.cost)) if (countItem(id) < need) ok = false;
    if (r.near === 'fire' && !(me.bits & 8)) ok = false;
    if (r.equip === 'armor' && me.bits & 1) ok = false;
    if (ok !== canCraft[i]) {
      canCraft[i] = ok;
      recipeEls[i].classList.toggle('can', ok);
    }
  });
  if (tooltipFor && tooltipFor.dataset && tooltipFor.dataset.tip) {
    const i = Number(tooltipFor.dataset.tip.slice(1));
    $('tooltip').innerHTML = recipeTipHtml(i);
  }
}

export function flashRecipe(i) {
  const el = recipeEls[i];
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------------------------------------------------------------------------
// chat + toasts
// ---------------------------------------------------------------------------
export function addChat(name, text, cls = '') {
  const log = $('chat-log');
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  if (name) {
    const b = document.createElement('b');
    b.textContent = `${name}: `;
    el.appendChild(b);
  }
  el.appendChild(document.createTextNode(text));
  log.appendChild(el);
  while (log.children.length > 60) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  setTimeout(() => el.classList.add('old'), 14000);
}

export function setChatOpen(open) {
  const box = $('chat');
  const inp = $('chat-input');
  box.classList.toggle('open', open);
  if (open) {
    inp.value = '';
    inp.focus();
    const log = $('chat-log');
    log.scrollTop = log.scrollHeight;
  } else {
    inp.blur();
  }
}

export const chatIsOpen = () => $('chat').classList.contains('open');

const toastTimes = new Map();
export function toast(text, cls = '') {
  const box = $('toasts');
  const now = performance.now();
  if (now - (toastTimes.get(text) || -1e9) < 1200) return; // do not spam
  toastTimes.set(text, now);
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  const life = cls === 'big' ? 3200 : 2200;
  setTimeout(() => el.classList.add('out'), life);
  setTimeout(() => el.remove(), life + 450);
}

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------
const CAUSES = {
  hunger: 'You starved',
  cold: 'You froze to death',
  wolf: 'Eaten by a wolf',
  dire: 'Torn apart by a dire wolf',
  bear: 'Mauled by a bear',
  boar: 'Trampled by a boar',
};

export function showDeath(cause, days, kills) {
  $('death-title').textContent = CAUSES[cause] || 'You died';
  $('death-stats').textContent = `Survived ${days.toFixed(1)} day${days === 1 ? '' : 's'} · ${kills} animal${kills === 1 ? '' : 's'} hunted`;
  const btn = $('respawn');
  btn.disabled = true;
  $('death').classList.remove('hidden');
  setTimeout(() => {
    btn.disabled = false;
  }, 1300);
}

export function hideDeath() {
  $('death').classList.add('hidden');
}

export function showHelp(show) {
  $('help').classList.toggle('hidden', !show);
  if (!show) local.set('wildwood.help', '1');
}

export const helpIsOpen = () => !$('help').classList.contains('hidden');

export function showLost(show, text) {
  $('lost').classList.toggle('hidden', !show);
  if (text) $('lost-text').textContent = text;
}

export function setSoundButton() {
  $('btn-sound').classList.toggle('off', S.muted);
}

export function hurtFlash(strength = 1) {
  vigFlash = Math.max(vigFlash, strength);
}

// ---------------------------------------------------------------------------
// leaderboard
// ---------------------------------------------------------------------------
export function refreshBoard() {
  const list = $('board-list');
  const rows = [...S.board].sort((a, b) => b[5] - a[5] || b[1] - a[1]);
  $('online').textContent = `(${rows.length})`;
  let html = '';
  for (const [id, days10, , , , alive] of rows.slice(0, 8)) {
    const info = S.roster.get(id);
    if (!info) continue;
    const me = S.me && id === S.me.id;
    html += `<div class="row${me ? ' me' : ''}${alive ? '' : ' dead'}"><img src="${assetUrl(`p${info.skin + 1}_0`)}" alt=""><span class="nm">${esc(info.name)}</span><span class="dy">${(days10 / 10).toFixed(1)} d</span></div>`;
  }
  if (rows.length > 8) html += `<div class="row"><span class="dy">+${rows.length - 8} more</span></div>`;
  list.innerHTML = html;
}

// ---------------------------------------------------------------------------
// first steps
// ---------------------------------------------------------------------------
const has = (id) => countItem(id) > 0;
const TIPS = [
  { text: 'Hit a tree to collect wood - aim with the mouse and hold the button', touch: 'Walk up to a tree and hold ACT to collect wood', done: () => countItem('wood') >= 5 || has('axe') },
  { text: 'Now hit a rock to collect some stone', done: () => countItem('stone') >= 4 || has('axe') || has('pickaxe') },
  { text: 'Craft an axe: click it in the panel on the left (8 wood, 4 stone)', touch: 'Craft an axe: tap it in the panel on the left (8 wood, 4 stone)', done: () => S.stats.crafted.axe || has('axe') },
  { text: 'Hungry? Hit a berry bush, select the berries and click to eat', touch: 'Hungry? Hit a berry bush, tap the berries in your bag, then ACT to eat', done: () => S.stats.ate },
  { text: 'Nights are deadly. Craft a campfire (12 wood, 6 stone)', done: () => S.stats.crafted.campfire || has('campfire') || S.stats.placed.campfire },
  { text: 'Select the campfire and click on the ground to place it', touch: 'Tap the campfire in your bag, then tap the ground to place it', done: () => S.stats.placed.campfire },
  { text: 'Stay near a fire at night - wolves fear it. Press E to feed it wood', touch: 'Stay near a fire at night - wolves fear it. Tap E to feed it wood', done: () => S.stats.dawns > 0 },
  { text: 'Hunt for meat and hides, cook at a fire, build walls and a tent. Good luck!', done: () => performance.now() - tipDoneAt > 20000 },
];

/** Is the player inside the circle that wolves do not dare to enter? */
function nearFire() {
  const me = S.me;
  for (const f of S.fires) {
    if (!f.state) continue;
    const r = OBJECTS[f.type].fear - 10;
    if ((f.x - me.x) ** 2 + (f.y - me.y) ** 2 < r * r) return true;
  }
  return false;
}

function updateTip() {
  const el = $('tip');
  if (!S.me || tipIndex >= TIPS.length) {
    el.classList.add('hidden');
    return;
  }
  let changed = false;
  while (tipIndex < TIPS.length && TIPS[tipIndex].done()) {
    tipIndex++;
    tipDoneAt = performance.now();
    changed = true;
  }
  if (tipIndex >= TIPS.length) {
    el.classList.add('hidden');
    return;
  }
  const tip = TIPS[tipIndex];
  let text = (S.touch && tip.touch) || tip.text;
  // newcomers who arrive in the dark: the most important rule first
  const warn = nightAmount(S.tod) > 0.4 && S.me.alive && !nearFire();
  if (warn) text = 'It is night - wolves hunt in the dark. Get back into the light of a fire!';
  el.classList.toggle('warn', warn);
  if (changed || el.textContent !== text) {
    el.textContent = text;
    el.classList.remove('hidden');
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }
}

// ---------------------------------------------------------------------------
// per frame
// ---------------------------------------------------------------------------
export function updateHud(dt) {
  const me = S.me;
  if (!me) return;

  // screen edge colour: red when hurt / dying, blue when freezing
  vigFlash = Math.max(0, vigFlash - dt * 2.2);
  let op = vigFlash * 0.75;
  let color = 'rgba(200, 20, 20, 0.65)';
  if (me.alive) {
    if (me.hp < 30) op = Math.max(op, 0.3 + 0.2 * Math.sin(S.time * 5));
    if (op < 0.05 && me.warmth < 30) {
      color = 'rgba(120, 190, 255, 0.7)';
      op = ((30 - me.warmth) / 30) * 0.75;
    }
  }
  if (Math.abs(op - vigShown) > 0.01 || color !== vigColor) {
    const v = $('vignette');
    if (color !== vigColor) v.style.setProperty('--vig', color);
    v.style.opacity = op.toFixed(2);
    vigShown = op;
    vigColor = color;
  }

  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.2;
    const vals = [me.hp, me.hunger, me.warmth];
    const bars = document.querySelectorAll('#bars .bar');
    vals.forEach((v, i) => {
      const r = Math.round(v);
      if (r === lastBars[i]) return;
      lastBars[i] = r;
      bars[i].querySelector('.fill').style.width = `${Math.max(0, Math.min(100, v))}%`;
      bars[i].classList.toggle('low', v < 25);
      if (i === 2) bars[i].classList.toggle('cold', v < 45);
    });
    $('day-label').textContent = `Day ${S.day}`;
    $('time-label').textContent = clockText(S.tod);
    $('phase-dot').className = phaseOf(S.tod);
    $('cycle-mark').style.left = `${(S.tod * 100).toFixed(1)}%`;
    $('netinfo').textContent = S.solo ? 'solo' : S.ping ? `${Math.round(S.ping)} ms` : '';
    updateTip();
    const hint = S.hint ? S.hint.text : '';
    if (hint !== lastHint) {
      lastHint = hint;
      $('hint').textContent = hint;
      $('hint').classList.toggle('hidden', !hint);
      $('t-e').classList.toggle('hidden', !hint);
    }
  }

  mapTimer -= dt;
  if (mapTimer <= 0) {
    mapTimer = 0.25;
    drawMinimap();
  }
}

function drawMinimap() {
  const cv = $('minimap');
  const g = cv.getContext('2d');
  const w = S.world;
  if (!w || !S.terrain) return;
  const size = cv.width;
  const k = size / w.pxW;
  g.imageSmoothingEnabled = false;
  g.drawImage(S.terrain.minimap, 0, 0, size, size);
  // buildings
  for (const o of S.fires) {
    g.fillStyle = o.state ? '#ff9a3d' : '#6b665f';
    g.beginPath();
    g.arc(o.x * k, o.y * k, o.type === 'bonfire' ? 7 : 4, 0, 6.2832);
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = '#1f1712';
    g.stroke();
  }
  for (const o of S.tents) {
    g.fillStyle = '#b07a45';
    g.strokeStyle = '#1f1712';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(o.x * k, o.y * k - 6);
    g.lineTo(o.x * k + 6, o.y * k + 4);
    g.lineTo(o.x * k - 6, o.y * k + 4);
    g.closePath();
    g.fill();
    g.stroke();
  }
  const me = S.me;
  g.lineWidth = 2;
  g.strokeStyle = '#1f1712';
  for (const [id, , , x, y, alive] of S.board) {
    if (!alive || (me && id === me.id)) continue;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(x * k, y * k, 4.5, 0, 6.2832);
    g.fill();
    g.stroke();
  }
  if (me) {
    // the part of the world on screen
    const cam = S.cam;
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1.5;
    g.strokeRect(cam.left * k, cam.top * k, cam.w * k, cam.h * k);
    g.fillStyle = '#ffd45e';
    g.strokeStyle = '#1f1712';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(me.x * k, me.y * k, 6, 0, 6.2832);
    g.fill();
    g.stroke();
  }
}
