from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import asyncio
import json
import logging
from pathlib import Path

from core.device_manager import _resolve_sidecar_command
from models.schemas import DeviceInfo

router = APIRouter(prefix="/api/device", tags=["device"])
logger = logging.getLogger(__name__)


async def _run_sidecar_json(*args: str) -> dict:
    sidecar_cmd, env = _resolve_sidecar_command()
    proc = await asyncio.create_subprocess_exec(
        "sudo",
        "-A",
        "--preserve-env=HOME,SUDO_ASKPASS",
        *sidecar_cmd,
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


# ── Setup wizard endpoints (Phase E) ────────────────────────────
# These are deliberately ergonomic for first-time setup flow:
# they tolerate "no device", report structured error codes the wizard
# UI can branch on, and don't require a fully connected SimulationEngine.

@router.post("/trigger-dev-mode-toggle")
async def trigger_dev_mode_toggle():
    """Make iOS surface the Developer Mode toggle in
    Settings → Privacy & Security. Without this call, the toggle stays
    hidden on devices that have never been touched by Xcode or any
    pymobiledevice3 dev tool.

    Uses AmfiService.reveal_developer_mode_option_in_ui() — the official
    pymobiledevice3 API for exactly this case (sends a DEVELOPER_MODE_REVEAL
    plist that creates an empty file at AMFIShowOverridePath, which iOS
    reads to decide whether to render the toggle).
    """
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.usbmux import list_devices as mux_list_devices

    try:
        raw_devices = await mux_list_devices()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "usbmux_unavailable",
                    "message": f"無法列出 USB 裝置: {e}"},
        )

    usb_dev = next(
        (d for d in raw_devices if getattr(d, "connection_type", "USB") == "USB"),
        None,
    )
    if usb_dev is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "trigger_needs_usb",
                "message": "請先用 USB 線連接裝置並按「信任這台電腦」。",
            },
        )

    udid = usb_dev.serial
    logger.info("dev-mode toggle reveal requested for %s", udid)

    try:
        lockdown = await create_using_usbmux(serial=udid, autopair=True)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "code": "trust_failed",
                "message": f"USB 信任失敗 — 請在裝置解鎖畫面上按「信任」: {e}",
                "udid": udid,
            },
        )

    try:
        from pymobiledevice3.services.amfi import AmfiService
        amfi = AmfiService(lockdown)
        await amfi.reveal_developer_mode_option_in_ui()
    except Exception as exc:
        logger.exception("reveal_developer_mode_option_in_ui failed for %s", udid)
        raise HTTPException(
            status_code=500,
            detail={"code": "reveal_failed",
                    "message": f"無法準備 Developer Mode 選項: {exc}",
                    "udid": udid},
        )

    return {
        "status": "revealed",
        "udid": udid,
        "next_step": (
            "請到手機 設定 → 隱私權與安全性 → 開發者模式 開啟 toggle，"
            "然後重新開機。如果還是看不到 toggle,請走『清密碼自動開啟』流程。"
        ),
    }


@router.post("/enable-dev-mode")
async def enable_dev_mode():
    """Enable Developer Mode automatically via AmfiService. Requires the
    device to have NO passcode set (Apple constraint). If a passcode is
    set, returns 400 with code='passcode_set' so the wizard can prompt
    the user to remove it first.
    """
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.usbmux import list_devices as mux_list_devices

    try:
        raw_devices = await mux_list_devices()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "usbmux_unavailable",
                    "message": f"無法列出 USB 裝置: {e}"},
        )

    usb_dev = next(
        (d for d in raw_devices if getattr(d, "connection_type", "USB") == "USB"),
        None,
    )
    if usb_dev is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "needs_usb",
                    "message": "請先用 USB 線連接裝置。"},
        )

    udid = usb_dev.serial
    try:
        lockdown = await create_using_usbmux(serial=udid, autopair=True)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "trust_failed",
                    "message": f"USB 信任失敗: {e}",
                    "udid": udid},
        )

    try:
        from pymobiledevice3.services.amfi import AmfiService
        try:
            from pymobiledevice3.services.amfi import DeviceHasPasscodeSetError  # type: ignore
        except ImportError:
            DeviceHasPasscodeSetError = None  # type: ignore

        amfi = AmfiService(lockdown)
        # enable_post_restart=False: send only the initial prompt and return
        # immediately. The default (True) blocks until the device finishes
        # rebooting and answers a second post-restart prompt server-side,
        # which makes the wizard feel hung from the user's perspective.
        # The UI flow expects the user to tap "Turn On" on the iPhone
        # themselves and then click 我已重開 once the phone is back.
        await amfi.enable_developer_mode(enable_post_restart=False)
        return {
            "status": "enabled",
            "udid": udid,
            "next_step": "請到裝置上點「Turn On」並重新開機。重開後可以把密碼設回去。",
        }
    except Exception as e:
        msg = str(e)
        is_passcode_error = (
            (DeviceHasPasscodeSetError is not None and isinstance(e, DeviceHasPasscodeSetError))
            or "passcode" in msg.lower()
        )
        if is_passcode_error:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "passcode_set",
                    "message": "裝置仍有密碼。請先到 設定 → Face ID 與密碼 → 關閉密碼，然後重試。",
                    "udid": udid,
                },
            )
        logger.exception("enable_developer_mode failed for %s", udid)
        raise HTTPException(
            status_code=500,
            detail={"code": "enable_failed",
                    "message": f"無法自動開啟開發者模式: {e}",
                    "udid": udid},
        )


@router.post("/mount-ddi")
async def mount_ddi():
    """Attempt to auto-mount the Personalized DDI on the connected USB device.
    Wraps pymobiledevice3.services.mobile_image_mounter.auto_mount_personalized
    with a generous timeout so a slow GitHub download doesn't hang the wizard.
    """
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.usbmux import list_devices as mux_list_devices

    try:
        raw_devices = await mux_list_devices()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "usbmux_unavailable",
                    "message": f"無法列出 USB 裝置: {e}"},
        )

    usb_dev = next(
        (d for d in raw_devices if getattr(d, "connection_type", "USB") == "USB"),
        None,
    )
    if usb_dev is None:
        raise HTTPException(
            status_code=400,
            detail={"code": "needs_usb",
                    "message": "請先用 USB 線連接裝置。"},
        )

    udid = usb_dev.serial
    try:
        lockdown = await create_using_usbmux(serial=udid, autopair=True)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "trust_failed",
                    "message": f"USB 信任失敗: {e}",
                    "udid": udid},
        )

    try:
        from pymobiledevice3.services.mobile_image_mounter import (
            MobileImageMounterService,
            auto_mount_personalized,
            AlreadyMountedError,
        )
    except ImportError as e:
        raise HTTPException(
            status_code=500,
            detail={"code": "module_unavailable",
                    "message": f"pymobiledevice3 mobile_image_mounter 不可用: {e}"},
        )

    # First check if already mounted — fast path
    try:
        mounter = MobileImageMounterService(lockdown=lockdown)
        try:
            await mounter.connect()
            if await mounter.is_image_mounted("Personalized"):
                return {"status": "already_mounted", "udid": udid}
        finally:
            try:
                await mounter.close()
            except Exception:
                pass
    except Exception:
        logger.debug("DDI mount-status query failed; will try mount anyway", exc_info=True)

    try:
        await asyncio.wait_for(auto_mount_personalized(lockdown), timeout=120.0)
        return {"status": "mounted", "udid": udid}
    except AlreadyMountedError:
        return {"status": "already_mounted", "udid": udid}
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail={"code": "mount_timeout",
                    "message": "DDI 下載超過 120 秒。請確認可以連到 github.com。",
                    "udid": udid},
        )
    except Exception as e:
        logger.exception("auto_mount_personalized failed for %s", udid)
        raise HTTPException(
            status_code=500,
            detail={"code": "mount_failed",
                    "message": f"DDI 掛載失敗: {e}",
                    "udid": udid},
        )
