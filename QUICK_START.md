# Quick Start - Deploy & Test Audit Logging

## TL;DR - 3 Commands

```bash
# 1. Deploy to VPS
bash deploy.sh

# 2. Run all tests
bash test.sh

# 3. View audit logs
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT action, status, createdAt FROM \"AuditLog\" ORDER BY createdAt DESC LIMIT 10;"
```

---

## Deploy Script (`deploy.sh`)

**What it does:**
- ✅ Fetches latest code from GitHub
- ✅ Checks out the audit-logging branch
- ✅ Verifies .env file exists with required variables
- ✅ Stops existing Docker containers
- ✅ Builds new Docker images
- ✅ Starts containers and waits for health
- ✅ Verifies TypeScript compilation

**Run it:**
```bash
bash deploy.sh
```

**Requirements:**
- `.env` file with: `DATABASE_URL`, `JWT_SECRET`, `SESSION_SECRET`, `GOOGLE_*` vars
- Docker and docker-compose installed
- Internet connection for git pull and Docker image pulls

**Time:** ~2-3 minutes

---

## Test Script (`test.sh`)

**What it does:**
- ✅ Test 1: Health check endpoint
- ✅ Test 2: Verify AuditLog table exists
- ✅ Test 3: Verify OAuth routes accessible
- ✅ Test 4: Test refresh token endpoint (expects auth failure)
- ✅ Test 5: Count existing audit events
- ✅ Test 6: Test API key endpoint (expects auth failure)

**Run it:**
```bash
bash test.sh
```

**Requirements:**
- Docker containers must be running

**Time:** ~30 seconds

---

## Manual Audit Event Testing

After deployment, trigger real audit events:

### 1. Complete OAuth Login Flow
```bash
# Open in browser and login with Google
http://localhost:3001/api/auth/google
```

### 2. View Audit Logs
```bash
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT action, status, createdAt FROM \"AuditLog\" ORDER BY createdAt DESC LIMIT 10;"
```

---

## Troubleshooting

### Deployment fails
```bash
docker-compose logs backend
docker-compose ps
```

### No audit entries appear
```bash
docker-compose logs backend | grep -i audit
```

---

## Next Steps

1. ✅ Run `bash deploy.sh` on VPS
2. ✅ Run `bash test.sh` to verify
3. ✅ Complete OAuth and verify audit logs
4. ✅ Merge PR to main

All code committed and ready!
