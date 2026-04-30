#!/bin/bash

###############################################################################
# API Testing Script for Zixify Backend
#
# This script tests all endpoints of the backend API
# Requires: curl, jq (for JSON parsing)
#
# Usage: bash tests/api-tests.sh
###############################################################################

set -e

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
  print_test "POST /api/ingest (no auth header)"

  response=$(curl -s -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -d '{"metrics":[]}')

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -d '{"metrics":[]}')

  if [ "$status" = "401" ]; then
    print_success "Correctly rejected request without API key (401 Unauthorized)"
    print_info "Response: $response"
  else
    print_error "Should have rejected with 401, got $status"
  fi
}

test_ingest_with_invalid_key() {
  print_header "Test 3: Ingest With Invalid API Key (Should Fail)"
  print_test "POST /api/ingest (invalid API key)"

  response=$(curl -s -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer invalid-key-12345" \
    -d '{"metrics":[]}')

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer invalid-key-12345" \
    -d '{"metrics":[]}')

  if [ "$status" = "401" ]; then
    print_success "Correctly rejected request with invalid API key (401 Unauthorized)"
    print_info "Response: $response"
  else
    print_error "Should have rejected with 401, got $status"
  fi
}

test_ingest_empty_metrics() {
  print_header "Test 4: Ingest Empty Metrics Array (Should Fail)"
  print_test "POST /api/ingest (empty metrics array)"

  response=$(curl -s -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d '{"metrics":[]}')

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d '{"metrics":[]}')

  if [ "$status" = "400" ]; then
    print_success "Correctly rejected empty metrics array (400 Bad Request)"
    print_info "Response: $response"
  else
    print_error "Should have rejected with 400, got $status"
  fi
}

test_ingest_single_metric() {
  print_header "Test 5: Ingest Single Valid Metric (Should Succeed)"
  print_test "POST /api/ingest (valid metric)"

  # Generate today's date
  today=$(date +%Y-%m-%d)

  payload=$(cat <<EOF
{
  "metrics": [
    {
      "googleLocationId": "9876543210",
      "date": "$today",
      "metricType": "views",
      "value": 150
    }
  ]
}
EOF
)

  response=$(curl -s -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload")

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload")

  if [ "$status" = "200" ]; then
    print_success "Successfully ingested metric (200 OK)"
    print_info "Response: $response"
  else
    print_error "Failed to ingest metric, got status $status"
    print_info "Response: $response"
  fi
}

test_ingest_multiple_metrics() {
  print_header "Test 6: Ingest Multiple Metrics (Should Succeed)"
  print_test "POST /api/ingest (batch of 5 metrics)"

  today=$(date +%Y-%m-%d)
  yesterday=$(date -d "1 day ago" +%Y-%m-%d)

  payload=$(cat <<EOF
{
  "metrics": [
    {
      "googleLocationId": "9876543210",
      "date": "$today",
      "metricType": "views",
      "value": 200
    },
    {
      "googleLocationId": "9876543210",
      "date": "$today",
      "metricType": "actions",
      "value": 45
    },
    {
      "googleLocationId": "9876543210",
      "date": "$today",
      "metricType": "phone_calls",
      "value": 12
    },
    {
      "googleLocationId": "9876543211",
      "date": "$yesterday",
      "metricType": "views",
      "value": 180
    },
    {
      "googleLocationId": "9876543211",
      "date": "$yesterday",
      "metricType": "website_clicks",
      "value": 25
    }
  ]
}
EOF
)

  response=$(curl -s -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload")

  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload")

  if [ "$status" = "200" ]; then
    print_success "Successfully ingested 5 metrics (200 OK)"
    print_info "Response: $response"
  else
    print_error "Failed to ingest metrics, got status $status"
  fi
}

test_ingest_idempotency() {
  print_header "Test 7: Test Idempotency (Same Metric Twice - Should Update)"
  print_test "POST /api/ingest (same metric pushed twice)"

  today=$(date +%Y-%m-%d)

  payload=$(cat <<EOF
{
  "metrics": [
    {
      "googleLocationId": "9876543212",
      "date": "$today",
      "metricType": "views",
      "value": 100
    }
  ]
}
EOF
)

  # Push first time
  response1=$(curl -s -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload")

  print_info "First push response: $response1"

  # Update the payload with a different value
  payload2=$(cat <<EOF
{
  "metrics": [
    {
      "googleLocationId": "9876543212",
      "date": "$today",
      "metricType": "views",
      "value": 200
    }
  ]
}
EOF
)

  # Push second time with updated value
  response2=$(curl -s -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload2")

  if echo "$response2" | grep -q '"successful":1'; then
    print_success "Idempotent upsert working correctly"
    print_info "Second push response: $response2"
  else
    print_error "Idempotent upsert may have failed"
    print_info "Response: $response2"
  fi
}

test_ingest_invalid_metric_type() {
  print_header "Test 8: Ingest With Invalid Metric Type (Should Fail)"
  print_test "POST /api/ingest (invalid metric type)"

  today=$(date +%Y-%m-%d)

  payload=$(cat <<EOF
{
  "metrics": [
    {
      "googleLocationId": "9876543210",
      "date": "$today",
      "metricType": "invalid_metric",
      "value": 150
    }
  ]
}
EOF
)

  response=$(curl -s -X POST "$API_URL/api/ingest" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID" \
    -d "$payload")

  if echo "$response" | grep -q '"failed":1'; then
    print_success "Correctly rejected invalid metric type"
    print_info "Response: $response"
  else
    print_error "Should have rejected invalid metric type"
    print_info "Response: $response"
  fi
}

test_ingest_status() {
  print_header "Test 9: Get Ingestion Status"
  print_test "GET /api/ingest/status"

  response=$(curl -s "$API_URL/api/ingest/status" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID")

  status=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/ingest/status" \
    -H "Authorization: Bearer $EXTENSION_KEY" \
    -H "X-Extension-ID: $EXTENSION_ID")

  if [ "$status" = "200" ]; then
    print_success "Successfully retrieved ingestion status (200 OK)"
    print_info "Response: $response"
  else
    print_error "Failed to get ingestion status, got status $status"
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

main() {
  echo ""
  echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║     Zixify Backend API Testing Suite              ║${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
  echo ""
  print_info "API URL: $API_URL"
  print_info "Extension Key: $EXTENSION_KEY"
  print_info "Extension ID: $EXTENSION_ID"

  check_server

  test_health_check
  test_ingest_without_auth
  test_ingest_with_invalid_key
  test_ingest_empty_metrics
  test_ingest_single_metric
  test_ingest_multiple_metrics
  test_ingest_idempotency
  test_ingest_invalid_metric_type
  test_ingest_status
  test_locations_endpoint

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
