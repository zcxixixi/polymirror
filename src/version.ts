import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/** Repository root (contains package.json). Works from src/ or dist/. */
export function getProjectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Local app version from package.json (SemVer). */
export function getAppVersion(): string {
  if (cached) return cached;
  const pkg = JSON.parse(readFileSync(join(getProjectRoot(), "package.json"), "utf8")) as {
    version?: string;
  };
  cached = pkg.version?.trim() || "0.0.0";
  return cached;
}

/** Test helper — clear memoized version. */
export function resetAppVersionCache(): void {
  cached = null;
}

/**
 * Parse leading major.minor.patch from a version or tag (e.g. `v1.2.3-beta`).
 * Returns null if not parseable.
 */
export function parseSemver(version: string): [number, number, number] | null {
  const m = version
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `latest` is a higher SemVer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

export function normalizeVersionLabel(version: string): string {
  return version.trim().replace(/^v/i, "");
}
