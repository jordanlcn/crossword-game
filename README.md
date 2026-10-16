# Tamtech WEM Crossword

Live multiplayer crossword (Node.js + WebSocket). 60 words from `words.json` (built from the Excel file), one puzzle per room, one player per team.

## Run locally
```
npm install
npm start          # http://localhost:3000
```

## Pages
| Who | URL | Login |
|---|---|---|
| Players | `/` | name + team + 6-digit room code |
| Game Master / Overseer | `/staff.html` | role dropdown + name + password |

Passwords / codes (override with env vars): Game Master `Five9` (`MASTER_PASSWORD`), Overseer `Five9OS` (`OVERSEER_PASSWORD`), terminating code `5959` (`TERMINATION_CODE`).

## Updating the words
```
python -I tools/build_words.py "<new file>.xlsx" words.json
```
Row 1 is skipped. B = word, C = clue, D/E/F = Overseer hints. Restart the server; new rooms use the new words (existing rooms keep theirs).

## Deploy to crossword.worldoftechdev.com
The app needs a host that keeps a Node process running (WebSockets), so static hosting will not work.

**Option A: Render / Railway / Fly (simplest).** Push this folder to a Git repo, create a Web Service (build `npm install`, start `npm start`), attach a persistent disk mounted at `/data` and set `DATA_DIR=/data`. Add `crossword.worldoftechdev.com` as a custom domain and create the CNAME record they show you at your DNS provider. HTTPS is automatic.

**Option B: your own VPS.**
```
docker build -t crossword . && docker run -d --restart=always -p 3000:3000 -v crossword-data:/data -e DATA_DIR=/data crossword
```
Point an `A` record for `crossword` at the server, then put Caddy in front for HTTPS and WebSocket support:
```
crossword.worldoftechdev.com {
    reverse_proxy localhost:3000
}
```

Room state is saved to `DATA_DIR/state.json`, so a restart does not lose active rooms. Run a single instance only (state is in memory).

## Tests
With the server on port 3111: `node tools/e2e.js`
