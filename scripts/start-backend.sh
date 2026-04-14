#!/bin/bash
# Start backend with sudo (iOS 17+ requires root for TUN interface)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../packages/backend"
PYTHON3_PATH="$(which python3)"

# Already root? Just run backend
if [ "$EUID" -eq 0 ]; then
    cd "$BACKEND_DIR"
    exec "$PYTHON3_PATH" main.py
fi

# Need sudo - should already be cached by dev-with-sudo.sh
# If not cached, this will fail (user should run pnpm dev which handles auth)
if sudo -n true 2>/dev/null; then
    cd "$BACKEND_DIR"
    exec sudo "$PYTHON3_PATH" main.py
else
    echo "Error: sudo not authorized. Run 'pnpm dev' instead of 'pnpm dev:be'"
    exit 1
fi
