#!/usr/bin/env bash
# Render build script — installs dependencies, Playwright Chromium, and builds.
# Set this as the "Build Command" in your Render service settings:
#   ./render-build.sh
set -e

echo "==> Installing Node dependencies..."
npm install

echo "==> Installing Playwright Chromium + system deps..."
npx playwright install chromium --with-deps

echo "==> Build complete."
