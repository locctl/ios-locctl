#!/bin/bash
# Development startup script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
BACKEND_DIR="$ROOT_DIR/packages/backend"
VENV_PYTHON="$ROOT_DIR/.venv/bin/python"

if [ ! -x "$VENV_PYTHON" ]; then
    echo "Error: Python virtualenv not found. Run 'pnpm run bootstrap' first."
    exit 1
fi

# 1. 先問密碼（會在終端提示）
echo "Backend 需要管理員權限來建立 iOS tunnel"
sudo -v || exit 1

# 2. 啟動 frontend（背景）
cd "$ROOT_DIR"
pnpm dev:fe &

# 3. 啟動 backend（前景，用 sudo）
cd "$BACKEND_DIR"
sudo "$VENV_PYTHON" main.py
