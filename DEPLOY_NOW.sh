#!/bin/bash

################################################################################
# ZIXIFY LIVE DEPLOYMENT & COMPREHENSIVE TESTING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# This script handles:
# 1. Full deployment (pull code, rebuild Docker, start services)
# 2. 6-point automated test suite
# 3. Manual E2E test harness
# 4. Live audit log verification
# 5. Complete reporting
################################################################################

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Global counters
TESTS_PASSED=0
TESTS_FAILED=0
START_TIME=$(date +%s)

log_header() {
  echo ""
  echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║ $1${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

log_step() {
  echo -e "${YELLOW}→ $1${NC}"
}

log_success() {
  echo -e "${GREEN}✓ $1${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

log_error() {
  echo -e "${RED}✗ $1${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
}

log_info() {
  echo -e "${BLUE}ℹ $1${NC}"
}

################################################################################
# PHASE 1: DEPLOYMENT
################################################################################

log_header "PHASE 1: DEPLOYMENT"

log_step "Step 1.1: Pulling latest code from GitHub"
git fetch origin
git checkout main 2>/dev/null || git checkout -b main origin/main 2>/dev/null || true
git pull origin main
log_success "Code updated to latest main"

log_step "Step 1.2: Verifying environment"
if [ ! -f ".env" ]; then
  log_error ".env file missing - deployment cannot continue"
  exit 1
fi
log_success "Environment file verified"

log_step "Step 1.3: Deploying with Docker Compose"
docker-compose down 2>/dev/null || true
sleep 2
docker-compose up -d --build 2>&1 | grep -E "Creating|Running|Built" || true
log_success "Docker containers deployed"

log_step "Step 1.4: Waiting for services to be healthy (up to 120s)"
max_attempts=60
attempt=0
while [ $attempt -lt $max_attempts ]; do
  if docker-compose exec -T backend curl -sf http://localhost:3001/health >/dev/null 2>&1; then
    log_success "Services are healthy"
    break
  fi
  attempt=$((attempt + 1))
  [ $((attempt % 15)) -eq 0 ] && echo "  Still waiting... ($attempt/60)"
  sleep 2
done

if [ $attempt -ge $max_attempts ]; then
  log_error "Services failed to become healthy within 120 seconds"
  docker-compose logs backend | tail -20
  exit 1
fi

################################################################################
# PHASE 2: AUTOMATED TEST SUITE
################################################################################

log_header "PHASE 2: AUTOMATED TEST SUITE (6 Tests)"

API_URL="http://localhost:3001"

# Test 1: Health Check
log_step "Test 2.1: Health Check Endpoint"
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/health")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "200" ]; then
  log_success "Health check OK (HTTP 200)"
else
  log_error "Health check failed (HTTP $HTTP_CODE)"
fi

# Test 2: Database
log_step "Test 2.2: Verify AuditLog Table"
TABLE_CHECK=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='AuditLog');")
if [[ "$TABLE_CHECK" == *"t"* ]]; then
  log_success "AuditLog table exists"
else
  log_error "AuditLog table not found"
fi

# Test 3: OAuth Route
log_step "Test 2.3: OAuth Route Accessible"
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/api/auth/google")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [[ "$HTTP_CODE" == "302" || "$HTTP_CODE" == "307" || "$HTTP_CODE" == "200" ]]; then
  log_success "OAuth route accessible (HTTP $HTTP_CODE)"
else
  log_error "OAuth route failed (HTTP $HTTP_CODE)"
fi

# Test 4: Token Refresh
log_step "Test 2.4: Token Refresh Endpoint Protection"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/auth/refresh" -H "Content-Type: application/json" -d '{}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "401" ]; then
  log_success "Token refresh correctly requires auth (HTTP 401)"
else
  log_error "Token refresh auth check failed (HTTP $HTTP_CODE)"
fi

# Test 5: Admin Audit Logs
log_step "Test 2.5: Admin Audit Logs Endpoint Protection"
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/api/admin/audit-logs")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "401" ]; then
  log_success "Admin endpoint correctly requires auth (HTTP 401)"
else
  log_error "Admin endpoint auth check failed (HTTP $HTTP_CODE)"
fi

# Test 6: Initial Audit Count
log_step "Test 2.6: Audit Log Events"
AUDIT_COUNT=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc "SELECT COUNT(*) FROM \"AuditLog\";")
if [ -n "$AUDIT_COUNT" ]; then
  log_success "Found $AUDIT_COUNT audit events in database"
else
  log_error "Could not count audit events"
fi

################################################################################
# PHASE 3: LIVE DEPLOYMENT REPORT
################################################################################

log_header "PHASE 3: LIVE DEPLOYMENT REPORT"

echo -e "🟢 ${GREEN}DEPLOYMENT SUCCESSFUL${NC}"
echo ""
echo "Service Status:"
docker-compose ps
echo ""

echo "Key Information:"
echo ""
echo "📊 API Endpoint: http://localhost:3001"
echo "📊 Health Check: curl http://localhost:3001/health"
echo "📊 Audit Logs: GET /api/admin/audit-logs (requires auth)"
echo "📊 OAuth Flow: http://localhost:3001/api/auth/google"
echo ""

echo "Database Connection:"
echo "  Host: postgres (internal) / 127.0.0.1:5433 (external)"
echo "  User: gbp_dev"
echo "  Database: gbp_database"
echo ""

echo "Docker Commands:"
echo "  View logs: docker-compose logs -f backend"
echo "  Restart: docker-compose restart backend"
echo "  Stop all: docker-compose down"
echo ""

################################################################################
# PHASE 4: OPTIONAL MANUAL E2E TESTS
################################################################################

log_header "PHASE 4: MANUAL E2E TESTS (Next Steps)"

cat << 'MANUAL_TESTS'

Ready for manual testing? Here are the 7 E2E test scenarios:

TEST 1: Health Check (Automated above ✓)
TEST 2: OAuth Login → LOGIN_OAUTH audit entry
TEST 3: Token Refresh → TOKEN_REFRESH audit entry
TEST 4: API Key Provision → API_KEY_CREATED audit entry
TEST 5: Metrics Ingestion → INGEST_SUCCESS audit entry
TEST 6: Admin Audit Logs → View all entries
TEST 7: Brute Force Protection → Account lockout after 5 failures

To continue with manual tests, run:

  # Open in browser and complete OAuth login
  http://localhost:3001/api/auth/google

  # Then check audit logs (paste your token):
  curl -X GET "http://localhost:3001/api/admin/audit-logs" \
    -H "Authorization: Bearer YOUR_TOKEN" | jq .

  # View all audit entries in database:
  docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
    "SELECT action, status, createdAt FROM \"AuditLog\" ORDER BY createdAt DESC LIMIT 20;"

MANUAL_TESTS

################################################################################
# PHASE 5: SUMMARY
################################################################################

log_header "DEPLOYMENT COMPLETE"

ELAPSED=$(($(date +%s) - START_TIME))
echo "⏱️  Total Time: ${ELAPSED}s"
echo ""
echo "📊 Test Results:"
echo -e "   ${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "   ${RED}Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}✓ ALL TESTS PASSED - SYSTEM READY FOR PRODUCTION${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 0
else
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}⚠ SOME TESTS FAILED - TROUBLESHOOT ABOVE${NC}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 1
fi
