#!/usr/bin/env bash
# Render build script — installs dependencies and builds the app.
# Set this as the "Build Command" in your Render service settings:
#   ./render-build.sh
set -e

echo "==> Installing Node dependencies..."
npm install --omit=dev

echo "==> Build complete."
