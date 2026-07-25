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
EXTENSION_KEY="test-extension-key-12345"
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

test_metrics_rejects_static_key() {
  print_header "Test 4: Metrics Ingest Rejects Legacy Static Key (Tenancy Guard)"
  print_test "POST /api/ingest/metrics (legacy static EXTENSION_INGESTION_KEY, valid payload)"

  today=$(date +%Y-%m-%d)
  year=$(date +%Y)
  # 10# forces base-10 so a zero-padded month ("07") does not become invalid
  # JSON — a bare 07 is a JSON syntax error, not the number seven.
  month=$((10#$(date +%m)))

  # This payload must stay VALID against the /api/ingest/metrics validator.
  # The point of the test is that a 401 proves auth rejected the shared key
  # BEFORE the body was even looked at. An invalid payload would muddy that:
  # a 400 could then mean either "bad body" or "guard moved", and the test
  # would no longer isolate the tenancy property it exists to protect.
  # Field names are deliberately the NEW ones (name/googlePlaceId/total) —
  # the old controller's googleLocationId/value vocabulary was deleted in A4.
  payload=$(cat <<EOF
{
  "businesses": [
    {
      "name": "CI Tenancy Guard Fixture",
      "googlePlaceId": "9876543210",
      "metrics": [
        {
          "metricType": "overview",
          "year": $year,
          "month": $month,
          "total": 150,
          "collectedAt": "${today}T00:00:00.000Z"
        }
      ]
    }
  ]
}
EOF
)

  response=$(curl -s -X POST "$API_URL/api/ingest/metrics" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload")

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest/metrics" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload")

  if [ "$status" = "401" ]; then
    print_success "Correctly rejected the shared static key (no user identity) with 401"
    print_info "Response: $response"
  else
    print_error "Should have rejected with 401, got $status (static key must never ingest metrics)"
    print_info "Response: $response"
  fi
}

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
  print_info "Extension Key: $EXTENSION_KEY"
  print_info "Extension ID: $EXTENSION_ID"

  check_dependencies
  check_server

  # Run tests with error handling
  test_health_check || true
  test_ingest_without_auth || true
  test_ingest_with_invalid_key || true
  test_metrics_rejects_static_key || true
  test_locations_endpoint || true

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
