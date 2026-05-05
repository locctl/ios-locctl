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
    DEFAULT_WEBHOOK_URL,
    SHEETS_CONFIG_FILE,
    SHEETS_SYNC_META_FILE,
)
from models.schemas import Bookmark, BookmarkCategory, BookmarkMoveRequest
from services.sheets_sync import (
    SheetsSyncError,
    SheetsSyncService,
    merge_deleted_into_upload_payload,
    merge_unique_local_into_upload_payload,
    parse_sheet_id_from_url,
)

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])
logger = logging.getLogger(__name__)


def _bm():
    from main import app_state
    return app_state.bookmark_manager


# ── Sheets sync config / status helpers ──────────────────

def _load_sheets_config() -> dict:
    """Return the active Sheets config, falling back to the bundled defaults
    (sheet_id + webhook_url) so a fresh install is already wired up to both
    pull from and push to the community sheet."""
    base = {
        "sheet_id": DEFAULT_SHEET_ID,
        "tab_name": DEFAULT_SHEET_TAB,
        "webhook_url": DEFAULT_WEBHOOK_URL,
    }
    if SHEETS_CONFIG_FILE.exists():
        try:
            cfg = json.loads(SHEETS_CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(cfg, dict):
                # Layer user overrides on top of the defaults so partial
                # configs (e.g. user only customised webhook_url) still get
                # the bundled sheet_id.
                merged = {**base, **{k: v for k, v in cfg.items() if v not in (None, "")}}
                merged.setdefault("tab_name", DEFAULT_SHEET_TAB)
                return merged
        except (OSError, json.JSONDecodeError):
            logger.warning("sheets_config.json corrupt; falling back to defaults", exc_info=True)
    return base


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
        updated_by=bookmark.updated_by,
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
        updated_by=bookmark.updated_by,
        source="local",
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return updated


@router.delete("/{bookmark_id}")
async def delete_bookmark(bookmark_id: str):
    bm = _bm()
    target = next((b for b in bm.list_bookmarks(include_deleted=True) if b.id == bookmark_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Bookmark not found")
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
# Both use the same CSV layout as the Google Sheets template, so
# users can paste exports straight into Sheets and import any CSV emitted by
# Sheets (or another ios-locctl install) without translation.
CSV_FIELDS = ["name", "lat", "lng", "country", "category", "updated_by", "updated_at", "note"]


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
            "updated_by": b.updated_by,
            "updated_at": b.updated_at,
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

    # Reuse sheets_sync's category discovery so categories invented by the
    # CSV file get auto-created in the same way as a Sheets sync would.
    svc._ensure_categories(bm.store, rows)
    cat_id_by_name = {c.name: c.id for c in bm.store.categories}

    from services.sheets_sync import _coord_key
    existing_keys = {_coord_key(b.lat, b.lng) for b in bm.list_bookmarks()}

    skipped_reasons: list[str] = []
    imported = 0
    skipped_dup = 0
    for i, raw in enumerate(rows, start=2):
        parsed = svc._parse_row(raw, i, skipped_reasons, cat_id_by_name)
        if parsed is None:
            continue
        if _coord_key(parsed.lat, parsed.lng) in existing_keys:
            skipped_dup += 1
            continue
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
    sheet_url_or_id: str | None = None
    tab_name: str | None = None
    webhook_url: str | None = None


@router.get("/sync/config")
async def get_sync_config():
    """Return the persisted Sheets config so the UI can prefill the modal
    on reopen."""
    cfg = _load_sheets_config()
    return {
        "sheet_id": cfg.get("sheet_id", ""),
        "tab_name": cfg.get("tab_name", "bookmarks"),
        "webhook_url": cfg.get("webhook_url", ""),
        "configured": bool(cfg.get("sheet_id")),
    }


@router.put("/sync/config")
async def set_sync_config(req: SheetsConfigRequest):
    """Update Sheets config. Each field is independent — pass only the ones
    you want to change. Sheet URL is parsed server-side so users can paste
    the full Google Sheets URL straight from the browser bar."""
    cfg = _load_sheets_config()

    if req.sheet_url_or_id is not None:
        s = req.sheet_url_or_id.strip()
        if s:
            sheet_id = parse_sheet_id_from_url(s)
            if not sheet_id:
                raise HTTPException(
                    status_code=400,
                    detail={"code": "invalid_sheet_url",
                            "message": "無法從輸入解析 Sheet ID。請貼整個 Google Sheets URL,或直接貼 ID。"},
                )
            cfg["sheet_id"] = sheet_id

    if req.tab_name is not None:
        cfg["tab_name"] = (req.tab_name.strip() or "bookmarks")

    if req.webhook_url is not None:
        wh = req.webhook_url.strip()
        if wh and not wh.startswith("https://script.google.com/"):
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_webhook_url",
                        "message": "Webhook URL 應為 https://script.google.com/macros/s/.../exec 格式"},
            )
        cfg["webhook_url"] = wh

    _save_sheets_config(cfg)
    return {
        "status": "saved",
        "sheet_id": cfg.get("sheet_id", ""),
        "tab_name": cfg.get("tab_name", "bookmarks"),
        "webhook_url": cfg.get("webhook_url", ""),
    }


@router.get("/sync/check")
async def check_sync_diff():
    """Cheap "is there anything new on the cloud?" probe.

    Hits the same CSV endpoint as `/sync` but only counts rows; no merge,
    no persist. Returns the cloud row count alongside the local cloud-tagged
    bookmark count so the UI can decide whether to show a "(有新更新)"
    badge on the download button without forcing the user to actually sync.

    Failures are not fatal — a network blip just collapses to "no diff
    visible" so the badge stays hidden.
    """
    cfg = _load_sheets_config()
    sheet_id = cfg.get("sheet_id")
    bm = _bm()
    local_cloud_count = sum(1 for b in bm.list_bookmarks(include_deleted=True) if b.source == "cloud")

    if not sheet_id:
        return {"configured": False, "cloud_count": 0, "local_cloud_count": local_cloud_count, "has_updates": False}

    svc = SheetsSyncService(sheet_id=sheet_id, tab_name=cfg.get("tab_name", "bookmarks"))
    try:
        rows = await svc.fetch_rows()
    except SheetsSyncError as e:
        logger.info("sync check failed quietly: %s", e)
        return {
            "configured": True, "cloud_count": 0,
            "local_cloud_count": local_cloud_count, "has_updates": False,
            "error": str(e),
        }

    cloud_count = sum(
        1 for r in rows if (r.get("name") or "").strip()
        and (r.get("lat") or "").strip()
        and (r.get("lng") or "").strip()
    )
    return {
        "configured": True,
        "cloud_count": cloud_count,
        "local_cloud_count": local_cloud_count,
        "has_updates": cloud_count != local_cloud_count,
    }


@router.get("/sync/status")
async def get_sync_status():
    """Last sync stats — used by the UI to render '上次同步: 5 分鐘前'."""
    cfg = _load_sheets_config()
    meta = _load_sync_meta()
    bm = _bm()
    pending_local = sum(1 for b in bm.list_bookmarks(include_deleted=True) if b.source in {"local", "deleted"})
    return {
        "configured": bool(cfg.get("sheet_id")),
        "sheet_id": cfg.get("sheet_id", ""),
        "tab_name": cfg.get("tab_name", "bookmarks"),
        "webhook_url": cfg.get("webhook_url", ""),
        "webhook_configured": bool(cfg.get("webhook_url")),
        "pending_local_count": pending_local,
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


# ── Phase B2: one-button upload of local bookmarks via Apps Script ────────

@router.post("/upload")
async def upload_local_bookmarks():
    """POST every source="local" bookmark to the user's Apps Script webhook.

    The webhook does an upsert: existing rows (matched by lat,lng to 6
    decimals) get rewritten in-place, new rows are appended. That covers
    both newly-added local bookmarks AND edits made to cloud bookmarks
    (which also flip source back to "local" until uploaded).

    Records the script confirms it added or updated have their local
    source flipped back to "cloud" so they don't get re-sent next time."""
    import httpx

    cfg = _load_sheets_config()
    webhook = (cfg.get("webhook_url") or "").strip()
    if not webhook:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_webhook",
                    "message": "尚未設定 Apps Script webhook URL。請先按 ⚙ 設定。"},
        )

    bm = _bm()
    upserts = merge_unique_local_into_upload_payload(bm.store)
    deletes = merge_deleted_into_upload_payload(bm.store)
    if not upserts and not deletes:
        return {
            "status": "noop", "added": 0, "updated": 0, "skipped": 0,
            "message": "沒有待上傳的本地書籤",
        }

    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.post(
                webhook,
                json={"action": "sync", "upserts": upserts, "deletes": deletes},
            )
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail={"code": "webhook_unreachable",
                    "message": f"無法連線 webhook: {e}"},
        )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail={"code": "webhook_http_error",
                    "message": f"webhook 回應 {resp.status_code}: {resp.text[:200]}"},
        )

    try:
        result = resp.json()
    except ValueError:
        raise HTTPException(
            status_code=502,
            detail={"code": "webhook_bad_response",
                    "message": f"webhook 回應不是 JSON: {resp.text[:200]}"},
        )

    if "error" in result:
        raise HTTPException(
            status_code=502,
            detail={"code": "webhook_error",
                    "message": f"webhook 錯誤: {result['error']}"},
        )

    # Upserts become cloud again; deletes are removed locally once cloud
    # confirms them.
    from services.sheets_sync import _coord_key
    synced_keys: set[str] = set()
    for bucket in ("added_items", "updated_items"):
        for item in (result.get(bucket) or []):
            if "lat" in item and "lng" in item:
                synced_keys.add(_coord_key(item["lat"], item["lng"]))

    flipped = 0
    for b in bm.list_bookmarks(include_deleted=True):
        if b.source == "local" and _coord_key(b.lat, b.lng) in synced_keys:
            b.source = "cloud"
            flipped += 1
    deleted_keys: set[str] = set()
    for item in (result.get("deleted_items") or []):
        if "lat" in item and "lng" in item:
            deleted_keys.add(_coord_key(item["lat"], item["lng"]))
    purged = bm.purge_bookmarks_by_coords(deleted_keys) if deleted_keys else 0
    if flipped and not purged:
        bm._save()

    return {
        "status": "ok",
        "added": result.get("added", 0),
        "updated": result.get("updated", 0),
        "deleted": result.get("deleted", 0),
        "skipped": result.get("skipped", 0),
        "flipped_to_cloud": flipped,
        "purged_local": purged,
        "skipped_items": result.get("skipped_items", []),
    }
