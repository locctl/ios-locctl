import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Coord } from "./geo";

const SETTINGS_FILE = join(__dirname, "..", "..", "..", "data", "settings.json");

interface Settings {
  last_position?: { lat: number; lng: number };
  coord_format?: string;
  cooldown_enabled?: boolean;
}

export function savePosition(coord: Coord): void {
  let settings: Settings = {};
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf-8");
    settings = JSON.parse(raw);
  } catch {}

  settings.last_position = { lat: coord.lat, lng: coord.lng };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function loadPosition(): Coord | null {
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf-8");
    const settings: Settings = JSON.parse(raw);
    if (settings.last_position) {
      return { lat: settings.last_position.lat, lng: settings.last_position.lng };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSavedPosition(): void {
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf-8");
    const settings: Settings = JSON.parse(raw);
    delete settings.last_position;
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch {}
}
