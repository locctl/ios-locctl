import {
  listDevices,
  isIOS17OrAbove,
  isTunnelRunning,
  startTunneld,
  DeviceInfo,
} from "./device";
import { setLocation, clearLocation, cleanup } from "./location";
import { move } from "./movement";
import { Coord, haversine, getCooldown } from "./geo";
import { savePosition, loadPosition, clearSavedPosition } from "./state";

const [, , command, ...rest] = process.argv;


function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function parseCoord(value: string): Coord {
  const [lat, lng] = value.split(",").map(Number);
  if (isNaN(lat) || isNaN(lng)) {
    throw new Error(`Invalid coordinate: ${value}. Expected: lat,lng`);
  }
  return { lat, lng };
}

async function getDevice(): Promise<{ device: DeviceInfo; ios17: boolean }> {
  const devices = await listDevices();
  if (devices.length === 0) {
    console.error("No iPhone connected. Check USB cable and trust prompt.");
    process.exit(1);
  }
  const device = devices[0];
  const ios17 = isIOS17OrAbove(device.ProductVersion);

  console.log(`Device: ${device.DeviceName} (iOS ${device.ProductVersion})`);

  if (ios17) {
    const tunnel = await isTunnelRunning();
    if (!tunnel) {
      console.log("iOS 17+ detected. Starting tunneld (will ask for password)...");
      await startTunneld();
      console.log("tunneld started.");
    }
  }

  return { device, ios17 };
}

async function main() {
  switch (command) {
    case "devices": {
      const devices = await listDevices();
      if (devices.length === 0) {
        console.log("No devices found.");
      } else {
        for (const d of devices) {
          console.log(
            `- ${d.DeviceName} | iOS ${d.ProductVersion} | ${d.UniqueDeviceID}`
          );
        }
      }
      break;
    }

    case "jump": {
      const args = parseArgs(rest);
      let lat: number;
      let lng: number;

      // Support shorthand: pnpm jump 25.033,121.565
      if (rest[0] && !rest[0].startsWith("--")) {
        const coord = parseCoord(rest[0]);
        lat = coord.lat;
        lng = coord.lng;
      } else if (args.lat && args.lng) {
        lat = Number(args.lat);
        lng = Number(args.lng);
        if (isNaN(lat) || isNaN(lng)) {
          console.error("lat and lng must be numbers.");
          process.exit(1);
        }
      } else {
        console.error("Usage: pnpm jump 25.033,121.565\n       pnpm jump --lat=25.033 --lng=121.565");
        process.exit(1);
      }

      const { ios17 } = await getDevice();
      const lastPos = loadPosition();
      if (lastPos) {
        const dist = haversine(lastPos, { lat, lng });
        console.log(`Last position: ${lastPos.lat}, ${lastPos.lng}`);
        console.log(`Jump distance: ${dist.toFixed(1)} km | Cooldown: ${getCooldown(dist).text}`);
      }
      console.log(`Setting location: ${lat}, ${lng}`);
      await setLocation(lat, lng, ios17);
      savePosition({ lat, lng });
      console.log("Location set. Press Ctrl+C to stop and restore real GPS.");
      process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
      });
      // Keep process alive
      await new Promise(() => {});
      break;
    }

    case "move": {
      const args = parseArgs(rest);
      let from: Coord;
      let to: Coord;
      let speedKmh: number;

      // Support shorthand: pnpm move 25.040,121.570 60
      if (rest[0] && !rest[0].startsWith("--")) {
        to = parseCoord(rest[0]);
        speedKmh = rest[1] ? Number(rest[1]) : 5;
        const lastPos = loadPosition();
        if (!lastPos) {
          console.error("No saved position. Use --from to specify start point.");
          process.exit(1);
        }
        from = lastPos;
        console.log(`From last position: ${from.lat}, ${from.lng}`);
      } else if (args.to) {
        to = parseCoord(args.to);
        speedKmh = Number(args.speed || "5");
        if (args.from) {
          from = parseCoord(args.from);
        } else {
          const lastPos = loadPosition();
          if (!lastPos) {
            console.error("No saved position. Use --from to specify start point.");
            process.exit(1);
          }
          from = lastPos;
          console.log(`From last position: ${from.lat}, ${from.lng}`);
        }
      } else {
        console.error(
          "Usage: pnpm move 25.040,121.570 60\n" +
          "       pnpm move --to=25.040,121.570 --speed=5\n" +
          "       pnpm move --from=25.033,121.565 --to=25.040,121.570 --speed=5"
        );
        process.exit(1);
      }
      const dist = haversine(from, to);
      console.log(`Distance: ${dist.toFixed(1)} km`);

      const { ios17 } = await getDevice();
      await move({ from, to, speedKmh, ios17, onProgress: savePosition });
      // Hold position at destination
      console.log("Holding position. Press Ctrl+C to stop.");
      await setLocation(to.lat, to.lng, ios17);
      savePosition(to);
      process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
      });
      await new Promise(() => {});
      break;
    }

    case "distance": {
      const args = parseArgs(rest);
      let from: Coord;
      let to: Coord;

      // Support shorthand: pnpm distance 25.040,121.570
      if (rest[0] && !rest[0].startsWith("--")) {
        to = parseCoord(rest[0]);
        const lastPos = loadPosition();
        if (!lastPos) {
          console.error("No saved position. Use --from to specify start point.");
          process.exit(1);
        }
        from = lastPos;
        console.log(`From last position: ${from.lat}, ${from.lng}`);
      } else if (args.to) {
        to = parseCoord(args.to);
        if (args.from) {
          from = parseCoord(args.from);
        } else {
          const lastPos = loadPosition();
          if (!lastPos) {
            console.error("No saved position. Use --from to specify start point.");
            process.exit(1);
          }
          from = lastPos;
          console.log(`From last position: ${from.lat}, ${from.lng}`);
        }
      } else {
        console.error(
          "Usage: pnpm distance 25.040,121.570\n" +
          "       pnpm distance --from=lat,lng --to=lat,lng"
        );
        process.exit(1);
      }
      const dist = haversine(from, to);
      console.log(`Distance: ${dist.toFixed(1)} km | Cooldown: ${getCooldown(dist).text}`);
      break;
    }

    case "clear": {
      const { ios17 } = await getDevice();
      await clearLocation(ios17);
      clearSavedPosition();
      console.log("Location simulation cleared. Saved position removed.");
      break;
    }

    case "status": {
      const lastPos = loadPosition();
      if (lastPos) {
        console.log(`Last position: ${lastPos.lat}, ${lastPos.lng}`);
      } else {
        console.log("No saved position.");
      }
      break;
    }

    default:
      console.log(
        "Usage:\n" +
          "  pnpm devices                List connected iPhones\n" +
          "  pnpm status                 Show last saved position\n" +
          "  pnpm jump 25.033,121.565    Set location\n" +
          "  pnpm move 25.040,121.570 60 Move from last position (speed optional)\n" +
          "  pnpm distance 25.040,121.57 Calculate distance & cooldown\n" +
          "  pnpm clear                  Clear simulated location\n"
      );
      break;
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
