#!/bin/bash

echo "╔════════════════════════════════════════╗"
echo "║  Backend Debug Script                  ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Stop existing containers
echo "Cleaning up existing containers..."
docker compose down -v 2>/dev/null || true
sleep 2

# Start backend in foreground for debugging
echo ""
echo "Starting backend container in foreground (Ctrl+C to stop)..."
echo "This will show all logs directly"
echo ""
echo "════════════════════════════════════════"

docker compose up backend

echo ""
echo "════════════════════════════════════════"
echo "Backend stopped"
