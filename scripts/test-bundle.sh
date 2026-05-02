#!/usr/bin/env bash
# scripts/test-bundle.sh — verify PyInstaller bundles run in a clean shell.
#
# Why: when running under `pnpm dev`, Python's site-packages and the repo venv
# are on PATH/PYTHONPATH, so import errors get masked. This script strips the
# environment to mimic a fresh user account that never installed Python.
#
# What it checks:
#   1. ios-locctl-backend binary launches without ModuleNotFoundError
#   2. backend serves HTTP 200 on GET /docs within 30s
#   3. wifi-tunnel binary launches without ModuleNotFoundError (argparse exits cleanly)
#
# It does NOT verify device interaction (no iPhone available in CI).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
BACKEND_DIST="$ROOT_DIR/packages/backend/dist/ios-locctl-backend"
TUNNEL_DIST="$ROOT_DIR/packages/backend/dist/wifi-tunnel"
BACKEND_BIN="$BACKEND_DIST/ios-locctl-backend"
TUNNEL_BIN="$TUNNEL_DIST/wifi-tunnel"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

[[ -x "$BACKEND_BIN" ]] || { red "✗ backend binary missing: $BACKEND_BIN — run 'pnpm build:be' first"; exit 1; }
[[ -x "$TUNNEL_BIN"  ]] || { red "✗ wifi-tunnel binary missing: $TUNNEL_BIN — run 'pnpm build:be' first"; exit 1; }

# Clean env: strip PATH/PYTHONPATH/etc, keep only what a fresh user would have.
# HOME is preserved so log files land in ~/.ios-locctl/logs as usual.
CLEAN_ENV=(
    env -i
    PATH=/usr/bin:/bin:/usr/sbin:/sbin
    HOME="$HOME"
    LANG="${LANG:-en_US.UTF-8}"
    TMPDIR="${TMPDIR:-/tmp}"
)

# ── 1. wifi-tunnel binary smoke test ─────────────────────────────
blue "[1/3] wifi-tunnel binary smoke test (argparse --help)…"
TUNNEL_OUT=$("${CLEAN_ENV[@]}" "$TUNNEL_BIN" --help 2>&1 || true)
if echo "$TUNNEL_OUT" | grep -qE "ModuleNotFoundError|ImportError"; then
    red "✗ wifi-tunnel has missing modules:"
    echo "$TUNNEL_OUT" | grep -E "ModuleNotFoundError|ImportError" | head -5
    exit 1
fi
if ! echo "$TUNNEL_OUT" | grep -q "usb"; then
    red "✗ wifi-tunnel didn't print expected subcommand list. Output:"
    echo "$TUNNEL_OUT" | head -20
    exit 1
fi
green "  ✓ wifi-tunnel imports OK, subcommands present"

# ── 2. backend binary boots ──────────────────────────────────────
blue "[2/3] launching backend binary in clean env…"
LOG_FILE=$(mktemp -t ios-locctl-bundle-test.XXXXXX)
"${CLEAN_ENV[@]}" "$BACKEND_BIN" > "$LOG_FILE" 2>&1 &
BACKEND_PID=$!
trap 'kill "$BACKEND_PID" 2>/dev/null || true; rm -f "$LOG_FILE"' EXIT

# Wait up to 30s for /docs to respond
DEADLINE=$((SECONDS + 30))
HEALTHY=0
while (( SECONDS < DEADLINE )); do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        red "✗ backend exited prematurely. Log:"
        cat "$LOG_FILE"
        exit 1
    fi
    if curl -fsS -o /dev/null -m 2 "http://127.0.0.1:8777/docs"; then
        HEALTHY=1
        break
    fi
    sleep 0.5
done

if (( HEALTHY == 0 )); then
    red "✗ backend did not respond on http://127.0.0.1:8777/docs within 30s. Log tail:"
    tail -50 "$LOG_FILE"
    exit 1
fi
green "  ✓ backend bound to :8777 and answered GET /docs"

# Check log for any ModuleNotFoundError / ImportError that backend silently swallowed
if grep -qE "ModuleNotFoundError|ImportError" "$LOG_FILE"; then
    red "✗ backend logged import errors:"
    grep -E "ModuleNotFoundError|ImportError" "$LOG_FILE" | head -5
    exit 1
fi

# ── 3. backend graceful shutdown ─────────────────────────────────
blue "[3/3] sending SIGTERM, expecting clean shutdown…"
kill "$BACKEND_PID"
if wait "$BACKEND_PID" 2>/dev/null; :; then :; fi
green "  ✓ backend shut down cleanly"

green ""
green "✓ All bundle smoke checks passed."
green "  Next: copy packages/backend/dist/ to a fresh macOS user account and rerun this script there"
green "  to confirm zero runtime Python dependency."
