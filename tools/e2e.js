// End-to-end smoke test: node tools/e2e.js [baseUrl]
const WebSocket = require('ws');
const base = process.argv[2] || 'http://localhost:3111';
const assert = require('assert');
const post = async (p, body, token) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const wsOpen = (q) => new Promise((res) => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?' + q); const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d))); ws.on('open', () => res({ ws, msgs }));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  assert.strictEqual((await post('/api/staff/login', { role: 'master', name: 'M', password: 'nope' })).status, 401);
  assert.strictEqual((await post('/api/staff/login', { role: 'overseer', name: 'O', password: 'Five9' })).status, 401);
  const master = (await post('/api/staff/login', { role: 'master', name: 'Boss', password: 'Five9' })).body;
  const over = (await post('/api/staff/login', { role: 'overseer', name: 'Eye', password: 'Five9OS' })).body;
  const room = (await post('/api/rooms', {}, master.token)).body;
  assert.match(room.code, /^\d{6}$/);
  console.log('room', room.code);

  const a = await post('/api/player/join', { name: 'Ann', team: 'Task Masters', code: room.code });
  assert.strictEqual(a.status, 200);
  assert.strictEqual((await post('/api/player/join', { name: 'Bob', team: 'Task Masters', code: room.code })).status, 409);
  const c = await post('/api/player/join', { name: 'Cy', team: 'Techie Titans', code: room.code });
  assert.strictEqual((await post('/api/player/join', { name: 'x', team: 'Task Masters', code: '000000' })).status, 404);

  const st = await wsOpen(`token=${master.token}&room=${room.code}`);
  const ov = await wsOpen(`token=${over.token}&room=${room.code}`);
  const p1 = await wsOpen('token=' + a.body.token);
  const p2 = await wsOpen('token=' + c.body.token);
  await wait(300);
  const init = st.msgs.find((m) => m.t === 'init');
  const pinit = p1.msgs.find((m) => m.t === 'init');
  const pinit2 = p2.msgs.find((m) => m.t === 'init');
  assert.strictEqual(init.puzzle.entries.length, 60);
  assert.ok(!('answer' in pinit.puzzle.entries[0]), 'players must not receive answers');
  assert.deepStrictEqual(pinit.puzzle, pinit2.puzzle, 'same room => same puzzle');
  assert.ok(pinit.startedAt, 'timer starts on view');

  const e = init.puzzle.entries[0];
  p1.ws.send(JSON.stringify({ t: 'answer', id: e.id, text: 'WRONG' }));
  p1.ws.send(JSON.stringify({ t: 'answer', id: e.id, text: e.answer }));
  p1.ws.send(JSON.stringify({ t: 'answer', id: e.id, text: e.answer })); // duplicate must not double count
  p2.ws.send(JSON.stringify({ t: 'answer', id: init.puzzle.entries[1].id, text: init.puzzle.entries[1].answer }));
  await wait(300);
  const res = p1.msgs.filter((m) => m.t === 'result');
  assert.strictEqual(res[0].ok, false); assert.strictEqual(res[1].ok, true); assert.strictEqual(res[1].score, 1);
  assert.strictEqual(p1.msgs.filter((m) => m.t === 'result' && m.ok).length, 1);
  assert.ok(ov.msgs.some((m) => m.t === 'solved' && m.team === 'Task Masters' && m.score === 1), 'overseer sees live score');

  assert.strictEqual((await post(`/api/rooms/${room.code}/end`, { terminationCode: '1234' }, master.token)).status, 403);
  assert.strictEqual((await post(`/api/rooms/${room.code}/end`, { terminationCode: '5959' }, over.token)).status, 401);
  const r0 = await fetch(`${base}/api/rooms/${room.code}/results`, { headers: { Authorization: 'Bearer ' + a.body.token } });
  assert.strictEqual(r0.status, 403, 'players cannot see results mid-game');
  assert.strictEqual((await post(`/api/rooms/${room.code}/end`, { terminationCode: '5959' }, master.token)).status, 200);
  await wait(200);
  assert.ok(p1.msgs.some((m) => m.t === 'ended') && p2.msgs.some((m) => m.t === 'ended'));
  const r = await (await fetch(`${base}/api/rooms/${room.code}/results`, { headers: { Authorization: 'Bearer ' + a.body.token } })).json();
  console.log(r.rows.slice(0, 3).map((x) => `${x.rank} ${x.team} ${x.points} ${x.timeMs}`), 'total', r.totalGameMs);
  const x = await fetch(`${base}/api/rooms/${room.code}/export`, { headers: { Authorization: 'Bearer ' + master.token } });
  assert.strictEqual(x.status, 200);
  require('fs').writeFileSync(process.env.TEMP + '/test-export.xlsx', Buffer.from(await x.arrayBuffer()));
  assert.strictEqual((await post('/api/player/join', { name: 'Late', team: 'Tamscendance', code: room.code })).status, 410);
  console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
