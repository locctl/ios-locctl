"""System utility endpoints — open files / folders for the user."""

import logging
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/system", tags=["system"])

logger = logging.getLogger(__name__)


def _open_native(path: Path) -> None:
    """Open a file or folder with the OS default application (macOS only)."""
    subprocess.Popen(["open", str(path)])


@router.post("/open-log")
async def open_log():
    """Open backend.log in the OS default text editor so the user can copy
    it for bug reports. Falls back to opening the log folder if the file
    is missing."""
    log_dir = Path.home() / ".ios-locctl" / "logs"
    log_file = log_dir / "backend.log"
    target = log_file if log_file.exists() else log_dir
    if not target.exists():
        log_dir.mkdir(parents=True, exist_ok=True)
        target = log_dir
    try:
        _open_native(target)
    except Exception as exc:
        logger.exception("Failed to open log path %s", target)
        raise HTTPException(status_code=500, detail={"code": "open_log_failed",
                                                     "message": f"無法開啟 log:{exc}"})
    return {"status": "opened", "path": str(target)}


@router.post("/open-log-folder")
async def open_log_folder():
    """Open the ~/.ios-locctl/logs folder in the file manager."""
    log_dir = Path.home() / ".ios-locctl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    try:
        _open_native(log_dir)
    except Exception as exc:
        logger.exception("Failed to open log folder %s", log_dir)
        raise HTTPException(status_code=500, detail={"code": "open_log_failed",
                                                     "message": f"無法開啟資料夾:{exc}"})
    return {"status": "opened", "path": str(log_dir)}
