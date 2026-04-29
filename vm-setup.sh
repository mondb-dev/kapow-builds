#!/usr/bin/env bash
# Kapow VM bootstrap — run as root on a fresh Debian 12 VM
# Usage: curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/kapow/main/vm-setup.sh | sudo bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mondb-dev/kapow-builds.git}"
APP_DIR="/opt/kapow"
DOCKER_COMPOSE_VERSION="2.27.1"

echo "==> Installing system deps"
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git lsb-release ufw

echo "==> Installing Docker"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

echo "==> Cloning repo"
# Pass GITHUB_TOKEN via env for private repos: GITHUB_TOKEN=xxx bash vm-setup.sh
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_REPO_URL="${REPO_URL/https:\/\//https://${GITHUB_TOKEN}@}"
else
  AUTH_REPO_URL="$REPO_URL"
fi
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$AUTH_REPO_URL" "$APP_DIR"
fi

echo "==> Checking for .env"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "⚠️  No .env found. Copy your .env to $APP_DIR/.env before running docker compose."
  echo "   Template saved to $APP_DIR/.env.example"
  cat > "$APP_DIR/.env.example" << 'EOF'
# ── Auth ──────────────────────────────────────────────────────────
NEXTAUTH_SECRET=
NEXTAUTH_URL=https://YOUR_DOMAIN

# ── Database ──────────────────────────────────────────────────────
POSTGRES_PASSWORD=changeme

# ── AI ────────────────────────────────────────────────────────────
AI_PROVIDER=google
AI_MODEL_STRONG=gemini-2.0-flash-thinking-exp-01-21
AI_MODEL_BALANCED=gemini-2.0-flash
AI_MODEL_FAST=gemini-2.0-flash
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp-credentials

# ── Comms ─────────────────────────────────────────────────────────
COMMS_TELEGRAM_BOT_TOKEN=
COMMS_TELEGRAM_CHAT_ID=

# ── Integrations ──────────────────────────────────────────────────
GITHUB_TOKEN=
VERCEL_TOKEN=
VERCEL_SCOPE=
NETLIFY_TOKEN=

# ── Kapow ─────────────────────────────────────────────────────────
KAPOW_DOMAIN=your.domain.com
KAPOW_INTERNAL_SECRET=changeme
EOF
fi

echo "==> Configuring firewall"
ufw --force enable
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp

echo ""
echo "✅ VM bootstrap complete."
echo ""
echo "Next steps:"
echo "  1. Upload your .env:    scp .env kapow-vm:$APP_DIR/.env"
echo "  2. Start the stack:     cd $APP_DIR && docker compose up -d --build"
echo "  3. Point your domain to 35.240.161.186 (A record)"
echo "  4. Caddy auto-provisions TLS once DNS resolves."
