# Top 10 Priority Fixes for Zixify - Quick Reference

## 🔴 CRITICAL (Must Do Before Any Customer Use)

### 1. Replace Static API Key with Dynamic Per-User Keys
**Status**: ❌ Not implemented  
**Impact**: Security vulnerability - API key exposed if .env leaked  
**Time**: 4-6 hours  
**What to do**:
- [ ] Create `ApiKey` table in Prisma (see schema below)
- [ ] Add endpoint `POST /api/auth/api-keys` to generate new keys
- [ ] Hash keys with bcrypt before storage
- [ ] Update `validateExtensionKey` middleware to query database

```prisma
// schema.prisma
model ApiKey {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name       String   // e.g., "Chrome Extension"
  keyHash    String   // bcrypt hash
  prefix     String   // First 8 chars for display
  isActive   Boolean  @default(true)
  lastUsedAt DateTime?
  createdAt  DateTime @default(now())
  expiresAt  DateTime?
  
  @@unique([userId, name])
  @@index([keyHash])
}
```

**Code snippet**:
```typescript
// POST /api/auth/api-keys - generate new key
router.post('/api-keys', validateJWT, asyncHandler(async (req, res) => {
  const { name } = req.body;
  const generatedKey = `zx_${crypto.randomBytes(32).toString('hex')}`;
  
  const apiKey = await prisma.apiKey.create({
    data: {
      userId: req.user!.id,
      name,
      keyHash: bcrypt.hashSync(generatedKey, 10),
      prefix: generatedKey.substring(0, 8),
    },
  });
  
  res.json({ apiKey: generatedKey, message: 'Save this key securely. It won\'t be shown again.' });
}));

// Updated middleware
export const validateExtensionKey = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthenticationError('Missing API key');
  }
  
  const key = authHeader.substring(7);
  // Find matching API key by attempting bcrypt compare
  // Or store bcrypt hash and compare
  
  next();
});
```

---

### 2. Implement Token Refresh Flow (No More 7-Day Expiry Logout)
**Status**: ❌ Not implemented  
**Impact**: Users logout every 7 days, poor UX  
**Time**: 3-4 hours  
**What to do**:
- [ ] Create `RefreshToken` model in Prisma
- [ ] Issue 15-min access tokens + 30-day refresh tokens
- [ ] Create `POST /api/auth/refresh` endpoint
- [ ] Implement refresh token rotation

```typescript
// POST /api/auth/refresh
router.post('/refresh', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) throw new AuthenticationError('Missing refresh token');
  
  const decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET!);
  const token = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  });
  
  if (!token || token.expiresAt < new Date()) {
    throw new AuthenticationError('Token expired');
  }
  
  // Issue new tokens
  const newAccessToken = jwt.sign({ userId: decoded.userId }, process.env.JWT_SECRET!, { expiresIn: '15m' });
  const newRefreshToken = jwt.sign({ userId: decoded.userId }, process.env.REFRESH_SECRET!, { expiresIn: '30d' });
  
  // Rotate refresh token
  await prisma.refreshToken.delete({ where: { id: token.id } });
  await prisma.refreshToken.create({
    data: { userId: decoded.userId, token: newRefreshToken, expiresAt: new Date(Date.now() + 30 * 86400 * 1000) },
  });
  
  res.cookie('refreshToken', newRefreshToken, { httpOnly: true, secure: true, sameSite: 'strict' });
  res.json({ accessToken: newAccessToken });
}));
```

---

### 3. Add Audit Logging for Compliance & Security
**Status**: ❌ Not implemented  
**Impact**: Cannot track who did what when - compliance violation  
**Time**: 4-5 hours  
**What to do**:
- [ ] Create `AuditLog` model in Prisma
- [ ] Add middleware to log auth events, API key operations, exports
- [ ] Create `GET /api/admin/audit-logs` endpoint for retrieval
- [ ] Set 90-day retention policy

```prisma
model AuditLog {
  id        String   @id @default(cuid())
  userId    String?
  action    String   // "API_KEY_CREATED", "LOGIN", "DATA_EXPORTED"
  resource  String   // "ApiKey:123", "User:456"
  status    String   // "SUCCESS", "FAILURE"
  ipAddress String?
  metadata  Json?    // Additional context
  createdAt DateTime @default(now())
  
  @@index([userId])
  @@index([createdAt])
}
```

---

### 4. Secure Credential Storage in Chrome Extension
**Status**: ⚠️  Partially implemented (localStorage = unsafe)  
**Impact**: XSS attack can steal API key  
**Time**: 2-3 hours  
**What to do**:
- [ ] Replace localStorage with sessionStorage for temp tokens
- [ ] Encrypt API keys with user's Google OAuth password
- [ ] Use Web Crypto API for client-side encryption

```javascript
// Replace this:
localStorage.setItem('gbpAuthToken', token); // ❌ UNSAFE

// With this:
// Short-lived (session expires when tab closes)
chrome.storage.session.set({ jwtToken: token }); // ✅ BETTER

// For persistent storage, encrypt
const encrypted = await encryptWithSubtle(apiKey, userPassword);
chrome.storage.local.set({ encryptedApiKey: encrypted }); // ✅ SAFE
```

---

### 5. Enforce HTTPS & Add Security Headers
**Status**: ⚠️  Partially implemented (helmet present, HTTPS not enforced)  
**Impact**: Man-in-the-middle attacks possible  
**Time**: 1-2 hours  
**What to do**:
- [ ] Add HTTPS redirect middleware
- [ ] Set HSTS header with preload
- [ ] Add CSP policy
- [ ] Test with https://securityheaders.com

```typescript
// Redirect to HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    return res.redirect(`https://${req.get('host')}${req.originalUrl}`);
  }
  next();
});

// Enhanced Helmet
app.use(helmet({
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "https://apis.google.com"],
    },
  },
}));
```

---

## 🟠 HIGH (Do Within 1-2 Weeks)

### 6. Auto-Provision API Keys on First Login
**Status**: ❌ Not implemented  
**Impact**: Users have to manually create API keys - high friction  
**Time**: 4-5 hours  
**What to do**:
- [ ] Create `POST /api/auth/provision-extension` endpoint
- [ ] Auto-generate API key after successful OAuth
- [ ] Return key securely (only in response, not in logs)
- [ ] Update extension to call this endpoint

```typescript
// POST /api/auth/provision-extension
router.post('/provision-extension', validateJWT, asyncHandler(async (req, res) => {
  const { extensionId } = req.body;
  
  // Check if already provisioned
  let apiKey = await prisma.apiKey.findFirst({
    where: { userId: req.user!.id, name: `ext-${extensionId}` },
  });
  
  if (!apiKey) {
    const key = `zx_${crypto.randomBytes(32).toString('hex')}`;
    apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user!.id,
        name: `ext-${extensionId}`,
        keyHash: bcrypt.hashSync(key, 10),
        prefix: key.substring(0, 8),
      },
    });
    
    return res.json({ apiKey: key, serverUrl: process.env.API_URL });
  }
  
  res.json({ message: 'Already provisioned', serverUrl: process.env.API_URL });
}));
```

---

### 7. Implement Google OAuth Flow
**Status**: ⚠️  Partially configured (endpoints exist, may need testing)  
**Impact**: Users can't sign up easily  
**Time**: 6-8 hours  
**What to do**:
- [ ] Register app in Google Cloud Console
- [ ] Get Client ID and Client Secret
- [ ] Test OAuth flow with ngrok (for local HTTPS)
- [ ] Auto-discover user's business locations
- [ ] Test with real Google account

```typescript
// Verify oauth is working end-to-end:
// 1. User clicks "Sign in with Google"
// 2. Redirects to GET /api/auth/google
// 3. Google consent screen appears
// 4. Redirects back to /api/auth/google/callback
// 5. User is logged in and has API key provisioned
```

---

### 8. Build Modern Dashboard
**Status**: ❌ Minimal UI only  
**Impact**: No visual feedback, hard to use  
**Time**: 8-10 hours  
**What to do**:
- [ ] Create Dashboard React component
- [ ] Show metric cards (total businesses, total records)
- [ ] List tracked businesses with record counts
- [ ] Make responsive for mobile
- [ ] Add loading/error states

```typescript
// Key dashboard features:
- Last sync time and status ✓
- Businesses tracked ✓
- Total metrics captured ✓
- Sync progress indicator ✓
- Business selection and details ✓
- Date range comparison ✓
```

---

### 9. Real-Time Sync Status (WebSocket)
**Status**: ❌ Not implemented  
**Impact**: Users can't see sync progress - feels broken  
**Time**: 6-8 hours  
**What to do**:
- [ ] Add Socket.io to backend
- [ ] Emit sync events from ingest endpoint
- [ ] Subscribe frontend to real-time updates
- [ ] Show progress bar during sync
- [ ] Display records/sec being processed

```typescript
// When extension sends metrics:
io.to(userId).emit('sync:progress', {
  recordsProcessed: 150,
  totalRecords: 500,
  percentComplete: 30,
  recordsPerSecond: 25,
});
```

---

### 10. Input Validation & Error Handling
**Status**: ⚠️  Partial (Prisma prevents SQL injection, but validation missing)  
**Impact**: Bad data in database, confusing error messages  
**Time**: 3-4 hours  
**What to do**:
- [ ] Add Zod/Joi validation to all endpoints
- [ ] Return clear error messages to users
- [ ] Log validation errors for debugging
- [ ] Test with invalid/malicious inputs

```typescript
import { z } from 'zod';

const metricSchema = z.object({
  googleLocationId: z.string().min(10),
  date: z.string().date(),
  metricType: z.enum(['views', 'calls', 'actions']),
  value: z.number().int().positive(),
});

router.post('/ingest', (req, res) => {
  try {
    const validated = metricSchema.parse(req.body);
    // Process validated data
  } catch (error) {
    res.status(400).json({ error: 'Invalid metric data', details: error.errors });
  }
});
```

---

## 📋 Quick Implementation Order

**Do these in order** (each unlocks the next):

1. **Dynamic API Keys** (4-6 hrs) → removes hardcoded secrets
2. **Token Refresh** (3-4 hrs) → improves user session management
3. **Audit Logging** (4-5 hrs) → enables compliance
4. **Secure Extension Storage** (2-3 hrs) → prevents credential theft
5. **HTTPS + Headers** (1-2 hrs) → enables production deployment
6. **Google OAuth** (6-8 hrs) → enables user registration
7. **Auto-Provision Keys** (4-5 hrs) → smooth onboarding
8. **Modern Dashboard** (8-10 hrs) → improves UX
9. **WebSocket Sync** (6-8 hrs) → real-time feedback
10. **Input Validation** (3-4 hrs) → data quality

**Total time**: ~45-60 hours = ~1-2 weeks with focused effort

---

## ✅ Verification Checklist

After implementing each fix, verify:

- [ ] No hardcoded secrets in code
- [ ] All API endpoints return proper error messages
- [ ] Extension can authenticate and retrieve API key
- [ ] Audit logs capture all sensitive operations
- [ ] Tokens refresh automatically (user never forced to log in)
- [ ] Dashboard displays real-time sync progress
- [ ] Mobile responsive tested
- [ ] Security headers present (https://securityheaders.com)
- [ ] No XSS vulnerabilities (test with `<script>alert('xss')</script>`)
- [ ] Rate limiting prevents brute force attacks

---

## 🚀 Ready for Beta Launch When

✅ All 10 items above completed  
✅ Security audit passed  
✅ Load tested with 100 concurrent users  
✅ Tested on iOS/Android mobile  
✅ Documentation written  
✅ Support email/chat configured  
✅ Privacy policy and terms reviewed by legal  
✅ Backup strategy tested  
✅ Monitoring/alerting configured  
✅ Rollback procedure documented  

**Estimated**: 4-6 weeks from now
