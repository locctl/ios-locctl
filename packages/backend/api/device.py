from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import logging

from models.schemas import DeviceInfo

router = APIRouter(prefix="/api/device", tags=["device"])
logger = logging.getLogger(__name__)


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
    from pymobiledevice3.remote.tunnel_service import (
        CoreDeviceTunnelProxy,
        create_core_device_tunnel_service_using_rsd,
    )
    from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
    from pathlib import Path

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

        proxy = None
        tunnel_ctx = None
        rsd = None
        tunnel_svc = None
        try:
            # Open CoreDeviceTunnelProxy tunnel over USB
            proxy = await CoreDeviceTunnelProxy.create(lockdown)
            tunnel_ctx = proxy.start_tcp_tunnel()
            tunnel_result = await tunnel_ctx.__aenter__()

            # Construct RSD on the tunnel
            rsd = RemoteServiceDiscoveryService((tunnel_result.address, tunnel_result.port))
            await rsd.connect()

            # Trigger Trust prompt and save RemotePairing record
            logger.info("Re-pair: opening CoreDeviceTunnelService — Trust prompt should appear...")
            tunnel_svc = await create_core_device_tunnel_service_using_rsd(rsd, autopair=True)
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
        finally:
            # Cleanup in reverse order
            for closer in (
                lambda: tunnel_svc and tunnel_svc.close(),
                lambda: rsd and rsd.close(),
                lambda: tunnel_ctx and tunnel_ctx.__aexit__(None, None, None),
            ):
                try:
                    r = closer()
                    if hasattr(r, "__await__"):
                        await r
                except Exception:
                    pass
            try:
                if proxy is not None:
                    proxy.close()
            except Exception:
                pass

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
