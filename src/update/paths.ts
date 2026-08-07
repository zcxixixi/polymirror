import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot } from "../version.js";

export function updatesDir(): string {
  return join(getProjectRoot(), "data", "updates");
}

export function updateStatePath(): string {
  return join(updatesDir(), "state.json");
}

export function updateDownloadsDir(): string {
  return join(updatesDir(), "downloads");
}

export function updateStagingDir(): string {
  return join(updatesDir(), "staging");
}

export function updateRollbackDir(): string {
  return join(updatesDir(), "rollback");
}

export function isRunningInDocker(): boolean {
  if (process.env.POLYMIRROR_IN_DOCKER?.trim() === "1") return true;
  return existsSync("/.dockerenv");
}

export function selfUpdateEnabled(): boolean {
  const v = process.env.POLYMIRROR_SELF_UPDATE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type RestartMode = "exec" | "exit" | "none";

export function resolveRestartMode(): RestartMode {
  const v = process.env.POLYMIRROR_UPDATE_RESTART?.trim().toLowerCase();
  if (v === "exec" || v === "exit" || v === "none") return v;
  // systemd sets INVOCATION_ID — let the unit Restart= policy bring us back.
  if (process.env.INVOCATION_ID) return "exit";
  return "exec";
}

/** Paths that must never be overwritten by release extract or rollback. */
export const PRESERVE_NAMES = new Set([
  ".env",
  ".env.local",
  "config.yaml",
  "config.yaml.bak",
  "config.local.yaml",
  "data",
  ".git",
  "node_modules",
]);
