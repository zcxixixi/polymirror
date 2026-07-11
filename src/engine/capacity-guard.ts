import { statfsSync, statSync } from "node:fs";

const GiB = 1024 ** 3;
const WARNING_AVAILABLE_BYTES = 20 * GiB;
const SETTLE_ONLY_AVAILABLE_BYTES = 10 * GiB;
const WARNING_PROJECTED_DAYS = 7;
const SETTLE_ONLY_PROJECTED_DAYS = 3;
const RATE_WARMUP_MS = 15 * 60_000;
const RATE_WINDOW_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export type CapacityStatus = "OK" | "WARNING" | "SETTLE_ONLY";

export type CapacityReason =
  | "available_below_20_gib"
  | "available_below_10_gib"
  | "projected_below_7_days"
  | "projected_below_3_days";

export interface CapacityAssessmentInput {
  availableBytes: number;
  growthBytesPerHour: number;
}

export interface CapacityAssessment {
  status: CapacityStatus;
  projectedDays: number | null;
  reasons: CapacityReason[];
}

export interface RollingByteSample {
  bytes: number;
  sampledAt: number;
}

export type RollingByteRateDirection = "increase" | "decrease";

export function assessCapacity(input: CapacityAssessmentInput): CapacityAssessment {
  if (!Number.isFinite(input.availableBytes) || input.availableBytes < 0) {
    throw new RangeError("availableBytes must be a finite non-negative number");
  }
  if (!Number.isFinite(input.growthBytesPerHour)) {
    throw new RangeError("growthBytesPerHour must be finite");
  }

  const projectedDays = input.growthBytesPerHour > 0
    ? input.availableBytes / input.growthBytesPerHour / 24
    : null;
  const reasons: CapacityReason[] = [];
  let status: CapacityStatus = "OK";

  if (input.availableBytes < SETTLE_ONLY_AVAILABLE_BYTES) {
    status = "SETTLE_ONLY";
    reasons.push("available_below_10_gib");
  } else if (input.availableBytes < WARNING_AVAILABLE_BYTES) {
    status = "WARNING";
    reasons.push("available_below_20_gib");
  }

  if (projectedDays !== null && projectedDays < SETTLE_ONLY_PROJECTED_DAYS) {
    status = "SETTLE_ONLY";
    reasons.push("projected_below_3_days");
  } else if (projectedDays !== null && projectedDays < WARNING_PROJECTED_DAYS) {
    if (status === "OK") status = "WARNING";
    reasons.push("projected_below_7_days");
  }

  return { status, projectedDays, reasons };
}

export function readFilesystemCapacity(path: string): number {
  const stats = statfsSync(path, { bigint: true });
  const availableBytes = stats.bavail * stats.bsize;
  if (availableBytes < 0n || availableBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("filesystem available bytes cannot be represented safely as a number");
  }
  return Number(availableBytes);
}

export function readSqliteFootprintBytes(dbPath: string): number {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((total, path) => {
    try {
      return total + statSync(path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return total;
      throw error;
    }
  }, 0);
}

export function recordRollingByteRate(
  samples: RollingByteSample[],
  sample: RollingByteSample,
  direction: RollingByteRateDirection
): number | null {
  if (!Number.isFinite(sample.bytes) || sample.bytes < 0) {
    throw new RangeError("sample bytes must be a finite non-negative number");
  }
  if (!Number.isFinite(sample.sampledAt) || sample.sampledAt < 0) {
    throw new RangeError("sampledAt must be a finite non-negative number");
  }

  const latest = samples.at(-1);
  if (latest && sample.sampledAt < latest.sampledAt) {
    throw new RangeError("sampledAt must not move backwards");
  }
  if (latest?.sampledAt === sample.sampledAt) {
    samples[samples.length - 1] = sample;
  } else {
    samples.push(sample);
  }

  const cutoff = sample.sampledAt - RATE_WINDOW_MS;
  while (samples.length > 1 && samples[0]!.sampledAt < cutoff) {
    samples.shift();
  }

  const baseline = samples[0]!;
  const elapsedMs = sample.sampledAt - baseline.sampledAt;
  if (elapsedMs < RATE_WARMUP_MS) return null;

  const deltaBytes = direction === "increase"
    ? sample.bytes - baseline.bytes
    : baseline.bytes - sample.bytes;
  return Math.max(0, deltaBytes) * HOUR_MS / elapsedMs;
}

export function selectProjectedGrowthRate(
  accountGrowthRates: Array<number | null | undefined>,
  filesystemDeclineBytesPerHour: number | null
): number {
  const sqliteGrowthBytesPerHour = accountGrowthRates.reduce<number>((total, rate) => {
    if (rate === null || rate === undefined) return total;
    if (!Number.isFinite(rate) || rate < 0) {
      throw new RangeError("account growth rates must be finite non-negative numbers");
    }
    return total + rate;
  }, 0);
  if (
    filesystemDeclineBytesPerHour !== null
    && (!Number.isFinite(filesystemDeclineBytesPerHour) || filesystemDeclineBytesPerHour < 0)
  ) {
    throw new RangeError("filesystem decline rate must be a finite non-negative number");
  }
  // Runway is a cohort-data gate: image pulls, backups, and other host writes
  // must not make a healthy SQLite cohort look as if it will fill the disk.
  // The whole-filesystem decline remains a separately exposed diagnostic.
  return sqliteGrowthBytesPerHour;
}
