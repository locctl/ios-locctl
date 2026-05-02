#!/usr/bin/env bash
# scripts/build-dmg.sh — full local dmg build pipeline.
#
# Order matters:
#   1. PyInstaller backend + wifi-tunnel  (needed before electron-builder
#      copies them into Resources/ via extraResources).
#   2. Vite frontend → packages/frontend/dist/
#   3. electron-builder dmg (unsigned).
#
# CSC_IDENTITY_AUTO_DISCOVERY=false stops electron-builder from poking
# the user's keychain for a Developer ID cert that doesn't exist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."

cyan()  { printf '\033[36m▶ %s\033[0m\n' "$*"; }
green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }

cd "$ROOT_DIR"

cyan "Step 1/3 — PyInstaller (backend + wifi-tunnel)"
pnpm build:be
green "PyInstaller bundles built"

cyan "Step 2/3 — Vite frontend"
pnpm build:fe
green "Frontend built"

cyan "Step 3/3 — electron-builder dmg (unsigned)"
cd packages/frontend
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist
green "dmg built"

echo
green "All done. Outputs in packages/frontend/release/:"
ls -1 "$ROOT_DIR/packages/frontend/release/"*.dmg 2>/dev/null || echo "  (no dmg found — check electron-builder output above)"
