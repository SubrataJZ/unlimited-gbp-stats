# Deployment Guide - Step 3: Audit Logging

## VPS Deployment (188.245.199.192)

### 1. SSH into VPS and pull latest code
```bash
ssh root@188.245.199.192
cd /path/to/unlimited-gbp-stats
git fetch origin
git checkout claude/vigorous-lovelace-436741
git pull origin claude/vigorous-lovelace-436741
```

### 2. Verify environment variables
```bash
cat .env
# Ensure these are set:
# - DATABASE_URL (PostgreSQL connection)
# - JWT_SECRET (secure random string)
# - SESSION_SECRET (secure random string)
# - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
```

### 3. Rebuild and restart Docker containers
```bash
docker-compose down
docker-compose up -d --build

# Wait for service startup (~30 seconds)
sleep 30
docker-compose ps
```

### 4. Verify database migration completed
```bash
docker-compose logs backend | grep -i "migration\|database"
```

## End-to-End Testing

### Test 1: Health Check
```bash
curl -s http://188.245.199.192:3001/health | jq .
# Expected: {"status":"ok","timestamp":"...","uptime":...}
```

### Test 2: Google OAuth Login Flow
1. Open browser: `http://188.245.199.192:3000/login`
2. Click "Login with Google"
3. Complete OAuth consent
4. Verify redirect back to dashboard with token in URL

#### Check Audit Log:
```bash
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT userId, action, status, ipAddress, createdAt FROM \"AuditLog\" ORDER BY createdAt DESC LIMIT 5;"
# Expected: LOGIN_OAUTH row with status='success'
```

### Test 3: Token Refresh
```bash
# From extension or programmatically:
curl -X POST http://188.245.199.192:3001/api/auth/refresh \
  -H "Content-Type: application/json" \
  -b "gbp_refresh=YOUR_REFRESH_TOKEN" \
  -d '{}'

# Should return new accessToken and expiresIn
```

#### Check Audit Log:
```bash
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT userId, action, status FROM \"AuditLog\" WHERE action='TOKEN_REFRESH' ORDER BY createdAt DESC LIMIT 1;"
# Expected: TOKEN_REFRESH row
```

### Test 4: API Key Provisioning
```bash
curl -X POST http://188.245.199.192:3001/api/auth/provision-extension \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "X-Extension-ID: test-ext-123"

# Should return raw API key
```

#### Check Audit Log:
```bash
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT userId, action, resource, metadata FROM \"AuditLog\" WHERE action='API_KEY_CREATED' ORDER BY createdAt DESC LIMIT 1;"
# Expected: API_KEY_CREATED with resource like 'ApiKey:...'
```

### Test 5: Metrics Ingestion
```bash
EXTENSION_KEY="zx_YOUR_GENERATED_KEY_HERE"

curl -X POST http://188.245.199.192:3001/api/ingest \
  -H "Authorization: Bearer $EXTENSION_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "metrics": [
      {
        "googleLocationId": "1234567890123456789",
        "date": "2024-01-15",
        "metricType": "views",
        "value": 150
      }
    ]
  }'

# Should return 200/207 with summary
```

#### Check Audit Log:
```bash
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT userId, action, status, metadata FROM \"AuditLog\" WHERE action LIKE 'INGEST_%' ORDER BY createdAt DESC LIMIT 1;"
# Expected: INGEST_SUCCESS with metadata containing metricsCount
```

### Test 6: Logout
```bash
curl -X POST http://188.245.199.192:3001/api/auth/logout \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -b "gbp_refresh=YOUR_REFRESH_TOKEN"

# Should clear cookie and revoke all tokens
```

#### Check Audit Log:
```bash
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT userId, action, status FROM \"AuditLog\" WHERE action='LOGOUT' ORDER BY createdAt DESC LIMIT 1;"
# Expected: LOGOUT row with status='success'
```

## Troubleshooting

### Backend container won't start
```bash
docker-compose logs backend
# Look for: "Failed to start server" or database connection errors
```

### TypeScript compilation errors
```bash
docker-compose exec backend npm run build
# Should complete with no errors
```

### Audit logs not appearing
```bash
# Check if auditLog table exists
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "\dt \"AuditLog\""

# Check if inserts are failing silently
docker-compose exec backend npm run dev
# Look for "Failed to log audit event:" in logs
```

### Permission denied on API key endpoints
```bash
# Verify JWT_SECRET is correct in .env
# Verify access token hasn't expired (15 min)
# Check Authorization header format: "Bearer TOKEN"
```

## Rollback

If issues occur, revert to previous commit:
```bash
git checkout HEAD~1
docker-compose down
docker-compose up -d --build
```

## Verification Checklist

- [ ] TypeScript builds without errors
- [ ] Docker containers start successfully
- [ ] Health check endpoint responds
- [ ] OAuth flow completes without errors
- [ ] Login audit log entry created
- [ ] Token refresh works and audits
- [ ] API key provision creates audit entry
- [ ] Metrics ingestion audits correctly
- [ ] Logout revokes tokens and audits
- [ ] All audit entries visible in database
- [ ] No "Failed to log audit event" errors in logs
