/**
 * Unlimited GBP Stats — Sync Server
 *
 * REST API that stores a server-side copy of all GBP performance data.
 * Every time the Chrome extension fetches new data it calls POST /api/sync.
 * The dashboard can call GET /api/business/:locationCode to pull all server data.
 *
 * Deploy anywhere Node.js runs:
 *   • Locally:  npm start  (http://localhost:3000)
 *   • Railway / Render / Fly.io — just point at this file
 *   • VPS:  pm2 start server.js
 *
 * Quick start:
 *   cp .env.example .env
 *   npm install
 *   npm start
 */

require('dotenv').config();
const express   = require('express');
const Database  = require('better-sqlite3');
const cors      = require('cors');
const path      = require('path');

const app      = express();
const PORT     = process.env.PORT     || 3000;
const API_KEY  = process.env.API_KEY  || 'change-me-secret-key';
const DB_PATH  = process.env.DB_PATH  || path.join(__dirname, 'gbp_data.sqlite');
const VERBOSE  = process.env.VERBOSE  === 'true';

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // better concurrency
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    location_code TEXT PRIMARY KEY,
    name          TEXT,
    last_updated  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id            TEXT PRIMARY KEY,
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
    FOREIGN KEY (location_code) REFERENCES businesses(location_code)
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_loc      ON metrics(location_code);
  CREATE INDEX IF NOT EXISTS idx_metrics_loc_type ON metrics(location_code, metric_type);
  CREATE INDEX IF NOT EXISTS idx_metrics_synced   ON metrics(synced_at);
`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  upsertBusiness: db.prepare(`
    INSERT INTO businesses (location_code, name, last_updated)
    VALUES (?, ?, ?)
    ON CONFLICT(location_code) DO UPDATE SET
      name         = excluded.name,
      last_updated = excluded.last_updated
  `),

  getMetricById: db.prepare(`SELECT id, derived FROM metrics WHERE id = ?`),

  upsertMetric: db.prepare(`
    INSERT INTO metrics
      (id, location_code, metric_type, year, month, total, daily,
       yoy_percent, extra, derived, collected_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      total        = excluded.total,
      daily        = excluded.daily,
      yoy_percent  = excluded.yoy_percent,
      extra        = excluded.extra,
      derived      = excluded.derived,
      collected_at = excluded.collected_at,
      synced_at    = excluded.synced_at
  `),

  getBusiness:     db.prepare(`SELECT * FROM businesses WHERE location_code = ?`),
  getAllBusinesses: db.prepare(`
    SELECT b.location_code, b.name, b.last_updated,
           COUNT(m.id) AS record_count,
           MAX(m.synced_at) AS last_synced
    FROM   businesses b
    LEFT JOIN metrics m ON b.location_code = m.location_code
    GROUP BY b.location_code
    ORDER BY b.last_updated DESC
  `),
  getMetricsSince: db.prepare(`
    SELECT * FROM metrics
    WHERE location_code = ? AND synced_at > ?
    ORDER BY year, month
  `),
  getAllMetrics: db.prepare(`
    SELECT * FROM metrics
    WHERE location_code = ?
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

/**
 * Upsert one metric record.
 * Real data (derived=false) always wins over estimated (derived=true).
 * Returns 'saved' | 'skipped'.
 */
function saveOneMetric(locationCode, metric) {
  const id       = makeMetricId(locationCode, metric.metricType, metric.year, metric.month);
  const existing = stmts.getMetricById.get(id);
  const isReal   = !metric.derived;

  // Don't overwrite real data with derived/estimated data
  if (existing && existing.derived === 0 && !isReal) return 'skipped';

  stmts.upsertMetric.run(
    id,
    locationCode,
    metric.metricType,
    metric.year,
    metric.month,
    metric.total   || 0,
    JSON.stringify(metric.daily || []),
    metric.yoyPercent ?? null,
    JSON.stringify(buildExtra(metric)),
    isReal ? 0 : 1,
    metric.collectedAt || Date.now(),
    Date.now()
  );
  return 'saved';
}

/** Extract "extra" fields (everything beyond the core metric fields). */
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

/** API key authentication — every /api/* route requires X-Api-Key header. */
function auth(req, res, next) {
  if (!API_KEY || API_KEY === 'change-me-secret-key') {
    // Warn loudly if using the default key
    console.warn('[GBP] ⚠  WARNING: Using default API_KEY — set a real secret in .env!');
  }
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — wrong or missing X-Api-Key header.' });
  }
  next();
}

app.use('/api', auth);

// ── Routes ────────────────────────────────────────────────────────────────────

/** Health check — no auth required so the extension can test connectivity. */
app.get('/health', (req, res) => {
  const bizCount = db.prepare('SELECT COUNT(*) AS n FROM businesses').get().n;
  const recCount = db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n;
  res.json({
    ok:         true,
    version:    '1.0.0',
    businesses: bizCount,
    records:    recCount,
  });
});

/**
 * POST /api/sync
 * Receive a single metric record from the extension and save it.
 *
 * Body: {
 *   locationCode: "12345678901234567890",
 *   businessName: "My Bakery",
 *   metric: { metricType, year, month, total, daily, yoyPercent, derived?, ...extra }
 * }
 */
app.post('/api/sync', (req, res) => {
  const { locationCode, businessName, metric } = req.body || {};
  if (!locationCode || !metric?.metricType) {
    return res.status(400).json({ error: 'Missing locationCode or metric.metricType' });
  }

  if (VERBOSE) console.log(`[GBP] SYNC  ${locationCode}  ${metric.metricType}  ${metric.year}-${metric.month}`);

  stmts.upsertBusiness.run(locationCode, businessName || locationCode, Date.now());
  const status = saveOneMetric(locationCode, metric);

  res.json({ success: true, status, id: makeMetricId(locationCode, metric.metricType, metric.year, metric.month) });
});

/**
 * POST /api/sync-bulk
 * Sync many records at once (used when exporting a full local DB to the server).
 *
 * Body: {
 *   locationCode: "...",
 *   businessName: "...",
 *   metrics: [ { metricType, year, month, total, daily, ... }, ... ]
 * }
 */
app.post('/api/sync-bulk', (req, res) => {
  const { locationCode, businessName, metrics } = req.body || {};
  if (!locationCode || !Array.isArray(metrics)) {
    return res.status(400).json({ error: 'Missing locationCode or metrics array' });
  }

  stmts.upsertBusiness.run(locationCode, businessName || locationCode, Date.now());

  const bulkInsert = db.transaction(() => {
    let saved = 0, skipped = 0;
    for (const m of metrics) {
      const status = saveOneMetric(locationCode, m);
      status === 'saved' ? saved++ : skipped++;
    }
    return { saved, skipped };
  });

  const counts = bulkInsert();
  if (VERBOSE) console.log(`[GBP] BULK-SYNC  ${locationCode}  saved=${counts.saved}  skipped=${counts.skipped}`);

  res.json({ success: true, ...counts, total: metrics.length });
});

/**
 * GET /api/business/:locationCode
 * Return all (or only new) metrics for a business.
 *
 * Query params:
 *   since=<timestamp_ms>  — only return records synced after this timestamp
 */
app.get('/api/business/:locationCode', (req, res) => {
  const { locationCode } = req.params;
  const since = parseInt(req.query.since) || 0;

  const business = stmts.getBusiness.get(locationCode);
  if (!business) return res.status(404).json({ error: 'Business not found on server' });

  const rows    = since > 0
    ? stmts.getMetricsSince.all(locationCode, since)
    : stmts.getAllMetrics.all(locationCode);

  const metrics = rows.map(metricRowToObject);

  res.json({
    success:  true,
    business: { id: business.location_code, name: business.name, lastUpdated: business.last_updated },
    metrics,
    count:    metrics.length,
  });
});

/**
 * GET /api/businesses
 * List all businesses stored on the server with their record counts.
 */
app.get('/api/businesses', (req, res) => {
  const rows = stmts.getAllBusinesses.all();
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

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  GBP Stats Sync Server running on http://localhost:${PORT}`);
  console.log(`    Health:   http://localhost:${PORT}/health`);
  console.log(`    API key:  ${API_KEY === 'change-me-secret-key' ? '⚠  DEFAULT — update .env!' : '✓ set'}`);
  console.log(`    DB:       ${DB_PATH}\n`);
});
