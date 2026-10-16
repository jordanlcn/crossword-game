'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const ExcelJS = require('exceljs');
const { generate, norm } = require('./puzzle');

const PORT = process.env.PORT || 3000;
const MASTER_PW = process.env.MASTER_PASSWORD || 'Five9';
const OVERSEER_PW = process.env.OVERSEER_PASSWORD || 'Five9OS';
const END_CODE = process.env.TERMINATION_CODE || '5959';
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'state.json');
const WORDS = require('./words.json');

const TEAMS = [
  { name: 'Tenacious Tamaraws', lead: 'Team Jeff' },
  { name: 'Task Masters', lead: 'Team Kid' },
  { name: 'Techie Titans', lead: 'Team Jez' },
  { name: 'Money Magnets', lead: 'Team Manny' },
  { name: 'Tamtastics', lead: 'Team Ciara' },
  { name: 'Valiant Knights', lead: 'Team Kurt' },
  { name: 'Tamscendance', lead: 'Team Vitto' },
  { name: 'Majestic Martians', lead: 'Team Martin' },
].map((t) => ({ ...t, label: `${t.name} - ${t.lead}` }));
const teamByName = (n) => TEAMS.find((t) => t.name === n);

// ---------- persistence ----------
let db = { rooms: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* fresh start */ }
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { console.error('save failed', e.message); }
  }, 300);
}

// ---------- helpers ----------
const conns = new Map(); // room code -> Set<{ws, role, team}>
const roomConns = (code) => { if (!conns.has(code)) conns.set(code, new Set()); return conns.get(code); };
const isOnline = (code, team) => [...roomConns(code)].some((c) => c.role === 'player' && c.team === team);
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
function broadcast(code, filter, msg) {
  const s = JSON.stringify(msg);
  for (const c of roomConns(code)) if (filter(c) && c.ws.readyState === 1) c.ws.send(s);
}
const toStaff = (code, msg) => broadcast(code, (c) => c.role !== 'player', msg);
const toAll = (code, msg) => broadcast(code, () => true, msg);

const publicPuzzle = (p) => ({
  rows: p.rows, cols: p.cols,
  entries: p.entries.map(({ id, num, dir, r, c, len, enum: en, clue }) => ({ id, num, dir, r, c, len, enum: en, clue })),
});
const staffPuzzle = (p) => p;

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function cellKeysOf(e) {
  const out = [];
  for (let i = 0; i < e.len; i++) out.push(`${e.r + (e.dir === 'D' ? i : 0)},${e.c + (e.dir === 'A' ? i : 0)}`);
  return out;
}

function summary(room, name) {
  const t = room.teams[name];
  if (!t) return { team: name, joined: false };
  return {
    team: name, joined: true, player: t.player, startedAt: t.startedAt, lastCorrectAt: t.lastCorrectAt,
    score: Object.keys(t.solved).length, online: isOnline(room.code, name),
  };
}
const roomInfo = (r) => ({ code: r.code, status: r.status, createdAt: r.createdAt, endedAt: r.endedAt || null, createdBy: r.createdBy });

function results(room) {
  const end = room.endedAt || Date.now();
  const rows = TEAMS.map((T) => {
    const t = room.teams[T.name];
    return {
      team: T.name, label: T.label, player: t ? t.player : null,
      points: t ? Object.keys(t.solved).length : 0,
      timeMs: t && t.lastCorrectAt && t.startedAt ? t.lastCorrectAt - t.startedAt : null,
    };
  });
  rows.sort((a, b) => b.points - a.points || (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity) || a.team.localeCompare(b.team));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { room: roomInfo(room), totalWords: room.puzzle.entries.length, totalGameMs: end - room.createdAt, rows };
}

function newToken() { return crypto.randomBytes(18).toString('hex'); }
function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const s = token && db.sessions[token];
  return s ? { token, ...s } : null;
}
const needStaff = (role) => (req, res, next) => {
  const a = auth(req);
  if (!a || a.role === 'player' || (role && a.role !== role)) return res.status(401).json({ error: 'Not authorized' });
  req.user = a; next();
};

// ---------- REST ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/teams', (req, res) => res.json(TEAMS));

app.post('/api/staff/login', (req, res) => {
  const { role, name, password } = req.body || {};
  const nm = String(name || '').trim().slice(0, 40);
  if (!nm) return res.status(400).json({ error: 'Please enter your name.' });
  const ok = (role === 'master' && password === MASTER_PW) || (role === 'overseer' && password === OVERSEER_PW);
  if (!ok) return res.status(401).json({ error: 'Incorrect password for that role.' });
  const token = newToken();
  db.sessions[token] = { role, name: nm };
  save();
  res.json({ token, role, name: nm });
});

// Which teams already have a player in this room (used by the player login to cross them out).
app.get('/api/rooms/:code/teams', (req, res) => {
  const room = db.rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room code not found.' });
  if (room.status === 'ended') return res.status(410).json({ error: 'This game has already ended.' });
  res.json(TEAMS.map((T) => ({ ...T, player: room.teams[T.name] ? room.teams[T.name].player : null })));
});

app.post('/api/player/join', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  const teamName = String(req.body.team || '');
  const code = String(req.body.code || '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter a player name.' });
  if (!teamByName(teamName)) return res.status(400).json({ error: 'Please choose your team.' });
  const room = db.rooms[code];
  if (!/^\d{6}$/.test(code) || !room) return res.status(404).json({ error: 'Room code not found. Check the code from your Game Master.' });
  if (room.status === 'ended') return res.status(410).json({ error: 'This game has already ended.' });
  let t = room.teams[teamName];
  if (t && t.player.toLowerCase() !== name.toLowerCase()) {
    return res.status(409).json({ error: `${teamName} already has a player (${t.player}) in this room. Only one player per team is allowed.` });
  }
  // Name-only rejoin (no saved device token) is refused while the original player is still connected.
  if (t && isOnline(code, teamName)) {
    return res.status(409).json({ error: `${t.player} is currently connected on ${teamName}. If that is you, use the Resume button on the device you started with.` });
  }
  if (!t) t = room.teams[teamName] = { player: name, startedAt: null, lastCorrectAt: null, cells: {}, solved: {}, token: null };
  if (t.token) delete db.sessions[t.token];
  t.token = newToken();
  db.sessions[t.token] = { role: 'player', name: t.player, room: code, team: teamName };
  save();
  res.json({ token: t.token, code, team: teamName, name: t.player });
});

// One-click rejoin from the device the player started on (their saved token).
app.post('/api/player/resume', (req, res) => {
  const a = auth(req);
  const room = a && a.role === 'player' && db.rooms[a.room];
  const t = room && room.teams[a.team];
  if (!t || t.token !== a.token) return res.status(401).json({ error: 'Session expired.' });
  if (room.status === 'ended') return res.status(410).json({ error: 'This game has already ended.', code: room.code });
  res.json({ token: a.token, code: room.code, team: a.team, name: t.player });
});

app.get('/api/rooms', needStaff(), (req, res) => {
  const list = Object.values(db.rooms)
    .filter((r) => req.user.role === 'master' || r.status === 'open')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({ ...roomInfo(r), teamsJoined: Object.keys(r.teams).length, teamsOnline: TEAMS.filter((t) => isOnline(r.code, t.name)).length }));
  res.json(list);
});

app.post('/api/rooms', needStaff('master'), (req, res) => {
  let code;
  do { code = String(100000 + crypto.randomInt(900000)); } while (db.rooms[code]);
  const seed = crypto.randomInt(1, 2 ** 31);
  const puzzle = generate(WORDS, seed);
  db.rooms[code] = { code, status: 'open', createdAt: Date.now(), createdBy: req.user.name, endedAt: null, seed, puzzle, teams: {} };
  save();
  res.json(roomInfo(db.rooms[code]));
});

app.post('/api/rooms/:code/end', needStaff('master'), (req, res) => {
  const room = db.rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (String(req.body.terminationCode) !== END_CODE) return res.status(403).json({ error: 'Incorrect terminating code.' });
  if (room.status !== 'ended') {
    room.status = 'ended';
    room.endedAt = Date.now();
    save();
    toAll(room.code, { t: 'ended', endedAt: room.endedAt });
  }
  res.json(roomInfo(room));
});

app.get('/api/rooms/:code/results', (req, res) => {
  const a = auth(req);
  const room = db.rooms[req.params.code];
  if (!a || !room) return res.status(404).json({ error: 'Not found' });
  if (a.role === 'player' && a.room !== room.code) return res.status(403).json({ error: 'Not your room' });
  if (a.role === 'player' && room.status !== 'ended') return res.status(403).json({ error: 'The game is still running.' });
  res.json({ ...results(room), me: a.role === 'player' ? a.team : null });
});

app.get('/api/rooms/:code/export', needStaff('master'), async (req, res) => {
  const room = db.rooms[req.params.code];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const r = results(room);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Results');
  const dt = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT' : '');
  const info = [
    ['Room Code', room.code],
    ['Game Opened', dt(room.createdAt)],
    ['Game Ended', room.endedAt ? dt(room.endedAt) : 'Still running'],
    ['Total Game Time (HH:MM:SS)', fmt(r.totalGameMs)],
    ['Total Words', r.totalWords],
  ];
  info.forEach((row) => { const x = ws.addRow(row); x.getCell(1).font = { bold: true }; });
  ws.addRow([]);
  const head = ws.addRow(['Rank', 'Team', 'Player', 'Points', 'Time of Last Correct Answer (HH:MM:SS)', 'Total Game Time (HH:MM:SS)']);
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B6BCB' } };
  });
  r.rows.forEach((x) => ws.addRow([x.rank, x.label, x.player || 'Did not play', x.points, fmt(x.timeMs) || '-', fmt(r.totalGameMs)]));
  [8, 38, 24, 10, 40, 28].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="crossword-room-${room.code}-results.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const sess = db.sessions[q.get('token')];
  const code = sess && (sess.role === 'player' ? sess.room : q.get('room'));
  const room = code && db.rooms[code];
  if (!sess || !room) return ws.close(4001, 'auth');

  const conn = { ws, role: sess.role, team: sess.team || null };

  if (sess.role === 'player') {
    const t = room.teams[sess.team];
    if (!t || t.token !== q.get('token')) return ws.close(4001, 'auth');
    for (const c of roomConns(code)) {
      if (c.role === 'player' && c.team === sess.team) { send(c.ws, { t: 'kicked' }); c.ws.close(4002, 'replaced'); roomConns(code).delete(c); }
    }
    roomConns(code).add(conn);
    if (room.status === 'open' && !t.startedAt) { t.startedAt = Date.now(); save(); }
    const solved = {};
    for (const id of Object.keys(t.solved)) solved[id] = room.puzzle.entries.find((e) => e.id === +id).answer;
    send(ws, {
      t: 'init', serverNow: Date.now(), room: roomInfo(room), team: sess.team, player: t.player,
      puzzle: publicPuzzle(room.puzzle), startedAt: t.startedAt, lastCorrectAt: t.lastCorrectAt,
      cells: t.cells, solved, score: Object.keys(t.solved).length,
    });
    toStaff(code, { t: 'team', ...summary(room, sess.team) });

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (room.status !== 'open') return;
      if (m.t === 'cell') {
        const k = String(m.k);
        const ch = String(m.ch || '').toUpperCase();
        if (!/^[A-Z]?$/.test(ch)) return;
        const valid = room.puzzle.entries.some((e) => cellKeysOf(e).includes(k));
        const locked = room.puzzle.entries.some((e) => t.solved[e.id] && cellKeysOf(e).includes(k));
        if (!valid || locked) return;
        if (ch) t.cells[k] = ch; else delete t.cells[k];
        save();
        toStaff(code, { t: 'cell', team: sess.team, k, ch });
      } else if (m.t === 'answer') {
        const e = room.puzzle.entries.find((x) => x.id === m.id);
        if (!e || t.solved[e.id]) return;
        if (norm(String(m.text || '')) === e.answer) {
          const now = Date.now();
          t.solved[e.id] = now;
          t.lastCorrectAt = now;
          cellKeysOf(e).forEach((k, i) => { t.cells[k] = e.answer[i]; });
          save();
          const score = Object.keys(t.solved).length;
          send(ws, { t: 'result', id: e.id, ok: true, answer: e.answer, score, lastCorrectAt: now });
          toStaff(code, { t: 'solved', team: sess.team, id: e.id, answer: e.answer, score, lastCorrectAt: now });
        } else {
          send(ws, { t: 'result', id: e.id, ok: false });
        }
      }
    });
    ws.on('close', () => {
      roomConns(code).delete(conn);
      toStaff(code, { t: 'team', ...summary(room, sess.team) });
    });
  } else {
    roomConns(code).add(conn);
    const teams = TEAMS.map((T) => {
      const t = room.teams[T.name];
      return { ...summary(room, T.name), cells: t ? t.cells : {}, solved: t ? Object.keys(t.solved).map(Number) : [] };
    });
    send(ws, { t: 'init', serverNow: Date.now(), room: roomInfo(room), puzzle: staffPuzzle(room.puzzle), teams, teamList: TEAMS });
    ws.on('close', () => roomConns(code).delete(conn));
  }
});

server.listen(PORT, () => console.log(`Crossword server on http://localhost:${PORT}`));
