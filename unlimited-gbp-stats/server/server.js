/**
 * Unlimited GBP Stats — Sync Server v2
 *
 * Now with user authentication (JWT).
 * Users sign up / log in via the extension popup.
 * Each user's data is isolated — they only see their own businesses.
 *
 * Deploy anywhere Node.js runs:
 *   • Locally:  npm start  (http://localhost:3000)
 *   • Railway / Render / Fly.io / VPS
 *
 * Quick start:
 *   cp .env.example .env   # set JWT_SECRET
 *   npm install
 *   npm start
 */

require('dotenv').config();
const express  = require('express');
const Database = require('better-sqlite3');
const cors     = require('cors');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const pkg      = require('./package.json');

const app        = express();
const PORT       = process.env.PORT       || 3000;
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'gbp_data.sqlite');
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required — set it in .env before starting the server');
}
const JWT_SECRET = process.env.JWT_SECRET;
const VERBOSE    = process.env.VERBOSE    === 'true';

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL DEFAULT '',
    name       TEXT    NOT NULL DEFAULT '',
    google_id  TEXT    UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    last_login INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS businesses (
    location_code TEXT    NOT NULL,
    user_id       INTEGER NOT NULL,
    name          TEXT,
    last_updated  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (location_code, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id            TEXT    NOT NULL,
    user_id       INTEGER NOT NULL,
    location_code TEXT    NOT NULL,
    metric_type   TEXT    NOT NULL,
    year          INTEGER NOT NULL,
    month         INTEGER NOT NULL,
    total         INTEGER NOT NULL DEFAULT 0,
    daily         TEXT    NOT NULL DEFAULT '[]',
    yoy_percent   REAL,
    extra         TEXT    NOT NULL DEFAULT '{}',
    derived       INTEGER NOT NULL DEFAULT 0,
    collected_at  INTEGER NOT NULL DEFAULT 0,
    synced_at     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_user      ON metrics(user_id);
  CREATE INDEX IF NOT EXISTS idx_metrics_user_loc  ON metrics(user_id, location_code);
  CREATE INDEX IF NOT EXISTS idx_metrics_synced    ON metrics(synced_at);
`);

// ── Migrate existing databases (add google_id if missing) ────────────────────
try {
  db.exec(`ALTER TABLE users ADD COLUMN google_id TEXT`);
} catch (_) { /* column already exists — ignore */ }

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  // Users
  createUser:       db.prepare(`INSERT INTO users (email, password, name) VALUES (?, ?, ?)`),
  createGoogleUser: db.prepare(`INSERT INTO users (email, password, name, google_id) VALUES (?, '', ?, ?)`),
  getUserByEmail:   db.prepare(`SELECT * FROM users WHERE email = ?`),
  getUserByGoogleId: db.prepare(`SELECT * FROM users WHERE google_id = ?`),
  getUserById:      db.prepare(`SELECT * FROM users WHERE id = ?`),
  updateLastLogin:  db.prepare(`UPDATE users SET last_login = ? WHERE id = ?`),
  linkGoogleId:     db.prepare(`UPDATE users SET google_id = ? WHERE id = ?`),

  // Businesses
  upsertBusiness: db.prepare(`
    INSERT INTO businesses (location_code, user_id, name, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(location_code, user_id) DO UPDATE SET
      name         = excluded.name,
      last_updated = excluded.last_updated
  `),
  getBusiness:     db.prepare(`SELECT * FROM businesses WHERE location_code = ? AND user_id = ?`),
  getAllBusinesses: db.prepare(`
    SELECT b.location_code, b.name, b.last_updated,
           COUNT(m.id) AS record_count,
           MAX(m.synced_at) AS last_synced
    FROM   businesses b
    LEFT JOIN metrics m ON b.location_code = m.location_code AND m.user_id = b.user_id
    WHERE  b.user_id = ?
    GROUP BY b.location_code
    ORDER BY b.last_updated DESC
  `),

  // Metrics
  getMetricById: db.prepare(`SELECT id, derived FROM metrics WHERE id = ? AND user_id = ?`),
  upsertMetric:  db.prepare(`
    INSERT INTO metrics
      (id, user_id, location_code, metric_type, year, month, total, daily,
       yoy_percent, extra, derived, collected_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, user_id) DO UPDATE SET
      total        = excluded.total,
      daily        = excluded.daily,
      yoy_percent  = excluded.yoy_percent,
      extra        = excluded.extra,
      derived      = excluded.derived,
      collected_at = excluded.collected_at,
      synced_at    = excluded.synced_at
  `),
  getMetricsSince: db.prepare(`
    SELECT * FROM metrics
    WHERE location_code = ? AND user_id = ? AND synced_at > ?
    ORDER BY year, month
  `),
  getAllMetrics: db.prepare(`
    SELECT * FROM metrics
    WHERE location_code = ? AND user_id = ?
    ORDER BY year, month
  `),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeMetricId(locationCode, metricType, year, month) {
  return `${locationCode}_${metricType}_${year}-${String(month).padStart(2, '0')}`;
}

function metricRowToObject(row) {
  const extra = row.extra ? JSON.parse(row.extra) : {};
  return {
    id:          row.id,
    businessId:  row.location_code,
    metricType:  row.metric_type,
    year:        row.year,
    month:       row.month,
    total:       row.total,
    daily:       JSON.parse(row.daily || '[]'),
    yoyPercent:  row.yoy_percent,
    derived:     row.derived === 1,
    collectedAt: row.collected_at,
    syncedAt:    row.synced_at,
    ...extra,
  };
}

function buildExtra(metric) {
  const CORE = new Set([
    'businessId','metricType','year','month','total','daily',
    'yoyPercent','derived','collectedAt','id',
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(metric)) {
    if (!CORE.has(k)) extra[k] = v;
  }
  return extra;
}

function saveOneMetric(userId, locationCode, metric) {
  const id       = makeMetricId(locationCode, metric.metricType, metric.year, metric.month);
  const existing = stmts.getMetricById.get(id, userId);
  const isReal   = !metric.derived;

  // Never overwrite a real record with a derived one
  if (existing && existing.derived === 0 && !isReal) return 'skipped';

  // Never overwrite a real record with a lower total from another real record
  // (keeps the highest value seen across all devices/scrapes)
  if (existing && existing.derived === 0 && isReal) {
    if ((metric.total || 0) < existing.total) return 'skipped';
  }

  stmts.upsertMetric.run(
    id, userId, locationCode,
    metric.metricType, metric.year, metric.month,
    metric.total || 0,
    JSON.stringify(metric.daily || []),
    metric.yoyPercent ?? null,
    JSON.stringify(buildExtra(metric)),
    isReal ? 0 : 1,
    metric.collectedAt || Date.now(),
    Date.now()
  );
  return 'saved';
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

/** JWT auth middleware — attaches req.user on success */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token — please log in.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user    = stmts.getUserById.get(payload.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token — please log in again.' });
  }
}

// ── Auth routes (no JWT required) ─────────────────────────────────────────────

/** Health check */
app.get('/health', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const recCount  = db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n;
  res.json({ ok: true, version: pkg.version, poweredBy: 'ZixAI', users: userCount, records: recCount });
});

/**
 * POST /api/auth/register
 * Body: { email, password, name? }
 */
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name = '' } = req.body || {};

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const existing = stmts.getUserByEmail.get(email.toLowerCase());
  if (existing)
    return res.status(409).json({ error: 'An account with this email already exists.' });

  const hashed = await bcrypt.hash(password, 10);
  const result = stmts.createUser.run(email.toLowerCase(), hashed, name.trim());
  const userId = result.lastInsertRowid;

  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '90d' });

  console.log(`[GBP] New user registered: ${email}`);
  res.json({ success: true, token, user: { id: userId, email: email.toLowerCase(), name: name.trim() } });
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const user = stmts.getUserByEmail.get(email.toLowerCase());
  if (!user)
    return res.status(401).json({ error: 'No account found with this email.' });

  const match = await bcrypt.compare(password, user.password);
  if (!match)
    return res.status(401).json({ error: 'Incorrect password.' });

  stmts.updateLastLogin.run(Date.now(), user.id);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '90d' });

  console.log(`[GBP] User logged in: ${email}`);
  res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });
});

/**
 * POST /api/auth/google
 * Body: { accessToken }  — Google OAuth2 access token from the extension
 * Verifies token with Google, then finds or creates the user, returns JWT.
 */
app.post('/api/auth/google', async (req, res) => {
  const { accessToken } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: 'Access token required.' });

  // Verify token and fetch profile from Google
  let profile;
  try {
    const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!gRes.ok) return res.status(401).json({ error: 'Invalid or expired Google token.' });
    profile = await gRes.json();
  } catch (err) {
    return res.status(502).json({ error: 'Could not verify token with Google.' });
  }

  const email    = profile.email?.toLowerCase();
  const googleId = profile.sub;
  const name     = profile.name || profile.given_name || '';

  if (!email || !googleId) return res.status(400).json({ error: 'Google did not return an email.' });

  // Find existing user by google_id first, then by email
  let user = stmts.getUserByGoogleId.get(googleId) || stmts.getUserByEmail.get(email);

  if (!user) {
    const result = stmts.createGoogleUser.run(email, name, googleId);
    user = { id: result.lastInsertRowid, email, name, google_id: googleId };
    console.log(`[GBP] New Google user: ${email}`);
  } else if (!user.google_id) {
    stmts.linkGoogleId.run(googleId, user.id);
    console.log(`[GBP] Linked Google account to existing user: ${email}`);
  }

  stmts.updateLastLogin.run(Date.now(), user.id);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '90d' });

  res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });
});

/**
 * GET /api/auth/me  — verify token and return user info
 */
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: { id: req.user.id, email: req.user.email, name: req.user.name } });
});

// ── Protected API routes (JWT required) ───────────────────────────────────────

/** POST /api/sync — save one metric record */
app.post('/api/sync', requireAuth, (req, res) => {
  const { locationCode, businessName, metric } = req.body || {};
  if (!locationCode || !metric?.metricType)
    return res.status(400).json({ error: 'Missing locationCode or metric.metricType' });

  if (VERBOSE) console.log(`[GBP] SYNC  user=${req.user.id}  ${locationCode}  ${metric.metricType}  ${metric.year}-${metric.month}`);

  stmts.upsertBusiness.run(locationCode, req.user.id, businessName || locationCode, Date.now());
  const status = saveOneMetric(req.user.id, locationCode, metric);

  res.json({ success: true, status, id: makeMetricId(locationCode, metric.metricType, metric.year, metric.month) });
});

/** POST /api/sync-bulk — save many records at once */
app.post('/api/sync-bulk', requireAuth, (req, res) => {
  const { locationCode, businessName, metrics } = req.body || {};
  if (!locationCode || !Array.isArray(metrics))
    return res.status(400).json({ error: 'Missing locationCode or metrics array' });

  stmts.upsertBusiness.run(locationCode, req.user.id, businessName || locationCode, Date.now());

  const bulkInsert = db.transaction(() => {
    let saved = 0, skipped = 0;
    for (const m of metrics) {
      saveOneMetric(req.user.id, locationCode, m) === 'saved' ? saved++ : skipped++;
    }
    return { saved, skipped };
  });

  const counts = bulkInsert();
  if (VERBOSE) console.log(`[GBP] BULK  user=${req.user.id}  ${locationCode}  saved=${counts.saved}`);

  res.json({ success: true, ...counts, total: metrics.length });
});

/** GET /api/businesses — list all user's businesses */
app.get('/api/businesses', requireAuth, (req, res) => {
  const rows = stmts.getAllBusinesses.all(req.user.id);
  res.json({
    success:    true,
    businesses: rows.map(r => ({
      id:          r.location_code,
      name:        r.name,
      lastUpdated: r.last_updated,
      recordCount: r.record_count,
      lastSynced:  r.last_synced,
    })),
  });
});

/** GET /api/business/:locationCode — all metrics for one business */
app.get('/api/business/:locationCode', requireAuth, (req, res) => {
  const { locationCode } = req.params;
  const since = parseInt(req.query.since) || 0;

  const business = stmts.getBusiness.get(locationCode, req.user.id);
  if (!business) return res.status(404).json({ error: 'Business not found.' });

  const rows    = since > 0
    ? stmts.getMetricsSince.all(locationCode, req.user.id, since)
    : stmts.getAllMetrics.all(locationCode, req.user.id);

  res.json({
    success:  true,
    business: { id: business.location_code, name: business.name, lastUpdated: business.last_updated },
    metrics:  rows.map(metricRowToObject),
    count:    rows.length,
  });
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  GBP Stats Server v2 running on http://localhost:${PORT}`);
  console.log(`    Auth:     POST /api/auth/register  |  POST /api/auth/login  |  POST /api/auth/google`);
  console.log(`    Health:   GET  /health`);
  console.log(`    JWT:      ${JWT_SECRET === 'change-this-secret-in-env' ? '⚠  DEFAULT — set JWT_SECRET in .env!' : '✓ set'}\n`);
});
