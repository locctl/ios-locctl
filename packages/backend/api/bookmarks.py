import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from config import (
    BOOKMARKS_LOCAL_BACKUP_FILE,
    BOOKMARKS_FILE,
    DEFAULT_SHEET_ID,
    DEFAULT_SHEET_TAB,
    SHEETS_CONFIG_FILE,
    SHEETS_SYNC_META_FILE,
)
from models.schemas import Bookmark, BookmarkCategory, BookmarkMoveRequest
from services.sheets_sync import SheetsSyncError, SheetsSyncService, parse_sheet_id_from_url

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])
logger = logging.getLogger(__name__)


def _bm():
    from main import app_state
    return app_state.bookmark_manager


# ── Sheets sync config / status helpers ──────────────────

def _load_sheets_config() -> dict:
    """Return the active Sheets config, falling back to the bundled default
    so a fresh install is already wired up to the community sheet."""
    if SHEETS_CONFIG_FILE.exists():
        try:
            cfg = json.loads(SHEETS_CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(cfg, dict) and cfg.get("sheet_id"):
                # Tolerate older configs that lack tab_name.
                cfg.setdefault("tab_name", DEFAULT_SHEET_TAB)
                return cfg
        except (OSError, json.JSONDecodeError):
            logger.warning("sheets_config.json corrupt; falling back to defaults", exc_info=True)
    return {"sheet_id": DEFAULT_SHEET_ID, "tab_name": DEFAULT_SHEET_TAB}


def _save_sheets_config(cfg: dict) -> None:
    SHEETS_CONFIG_FILE.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _load_sync_meta() -> dict:
    if not SHEETS_SYNC_META_FILE.exists():
        return {}
    try:
        return json.loads(SHEETS_SYNC_META_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_sync_meta(meta: dict) -> None:
    SHEETS_SYNC_META_FILE.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


# ── Bookmarks ─────────────────────────────────────────────

@router.get("", response_model=dict)
async def list_bookmarks():
    bm = _bm()
    return {
        "categories": [c.model_dump() for c in bm.list_categories()],
        "bookmarks": [b.model_dump() for b in bm.list_bookmarks()],
    }


@router.post("", response_model=Bookmark)
async def create_bookmark(bookmark: Bookmark):
    bm = _bm()
    return bm.create_bookmark(
        name=bookmark.name,
        lat=bookmark.lat,
        lng=bookmark.lng,
        country=bookmark.country,
        note=bookmark.note,
        category_id=bookmark.category_id,
        added_by=bookmark.added_by,
        added_at=bookmark.added_at,
    )


@router.put("/{bookmark_id}", response_model=Bookmark)
async def update_bookmark(bookmark_id: str, bookmark: Bookmark):
    bm = _bm()
    # User edits invalidate the "cloud" source flag — once a record diverges
    # from the upstream Sheet, treat it as local-pending until next upload.
    updated = bm.update_bookmark(
        bookmark_id,
        name=bookmark.name,
        lat=bookmark.lat,
        lng=bookmark.lng,
        country=bookmark.country,
        note=bookmark.note,
        category_id=bookmark.category_id,
        source="local",
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return updated


@router.delete("/{bookmark_id}")
async def delete_bookmark(bookmark_id: str):
    bm = _bm()
    if not bm.delete_bookmark(bookmark_id):
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return {"status": "deleted"}


@router.post("/move")
async def move_bookmarks(req: BookmarkMoveRequest):
    bm = _bm()
    count = bm.move_bookmarks(req.bookmark_ids, req.target_category_id)
    return {"moved": count}


# ── Categories ────────────────────────────────────────────

@router.get("/categories", response_model=list[BookmarkCategory])
async def list_categories():
    bm = _bm()
    return bm.list_categories()


@router.post("/categories", response_model=BookmarkCategory)
async def create_category(cat: BookmarkCategory):
    bm = _bm()
    return bm.create_category(name=cat.name, color=cat.color)


@router.put("/categories/{cat_id}", response_model=BookmarkCategory)
async def update_category(cat_id: str, cat: BookmarkCategory):
    bm = _bm()
    updated = bm.update_category(cat_id, name=cat.name, color=cat.color)
    if not updated:
        raise HTTPException(status_code=404, detail="Category not found")
    return updated


@router.delete("/categories/{cat_id}")
async def delete_category(cat_id: str):
    bm = _bm()
    if cat_id == "default":
        raise HTTPException(status_code=400, detail="Cannot delete default category")
    if not bm.delete_category(cat_id):
        raise HTTPException(status_code=404, detail="Category not found")
    return {"status": "deleted"}


# ── Import / Export ───────────────────────────────────────
# Both use the same 8-column CSV layout as the Google Sheets template, so
# users can paste exports straight into Sheets and import any CSV emitted by
# Sheets (or another ios-locctl install) without translation.

CSV_FIELDS = ["name", "lat", "lng", "country", "category", "added_by", "added_at", "note"]


@router.get("/export")
async def export_bookmarks():
    """Emit the local store as CSV in the same shape as the shared Sheet."""
    import csv
    import io

    bm = _bm()
    cat_name_by_id = {c.id: c.name for c in bm.list_categories()}
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_FIELDS)
    writer.writeheader()
    for b in bm.list_bookmarks():
        writer.writerow({
            "name": b.name,
            "lat": b.lat,
            "lng": b.lng,
            "country": b.country,
            "category": cat_name_by_id.get(b.category_id, "未分類"),
            "added_by": b.added_by,
            "added_at": b.added_at,
            "note": b.note,
        })
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="bookmarks.csv"'},
    )


@router.post("/import")
async def import_bookmarks_csv(data: dict):
    """Import a batch of bookmarks from CSV text.

    Body shape: ``{"csv": "<raw csv text including header>"}``.

    Behavior:
      • Rows are validated with the same parser as Sheets sync.
      • Lookup by 6-decimal lat,lng — if a record already exists we skip it
        rather than overwrite (import never destroys local edits).
      • New records land as ``source="local"`` so the user can decide later
        whether to upload them via Phase B2.
    """
    csv_text = (data or {}).get("csv", "")
    if not csv_text.strip():
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_csv", "message": "CSV 內容為空"},
        )

    bm = _bm()
    # Build a bookmarks-only sheet snapshot to feed the existing parser.
    svc = SheetsSyncService(sheet_id="(import)", tab_name="(import)")
    import csv as _csv
    import io as _io
    try:
        rows = list(_csv.DictReader(_io.StringIO(csv_text)))
    except _csv.Error as e:
        raise HTTPException(
            status_code=400,
            detail={"code": "csv_parse_failed", "message": f"CSV 解析失敗: {e}"},
        )
    if not rows:
        return {"imported": 0, "skipped": 0, "errors": []}

    # Index existing by coord key
    from services.sheets_sync import _coord_key
    existing_keys = {_coord_key(b.lat, b.lng) for b in bm.list_bookmarks()}

    skipped_reasons: list[str] = []
    imported = 0
    skipped_dup = 0
    for i, raw in enumerate(rows, start=2):
        parsed = svc._parse_row(raw, i, skipped_reasons)
        if parsed is None:
            continue
        if _coord_key(parsed.lat, parsed.lng) in existing_keys:
            skipped_dup += 1
            continue
        # Imported records belong to the user — flag them as local-pending.
        parsed.source = "local"
        bm.store.bookmarks.append(parsed)
        existing_keys.add(_coord_key(parsed.lat, parsed.lng))
        imported += 1

    if imported:
        bm._save()

    return {
        "imported": imported,
        "skipped_duplicates": skipped_dup,
        "errors": skipped_reasons[:20],  # cap for bandwidth — full list in log
    }


# ── Phase B1: Google Sheets one-way sync ──────────────────

class SheetsConfigRequest(BaseModel):
    sheet_url_or_id: str
    tab_name: str | None = None


@router.get("/sync/config")
async def get_sync_config():
    """Return the persisted Sheets config so the UI can prefill the modal
    on reopen."""
    cfg = _load_sheets_config()
    return {
        "sheet_id": cfg.get("sheet_id", ""),
        "tab_name": cfg.get("tab_name", "bookmarks"),
        "configured": bool(cfg.get("sheet_id")),
    }


@router.put("/sync/config")
async def set_sync_config(req: SheetsConfigRequest):
    """Accept either a full Sheets URL or just the id; we extract the id
    server-side so the user can paste the URL straight from the browser bar."""
    sheet_id = parse_sheet_id_from_url(req.sheet_url_or_id)
    if not sheet_id:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_sheet_url",
                    "message": "無法從輸入解析 Sheet ID。請貼整個 Google Sheets URL,或直接貼 ID。"},
        )
    cfg = _load_sheets_config()
    cfg["sheet_id"] = sheet_id
    cfg["tab_name"] = (req.tab_name or "bookmarks").strip() or "bookmarks"
    _save_sheets_config(cfg)
    return {"status": "saved", "sheet_id": sheet_id, "tab_name": cfg["tab_name"]}


@router.get("/sync/status")
async def get_sync_status():
    """Last sync stats — used by the UI to render '上次同步: 5 分鐘前'."""
    cfg = _load_sheets_config()
    meta = _load_sync_meta()
    return {
        "configured": bool(cfg.get("sheet_id")),
        "sheet_id": cfg.get("sheet_id", ""),
        "tab_name": cfg.get("tab_name", "bookmarks"),
        "last_synced_at": meta.get("last_synced_at", ""),
        "total_count": meta.get("total_count", 0),
        "per_category": meta.get("per_category", {}),
        "added": meta.get("added", 0),
        "updated": meta.get("updated", 0),
        "removed": meta.get("removed", 0),
    }


@router.post("/sync")
async def sync_from_sheets():
    """Pull the configured Sheet, merge in cloud-source-of-truth fashion,
    persist. Failure is atomic — local store is untouched on any error."""
    cfg = _load_sheets_config()
    sheet_id = cfg.get("sheet_id")
    if not sheet_id:
        raise HTTPException(
            status_code=400,
            detail={"code": "not_configured",
                    "message": "尚未設定 Google Sheets URL。請先在書籤面板按設定。"},
        )
    tab_name = cfg.get("tab_name", "bookmarks")

    bm = _bm()
    svc = SheetsSyncService(sheet_id=sheet_id, tab_name=tab_name)

    try:
        rows = await svc.fetch_rows()
    except SheetsSyncError as e:
        raise HTTPException(status_code=502, detail={"code": "sheets_fetch_failed", "message": str(e)})

    # Snapshot local state before mutation so we can roll back on save failure.
    try:
        BOOKMARKS_LOCAL_BACKUP_FILE.write_text(
            BOOKMARKS_FILE.read_text(encoding="utf-8"), encoding="utf-8"
        )
    except OSError:
        logger.warning("Could not write local backup before sync; proceeding anyway", exc_info=True)

    result = svc.merge_into(bm.store, rows)
    bm._save()

    meta = {
        "last_synced_at": result.synced_at,
        "sheet_id": result.sheet_id,
        "total_count": result.total_count,
        "per_category": result.per_category,
        "added": result.added,
        "updated": result.updated,
        "removed": result.removed,
    }
    _save_sync_meta(meta)

    return {
        "status": "ok",
        **meta,
        "skipped_rows": result.skipped_rows,
    }
