# SQLite → Postgres user migration

One-off. Folds every legacy account from the SQLite sync server
(`gbp_sync_server`) into the Postgres backend's `users` table, so identity lives
in one place. Passwords keep working — the bcrypt hashes carry over unchanged.

Prereq: the `20260906120000_auth_email_password` migration is applied on the
Postgres DB (it runs automatically on the next `gbp_backend` deploy via
`entrypoint.sh`).

## 1. Export from SQLite

Runs inside the sync-server container (it has `better-sqlite3` and the DB
volume). Read-only — never writes to the SQLite file.

```bash
docker exec gbp_sync_server node scripts/export-users.js > /tmp/users.json
docker cp gbp_sync_server:/tmp/users.json ./users.json   # if the next step runs elsewhere
```

`users.json` shape: `{ exportedAt, users: [{ id, email, password, name, google_id, created_at, last_login }] }`.
`password` is the raw bcrypt hash (`''` = a Google-only account).

## 2. Dry run (no writes)

Copy `users.json` into the backend container, then:

```bash
docker cp ./users.json gbp_backend:/tmp/users.json
docker exec gbp_backend npx ts-node scripts/import-sqlite-users.ts --input /tmp/users.json
```

Prints the plan: `CREATE` / `UPDATE` (with reasons) / `CONFLICT`. **Resolve every
CONFLICT by hand before applying** — they are genuine identity clashes (same
email with a different `google_id`, or a `google_id` already owned by another
Postgres user) and are never guessed.

Matching is by normalized email. For an existing Postgres user the script only
*adds* missing pieces: attaches the password hash if there was none, links the
`google_id` if there was none, keeps the earliest `createdAt` / latest
`lastLoginAt`, marks Google-linked accounts verified. It never overwrites an
existing password or name.

## 3. Apply

```bash
docker exec gbp_backend npx ts-node scripts/import-sqlite-users.ts --input /tmp/users.json --apply
```

Idempotent — safe to re-run. Each created/updated user also gets its personal
Organization + Membership (`resolveOrgId`) so plan/role gating has something to
read.

## 4. Verify

```bash
docker exec gbp_postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT count(*) FILTER (WHERE password_hash IS NOT NULL) AS with_pw,
          count(*) FILTER (WHERE google_id IS NOT NULL)     AS with_google,
          count(*)                                          AS total
   FROM users;"
```

Then have a known user sign in through the extension and the web
(`/backend/auth/login`) — both should succeed with the same credentials.

## After migration

The SQLite server is no longer an identity source. Metrics sync already runs
Postgres-only (extension ≥ 1.29.0, `gbpSyncV2` default on). Once the metrics
backfill (`backfill-sqlite-metrics.ts`) is done and confidence is high, the
`gbp_sync_server` container can be retired — see `deployment_topology`.
