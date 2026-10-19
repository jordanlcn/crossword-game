'use strict';
// Renders a team's crossword board (their letters + solved words) as a WebP image.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const LOGO = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(__dirname, 'public', 'five9-logo-blue.svg')).toString('base64');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FONT = "'Silka','Segoe UI','DejaVu Sans',Arial,sans-serif";
const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };

function cellKeysOf(e) {
  const out = [];
  for (let i = 0; i < e.len; i++) out.push(`${e.r + (e.dir === 'D' ? i : 0)},${e.c + (e.dir === 'A' ? i : 0)}`);
  return out;
}

function boardSvg(room, teamName, label) {
  const t = room.teams[teamName];
  const p = room.puzzle, S = 30, M = 24, H = 112;
  const W = Math.max(p.cols * S + M * 2, 640), Ht = H + p.rows * S + M;
  const solvedKeys = new Set(), numbers = new Map(), cells = new Set();
  for (const e of p.entries) {
    const ks = cellKeysOf(e);
    ks.forEach((k) => cells.add(k));
    if (!numbers.has(ks[0])) numbers.set(ks[0], e.num);
    if (t && t.solved[e.id]) ks.forEach((k) => solvedKeys.add(k));
  }
  const score = t ? Object.keys(t.solved).length : 0;
  const last = t && t.lastCorrectAt && t.startedAt ? fmt(t.lastCorrectAt - t.startedAt) : '-';
  const ox = Math.round((W - p.cols * S) / 2);
  let g = '';
  for (const k of cells) {
    const [r, c] = k.split(',').map(Number);
    const x = ox + c * S, y = H + r * S, solved = solvedKeys.has(k), ch = t && t.cells[k];
    g += `<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="${solved ? '#2A4CF9' : '#FFFFFF'}" stroke="${solved ? '#192A52' : '#757F97'}" stroke-width="1"/>`;
    if (numbers.has(k)) g += `<text x="${x + 2}" y="${y + 9}" font-size="8" fill="${solved ? '#DBE2F1' : '#757F97'}">${numbers.get(k)}</text>`;
    if (ch) g += `<text x="${x + S / 2}" y="${y + S / 2 + 6}" font-size="17" font-weight="700" text-anchor="middle" fill="${solved ? '#FFFFFF' : '#192A52'}">${esc(ch)}</text>`;
  }
  const status = room.status === 'ended' ? 'Final board' : 'Board at ' + new Date().toISOString().slice(11, 19) + ' UTC';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}" font-family="${FONT}">
<rect width="100%" height="100%" fill="#F5F7FB"/>
<rect width="100%" height="${H - 14}" fill="#192A52"/>
<rect x="${ox - 6}" y="${H - 6}" width="${p.cols * S + 12}" height="${p.rows * S + 12}" rx="8" fill="#FFFFFF"/>
<image href="${LOGO}" x="${M}" y="16" width="110" height="37"/>
<text x="${W - M}" y="34" font-size="14" text-anchor="end" fill="#DBE2F1">Tamtech WEM Crossword • Room ${esc(room.code)} • ${status}</text>
<text x="${M}" y="82" font-size="22" font-weight="700" fill="#FFFFFF">${esc(label)}</text>
<text x="${W - M}" y="82" font-size="16" text-anchor="end" fill="#FFFFFF">Player: ${esc(t ? t.player : '—')}  •  Score ${score}/${p.entries.length}  •  Last correct answer: ${last}</text>
${g}
</svg>`;
}

async function boardWebp(room, teamName, label) {
  return sharp(Buffer.from(boardSvg(room, teamName, label)), { density: 144 }).webp({ quality: 90 }).toBuffer();
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

module.exports = { boardWebp, slug };
