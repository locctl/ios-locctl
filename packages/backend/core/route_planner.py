"""Shared route planning helpers for movement modes."""

from __future__ import annotations

from dataclasses import dataclass

from models.schemas import Coordinate, MovementMode


@dataclass(slots=True)
class RoutePlan:
    coords: list[Coordinate]
    distance_m: float


class RoutePlanner:
    """Build straight-line or road-snapped routes in one place."""

    def __init__(self, route_service) -> None:
        self.route_service = route_service

    @staticmethod
    def osrm_profile(mode: MovementMode) -> str:
        if mode in (MovementMode.WALKING, MovementMode.RUNNING):
            return "foot"
        if mode == MovementMode.BICYCLING:
            return "bicycle"
        return "car"

    async def plan_leg(
        self,
        start: Coordinate,
        end: Coordinate,
        mode: MovementMode,
        *,
        direct_route: bool = False,
    ) -> RoutePlan:
        if direct_route:
            return RoutePlan(
                coords=[start, end],
                distance_m=self.route_service.haversine_distance(
                    start.lat, start.lng, end.lat, end.lng,
                ),
            )

        route_data = await self.route_service.get_route(
            start.lat,
            start.lng,
            end.lat,
            end.lng,
            profile=self.osrm_profile(mode),
        )
        return RoutePlan(
            coords=[Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]],
            distance_m=route_data["distance"],
        )

    async def plan_waypoints(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        *,
        direct_route: bool = False,
        close_loop: bool = False,
    ) -> RoutePlan:
        if len(waypoints) < 2:
            return RoutePlan(coords=list(waypoints), distance_m=0.0)

        route_points = list(waypoints)
        if close_loop:
            route_points = route_points + [route_points[0]]

        if direct_route:
            distance = 0.0
            for i in range(len(route_points) - 1):
                a = route_points[i]
                b = route_points[i + 1]
                distance += self.route_service.haversine_distance(
                    a.lat, a.lng, b.lat, b.lng,
                )
            return RoutePlan(coords=route_points, distance_m=distance)

        route_data = await self.route_service.get_multi_route(
            [(wp.lat, wp.lng) for wp in route_points],
            profile=self.osrm_profile(mode),
        )
        return RoutePlan(
            coords=[Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]],
            distance_m=route_data["distance"],
        )
