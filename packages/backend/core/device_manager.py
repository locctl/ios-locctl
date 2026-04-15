"""
ios-locctl Device Manager

Handles iOS device detection, connection lifecycle, tunnel establishment,
and location service creation.  Wraps pymobiledevice3 internals so the
rest of the application never touches low-level device APIs directly.

Supports both USB and WiFi connections.  ``list_devices()`` from usbmuxd
returns devices with ``connection_type`` of ``"USB"`` or ``"Network"``.
WiFi requires the device to be paired and on the same local network.

For iOS 17+, a TCP tunnel via CoreDeviceTunnelProxy is established first,
then a RemoteServiceDiscoveryService (RSD) is created over the tunnel to
access DVT services.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import sys
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

from pymobiledevice3.lockdown import create_using_usbmux, create_using_tcp
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.tunnel_service import CoreDeviceTunnelProxy
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.simulate_location import DtSimulateLocation
from pymobiledevice3.usbmux import list_devices

from config import PROJECT_ROOT
from models.schemas import DeviceInfo
from services.location_service import (
    DvtLocationService,
    LegacyLocationService,
    LocationService,
)


class UnsupportedIosVersionError(RuntimeError):
    """Raised when a connecting device's iOS version is below the minimum
    supported by ios-locctl (currently 17.0). Surfaces a structured error to
    the API layer so the frontend can show an actionable message rather
    than a stack trace."""

    MIN_VERSION = "17.0"

    def __init__(self, version: str) -> None:
        self.version = version
        super().__init__(f"iOS {version} is not supported (requires {self.MIN_VERSION}+)")

logger = logging.getLogger(__name__)


def _parse_ios_version(version_string: str) -> tuple[int, ...]:
    """Convert an iOS version string like '17.4.1' into a comparable tuple."""
    try:
        return tuple(int(p) for p in version_string.split("."))
    except (ValueError, AttributeError):
        logger.warning("Unable to parse iOS version '%s', assuming 0.0", version_string)
        return (0, 0)


@dataclass
class _ActiveConnection:
    """Internal bookkeeping for a single connected device."""
    udid: str
    lockdown: object  # LockdownClient or RemoteServiceDiscoveryService
    ios_version: str
    device_name: str = "Unknown"
    connection_type: str = "USB"  # "USB" or "Network"
    dvt_provider: Optional[DvtProvider] = None
    tunnel_proxy: Optional[CoreDeviceTunnelProxy] = None
    tunnel_context: object = None  # async context manager for the tunnel
    rsd: Optional[RemoteServiceDiscoveryService] = None
    location_service: Optional[LocationService] = None
    usbmux_lockdown: object = None  # Original lockdown client (for legacy fallback on iOS 17+)
    tunnel_process: asyncio.subprocess.Process | None = None


class DeviceManager:
    """
    Manages the full lifecycle of iOS device connections.

    Usage::

        dm = DeviceManager()
        devices = await dm.discover_devices()
        await dm.connect(devices[0].udid)
        loc = await dm.get_location_service(devices[0].udid)
        await loc.set(37.7749, -122.4194)
        await dm.disconnect(devices[0].udid)
    """

    def __init__(self) -> None:
        self._connections: Dict[str, _ActiveConnection] = {}
        self._wifi_ips: Dict[str, str] = {}  # udid -> wifi_ip cache from last scan
        self._lock = asyncio.Lock()

    async def _log_sidecar_stderr(self, proc: asyncio.subprocess.Process, udid: str) -> None:
        if proc.stderr is None:
            return
        while True:
            line = await proc.stderr.readline()
            if not line:
                return
            logger.warning("tunnel sidecar[%s]: %s", udid, line.decode(errors="replace").rstrip())

    async def _spawn_tunnel_sidecar(self, args: list[str], udid: str) -> tuple[asyncio.subprocess.Process, dict]:
        askpass = PROJECT_ROOT / "scripts" / "askpass.sh"
        user_home = str(Path.home())
        env = {
            **os.environ,
            "SUDO_ASKPASS": str(askpass),
            "HOME": user_home,
        }
        proc = await asyncio.create_subprocess_exec(
            "sudo",
            "-A",
            "--preserve-env=HOME,SUDO_ASKPASS",
            sys.executable,
            str(PROJECT_ROOT / "packages" / "backend" / "tunnel_sidecar.py"),
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        if proc.stdout is None:
            raise RuntimeError("Tunnel sidecar stdout unavailable")
        line = await proc.stdout.readline()
        if not line:
            rc = await proc.wait()
            detail = ""
            if proc.stderr is not None:
                detail = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
            raise RuntimeError(detail or f"無法啟動管理員 tunnel helper (exit {rc})")
        payload = json.loads(line.decode("utf-8"))
        if payload.get("status") != "ready":
            if proc.stdin is not None:
                proc.stdin.close()
            await proc.wait()
            raise RuntimeError(
                "無法建立裝置通道。請確認已允許管理員權限，且裝置已解鎖並信任這台電腦。"
                f" 詳細錯誤: {payload.get('message', 'unknown error')}"
            )
        asyncio.create_task(self._log_sidecar_stderr(proc, udid))
        return proc, payload

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    async def discover_devices(self, scan_wifi: bool = True) -> list[DeviceInfo]:
        """
        Scan for all iOS devices visible over USB and WiFi.

        - USB devices: via usbmux list
        - WiFi devices: via mDNS (Bonjour) RemotePairing scan (if scan_wifi=True)
        - Already connected: from _connections cache

        Returns a list of ``DeviceInfo`` objects with basic identification
        data.  This does **not** establish a persistent connection.
        """
        devices: list[DeviceInfo] = []
        seen_udids: set[str] = set()

        # Scan USB devices via usbmux
        try:
            raw_devices = await list_devices()
        except Exception:
            logger.exception("Failed to list usbmux devices")
            raw_devices = []

        for raw in raw_devices:
            try:
                conn_type = getattr(raw, "connection_type", "USB")
                # If we already saw this device via USB, skip the Network duplicate
                if raw.serial in seen_udids:
                    # But upgrade to USB if this entry is USB (prefer USB info)
                    if conn_type == "USB":
                        for d in devices:
                            if d.udid == raw.serial:
                                d.connection_type = "USB"
                    continue
                seen_udids.add(raw.serial)

                lockdown = await create_using_usbmux(serial=raw.serial)
                all_values = lockdown.all_values
                # If device is already connected, report the active connection type
                active_conn = self._connections.get(raw.serial)
                if active_conn:
                    conn_type = active_conn.connection_type
                info = DeviceInfo(
                    udid=raw.serial,
                    name=all_values.get("DeviceName", "Unknown"),
                    ios_version=all_values.get("ProductVersion", "0.0"),
                    connection_type=conn_type,
                )
                info.is_connected = raw.serial in self._connections
                devices.append(info)
                logger.debug("Discovered device %s (%s) running iOS %s via %s (connected=%s)",
                             info.name, info.udid, info.ios_version, conn_type, info.is_connected)
            except Exception:
                logger.exception("Failed to query device %s", getattr(raw, "serial", "?"))

        # Scan WiFi devices via mDNS (Bonjour) if requested
        if scan_wifi:
            try:
                from pymobiledevice3.bonjour import browse_remotepairing
                from pathlib import Path
                import plistlib

                # Find all known RemotePairing UDIDs from saved records
                pair_records = list(Path.home().glob(".pymobiledevice3/remote_*.plist"))
                known_udids = {p.stem.replace("remote_", "") for p in pair_records}

                # Scan mDNS for RemotePairing devices (timeout 2s to avoid blocking)
                mdns_devices = await browse_remotepairing(timeout=2.0)

                for svc in mdns_devices:
                    # Extract IPv4 address
                    ip = None
                    for addr in svc.addresses:
                        if '.' in addr.ip and not addr.ip.startswith('127.'):
                            ip = addr.ip
                            break

                    if not ip:
                        continue

                    # Try each known UDID (can't determine UDID from mDNS alone)
                    # In practice, there's usually only 1-2 paired devices
                    for udid in known_udids:
                        if udid in seen_udids:
                            continue

                        # Cache WiFi IP for connect()
                        self._wifi_ips[udid] = ip

                        # Mark as WiFi-available (will show in UI)
                        info = DeviceInfo(
                            udid=udid,
                            name=svc.host.replace('.local.', '').split('.')[0],
                            ios_version="Unknown",
                            connection_type="WiFi",
                            is_connected=udid in self._connections,
                            wifi_ip=ip,
                        )
                        devices.append(info)
                        seen_udids.add(udid)
                        logger.debug("Found WiFi device: %s at %s (UDID: %s)", svc.host, ip, udid)
                        break  # One mDNS entry per known UDID

            except Exception:
                logger.debug("WiFi scan failed (normal if no WiFi devices)", exc_info=True)

        # Also include devices connected via tunnel but not visible in either scan
        for udid, conn in self._connections.items():
            if udid not in seen_udids:
                info = DeviceInfo(
                    udid=udid,
                    name=conn.device_name or "Unknown Device",
                    ios_version=conn.ios_version or "0.0",
                    connection_type=conn.connection_type,
                    is_connected=True,
                )
                devices.append(info)
                logger.debug("Added active connection not in scan: %s (%s)", info.name, udid)

        return devices

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    async def connect(self, udid: str, wifi_ip: str | None = None) -> None:
        """
        Establish a connection to device via USB or WiFi.

        Auto-detects connection method:
        - If wifi_ip provided or device only visible via WiFi → RemotePairing
        - If device visible via USB → CoreDeviceTunnelProxy
        """
        async with self._lock:
            if udid in self._connections:
                logger.info("Device %s is already connected", udid)
                return

        # USB path first: try usbmux, fall back to WiFi
        # Only use WiFi if explicitly requested or USB unavailable
        usb_available = False
        if not wifi_ip:
            try:
                raw_devices = await list_devices()
                usb_available = any(raw.serial == udid for raw in raw_devices)
            except Exception:
                pass

        # Auto-detect WiFi IP only if USB not available
        if not wifi_ip and not usb_available:
            wifi_ip = self._wifi_ips.get(udid)
            if not wifi_ip:
                await self.discover_devices(scan_wifi=True)
                wifi_ip = self._wifi_ips.get(udid)
            if wifi_ip:
                logger.debug("USB unavailable, using WiFi IP for %s: %s", udid, wifi_ip)

        # WiFi path: RemotePairing tunnel
        if wifi_ip and not usb_available:
            logger.info("Connecting to %s via WiFi (%s)", udid, wifi_ip)
            conn = await self._connect_wifi_remotepairing(udid, wifi_ip)
            async with self._lock:
                self._connections[udid] = conn
            logger.info("Connected to %s (iOS %s) via WiFi", udid, conn.ios_version)
            return

        # USB path: CoreDeviceTunnelProxy + RSD (original logic)
        connection_type = "USB"
        try:
            raw_devices = await list_devices()
            for raw in raw_devices:
                if raw.serial == udid:
                    connection_type = getattr(raw, "connection_type", "USB")
                    if connection_type == "USB":
                        break
        except Exception:
            logger.debug("Could not determine connection type for %s, assuming USB", udid)

        logger.info("Connecting to %s via %s", udid, connection_type)

        try:
            lockdown = await create_using_usbmux(serial=udid)
        except Exception:
            logger.exception("Cannot create lockdown client for %s via %s", udid, connection_type)
            raise

        ios_version_str: str = lockdown.all_values.get("ProductVersion", "0.0")
        device_name: str = lockdown.all_values.get("DeviceName", "Unknown")
        ver = _parse_ios_version(ios_version_str)

        if ver < (17, 0):
            logger.warning(
                "Refusing connect: %s reports iOS %s, below minimum 17.0",
                udid, ios_version_str,
            )
            raise UnsupportedIosVersionError(ios_version_str)

        conn = await self._connect_tunnel(udid, lockdown, ios_version_str, device_name)
        conn.connection_type = connection_type

        async with self._lock:
            self._connections[udid] = conn

        logger.info("Connected to %s (iOS %s) via %s", udid, ios_version_str, connection_type)

    # -- iOS 17+ via CoreDeviceTunnelProxy ---------------------------------

    async def _connect_tunnel(
        self, udid: str, lockdown, ios_version: str, device_name: str = "Unknown"
    ) -> _ActiveConnection:
        """TCP tunnel for iOS 17+ using a privileged sidecar + RSD."""
        logger.debug("Establishing TCP tunnel for %s (iOS %s)", udid, ios_version)

        try:
            proc, tunnel_result = await self._spawn_tunnel_sidecar(["usb", "--udid", udid], udid)

            logger.info("Tunnel established for %s: %s:%s",
                        udid, tunnel_result["address"], tunnel_result["port"])

            # Create RSD over the tunnel
            rsd = RemoteServiceDiscoveryService((tunnel_result["address"], tunnel_result["port"]))
            await rsd.connect()
            logger.info("RSD connected for %s", udid)

            return _ActiveConnection(
                udid=udid,
                lockdown=rsd,
                ios_version=ios_version,
                device_name=device_name,
                rsd=rsd,
                usbmux_lockdown=lockdown,
                tunnel_process=proc,
            )
        except Exception as exc:
            logger.exception("TCP tunnel failed for %s (iOS %s)", udid, ios_version)
            raise RuntimeError(
                f"無法建立裝置通道 (iOS {ios_version})。{exc}"
            )

    # -- WiFi via RemotePairing ----------------------------------------

    async def _connect_wifi_remotepairing(
        self, udid: str, ip: str, port: int = 49152
    ) -> _ActiveConnection:
        """
        WiFi tunnel using RemotePairing protocol.
        Requires remote_*.plist pair record and Python 3.13+.
        """
        logger.debug("Establishing WiFi tunnel to %s at %s:%d", udid, ip, port)

        try:
            proc, tunnel_result = await self._spawn_tunnel_sidecar(
                ["wifi", "--udid", udid, "--ip", ip, "--port", str(port)],
                udid,
            )

            logger.info("WiFi tunnel established for %s: %s:%s",
                        udid, tunnel_result["address"], tunnel_result["port"])

            # Create RSD over the tunnel
            rsd = RemoteServiceDiscoveryService((tunnel_result["address"], tunnel_result["port"]))
            await rsd.connect()
            logger.info("RSD connected for %s (WiFi)", udid)

            # Get device info from RSD
            try:
                props = rsd.peer_info
                ios_version = props.get("Properties", {}).get("OSVersion", "Unknown")
                device_name = props.get("Properties", {}).get("Name", "iPad")
            except Exception:
                ios_version = "Unknown"
                device_name = "iPad"

            return _ActiveConnection(
                udid=udid,
                lockdown=rsd,
                ios_version=ios_version,
                device_name=device_name,
                connection_type="WiFi",
                rsd=rsd,
                tunnel_process=proc,
            )
        except Exception as exc:
            logger.exception("WiFi RemotePairing failed for %s at %s", udid, ip)
            raise RuntimeError(
                f"無法建立 WiFi 連線 ({ip}:{port})。"
                f"請確認裝置與電腦在同一網段，且已透過 USB 完成配對。{exc}"
            )

    # iOS < 17 path removed in v0.1.49 — see UnsupportedIosVersionError.

    # ------------------------------------------------------------------
    # Disconnection
    # ------------------------------------------------------------------

    async def disconnect(self, udid: str) -> None:
        """Tear down the connection and clean up resources for *udid*."""
        async with self._lock:
            conn = self._connections.pop(udid, None)

        if conn is None:
            logger.warning("Disconnect requested for unknown device %s", udid)
            return

        # Clear any active location simulation first.
        if conn.location_service is not None:
            try:
                await conn.location_service.clear()
            except Exception:
                logger.exception("Error clearing location on disconnect for %s", udid)

        # Shut down the DVT provider if it was opened.
        if conn.dvt_provider is not None:
            try:
                await conn.dvt_provider.__aexit__(None, None, None)
            except Exception:
                logger.exception("Error closing DvtProvider for %s", udid)

        # Close RSD.
        if conn.rsd is not None:
            try:
                await conn.rsd.close()
            except Exception:
                logger.exception("Error closing RSD for %s", udid)

        # Close tunnel context.
        if conn.tunnel_context is not None:
            try:
                await conn.tunnel_context.__aexit__(None, None, None)
            except Exception:
                logger.exception("Error closing tunnel for %s", udid)

        if conn.tunnel_process is not None:
            try:
                if conn.tunnel_process.stdin is not None:
                    conn.tunnel_process.stdin.write(b"stop\n")
                    await conn.tunnel_process.stdin.drain()
                    conn.tunnel_process.stdin.close()
                await asyncio.wait_for(conn.tunnel_process.wait(), timeout=5.0)
            except Exception:
                logger.exception("Error stopping tunnel sidecar for %s", udid)
                with suppress(ProcessLookupError):
                    conn.tunnel_process.terminate()

        # Close tunnel proxy.
        if conn.tunnel_proxy is not None:
            try:
                conn.tunnel_proxy.close()
            except Exception:
                logger.exception("Error closing tunnel proxy for %s", udid)

        logger.info("Disconnected device %s", udid)

    # ------------------------------------------------------------------
    # Location service
    # ------------------------------------------------------------------

    async def get_location_service(self, udid: str) -> LocationService:
        """
        Return a ``LocationService`` instance for the given device.

        The concrete type depends on the iOS version:

        * iOS 17+  ->  ``DvtLocationService`` (uses DVT instrumentation)
        * iOS < 17 ->  ``LegacyLocationService`` (uses DtSimulateLocation)

        The service is cached on the connection so subsequent calls are cheap.
        """
        async with self._lock:
            conn = self._connections.get(udid)

        if conn is None:
            raise RuntimeError(
                f"Device {udid} is not connected. Call connect() first."
            )

        if conn.location_service is not None:
            return conn.location_service

        # iOS <17 connections are rejected up-front in connect(), so any
        # active conn here is iOS 17+. The DVT path internally falls back
        # to LegacyLocationService (com.apple.dt.simulatelocation) on DVT
        # failure, which still works on many iOS 17+/26 devices.
        loc = await self._create_dvt_location_service(conn)
        conn.location_service = loc
        return loc

    async def _ensure_personalized_ddi_mounted(self, conn: _ActiveConnection) -> None:
        """For iOS 17+ devices, make sure the Personalized Developer Disk Image
        is mounted. Without the DDI, the DVT service hub won't advertise and
        DvtProvider will fail with "No such service: com.apple.instruments.dtservicehub".

        If already mounted, this is a no-op. Otherwise it downloads the image
        from the pymobiledevice3 DDI repository (GitHub) and mounts it. The
        per-device signing (TSS) is handled internally by pymobiledevice3.
        """
        try:
            from pymobiledevice3.services.mobile_image_mounter import (
                MobileImageMounterService,
                auto_mount_personalized,
                AlreadyMountedError,
            )
        except ImportError:
            logger.warning("pymobiledevice3 mobile_image_mounter not available; skipping DDI mount")
            return

        # 1. Check whether a Personalized image is already mounted.
        try:
            mounter = MobileImageMounterService(lockdown=conn.lockdown)
            try:
                await mounter.connect()
                if await mounter.is_image_mounted("Personalized"):
                    logger.debug("Personalized DDI already mounted on %s", conn.udid)
                    return
            finally:
                try:
                    await mounter.close()
                except Exception:
                    pass
        except Exception:
            logger.warning("Could not query image mount status; will attempt to mount anyway", exc_info=True)

        # 2. Not mounted — download + mount. Notify frontend so the user
        # sees a "preparing device" overlay instead of a frozen UI.
        logger.info("Personalized DDI not mounted on %s; mounting (may download ~20MB)...", conn.udid)
        try:
            from api.websocket import broadcast
            await broadcast("ddi_mounting", {"udid": conn.udid})
        except Exception:
            pass
        mount_succeeded = False
        try:
            # auto_mount_personalized internally uses requests.get for the
            # GitHub DDI download. Hard-cap the whole operation so a slow or
            # blocked network can't freeze us indefinitely.
            await asyncio.wait_for(auto_mount_personalized(conn.lockdown), timeout=120.0)
            logger.info("Personalized DDI mounted successfully for %s", conn.udid)
            mount_succeeded = True
        except AlreadyMountedError:
            logger.info("DDI was mounted concurrently for %s", conn.udid)
            mount_succeeded = True
        except asyncio.TimeoutError:
            logger.error("DDI mount timed out after 120s for %s", conn.udid)
            try:
                from api.websocket import broadcast
                await broadcast("ddi_mount_failed", {
                    "udid": conn.udid,
                    "error": "DDI download/mount timed out (120s). Check network access to github.com.",
                })
            except Exception:
                pass
            raise RuntimeError("DDI mount timed out — check network access to github.com")
        except Exception as exc:
            logger.exception("auto_mount_personalized failed for %s", conn.udid)
            try:
                from api.websocket import broadcast
                await broadcast("ddi_mount_failed", {
                    "udid": conn.udid,
                    "error": f"{exc.__class__.__name__}: {exc}",
                })
            except Exception:
                pass
            raise
        finally:
            if mount_succeeded:
                try:
                    from api.websocket import broadcast
                    await broadcast("ddi_mounted", {"udid": conn.udid})
                except Exception:
                    pass

    async def _create_dvt_location_service(
        self, conn: _ActiveConnection
    ) -> DvtLocationService:
        """Spin up a DVT provider and hand it to ``DvtLocationService``.

        If DVT fails because the Developer Disk Image is not mounted,
        we try to mount it automatically and retry once.
        """
        # Try to mount DDI proactively (fast no-op when already mounted).
        try:
            await self._ensure_personalized_ddi_mounted(conn)
        except Exception:
            logger.warning("DDI auto-mount failed; DVT may still fail", exc_info=True)

        try:
            dvt = DvtProvider(conn.lockdown)
            await dvt.__aenter__()
            conn.dvt_provider = dvt
            logger.debug("DVT provider opened for %s", conn.udid)
            return DvtLocationService(dvt, lockdown=conn.lockdown)
        except Exception as dvt_exc:
            logger.warning(
                "DVT location service failed for %s (%s). Falling back to "
                "legacy DtSimulateLocation over lockdown.",
                conn.udid, dvt_exc,
            )
            # iOS 17+ still exposes com.apple.dt.simulatelocation on some
            # devices (reported working on iOS 26 by multiple users), so
            # try the legacy service before giving up entirely.
            try:
                # Prefer the original usbmux/TCP lockdown for DtSimulateLocation;
                # fall back to whatever we have stored if not available.
                legacy_lockdown = conn.usbmux_lockdown or conn.lockdown
                legacy = LegacyLocationService(legacy_lockdown)
                logger.info("Using LegacyLocationService fallback for %s", conn.udid)
                return legacy
            except Exception:
                logger.exception(
                    "Both DVT and legacy location services failed for %s", conn.udid
                )
                raise dvt_exc

    # _ensure_classic_ddi_mounted, _create_legacy_location_service, and
    # connect_wifi (legacy direct-IP WiFi) removed in v0.1.49 — see
    # UnsupportedIosVersionError. iOS 17+ continues to use the
    # personalized DDI mount path + DvtLocationService (with
    # LegacyLocationService as a runtime fallback inside
    # _create_dvt_location_service when DVT itself fails).

    # ------------------------------------------------------------------
    # WiFi connection (iOS 17+ tunnel only)
    # ------------------------------------------------------------------

    async def connect_wifi_tunnel(
        self, rsd_address: str, rsd_port: int
    ) -> DeviceInfo:
        """Connect to a device via an existing WiFi tunnel.

        Use this when a WiFi tunnel has already been established by
        ``wifi_tunnel.py`` (or ``pymobiledevice3 remote start-tunnel``).
        The caller provides the RSD address and port printed by the
        tunnel process.

        Returns a ``DeviceInfo`` describing the connected device.
        """
        logger.info("Connecting via WiFi tunnel RSD at %s:%d", rsd_address, rsd_port)

        import asyncio as _asyncio
        rsd = None
        last_exc: Exception | None = None
        # TUN interface routes may take a few seconds to become reachable
        # after the tunnel process reports ready, so retry with backoff.
        for attempt in range(1, 11):
            rsd = RemoteServiceDiscoveryService((rsd_address, rsd_port))
            try:
                await rsd.connect()
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "RSD connect attempt %d/10 failed (%s): %s",
                    attempt, exc.__class__.__name__, exc,
                )
                try:
                    await rsd.close()
                except (OSError, ConnectionError):
                    pass
                await _asyncio.sleep(min(0.5 * attempt, 2.0))

        if last_exc is not None:
            logger.error("Failed to connect to RSD at %s:%d after retries", rsd_address, rsd_port)
            raise RuntimeError(
                f"無法連線到 WiFi tunnel RSD ({rsd_address}:{rsd_port})。"
                "請確認 wifi_tunnel.py 正在執行且 tunnel 仍然活躍。"
            ) from last_exc

        peer = rsd.peer_info or {}
        props = peer.get("Properties", {})
        udid = props.get("UniqueDeviceID", "")
        ios_version_str = props.get("OSVersion", "0.0")
        device_name = props.get("DeviceClass", "iPhone")

        if udid in self._connections:
            await self.disconnect(udid)

        conn = _ActiveConnection(
            udid=udid,
            lockdown=rsd,
            ios_version=ios_version_str,
            device_name=device_name,
            connection_type="Network",
            rsd=rsd,
        )

        async with self._lock:
            self._connections[udid] = conn

        logger.info("WiFi tunnel connected to %s (iOS %s)", udid, ios_version_str)

        return DeviceInfo(
            udid=udid,
            name=device_name,
            ios_version=ios_version_str,
            connection_type="Network",
            is_connected=True,
        )

    async def scan_wifi_devices(
        self,
        subnet: str | None = None,
        timeout: float = 0.5,
    ) -> list[dict]:
        """Scan the local network for iOS devices on port 62078 (lockdownd).

        Tries each IP in the subnet concurrently.  Returns a list of
        ``{"ip": ..., "name": ..., "udid": ...}`` dicts for reachable
        devices.

        If *subnet* is not given, the local machine's subnet is guessed
        from the default route interface.
        """
        if subnet is None:
            subnet = _guess_local_subnet()
            if subnet is None:
                logger.warning("Cannot determine local subnet for WiFi scan")
                return []

        logger.info("Scanning subnet %s for iOS devices...", subnet)

        # Generate IPs: e.g. "192.168.1" → .1 to .254
        base = subnet.rsplit(".", 1)[0]
        ips = [f"{base}.{i}" for i in range(1, 255)]

        async def _probe(ip: str) -> dict | None:
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection(ip, 62078),
                    timeout=timeout,
                )
                writer.close()
                await writer.wait_closed()
                # Port is open — try a quick lockdown to get device info
                try:
                    pair_rec = _load_pair_record()
                    lockdown = await asyncio.wait_for(
                        create_using_tcp(
                            ip,
                            pair_record=pair_rec,
                            autopair=pair_rec is None,
                        ),
                        timeout=5.0,
                    )
                    vals = lockdown.all_values
                    return {
                        "ip": ip,
                        "name": vals.get("DeviceName", "Unknown"),
                        "udid": vals.get("UniqueDeviceID", lockdown.udid or ""),
                        "ios_version": vals.get("ProductVersion", "0.0"),
                    }
                except Exception:
                    # Port open but lockdown failed — still report it
                    return {"ip": ip, "name": "iOS Device", "udid": "", "ios_version": ""}
            except (OSError, asyncio.TimeoutError):
                return None

        results = await asyncio.gather(*[_probe(ip) for ip in ips])
        found = [r for r in results if r is not None]
        logger.info("WiFi scan found %d device(s)", len(found))
        return found

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    @property
    def connected_udids(self) -> list[str]:
        """Return the UDIDs of all currently connected devices."""
        return list(self._connections.keys())

    def is_connected(self, udid: str) -> bool:
        """Check whether a device is currently connected."""
        return udid in self._connections

    def get_connection_type(self, udid: str) -> str:
        """Return ``'USB'`` or ``'Network'`` for a connected device."""
        conn = self._connections.get(udid)
        return conn.connection_type if conn else "USB"

    async def disconnect_all(self) -> None:
        """Disconnect every active device."""
        udids = list(self._connections.keys())
        for udid in udids:
            await self.disconnect(udid)
        logger.info("All devices disconnected")


def _load_pair_record(udid: str | None = None) -> dict | None:
    """Load a USB pair record from Apple's system Lockdown store.

    On macOS, pair records live in ``/var/db/lockdown``.
    If *udid* is given, loads that specific record; otherwise loads the
    first ``.plist`` found (most setups have only one device).
    """
    import plistlib

    lockdown_dir = Path("/var/db/lockdown")
    if not lockdown_dir.exists():
        logger.debug("Apple Lockdown directory not found: %s", lockdown_dir)
        return None

    target: Path | None = None
    if udid:
        candidate = lockdown_dir / f"{udid}.plist"
        if candidate.exists():
            target = candidate
    else:
        # Pick the first device plist (skip SystemConfiguration.plist)
        for f in lockdown_dir.glob("*.plist"):
            if f.stem != "SystemConfiguration":
                target = f
                break

    if target is None:
        logger.debug("No pair record found in %s", lockdown_dir)
        return None

    try:
        with open(target, "rb") as fh:
            record = plistlib.load(fh)
        logger.debug("Loaded pair record from %s", target)
        return record
    except Exception:
        logger.exception("Failed to load pair record from %s", target)
        return None


def _guess_local_subnet() -> str | None:
    """Best-effort guess of the local LAN subnet (e.g. '192.168.1.0/24').

    Returns the base IP like '192.168.1.0' or ``None`` if unable to determine.
    """
    try:
        # Open a UDP socket to a public IP (doesn't actually send)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        # Return the /24 base
        parts = local_ip.rsplit(".", 1)
        return f"{parts[0]}.0"
    except (OSError, IndexError):
        return None
