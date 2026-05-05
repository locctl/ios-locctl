"""Saved route persistence with simple JSON storage."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from config import ROUTES_FILE
from models.schemas import SavedRoute

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _route_id(name: str) -> str:
    return name.strip()


class RouteManager:
    def __init__(self) -> None:
        self._routes: dict[str, SavedRoute] = {}
        self._load()

    def _load(self) -> None:
        path = Path(ROUTES_FILE)
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            items = raw if isinstance(raw, list) else raw.get("routes", [])
            loaded: dict[str, SavedRoute] = {}
            for item in items:
                route = SavedRoute(**item)
                if not route.id:
                    route.id = _route_id(route.name)
                loaded[route.id] = route
            self._routes = loaded
        except Exception:
            logger.warning("Failed to load saved routes", exc_info=True)

    def _save(self) -> None:
        path = Path(ROUTES_FILE)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = [r.model_dump() for r in self.list_routes()]
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def list_routes(self, include_deleted: bool = False) -> list[SavedRoute]:
        routes = self._routes.values() if include_deleted else [r for r in self._routes.values() if r.source != "deleted"]
        return sorted(routes, key=lambda r: (r.updated_at or r.created_at or "", r.name), reverse=True)

    def save_route(
        self,
        name: str,
        waypoints: list,
        profile: str = "walking",
        note: str = "",
        updated_by: str = "",
    ) -> SavedRoute:
        route_id = _route_id(name)
        now = _now_iso()
        existing = self._routes.get(route_id)
        if existing is None:
            route = SavedRoute(
                id=route_id,
                name=name,
                waypoints=waypoints,
                profile=profile,
                note=note,
                created_at=now,
                updated_by=updated_by,
                updated_at=now,
                source="local",
            )
        else:
            existing.name = name
            existing.waypoints = waypoints
            existing.profile = profile
            existing.note = note
            existing.updated_by = updated_by
            existing.updated_at = now
            existing.source = "local"
            route = existing
        self._routes[route_id] = route
        self._save()
        return route

    def rename_route(self, route_id: str, name: str, updated_by: str = "") -> SavedRoute | None:
        route = self._routes.get(route_id)
        if route is None:
            return None
        new_id = _route_id(name)
        if new_id != route_id and new_id in self._routes:
            raise ValueError("duplicate_name")
        now = _now_iso()
        if route.source == "cloud" and new_id != route_id:
            tombstone = route.model_copy(deep=True)
            tombstone.source = "deleted"
            tombstone.updated_by = updated_by
            tombstone.updated_at = now
            self._routes[route_id] = tombstone
            route = SavedRoute(
                id=new_id,
                name=name,
                waypoints=tombstone.waypoints,
                profile=tombstone.profile,
                note=tombstone.note,
                created_at=tombstone.created_at,
                updated_by=updated_by,
                updated_at=now,
                source="local",
            )
            self._routes[new_id] = route
        else:
            del self._routes[route_id]
            route.id = new_id
            route.name = name
            route.updated_by = updated_by
            route.updated_at = now
            route.source = "local"
            self._routes[new_id] = route
        self._save()
        return route

    def delete_route(self, route_id: str) -> bool:
        route = self._routes.get(route_id)
        if route is None:
            return False
        if route.source == "local":
            del self._routes[route_id]
        else:
            route.source = "deleted"
            route.updated_at = _now_iso()
        self._save()
        return True

    def get_route(self, route_id: str) -> SavedRoute | None:
        return self._routes.get(route_id)

    def purge_routes_by_names(self, names: set[str]) -> int:
        removed = 0
        for name in list(names):
            if name in self._routes:
                del self._routes[name]
                removed += 1
        if removed:
            self._save()
        return removed
