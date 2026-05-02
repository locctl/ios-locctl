"""Random walk handler -- wander randomly within a radius."""

from __future__ import annotations

import asyncio
import logging
import random

from pymobiledevice3.exceptions import ConnectionTerminatedError

from models.schemas import Coordinate, MovementMode, SimulationState
from services.interpolator import RouteInterpolator
from config import resolve_speed_profile

logger = logging.getLogger(__name__)


class RandomWalkHandler:
    """Picks random destinations within a radius, routes to them,
    pauses briefly, then picks another destination. Repeats until stopped."""

    def __init__(self, engine):
        self.engine = engine

    async def _pick_routable_destination(
        self,
        center: Coordinate,
        current: Coordinate,
        radius_m: float,
        mode: MovementMode,
        *,
        direct_route: bool,
        max_attempts: int = 12,
    ) -> tuple[Coordinate, object] | None:
        """Try several random targets until one produces a usable route.

        For road mode, many random points inside the radius can land in places
        OSRM cannot route to directly (inside buildings, parks, tiny alleys).
        That used to make random walk appear "broken" and then self-stop after
        a few consecutive failures. We keep sampling until we find a routable
        leg instead of treating each bad sample as a fatal leg error.
        """
        engine = self.engine

        for attempt in range(1, max_attempts + 1):
            dest_lat, dest_lng = RouteInterpolator.random_point_in_radius(
                center.lat, center.lng, radius_m,
            )
            dest = Coordinate(lat=dest_lat, lng=dest_lng)
            try:
                route = await engine.route_planner.plan_leg(
                    current,
                    dest,
                    mode,
                    direct_route=direct_route,
                )
            except RuntimeError as exc:
                msg = str(exc)
                if "OSRM error" in msg:
                    logger.debug(
                        "Random walk candidate %d/%d not routable: %s",
                        attempt,
                        max_attempts,
                        msg,
                    )
                    continue
                raise

            if len(route.coords) >= 2:
                return dest, route

            logger.debug(
                "Random walk candidate %d/%d too short (%d points)",
                attempt,
                max_attempts,
                len(route.coords),
            )

        return None

    async def start(
        self,
        center: Coordinate,
        radius_m: float,
        mode: MovementMode,
        *,
        direct_route: bool = False,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = True,
        pause_min: float = 5.0,
        pause_max: float = 20.0,
    ) -> None:
        """Begin a random walk around *center* within *radius_m*.

        Parameters
        ----------
        center
            Centre point of the random walk area.
        radius_m
            Maximum distance from centre (meters).
        mode
            Movement speed profile.
        pause_enabled
            Whether to pause at each random destination (True by default).
        pause_min, pause_max
            When pause_enabled is True, pause for a random duration in this range.
        """
        engine = self.engine

        if engine.current_position is None:
            raise RuntimeError(
                "Cannot start random walk: no current position. Teleport first."
            )

        profile_name = mode.value
        engine.state = SimulationState.RANDOM_WALK
        engine.distance_traveled = 0.0
        engine.lap_count = 0

        await engine._emit("state_change", {
            "state": engine.state.value,
            "center": {"lat": center.lat, "lng": center.lng},
            "radius_m": radius_m,
        })

        logger.info(
            "Random walk started: center=(%.6f,%.6f), radius=%.0fm [%s]",
            center.lat, center.lng, radius_m, profile_name,
        )

        walk_count = 0
        consecutive_errors = 0
        max_consecutive_errors = 5
        # Connection errors get a much higher retry budget so the walk
        # can survive screen-lock / WiFi blips without dying.
        consecutive_conn_errors = 0
        max_consecutive_conn_errors = 60  # ~30 min at max backoff

        while not engine._stop_event.is_set():
            current = engine.current_position
            if current is None:
                logger.warning("Random walk: no current position, stopping")
                break

            # Get OSRM route and move along it; catch ALL errors so one
            # failed leg doesn't kill the entire random walk.
            try:
                picked = await self._pick_routable_destination(
                    center,
                    current,
                    radius_m,
                    mode,
                    direct_route=direct_route,
                )
                if picked is None:
                    logger.warning(
                        "Random walk leg %d: no routable destination found inside %.0fm radius; retrying",
                        walk_count + 1,
                        radius_m,
                    )
                    await asyncio.sleep(1.0)
                    continue

                dest, route = picked
                dest_lat = dest.lat
                dest_lng = dest.lng

                logger.info(
                    "Random walk leg %d: (%.6f, %.6f) → (%.6f, %.6f)",
                    walk_count + 1,
                    current.lat,
                    current.lng,
                    dest_lat,
                    dest_lng,
                )

                coords = route.coords
                engine.distance_remaining = route.distance_m

                if len(coords) >= 2:
                    await engine._emit("route_path", {
                        "coords": [{"lat": c.lat, "lng": c.lng} for c in coords],
                    })
                    # Honor mid-flight apply_speed; otherwise re-pick per leg.
                    if engine._speed_was_applied and engine._active_speed_profile is not None:
                        speed_profile = dict(engine._active_speed_profile)
                    else:
                        speed_profile = resolve_speed_profile(
                            profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
                        )
                    # Random walk has no named waypoints — disable highlight
                    engine._user_waypoints = []
                    engine._user_waypoint_next = 0
                    await engine._move_along_route(coords, speed_profile)
                else:
                    logger.debug("Random walk: route too short (%d points), picking new destination", len(coords))
                    await asyncio.sleep(0.5)
                    continue

                # Reset error counters on success
                consecutive_errors = 0
                consecutive_conn_errors = 0

            except asyncio.CancelledError:
                raise  # Don't swallow cancellation
            except (ConnectionTerminatedError, ConnectionError, OSError) as exc:
                # Device connection lost (WiFi drop, screen lock, etc.)
                # Use longer backoff and higher retry limit.
                consecutive_conn_errors += 1
                backoff = min(5.0 * (2 ** min(consecutive_conn_errors - 1, 5)), 30.0)
                logger.warning(
                    "Random walk leg %d: connection lost (%s), "
                    "retry %d/%d in %.0fs",
                    walk_count + 1, exc.__class__.__name__,
                    consecutive_conn_errors, max_consecutive_conn_errors,
                    backoff,
                )
                if consecutive_conn_errors >= max_consecutive_conn_errors:
                    logger.error(
                        "Random walk: device unreachable after %d attempts, stopping",
                        consecutive_conn_errors,
                    )
                    break
                await engine._emit("connection_lost", {
                    "retry": consecutive_conn_errors,
                    "max_retries": max_consecutive_conn_errors,
                    "next_retry_seconds": backoff,
                })
                try:
                    await asyncio.wait_for(
                        engine._stop_event.wait(), timeout=backoff,
                    )
                    break  # User requested stop during wait
                except asyncio.TimeoutError:
                    pass
                continue
            except Exception:
                consecutive_errors += 1
                logger.warning(
                    "Random walk leg %d failed (error %d/%d)",
                    walk_count + 1, consecutive_errors, max_consecutive_errors,
                    exc_info=True,
                )
                if consecutive_errors >= max_consecutive_errors:
                    logger.error(
                        "Random walk: too many consecutive errors (%d), stopping",
                        consecutive_errors,
                    )
                    break
                await asyncio.sleep(1.0)
                continue

            if engine._stop_event.is_set():
                break

            walk_count += 1
            engine.lap_count = walk_count

            await engine._emit("random_walk_arrived", {
                "count": walk_count,
                "lat": dest_lat,
                "lng": dest_lng,
            })

            logger.info("Random walk arrived at destination %d", walk_count)

            # Optional random pause at the destination
            if not pause_enabled:
                continue
            lo, hi = sorted((float(pause_min), float(pause_max)))
            if lo <= 0 and hi <= 0:
                continue
            if lo < 0:
                lo = 0.0
            pause_duration = random.uniform(lo, hi)
            logger.info("Random walk pausing for %.1fs before next leg", pause_duration)

            await engine._emit("pause_countdown", {
                "duration_seconds": pause_duration,
                "source": "random_walk",
            })

            try:
                await asyncio.wait_for(
                    engine._stop_event.wait(),
                    timeout=pause_duration,
                )
                # Stop was requested during the pause
                break
            except asyncio.TimeoutError:
                # Normal timeout -- continue to next random destination
                pass

            await engine._emit("pause_countdown_end", {"source": "random_walk"})

        # Ensure state returns to IDLE when random walk ends
        if engine.state in (SimulationState.RANDOM_WALK, SimulationState.PAUSED):
            engine.state = SimulationState.IDLE
            await engine._emit("random_walk_complete", {
                "destinations_visited": walk_count,
            })
            await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Random walk finished after %d destinations", walk_count)
