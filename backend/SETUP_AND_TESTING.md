# Zixify Backend - Setup & Testing Guide

## Quick Start

### Prerequisites
- Docker & Docker Compose installed
- Node.js 18+ (for local development)
- PostgreSQL client tools (optional, for manual DB access)
- curl or Postman (for API testing)

---

## Option 1: Run Everything with Docker Compose

### Step 1: Prepare Environment

```bash
# Navigate to project root
cd ~/Projects\ by\ Claude/unlimited\ business\ stats

# Docker Compose will handle everything automatically
# It will:
# 1. Start PostgreSQL 16 Alpine
# 2. Start pgAdmin (optional, for DB management)
# 3. Start the Node.js backend
# 4. Run database migrations
```

### Step 2: Start Services

```bash
# Start all services in the background
docker-compose up -d

# Verify services are running
docker-compose ps

# Watch logs (optional)
docker-compose logs -f backend
```

### Step 3: Wait for Services

```bash
# Check if backend is ready (wait ~30 seconds for first run)
curl http://localhost:3001/health

# Expected response:
# {"status":"ok","timestamp":"2024-01-15T10:30:00.000Z","uptime":15.234}
```

**Access Points:**
- Backend API: `http://localhost:3001`
- pgAdmin: `http://localhost:5050` (admin@gbp.local / admin)
- PostgreSQL: `localhost:5432`

---

## Option 2: Local Development Setup

### Step 1: Install Dependencies

```bash
cd backend
npm install
```

### Step 2: Setup Environment

```bash
# Copy example env file
cp .env.example .env

# Edit .env (already configured for local development)
# Database should be running via Docker:
# docker-compose up -d postgres pgadmin
```

### Step 3: Setup Prisma

```bash
# Generate Prisma Client
npx prisma generate

# Push schema to database (creates tables)
npx prisma db push

# Optional: View data with Prisma Studio
npx prisma studio
```

### Step 4: Start Backend

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode (compiled)
npm run build
npm start
```

**Output should show:**
```
[timestamp] info: ✓ Database connection successful
[timestamp] info: ✓ Server running on http://localhost:3001
[timestamp] info: ✓ Health check: GET /health
[timestamp] info: ✓ Ingest endpoint: POST /api/ingest
```

---

## Testing the Backend

### Automated Test Suite

```bash
# Make test script executable
chmod +x backend/tests/api-tests.sh

# Run all tests
bash backend/tests/api-tests.sh
```

This will test:
- ✅ Health check endpoint
- ✅ Authentication (valid/invalid keys)
- ✅ Metric ingestion
- ✅ Idempotency (upsert logic)
- ✅ Error handling
- ✅ Status endpoints

### Manual Testing with curl

#### 1. Health Check
```bash
curl http://localhost:3001/health
```

**Expected:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 15.234
}
```

#### 2. Test Authentication (Should Fail)
```bash
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"metrics":[]}'
```

**Expected:** 401 Unauthorized
```json
{
  "error": {
    "message": "Missing or invalid Authorization header. Expected: Bearer <API_KEY>",
    "statusCode": 401
  }
}
```

#### 3. Ingest Single Metric
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

**Expected:** 200 OK
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

#### 4. Ingest Multiple Metrics
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
      }
    ]
  }'
```

**Expected:** 200 OK
```json
{
  "summary": {
    "total": 4,
    "successful": 4,
    "failed": 0
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

#### 5. Get Ingestion Status
```bash
curl http://localhost:3001/api/ingest/status \
  -H "Authorization: Bearer test-extension-key-12345" \
  -H "X-Extension-ID: test-extension-id-chrome"
```

**Expected:** 200 OK
```json
{
  "status": "ok",
  "totalMetrics": 4,
  "locationsWithData": 2,
  "lastIngestionAt": "2024-01-15T10:30:00.000Z",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

#### 6. Test Idempotency (Push Same Metric Twice)
```bash
# First push
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

# Second push (same metric, different value)
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

**Expected:** Both return 200 OK with 1 successful
- First push creates new metric
- Second push updates existing metric (no duplicates)

#### 7. Get Locations for User
```bash
curl "http://localhost:3001/api/locations?userId=test-user-id"
```

**Note:** Will return empty array if no users exist in DB yet

---

## Using Prisma Studio (GUI Database Browser)

```bash
cd backend

# Start Prisma Studio
npx prisma studio

# Opens: http://localhost:5555
# You can:
# - View all data in tables
# - Create/edit/delete records
# - Run SQL queries
# - Export data
```

---

## Database Management via pgAdmin

1. **Open pgAdmin:** `http://localhost:5050`
2. **Login:** `admin@gbp.local` / `admin`
3. **Add Server:**
   - Host: `postgres` (Docker network name)
   - Port: `5432`
   - Username: `gbp_dev`
   - Password: `dev_password_change_me`
4. **Browse Data:** Navigate to `Databases > gbp_database > Schemas > public > Tables`

---

## Troubleshooting

### Problem: `connect ECONNREFUSED 127.0.0.1:5432`
**Solution:** PostgreSQL is not running
```bash
# Check Docker containers
docker-compose ps

# Start PostgreSQL if down
docker-compose up -d postgres

# Wait 10 seconds for startup
sleep 10

# Test connection
curl http://localhost:3001/health
```

### Problem: `Error: EXTENSION_INGESTION_KEY is not configured`
**Solution:** Verify .env file
```bash
# Check .env exists and has the key
cat backend/.env | grep EXTENSION_INGESTION_KEY

# Should see:
# EXTENSION_INGESTION_KEY=test-extension-key-12345
```

### Problem: `relation "metrics" does not exist`
**Solution:** Database schema not migrated
```bash
# Push schema to database
npx prisma db push

# Or run migration
npx prisma migrate dev --name init
```

### Problem: `npm ERR! code ERESOLVE`
**Solution:** NPM dependency conflict
```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install

# Or use legacy peer deps
npm install --legacy-peer-deps
```

### Problem: Port 3001 already in use
**Solution:** Change PORT in .env or kill process
```bash
# Kill process using port 3001
lsof -ti:3001 | xargs kill -9

# Or change PORT in .env
PORT=3002
npm run dev
```

---

## Key Files & What They Do

```
backend/
├── src/
│   ├── index.ts              # Main Express server setup
│   ├── controllers/
│   │   └── ingest.controller.ts    # Metric ingestion logic
│   ├── services/
│   │   └── google.service.ts       # Google API integration
│   ├── routes/
│   │   ├── ingest.routes.ts        # POST /api/ingest
│   │   ├── auth.routes.ts          # OAuth routes
│   │   └── locations.routes.ts     # Location endpoints
│   ├── middlewares/
│   │   ├── auth.middleware.ts      # API key validation
│   │   └── error.middleware.ts     # Error handling
│   └── utils/
│       ├── logger.ts               # Winston logger
│       └── errors.ts               # Custom error classes
├── prisma/
│   └── schema.prisma         # Database schema
├── .env                      # Environment variables
├── docker-compose.yml        # Docker services config
└── tests/
    └── api-tests.sh          # Automated test suite
```

---

## Environment Variables Explained

| Variable | Purpose | Example |
|----------|---------|---------|
| `NODE_ENV` | Node environment | `development` |
| `PORT` | Server port | `3001` |
| `DATABASE_URL` | PostgreSQL connection | `postgresql://user:pass@host:5432/db` |
| `EXTENSION_INGESTION_KEY` | Static API key for extension | `test-extension-key-12345` |
| `EXTENSION_ID` | Chrome extension ID | `test-extension-id-chrome` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | (from Google Cloud Console) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret | (from Google Cloud Console) |
| `LOG_LEVEL` | Logging verbosity | `info` or `debug` |

---

## Next Steps

1. ✅ **Backend is running** - Test all endpoints
2. 📦 **Verify database** - Check metrics in pgAdmin
3. 🔐 **Implement JWT** - Add user authentication
4. 🌐 **Build frontend** - Connect to backend APIs
5. 🚀 **Deploy to Hetzner** - Use Docker Compose on VPS

---

## Common curl Commands Cheat Sheet

```bash
# Health check
curl http://localhost:3001/health

# Ingest with proper auth
curl -X POST http://localhost:3001/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-extension-key-12345" \
  -d '{"metrics":[...]}'

# Get status
curl http://localhost:3001/api/ingest/status \
  -H "Authorization: Bearer test-extension-key-12345"

# Get locations
curl "http://localhost:3001/api/locations?userId=USER_ID"

# Docker logs
docker-compose logs -f backend

# Stop services
docker-compose down

# Clean database (CAUTION!)
docker-compose down -v
```

---

## Production Deployment Checklist

- [ ] Set strong `EXTENSION_INGESTION_KEY` (not test key)
- [ ] Configure real `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- [ ] Change `JWT_SECRET` and `SESSION_SECRET`
- [ ] Enable HTTPS (with nginx reverse proxy)
- [ ] Setup monitoring (logs, metrics, alerts)
- [ ] Configure backups (PostgreSQL WAL backups)
- [ ] Update CORS origins (remove localhost)
- [ ] Implement rate limiting in production
- [ ] Setup CI/CD pipeline

---

For additional help or issues, check the backend logs:
```bash
docker-compose logs backend
```
