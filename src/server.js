/**
 * Sylvenka Community Server
 * Express + WebSocket + SQLite
 * ----------------------------
 * Routes:
 *   GET  /api/health
 *   GET  /api/rooms
 *   GET  /api/rooms/:id/messages
 *   POST /api/rooms/:id/messages
 *   GET  /api/board
 *   POST /api/board
 *   POST /api/board/:id/like
 *   GET  /api/partners
 *   POST /api/partners
 *   GET  /api/velasin
 *   POST /api/velasin
 *   WS   /ws  (real-time broadcast)
 */

'use strict';

const http        = require('http');
const path        = require('path');
const express     = require('express');
const { WebSocketServer } = require('ws');
const Database    = require('better-sqlite3');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');

// ── Config ────────────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sylvenka.db');
const ORIGIN  = process.env.ORIGIN || '*';

// ── Database ──────────────────────────────────────────────────
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS room_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id   TEXT    NOT NULL,
    name      TEXT    NOT NULL,
    level     TEXT    NOT NULL DEFAULT 'melo',
    text      TEXT    NOT NULL,
    tr        TEXT    DEFAULT '',
    ts        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS board_posts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    level     TEXT    NOT NULL DEFAULT 'melo',
    text      TEXT    NOT NULL,
    tag       TEXT    NOT NULL DEFAULT 'hello',
    likes     INTEGER NOT NULL DEFAULT 0,
    ts        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS board_replies (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id   INTEGER NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
    name      TEXT    NOT NULL,
    text      TEXT    NOT NULL,
    ts        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS partners (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    level     TEXT    NOT NULL DEFAULT 'melo',
    tz        TEXT    NOT NULL DEFAULT '',
    time_pref TEXT    NOT NULL DEFAULT 'Anytime',
    goal      TEXT    NOT NULL DEFAULT 'general practice',
    ts        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS velasin (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    lines     TEXT    NOT NULL,
    ts        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_board_ts ON board_posts(ts DESC);
`);

// ── Prepared statements ───────────────────────────────────────
const stmts = {
  getRoomMessages:   db.prepare('SELECT * FROM room_messages WHERE room_id=? ORDER BY ts ASC LIMIT 120'),
  insertRoomMessage: db.prepare('INSERT INTO room_messages (room_id,name,level,text,tr) VALUES (?,?,?,?,?)'),
  getBoardPosts:     db.prepare(`
    SELECT p.*, GROUP_CONCAT(r.name||'|||'||r.text||'|||'||r.ts, '~~~') AS replies_raw
    FROM board_posts p
    LEFT JOIN board_replies r ON r.post_id = p.id
    GROUP BY p.id ORDER BY p.ts DESC LIMIT 80`),
  insertBoardPost:   db.prepare('INSERT INTO board_posts (name,level,text,tag) VALUES (?,?,?,?)'),
  likePost:          db.prepare('UPDATE board_posts SET likes=likes+1 WHERE id=?'),
  insertReply:       db.prepare('INSERT INTO board_replies (post_id,name,text) VALUES (?,?,?)'),
  getPartners:       db.prepare('SELECT * FROM partners ORDER BY ts DESC LIMIT 60'),
  insertPartner:     db.prepare('INSERT INTO partners (name,level,tz,time_pref,goal) VALUES (?,?,?,?,?)'),
  getVelasin:        db.prepare('SELECT * FROM velasin ORDER BY ts DESC LIMIT 60'),
  insertVelasin:     db.prepare('INSERT INTO velasin (name,lines) VALUES (?,?)'),
  countSpeakers:     db.prepare('SELECT COUNT(DISTINCT name) AS n FROM velasin'),
};

// ── Express ───────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: '32kb' }));

// Rate limiting
const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Validators ────────────────────────────────────────────────
const ROOM_IDS = new Set(['sela','tovi','lama','miren','velasin']);
const LEVELS   = new Set(['melo','nashuen','veloen','loven']);
const TAGS     = new Set(['question','sentence','translation','hello','poem']);

function sanitize(str, max = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}
function validName(s) { return /^[\w\s\-\.]{1,30}$/i.test(sanitize(s, 30)); }

// ── API routes ────────────────────────────────────────────────

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, speakers: stmts.countSpeakers.get().n });
});

// ── Room messages
app.get('/api/rooms/:id/messages', (req, res) => {
  if (!ROOM_IDS.has(req.params.id)) return res.status(404).json({ error: 'Unknown room' });
  res.json(stmts.getRoomMessages.all(req.params.id));
});

app.post('/api/rooms/:id/messages', (req, res) => {
  if (!ROOM_IDS.has(req.params.id)) return res.status(404).json({ error: 'Unknown room' });
  const { name, level, text, tr } = req.body;
  if (!validName(name)) return res.status(400).json({ error: 'Invalid name' });
  const cleanText = sanitize(text, 400);
  if (!cleanText) return res.status(400).json({ error: 'Empty message' });
  const cleanLevel = LEVELS.has(level) ? level : 'melo';
  const info = stmts.insertRoomMessage.run(req.params.id, sanitize(name, 30), cleanLevel, cleanText, sanitize(tr, 200));
  const msg = { id: info.lastInsertRowid, room_id: req.params.id, name: sanitize(name,30), level: cleanLevel, text: cleanText, tr: sanitize(tr,200), ts: Date.now() };
  broadcast({ type: 'room_message', payload: msg });
  res.status(201).json(msg);
});

// ── Board
app.get('/api/board', (_req, res) => {
  const posts = stmts.getBoardPosts.all().map(p => ({
    ...p,
    replies: p.replies_raw
      ? p.replies_raw.split('~~~').map(r => { const [n,t,ts]=r.split('|||'); return {name:n,text:t,ts:Number(ts)}; })
      : []
  }));
  res.json(posts);
});

app.post('/api/board', (req, res) => {
  const { name, level, text, tag } = req.body;
  if (!validName(name)) return res.status(400).json({ error: 'Invalid name' });
  const cleanText = sanitize(text, 600);
  if (!cleanText) return res.status(400).json({ error: 'Empty post' });
  const cleanTag = TAGS.has(tag) ? tag : 'hello';
  const cleanLevel = LEVELS.has(level) ? level : 'melo';
  const info = stmts.insertBoardPost.run(sanitize(name,30), cleanLevel, cleanText, cleanTag);
  const post = { id: info.lastInsertRowid, name: sanitize(name,30), level: cleanLevel, text: cleanText, tag: cleanTag, likes: 0, ts: Date.now(), replies: [] };
  broadcast({ type: 'board_post', payload: post });
  res.status(201).json(post);
});

app.post('/api/board/:id/like', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  stmts.likePost.run(id);
  broadcast({ type: 'board_like', payload: { id } });
  res.json({ ok: true });
});

app.post('/api/board/:id/reply', (req, res) => {
  const postId = parseInt(req.params.id, 10);
  const { name, text } = req.body;
  if (!validName(name)) return res.status(400).json({ error: 'Invalid name' });
  const cleanText = sanitize(text, 400);
  if (!cleanText) return res.status(400).json({ error: 'Empty reply' });
  stmts.insertReply.run(postId, sanitize(name,30), cleanText);
  const reply = { name: sanitize(name,30), text: cleanText, ts: Date.now() };
  broadcast({ type: 'board_reply', payload: { postId, reply } });
  res.status(201).json(reply);
});

// ── Partners
app.get('/api/partners', (_req, res) => res.json(stmts.getPartners.all()));

app.post('/api/partners', (req, res) => {
  const { name, level, tz, time_pref, goal } = req.body;
  if (!validName(name)) return res.status(400).json({ error: 'Invalid name' });
  const cleanLevel = LEVELS.has(level) ? level : 'melo';
  const info = stmts.insertPartner.run(sanitize(name,30), cleanLevel, sanitize(tz,60), sanitize(time_pref,20), sanitize(goal,200));
  const partner = { id: info.lastInsertRowid, name: sanitize(name,30), level: cleanLevel, tz: sanitize(tz,60), time_pref: sanitize(time_pref,20), goal: sanitize(goal,200), ts: Date.now() };
  broadcast({ type: 'partner_new', payload: partner });
  res.status(201).json(partner);
});

// ── Velasin poems
app.get('/api/velasin', (_req, res) => {
  const rows = stmts.getVelasin.all().map(r => ({ ...r, lines: JSON.parse(r.lines) }));
  res.json(rows);
});

app.post('/api/velasin', (req, res) => {
  const { name, lines } = req.body;
  if (!validName(name)) return res.status(400).json({ error: 'Invalid name' });
  if (!Array.isArray(lines) || lines.length !== 4) return res.status(400).json({ error: 'Need exactly 4 lines' });
  const cleanLines = lines.map(l => sanitize(l, 200));
  if (cleanLines.some(l => !l)) return res.status(400).json({ error: 'Empty line' });
  const info = stmts.insertVelasin.run(sanitize(name,30), JSON.stringify(cleanLines));
  const poem = { id: info.lastInsertRowid, name: sanitize(name,30), lines: cleanLines, ts: Date.now() };
  broadcast({ type: 'velasin_new', payload: poem });
  res.status(201).json(poem);
});

// ── WebSocket ─────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  // Send current speaker count on connect
  ws.send(JSON.stringify({ type: 'welcome', speakers: stmts.countSpeakers.get().n }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🌿 Sylvenka community server running`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   DB: ${DB_PATH}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => { db.close(); server.close(); });
process.on('SIGINT',  () => { db.close(); server.close(); });

// ── Additional routes for sylvenka.com ───────────────────────
// Serve chat at /chat
app.get('/chat', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'chat', 'index.html'));
});

// Simple OG image placeholder route (returns SVG as PNG-compatible)
app.get('/og-image.png', (_req, res) => {
  const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="630" fill="#020507"/>
    <ellipse cx="900" cy="200" rx="300" ry="150" fill="#2F6B5A" opacity=".08"/>
    <ellipse cx="300" cy="450" rx="200" ry="100" fill="#6E549C" opacity=".06"/>
    <text x="600" y="220" font-family="Georgia,serif" font-style="italic" font-size="96" fill="#ffffff" text-anchor="middle" letter-spacing="4">Shila ve-va.</text>
    <text x="600" y="300" font-family="Arial,sans-serif" font-size="28" fill="#5ecfa0" text-anchor="middle" letter-spacing="2">speak only what you have witnessed</text>
    <text x="600" y="420" font-family="Arial,sans-serif" font-size="22" fill="#ffffff" opacity=".4" text-anchor="middle" letter-spacing="8">SYLVENKA.COM</text>
    <g font-family="Arial,sans-serif" font-size="18" text-anchor="middle">
      <rect x="310" y="460" width="120" height="32" rx="16" fill="#0f2a1e" stroke="#2F6B5A" stroke-width="1"/>
      <text x="370" y="481" fill="#5ecfa0">-va witnessed</text>
      <rect x="450" y="460" width="100" height="32" rx="16" fill="#0f1828" stroke="#3F72A3" stroke-width="1"/>
      <text x="500" y="481" fill="#7ab8f5">-shi hearsay</text>
      <rect x="570" y="460" width="110" height="32" rx="16" fill="#281c08" stroke="#A9761F" stroke-width="1"/>
      <text x="625" y="481" fill="#f5c06a">-nu inferred</text>
      <rect x="700" y="460" width="110" height="32" rx="16" fill="#1e1030" stroke="#6E549C" stroke-width="1"/>
      <text x="755" y="481" fill="#c4a0f5">-le dreamed</text>
    </g>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

// Robots.txt
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nSitemap: https://sylvenka.com/sitemap.xml');
});

// Basic sitemap
app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://sylvenka.com/</loc><priority>1.0</priority></url>
  <url><loc>https://sylvenka.com/chat</loc><priority>0.9</priority></url>
</urlset>`);
});

// ══════════════════════════════════════════════════════════════
// MONETISATION — Stripe payments + Pro features
// ══════════════════════════════════════════════════════════════

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'sylvenka-shila-ve-va-secret';

// ── Database upgrades for pro users ──────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pro_users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT    NOT NULL UNIQUE,
    name            TEXT    NOT NULL DEFAULT '',
    stripe_customer TEXT    DEFAULT '',
    plan            TEXT    NOT NULL DEFAULT 'free',
    certified       INTEGER NOT NULL DEFAULT 0,
    cert_name       TEXT    DEFAULT '',
    cert_ts         INTEGER DEFAULT NULL,
    created_ts      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );
  CREATE TABLE IF NOT EXISTS cert_attempts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    email     TEXT    NOT NULL,
    score     INTEGER NOT NULL,
    passed    INTEGER NOT NULL DEFAULT 0,
    ts        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );
`);

const stmts2 = {
  getProUser:    db.prepare('SELECT * FROM pro_users WHERE email=?'),
  upsertProUser: db.prepare(`INSERT INTO pro_users (email,name,stripe_customer,plan) VALUES (?,?,?,?)
                             ON CONFLICT(email) DO UPDATE SET plan=excluded.plan, stripe_customer=excluded.stripe_customer`),
  setPro:        db.prepare('UPDATE pro_users SET plan=? WHERE email=?'),
  setCertified:  db.prepare('UPDATE pro_users SET certified=1, cert_name=?, cert_ts=? WHERE email=?'),
  logAttempt:    db.prepare('INSERT INTO cert_attempts (email,score,passed) VALUES (?,?,?)'),
  countSpeakers: db.prepare('SELECT COUNT(*) AS n FROM pro_users'),
  proCount:      db.prepare("SELECT COUNT(*) AS n FROM pro_users WHERE plan='pro'"),
};

// ── Auth helper ───────────────────────────────────────────────
function issueToken(email, plan) {
  return jwt.sign({ email, plan }, JWT_SECRET, { expiresIn: '30d' });
}
function verifyToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ── Pro check middleware ──────────────────────────────────────
app.get('/api/me', (req, res) => {
  const payload = verifyToken(req);
  if (!payload) return res.json({ plan: 'free', certified: false });
  const user = stmts2.getProUser.get(payload.email);
  if (!user) return res.json({ plan: 'free', certified: false });
  res.json({
    email: user.email,
    name: user.name,
    plan: user.plan,
    certified: !!user.certified,
    cert_name: user.cert_name,
    cert_ts: user.cert_ts,
  });
});

// ── Stripe: create checkout session ──────────────────────────
app.post('/api/subscribe', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured yet' });
  const { email, plan } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const priceId = plan === 'certified'
      ? process.env.STRIPE_PRICE_CERT    // one-time $29
      : process.env.STRIPE_PRICE_PRO;    // recurring $4.99

    const mode = plan === 'certified' ? 'payment' : 'subscription';

    const session = await stripe.checkout.sessions.create({
      mode,
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `https://sylvenka.com/pro?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `https://sylvenka.com/pro?cancelled=1`,
      metadata: { email, plan },
    });

    // Register user
    stmts2.upsertProUser.run(email, '', '', 'pending');
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe: verify session after payment ─────────────────────
app.get('/api/verify-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { session_id, plan } = req.query;
  if (!session_id) return res.status(400).json({ error: 'No session' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(402).json({ error: 'Payment not complete' });
    }
    const email = session.customer_email || session.metadata?.email;
    stmts2.setPro.run(plan === 'certified' ? 'free' : 'pro', email);
    const token = issueToken(email, plan === 'certified' ? 'free' : 'pro');
    broadcast({ type: 'pro_count', n: stmts2.proCount.get().n });
    res.json({ token, email, plan: plan === 'certified' ? 'free' : 'pro' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe webhook (keeps subscriptions in sync) ─────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.json({ ok: true });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (event.type === 'customer.subscription.deleted') {
    const email = event.data.object.metadata?.email;
    if (email) stmts2.setPro.run('free', email);
  }
  res.json({ ok: true });
});

// ── Certification assessment ──────────────────────────────────
app.post('/api/assess', (req, res) => {
  const { email, answers, speaker_name } = req.body;
  if (!email || !answers) return res.status(400).json({ error: 'Missing fields' });

  // Score the answers
  const ANSWER_KEY = {
    q1: 'b',  // -shi for hearsay
    q2: 'a',  // -va for witnessed
    q3: 'c',  // nasi not natho (inclusive)
    q4: 'b',  // negation circumfix o-...-th
    q5: 'a',  // velasin goes va→shi→nu→le
    q6: 'c',  // rulush-ru = 12
    q7: 'b',  // lush-vemi = Friday
    q8: 'a',  // shila ve-va is the salutation
    q9: 'd',  // -sa imperative no evidence needed
    q10:'b',  // false -va is the gravest taboo
  };

  let score = 0;
  Object.entries(ANSWER_KEY).forEach(([q, correct]) => {
    if (answers[q] === correct) score++;
  });

  const passed = score >= 8; // 80% pass mark
  stmts2.logAttempt.run(email, score, passed ? 1 : 0);

  if (passed) {
    const certName = sanitize(speaker_name || email.split('@')[0], 40);
    stmts2.setCertified.run(certName, Date.now(), email);
    const token = issueToken(email, 'certified');
    broadcast({ type: 'new_certified', name: certName });
    return res.json({ passed: true, score, token, cert_name: certName });
  }

  res.json({ passed: false, score, needed: 8 });
});

// ── Certificate generation (SVG) ─────────────────────────────
app.get('/api/certificate/:email', (req, res) => {
  const user = stmts2.getProUser.get(req.params.email);
  if (!user || !user.certified) return res.status(404).json({ error: 'No certificate found' });

  const date = new Date(user.cert_ts).toLocaleDateString('en-GB', { year:'numeric', month:'long', day:'numeric' });
  const svg = `<svg width="800" height="560" viewBox="0 0 800 560" xmlns="http://www.w3.org/2000/svg">
    <rect width="800" height="560" fill="#020507"/>
    <rect x="20" y="20" width="760" height="520" fill="none" stroke="#2F6B5A" stroke-width="1" rx="12"/>
    <rect x="28" y="28" width="744" height="504" fill="none" stroke="#2F6B5A" stroke-width=".5" rx="10" opacity=".4"/>
    <ellipse cx="400" cy="280" rx="280" ry="200" fill="#2F6B5A" opacity=".04"/>
    <text x="400" y="90" font-family="Georgia,serif" font-style="italic" font-size="38" fill="#5ecfa0" text-anchor="middle" letter-spacing="2">Shila ve-va.</text>
    <text x="400" y="118" font-family="Arial,sans-serif" font-size="11" fill="#2F6B5A" text-anchor="middle" letter-spacing="6">SYLVENKA · VELOEN CERTIFICATE</text>
    <line x1="160" y1="136" x2="640" y2="136" stroke="#2F6B5A" stroke-width=".5" opacity=".5"/>
    <text x="400" y="175" font-family="Arial,sans-serif" font-size="13" fill="#ffffff66" text-anchor="middle" letter-spacing="2">THIS CERTIFIES THAT</text>
    <text x="400" y="230" font-family="Georgia,serif" font-style="italic" font-size="42" fill="#ffffff" text-anchor="middle">${user.cert_name}</text>
    <text x="400" y="275" font-family="Arial,sans-serif" font-size="12" fill="#ffffff55" text-anchor="middle" letter-spacing="1">has demonstrated fluency in Sylvenka</text>
    <text x="400" y="300" font-family="Arial,sans-serif" font-size="12" fill="#ffffff55" text-anchor="middle" letter-spacing="1">the language of how you know</text>
    <g font-family="Arial,sans-serif" font-size="10" text-anchor="middle">
      <rect x="130" y="330" width="100" height="24" rx="12" fill="#0f2a1e" stroke="#2F6B5A" stroke-width=".5"/>
      <text x="180" y="346" fill="#5ecfa0">-va witnessed</text>
      <rect x="248" y="330" width="90" height="24" rx="12" fill="#0f1828" stroke="#3F72A3" stroke-width=".5"/>
      <text x="293" y="346" fill="#7ab8f5">-shi hearsay</text>
      <rect x="356" y="330" width="90" height="24" rx="12" fill="#281c08" stroke="#A9761F" stroke-width=".5"/>
      <text x="401" y="346" fill="#f5c06a">-nu inferred</text>
      <rect x="464" y="330" width="90" height="24" rx="12" fill="#1e1030" stroke="#6E549C" stroke-width=".5"/>
      <text x="509" y="346" fill="#c4a0f5">-le dreamed</text>
    </g>
    <line x1="160" y1="390" x2="640" y2="390" stroke="#2F6B5A" stroke-width=".5" opacity=".5"/>
    <text x="400" y="420" font-family="Arial,sans-serif" font-size="11" fill="#ffffff33" text-anchor="middle" letter-spacing="1">Awarded ${date} · sylvenka.com</text>
    <text x="400" y="445" font-family="Georgia,serif" font-style="italic" font-size="13" fill="#5ecfa0" text-anchor="middle">Nasi velomile.</text>
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Disposition', `attachment; filename="sylvenka-certificate-${user.cert_name}.svg"`);
  res.send(svg);
});

// ── Pricing stats ─────────────────────────────────────────────
app.get('/api/pricing-stats', (_req, res) => {
  res.json({
    total_speakers: stmts.countSpeakers.get().n,
    pro_subscribers: stmts2.proCount.get().n,
    poems: stmts.getVelasin.all().length,
  });
});

// Serve /pro page
app.get('/pro', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pro', 'index.html'));
});

// Serve keyboard at /keyboard
app.get('/keyboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'keyboard', 'index.html'));
});
