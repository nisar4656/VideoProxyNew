#!/usr/bin/env bash
# Render build script — installs system libs, Playwright Chromium, and Node deps.
# Set this as the "Build Command" in your Render service settings:
#   ./render-build.sh
set -e

echo "==> Installing system libraries required by Chromium headless..."
apt-get update -qq
apt-get install -y -qq \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libasound2 \
  libcairo2 \
  libx11-xcb1 \
  libxcb-dri3-0 \
  fonts-liberation \
  --no-install-recommends 2>&1 | tail -3

echo "==> Installing Node dependencies..."
npm install

echo "==> Installing Playwright Chromium binary (system deps already installed)..."
npx playwright install chromium

echo "==> Build complete."
