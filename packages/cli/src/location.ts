import { ChildProcess } from "child_process";
import { spawnSetLocation, runClearLocation } from "./device";

let activeProcess: ChildProcess | null = null;

/** Set simulated location. Spawns new process first, then kills old one to avoid GPS gap. */
export function setLocation(
  lat: number,
  lng: number,
  ios17: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const oldProcess = activeProcess;

    const proc = spawnSetLocation(lat, lng, ios17);
    activeProcess = proc;

    let resolved = false;
    let stderrOutput = "";

    proc.stderr?.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    proc.on("close", (code) => {
      if (activeProcess === proc) activeProcess = null;
      if (!resolved) {
        resolved = true;
        if (code === 0) resolve();
        else reject(new Error(stderrOutput || `set-location exited with code ${code}`));
      }
    });

    // Wait for new process to start, then kill old one
    setTimeout(() => {
      if (oldProcess && !oldProcess.killed) {
        oldProcess.kill("SIGTERM");
      }
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, 200);
  });
}

/** Clear simulated location */
export async function clearLocation(ios17: boolean): Promise<void> {
  killActiveProcess();
  await runClearLocation(ios17);
}

function killActiveProcess(): void {
  if (activeProcess && !activeProcess.killed) {
    activeProcess.kill("SIGTERM");
    activeProcess = null;
  }
}

/** Kill active process on exit (registered by caller, not automatically) */
export function cleanup(): void {
  killActiveProcess();
}
