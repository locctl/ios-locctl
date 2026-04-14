"""OSRM route planning service."""

from __future__ import annotations

import logging

import httpx

from config import OSRM_BASE_URL

logger = logging.getLogger(__name__)

# Map user-facing profile names to OSRM profile slugs
_PROFILE_MAP = {
    "walking": "foot",
    "running": "foot",
    "driving": "car",
    "foot": "foot",
    "car": "car",
    "bike": "bike",
    "bicycle": "bicycle",
}

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class RouteService:
    """Thin async wrapper around the OSRM HTTP API."""

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    async def get_route(
        self,
        start_lat: float,
        start_lng: float,
        end_lat: float,
        end_lng: float,
        profile: str = "foot",
    ) -> dict:
        """Plan a route between two points via OSRM.

        Returns
        -------
        dict
            coords:         list of [lat, lng] pairs (route geometry)
            duration:        total duration in seconds
            distance:        total distance in meters
            leg_durations:   list of per-leg durations (seconds)
        """
        waypoints = [
            (start_lat, start_lng),
            (end_lat, end_lng),
        ]
        return await self._fetch_route(waypoints, profile)

    async def get_multi_route(
        self,
        waypoints: list[tuple[float, float] | list[float] | dict],
        profile: str = "foot",
    ) -> dict:
        """Plan a route through multiple waypoints.

        *waypoints* may be a list of ``(lat, lng)`` tuples, ``[lat, lng]``
        lists, or dicts with ``lat``/``lng`` keys.
        """
        normalised: list[tuple[float, float]] = []
        for wp in waypoints:
            if isinstance(wp, dict):
                normalised.append((wp["lat"], wp["lng"]))
            else:
                normalised.append((float(wp[0]), float(wp[1])))

        if len(normalised) < 2:
            raise ValueError("At least two waypoints are required")

        return await self._fetch_route(normalised, profile)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _fetch_route(
        self,
        waypoints: list[tuple[float, float]],
        profile: str,
    ) -> dict:
        osrm_profile = _PROFILE_MAP.get(profile, profile)

        # OSRM coordinate pairs are lon,lat (not lat,lon)
        coords_str = ";".join(
            f"{lng},{lat}" for lat, lng in waypoints
        )

        url = (
            f"{OSRM_BASE_URL}/route/v1/{osrm_profile}/{coords_str}"
            "?overview=full&geometries=geojson&steps=true"
            "&annotations=duration,distance"
        )

        logger.debug("OSRM request: %s", url)

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()

        if data.get("code") != "Ok":
            msg = data.get("message", "Unknown OSRM error")
            raise RuntimeError(f"OSRM error: {msg}")

        route = data["routes"][0]
        geometry = route["geometry"]  # GeoJSON LineString

        # GeoJSON coordinates are [lon, lat]; convert to [lat, lng]
        coords = [
            [pt[1], pt[0]] for pt in geometry["coordinates"]
        ]

        leg_durations = [leg["duration"] for leg in route["legs"]]

        return {
            "coords": coords,
            "duration": route["duration"],
            "distance": route["distance"],
            "leg_durations": leg_durations,
        }
