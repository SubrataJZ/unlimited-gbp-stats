# Admin Audit Logs API

**Endpoint:** `GET /api/admin/audit-logs`

**Authentication:** Required (JWT access token)

**Purpose:** Retrieve, filter, paginate, and export audit logs for compliance, security investigation, and operational monitoring.

---

## Basic Usage

### Get Last 50 Audit Events
```bash
curl -X GET http://localhost:3001/api/admin/audit-logs \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Response:**
```json
{
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 247,
    "totalPages": 5,
    "hasNextPage": true,
    "hasPrevPage": false
  },
  "filters": {
    "action": null,
    "status": null,
    "userId": null,
    "startDate": null,
    "endDate": null,
    "sortBy": "createdAt",
    "sortOrder": "desc"
  },
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "userId": "user-123",
      "action": "INGEST_SUCCESS",
      "resource": null,
      "status": "success",
      "ipAddress": "192.168.1.100",
      "userAgent": "Mozilla/5.0 (Chrome/91.0)",
      "metadata": { "metricsCount": 150 },
      "createdAt": "2024-01-15T10:30:45.123Z"
    }
  ],
  "timestamp": "2024-01-15T10:35:00.000Z"
}
```

---

## Query Parameters

### Pagination
- `page` (integer, default: 1) - Page number
- `limit` (integer, default: 50, max: 500) - Results per page

### Filtering
- `action` (string) - Filter by action (case-insensitive contains)
- `status` (string) - Filter by status: `success` or `failure`
- `userId` (string) - Filter by user ID
- `startDate` (ISO 8601) - Filter from date (inclusive)
- `endDate` (ISO 8601) - Filter to date (inclusive)

### Sorting
- `sortBy` (string, default: createdAt) - Field to sort: `createdAt`, `action`, `userId`
- `sortOrder` (string, default: desc) - Order: `asc`, `desc`

### Export
- `export` (string) - Format: `csv` or `json`

---

## Common Examples

### Get Failed Login Attempts (Last 24 Hours)
```bash
curl -X GET "http://localhost:3001/api/admin/audit-logs?action=AUTH_FAILED&status=failure&startDate=2024-01-14T10:00:00Z&endDate=2024-01-15T10:00:00Z" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get All API Key Operations for a User
```bash
curl -X GET "http://localhost:3001/api/admin/audit-logs?action=API_KEY&userId=user-123&limit=100" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Export Audit Trail as CSV
```bash
curl -X GET "http://localhost:3001/api/admin/audit-logs?startDate=2024-01-08T00:00:00Z&endDate=2024-01-15T23:59:59Z&export=csv&limit=500" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -o audit-logs.csv
```

### Export as JSON
```bash
curl -X GET "http://localhost:3001/api/admin/audit-logs?export=json&limit=500" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -o audit-logs.json
```

---

## Audit Log Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique identifier |
| `userId` | UUID (nullable) | User who performed action |
| `action` | string | Action type (LOGIN_OAUTH, API_KEY_CREATED, etc.) |
| `resource` | string (nullable) | Resource affected |
| `status` | enum | `success` or `failure` |
| `ipAddress` | string (nullable) | Client IP address |
| `userAgent` | string (nullable) | Browser/client user-agent |
| `metadata` | JSONB | Context-specific data |
| `createdAt` | timestamp | When action occurred |

---

## Action Types

### Authentication
- `LOGIN_OAUTH` - Google OAuth login
- `LOGIN_PASSWORD` - Password auth (future)
- `LOGOUT` - Session termination
- `TOKEN_REFRESH` - Token rotation
- `AUTH_FAILED` - Failed authentication

### API Keys
- `API_KEY_CREATED` - Key generation
- `API_KEY_REVOKED` - Key deactivation

### Data Ingestion
- `INGEST_SUCCESS` - Metrics ingested
- `INGEST_FAILED` - Ingestion failure

### Data Operations (Future)
- `DATA_EXPORTED` - Data export
- `DATA_IMPORTED` - Data import
- `DATA_IMPORT_FAILED` - Import failure

---

## Use Cases

**Compliance:** Export audit trail for regulatory compliance
**Security Investigation:** Find user activity, failed logins, suspicious patterns
**Operational Metrics:** Monitor data ingestion health, API key usage
**Incident Response:** Track what happened, when, from where
**Access Control:** Verify authorization events

---

## Performance

- Pagination recommended for large result sets
- Date ranges improve query speed
- Max 500 results per request
- All queries indexed for fast performance

---

## Security

✅ JWT authentication required
✅ Audit logs are immutable (append-only)
✅ IP address tracked for every action
✅ User-agent captured for client identification
✅ Flexible filtering for investigations
✅ Export with timestamp for traceability
