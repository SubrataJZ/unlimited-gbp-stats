# 🚀 Deployment Guide - zixify.zixai.in

Complete guide to deploying the Unlimited GBP Stats app to your VPS with automatic GitHub Actions CI/CD.

---

## 📋 Prerequisites

- ✅ VPS: Ubuntu 24.04.4 LTS (188.245.199.192)
- ✅ SSH access as root
- ✅ Domain: zixify.zixai.in (DNS pointing to VPS IP)
- ✅ GitHub repository: https://github.com/SubrataJZ/unlimited-gbp-stats

---

## 🔑 Step 1: SSH Key Setup for GitHub Actions

### 1.1 SSH Key Pair (Already Generated)

**Private Key** (for GitHub Secrets):
```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACA2VHa4VFgGIGHe30WkruDaEECq1naPFQPPOEXnyvrADwAAAKAwVyKPMFci
jwAAAAtzc2gtZWQyNTUxOQAAACA2VHa4VFgGIGHe30WkruDaEECq1naPFQPPOEXnyvrADw
AAAECn7MxE5ZjW4cpGjgPw0TmI0ZUOuUdM3JgmyqcbvN3tLjZUdrhUWAYgYd7fRaSu4NoQ
QKrWdo8VA884RefK+sAPAAAAGWdpdGh1Yi1hY3Rpb25zLXZwcy1kZXBsb3kBAgME
-----END OPENSSH PRIVATE KEY-----
```

**Public Key** (for VPS):
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDZUdrhUWAYgYd7fRaSu4NoQQKrWdo8VA884RefK+sAP github-actions-vps-deploy
```

### 1.2 Add Public Key to VPS

SSH into your VPS and add the public key:

```bash
# SSH to VPS
ssh root@188.245.199.192

# Add public key to authorized_keys
mkdir -p ~/.ssh
cat >> ~/.ssh/authorized_keys << 'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDZUdrhUWAYgYd7fRaSu4NoQQKrWdo8VA884RefK+sAP github-actions-vps-deploy
EOF

# Set correct permissions
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys

# Test SSH key (from your computer, not VPS)
ssh -i /path/to/private/key root@188.245.199.192 "echo 'SSH access confirmed!'"
```

---

## 🐳 Step 2: VPS Setup (Run Once)

### 2.1 Run Setup Script on VPS

```bash
# SSH to VPS
ssh root@188.245.199.192

# Download and run the setup script
cd /tmp
wget https://raw.githubusercontent.com/SubrataJZ/unlimited-gbp-stats/main/vps-setup.sh
chmod +x vps-setup.sh
sudo bash vps-setup.sh
```

### 2.2 Setup SSL Certificate

After the setup script completes:

```bash
# Run certbot to get SSL certificate
sudo certbot certonly --nginx \
  -d zixify.zixai.in \
  -d api.zixify.zixai.in \
  -m subrata.alone@gmail.com

# Reload Nginx to activate SSL
sudo systemctl reload nginx

# Verify SSL
curl -I https://zixify.zixai.in
curl -I https://api.zixify.zixai.in
```

### 2.3 Verify Services Running

```bash
# Check Docker containers
docker ps

# Expected output:
# gbp_backend  (Node.js API on :3001)
# gbp_postgres (PostgreSQL on :5432)
# gbp_pgadmin  (pgAdmin on :5050)

# Check Nginx
sudo systemctl status nginx

# Test backend health
curl http://localhost:3001/health
# Should return: {"status":"ok","timestamp":"...","uptime":...}
```

---

## 🔐 Step 3: GitHub Secrets Configuration

### 3.1 Add Secrets to GitHub Repository

Go to: **GitHub** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these secrets:

| Secret Name | Value |
|-------------|-------|
| `VPS_HOST` | `188.245.199.192` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | (Private key from Step 1.1) |

### 3.2 Example: Adding VPS_SSH_KEY

1. Go to GitHub repository → **Settings**
2. Click **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `VPS_SSH_KEY`
5. Value: Paste the entire private key (from Step 1.1)
6. Click **Add secret**

---

## ⚙️ Step 4: Configure Environment Variables

### 4.1 Update .env on VPS

SSH to VPS and update the environment file:

```bash
ssh root@188.245.199.192

# Edit the .env file
nano /home/zixify-app/.env
```

Update these values:

```bash
# Google OAuth (get from Google Cloud Console)
GOOGLE_CLIENT_ID=your_actual_google_client_id
GOOGLE_CLIENT_SECRET=your_actual_google_client_secret

# Generate secure secrets
JWT_SECRET=$(openssl rand -base64 32)
SESSION_SECRET=$(openssl rand -base64 32)

# Database (keep default or change)
DB_PASSWORD=change_to_secure_password

# URLs
API_BASE_URL=https://api.zixify.zixai.in
FRONTEND_URL=https://zixify.zixai.in
```

### 4.2 Restart Services with New Config

```bash
cd /home/zixify-app

# Restart Docker containers
docker compose restart

# Check logs
docker compose logs -f backend
```

---

## 🚀 Step 5: Test the Deployment Pipeline

### 5.1 Verify Tests Pass Locally

```bash
# In Claude Code, run:
bash backend/tests/api-tests.sh

# You should see all 10 tests passing ✅
```

### 5.2 Push to GitHub

```bash
git push origin main
```

### 5.3 Monitor GitHub Actions

1. Go to: **GitHub** → **Actions** tab
2. You should see two workflows running:
   - ✅ **Test Backend API** (runs tests)
   - 🚀 **Deploy to Production** (deploys after tests pass)

3. Both should show **green checkmarks** when complete

---

## 📊 Access Your App

After successful deployment:

| URL | Purpose |
|-----|---------|
| https://zixify.zixai.in | Dashboard / Frontend |
| https://api.zixify.zixai.in | REST API Endpoints |
| https://zixify.zixai.in/pgadmin/ | Database Admin (pgAdmin) |

### API Health Check

```bash
curl https://api.zixify.zixai.in/health

# Expected response:
# {"status":"ok","timestamp":"2026-05-03T...","uptime":...}
```

---

## 🔄 Automatic Deployment Workflow

```
1. You push code to GitHub (main branch)
                    ↓
2. GitHub Actions triggers "Test Backend API"
   - Runs 10 API tests
   - Builds Docker images
   - Tests container startup
                    ↓
3. If tests pass ✅
   - Triggers "Deploy to Production"
   - SSH into VPS (188.245.199.192)
   - `git pull origin main`
   - `docker compose up -d`
   - Waits for backend health check
                    ↓
4. App live at zixify.zixai.in ✅
```

---

## 🔧 Maintenance & Troubleshooting

### Check VPS Status

```bash
ssh root@188.245.199.192

# Docker containers
docker ps

# View logs
docker compose logs -f backend    # Backend logs
docker compose logs -f postgres   # Database logs

# Check disk space
df -h

# Check CPU/Memory
htop
```

### Restart Services

```bash
cd /home/zixify-app

# Restart all services
docker compose restart

# Restart specific service
docker compose restart backend

# Stop all services
docker compose down

# Start all services
docker compose up -d
```

### View API Logs

```bash
docker compose logs -f backend --tail 50
```

### Database Backup

```bash
# Backup PostgreSQL database
docker compose exec postgres pg_dump -U gbp_dev gbp_database > backup-$(date +%Y%m%d-%H%M%S).sql

# Restore database
docker compose exec -T postgres psql -U gbp_dev gbp_database < backup-20260503.sql
```

---

## 🆘 Common Issues

### Issue: Deployment fails with SSH error

**Solution**: Verify SSH key is added correctly
```bash
ssh -i /path/to/key root@188.245.199.192 "echo 'OK'"
```

### Issue: Backend unhealthy after deployment

**Solution**: Check logs and restart
```bash
docker compose logs backend
docker compose restart backend
docker compose logs -f backend
```

### Issue: SSL certificate not working

**Solution**: Renew certificate
```bash
sudo certbot renew --nginx
sudo systemctl reload nginx
```

### Issue: Database connection errors

**Solution**: Verify PostgreSQL is running
```bash
docker compose ps
docker compose logs postgres
```

---

## 📝 Summary

You now have:

✅ **Automated CI/CD Pipeline**
- Tests run on every push
- Automatic deployment on test success
- Zero-downtime updates

✅ **Production Environment**
- Docker containers on Ubuntu 24.04
- Nginx reverse proxy with SSL/TLS
- PostgreSQL database
- pgAdmin for database management

✅ **Monitoring**
- GitHub Actions logs
- Docker container logs
- Application health checks

✅ **Security**
- SSH key authentication
- GitHub Secrets for credentials
- Let's Encrypt SSL certificates
- Security headers in Nginx

---

## 🎯 What Happens Now

When you:
1. **Make code changes** locally in Claude
2. **Commit and push** to GitHub
3. **Tests automatically run** (10 API tests)
4. **If tests pass** → Automatically deploys to VPS
5. **Your app is live** at zixify.zixai.in ✅

**That's it!** Your full CI/CD pipeline is ready! 🚀
