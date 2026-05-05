import json

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File

from config import DEFAULT_ROUTES_TAB, DEFAULT_SHEET_ID, DEFAULT_WEBHOOK_URL, SHEETS_CONFIG_FILE
from models.schemas import RoutePlanRequest, SavedRoute
from services.route_service import RouteService
from services.gpx_service import GpxService
from services.routes_sync import RouteSheetsSyncService, routes_delete_payload, routes_upsert_payload
from services.sheets_sync import SheetsSyncError

router = APIRouter(prefix="/api/route", tags=["route"])

route_service = RouteService()
gpx_service = GpxService()

def _routes():
    from main import app_state
    return app_state.route_manager


def _load_cfg() -> dict:
    base = {"sheet_id": DEFAULT_SHEET_ID, "webhook_url": DEFAULT_WEBHOOK_URL}
    if SHEETS_CONFIG_FILE.exists():
        try:
            raw = json.loads(SHEETS_CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return {**base, **{k: v for k, v in raw.items() if v not in (None, "")}}
        except Exception:
            pass
    return base


@router.post("/plan")
async def plan_route(req: RoutePlanRequest):
    profile_map = {"walking": "foot", "running": "foot", "bicycling": "bicycle", "driving": "car", "foot": "foot", "car": "car", "bicycle": "bicycle"}
    profile = profile_map.get(req.profile, "foot")
    result = await route_service.get_route(req.start.lat, req.start.lng, req.end.lat, req.end.lng, profile)
    return result


@router.get("/saved", response_model=list[SavedRoute])
async def list_saved():
    return _routes().list_routes()


@router.post("/saved", response_model=SavedRoute)
async def save_route(route: SavedRoute):
    name = route.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail={"code": "invalid_name", "message": "路線名稱不可為空"})
    return _routes().save_route(
        name=name,
        waypoints=route.waypoints,
        profile=route.profile,
        note=route.note,
        updated_by=route.updated_by,
    )


@router.delete("/saved/{route_id}")
async def delete_saved(route_id: str):
    if not _routes().delete_route(route_id):
        raise HTTPException(status_code=404, detail="Route not found")
    return {"status": "deleted"}


from pydantic import BaseModel as _BM


class _RouteRenameRequest(_BM):
    name: str
    updated_by: str = ""


@router.patch("/saved/{route_id}")
async def rename_saved(route_id: str, req: _RouteRenameRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail={"code": "invalid_name", "message": "路線名稱不可為空"})
    try:
        route = _routes().rename_route(route_id, name, updated_by=req.updated_by)
    except ValueError:
        raise HTTPException(status_code=409, detail={"code": "duplicate_name", "message": "已有同名路線"})
    if route is None:
        raise HTTPException(status_code=404, detail="Route not found")
    return route


@router.post("/gpx/import")
async def import_gpx(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode("utf-8")
    coords = gpx_service.parse_gpx(text)
    # Strip the .gpx extension from the filename so the rename input
    # doesn't show "myroute.gpx" — the format suffix is irrelevant to the
    # in-app route name.
    raw_name = file.filename or "Imported GPX"
    base_name = raw_name.rsplit(".", 1)[0] if raw_name.lower().endswith(".gpx") else raw_name
    route = SavedRoute(
        id="",
        name=base_name or "Imported GPX",
        waypoints=coords,
        profile="walking",
        note="",
    )
    saved = _routes().save_route(
        name=route.name,
        waypoints=route.waypoints,
        profile=route.profile,
        note=route.note,
    )
    return {"status": "imported", "id": saved.id, "points": len(coords)}


@router.get("/gpx/export/{route_id}")
async def export_gpx(route_id: str):
    route = _routes().get_route(route_id)
    if route is None:
        raise HTTPException(status_code=404, detail="Route not found")
    points = [{"lat": c.lat, "lng": c.lng} for c in route.waypoints]
    gpx_xml = gpx_service.generate_gpx(points, name=route.name)
    from fastapi.responses import Response
    return Response(content=gpx_xml, media_type="application/gpx+xml",
                    headers={"Content-Disposition": f'attachment; filename="{route.name}.gpx"'})


@router.get("/sync/status")
async def route_sync_status():
    cfg = _load_cfg()
    rm = _routes()
    pending = sum(1 for r in rm.list_routes(include_deleted=True) if r.source in {"local", "deleted"})
    return {
        "configured": bool(cfg.get("sheet_id")),
        "sheet_id": cfg.get("sheet_id", ""),
        "tab_name": DEFAULT_ROUTES_TAB,
        "webhook_url": cfg.get("webhook_url", ""),
        "webhook_configured": bool(cfg.get("webhook_url")),
        "pending_local_count": pending,
        "last_synced_at": "",
        "total_count": len(rm.list_routes()),
        "per_category": {},
        "added": 0,
        "updated": 0,
        "removed": 0,
    }


@router.post("/sync")
async def route_sync():
    cfg = _load_cfg()
    sheet_id = cfg.get("sheet_id")
    if not sheet_id:
        raise HTTPException(status_code=400, detail={"code": "not_configured", "message": "尚未設定 Google Sheets URL。"})
    svc = RouteSheetsSyncService(sheet_id=sheet_id, tab_name=DEFAULT_ROUTES_TAB)
    try:
        rows = await svc.fetch_rows()
    except SheetsSyncError as e:
        raise HTTPException(status_code=502, detail={"code": "sheets_fetch_failed", "message": str(e)})
    result = svc.merge_into(_routes(), rows)
    return {
        "status": "ok",
        "configured": True,
        "sheet_id": result.sheet_id,
        "tab_name": DEFAULT_ROUTES_TAB,
        "webhook_url": cfg.get("webhook_url", ""),
        "webhook_configured": bool(cfg.get("webhook_url")),
        "pending_local_count": sum(1 for r in _routes().list_routes(include_deleted=True) if r.source in {"local", "deleted"}),
        "last_synced_at": result.synced_at,
        "total_count": result.total_count,
        "per_category": {},
        "added": result.added,
        "updated": result.updated,
        "removed": result.removed,
        "skipped_rows": result.skipped_rows,
    }


@router.post("/upload")
async def route_upload():
    cfg = _load_cfg()
    webhook = (cfg.get("webhook_url") or "").strip()
    if not webhook:
        raise HTTPException(status_code=400, detail={"code": "no_webhook", "message": "尚未設定 Apps Script webhook URL。"})
    rm = _routes()
    upserts = routes_upsert_payload(rm)
    deletes = routes_delete_payload(rm)
    if not upserts and not deletes:
        return {"status": "noop", "added": 0, "updated": 0, "deleted": 0, "skipped": 0, "message": "沒有待上傳的本地路線"}
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.post(
                webhook,
                json={"resource": "routes", "action": "sync", "upserts": upserts, "deletes": deletes},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail={"code": "webhook_unreachable", "message": f"無法連線 webhook: {e}"})
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail={"code": "webhook_http_error", "message": f"webhook 回應 {resp.status_code}: {resp.text[:200]}"})
    result = resp.json()
    if "error" in result:
        raise HTTPException(status_code=502, detail={"code": "webhook_error", "message": f"webhook 錯誤: {result['error']}"})
    synced_names = {
        item["name"]
        for bucket in ("added_items", "updated_items")
        for item in (result.get(bucket) or [])
        if item.get("name")
    }
    for route in rm.list_routes(include_deleted=True):
        if route.source == "local" and route.name in synced_names:
            route.source = "cloud"
    deleted_names = {item["name"] for item in (result.get("deleted_items") or []) if item.get("name")}
    purged = rm.purge_routes_by_names(deleted_names) if deleted_names else 0
    if synced_names and not purged:
        rm._save()
    return {
        "status": "ok",
        "added": result.get("added", 0),
        "updated": result.get("updated", 0),
        "deleted": result.get("deleted", 0),
        "skipped": result.get("skipped", 0),
        "flipped_to_cloud": len(synced_names),
        "purged_local": purged,
        "skipped_items": result.get("skipped_items", []),
    }
