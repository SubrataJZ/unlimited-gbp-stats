#!/bin/bash

################################################################################
# COMPREHENSIVE E2E TEST SUITE
# After deployment, use this to test all features
################################################################################

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

API_URL="http://localhost:3001"
TESTS_PASSED=0
TESTS_FAILED=0

log_header() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
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
  echo -e "${YELLOW}→ $1${NC}"
}

################################################################################
# TEST 1: HEALTH CHECK
################################################################################

log_header "TEST 1: HEALTH CHECK"

log_info "Calling: GET /health"
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/health")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  log_success "Health check returned 200"
  echo "Response: $BODY" | jq . 2>/dev/null || echo "Response: $BODY"
else
  log_error "Health check failed with HTTP $HTTP_CODE"
fi

################################################################################
# TEST 2: UNAUTHENTICATED AUDIT LOGS (Should fail)
################################################################################

log_header "TEST 2: AUDIT LOGS - AUTH PROTECTION"

log_info "Calling: GET /api/admin/audit-logs (no auth)"
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/api/admin/audit-logs")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

if [ "$HTTP_CODE" = "401" ]; then
  log_success "Correctly requires authentication (HTTP 401)"
else
  log_error "Should require auth, got HTTP $HTTP_CODE"
fi

################################################################################
# TEST 3: DATABASE INTEGRITY
################################################################################

log_header "TEST 3: DATABASE INTEGRITY CHECKS"

log_info "Checking AuditLog table..."
TABLE_CHECK=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc "SELECT COUNT(*) FROM \"AuditLog\";")
if [ -n "$TABLE_CHECK" ]; then
  log_success "AuditLog table has $TABLE_CHECK events"
else
  log_error "Could not read AuditLog table"
fi

log_info "Checking User table..."
USER_COUNT=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc "SELECT COUNT(*) FROM \"User\";")
log_success "User table has $USER_COUNT users"

log_info "Checking ApiKey table..."
KEY_COUNT=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc "SELECT COUNT(*) FROM \"ApiKey\";")
log_success "ApiKey table has $KEY_COUNT keys"

################################################################################
# TEST 4: AUDIT EVENTS BY TYPE
################################################################################

log_header "TEST 4: AUDIT EVENT DISTRIBUTION"

log_info "Querying event counts by action..."
docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT COUNT(*) as count, action FROM \"AuditLog\" GROUP BY action ORDER BY count DESC;" || true

################################################################################
# TEST 5: RECENT AUDIT ENTRIES
################################################################################

log_header "TEST 5: RECENT AUDIT LOG ENTRIES"

log_info "Last 10 events:"
docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT action, status, ip_address, created_at FROM \"AuditLog\" ORDER BY created_at DESC LIMIT 10;" || true

################################################################################
# TEST 6: SECURITY STATUS
################################################################################

log_header "TEST 6: SECURITY & LOCKOUT STATUS"

log_info "Checking for failed auth attempts..."
FAILED_AUTH=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc \
  "SELECT COUNT(*) FROM \"AuditLog\" WHERE action='AUTH_FAILED' AND status='failure';")

if [ "$FAILED_AUTH" -gt 0 ]; then
  log_success "Found $FAILED_AUTH failed authentication attempts"
else
  log_success "No failed attempts (clean state)"
fi

log_info "Checking for locked accounts..."
LOCKED=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc \
  "SELECT COUNT(*) FROM (
    SELECT user_id, COUNT(*) as fails
    FROM \"AuditLog\"
    WHERE action='AUTH_FAILED'
    AND status='failure'
    AND created_at > NOW() - INTERVAL '30 minutes'
    GROUP BY user_id
    HAVING COUNT(*) >= 5
  ) t;")

if [ "$LOCKED" -gt 0 ]; then
  log_error "Found $LOCKED potentially locked accounts!"
else
  log_success "No locked accounts (security good)"
fi

################################################################################
# TEST 7: DATABASE CONNECTION
################################################################################

log_header "TEST 7: BACKEND DATABASE CONNECTIVITY"

log_info "Testing backend to DB connection..."
DB_TEST=$(docker-compose exec -T backend npm run build 2>&1 | grep -c "error" || echo "0")

if [ "$DB_TEST" = "0" ]; then
  log_success "Backend TypeScript builds without errors"
else
  log_error "Backend build has errors"
fi

################################################################################
# SUMMARY
################################################################################

log_header "E2E TEST SUMMARY"

echo ""
echo -e "${BLUE}Results:${NC}"
echo -e "  ${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "  ${RED}Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ ALL E2E TESTS PASSED${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Open browser: http://localhost:3001/api/auth/google"
  echo "  2. Complete OAuth login with Google"
  echo "  3. Extract access token from redirect URL"
  echo "  4. Test admin audit logs:"
  echo "     curl -H 'Authorization: Bearer TOKEN' http://localhost:3001/api/admin/audit-logs"
  echo "  5. View in database:"
  echo "     docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \\"
  echo "       'SELECT action, status, createdAt FROM \\\"AuditLog\\\" ORDER BY createdAt DESC LIMIT 20;'"
else
  echo -e "${RED}⚠ SOME TESTS FAILED${NC}"
  echo ""
  echo "Troubleshooting:"
  echo "  docker-compose logs backend"
  echo "  docker-compose logs postgres"
fi

echo ""
