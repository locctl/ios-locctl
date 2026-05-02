"""One-way sync from a public Google Sheets tab into local bookmarks.json.

Why one-way pull (not OAuth bidirectional): the shared Sheet IS the canonical
co-edited knowledge base. Anyone with the link can edit it directly in
Google Sheets. The app pulls it down to be the source of truth for
"cloud" records, while locally-added "local" records stay untouched until
the user explicitly uploads them (Phase B2 — separate Apps Script POST flow).

CSV endpoint: ``/gviz/tq?tqx=out:csv&sheet=<tab>`` — no API key, no OAuth, just
a publicly-shared sheet.

Merge rules (cloud-source-of-truth, never lose local):
  * cloud row + local "cloud" record (same lat,lng) → overwrite with cloud
  * cloud row + local "local" record (same lat,lng) → flip to "cloud"
    (the upload race already happened — adopt the cloud copy, drop the local
    duplicate so the user doesn't have to manually reconcile)
  * cloud row + no local record → insert as "cloud"
  * local "cloud" record + no matching cloud row → DELETE (someone removed
    it from the Sheet)
  * local "local" record + no matching cloud row → KEEP (user's pending
    upload, don't touch)
"""

from __future__ import annotations

import csv
import io
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

import httpx

from models.schemas import Bookmark, BookmarkCategory, BookmarkStore
from services.bookmarks import GROUP_ORDER, NAME_TO_ID, _now_iso

logger = logging.getLogger(__name__)

# Public CSV export URL. `{sheet_id}` is the alphanumeric blob from the Sheets
# URL (the one between /d/ and /edit). `{tab_name}` is the tab title.
_CSV_URL_TMPL = (
    "https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq"
    "?tqx=out:csv&sheet={tab_name}"
)

# Recognized columns in the Sheet. Everything else is ignored. Order in the
# Sheet doesn't matter — DictReader uses the header row.
_REQUIRED_COLS = {"name", "lat", "lng"}
_CATEGORY_NAMES = {name for _, name in GROUP_ORDER}


def _coord_key(lat: float, lng: float) -> str:
    """Stable identity for cross-source dedupe. 6 decimals ≈ 11 cm at the
    equator — far below the noise floor of any GPS-related workflow but
    tight enough that two distinct points in the same building stay distinct."""
    return f"{round(float(lat), 6)},{round(float(lng), 6)}"


@dataclass
class SyncResult:
    synced_at: str
    sheet_id: str
    total_count: int
    per_category: dict[str, int]
    added: int
    updated: int
    removed: int
    skipped_rows: list[str]  # human-readable reasons (one per skipped row)


class SheetsSyncError(RuntimeError):
    """Raised when the sync should be aborted without touching local state.
    The HTTP layer maps this to 502/400 as appropriate."""


def parse_sheet_id_from_url(url: str) -> str | None:
    """Pull the sheet id out of any flavor of Sheets URL the user might paste.
    Accepts the bare id too (so both /spreadsheets/d/<id>/edit?gid=... and the
    raw id work)."""
    s = (url or "").strip()
    if not s:
        return None
    # Bare id heuristic: alphanumeric + - + _, length ≥ 20
    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", s):
        return s
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", s)
    return m.group(1) if m else None


class SheetsSyncService:
    def __init__(self, sheet_id: str, tab_name: str = "bookmarks") -> None:
        self.sheet_id = sheet_id
        self.tab_name = tab_name

    async def fetch_rows(self) -> list[dict[str, str]]:
        """Pull the published CSV and parse it into a list of dicts. Raises
        SheetsSyncError on any network / format problem; we never touch the
        local store on failure."""
        url = _CSV_URL_TMPL.format(sheet_id=self.sheet_id, tab_name=self.tab_name)
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                resp = await client.get(url)
        except httpx.HTTPError as e:
            raise SheetsSyncError(f"無法連線到 Google Sheets: {e}") from e

        if resp.status_code == 400:
            raise SheetsSyncError(
                "Sheets 回應 400 — 請確認 tab 名稱為 'bookmarks' 且試算表已設成「知道連結的人都能查看」"
            )
        if resp.status_code != 200:
            raise SheetsSyncError(
                f"Sheets 回應 {resp.status_code} — 請檢查試算表分享設定與 sheet id"
            )

        text = resp.text
        # gviz returns text/csv with utf-8; sometimes wraps in BOM
        if text.startswith("﻿"):
            text = text.lstrip("﻿")

        try:
            rows = list(csv.DictReader(io.StringIO(text)))
        except csv.Error as e:
            raise SheetsSyncError(f"CSV 解析失敗: {e}") from e

        if not rows:
            raise SheetsSyncError("試算表沒有資料列(只有標題或全空)")

        missing = _REQUIRED_COLS - set(rows[0].keys())
        if missing:
            raise SheetsSyncError(
                f"試算表缺少必要欄位: {', '.join(sorted(missing))}。"
                f"請確認標題列含 name, lat, lng (其他欄位選用)。"
            )

        return rows

    def merge_into(self, store: BookmarkStore, rows: list[dict[str, str]]) -> SyncResult:
        """Apply the cloud-source-of-truth merge rules in-place on `store`.
        Returns a SyncResult summary; caller is responsible for persisting."""
        skipped: list[str] = []
        cloud_records: list[Bookmark] = []
        for i, raw in enumerate(rows, start=2):  # row 2 = first data row in Sheets
            parsed = self._parse_row(raw, i, skipped)
            if parsed is not None:
                cloud_records.append(parsed)

        # Index existing bookmarks by coord key
        local_by_key: dict[str, Bookmark] = {}
        for bm in store.bookmarks:
            local_by_key[_coord_key(bm.lat, bm.lng)] = bm

        cloud_keys: set[str] = set()
        added = updated = 0
        new_bookmarks: list[Bookmark] = []
        # Process cloud rows: add or overwrite.
        for cloud_bm in cloud_records:
            key = _coord_key(cloud_bm.lat, cloud_bm.lng)
            cloud_keys.add(key)
            existing = local_by_key.get(key)
            if existing is None:
                # New cloud record
                new_bookmarks.append(cloud_bm)
                added += 1
            else:
                # Overwrite metadata, but preserve the existing UUID + timestamps
                # so frontend referential identity stays stable across syncs.
                existing.name = cloud_bm.name
                existing.country = cloud_bm.country
                existing.note = cloud_bm.note
                existing.category_id = cloud_bm.category_id
                existing.added_by = cloud_bm.added_by
                existing.added_at = cloud_bm.added_at
                # Adopt the cloud copy: a "local" record now has a cloud twin.
                existing.source = "cloud"
                updated += 1

        # Carry forward records that aren't in the cloud:
        # - source="cloud" + missing from cloud → DELETE
        # - source="local" + missing from cloud → KEEP (pending upload)
        kept: list[Bookmark] = []
        removed = 0
        for bm in store.bookmarks:
            key = _coord_key(bm.lat, bm.lng)
            if key in cloud_keys:
                kept.append(bm)
            elif bm.source == "local":
                kept.append(bm)
            else:
                removed += 1

        store.bookmarks = kept + new_bookmarks

        # Build per-category count for the response (uses category names so the
        # frontend can show "明信片菇點: 31" without an extra lookup).
        cat_name_by_id = {c.id: c.name for c in store.categories}
        per_category: dict[str, int] = {}
        for bm in store.bookmarks:
            n = cat_name_by_id.get(bm.category_id, "未分類")
            per_category[n] = per_category.get(n, 0) + 1

        return SyncResult(
            synced_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            sheet_id=self.sheet_id,
            total_count=len(store.bookmarks),
            per_category=per_category,
            added=added,
            updated=updated,
            removed=removed,
            skipped_rows=skipped,
        )

    def _parse_row(self, raw: dict[str, str], row_num: int, skipped: list[str]) -> Bookmark | None:
        """Validate one CSV row → Bookmark, or append a reason to `skipped`
        and return None. We deliberately tolerate malformed rows and keep
        going so one bad row can't kill an otherwise-good sync."""
        name = (raw.get("name") or "").strip()
        if not name:
            # An entirely blank row at the bottom of a Sheet is common and
            # uninteresting — only complain if some other column had data.
            if any((raw.get(k) or "").strip() for k in raw):
                skipped.append(f"row {row_num}: missing name")
            return None
        try:
            lat = float((raw.get("lat") or "").strip())
            lng = float((raw.get("lng") or "").strip())
        except (TypeError, ValueError):
            skipped.append(f"row {row_num} ({name}): invalid lat/lng")
            return None
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            skipped.append(f"row {row_num} ({name}): coord out of range")
            return None

        category_name = (raw.get("category") or "").strip() or "未分類"
        if category_name not in _CATEGORY_NAMES:
            skipped.append(
                f"row {row_num} ({name}): unknown category '{category_name}' → fell back to 未分類"
            )
            category_name = "未分類"
        category_id = NAME_TO_ID[category_name]

        now_iso = _now_iso()
        return Bookmark(
            id=str(uuid.uuid4()),
            name=name,
            lat=lat,
            lng=lng,
            note=(raw.get("note") or "").strip(),
            category_id=category_id,
            created_at=now_iso,
            last_used_at=now_iso,
            country=(raw.get("country") or "").strip(),
            added_by=(raw.get("added_by") or "").strip(),
            added_at=(raw.get("added_at") or "").strip(),
            source="cloud",
        )


def merge_unique_local_into_upload_payload(store: BookmarkStore) -> list[dict]:
    """Helper used by Phase B2 (upload). Returns a JSON-serializable list of
    only the records currently flagged source="local" — those are the ones the
    user has added in-app but hasn't pushed to the cloud yet."""
    cat_name_by_id = {c.id: c.name for c in store.categories}
    out = []
    for bm in store.bookmarks:
        if bm.source != "local":
            continue
        out.append({
            "name": bm.name,
            "lat": bm.lat,
            "lng": bm.lng,
            "country": bm.country,
            "category": cat_name_by_id.get(bm.category_id, "未分類"),
            "added_by": bm.added_by,
            "added_at": bm.added_at,
            "note": bm.note,
        })
    return out
