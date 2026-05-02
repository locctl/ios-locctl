"""Navigator -- single-destination route navigation."""

from __future__ import annotations

import logging

from models.schemas import Coordinate, MovementMode, SimulationState
from config import resolve_speed_profile

logger = logging.getLogger(__name__)


class Navigator:
    """Navigates from the current position to a destination via OSRM routing."""

    def __init__(self, engine):
        self.engine = engine

    async def navigate_to(
        self, dest: Coordinate, mode: MovementMode, *,
        direct_route: bool = False,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
    ) -> None:
        """Get an OSRM route from the current position to *dest*, then
        walk/run/drive along it using the engine's core movement loop.

        Raises
        ------
        RuntimeError
            If there is no current position set on the engine.
        """
        engine = self.engine

        if engine.current_position is None:
            raise RuntimeError(
                "Cannot navigate: no current position. Teleport first."
            )

        start = engine.current_position
        profile_name = mode.value  # "walking" | "running" | "driving"
        speed_profile = resolve_speed_profile(profile_name, speed_kmh, speed_min_kmh, speed_max_kmh)

        logger.info(
            "Navigating from (%.6f, %.6f) to (%.6f, %.6f) [%s]",
            start.lat, start.lng, dest.lat, dest.lng, profile_name,
        )

        route = await engine.route_planner.plan_leg(
            start,
            dest,
            mode,
            direct_route=direct_route,
        )
        coords = route.coords
        route_distance = route.distance_m

        if len(coords) < 2:
            logger.warning("Route returned fewer than 2 points; teleporting instead")
            await engine._set_position(dest.lat, dest.lng)
            return

        engine.state = SimulationState.NAVIGATING
        engine.total_segments = len(coords) - 1
        engine.segment_index = 0
        engine.distance_traveled = 0.0
        engine.distance_remaining = route_distance

        await engine._emit("route_path", {
            "coords": [{"lat": c.lat, "lng": c.lng} for c in coords],
        })
        await engine._emit("state_change", {
            "state": engine.state.value,
            "destination": {"lat": dest.lat, "lng": dest.lng},
        })

        # User-facing waypoints for highlight: just start + destination.
        engine._user_waypoints = [start, dest]
        engine._user_waypoint_next = 1

        # Delegate to the core movement loop
        await engine._move_along_route(coords, speed_profile)

        # Navigation complete
        if engine.state == SimulationState.NAVIGATING:
            engine.state = SimulationState.IDLE
            await engine._emit("navigation_complete", {
                "destination": {"lat": dest.lat, "lng": dest.lng},
            })
            await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Navigation to (%.6f, %.6f) finished", dest.lat, dest.lng)
