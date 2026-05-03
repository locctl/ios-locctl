"""Bookmark and category management with JSON file persistence."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import BOOKMARKS_FILE
from models.schemas import Bookmark, BookmarkCategory, BookmarkStore

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# Only the fallback "未分類" is hardcoded — every other category is created
# dynamically from whatever the cloud Sheet contains. We keep the default
# present so empty installs and locally-added bookmarks always have at least
# one category to land in before any sync runs.
GROUP_ORDER = [
    ("default", "未分類"),
]

NAME_TO_ID = {name: cat_id for cat_id, name in GROUP_ORDER}
ID_TO_NAME = {cat_id: name for cat_id, name in GROUP_ORDER}


def _new_category(cat_id: str, name: str, sort_order: int) -> BookmarkCategory:
    return BookmarkCategory(
        id=cat_id,
        name=name,
        color="#6c8cff",
        sort_order=sort_order,
        created_at=_now_iso(),
    )


def _empty_store() -> BookmarkStore:
    return BookmarkStore(
        categories=[_new_category(cat_id, name, idx) for idx, (cat_id, name) in enumerate(GROUP_ORDER)],
        bookmarks=[],
    )


def _group_for_bookmark(bm: Bookmark) -> str:
    name = (bm.category_id or "").strip()
    if name in NAME_TO_ID:
        return name
    if name in ID_TO_NAME:
        return ID_TO_NAME[name]
    return "未分類"


def _serialize_grouped(store: BookmarkStore) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {name: [] for _, name in GROUP_ORDER}

    cat_name_by_id = {c.id: c.name for c in store.categories}
    for bm in store.bookmarks:
        cat_name = cat_name_by_id.get(bm.category_id, "未分類")
        grouped.setdefault(cat_name, []).append(
            {
                "name": bm.name,
                "lat": bm.lat,
                "lng": bm.lng,
                "country": bm.country,
                "added_by": bm.added_by,
                "added_at": bm.added_at,
                "source": bm.source,
                "note": bm.note,
            }
        )

    # Keep any unexpected categories instead of dropping data.
    for cat in store.categories:
        grouped.setdefault(cat.name, [])

    return grouped


def _load_old_style(data: dict[str, Any]) -> BookmarkStore:
    return BookmarkStore(**data)


def _load_grouped_style(data: dict[str, Any]) -> BookmarkStore:
    store = _empty_store()
    categories_by_name = {c.name: c for c in store.categories}
    bookmarks: list[Bookmark] = []

    for idx, (cat_name, items) in enumerate(data.items()):
        if not isinstance(items, list):
            continue
        cat = categories_by_name.get(cat_name)
        if cat is None:
            cat = _new_category(cat_name, cat_name, len(store.categories) + idx)
            store.categories.append(cat)
            categories_by_name[cat_name] = cat

        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                bookmarks.append(
                    Bookmark(
                        id=str(uuid.uuid4()),
                        name=str(item.get("name", "")).strip(),
                        lat=float(item.get("lat")),
                        lng=float(item.get("lng")),
                        note=str(item.get("note", "") or ""),
                        category_id=cat.id,
                        created_at=_now_iso(),
                        last_used_at=_now_iso(),
                        country=str(item.get("country", "") or ""),
                        added_by=str(item.get("added_by", "") or ""),
                        added_at=str(item.get("added_at", "") or ""),
                        # Fall back to "cloud" for legacy data — pre-Phase-A
                        # bookmarks are the seed set, so they belong to the
                        # shared knowledge base by default.
                        source=str(item.get("source", "cloud") or "cloud"),
                    )
                )
            except Exception:
                logger.warning("Skipping invalid grouped bookmark item in %s", cat_name)

    store.bookmarks = bookmarks
    return store


class BookmarkManager:
    """CRUD manager for bookmarks and categories.

    State is persisted to :data:`BOOKMARKS_FILE` (JSON) on every write
    operation.
    """

    def __init__(self) -> None:
        self.store = _empty_store()
        self._load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Load bookmarks from the JSON file, if it exists."""
        path = Path(BOOKMARKS_FILE)
        if not path.exists():
            logger.info("No bookmark file found; using defaults")
            return

        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
            if isinstance(data, dict) and "categories" in data and "bookmarks" in data:
                self.store = _load_old_style(data)
            elif isinstance(data, dict):
                self.store = _load_grouped_style(data)
            else:
                raise ValueError("unsupported bookmark JSON shape")
            logger.info(
                "Loaded %d bookmarks in %d categories",
                len(self.store.bookmarks),
                len(self.store.categories),
            )
        except Exception as exc:
            logger.warning("Failed to load bookmarks: %s", exc)

    def _save(self) -> None:
        """Persist the current store to disk."""
        path = Path(BOOKMARKS_FILE)
        path.parent.mkdir(parents=True, exist_ok=True)

        try:
            raw = json.dumps(_serialize_grouped(self.store), ensure_ascii=False, indent=2)
            path.write_text(raw + "\n", encoding="utf-8")
        except Exception as exc:
            logger.error("Failed to save bookmarks: %s", exc)

    # ------------------------------------------------------------------
    # Categories
    # ------------------------------------------------------------------

    def create_category(
        self,
        name: str,
        color: str = "#6c8cff",
    ) -> BookmarkCategory:
        """Create and return a new category."""
        max_order = max((c.sort_order for c in self.store.categories), default=-1)
        cat = BookmarkCategory(
            id=NAME_TO_ID.get(name, str(uuid.uuid4())),
            name=name,
            color=color,
            sort_order=max_order + 1,
            created_at=_now_iso(),
        )
        self.store.categories.append(cat)
        self._save()
        return cat

    def update_category(
        self,
        cat_id: str,
        name: str | None = None,
        color: str | None = None,
    ) -> BookmarkCategory | None:
        """Update a category's name or colour. Returns ``None`` if not found."""
        cat = self._find_category(cat_id)
        if cat is None:
            return None
        if name is not None:
            cat.name = name
        if color is not None:
            cat.color = color
        self._save()
        return cat

    def delete_category(self, cat_id: str) -> bool:
        """Delete a category and move its bookmarks to *default*.

        The *default* category cannot be deleted.
        """
        if cat_id == "default":
            logger.warning("Cannot delete the default category")
            return False

        cat = self._find_category(cat_id)
        if cat is None:
            return False

        # Move orphaned bookmarks
        for bm in self.store.bookmarks:
            if bm.category_id == cat_id:
                bm.category_id = "default"

        self.store.categories = [c for c in self.store.categories if c.id != cat_id]
        self._save()
        return True

    def list_categories(self) -> list[BookmarkCategory]:
        return sorted(self.store.categories, key=lambda c: c.sort_order)

    def _find_category(self, cat_id: str) -> BookmarkCategory | None:
        return next((c for c in self.store.categories if c.id == cat_id), None)

    # ------------------------------------------------------------------
    # Bookmarks
    # ------------------------------------------------------------------

    def create_bookmark(
        self,
        name: str,
        lat: float,
        lng: float,
        country: str = "",
        note: str = "",
        category_id: str = "default",
        added_by: str = "",
        added_at: str = "",
    ) -> Bookmark:
        """Create a new bookmark.

        New records default to ``source="local"`` — they only become "cloud"
        once the user uploads them via Phase B2.
        """
        if self._find_category(category_id) is None:
            category_id = "default"

        now = _now_iso()
        from datetime import date
        bm = Bookmark(
            id=str(uuid.uuid4()),
            name=name,
            lat=lat,
            lng=lng,
            country=country,
            note=note,
            category_id=category_id,
            created_at=now,
            last_used_at=now,
            added_by=added_by,
            added_at=added_at or date.today().isoformat(),
            source="local",
        )
        self.store.bookmarks.append(bm)
        self._save()
        return bm

    def update_bookmark(self, bm_id: str, **kwargs: object) -> Bookmark | None:
        """Update a bookmark's fields. Returns ``None`` if not found."""
        bm = self._find_bookmark(bm_id)
        if bm is None:
            return None

        allowed = {"name", "lat", "lng", "country", "note", "category_id",
                   "last_used_at", "added_by", "added_at", "source"}
        for key, value in kwargs.items():
            if key in allowed and value is not None:
                setattr(bm, key, value)

        self._save()
        return bm

    def delete_bookmark(self, bm_id: str) -> bool:
        """Delete a bookmark by ID."""
        before = len(self.store.bookmarks)
        self.store.bookmarks = [b for b in self.store.bookmarks if b.id != bm_id]
        if len(self.store.bookmarks) < before:
            self._save()
            return True
        return False

    def list_bookmarks(self) -> list[Bookmark]:
        return list(self.store.bookmarks)

    def move_bookmarks(
        self,
        bookmark_ids: list[str],
        target_category_id: str,
    ) -> int:
        """Move multiple bookmarks to *target_category_id*.

        Returns the number of bookmarks actually moved.
        """
        if self._find_category(target_category_id) is None:
            logger.warning("Target category %s does not exist", target_category_id)
            return 0

        moved = 0
        ids_set = set(bookmark_ids)
        for bm in self.store.bookmarks:
            if bm.id in ids_set and bm.category_id != target_category_id:
                bm.category_id = target_category_id
                moved += 1

        if moved:
            self._save()
        return moved

    def _find_bookmark(self, bm_id: str) -> Bookmark | None:
        return next((b for b in self.store.bookmarks if b.id == bm_id), None)

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    def export_json(self) -> str:
        """Serialise the entire store to a JSON string."""
        return json.dumps(_serialize_grouped(self.store), ensure_ascii=False, indent=2)

    def import_json(self, data: str) -> int:
        """Import bookmarks (and optionally categories) from a JSON string.

        Merges into the existing store -- duplicates by ID are skipped.

        Returns the number of bookmarks imported.
        """
        try:
            raw = json.loads(data)
            if isinstance(raw, dict) and "categories" in raw and "bookmarks" in raw:
                incoming = BookmarkStore(**raw)
            elif isinstance(raw, dict):
                incoming = _load_grouped_style(raw)
            else:
                raise ValueError("unsupported bookmark JSON shape")
        except Exception as exc:
            logger.error("Invalid bookmark JSON: %s", exc)
            return 0

        existing_cat_ids = {c.id for c in self.store.categories}
        for cat in incoming.categories:
            if cat.id not in existing_cat_ids:
                self.store.categories.append(cat)
                existing_cat_ids.add(cat.id)

        existing_bm_ids = {b.id for b in self.store.bookmarks}
        imported = 0
        for bm in incoming.bookmarks:
            if bm.id not in existing_bm_ids:
                # Ensure the bookmark's category exists
                if bm.category_id not in existing_cat_ids:
                    bm.category_id = "default"
                self.store.bookmarks.append(bm)
                existing_bm_ids.add(bm.id)
                imported += 1

        if imported:
            self._save()
        logger.info("Imported %d bookmarks", imported)
        return imported
