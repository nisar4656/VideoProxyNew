#!/usr/bin/env bash
# Render build script — installs Chromium then builds the app.
# Set this as the "Build Command" in your Render service settings:
#   ./render-build.sh
set -e

echo "==> Installing Chromium..."
apt-get update -qq && apt-get install -y -qq chromium-browser \
  fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libcups2 libdbus-1-3 libgdk-pixbuf2.0-0 libnspr4 \
  libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
  xdg-utils --no-install-recommends 2>&1 | tail -5

echo "==> Chromium installed at: $(which chromium-browser || echo 'not found')"

echo "==> Installing Node dependencies..."
npm install --omit=dev

echo "==> Build complete."
