#!/usr/bin/env bash
# Kit post-acquire hook: TypeScript / Next.js
# Runs once after the workarea is acquired and ready.
# Installs dependencies if node_modules is absent.

set -euo pipefail

WORKAREA_ROOT="${1:-$(pwd)}"
cd "$WORKAREA_ROOT"

echo "[ts-nextjs kit] post_acquire: checking workarea..."

# Install dependencies if not present
if [ ! -d "node_modules" ]; then
  echo "[ts-nextjs kit] Installing dependencies..."
  if command -v pnpm &>/dev/null; then
    pnpm install --prefer-offline
  elif command -v npm &>/dev/null; then
    npm install
  else
    echo "[ts-nextjs kit] WARNING: No package manager found. Skipping install."
  fi
fi

echo "[ts-nextjs kit] post_acquire: done."
