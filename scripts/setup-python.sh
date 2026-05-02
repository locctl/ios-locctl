#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
VENV_DIR="$ROOT_DIR/.venv"
REQ_FILE="$ROOT_DIR/packages/backend/requirements.txt"
REQ_BUILD_FILE="$ROOT_DIR/packages/backend/requirements-build.txt"

if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$REQ_FILE"
# Build-only deps (PyInstaller) — needed for `pnpm build:be`.
[ -f "$REQ_BUILD_FILE" ] && "$VENV_DIR/bin/pip" install -r "$REQ_BUILD_FILE"
