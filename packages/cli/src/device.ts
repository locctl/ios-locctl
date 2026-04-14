import { execFile, ChildProcess, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const CMD = "pymobiledevice3";

export interface DeviceInfo {
  DeviceName: string;
  ProductVersion: string;
  UniqueDeviceID: string;
  [key: string]: unknown;
}

/** List connected USB devices */
export async function listDevices(): Promise<DeviceInfo[]> {
  const { stdout } = await execFileAsync(CMD, ["usbmux", "list"]);
  return JSON.parse(stdout);
}

/** Determine if the device is iOS 17+ */
export function isIOS17OrAbove(version: string): boolean {
  const major = parseInt(version.split(".")[0], 10);
  return major >= 17;
}

/** Build the simulate-location command args based on iOS version */
export function buildSetArgs(
  lat: number,
  lng: number,
  ios17: boolean
): string[] {
  if (ios17) {
    return [
      "developer",
      "dvt",
      "simulate-location",
      "set",
      "--tunnel",
      "",
      "--",
      lat.toString(),
      lng.toString(),
    ];
  }
  return [
    "developer",
    "simulate-location",
    "set",
    "--",
    lat.toString(),
    lng.toString(),
  ];
}

export function buildClearArgs(ios17: boolean): string[] {
  if (ios17) {
    return [
      "developer",
      "dvt",
      "simulate-location",
      "clear",
      "--tunnel",
      "",
    ];
  }
  return ["developer", "simulate-location", "clear"];
}

export function buildPlayArgs(gpxPath: string, ios17: boolean): string[] {
  if (ios17) {
    return ["developer", "dvt", "simulate-location", "play", "--tunnel", "", gpxPath];
  }
  return ["developer", "simulate-location", "play", gpxPath];
}

/** Spawn a long-lived set-location process */
export function spawnSetLocation(
  lat: number,
  lng: number,
  ios17: boolean
): ChildProcess {
  const args = buildSetArgs(lat, lng, ios17);
  return spawn(CMD, args, { stdio: "pipe" });
}

/** Run clear-location (one-shot) */
export async function runClearLocation(ios17: boolean): Promise<void> {
  const args = buildClearArgs(ios17);
  await execFileAsync(CMD, args);
}

/** Check if tunneld is likely running (iOS 17+ only) */
export async function isTunnelRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "pymobiledevice3.*tunneld"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Start tunneld via osascript (prompts for admin password via macOS dialog) */
export async function startTunneld(): Promise<void> {
  const pymobiledevice3Path = await findPymobiledevice3Path();
  const script = `do shell script "${pymobiledevice3Path} remote tunneld" with administrator privileges`;

  const proc = spawn("osascript", ["-e", script], {
    stdio: "ignore",
    detached: true,
  });
  proc.unref();

  // Wait for tunneld to actually start
  console.log("Waiting for tunneld to start...");
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (await isTunnelRunning()) {
      return;
    }
  }
  throw new Error("tunneld did not start within 15 seconds.");
}

async function findPymobiledevice3Path(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["pymobiledevice3"]);
    return stdout.trim();
  } catch {
    return "pymobiledevice3";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
