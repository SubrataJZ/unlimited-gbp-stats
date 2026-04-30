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

# Run migrations
echo ""
echo "Step 2: Running Prisma migrations..."
if npx prisma db push --skip-generate --accept-data-loss 2>&1; then
  echo "✓ Database migrations completed successfully"
else
  status=$?
  echo "⚠ Prisma db push returned status $status"
  echo "This might be OK if the schema is already up to date"
  echo "Continuing with server startup..."
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
