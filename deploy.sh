#!/bin/bash

# Zixify Backend Deployment Script
# Usage: ./deploy.sh

set -e  # Exit on error

echo "======================================"
echo "Zixify Backend Deployment"
echo "======================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

log_info() {
  echo -e "${YELLOW}→ $1${NC}"
}

log_error() {
  echo -e "${RED}✗ $1${NC}"
}

# Step 1: Verify environment
log_info "Step 1: Verifying environment"
if [ ! -f "docker-compose.yml" ]; then
  log_error "docker-compose.yml not found. Run from repository root."
  exit 1
fi
log_success "Found docker-compose.yml"

# Step 2: Pull latest code
log_info "Step 2: Pulling latest code from GitHub"
git fetch origin
git checkout claude/vigorous-lovelace-436741 2>/dev/null || {
  log_info "Branch doesn't exist locally, checking out new"
  git checkout -b claude/vigorous-lovelace-436741 origin/claude/vigorous-lovelace-436741
}
git pull origin claude/vigorous-lovelace-436741
log_success "Code updated"

# Step 3: Verify environment variables
log_info "Step 3: Checking environment variables"
if [ ! -f ".env" ]; then
  log_error ".env file not found!"
  echo "Please create .env with the following variables:"
  echo "  DATABASE_URL=postgresql://..."
  echo "  JWT_SECRET=..."
  echo "  SESSION_SECRET=..."
  echo "  GOOGLE_CLIENT_ID=..."
  echo "  GOOGLE_CLIENT_SECRET=..."
  echo "  GOOGLE_REDIRECT_URI=..."
  exit 1
fi

# Check critical env vars
required_vars=("DATABASE_URL" "JWT_SECRET" "SESSION_SECRET" "GOOGLE_CLIENT_ID" "GOOGLE_CLIENT_SECRET")
for var in "${required_vars[@]}"; do
  if ! grep -q "^$var=" .env; then
    log_error "Missing required variable: $var"
    exit 1
  fi
done
log_success "Environment variables verified"

# Step 4: Stop existing containers
log_info "Step 4: Stopping existing containers"
docker-compose down 2>/dev/null || true
sleep 2
log_success "Containers stopped"

# Step 5: Build and start containers
log_info "Step 5: Building and starting Docker containers"
docker-compose up -d --build
log_success "Docker containers started"

# Step 6: Wait for services to be healthy
log_info "Step 6: Waiting for services to be healthy (up to 120 seconds)"
max_attempts=60
attempt=0

until [ $attempt -ge $max_attempts ]; do
  if docker-compose exec -T backend curl -sf http://localhost:3001/health >/dev/null 2>&1; then
    log_success "Backend is healthy!"
    break
  fi

  attempt=$((attempt + 1))
  if [ $((attempt % 10)) -eq 0 ]; then
    echo "  Waiting... ($attempt/$max_attempts)"
  fi
  sleep 2
done

if [ $attempt -ge $max_attempts ]; then
  log_error "Services failed to become healthy within 120 seconds"
  echo ""
  echo "Docker container status:"
  docker-compose ps
  echo ""
  echo "Backend logs:"
  docker-compose logs backend | tail -20
  exit 1
fi

# Step 7: Verify database migrations
log_info "Step 7: Verifying database migrations"
sleep 2  # Give database a moment to settle
if docker-compose exec -T backend npm run build >/dev/null 2>&1; then
  log_success "TypeScript build successful"
else
  log_error "TypeScript build failed"
  docker-compose logs backend
  exit 1
fi

# Step 8: Display summary
echo ""
echo "======================================"
log_success "Deployment Complete!"
echo "======================================"
echo ""
echo "Services running:"
docker-compose ps
echo ""
echo "Next steps:"
echo "  1. Run tests: bash test.sh"
echo "  2. Check logs: docker-compose logs -f backend"
echo "  3. Access API: http://localhost:3001/health"
echo ""
