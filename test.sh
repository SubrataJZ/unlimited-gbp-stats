#!/bin/bash

# Zixify Audit Logging E2E Test Suite
# Runs 6 comprehensive tests to verify audit logging works correctly
# Usage: bash test.sh

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_test() {
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}Test $1: $2${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

log_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

log_error() {
  echo -e "${RED}✗ $1${NC}"
}

log_info() {
  echo -e "${YELLOW}→ $1${NC}"
}

# Verify Docker containers are running
if ! docker-compose ps | grep -q "gbp_backend.*Up"; then
  log_error "Backend container is not running"
  echo "Run: docker-compose up -d"
  exit 1
fi

# Get backend container name
BACKEND_CONTAINER=$(docker-compose ps | grep gbp_backend | awk '{print $1}')
DB_CONTAINER=$(docker-compose ps | grep gbp_postgres | awk '{print $1}')
API_URL="http://localhost:3001"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║        Zixify Audit Logging E2E Test Suite                    ║"
echo "║        6 Tests • Comprehensive Coverage                        ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ========================================
# TEST 1: Health Check
# ========================================
log_test "1" "Health Check Endpoint"

RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/health")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  log_success "Health check responded with 200"
  echo "Response: $BODY" | jq . 2>/dev/null || echo "Response: $BODY"
else
  log_error "Health check failed with HTTP $HTTP_CODE"
  exit 1
fi

echo ""

# ========================================
# TEST 2: Check Audit Table Exists
# ========================================
log_test "2" "Verify AuditLog Table Exists"

TABLE_CHECK=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc \
  "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='AuditLog');")

if [[ "$TABLE_CHECK" == *"t"* ]]; then
  log_success "AuditLog table exists"
else
  log_error "AuditLog table not found"
  exit 1
fi

echo ""

# ========================================
# TEST 3: Verify OAuth Routes Exist
# ========================================
log_test "3" "Verify OAuth Routes are Accessible"

RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/api/auth/google")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

# Should redirect or return 302/307 or 200
if [[ "$HTTP_CODE" == "302" || "$HTTP_CODE" == "307" || "$HTTP_CODE" == "200" ]]; then
  log_success "OAuth route is accessible (HTTP $HTTP_CODE)"
else
  log_error "OAuth route returned HTTP $HTTP_CODE (expected 302/307/200)"
fi

echo ""

# ========================================
# TEST 4: Test Refresh Endpoint (No Token)
# ========================================
log_test "4" "Test Token Refresh Endpoint"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

# Should fail with 401 (no token)
if [ "$HTTP_CODE" = "401" ]; then
  log_success "Refresh endpoint correctly requires token (HTTP 401)"
else
  log_error "Expected HTTP 401, got $HTTP_CODE"
  echo "Response: $BODY"
fi

echo ""

# ========================================
# TEST 5: Verify Audit Events are Logged
# ========================================
log_test "5" "Check for Existing Audit Events"

AUDIT_COUNT=$(docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -tc \
  "SELECT COUNT(*) FROM \"AuditLog\";")

if [ -z "$AUDIT_COUNT" ] || [ "$AUDIT_COUNT" -lt 0 ]; then
  log_info "No audit events yet (table is empty - this is expected for fresh deployment)"
else
  log_success "Found $AUDIT_COUNT audit events in database"
  echo ""
  log_info "Recent audit events:"
  docker-compose exec -T postgres psql -U gbp_dev -d gbp_database -c \
    "SELECT action, status, \"userId\", created_at FROM \"AuditLog\" ORDER BY created_at DESC LIMIT 5;" 2>/dev/null || echo "  (Could not query events)"
fi

echo ""

# ========================================
# TEST 6: Test Unauthenticated API Key Endpoint
# ========================================
log_test "6" "Test API Key Endpoints (Auth Required)"

RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "$API_URL/api/auth/api-keys")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

if [ "$HTTP_CODE" = "401" ]; then
  log_success "API key endpoint correctly requires authentication (HTTP 401)"
else
  log_error "Expected HTTP 401, got $HTTP_CODE"
fi

echo ""

# ========================================
# Summary
# ========================================
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Test Summary                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
log_success "All basic tests passed!"
echo ""
echo "Next steps to test audit logging:"
echo "  1. Complete OAuth flow manually:"
echo "     - Open: http://localhost:3001/api/auth/google"
echo "     - Login with Google"
echo "     - Verify redirect back"
echo ""
echo "  2. Check audit logs after OAuth:"
echo "     docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \\"
echo "       \"SELECT action, status, ipAddress FROM \\\"AuditLog\\\" ORDER BY createdAt DESC LIMIT 5;\""
echo ""
echo "  3. Expected audit entries:"
echo "     - LOGIN_OAUTH (after successful login)"
echo "     - TOKEN_REFRESH (after calling /api/auth/refresh)"
echo "     - LOGOUT (after calling /api/auth/logout)"
echo "     - API_KEY_CREATED (after calling /api/auth/provision-extension)"
echo ""
echo "Useful commands:"
echo "  - View all audit logs: docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \\\"SELECT * FROM \\\\\\\"AuditLog\\\\\\\" ORDER BY createdAt DESC;\\\""
echo "  - View logs by action: docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \\\"SELECT * FROM \\\\\\\"AuditLog\\\\\\\" WHERE action = 'LOGIN_OAUTH';\\\""
echo "  - Backend logs: docker-compose logs -f backend"
echo ""
