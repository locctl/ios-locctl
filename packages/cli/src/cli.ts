/**
 * ios-locctl CLI — lightweight HTTP client that calls the backend API.
 * All device/location logic is handled by the backend (packages/backend).
 * Backend must be running: pnpm dev
 */

const API = "http://127.0.0.1:8777";

// ── HTTP helpers ────────────────────────────────────────

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, opts);
  } catch {
    console.error("Error: Backend not running. Start with: pnpm dev");
    process.exit(1);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ detail: res.statusText })) as any;
    const msg = typeof errBody.detail === "string" ? errBody.detail : errBody.detail?.message || res.statusText;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ── Geo helpers ─────────────────────────────────────────

interface Coord {
  lat: number;
  lng: number;
}

function haversine(a: Coord, b: Coord): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function getCooldown(km: number): string {
  if (km <= 1) return "1 min";
  if (km <= 5) return "2 min";
  if (km <= 10) return "6 min";
  if (km <= 25) return "11 min";
  if (km <= 50) return "22 min";
  if (km <= 100) return "35 min";
  if (km <= 250) return "53 min";
  if (km <= 500) return "1 hr";
  if (km <= 750) return "1 hr 18 min";
  if (km <= 1000) return "1.5 hr";
  return "2 hr";
}

function parseCoord(value: string): Coord {
  const [lat, lng] = value.split(",").map(Number);
  if (isNaN(lat) || isNaN(lng)) {
    throw new Error(`Invalid coordinate: ${value}. Expected: lat,lng`);
  }
  return { lat, lng };
}

// ── Commands ────────────────────────────────────────────

const [, , command, ...rest] = process.argv;

async function main() {
  switch (command) {
    case "devices": {
      const devices = await request<any[]>("GET", "/api/device/list");
      if (devices.length === 0) {
        console.log("No devices found.");
      } else {
        for (const d of devices) {
          const status = d.is_connected ? "●" : "○";
          const type = d.wifi_ip ? `WiFi ${d.wifi_ip}` : d.connection_type;
          console.log(`${status} ${d.name} | iOS ${d.ios_version} | ${type} | ${d.udid}`);
        }
      }
      break;
    }

    case "jump": {
      if (!rest[0]) {
        console.error("Usage: pnpm jump 25.033,121.565");
        process.exit(1);
      }
      const { lat, lng } = parseCoord(rest[0]);

      // Show distance from last position
      try {
        const status = await request<any>("GET", "/api/location/status");
        if (status.current_position) {
          const last = status.current_position;
          const dist = haversine(last, { lat, lng });
          console.log(`Last: ${last.lat.toFixed(4)}, ${last.lng.toFixed(4)}`);
          console.log(`Jump: ${dist.toFixed(1)} km | Cooldown: ${getCooldown(dist)}`);
        }
      } catch {}

      console.log(`Setting: ${lat}, ${lng}`);
      await request("POST", "/api/location/teleport", { lat, lng });
      console.log("Location set.");
      break;
    }

    case "move": {
      if (!rest[0]) {
        console.error("Usage: pnpm move 25.040,121.570 60");
        process.exit(1);
      }
      const to = parseCoord(rest[0]);
      const speed = rest[1] ? Number(rest[1]) : 5;
      const mode = speed > 20 ? "driving" : speed > 8 ? "running" : "walking";

      console.log(`Moving to ${to.lat}, ${to.lng} at ${speed} km/h (${mode})`);
      await request("POST", "/api/location/navigate", {
        lat: to.lat,
        lng: to.lng,
        mode,
        speed_kmh: speed,
      });
      console.log("Navigation started.");
      break;
    }

    case "stop": {
      await request("POST", "/api/location/stop");
      console.log("Simulation stopped.");
      break;
    }

    case "status": {
      const status = await request<any>("GET", "/api/location/status");
      if (status.current_position) {
        const p = status.current_position;
        console.log(`Position: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
        console.log(`State: ${status.state}`);
        if (status.speed_mps) console.log(`Speed: ${(status.speed_mps * 3.6).toFixed(1)} km/h`);
      } else {
        console.log("No position set.");
      }
      break;
    }

    case "distance": {
      if (!rest[0]) {
        console.error("Usage: pnpm distance 25.040,121.570");
        process.exit(1);
      }
      const to = parseCoord(rest[0]);

      try {
        const status = await request<any>("GET", "/api/location/status");
        if (status.current_position) {
          const from = status.current_position;
          const dist = haversine(from, to);
          console.log(`From: ${from.lat.toFixed(4)}, ${from.lng.toFixed(4)}`);
          console.log(`Distance: ${dist.toFixed(1)} km | Cooldown: ${getCooldown(dist)}`);
        } else {
          console.log("No current position. Jump to a location first.");
        }
      } catch {
        console.log("No current position. Jump to a location first.");
      }
      break;
    }

    case "clear": {
      await request("POST", "/api/location/stop");
      console.log("Location simulation cleared.");
      break;
    }

    default:
      console.log(
        "ios-locctl CLI (requires backend: pnpm dev)\n\n" +
          "Usage:\n" +
          "  pnpm devices                List connected devices\n" +
          "  pnpm status                 Show current position\n" +
          "  pnpm jump 25.033,121.565    Teleport to coordinate\n" +
          "  pnpm move 25.040,121.570 60 Navigate (speed km/h)\n" +
          "  pnpm distance 25.040,121.57 Calculate distance & cooldown\n" +
          "  pnpm stop                   Stop simulation\n" +
          "  pnpm clear                  Clear simulated location\n"
      );
      break;
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
