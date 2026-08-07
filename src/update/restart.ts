import { spawn } from "node:child_process";
import { getProjectRoot } from "../version.js";
import { resolveRestartMode, type RestartMode } from "./paths.js";
import { logInfo, logError } from "../notify/logger.js";

export function scheduleProcessRestart(delayMs = 900): RestartMode {
  const mode = resolveRestartMode();
  logInfo("Scheduling process restart after update", { mode, delayMs });

  if (mode === "none") {
    return mode;
  }

  if (mode === "exec") {
    try {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: getProjectRoot(),
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("Failed to spawn replacement process", { error: msg });
      throw new Error(`Restart spawn failed: ${msg}`);
    }
  }

  setTimeout(() => {
    process.exit(0);
  }, delayMs);

  return mode;
}
