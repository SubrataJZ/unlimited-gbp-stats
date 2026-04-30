# Setup Guide — Unlimited GBP Stats Production Environment

## Prerequisites

- **Docker** and **Docker Compose** (version 3.9+)
- **Node.js** (v20+) — for local development without Docker
- **Google Cloud Console** access — for OAuth 2.0 credentials

## Quick Start (with Docker)

### 1. Clone and Setup

```bash
git clone https://github.com/SubrataJZ/unlimited-gbp-stats.git
cd unlimited-gbp-stats
cp .env.example .env
```

### 2. Configure Environment Variables

Edit `.env` and update:
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — from Google Cloud Console
- `JWT_SECRET` — generate a strong random string (e.g., `openssl rand -hex 32`)
- `NEXTAUTH_SECRET` — generate a strong random string (e.g., `openssl rand -hex 32`)

### 3. Start Services

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL** on `localhost:5432`
- **Backend API** on `localhost:3000`
- **pgAdmin** (database GUI) on `localhost:5050`

### 4. Verify Setup

```bash
# Check if services are running
docker-compose ps

# View logs
docker-compose logs -f backend

# Test API health
curl http://localhost:3000/health

# Access database GUI
open http://localhost:5050
# Login: admin@example.com / admin_password_change_in_production
```

### 5. Run Prisma Migrations

Migrations run automatically on backend startup. To manually run:

```bash
docker-compose exec backend npx prisma migrate dev --name initial
```

To see the schema:

```bash
docker-compose exec backend npx prisma studio
# Opens http://localhost:5555
```

---

## Local Development (without Docker)

### 1. Install Dependencies

```bash
npm install
npx prisma generate
```

### 2. Start PostgreSQL (Docker only)

```bash
docker run -d \
  --name gbp_postgres \
  -e POSTGRES_USER=gbp_user \
  -e POSTGRES_PASSWORD=gbp_dev_password_change_in_production \
  -e POSTGRES_DB=gbp_stats_production \
  -p 5432:5432 \
  postgres:16-alpine
```

### 3. Configure .env

Update `.env` with:
```
DATABASE_URL=postgresql://gbp_user:gbp_dev_password_change_in_production@localhost:5432/gbp_stats_production
NODE_ENV=development
```

### 4. Run Migrations and Start Server

```bash
npx prisma migrate dev
npm run dev
```

---

## Google OAuth 2.0 Setup

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project: "Unlimited GBP Stats"
3. Enable these APIs:
   - **Google Business Profile API** (for managing locations)
   - **Google My Business API** (for performance metrics)
   - **Google Places API**
   - **Google Drive API** (optional, for file sharing)

### 2. Create OAuth 2.0 Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth 2.0 Client ID**
3. Choose **Web application**
4. Add authorized redirect URIs:
   - `http://localhost:3000/auth/google/callback` (local)
   - `http://localhost:3000/auth/google/callback` (development)
   - `https://yourdomain.com/auth/google/callback` (production)
5. Copy **Client ID** and **Client Secret** into `.env`

### 3. Test OAuth Flow

```bash
open http://localhost:3000/auth/signin
```

---

## Database Management

### pgAdmin Web Interface

Access at `http://localhost:5050`:
- **Email:** admin@example.com
- **Password:** admin_password_change_in_production

### Add PostgreSQL Server to pgAdmin

1. Right-click **Servers** → **Create** → **Server**
2. **General** tab:
   - Name: `GBP Stats DB`
3. **Connection** tab:
   - Host: `postgres` (or `localhost` if running locally)
   - Username: `gbp_user`
   - Password: `gbp_dev_password_change_in_production`
4. Click **Save**

### Prisma Studio (Database GUI)

```bash
docker-compose exec backend npx prisma studio
# or locally:
npx prisma studio
```

Runs on `http://localhost:5555` — visual editor for database records.

---

## Troubleshooting

### PostgreSQL won't start

```bash
# Check if port 5432 is in use
netstat -tulpn | grep 5432

# Remove orphaned container
docker-compose down -v
docker-compose up -d
```

### Backend can't connect to database

```bash
# Check Docker network
docker network ls
docker inspect gbp_network

# Restart services
docker-compose restart backend
docker-compose logs backend
```

### Prisma migration errors

```bash
# Reset database (CAUTION: deletes all data)
docker-compose exec backend npx prisma migrate reset

# Or manually:
docker-compose exec backend npx prisma db push
```

### Chrome extension won't sync

1. Verify backend is running: `curl http://localhost:3000/health`
2. Check extension API key in `.env` matches extension config
3. Check browser console for CORS errors
4. Verify server URL in extension settings is correct

---

## Useful Docker Commands

```bash
# View running services
docker-compose ps

# View logs (all services)
docker-compose logs

# View logs (specific service)
docker-compose logs -f backend
docker-compose logs -f postgres

# Stop all services
docker-compose stop

# Stop and remove containers, networks (but keep volumes)
docker-compose down

# Stop and remove everything including volumes
docker-compose down -v

# Execute command in container
docker-compose exec backend npx prisma migrate dev

# Rebuild images
docker-compose up -d --build
```

---

## Next Steps

1. **Implement Google OAuth routes** in `/pages/api/auth/[...nextauth].js`
2. **Build frontend** using Next.js and React
3. **Implement location scraper** for Chrome extension
4. **Set up webhooks** for real-time sync notifications
5. **Deploy to production** (Hetzner Linux VPS)

---

## Production Deployment Checklist

- [ ] Update all `.env` values (Google credentials, secrets, URLs)
- [ ] Set `NODE_ENV=production`
- [ ] Use strong, randomly generated secrets (JWT, NEXTAUTH)
- [ ] Configure domain and SSL/TLS certificates
- [ ] Set up PostgreSQL backups
- [ ] Enable database encryption at rest
- [ ] Configure monitoring and alerting
- [ ] Set up log aggregation
- [ ] Create CI/CD pipeline (GitHub Actions)
- [ ] Plan disaster recovery strategy

---

For issues or questions, refer to `PROJECT_CONTEXT.md` for architecture overview.
