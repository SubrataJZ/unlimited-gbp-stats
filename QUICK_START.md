# 🚀 Zixify Backend - Quick Start (5 Minutes)

## Step 1: Start Docker Compose (All Services)

```bash
# Navigate to project root
cd ~/Projects\ by\ Claude/unlimited\ business\ stats

# Start everything
docker-compose up -d

# Wait for startup (~30 seconds on first run)
sleep 30

# Check status
docker-compose ps
```

**Expected Output:**
```
NAME              STATUS              PORTS
gbp_postgres      Up 30s              0.0.0.0:5432->5432/tcp
gbp_backend       Up 10s (healthy)    0.0.0.0:3001->3001/tcp
gbp_pgadmin       Up 25s              0.0.0.0:5050->80/tcp
```

---

## Step 2: Verify Backend is Running

```bash
# Test health endpoint
curl http://localhost:3001/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 25.234
}
```

---

## Step 3: Test Data Ingestion

```bash
# Ingest a single metric
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-extension-key-12345" \
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

**Expected Response (200 OK):**
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

---

## Step 4: Check Ingestion Status

```bash
# Get status
curl http://localhost:3001/api/ingest/status \
  -H "Authorization: Bearer test-extension-key-12345"
```

**Expected Response:**
```json
{
  "status": "ok",
  "totalMetrics": 1,
  "locationsWithData": 1,
  "lastIngestionAt": "2024-01-15T10:30:00.000Z",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## Step 5: View Data in Database

**Option A: Prisma Studio (GUI)**
```bash
cd backend
npx prisma studio
# Opens: http://localhost:5555
```

**Option B: pgAdmin (Web UI)**
- Open: http://localhost:5050
- Login: admin@gbp.local / admin
- Password: admin
- Browse: Databases → gbp_database → Schemas → public → Tables

**Option C: Direct SQL**
```bash
# Connect to PostgreSQL
docker exec -it gbp_postgres psql -U gbp_dev -d gbp_database

# View metrics
SELECT * FROM "metrics";

# View locations
SELECT * FROM "locations";

# View users
SELECT * FROM "users";

# Exit
\q
```

---

## Step 6: Run Automated Tests

```bash
# Make test script executable
chmod +x backend/tests/api-tests.sh

# Run all tests
bash backend/tests/api-tests.sh
```

**Expected Output:**
```
✓ Health check returned 200 OK
✓ Correctly rejected request without API key (401 Unauthorized)
✓ Correctly rejected request with invalid API key (401 Unauthorized)
...
✓ All tests passed!
```

---

## 📊 Access Points

| Service | URL | Credentials |
|---------|-----|-------------|
| **Backend API** | http://localhost:3001 | API Key: `test-extension-key-12345` |
| **Health Check** | http://localhost:3001/health | No auth required |
| **pgAdmin** | http://localhost:5050 | admin@gbp.local / admin |
| **Prisma Studio** | http://localhost:5555 | (when running npx prisma studio) |
| **PostgreSQL** | localhost:5432 | gbp_dev / dev_password_change_me |

---

## 🧪 Quick Test Commands

```bash
# Health check (no auth)
curl http://localhost:3001/health

# Test authentication failure
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"metrics":[]}'
# Expected: 401 Unauthorized

# Ingest metrics (with auth)
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-extension-key-12345" \
  -d '{
    "metrics": [
      {"googleLocationId": "9876543210", "date": "2024-01-15", "metricType": "views", "value": 150},
      {"googleLocationId": "9876543210", "date": "2024-01-15", "metricType": "actions", "value": 45},
      {"googleLocationId": "9876543211", "date": "2024-01-14", "metricType": "views", "value": 180}
    ]
  }'

# Get ingest status
curl http://localhost:3001/api/ingest/status \
  -H "Authorization: Bearer test-extension-key-12345"

# View logs
docker-compose logs -f backend

# Stop services
docker-compose down

# Reset database (careful!)
docker-compose down -v
```

---

## 🔧 Troubleshooting

| Issue | Solution |
|-------|----------|
| `connect ECONNREFUSED 127.0.0.1:5432` | PostgreSQL not running: `docker-compose up -d postgres` |
| `relation "metrics" does not exist` | Schema not migrated: `docker-compose down && docker-compose up` |
| `Port 3001 already in use` | Kill process: `lsof -ti:3001 \| xargs kill -9` |
| `npm ERR! code ERESOLVE` | Clear cache: `npm install --legacy-peer-deps` |
| Backend not connecting to DB | Check DATABASE_URL in .env |

---

## 📝 Next Steps

1. ✅ **Backend Running** - All services are up
2. ✅ **Data Ingestion** - Metrics are being stored
3. 📦 **Verify Database** - Check data in pgAdmin/Prisma Studio
4. 🔐 **Implement JWT** - Add user authentication (next phase)
5. 🌐 **Build Frontend** - Connect to backend APIs
6. 🚀 **Deploy to Hetzner** - Production deployment

---

## 💡 Pro Tips

- **Watch logs in real-time:** `docker-compose logs -f backend`
- **Restart a service:** `docker-compose restart backend`
- **Enter container shell:** `docker exec -it gbp_backend sh`
- **View environment variables:** `docker-compose exec backend env`
- **Test database connection:** `docker-compose exec postgres psql -U gbp_dev -d gbp_database`

---

## ❌ Need Help?

Check the detailed guide:
```bash
cat backend/SETUP_AND_TESTING.md
```

View service logs:
```bash
# Backend logs
docker-compose logs backend

# Database logs
docker-compose logs postgres

# All logs
docker-compose logs
```

---

**Backend is ready to use! 🎉**
