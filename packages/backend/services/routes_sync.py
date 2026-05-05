from __future__ import annotations

import csv
import io
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from config import DEFAULT_ROUTES_TAB
from models.schemas import Coordinate, SavedRoute
from services.bookmarks import _now_iso
from services.sheets_sync import SheetsSyncError

logger = logging.getLogger(__name__)

_CSV_URL_TMPL = (
    "https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq"
    "?tqx=out:csv&sheet={tab_name}"
)

_REQUIRED_COLS = {"name", "waypoints_json"}


@dataclass
class RouteSyncResult:
    synced_at: str
    sheet_id: str
    total_count: int
    added: int
    updated: int
    removed: int
    skipped_rows: list[str]


class RouteSheetsSyncService:
    def __init__(self, sheet_id: str, tab_name: str = DEFAULT_ROUTES_TAB) -> None:
        self.sheet_id = sheet_id
        self.tab_name = tab_name

    async def fetch_rows(self) -> list[dict[str, str]]:
        url = _CSV_URL_TMPL.format(sheet_id=self.sheet_id, tab_name=self.tab_name)
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                resp = await client.get(url)
        except httpx.HTTPError as e:
            raise SheetsSyncError(f"無法連線到 Google Sheets: {e}") from e
        if resp.status_code == 400:
            raise SheetsSyncError(
                f"Sheets 回應 400 — 請確認 tab 名稱為 '{self.tab_name}' 且試算表已設成「知道連結的人都能查看」"
            )
        if resp.status_code != 200:
            raise SheetsSyncError(f"Sheets 回應 {resp.status_code} — 請檢查試算表分享設定與 sheet id")
        text = resp.text.lstrip("﻿")
        rows = list(csv.DictReader(io.StringIO(text)))
        if not rows:
            raise SheetsSyncError("試算表沒有資料列(只有標題或全空)")
        missing = _REQUIRED_COLS - set(rows[0].keys())
        if missing:
            raise SheetsSyncError(
                f"試算表缺少必要欄位: {', '.join(sorted(missing))}。請確認標題列含 name, waypoints_json。"
            )
        return rows

    def _parse_row(self, raw: dict[str, str], row_num: int, skipped: list[str]) -> SavedRoute | None:
        name = (raw.get("name") or "").strip()
        if not name:
            if any((raw.get(k) or "").strip() for k in raw):
                skipped.append(f"row {row_num}: missing name")
            return None
        raw_points = (raw.get("waypoints_json") or "").strip()
        if not raw_points:
            skipped.append(f"row {row_num} ({name}): missing waypoints_json")
            return None
        try:
            pts = json.loads(raw_points)
            waypoints = [Coordinate(lat=float(p["lat"]), lng=float(p["lng"])) for p in pts]
        except Exception:
            skipped.append(f"row {row_num} ({name}): invalid waypoints_json")
            return None
        if not waypoints:
            skipped.append(f"row {row_num} ({name}): empty route")
            return None
        now = _now_iso()
        return SavedRoute(
            id=name,
            name=name,
            waypoints=waypoints,
            note=(raw.get("note") or "").strip(),
            updated_by=(raw.get("updated_by") or "").strip(),
            updated_at=(raw.get("updated_at") or "").strip() or now,
            created_at=now,
            source="cloud",
        )

    def merge_into(self, routes_mgr, rows: list[dict[str, str]]) -> RouteSyncResult:
        skipped: list[str] = []
        cloud_routes: list[SavedRoute] = []
        for i, raw in enumerate(rows, start=2):
            parsed = self._parse_row(raw, i, skipped)
            if parsed is not None:
                cloud_routes.append(parsed)
        local_by_name = {r.name: r for r in routes_mgr.list_routes(include_deleted=True)}
        cloud_names: set[str] = set()
        added = updated = 0
        for cloud in cloud_routes:
            cloud_names.add(cloud.name)
            existing = local_by_name.get(cloud.name)
            if existing is None:
                routes_mgr._routes[cloud.id] = cloud
                added += 1
            elif existing.source == "deleted":
                continue
            else:
                existing.waypoints = cloud.waypoints
                existing.note = cloud.note
                existing.updated_by = cloud.updated_by
                existing.updated_at = cloud.updated_at
                existing.source = "cloud"
                updated += 1
        removed = 0
        for route in list(routes_mgr.list_routes(include_deleted=True)):
            if route.name in cloud_names or route.source in {"local", "deleted"}:
                continue
            del routes_mgr._routes[route.id]
            removed += 1
        routes_mgr._save()
        return RouteSyncResult(
            synced_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            sheet_id=self.sheet_id,
            total_count=len(routes_mgr.list_routes()),
            added=added,
            updated=updated,
            removed=removed,
            skipped_rows=skipped,
        )


def routes_upsert_payload(routes_mgr) -> list[dict]:
    out = []
    for route in routes_mgr.list_routes(include_deleted=True):
        if route.source != "local":
            continue
        out.append({
            "name": route.name,
            "waypoints_json": json.dumps([w.model_dump() for w in route.waypoints], ensure_ascii=False),
            "updated_by": route.updated_by,
            "updated_at": route.updated_at,
            "note": route.note,
        })
    return out


def routes_delete_payload(routes_mgr) -> list[dict]:
    out = []
    for route in routes_mgr.list_routes(include_deleted=True):
        if route.source != "deleted":
            continue
        out.append({
            "name": route.name,
            "updated_by": route.updated_by,
            "updated_at": route.updated_at,
        })
    return out
