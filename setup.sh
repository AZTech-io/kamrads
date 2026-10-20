#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 VPS. Run as root from inside the kamrads folder.
set -euo pipefail
if ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
timedatectl set-timezone Australia/Perth || true
[ -f .env ] || { cp .env.example .env; echo ">> Created .env - edit it now (nano .env), then run: docker compose up -d --build"; exit 0; }
docker compose up -d --build
echo ">> KAMRADS is starting. Watch it with: docker compose logs -f kamrads"
