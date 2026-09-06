#!/usr/bin/env node
/**
 * export-users.js — read-only export of the legacy SQLite user table to JSON.
 *
 * The SECOND (and final) explicitly-approved new file under the otherwise-FROZEN
 * unlimited-gbp-stats/server/ directory, alongside export-metrics.js. It exists
 * solely to support the one-off SQLite -> Postgres USER migration
 * (backend/scripts/import-sqlite-users.ts), which unifies identity onto the
 * Postgres backend. Do not add features here; do not modify server.js,
 * package.json, or the Dockerfile.
 *
 * Runs inside the gbp_sync_server container, where better-sqlite3 and the
 * gbp_data volume already exist — the backend image intentionally carries no
 * native sqlite dependency for this one-off migration.
 *
 * Opens the SQLite file READONLY and NEVER writes to it. Emits one JSON object
 * to stdout:
 *   { exportedAt, users: [{ id, email, password, name, google_id,
 *                            created_at, last_login }] }
 *
 * `password` is the raw bcrypt hash (bcryptjs, $2a$/$2b$ — verifiable by the
 * backend's `bcrypt`). '' means a Google-only account with no password. Raw
 * values only; all mapping is the import script's job.
 *
 * Usage:
 *   node scripts/export-users.js [--db <path-to-sqlite-file>] > users.json
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

  const db = new Database(dbPath, { readonly: true });
  try {
    const users = db
      .prepare(
        `SELECT id, email, password, name, google_id, created_at, last_login
         FROM users`
      )
      .all();

    process.stdout.write(
      JSON.stringify({ exportedAt: new Date().toISOString(), users })
    );
  } finally {
    db.close();
  }
}

main();
