#!/usr/bin/env node
/**
 * export-metrics.js — read-only export of the legacy SQLite metrics DB to JSON.
 *
 * This is the ONE explicitly-approved new file under the otherwise-FROZEN
 * unlimited-gbp-stats/server/ directory (see CLAUDE.md + task A6 spec). It
 * exists solely to support the one-off SQLite → Postgres metrics backfill
 * (backend/scripts/backfill-sqlite-metrics.ts). Do not add features here and
 * do not modify server.js, package.json, or the Dockerfile to support it.
 *
 * Runs inside the gbp_sync_server container, where better-sqlite3 and the
 * gbp_data volume already exist — the backend image intentionally does not
 * carry a native sqlite dependency for this one-off migration.
 *
 * Opens the SQLite file READONLY and NEVER writes to it. Writes a single
 * JSON object to stdout:
 *   { exportedAt, users: [...], businesses: [...], metrics: [...] }
 *
 * Raw values only — no mapping/transformation happens here. Mapping
 * (collectedAt derivation, extra-key extraction, etc.) is the import
 * script's job.
 *
 * Usage:
 *   node scripts/export-metrics.js [--db <path-to-sqlite-file>] > export.json
 *
 * Defaults to the same DB_PATH resolution the server itself uses (env var
 * DB_PATH, else gbp_data.sqlite next to server.js).
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') out.db = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath =
    args.db || process.env.DB_PATH || path.join(__dirname, '..', 'gbp_data.sqlite');

  // Readonly handle — this script must never write to the SQLite file.
  const db = new Database(dbPath, { readonly: true });

  try {
    const users = db.prepare('SELECT id, email, google_id FROM users').all();
    const businesses = db
      .prepare('SELECT location_code, user_id, name FROM businesses')
      .all();
    const metrics = db
      .prepare(
        `SELECT id, user_id, location_code, metric_type, year, month, total,
                daily, yoy_percent, extra, derived, collected_at, synced_at
         FROM metrics`
      )
      .all();

    const out = {
      exportedAt: new Date().toISOString(),
      users,
      businesses,
      metrics,
    };

    process.stdout.write(JSON.stringify(out));
  } finally {
    db.close();
  }
}

main();
