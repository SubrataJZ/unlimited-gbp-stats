#!/bin/bash

###############################################################################
# API Testing Script for Zixify Backend
#
# This script tests all endpoints of the backend API
# Requires: curl, jq (for JSON parsing)
#
# Usage: bash tests/api-tests.sh
###############################################################################

set -o pipefail  # Fail on pipe errors but allow continuing after individual test failures

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_URL="http://localhost:3001"
EXTENSION_ID="test-extension-id-chrome"

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

###############################################################################
# Helper Functions
###############################################################################

print_header() {
  echo ""
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}========================================${NC}"
  echo ""
}

print_test() {
  echo -e "${YELLOW}→ $1${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
  ((TESTS_PASSED++))
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
  ((TESTS_FAILED++))
}

print_info() {
  echo -e "${BLUE}ℹ $1${NC}"
}

# Check if server is running with retries
check_server() {
  print_header "Checking Server Connection"
  print_test "Checking if server is running at $API_URL..."

  max_attempts=60
  attempt=1

  while [ $attempt -le $max_attempts ]; do
    if curl -s "$API_URL/health" > /dev/null 2>&1; then
      print_success "Server is running!"
      return 0
    fi

    if [ $attempt -eq 1 ] || [ $((attempt % 10)) -eq 0 ]; then
      echo "  Attempt $attempt/$max_attempts... waiting for backend to be ready"
    fi

    sleep 1
    ((attempt++))
  done

  print_error "Server is not responding after ${max_attempts} seconds. Make sure the backend is running."
  exit 1
}

###############################################################################
# Test Cases
###############################################################################

test_health_check() {
  print_header "Test 1: Health Check Endpoint"
  print_test "GET /health"

  response=$(curl -s "$API_URL/health")
  status=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health")

  if [ "$status" = "200" ]; then
    print_success "Health check returned 200 OK"
    print_info "Response: $response"
  else
    print_error "Health check failed with status $status"
  fi
}

test_ingest_without_auth() {
  print_header "Test 2: Ingest Without Authentication (Should Fail)"
  print_test "POST /api/ingest/metrics (no auth header)"

  response=$(curl -s -X POST "$API_URL/api/ingest/metrics" \
    -H "Content-Type: application/json" \
    -d '{"businesses":[]}')

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest/metrics" \
    -H "Content-Type: application/json" \
    -d '{"businesses":[]}')

  if [ "$status" = "401" ]; then
    print_success "Correctly rejected request without API key (401 Unauthorized)"
    print_info "Response: $response"
  else
    print_error "Should have rejected with 401, got $status"
  fi
}

test_ingest_with_invalid_key() {
  print_header "Test 3: Ingest With Invalid API Key (Should Fail)"
  print_test "POST /api/ingest/metrics (invalid API key)"

  response=$(curl -s -X POST "$API_URL/api/ingest/metrics" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer invalid-key-12345" \
    -d '{"businesses":[]}')

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest/metrics" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer invalid-key-12345" \
    -d '{"businesses":[]}')

  if [ "$status" = "401" ]; then
    print_success "Correctly rejected request with invalid API key (401 Unauthorized)"
    print_info "Response: $response"
  else
    print_error "Should have rejected with 401, got $status"
  fi
}

# NOTE: a prior "Test 4: Metrics Ingest Rejects Legacy Static Key (Tenancy
# Guard)" test (test_metrics_rejects_static_key) lived here. It sent a
# hardcoded shared-secret bearer token and asserted 401. Once the legacy
# EXTENSION_INGESTION_KEY static-key auth path was removed from
# auth.middleware.ts, that token became just an arbitrary wrong credential —
# functionally identical to test_ingest_with_invalid_key below (both assert
# "an unrecognized bearer token gets 401"). Deleted as redundant rather than
# renamed, since keeping two tests asserting the same thing under different
# names invites confusion about what property each is meant to isolate.

test_locations_endpoint() {
  print_header "Test 10: Get Locations Endpoint"
  print_test "GET /api/locations (requires userId query param)"

  status=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/locations?userId=test-user-id")

  if [ "$status" = "200" ] || [ "$status" = "400" ]; then
    print_success "Locations endpoint is accessible (status $status)"
  else
    print_error "Locations endpoint failed with status $status"
  fi
}

test_email_password_auth() {
  print_header "Test 11: Email/Password Auth Flow"

  local email="ci-$(date +%s)-$RANDOM@example.test"
  local pass="correct-horse-9"
  local body ; local status

  # 1. Register
  print_test "POST /api/auth/register (new account)"
  body=$(curl -s -X POST "$API_URL/api/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$pass\",\"name\":\"CI User\"}")
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"dup-$email\",\"password\":\"$pass\"}")
  if echo "$body" | grep -q '"token"' ; then
    print_success "register returned a token"
  else
    print_error "register did not return a token: $body"
  fi

  # 2. Duplicate registration → 409
  print_test "POST /api/auth/register (same email again → 409)"
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$pass\"}")
  [ "$status" = "409" ] && print_success "duplicate rejected (409)" || print_error "expected 409, got $status"

  # 3. Weak password → 400
  print_test "POST /api/auth/register (weak password → 400)"
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"weak-$email\",\"password\":\"short\"}")
  [ "$status" = "400" ] && print_success "weak password rejected (400)" || print_error "expected 400, got $status"

  # 4. Login OK
  print_test "POST /api/auth/login (correct credentials)"
  body=$(curl -s -X POST "$API_URL/api/auth/login" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$pass\"}")
  echo "$body" | grep -q '"token"' && print_success "login returned a token" || print_error "login failed: $body"

  # 4b. Same user, two logins in the same second: refresh tokens used to be
  # identical and collide on refresh_tokens_token_key → 500.
  print_test "POST /api/auth/login x3 back-to-back (no 500)"
  local codes=""
  for _ in 1 2 3; do
    codes="$codes $(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/login" \
      -H "Content-Type: application/json" -d "{\"email\":\"$email\",\"password\":\"$pass\"}")"
  done
  [ "$codes" = " 200 200 200" ] && print_success "repeat logins all 200" || print_error "expected 200 x3, got$codes"

  # 5. Login wrong password → 401
  print_test "POST /api/auth/login (wrong password → 401)"
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"nope\"}")
  [ "$status" = "401" ] && print_success "wrong password rejected (401)" || print_error "expected 401, got $status"

  # 6. Login unknown email → 401 (same as wrong password — no enumeration)
  print_test "POST /api/auth/login (unknown email → 401)"
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"nobody-$email\",\"password\":\"$pass\"}")
  [ "$status" = "401" ] && print_success "unknown email rejected (401)" || print_error "expected 401, got $status"

  # 7. forgot-password → always 200
  print_test "POST /api/auth/forgot-password (known + unknown → both 200)"
  s1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/forgot-password" \
    -H "Content-Type: application/json" -d "{\"email\":\"$email\"}")
  s2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/forgot-password" \
    -H "Content-Type: application/json" -d "{\"email\":\"ghost-$email\"}")
  [ "$s1" = "200" ] && [ "$s2" = "200" ] && print_success "forgot-password always 200 ($s1/$s2)" \
    || print_error "expected 200/200, got $s1/$s2"

  # 8. reset-password with a bogus token → 401
  print_test "POST /api/auth/reset-password (bad token → 401)"
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"deadbeef\",\"password\":\"$pass-new\"}")
  [ "$status" = "401" ] && print_success "bogus reset token rejected (401)" || print_error "expected 401, got $status"

  # 9. change-password without auth → 401
  print_test "POST /api/auth/change-password (no auth → 401)"
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/change-password" \
    -H "Content-Type: application/json" -d '{"currentPassword":"x","newPassword":"yyyyyyyy"}')
  [ "$status" = "401" ] && print_success "change-password requires auth (401)" || print_error "expected 401, got $status"
}

test_auth_pages() {
  print_header "Test 12: Server-rendered Auth Pages"
  for page in login signup forgot-password reset-password; do
    print_test "GET /auth/$page"
    ct=$(curl -s -o /dev/null -w "%{http_code} %{content_type}" "$API_URL/auth/$page")
    case "$ct" in
      "200 text/html"*) print_success "/auth/$page serves HTML" ;;
      *) print_error "/auth/$page → $ct" ;;
    esac
  done
  print_test "GET /auth/app.js"
  ct=$(curl -s -o /dev/null -w "%{http_code} %{content_type}" "$API_URL/auth/app.js")
  case "$ct" in
    "200 application/javascript"*|"200 text/javascript"*) print_success "app.js served" ;;
    *) print_error "app.js → $ct" ;;
  esac
}

test_billing_endpoints() {
  print_header "Test 13: Billing / Plan Endpoints (auth required)"

  print_test "GET /api/billing/status (no auth → 401)"
  s=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/billing/status")
  [ "$s" = "401" ] && print_success "status requires auth (401)" || print_error "expected 401, got $s"

  print_test "POST /api/billing/redeem (no auth → 401)"
  s=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/billing/redeem" \
    -H "Content-Type: application/json" -d '{"code":"ZX-PRO-AAAA-BBBB-CCCC"}')
  [ "$s" = "401" ] && print_success "redeem requires auth (401)" || print_error "expected 401, got $s"

  print_test "POST /api/billing/redeem (bad API key → 401)"
  s=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/billing/redeem" \
    -H "Content-Type: application/json" -H "Authorization: Bearer zx_deadbeef" \
    -d '{"code":"ZX-PRO-AAAA-BBBB-CCCC"}')
  [ "$s" = "401" ] && print_success "invalid key rejected (401)" || print_error "expected 401, got $s"
}

test_review_dedupe() {
  print_header "Test 14: Review ingest drops hash-id duplicates"

  # Older extension builds put the relative date ("a day ago") into fallback
  # review ids, so one review was stored again on every scrape.
  local email="ci-dedupe-$(date +%s)-$RANDOM@example.test"
  local token ; local key ; local body ; local n
  token=$(curl -s -X POST "$API_URL/api/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"correct-horse-9\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  key=$(curl -s -X POST "$API_URL/api/auth/provision-extension" \
    -H "Authorization: Bearer $token" -H "x-extension-id: $EXTENSION_ID" | sed -n 's/.*"apiKey":"\([^"]*\)".*/\1/p')
  if [ -z "$key" ]; then print_error "could not provision an extension key"; return; fi

  local biz='"name":"Dedupe Test","googlePlaceId":"999000111","snapshot":{"totalReviews":1}'
  local rev='"rating":5,"authorName":"Amit","text":"Recovered my SSD"'
  for id in h1abc h2xyz ChdDSUhNMG9nS0VJQ0FnSU; do
    curl -s -o /dev/null -X POST "$API_URL/api/ingest/intel" -H "Authorization: Bearer $key" \
      -H "x-extension-id: $EXTENSION_ID" -H "Content-Type: application/json" \
      -d "{\"businesses\":[{$biz,\"reviews\":[{\"externalReviewId\":\"$id\",$rev}]}]}"
  done

  print_test "GET /api/ingest/intel (one review left, under Google's real id)"
  body=$(curl -s "$API_URL/api/ingest/intel" -H "Authorization: Bearer $key" -H "x-extension-id: $EXTENSION_ID")
  n=$(echo "$body" | grep -o '"externalReviewId"' | wc -l | tr -d ' ')
  if [ "$n" = "1" ] && echo "$body" | grep -q 'ChdDSUhNMG9nS0VJQ0FnSU'; then
    print_success "hash-id copies were removed (1 review)"
  else
    print_error "expected 1 review under the real id, got $n: $body"
  fi
}

test_extension_origin() {
  print_header "Test 15: Requests from the extension's Origin are not rejected by CORS"

  # Chrome sends Origin: chrome-extension://<id> on every extension request.
  # curl sends none, which is why CORS rejecting it (a 500) went unnoticed.
  local origin="Origin: chrome-extension://mijkelehhdboakkcekamkmcpahnppldh"
  local s

  print_test "POST /api/auth/google/extension from the extension (bad token → 401, not 500)"
  s=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/auth/google/extension" \
    -H "$origin" -H "Content-Type: application/json" -d '{"accessToken":"ya29.invalid"}')
  [ "$s" = "401" ] && print_success "extension origin accepted (401 for the bad token)" || print_error "expected 401, got $s"

  print_test "POST /api/ingest/intel from the extension (bad key → 401, not 500)"
  s=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest/intel" \
    -H "$origin" -H "Authorization: Bearer zx_deadbeef" -H "Content-Type: application/json" -d '{"businesses":[]}')
  [ "$s" = "401" ] && print_success "extension origin accepted (401 for the bad key)" || print_error "expected 401, got $s"
}

test_web_dashboard() {
  print_header "Test 16: Web dashboard pages and data endpoint"
  local s ; local ct ; local token ; local body

  print_test "GET /app (no trailing slash → redirect to app/)"
  s=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$API_URL/app")
  case "$s" in 301*app/) print_success "redirects to app/" ;; *) print_error "expected 301 → app/, got $s" ;; esac

  print_test "GET /app/ serves the dashboard page"
  ct=$(curl -s -o /dev/null -w "%{http_code} %{content_type}" "$API_URL/app/")
  case "$ct" in 200*text/html*) print_success "dashboard HTML served" ;; *) print_error "expected 200 text/html, got $ct" ;; esac

  for f in app.js styles.css manifest.webmanifest icon.svg; do
    s=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/app/$f")
    [ "$s" = "200" ] && print_success "/app/$f served" || print_error "/app/$f expected 200, got $s"
  done

  print_test "GET /api/app/overview without a token → 401"
  s=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/app/overview")
  [ "$s" = "401" ] && print_success "requires sign-in (401)" || print_error "expected 401, got $s"

  print_test "GET /api/app/overview signed in → 200 with a businesses list"
  token=$(curl -s -X POST "$API_URL/api/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"ci-web-$(date +%s)-$RANDOM@example.test\",\"password\":\"correct-horse-9\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  body=$(curl -s "$API_URL/api/app/overview" -H "Authorization: Bearer $token")
  echo "$body" | grep -q '"businesses":\[' && print_success "overview returned businesses" || print_error "unexpected overview: $body"

  print_test "GET /api/auth/google/web → Google, minimal scope, with a state cookie"
  local hdr
  hdr=$(curl -s -o /dev/null -D - "$API_URL/api/auth/google/web")
  if echo "$hdr" | grep -qi '^location: https://accounts.google.com/'      && echo "$hdr" | grep -qi 'scope=openid+email+profile&'      && echo "$hdr" | grep -qi 'state=[0-9a-f]\{32\}'      && echo "$hdr" | grep -qi '^set-cookie: gbp_oauth_state='; then
    print_success "redirects to Google with openid/email/profile and a state cookie"
  else
    print_error "unexpected Google redirect: $(echo "$hdr" | grep -i '^location\|^set-cookie')"
  fi

  print_test "GET /api/auth/google/web/callback with a forged state → back to login"
  s=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$API_URL/api/auth/google/web/callback?code=x&state=forged")
  case "$s" in 302*auth/login*error=session_expired*) print_success "forged state rejected" ;; *) print_error "expected redirect to login with error, got $s" ;; esac
}

###############################################################################
# Main Test Execution
###############################################################################

check_dependencies() {
  print_header "Checking Dependencies"

  if ! command -v curl &> /dev/null; then
    print_error "curl is not installed"
    exit 1
  fi
  print_success "curl is available"

  # jq is optional, we use grep instead
  if ! command -v jq &> /dev/null; then
    print_info "jq is not available (optional - using grep for JSON parsing)"
  else
    print_success "jq is available"
  fi
}

main() {
  echo ""
  echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║     Zixify Backend API Testing Suite              ║${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
  echo ""
  print_info "API URL: $API_URL"
  print_info "Extension ID: $EXTENSION_ID"

  check_dependencies
  check_server

  # Run tests with error handling
  test_health_check || true
  test_ingest_without_auth || true
  test_ingest_with_invalid_key || true
  test_locations_endpoint || true
  test_email_password_auth || true
  test_auth_pages || true
  test_billing_endpoints || true
  test_review_dedupe || true
  test_extension_origin || true
  test_web_dashboard || true

  print_header "Test Results Summary"
  echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
  echo -e "${RED}Failed: $TESTS_FAILED${NC}"
  echo ""

  if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
  else
    echo -e "${RED}✗ Some tests failed. Please review the output above.${NC}"
    exit 1
  fi
}

main "$@"
