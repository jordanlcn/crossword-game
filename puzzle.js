'use strict';
// Crossword generator: places every word in one grid (crossing wherever possible).

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (w) => w.toUpperCase().replace(/[^A-Z]/g, '');
const enumeration = (w) =>
  w.trim().split(/[\s\-\/]+/).map((p) => norm(p).length).filter((n) => n > 0).join(',');
const key = (r, c) => r + ',' + c;

function attempt(words, rnd) {
  const cells = new Map(); // "r,c" -> {r,c,ch,a,d}
  const byLetter = new Map();
  const placed = [];
  let minR = 0, maxR = 0, minC = 0, maxC = 0, first = true;

  function check(w, r, c, dir) {
    const dr = dir === 'D' ? 1 : 0, dc = dir === 'A' ? 1 : 0, L = w.text.length;
    if (cells.has(key(r - dr, c - dc)) || cells.has(key(r + dr * L, c + dc * L))) return -1;
    let cross = 0;
    for (let i = 0; i < L; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      const cell = cells.get(key(rr, cc));
      if (cell) {
        if (cell.ch !== w.text[i]) return -1;
        if (dir === 'A' ? cell.a != null : cell.d != null) return -1;
        cross++;
      } else if (cells.has(key(rr + dc, cc + dr)) || cells.has(key(rr - dc, cc - dr))) {
        return -1;
      }
    }
    return cross;
  }

  function put(w, r, c, dir) {
    const dr = dir === 'D' ? 1 : 0, dc = dir === 'A' ? 1 : 0;
    for (let i = 0; i < w.text.length; i++) {
      const rr = r + dr * i, cc = c + dc * i, k = key(rr, cc);
      let cell = cells.get(k);
      if (!cell) {
        cell = { r: rr, c: cc, ch: w.text[i], a: null, d: null };
        cells.set(k, cell);
        if (!byLetter.has(cell.ch)) byLetter.set(cell.ch, []);
        byLetter.get(cell.ch).push(cell);
      }
      if (dir === 'A') cell.a = w.id; else cell.d = w.id;
    }
    const er = r + dr * (w.text.length - 1), ec = c + dc * (w.text.length - 1);
    if (first) { minR = r; maxR = er; minC = c; maxC = ec; first = false; }
    else { minR = Math.min(minR, r); maxR = Math.max(maxR, er); minC = Math.min(minC, c); maxC = Math.max(maxC, ec); }
    placed.push({ id: w.id, r, c, dir, len: w.text.length });
  }

  const order = words.slice().sort((a, b) => b.text.length - a.text.length + (rnd() - 0.5) * 6);
  put(order[0], 0, 0, 'A');
  let pending = order.slice(1);

  for (let pass = 0; pass < 6 && pending.length; pass++) {
    const next = [];
    for (const w of pending) {
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < w.text.length; i++) {
        for (const cell of byLetter.get(w.text[i]) || []) {
          for (const dir of ['A', 'D']) {
            if (dir === 'A' ? cell.a != null : cell.d != null) continue;
            const r = dir === 'D' ? cell.r - i : cell.r, c = dir === 'A' ? cell.c - i : cell.c;
            const cross = check(w, r, c, dir);
            if (cross < 1) continue;
            const er = r + (dir === 'D' ? w.text.length - 1 : 0), ec = c + (dir === 'A' ? w.text.length - 1 : 0);
            const h = Math.max(maxR, er) - Math.min(minR, r) + 1, wd = Math.max(maxC, ec) - Math.min(minC, c) + 1;
            const oh = maxR - minR + 1, ow = maxC - minC + 1;
            const score = cross * 6 - (h * wd - oh * ow) / 8 - Math.abs(h - wd) * 0.3 + rnd() * 2.5;
            if (score > bestScore) { bestScore = score; best = { r, c, dir }; }
          }
        }
      }
      if (best) put(w, best.r, best.c, best.dir); else next.push(w);
    }
    if (next.length === pending.length) break;
    pending = next;
  }

  // Safety net: anything that could not cross is placed on its own row below the grid.
  let leftovers = pending.length;
  let row = maxR + 2;
  for (const w of pending) { put(w, row, minC, 'A'); row += 2; }

  return { cells, placed, leftovers, h: maxR - minR + 1, w: maxC - minC + 1, minR, minC };
}

function generate(items, seed, budgetMs = 4000) {
  // items: [{word, clue, hints}] -> puzzle with entries
  const words = items.map((it, i) => ({ id: i + 1, text: norm(it.word) }));
  const rnd = mulberry32(seed);
  const t0 = Date.now();
  let best = null;
  for (let n = 0; n < 80 && (n < 5 || Date.now() - t0 < budgetMs); n++) {
    const res = attempt(words, rnd);
    const cost = res.leftovers * 100000 + res.h * res.w + Math.abs(res.h - res.w) * 10;
    if (!best || cost < best.cost) best = { res, cost };
  }
  const { res } = best;
  const rows = res.h, cols = res.w;
  const entries = res.placed.map((p) => {
    const it = items[p.id - 1];
    return {
      id: p.id, dir: p.dir, r: p.r - res.minR, c: p.c - res.minC, len: p.len,
      enum: enumeration(it.word), clue: it.clue, answer: words[p.id - 1].text, hints: it.hints || [],
    };
  });
  // Standard crossword numbering: row-major over start cells.
  const starts = new Map();
  entries.sort((a, b) => a.r - b.r || a.c - b.c || (a.dir === 'A' ? -1 : 1));
  let n = 0;
  for (const e of entries) {
    const k = key(e.r, e.c);
    if (!starts.has(k)) starts.set(k, ++n);
    e.num = starts.get(k);
  }
  return { rows, cols, entries, leftovers: res.leftovers };
}

module.exports = { generate, norm };
