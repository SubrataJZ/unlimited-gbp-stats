# 🧪 Test Backend NOW - Step-by-Step Guide

## Prerequisites
- Docker & Docker Compose installed
- `curl` command available
- ~5 minutes of time

---

## 🎬 Action: Start Services (1-2 minutes)

### Step 1: Open Terminal
```bash
cd ~/Projects\ by\ Claude/unlimited\ business\ stats
```

### Step 2: Start All Services
```bash
docker-compose up -d
```

**Expected Output:**
```
Creating gbp_postgres ... done
Creating gbp_pgadmin ... done
Creating gbp_backend ... done
```

### Step 3: Wait for Services (30 seconds)
```bash
# Watch the backend startup logs
docker-compose logs -f backend

# Wait until you see:
# [timestamp] info: ✓ Database connection successful
# [timestamp] info: ✓ Server running on http://localhost:3001
```

Press `Ctrl+C` to stop watching logs.

---

## ✅ Test 1: Health Check (No Auth)

### Command
```bash
curl http://localhost:3001/health
```

### Expected Response
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 25.234
}
```

### What This Proves
- ✅ Server is running
- ✅ Network connectivity works
- ✅ API responds to requests

---

## ✅ Test 2: Auth Rejection (No API Key)

### Command
```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"metrics":[]}'
```

### Expected Response (401 Unauthorized)
```json
{
  "error": {
    "message": "Missing or invalid Authorization header. Expected: Bearer <API_KEY>",
    "statusCode": 401
  }
}
```

### What This Proves
- ✅ Security: Extension requests are protected
- ✅ API key validation is enforced
- ✅ Proper error response format

---

## ✅ Test 3: Ingest Single Metric

### Command
```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-extension-key-12345" \
  -H "X-Extension-ID: test-extension-id-chrome" \
  -d '{
    "metrics": [
      {
        "googleLocationId": "9876543210",
        "date": "2024-01-15",
        "metricType": "views",
        "value": 150
      }
    ]
  }'
```

### Expected Response (200 OK)
```json
{
  "summary": {
    "total": 1,
    "successful": 1,
    "failed": 0
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### What This Proves
- ✅ API key authentication works
- ✅ Metrics are accepted
- ✅ Database write succeeded
- ✅ Proper response format

---

## ✅ Test 4: Ingest Batch (Multiple Metrics)

### Command
```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-extension-key-12345" \
  -d '{
    "metrics": [
      {
        "googleLocationId": "9876543210",
        "date": "2024-01-15",
        "metricType": "views",
        "value": 200
      },
      {
        "googleLocationId": "9876543210",
        "date": "2024-01-15",
        "metricType": "actions",
        "value": 45
      },
      {
        "googleLocationId": "9876543210",
        "date": "2024-01-15",
        "metricType": "phone_calls",
        "value": 12
      },
      {
        "googleLocationId": "9876543211",
        "date": "2024-01-14",
        "metricType": "views",
        "value": 180
      },
      {
        "googleLocationId": "9876543211",
        "date": "2024-01-14",
        "metricType": "website_clicks",
        "value": 28
      }
    ]
  }'
```

### Expected Response (200 OK)
```json
{
  "summary": {
    "total": 5,
    "successful": 5,
    "failed": 0
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### What This Proves
- ✅ Batch processing works
- ✅ Multiple metrics accepted
- ✅ Multiple locations handled
- ✅ All metrics stored

---

## ✅ Test 5: Idempotency (Push Same Metric Twice)

### First Push
```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-extension-key-12345" \
  -d '{
    "metrics": [
      {
        "googleLocationId": "9876543212",
        "date": "2024-01-15",
        "metricType": "views",
        "value": 100
      }
    ]
  }'
```

### Response (200 OK)
```json
{
  "summary": {
    "total": 1,
    "successful": 1,
    "failed": 0
  }
}
```

### Second Push (Same Metric, Updated Value)
```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-extension-key-12345" \
  -d '{
    "metrics": [
      {
        "googleLocationId": "9876543212",
        "date": "2024-01-15",
        "metricType": "views",
        "value": 200
      }
    ]
  }'
```

### Response (200 OK)
```json
{
  "summary": {
    "total": 1,
    "successful": 1,
    "failed": 0
  }
}
```

### What This Proves
- ✅ Idempotency works (no duplicates)
- ✅ Upsert logic works correctly
- ✅ Values are updated, not duplicated
- ✅ Database has exactly 1 record for this metric

**Verify in database:**
```bash
docker exec -it gbp_postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT COUNT(*) FROM metrics WHERE location_id='9876543212' AND metric_type='views' AND date='2024-01-15';"
```

Should return: `1` (exactly one record, not two)

---

## ✅ Test 6: Get Ingestion Status

### Command
```bash
curl http://localhost:3001/api/ingest/status \
  -H "Authorization: Bearer test-extension-key-12345"
```

### Expected Response
```json
{
  "status": "ok",
  "totalMetrics": 6,
  "locationsWithData": 2,
  "lastIngestionAt": "2024-01-15T10:30:00.000Z",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### What This Proves
- ✅ Status endpoint works
- ✅ Metrics are being counted correctly
- ✅ Location tracking works
- ✅ Timestamps are recorded

---

## ✅ Test 7: Invalid Metric Rejection

### Command (Invalid metric type)
```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-extension-key-12345" \
  -d '{
    "metrics": [
      {
        "googleLocationId": "9876543210",
        "date": "2024-01-15",
        "metricType": "invalid_metric_type",
        "value": 150
      }
    ]
  }'
```

### Expected Response (207 Multi-Status)
```json
{
  "summary": {
    "total": 1,
    "successful": 0,
    "failed": 1
  },
  "errors": [
    {
      "index": 0,
      "metric": {...},
      "error": "Invalid metricType. Must be one of: views, actions, phone_calls, ..."
    }
  ],
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### What This Proves
- ✅ Input validation works
- ✅ Invalid metrics are rejected
- ✅ Error details provided
- ✅ Database integrity protected

---

## ✅ Test 8: View Data in Database

### Option A: Direct PostgreSQL
```bash
# Connect to database
docker exec -it gbp_postgres psql -U gbp_dev -d gbp_database

# View all metrics
SELECT location_id, date, metric_type, value FROM metrics;

# Count by location
SELECT location_id, COUNT(*) FROM metrics GROUP BY location_id;

# View latest metric
SELECT * FROM metrics ORDER BY created_at DESC LIMIT 1;

# Exit
\q
```

### Option B: Prisma Studio (GUI)
```bash
cd backend
npx prisma studio

# Opens http://localhost:5555 in browser
# Click on "Metric" table to view all records
```

### Option C: pgAdmin (Web UI)
1. Open http://localhost:5050
2. Login: `admin@gbp.local` / `admin`
3. Navigate: Databases → gbp_database → Schemas → public → Tables → metrics
4. Right-click → View/Edit Data

### Expected Data
You should see 6+ metric records in the database:
- Location `9876543210`: 3 metrics (views=200, actions=45, phone_calls=12)
- Location `9876543211`: 2 metrics (views=180, website_clicks=28)
- Location `9876543212`: 1 metric (views=200, updated value)

---

## ✅ Test 9: Automated Test Suite

### Command
```bash
# Make executable
chmod +x backend/tests/api-tests.sh

# Run all 10 tests
bash backend/tests/api-tests.sh
```

### Expected Output
```
✓ Health check returned 200 OK
✓ Correctly rejected request without API key (401 Unauthorized)
✓ Correctly rejected request with invalid API key (401 Unauthorized)
✓ Correctly rejected empty metrics array (400 Bad Request)
✓ Successfully ingested metric (200 OK)
✓ Successfully ingested 5 metrics (200 OK)
✓ Idempotent upsert working correctly
✓ Correctly rejected invalid metric type
✓ Successfully retrieved ingestion status (200 OK)
✓ Locations endpoint is accessible

Passed: 10
Failed: 0
✓ All tests passed!
```

---

## 🎉 Summary: All Tests Passed!

If you've completed all tests above, your backend is:

- ✅ **Running** - Server is up and responsive
- ✅ **Secure** - API key authentication working
- ✅ **Functional** - Metrics are being ingested and stored
- ✅ **Idempotent** - No duplicate data from repeated pushes
- ✅ **Validated** - Input validation prevents bad data
- ✅ **Persistent** - Data is saved in PostgreSQL
- ✅ **Monitored** - Status endpoint shows statistics
- ✅ **Tested** - Automated test suite passes

---

## 📊 Test Results Summary

| Test | Status | Endpoint | Auth | Response |
|------|--------|----------|------|----------|
| Health Check | ✅ | GET /health | No | 200 OK |
| No Auth | ✅ | POST /api/ingest | No | 401 Unauth |
| Single Metric | ✅ | POST /api/ingest | Yes | 200 OK |
| Batch Metrics | ✅ | POST /api/ingest | Yes | 200 OK |
| Idempotency | ✅ | POST /api/ingest | Yes | 200 OK |
| Status | ✅ | GET /api/ingest/status | Yes | 200 OK |
| Invalid Input | ✅ | POST /api/ingest | Yes | 207 Multi |
| Auto Tests | ✅ | All endpoints | Various | 10/10 Pass |

---

## 🚀 Next: Integration with Chrome Extension

Now that the backend is tested and working:

1. **Update Chrome Extension** to send data to `http://localhost:3001/api/ingest`
2. **Use API Key** `test-extension-key-12345` in Authorization header
3. **Watch Data Flow** from extension → backend → database

---

## 🆘 Troubleshooting

### Server Not Running
```bash
# Check status
docker-compose ps

# View logs
docker-compose logs backend

# Restart
docker-compose restart backend
```

### Database Connection Failed
```bash
# Check PostgreSQL is running
docker-compose ps postgres

# View database logs
docker-compose logs postgres

# Restart PostgreSQL
docker-compose restart postgres
```

### Port Already in Use
```bash
# Check what's using port 3001
lsof -i :3001

# Kill the process
kill -9 <PID>

# Or change PORT in .env
PORT=3002
docker-compose up -d
```

### Tests Failing
```bash
# View test output
bash backend/tests/api-tests.sh

# Check individual endpoint
curl http://localhost:3001/health -v

# View logs
docker-compose logs backend
```

---

## 💾 Save Test Results

```bash
# Run tests and save results
bash backend/tests/api-tests.sh | tee test-results.txt

# View later
cat test-results.txt
```

---

## 📝 Test Checklist

- [ ] Docker compose started successfully
- [ ] Backend logs show "Server running"
- [ ] Health check returns 200 OK
- [ ] Auth rejection returns 401
- [ ] Single metric ingestion succeeds
- [ ] Batch ingestion succeeds (5 metrics)
- [ ] Idempotency works (same metric updated, not duplicated)
- [ ] Status endpoint shows correct counts
- [ ] Invalid input is rejected
- [ ] Data visible in database
- [ ] Automated test suite passes

✅ **All tests passed = Backend is production-ready!**

---

## 🎯 You're Done Testing!

Backend is verified working. Next steps:
1. Integrate with Chrome Extension
2. Build frontend dashboard
3. Deploy to Hetzner VPS

Questions? Check the code comments - they're detailed!
