#!/bin/bash

set -e

echo "╔════════════════════════════════════════╗"
echo "║  Local Backend Testing Script          ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Check if docker and docker-compose are available
if ! command -v docker &> /dev/null; then
  echo "✗ Docker is not installed"
  exit 1
fi

if ! command -v docker compose &> /dev/null; then
  echo "✗ Docker Compose is not installed"
  exit 1
fi

echo "✓ Docker and Docker Compose are available"
echo ""

# Stop any existing containers
echo "Stopping any existing containers..."
docker compose down -v 2>/dev/null || true
sleep 2

# Start services
echo ""
echo "Starting services with docker-compose..."
docker compose up -d

echo "Waiting 5 seconds for services to initialize..."
sleep 5

# Check docker status
echo ""
echo "Docker container status:"
docker ps -a

echo ""
echo "═══════════════════════════════════════"
echo "Checking Backend Connection"
echo "═══════════════════════════════════════"
echo ""

# Wait for backend
max_attempts=90
attempt=1
while [ $attempt -le $max_attempts ]; do
  status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health 2>/dev/null || echo "000")

  if [ "$status" = "200" ]; then
    echo "✓ Backend is responding! (HTTP $status)"
    echo ""
    break
  fi

  if [ $((attempt % 15)) -eq 1 ] || [ $attempt -eq 1 ]; then
    echo "Attempt $attempt/$max_attempts: HTTP status $status"
  fi

  sleep 1
  attempt=$((attempt + 1))
done

if [ $attempt -gt $max_attempts ]; then
  echo ""
  echo "✗ Backend failed to respond"
  echo ""
  echo "════ Backend Logs ════"
  docker compose logs backend
  echo ""
  echo "════ All Container Logs ════"
  docker compose logs
  echo ""
  echo "Cleaning up..."
  docker compose down -v
  exit 1
fi

# Run tests
echo ""
echo "═══════════════════════════════════════"
echo "Running API Tests"
echo "═══════════════════════════════════════"
echo ""
bash backend/tests/api-tests.sh

test_result=$?

# Cleanup
echo ""
echo "Cleaning up containers..."
docker compose down -v

if [ $test_result -eq 0 ]; then
  echo ""
  echo "✓ All tests passed!"
  exit 0
else
  echo ""
  echo "✗ Tests failed"
  exit 1
fi
