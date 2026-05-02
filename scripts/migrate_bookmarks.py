#!/usr/bin/env python3
"""One-shot Phase A migration for data/bookmarks.json.

Transforms the legacy 5-field shape (name/lat/lng/address/note) into the
8-field shape used from Phase A onward:
    name | lat | lng | country | category | added_by | added_at | note

Changes applied:
  • Category "預設" → "未分類"
  • Category "隱藏明信片" merged into "明信片菇點"; affected bookmarks get
    "（掃描才出現）" appended to their note.
  • New field `country` is seeded from the existing free-form `address` value
    (so "日本兵庫縣淡路市" stays as-is — Sheets editors can clean up later).
  • New field `category` carries the human-readable category name on each
    bookmark (so the upcoming single-tab Sheets layout can sort/filter by it).
  • New fields `added_by` / `added_at` are stamped with the values you pass
    via --by (default "mars") and today's date.
  • New field `source` is set to "cloud" — these are the seed knowledge base,
    everyone using the app sees them as the shared baseline.
  • The `address` field is dropped (replaced by `country`).

Outputs:
  • data/bookmarks.json — overwritten with the new shape
  • data/bookmarks_pre_migration.json — full backup of the original file
  • scripts/sheets_seed/bookmarks.csv — single 8-column CSV ready to paste
    into the Google Sheets template (one header row + one row per bookmark).

Idempotent: re-running on already-migrated data is a no-op (detected by
absence of `address` in any record).
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BOOKMARKS_FILE = REPO_ROOT / "data" / "bookmarks.json"
BACKUP_FILE = REPO_ROOT / "data" / "bookmarks_pre_migration.json"
CSV_OUT = REPO_ROOT / "scripts" / "sheets_seed" / "bookmarks.csv"

# Old → new category renames; absent keys pass through unchanged.
CATEGORY_RENAMES = {"預設": "未分類"}
# Old categories whose contents merge into another category. The merged-in
# bookmarks get a note suffix so Sheets editors know why they look unusual.
CATEGORY_MERGES: dict[str, tuple[str, str]] = {
    # source_category → (target_category, note_suffix)
    "隱藏明信片": ("明信片菇點", "（掃描才出現）"),
}

CSV_FIELDS = ["name", "lat", "lng", "country", "category", "added_by", "added_at", "note"]


def is_already_migrated(data: dict) -> bool:
    """Return True if no record in any category still has an 'address' field
    AND every record has at least one of the new fields populated. We use a
    permissive check so partial re-runs still progress."""
    for items in data.values():
        if not isinstance(items, list):
            continue
        for b in items:
            if isinstance(b, dict) and "address" in b:
                return False
    return True


def migrate(by: str, today: str) -> tuple[dict, list[dict]]:
    """Read bookmarks.json, return (new_grouped_dict, flat_list_for_csv)."""
    raw = json.loads(BOOKMARKS_FILE.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SystemExit(f"Expected dict-of-lists, got {type(raw).__name__}")

    if is_already_migrated(raw):
        print("✓ Already migrated (no `address` field found). Nothing to do.")
        return raw, []

    new_grouped: dict[str, list[dict]] = {}
    flat: list[dict] = []

    for old_cat, items in raw.items():
        if not isinstance(items, list):
            continue
        target_cat = CATEGORY_RENAMES.get(old_cat, old_cat)
        note_suffix = ""
        if old_cat in CATEGORY_MERGES:
            target_cat, note_suffix = CATEGORY_MERGES[old_cat]

        bucket = new_grouped.setdefault(target_cat, [])
        for b in items:
            if not isinstance(b, dict):
                continue
            address = (b.get("address") or "").strip()
            note = (b.get("note") or "").strip()
            if note_suffix:
                note = f"{note} {note_suffix}".strip()
            new_record = {
                "name": (b.get("name") or "").strip(),
                "lat": float(b["lat"]),
                "lng": float(b["lng"]),
                "country": address,    # carry old `address` as free-form country
                "added_by": by,
                "added_at": today,
                "source": "cloud",
                "note": note,
            }
            bucket.append(new_record)
            # CSV row carries category explicitly because the Sheets layout is
            # one tab where rows from all categories live together.
            flat.append({
                "name": new_record["name"],
                "lat": new_record["lat"],
                "lng": new_record["lng"],
                "country": new_record["country"],
                "category": target_cat,
                "added_by": new_record["added_by"],
                "added_at": new_record["added_at"],
                "note": new_record["note"],
            })

    return new_grouped, flat


def write_outputs(new_grouped: dict, flat: list[dict]) -> None:
    if not flat:
        return  # nothing to do — already migrated case

    BACKUP_FILE.write_text(BOOKMARKS_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"✓ Backup → {BACKUP_FILE.relative_to(REPO_ROOT)}")

    BOOKMARKS_FILE.write_text(
        json.dumps(new_grouped, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"✓ Wrote new {BOOKMARKS_FILE.relative_to(REPO_ROOT)} ({sum(len(v) for v in new_grouped.values())} bookmarks)")

    CSV_OUT.parent.mkdir(parents=True, exist_ok=True)
    with CSV_OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for row in flat:
            w.writerow(row)
    print(f"✓ Wrote seed CSV → {CSV_OUT.relative_to(REPO_ROOT)} ({len(flat)} rows)")
    print()
    print("Next: open Google Sheets, create a tab named `bookmarks`,")
    print("then paste the contents of scripts/sheets_seed/bookmarks.csv into it.")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--by", default="mars", help="Value for `added_by` on every existing bookmark (default: mars)")
    p.add_argument("--date", default=date.today().isoformat(), help="Value for `added_at` (default: today YYYY-MM-DD)")
    args = p.parse_args()

    if not BOOKMARKS_FILE.exists():
        print(f"✗ {BOOKMARKS_FILE} does not exist", file=sys.stderr)
        return 1

    new_grouped, flat = migrate(args.by, args.date)
    write_outputs(new_grouped, flat)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
