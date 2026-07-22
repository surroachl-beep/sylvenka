# Sylvenka Community Server

Real-time multi-user backend for the Sylvenka language learning site.
WebSocket live updates · SQLite database · rate-limited API · one-command deploy.

---

## What this adds over the standalone HTML file

| Feature | Standalone HTML | With this server |
|---|---|---|
| Conversation rooms | ✅ your browser only | ✅ **shared by everyone** |
| Message board | ✅ your browser only | ✅ **shared by everyone** |
| Partner listings | ✅ your browser only | ✅ **shared by everyone** |
| Velasin poems | ✅ your browser only | ✅ **shared by everyone** |
| Real-time updates | ❌ | ✅ **WebSocket push** |
| Speaker count | local estimate | ✅ **true global count** |
| Persists after refresh | ❌ cleared sometimes | ✅ SQLite on disk |

---

## Run locally (30 seconds)

```bash
# 1. Install
npm install

# 2. Start
npm start
# or, with auto-restart on file changes:
npm run dev

# 3. Open
open http://localhost:3000
```

The SQLite database is created automatically at `data/sylvenka.db`.

---

## Deploy to Railway (free tier, 5 minutes)

Railway gives you a free persistent server — perfect for a growing language community.

1. Go to [railway.app](https://railway.app) and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
   - Push this folder to a GitHub repo first, or use **Deploy from local** with the Railway CLI
3. Railway detects Node.js automatically and runs `npm start`
4. Add a **Volume** (under your service → Volumes) mounted at `/app/data` — this keeps your database across deploys
5. Your site is live at `https://your-project.up.railway.app`

That's it. The frontend auto-detects the server URL (same origin), so no config needed.

---

## Deploy to Render (free tier)

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Set:
   - **Build command:** `npm install`
   - **Start command:** `node src/server.js`
4. Add a **Disk** under Advanced, mounted at `/app/data`, size 1 GB
5. Deploy

---

## Deploy with Docker (any VPS)

```bash
# Build
docker build -t sylvenka .

# Run with persistent data volume
docker run -d \
  -p 3000:3000 \
  -v sylvenka_data:/app/data \
  --name sylvenka \
  sylvenka

# Or with docker-compose:
docker compose up -d
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/sylvenka.db` | SQLite file path |
| `ORIGIN` | `*` | CORS allowed origin (set to your domain in production) |

---

## API reference

All endpoints return JSON. Posts are rate-limited to 60 requests/minute per IP.

```
GET  /api/health                     → { ok, speakers }
GET  /api/rooms/:id/messages         → Message[]
POST /api/rooms/:id/messages         → Message  body: { name, level, text, tr }
GET  /api/board                      → Post[]
POST /api/board                      → Post     body: { name, level, text, tag }
POST /api/board/:id/like             → { ok }
POST /api/board/:id/reply            → Reply    body: { name, text }
GET  /api/partners                   → Partner[]
POST /api/partners                   → Partner  body: { name, level, tz, time_pref, goal }
GET  /api/velasin                    → Poem[]
POST /api/velasin                    → Poem     body: { name, lines: string[4] }

WS   /ws                             ← welcome, room_message, board_post,
                                        board_like, board_reply, partner_new, velasin_new
```

Room IDs: `sela` · `tovi` · `lama` · `miren` · `velasin`
Levels: `melo` · `nashuen` · `veloen` · `loven`
Tags: `question` · `sentence` · `translation` · `hello` · `poem`

---

## File structure

```
sylvenka-server/
├── src/
│   └── server.js        ← Express + WebSocket + SQLite
├── public/
│   └── index.html       ← Full Sylvenka site (auto-served)
├── data/
│   └── sylvenka.db      ← Created on first run
├── Dockerfile
├── railway.json
├── package.json
└── README.md
```

---

*Shila tenu. Nasi velomile.* — Speak gently. We will see it together.
