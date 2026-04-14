"""
ios-locctl WiFi Tunnel

Establishes a persistent WiFi tunnel to an iOS device using
pymobiledevice3's RemotePairing protocol.  Once the tunnel is running,
USB can be disconnected and ios-locctl can control the device's GPS
location over WiFi.

Prerequisites:
  - Python 3.13+ (native TLS-PSK support required)
  - Device must have been paired via USB first (remote pair record
    must exist in ~/.pymobiledevice3/)
  - Device must be on the same WiFi network
  - Must run with sudo (tunnel creates a TUN interface)

Usage:
  python3.13 wifi_tunnel.py [--ip IP] [--port PORT]

The script prints the RSD address and port, which ios-locctl uses to
connect to the device's developer services.
"""

import argparse
import asyncio
import json
import logging
import signal
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Default device settings
DEFAULT_UDID = None  # caller must supply or auto-detect
DEFAULT_IP = ""
DEFAULT_REMOTEPAIRING_PORT = 49152


async def run_tunnel(udid: str, ip: str, port: int) -> None:
    from pymobiledevice3.remote.tunnel_service import (
        create_core_device_tunnel_service_using_remotepairing,
    )

    logger.info("Connecting to RemotePairing service at %s:%d ...", ip, port)
    service = await create_core_device_tunnel_service_using_remotepairing(udid, ip, port)
    logger.info("RemotePairing connected (identifier: %s)", service.remote_identifier)

    logger.info("Starting TCP tunnel ...")
    async with service.start_tcp_tunnel() as tunnel:
        info = {
            "rsd_address": tunnel.address,
            "rsd_port": tunnel.port,
            "interface": tunnel.interface,
            "protocol": str(tunnel.protocol),
        }
        logger.info(
            "WiFi tunnel established!\n"
            "  RSD Address : %s\n"
            "  RSD Port    : %d\n"
            "  Interface   : %s",
            tunnel.address,
            tunnel.port,
            tunnel.interface,
        )

        # Write tunnel info to a file so ios-locctl can read it.
        info_dir = Path.home() / ".ios-locctl"
        info_dir.mkdir(exist_ok=True)
        info_path = info_dir / "wifi_tunnel_info.json"
        with open(info_path, "w") as f:
            json.dump(info, f, indent=2)
        logger.info("Tunnel info written to %s", info_path)

        print(flush=True)
        print("=" * 50, flush=True)
        print("  WiFi tunnel is active.", flush=True)
        print("  USB cable can be safely disconnected.", flush=True)
        print("  Press Ctrl+C to stop the tunnel.", flush=True)
        print("=" * 50, flush=True)
        print(flush=True)

        # Keep the tunnel alive
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()

        def _signal_handler():
            stop.set()

        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _signal_handler)

        try:
            await stop.wait()
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass

        logger.info("Shutting down tunnel ...")

    logger.info("Tunnel closed.")


def main() -> None:
    parser = argparse.ArgumentParser(description="ios-locctl WiFi Tunnel")
    parser.add_argument("--udid", default=DEFAULT_UDID, help="Device UDID (auto-detected when omitted)")
    parser.add_argument("--ip", default=DEFAULT_IP, help="Device WiFi IP address (required)")
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_REMOTEPAIRING_PORT,
        help="RemotePairing service port",
    )
    args = parser.parse_args()

    if not args.udid:
        # Try to auto-detect from a currently attached USB device
        try:
            from pymobiledevice3.usbmux import list_devices
            devs = list_devices()
            if devs:
                args.udid = devs[0].serial
        except Exception:
            pass
        if not args.udid:
            args.udid = "auto"  # harmless placeholder; WiFi path does not need exact match

    if not args.ip:
        print("ERROR: --ip is required", file=sys.stderr)
        sys.exit(2)

    if sys.version_info < (3, 13):
        print(
            "ERROR: Python 3.13+ is required for WiFi tunnel (native TLS-PSK support).",
            file=sys.stderr,
        )
        print(f"Current version: {sys.version}", file=sys.stderr)
        sys.exit(1)

    asyncio.run(run_tunnel(args.udid, args.ip, args.port))


if __name__ == "__main__":
    main()
