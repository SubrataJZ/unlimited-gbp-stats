#!/bin/bash

###############################################################################
# VPS Setup Script for zixify.zixai.in
#
# This script prepares your Ubuntu 24.04 VPS to host the app with:
# - Docker & Docker Compose
# - Nginx (reverse proxy)
# - Let's Encrypt SSL/TLS
# - GitHub Actions deployment user
#
# Usage: sudo bash vps-setup.sh
###############################################################################

set -e

echo "🚀 Starting VPS setup for zixify.zixai.in..."

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Variables
APP_USER="zixify-app"
APP_DIR="/home/zixify-app"
DOMAIN="zixify.zixai.in"
EMAIL="subrata.alone@gmail.com"

###############################################################################
# Step 1: Update system
###############################################################################
echo -e "${BLUE}Step 1: Updating system packages...${NC}"
apt-get update
apt-get upgrade -y

###############################################################################
# Step 2: Install Docker
###############################################################################
echo -e "${BLUE}Step 2: Installing Docker and Docker Compose...${NC}"

# Install Docker dependencies
apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  gnupg \
  lsb-release

# Add Docker GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# Add Docker repository
echo \
  "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Enable Docker service
systemctl enable docker
systemctl start docker

# Add docker group
usermod -aG docker root

echo -e "${GREEN}✓ Docker installed${NC}"

###############################################################################
# Step 3: Install Nginx
###############################################################################
echo -e "${BLUE}Step 3: Installing Nginx...${NC}"

apt-get install -y nginx

# Enable Nginx
systemctl enable nginx
systemctl start nginx

echo -e "${GREEN}✓ Nginx installed${NC}"

###############################################################################
# Step 4: Install Certbot for Let's Encrypt
###############################################################################
echo -e "${BLUE}Step 4: Installing Certbot for SSL...${NC}"

apt-get install -y certbot python3-certbot-nginx

echo -e "${GREEN}✓ Certbot installed${NC}"

###############################################################################
# Step 5: Create app user and directories
###############################################################################
echo -e "${BLUE}Step 5: Creating app user and directories...${NC}"

# Create user if it doesn't exist
if ! id "$APP_USER" &>/dev/null; then
  useradd -m -s /bin/bash $APP_USER
fi

# Create app directory
mkdir -p $APP_DIR
chown -R $APP_USER:$APP_USER $APP_DIR

# Configure SSH access for GitHub Actions
mkdir -p /home/$APP_USER/.ssh
chmod 700 /home/$APP_USER/.ssh

echo -e "${GREEN}✓ App user and directories created${NC}"

###############################################################################
# Step 6: Clone repository
###############################################################################
echo -e "${BLUE}Step 6: Cloning repository...${NC}"

sudo -u $APP_USER git clone https://github.com/SubrataJZ/unlimited-gbp-stats.git $APP_DIR

# Create .env file
cat > $APP_DIR/.env << 'ENVFILE'
# Database Configuration
DB_USER=gbp_dev
DB_PASSWORD=dev_password_change_me
DB_NAME=gbp_database
DB_PORT=5432

# Node Environment
NODE_ENV=production
PORT=3001

# API Configuration
API_BASE_URL=https://api.zixify.zixai.in
FRONTEND_URL=https://zixify.zixai.in

# Extension Configuration
EXTENSION_INGESTION_KEY=test-extension-key-12345
EXTENSION_ID=test-extension-id-chrome

# Google OAuth (Set these in production)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=https://api.zixify.zixai.in/api/auth/google/callback

# Session & Security (Change these in production!)
JWT_SECRET=your-jwt-secret-key-change-this
SESSION_SECRET=your-session-secret-key-change-this
ENVFILE

chown $APP_USER:$APP_USER $APP_DIR/.env
chmod 600 $APP_DIR/.env

echo -e "${GREEN}✓ Repository cloned${NC}"

###############################################################################
# Step 7: Create Nginx configuration
###############################################################################
echo -e "${BLUE}Step 7: Creating Nginx configuration...${NC}"

cat > /etc/nginx/sites-available/$DOMAIN << 'NGINXCONF'
# Upstream backend
upstream backend {
    server localhost:3001;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name zixify.zixai.in api.zixify.zixai.in;
    return 301 https://$server_name$request_uri;
}

# Main domain - serves dashboard/frontend
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name zixify.zixai.in;

    # SSL certificates (will be added by Certbot)
    ssl_certificate /etc/letsencrypt/live/zixify.zixai.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/zixify.zixai.in/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Serve static files for dashboard
    location / {
        root /home/zixify-app/unlimited-gbp-stats;
        try_files $uri $uri/ /dashboard.html;
        index dashboard.html;
    }

    # Serve pgAdmin for database management
    location /pgadmin/ {
        proxy_pass http://localhost:5050/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# API subdomain
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.zixify.zixai.in;

    # SSL certificates (will be added by Certbot)
    ssl_certificate /etc/letsencrypt/live/zixify.zixai.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/zixify.zixai.in/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Proxy to backend API
    location / {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 60s;
        proxy_connect_timeout 60s;
    }
}
NGINXCONF

# Enable the site
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/

# Remove default site
rm -f /etc/nginx/sites-enabled/default

# Test Nginx configuration
nginx -t

# Reload Nginx
systemctl reload nginx

echo -e "${GREEN}✓ Nginx configured${NC}"

###############################################################################
# Step 8: Setup Let's Encrypt SSL (manual)
###############################################################################
echo -e "${BLUE}Step 8: SSL Certificate Setup${NC}"
echo ""
echo "To set up SSL certificates, run:"
echo "  sudo certbot certonly --nginx -d zixify.zixai.in -d api.zixify.zixai.in -m $EMAIL"
echo ""
echo "After that, reload Nginx:"
echo "  sudo systemctl reload nginx"
echo ""

###############################################################################
# Step 9: Configure GitHub Actions SSH key
###############################################################################
echo -e "${BLUE}Step 9: GitHub Actions Setup${NC}"
echo ""
echo "To allow GitHub Actions to deploy, add your SSH public key to:"
echo "  /home/$APP_USER/.ssh/authorized_keys"
echo ""
echo "Then set these GitHub Secrets in your repository:"
echo "  - VPS_HOST: 188.245.199.192"
echo "  - VPS_USER: root"
echo "  - VPS_SSH_KEY: (paste the private key)"
echo ""

###############################################################################
# Step 10: Start the application
###############################################################################
echo -e "${BLUE}Step 10: Starting the application...${NC}"

cd $APP_DIR

# Create .env with required values (already done above)

# Start Docker Compose services
docker compose up -d

# Wait for services
sleep 10

# Check health
if curl -sf http://localhost:3001/health > /dev/null; then
  echo -e "${GREEN}✓ Backend is healthy!${NC}"
else
  echo -e "${BLUE}⚠ Backend might be starting, check logs with:${NC}"
  echo "  docker compose logs -f backend"
fi

###############################################################################
# Summary
###############################################################################
echo ""
echo -e "${GREEN}✅ VPS Setup Complete!${NC}"
echo ""
echo "Your app will be available at:"
echo "  🌐 https://zixify.zixai.in (Dashboard)"
echo "  🔌 https://api.zixify.zixai.in (API)"
echo "  📊 https://zixify.zixai.in/pgadmin/ (Database Admin)"
echo ""
echo "Next steps:"
echo "1. Run certbot to set up SSL:"
echo "   sudo certbot certonly --nginx -d zixify.zixai.in -d api.zixify.zixai.in"
echo ""
echo "2. Add GitHub SSH key to: /root/.ssh/authorized_keys"
echo ""
echo "3. Set GitHub Secrets (VPS_HOST, VPS_USER, VPS_SSH_KEY)"
echo ""
echo "4. Update .env with your real values (especially Google OAuth credentials)"
echo ""
echo "5. Push to main branch to trigger automatic deployment!"
echo ""
