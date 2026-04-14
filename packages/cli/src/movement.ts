import { writeFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { Coord, haversine, lerp, getCooldown } from "./geo";
import { buildPlayArgs } from "./device";

const UPDATE_INTERVAL_MS = 1000;

export interface MoveOptions {
  from: Coord;
  to: Coord;
  speedKmh: number;
  ios17: boolean;
  onProgress?: (coord: Coord) => void;
}

/** Generate a GPX file from interpolated points */
function generateGpx(points: { coord: Coord; time: Date }[]): string {
  const trackpoints = points
    .map(
      (p) =>
        `      <trkpt lat="${p.coord.lat}" lon="${p.coord.lng}"><time>${p.time.toISOString()}</time></trkpt>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ios-locctl">
  <trk>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>`;
}

/** Simulate movement from A to B using GPX play */
export async function move(opts: MoveOptions): Promise<void> {
  const { from, to, speedKmh, ios17, onProgress } = opts;

  if (speedKmh <= 0) {
    throw new Error("Speed must be greater than 0.");
  }

  const distanceKm = haversine(from, to);
  const durationMs = (distanceKm / speedKmh) * 3600 * 1000;
  const totalSteps = Math.max(1, Math.ceil(durationMs / UPDATE_INTERVAL_MS));
  const durationMin = durationMs / 1000 / 60;
  const cooldown = getCooldown(distanceKm);
  const cooldownCovered = durationMin >= cooldown.minutes;

  console.log(`ETA: ${durationMin.toFixed(1)} min | Speed: ${speedKmh} km/h | Cooldown: ${cooldown.text}`);
  if (cooldownCovered) {
    console.log("Cooldown will be covered by travel time.");
  } else {
    const waitMin = (cooldown.minutes - durationMin).toFixed(0);
    console.log(`Need to wait ${waitMin} min after arrival before actions.`);
  }

  // Generate waypoints
  const now = new Date();
  const points: { coord: Coord; time: Date }[] = [];

  for (let i = 0; i <= totalSteps; i++) {
    const t = i / totalSteps;
    const coord = lerp(from, to, t);
    const time = new Date(now.getTime() + i * UPDATE_INTERVAL_MS);
    points.push({ coord, time });
  }

  // Write GPX file
  const gpxPath = "/tmp/ios-locctl-route.gpx";
  const gpx = generateGpx(points);
  writeFileSync(gpxPath, gpx);

  console.log(`Generated ${totalSteps} waypoints\n`);

  // Play GPX via pymobiledevice3
  const args = buildPlayArgs(gpxPath, ios17);

  return new Promise((resolve, reject) => {
    const proc = spawn("pymobiledevice3", args, { stdio: "pipe" });

    // Log progress and save position
    const logInterval = setInterval(() => {
      const elapsed = (Date.now() - now.getTime()) / 1000 / 60;
      const t = Math.min(1, elapsed / durationMin);
      const pct = t * 100;
      const current = lerp(from, to, t);
      const remaining = haversine(current, to);
      console.log(
        `[${pct.toFixed(0)}%] ${elapsed.toFixed(1)}min | lat=${current.lat.toFixed(6)} lng=${current.lng.toFixed(6)} | remaining: ${remaining.toFixed(1)} km`
      );
      onProgress?.(current);
    }, Math.max(10000, durationMs / 10));

    proc.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.error(msg);
    });

    // Cleanup on Ctrl+C — save estimated position before exit
    const sigintHandler = () => {
      clearInterval(logInterval);
      const elapsed = (Date.now() - now.getTime()) / 1000 / 60;
      const t = Math.min(1, elapsed / durationMin);
      const current = lerp(from, to, t);
      onProgress?.(current);
      console.log(`\nStopped at: lat=${current.lat.toFixed(6)} lng=${current.lng.toFixed(6)}`);
      proc.kill("SIGTERM");
      try { unlinkSync(gpxPath); } catch {}
      process.exit(0);
    };
    process.on("SIGINT", sigintHandler);

    proc.on("close", (code) => {
      clearInterval(logInterval);
      process.removeListener("SIGINT", sigintHandler);
      try { unlinkSync(gpxPath); } catch {}
      if (code === 0) {
        onProgress?.(to);
        console.log("\nArrived.");
        resolve();
      } else {
        reject(new Error(`GPX play exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      clearInterval(logInterval);
      process.removeListener("SIGINT", sigintHandler);
      reject(err);
    });
  });
}
