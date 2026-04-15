from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

from config import PROJECT_ROOT
from models.schemas import DeviceInfo

router = APIRouter(prefix="/api/device", tags=["device"])
logger = logging.getLogger(__name__)


async def _run_sidecar_json(*args: str) -> dict:
    user_home = str(Path.home())
    env = {
        **os.environ,
        "SUDO_ASKPASS": str(PROJECT_ROOT / "scripts" / "askpass.sh"),
        "HOME": user_home,
    }
    proc = await asyncio.create_subprocess_exec(
        "sudo",
        "-A",
        "--preserve-env=HOME,SUDO_ASKPASS",
        sys.executable,
        str(PROJECT_ROOT / "packages" / "backend" / "tunnel_sidecar.py"),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    stdout, stderr = await proc.communicate()
    if not stdout:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or f"sidecar exited with {proc.returncode}")
    payload = json.loads(stdout.decode("utf-8").splitlines()[0])
    if proc.returncode != 0 or payload.get("status") == "error":
        raise RuntimeError(payload.get("message", "unknown sidecar error"))
    return payload


def _dm():
    from main import app_state
    return app_state.device_manager


@router.get("/list", response_model=list[DeviceInfo])
async def list_devices():
    """List all discoverable devices (USB + WiFi via mDNS)."""
    dm = _dm()
    return await dm.discover_devices()


@router.post("/wifi/repair")
async def wifi_repair():
    """
    Regenerate RemotePairing pair record via USB.

    Requires USB connection. iPhone will show 'Trust This Computer' prompt.
    After trust, remote_*.plist is regenerated for WiFi use.
    """
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.usbmux import list_devices as mux_list_devices
    # Must have USB device
    try:
        raw_devices = await mux_list_devices()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "usbmux_unavailable", "message": f"無法列出 USB 裝置:{e}"},
        )

    usb_dev = next((d for d in raw_devices if getattr(d, "connection_type", "USB") == "USB"), None)
    if usb_dev is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "repair_needs_usb",
                "message": "請先用 USB 線連接裝置。重新配對需要 USB 觸發『信任這台電腦』提示。",
            },
        )

    udid = usb_dev.serial
    logger.info("Re-pair requested for USB device %s", udid)

    # Step 1: USB lockdown autopair
    try:
        lockdown = await create_using_usbmux(serial=udid, autopair=True)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "code": "trust_failed",
                "message": f"USB 信任失敗 — 請在裝置解鎖畫面上點「信任」後再試:{e}",
                "udid": udid,
            },
        )

    ios_version = lockdown.all_values.get("ProductVersion", "0.0")
    name = lockdown.all_values.get("DeviceName", "Device")

    # Step 2: iOS 17+ - open tunnel briefly to trigger RemotePairing record generation
    remote_record_regenerated = False
    try:
        major = int(ios_version.split(".")[0])
    except (ValueError, IndexError):
        major = 0

    if major >= 17:
        # Delete stale remote pair record
        try:
            from pymobiledevice3.common import get_home_folder
            from pymobiledevice3.pair_records import (
                PAIRING_RECORD_EXT,
                get_remote_pairing_record_filename,
            )
            stale = get_home_folder() / f"{get_remote_pairing_record_filename(udid)}.{PAIRING_RECORD_EXT}"
            if stale.exists():
                stale.unlink()
                logger.info("Re-pair: removed stale remote pair record %s", stale)
        except Exception:
            logger.debug("Re-pair: could not check/remove stale pair record", exc_info=True)

        try:
            logger.info("Re-pair: opening CoreDeviceTunnelService via privileged helper...")
            await _run_sidecar_json("repair", "--udid", udid)
            logger.info("Re-pair: RemotePairing record written for %s", udid)
            remote_record_regenerated = True
        except Exception as e:
            logger.exception("Re-pair: RemotePairing handshake failed")
            msg = str(e)
            if "PairingDialogResponsePending" in msg or "consent" in msg.lower():
                friendly = "請在裝置解鎖螢幕上按「信任」後重試(timeout 只有幾秒)。"
            elif "not paired" in msg.lower() or "pairingerror" in msg.lower():
                friendly = "USB 配對失效,請拔 USB 重插一次並按信任。"
            else:
                friendly = f"RemotePairing 握手失敗:{msg}"
            raise HTTPException(
                status_code=500,
                detail={
                    "code": "remote_pair_failed",
                    "message": friendly,
                    "udid": udid,
                    "ios_version": ios_version,
                },
            )

    return {
        "status": "paired",
        "udid": udid,
        "name": name,
        "ios_version": ios_version,
        "remote_record_regenerated": remote_record_regenerated,
    }


# ── Device connection ─────────────────────────────────────────────

class ConnectRequest(BaseModel):
    wifi_ip: str | None = None


@router.post("/{udid}/connect")
async def connect_device(udid: str, req: ConnectRequest | None = None):
    """
    Connect to device via USB or WiFi.

    - If wifi_ip provided: connect via RemotePairing WiFi
    - Otherwise: auto-detect (WiFi if available, else USB)
    """
    from main import app_state
    from core.device_manager import UnsupportedIosVersionError
    dm = _dm()
    wifi_ip = req.wifi_ip if req else None
    try:
        await dm.connect(udid, wifi_ip=wifi_ip)
        await app_state.create_engine_for_device(udid)
        return {"status": "connected", "udid": udid}
    except UnsupportedIosVersionError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "ios_unsupported",
                "message": (
                    f"偵測到 iOS {e.version},ios-locctl 僅支援 "
                    f"iOS 17 以上。請將裝置升級後再連線。"
                ),
                "ios_version": e.version,
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{udid}/connect")
async def disconnect_device(udid: str):
    """Disconnect device and stop simulation."""
    dm = _dm()
    await dm.disconnect(udid)
    return {"status": "disconnected", "udid": udid}


@router.get("/{udid}/info", response_model=DeviceInfo | None)
async def device_info(udid: str):
    """Get device information."""
    dm = _dm()
    devices = await dm.discover_devices()
    for d in devices:
        if d.udid == udid:
            return d
    raise HTTPException(status_code=404, detail="Device not found")
