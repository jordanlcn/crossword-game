'use strict';
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => e.append(k));
  return e;
};
const pad2 = (n) => String(n).padStart(2, '0');
function fmtMs(ms) {
  if (ms == null) return '-';
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || (res.status >= 500 || res.status === 404
      ? `The game server did not respond correctly (HTTP ${res.status}). If the site was just updated or is waking up, wait a minute and try again.`
      : `Request failed (HTTP ${res.status})`);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}

// WebSocket with auto-reconnect. onMessage(msg); onAuthFail() when the server rejects the token.
function connect(query, onMessage, onAuthFail, onStatus) {
  let stop = false, cur = null;
  function open() {
    const ws = cur = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${query}`);
    ws.onopen = () => onStatus && onStatus(true);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data), ws);
    ws.onclose = (e) => {
      if (stop) return;
      if (onStatus && e.code !== 4001 && e.code !== 4002) onStatus(false);
      if (e.code === 4001) return onAuthFail && onAuthFail();
      if (e.code === 4002) return;
      setTimeout(open, 2000);
    };
  }
  open();
  return { send: (m) => cur && cur.readyState === 1 && cur.send(JSON.stringify(m)), stop: () => { stop = true; cur.close(); } };
}

// ----- shared grid renderer -----
const cellKey = (r, c) => r + ',' + c;
function entryCells(e) {
  const out = [];
  for (let i = 0; i < e.len; i++) out.push(cellKey(e.r + (e.dir === 'D' ? i : 0), e.c + (e.dir === 'A' ? i : 0)));
  return out;
}

function buildGrid(container, puzzle, { readOnly = false, onCellClick } = {}) {
  const cells = new Map(); // key -> {div, letterEl, entries:[ids], r, c}
  const byId = new Map(puzzle.entries.map((e) => [e.id, e]));
  for (const e of puzzle.entries) {
    entryCells(e).forEach((k, i) => {
      if (!cells.has(k)) {
        const [r, c] = k.split(',').map(Number);
        const div = el('div', { className: 'cell' + (readOnly ? ' ro' : '') });
        div.style.gridRow = r + 1; div.style.gridColumn = c + 1;
        const letter = el('span');
        div.append(letter);
        div.onclick = () => onCellClick && onCellClick(k);
        cells.set(k, { div, letter, entries: [], r, c, ch: '' });
      }
      cells.get(k).entries.push(e.id);
      if (i === 0) {
        const cell = cells.get(k);
        if (!cell.num) { cell.num = e.num; cell.div.prepend(el('span', { className: 'n', textContent: e.num })); }
      }
    });
  }
  container.innerHTML = '';
  container.classList.add('grid');
  container.style.gridTemplateColumns = `repeat(${puzzle.cols}, var(--cell))`;
  container.style.gridTemplateRows = `repeat(${puzzle.rows}, var(--cell))`;
  cells.forEach((c) => container.append(c.div));
  return {
    cells, byId,
    setLetter(k, ch) { const c = cells.get(k); if (c) { c.ch = ch || ''; c.letter.textContent = c.ch; } },
    clear() { cells.forEach((c) => { c.ch = ''; c.letter.textContent = ''; c.div.classList.remove('solved', 'hl', 'cur', 'wrong'); }); },
    markSolved(id) { entryCells(byId.get(id)).forEach((k) => cells.get(k).div.classList.add('solved')); },
    highlight(id, cur) {
      cells.forEach((c) => c.div.classList.remove('hl', 'cur'));
      if (id == null) return;
      entryCells(byId.get(id)).forEach((k) => cells.get(k).div.classList.add('hl'));
      if (cur && cells.get(cur)) cells.get(cur).div.classList.add('cur');
    },
    isSolvedCell(k) { return cells.get(k).div.classList.contains('solved'); },
  };
}

function setZoom(container, delta) {
  const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell')) || 30;
  document.documentElement.style.setProperty('--cell', Math.min(56, Math.max(16, cur + delta)) + 'px');
}
function zoomBar() {
  return el('div', { className: 'zoom' }, el('span', { className: 'muted', textContent: 'Zoom' }),
    el('button', { className: 'sec', textContent: '−', onclick: () => setZoom(null, -4) }),
    el('button', { className: 'sec', textContent: '+', onclick: () => setZoom(null, 4) }));
}

// Renders Across / Down clue lists. getState(e) -> {done, answer}. onPick(id)
function buildClues(container, puzzle, onPick) {
  container.innerHTML = '';
  const items = new Map();
  for (const [dir, title] of [['A', 'Across'], ['D', 'Down']]) {
    container.append(el('h3', { textContent: title }));
    puzzle.entries.filter((e) => e.dir === dir).sort((a, b) => a.num - b.num).forEach((e) => {
      const row = el('div', { className: 'clue', onclick: () => onPick(e.id) },
        el('b', { textContent: e.num + '.' }), el('span', { className: 't', textContent: `${e.clue} (${e.enum})` }));
      container.append(row);
      items.set(e.id, row);
    });
  }
  return {
    items,
    active(id) { items.forEach((r, k) => r.classList.toggle('active', k === id)); if (items.get(id)) items.get(id).scrollIntoView({ block: 'nearest' }); },
    done(id, answer) {
      const r = items.get(id); r.classList.add('done');
      if (answer && !r.querySelector('.a')) r.append(el('span', { className: 'a', textContent: '✓ ' + answer }));
    },
    reset() { items.forEach((r) => { r.classList.remove('done', 'active'); const a = r.querySelector('.a'); if (a) a.remove(); }); },
  };
}

function logoutTo(page, ...keys) { keys.forEach((k) => localStorage.removeItem(k)); location.href = page; }
