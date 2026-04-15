from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from contextlib import suppress

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.tunnel_service import (
    CoreDeviceTunnelProxy,
    create_core_device_tunnel_service_using_remotepairing,
    create_core_device_tunnel_service_using_rsd,
)


logging.basicConfig(level=logging.INFO, format="%(asctime)s [sidecar] %(levelname)s: %(message)s")
logger = logging.getLogger("ios-locctl.sidecar")


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def _wait_for_stop() -> None:
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if line == "":
            return
        if line.strip().lower() in {"stop", "exit", "quit"}:
            return


async def _run_usb_tunnel(udid: str) -> None:
    lockdown = await create_using_usbmux(serial=udid)
    proxy = None
    tunnel_ctx = None
    rsd = None
    try:
        proxy = await CoreDeviceTunnelProxy.create(lockdown)
        tunnel_ctx = proxy.start_tcp_tunnel()
        tunnel = await tunnel_ctx.__aenter__()
        rsd = RemoteServiceDiscoveryService((tunnel.address, tunnel.port))
        await rsd.connect()
        _emit({"status": "ready", "address": tunnel.address, "port": tunnel.port})
        await _wait_for_stop()
    finally:
        if rsd is not None:
            with suppress(Exception):
                await rsd.close()
        if tunnel_ctx is not None:
            with suppress(Exception):
                await tunnel_ctx.__aexit__(None, None, None)
        if proxy is not None:
            with suppress(Exception):
                proxy.close()


async def _run_wifi_tunnel(udid: str, ip: str, port: int) -> None:
    service = await create_core_device_tunnel_service_using_remotepairing(udid, ip, port)
    tunnel_ctx = None
    rsd = None
    try:
        tunnel_ctx = service.start_tcp_tunnel()
        tunnel = await tunnel_ctx.__aenter__()
        rsd = RemoteServiceDiscoveryService((tunnel.address, tunnel.port))
        await rsd.connect()
        _emit({"status": "ready", "address": tunnel.address, "port": tunnel.port})
        await _wait_for_stop()
    finally:
        if rsd is not None:
            with suppress(Exception):
                await rsd.close()
        if tunnel_ctx is not None:
            with suppress(Exception):
                await tunnel_ctx.__aexit__(None, None, None)
        with suppress(Exception):
            close = getattr(service, "close", None)
            if close is not None:
                result = close()
                if hasattr(result, "__await__"):
                    await result


async def _run_repair(udid: str) -> None:
    lockdown = await create_using_usbmux(serial=udid, autopair=True)

    try:
        from pymobiledevice3.common import get_home_folder
        from pymobiledevice3.pair_records import (
            PAIRING_RECORD_EXT,
            get_remote_pairing_record_filename,
        )

        stale = get_home_folder() / f"{get_remote_pairing_record_filename(udid)}.{PAIRING_RECORD_EXT}"
        if stale.exists():
            stale.unlink()
    except Exception:
        logger.debug("Failed to remove stale remote pair record", exc_info=True)

    proxy = None
    tunnel_ctx = None
    rsd = None
    tunnel_svc = None
    try:
        proxy = await CoreDeviceTunnelProxy.create(lockdown)
        tunnel_ctx = proxy.start_tcp_tunnel()
        tunnel = await tunnel_ctx.__aenter__()
        rsd = RemoteServiceDiscoveryService((tunnel.address, tunnel.port))
        await rsd.connect()
        tunnel_svc = await create_core_device_tunnel_service_using_rsd(rsd, autopair=True)
        _emit({"status": "paired"})
    finally:
        for closer in (
            lambda: tunnel_svc and tunnel_svc.close(),
            lambda: rsd and rsd.close(),
            lambda: tunnel_ctx and tunnel_ctx.__aexit__(None, None, None),
        ):
            try:
                result = closer()
                if hasattr(result, "__await__"):
                    await result
            except Exception:
                pass
        if proxy is not None:
            with suppress(Exception):
                proxy.close()


async def _amain() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    usb = sub.add_parser("usb")
    usb.add_argument("--udid", required=True)

    wifi = sub.add_parser("wifi")
    wifi.add_argument("--udid", required=True)
    wifi.add_argument("--ip", required=True)
    wifi.add_argument("--port", type=int, default=49152)

    repair = sub.add_parser("repair")
    repair.add_argument("--udid", required=True)

    args = parser.parse_args()

    try:
        if args.command == "usb":
            await _run_usb_tunnel(args.udid)
        elif args.command == "wifi":
            await _run_wifi_tunnel(args.udid, args.ip, args.port)
        else:
            await _run_repair(args.udid)
        return 0
    except Exception as exc:
        logger.exception("sidecar command failed")
        _emit({"status": "error", "message": f"{exc.__class__.__name__}: {exc}"})
        return 1


def main() -> None:
    raise SystemExit(asyncio.run(_amain()))


if __name__ == "__main__":
    main()
