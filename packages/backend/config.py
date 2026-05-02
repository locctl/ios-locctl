import os
import shutil
import sys
from pathlib import Path
from typing import TypedDict

# ── Paths ────────────────────────────────────────────────
# Dev mode: data/ lives at repo root next to packages/.
# Frozen mode (Electron .app bundle): ~/.ios-locctl/data/ holds mutable user
# state (bookmarks edits, settings); on first launch we seed it from the
# read-only copy bundled inside the .app via Electron's IOSLOCCTL_RESOURCES_PATH.
PROJECT_ROOT = Path(__file__).parent.parent.parent

if getattr(sys, "frozen", False):
    DATA_DIR = Path.home() / ".ios-locctl" / "data"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _bundle_root = Path(os.environ.get("IOSLOCCTL_RESOURCES_PATH", "")) if os.environ.get("IOSLOCCTL_RESOURCES_PATH") else None
    if _bundle_root and _bundle_root.exists():
        # Seed bookmarks.json from the .app bundle on first run only — never
        # overwrite a user's edits on subsequent launches.
        _seed = _bundle_root / "data" / "bookmarks.json"
        _target = DATA_DIR / "bookmarks.json"
        if _seed.exists() and not _target.exists():
            try:
                shutil.copy2(_seed, _target)
            except Exception:
                pass  # non-fatal; backend will run with empty bookmarks
else:
    DATA_DIR = PROJECT_ROOT / "data"
    DATA_DIR.mkdir(exist_ok=True)

SETTINGS_FILE = DATA_DIR / "settings.json"
BOOKMARKS_FILE = DATA_DIR / "bookmarks.json"
SHEETS_CONFIG_FILE = DATA_DIR / "sheets_config.json"
SHEETS_SYNC_META_FILE = DATA_DIR / "sheets_sync_meta.json"
BOOKMARKS_LOCAL_BACKUP_FILE = DATA_DIR / "bookmarks.local_backup.json"

# Default community-curated bookmarks Sheet — comes pre-configured so a
# fresh install can sync without the user having to find a URL anywhere.
# User's own sheet_id (set via the in-app config modal) overrides this.
DEFAULT_SHEET_ID = "1GDTyBgBzkBiOAEc8GdlaS7pKmPWq2cMdYNLjqNwjdiU"
DEFAULT_SHEET_TAB = "bookmarks"

# OSRM
OSRM_BASE_URL = "https://router.project-osrm.org"

# Nominatim
NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org"
NOMINATIM_USER_AGENT = "ios-locctl/1.0"


class SpeedProfile(TypedDict):
    """Runtime speed profile consumed by the simulation engine."""
    speed_mps: float        # metres per second
    jitter: float           # ± jitter added to each tick for realism (metres)
    update_interval: float  # tick period (seconds)


# Speed profiles (m/s)
SPEED_PROFILES: dict[str, SpeedProfile] = {
    "walking": {"speed_mps": 1.4, "jitter": 0.3, "update_interval": 1.0},
    "running": {"speed_mps": 2.8, "jitter": 0.5, "update_interval": 1.0},
    "bicycling": {"speed_mps": 4.2, "jitter": 0.6, "update_interval": 0.8},
    "driving": {"speed_mps": 11.1, "jitter": 1.0, "update_interval": 0.5},
}


def make_speed_profile(speed_kmh: float) -> SpeedProfile:
    """Build a speed profile dict from a km/h value."""
    speed_mps = speed_kmh / 3.6
    jitter = min(speed_mps * 0.2, 1.5)
    update_interval = 0.5 if speed_mps > 5 else 1.0
    return {"speed_mps": speed_mps, "jitter": jitter, "update_interval": update_interval}


def resolve_speed_profile(
    profile_name: str,
    speed_kmh: float | None = None,
    speed_min_kmh: float | None = None,
    speed_max_kmh: float | None = None,
) -> SpeedProfile:
    """Return a speed profile, picking a random km/h from the range if provided.
    Precedence: range > fixed custom > mode default."""
    import random
    if speed_min_kmh is not None and speed_max_kmh is not None:
        lo, hi = sorted((float(speed_min_kmh), float(speed_max_kmh)))
        if lo <= 0:
            lo = 0.1
        return make_speed_profile(random.uniform(lo, hi))
    if speed_kmh:
        return make_speed_profile(speed_kmh)
    return SPEED_PROFILES[profile_name]


# Cooldown table: (max_distance_km, cooldown_seconds)
COOLDOWN_TABLE = [
    (1, 0),
    (5, 30),
    (10, 120),
    (25, 300),
    (100, 900),
    (250, 1500),
    (500, 2700),
    (750, 3600),
    (1000, 5400),
    (float("inf"), 7200),
]

# Reconnect
RECONNECT_BASE_DELAY = 2.0
RECONNECT_MAX_DELAY = 60.0
RECONNECT_MAX_RETRIES = 30

# Default location (Taipei City Hall)
DEFAULT_LOCATION = {"lat": 25.0375, "lng": 121.5637}

# Server
API_HOST = "0.0.0.0"
API_PORT = 8777
