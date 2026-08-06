#!/bin/sh

echo "================================"
echo "Zixify Backend Startup"
echo "================================"
echo ""
echo "Environment:"
echo "  NODE_ENV: $NODE_ENV"
echo "  PORT: $PORT"
echo "  DATABASE_URL: ${DATABASE_URL:0:50}..."
echo ""

# Wait for database with better error handling
echo "Step 1: Waiting for database to be ready..."
max_attempts=60
attempt=1
db_ready=false

while [ $attempt -le $max_attempts ]; do
  if nc -z postgres 5432 2>/dev/null; then
    echo "✓ Database port 5432 is reachable"
    db_ready=true
    break
  fi

  if [ $((attempt % 10)) -eq 1 ] || [ $attempt -eq 1 ]; then
    echo "  Attempt $attempt/$max_attempts..."
  fi
  sleep 1
  attempt=$((attempt + 1))
done

if [ "$db_ready" = false ]; then
  echo "✗ Could not reach database at postgres:5432"
  exit 1
fi

# Wait a bit more for postgres to fully initialize
sleep 3

# ── Step 2: migrations ───────────────────────────────────────────────────────
#
# This used to run `prisma db push --accept-data-loss` on EVERY container
# start. That flag authorises Prisma to drop columns and tables in order to
# make the database match schema.prisma, which means any accidental deletion
# in the schema file became silent production data loss on the next deploy,
# with no review step in between. `migrate deploy` cannot do that: it only
# ever runs the SQL committed under prisma/migrations, and it refuses to run
# anything it does not recognise.
#
# One wrinkle. Because every previous release used db push, the production
# database has tables but no migration history, so a first `migrate deploy`
# there fails with P3005 ("the database schema is not empty"). Prisma's
# documented remedy is to baseline: record the existing migrations as already
# applied without executing their SQL. That only ever writes rows to
# _prisma_migrations, so it cannot touch application data. We do it lazily,
# and ONLY after a deploy has actually failed for that reason — never
# speculatively, and never on a fresh database, where the normal path applies
# every migration properly from scratch.
echo ""
echo "Step 2: Applying database migrations..."

run_migrate_deploy() {
  migrate_out=$(npx prisma migrate deploy 2>&1)
  migrate_rc=$?
  echo "$migrate_out"
  return $migrate_rc
}

baseline_existing_migrations() {
  echo ""
  echo "→ Database already has these tables but no usable migration history."
  echo "  Baselining: recording the migration(s) as applied. No SQL is run and"
  echo "  no data is touched — this only writes to _prisma_migrations."
  echo "  'migrate resolve --applied' also clears a migration recorded as"
  echo "  failed, which is what unblocks P3018."
  for dir in ./prisma/migrations/*/; do
    [ -f "${dir}migration.sql" ] || continue
    name=$(basename "$dir")
    echo "  · $name"
    npx prisma migrate resolve --applied "$name" >/dev/null 2>&1 \
      || echo "    (already recorded, skipping)"
  done
}

# Does this failure mean "the tables are already there", rather than "the SQL
# is wrong"?
#
# The first version of this check only looked for P3005. That was wrong:
# P3005 is raised by `migrate dev`, not by `migrate deploy`, which simply tries
# to apply the migration and trips over the existing objects instead —
# P3018 / SQLSTATE 42710, `type "Role" already exists`. The baseline branch
# therefore never ran, and the deploy failed.
#
# The guard is that this is only ever legitimate for the INIT migration.
# Baselining exists to adopt a database that predates migrations entirely; any
# LATER migration failing with "already exists" is a genuine bug, and must fail
# the deploy loudly rather than be quietly marked as done.
needs_baseline() {
  echo "$migrate_out" | grep -qE "P3005|schema is not empty" && return 0
  echo "$migrate_out" | grep -qE "P3018|already exists|42710" \
    && echo "$migrate_out" | grep -q "00000000000000_init" \
    && return 0
  return 1
}

if run_migrate_deploy; then
  echo "✓ Migrations applied"
else
  if needs_baseline; then
    baseline_existing_migrations
    if run_migrate_deploy; then
      echo "✓ Migrations applied after baselining"
    else
      echo ""
      echo "✗✗✗ MIGRATIONS FAILED AFTER BASELINING ✗✗✗"
      echo "The database schema may not match this build. Investigate before"
      echo "trusting any write path."
      [ "$STRICT_MIGRATIONS" = "1" ] && exit 1
    fi
  else
    echo ""
    echo "✗✗✗ MIGRATIONS FAILED ✗✗✗"
    echo "Refusing to fall back to a destructive schema sync. The server will"
    echo "still start so the outage is not total, but the schema may be stale."
    echo "Set STRICT_MIGRATIONS=1 to make this fatal instead."
    [ "$STRICT_MIGRATIONS" = "1" ] && exit 1
  fi
fi

echo ""
echo "Step 3: Starting Node.js backend server..."
echo "Server should be listening on 0.0.0.0:${PORT}"
echo "Health check: curl http://localhost:${PORT}/health"
echo ""

# Verify npm can be found
if ! command -v npm &> /dev/null; then
  echo "✗ npm not found in PATH"
  echo "Available PATH: $PATH"
  exit 1
fi

# Verify npm run dev command exists
if ! npm run 2>&1 | grep -q "dev"; then
  echo "⚠ 'dev' script not found in package.json"
fi

# Start the server
echo "Executing: npm run dev"
exec npm run dev
