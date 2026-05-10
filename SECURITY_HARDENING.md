# Security Hardening Implementation

**Purpose:** Protect against brute force attacks, account takeover, and suspicious activity patterns.

**Files:**
- `backend/src/utils/security.ts` - Core security utility functions
- `backend/src/middlewares/auth.middleware.ts` - Enhanced JWT validation
- `backend/src/routes/auth.routes.ts` - OAuth integration

---

## Features Implemented

### 1. **Brute Force Protection**

**Configuration:**
- Max failed attempts: 5
- Lockout duration: 30 minutes
- Suspension window: 24 hours

**Behavior:**
- Tracks failed authentication attempts per user
- Locks account after 5 failed attempts in 30 minutes
- Automatic unlock after 30 minutes
- Clear failed attempts on successful login

**Example:**
```
Attempt 1: Failed (Login page reloads)
Attempt 2: Failed
Attempt 3: Failed
Attempt 4: Failed
Attempt 5: Failed → Account locked for 30 minutes
Message: "Account temporarily locked due to multiple failed login attempts. Try again in 30 minutes."
```

### 2. **Suspicious Activity Detection**

**Monitored Patterns:**

| Pattern | Threshold | Window | Action |
|---------|-----------|--------|--------|
| Multiple failed attempts | 10+ failures | 60 minutes | Log as suspicious |
| Rapid attack | 20+ failures | 5 minutes | Flag as high threat |
| Multi-IP login | 3+ different IPs | 60 minutes | Alert on impossible travel |

**Threat Levels:**
- 🟢 **Safe** - Normal activity
- 🟡 **Elevated** - One suspicious pattern detected
- 🔴 **High** - Multiple patterns or account locked

### 3. **Account Lockout Mechanism**

**How it works:**
1. Each failed auth attempt recorded in AuditLog
2. Lockout checks count failures in last 30 minutes
3. If count ≥ 5: account locked, unlock time calculated
4. User gets helpful message with unlock countdown
5. No forced password reset needed (OAuth only, no password reset)

**Database:**
- Uses existing `AuditLog` table (no schema changes)
- Counts failures via SQL query
- Stateless lockout (no additional tables)

### 4. **IP Reputation Tracking**

**Tracked Information:**
- IP address for each authentication attempt
- Client user-agent string
- Timestamp of attempt
- Success/failure status

**Queries:**
```sql
-- Find failed attempts from an IP
SELECT * FROM "AuditLog"
WHERE action = 'AUTH_FAILED' AND ip_address = '192.168.1.100'
ORDER BY created_at DESC;

-- Find logins from different IPs
SELECT DISTINCT ip_address, COUNT(*) as attempts
FROM "AuditLog"
WHERE user_id = 'user-123' AND action LIKE 'LOGIN_%'
GROUP BY ip_address;
```

### 5. **Security Summary Endpoint**

**Endpoint:** `GET /api/admin/audit-logs` (existing)

**New security context:**
- Failed attempts last 24 hours
- Current lockout status
- Detected suspicious patterns
- Current threat level
- Recent login IPs

**Example:**
```bash
curl -X GET "http://localhost:3001/api/admin/audit-logs?action=AUTH" \
  -H "Authorization: Bearer TOKEN"
```

---

## Usage Guide

### For Users

**What happens when account is locked:**
```
Error: Account temporarily locked due to multiple failed login attempts. 
Try again in 25 minutes.
```

**What triggers lockout:**
- 5 failed OAuth consent denials
- 5 failed token validations
- 5 failed API key submissions
- Any combination of auth failures

**How to unlock:**
- Wait 30 minutes (automatic)
- No password reset needed (OAuth-based)
- Next successful login clears counter

### For Administrators

**Monitor suspicious activity:**
```bash
# Get failed auth attempts (last 24h)
curl -X GET "http://localhost:3001/api/admin/audit-logs?action=AUTH_FAILED&startDate=2024-01-14T10:00:00Z" \
  -H "Authorization: Bearer TOKEN"

# Check specific user's security status
# (Use security summary utilities in codebase)
```

**Check threat level for a user:**
```typescript
import { getThreatLevel } from './utils/security';

const threat = await getThreatLevel(userId, ipAddress);
if (threat === 'high') {
  // Consider requiring re-authentication or 2FA
}
```

**Investigate account:**
```typescript
import { getSecuritySummary } from './utils/security';

const summary = await getSecuritySummary(userId);
console.log('Failed attempts last 24h:', summary.failedAttemptsLast24h);
console.log('Threat level:', summary.threatLevel);
console.log('Recent IPs:', summary.recentIPs);
console.log('Patterns:', summary.suspiciousPatterns);
```

---

## Configuration

**File:** `backend/src/utils/security.ts`

```typescript
const SECURITY_CONFIG = {
  maxFailedAttempts: 5,           // Failed attempts before lockout
  lockoutDurationMinutes: 30,     // How long account is locked
  suspiciousThreshold: 10,        // Failed attempts = suspicious
  suspiciousWindow: 60,           // Time window in minutes
  rapidAttackThreshold: 20,       // Attempts = rapid attack
  rapidAttackWindow: 5,           // Time window in minutes
};
```

**To adjust:**
1. Edit `SECURITY_CONFIG` in `security.ts`
2. Rebuild: `npm run build`
3. Redeploy containers

---

## Security Events Logged

All of these are automatically logged to `AuditLog`:

| Action | Trigger | Status | Impact |
|--------|---------|--------|--------|
| `AUTH_FAILED` | Failed OAuth, invalid token, bad API key | failure | Increments lockout counter |
| `LOGIN_OAUTH` | Successful Google OAuth | success | Clears failed attempts |
| `LOGOUT` | User logs out | success | Revokes all tokens |
| `TOKEN_REFRESH` | Token rotation | success/failure | Tracks token usage |

---

## Detection Examples

### Example 1: Brute Force Attack
```
IP: 192.168.1.50
Time: 10:00 - 10:05 AM (5 minutes)

10:00 - Attempt 1: "Invalid code" → AUTH_FAILED logged
10:01 - Attempt 2: "Invalid code" → AUTH_FAILED logged
10:02 - Attempt 3: "Invalid code" → AUTH_FAILED logged
10:03 - Attempt 4: "Invalid code" → AUTH_FAILED logged
10:04 - Attempt 5: "Invalid code" → AUTH_FAILED logged
10:05 - System locks account
10:35 - Account automatically unlocks
```

**Detection:**
- Pattern: 5 failures in 5 minutes
- Action: Account locked
- Log: "Rapid attack pattern detected (5 attempts in 5min)"

### Example 2: Multi-IP Suspicious Activity
```
User: alice@example.com
Last 60 minutes:

10:00 - Login from 192.168.1.100 → Success
10:15 - Login from 8.8.8.8 (different country) → Success
10:30 - Login from 1.2.3.4 (third IP) → Success
```

**Detection:**
- Pattern: 3 logins from 3 different IPs in 60 min
- Threat Level: Elevated
- Action: Log alert, audit admin can investigate
- Log: "Login from 3 different IPs in 60min"

---

## Testing Security Features

### Test 1: Trigger Account Lockout
```bash
# Make 5 failed OAuth attempts
for i in {1..5}; do
  curl -X GET "http://localhost:3001/api/auth/google/callback?code=invalid&error=invalid" \
    2>/dev/null | grep -o "locked\|temporary"
  sleep 1
done

# Verify lockout in database
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "SELECT COUNT(*) FROM \"AuditLog\" WHERE action='AUTH_FAILED' AND status='failure';"
```

### Test 2: Check Threat Level
```typescript
import { getThreatLevel } from './utils/security';

const threat = await getThreatLevel('user-123', '192.168.1.1');
console.log('Current threat:', threat);
// Expected: 'safe', 'elevated', or 'high'
```

### Test 3: View Security Summary
```typescript
import { getSecuritySummary } from './utils/security';

const summary = await getSecuritySummary('user-123');
console.log(JSON.stringify(summary, null, 2));

/* Output:
{
  "failedAttemptsLast24h": 2,
  "lockoutStatus": {
    "locked": false
  },
  "suspiciousPatterns": [],
  "threatLevel": "safe",
  "recentIPs": ["192.168.1.100"]
}
*/
```

---

## Future Enhancements

1. **Geographic Impossible Travel**
   - Detect login from 2 locations too far apart in too short time
   - Requires geolocation database (MaxMind, IP2Location)

2. **CAPTCHA on Suspicious Activity**
   - Require CAPTCHA after N suspicious patterns
   - Slows down attackers, doesn't block legitimate users

3. **Email Alerts**
   - Notify user of login from new IP
   - Alert admins of rapid-attack patterns

4. **Rate Limiting per User**
   - Limit login attempts per user per minute
   - Currently: 50 requests/min per API key globally

5. **2FA (Two-Factor Authentication)**
   - Backup authentication when threat level is high
   - Time-based OTP via authenticator app

6. **Account Recovery**
   - If account locked, user can unlock via email verification
   - Current: Automatic 30-minute unlock only

---

## Compliance & Privacy

✅ **No personal data exposed** - Only logs IPs (necessary for security)
✅ **Non-invasive** - No CAPTCHA unless attacking
✅ **Reversible** - Locked accounts auto-unlock
✅ **Auditable** - All actions logged to immutable audit trail
✅ **GDPR compliant** - IP addresses logged for security (legitimate interest)
✅ **User-friendly** - Clear error messages, helpful unlock times

---

## Troubleshooting

### User says account is locked but it shouldn't be
1. Check failed attempts: `docker-compose exec postgres psql ... SELECT COUNT(*) FROM "AuditLog" WHERE user_id='X' AND action='AUTH_FAILED' AND created_at > NOW() - INTERVAL '30 minutes';`
2. If count < 5: Might be different issue
3. If count ≥ 5: Check oldest failure timestamp
4. Manual unlock: Wait 30 minutes or manually delete old AUTH_FAILED entries (not recommended)

### High false-positive lockouts
1. Reduce `maxFailedAttempts` threshold (currently 5)
2. Increase `lockoutDurationMinutes` (currently 30)
3. Check if users are copy-pasting codes or having OAuth issues

### Need to unlock account immediately
```bash
# Delete failed auth records (last resort)
docker-compose exec postgres psql -U gbp_dev -d gbp_database -c \
  "DELETE FROM \"AuditLog\" WHERE user_id='user-uuid' AND action='AUTH_FAILED' AND status='failure' AND created_at < NOW() - INTERVAL '30 minutes';"
```

---

## Related Files

- `ADMIN_AUDIT_LOGS.md` - Audit log viewer API
- `AUDIT_LOGGING_SUMMARY.md` - Comprehensive audit logging
- `DEPLOY.md` - Deployment guide
- `QUICK_START.md` - Quick reference
