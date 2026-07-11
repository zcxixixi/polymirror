import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessCapacity,
  recordRollingByteRate,
  readFilesystemCapacity,
  readSqliteFootprintBytes,
  selectProjectedGrowthRate,
} from "../src/engine/capacity-guard.js";

const GiB = 1024 ** 3;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("assessCapacity", () => {
  it("returns OK when both free space and projected runway clear the warning gates", () => {
    const result = assessCapacity({
      availableBytes: 30 * GiB,
      growthBytesPerHour: 0.1 * GiB,
    });

    expect(result.status).toBe("OK");
    expect(result.projectedDays).toBeCloseTo(12.5);
    expect(result.reasons).toEqual([]);
  });

  it("warns below 20 GiB without escalating at the 10 GiB boundary", () => {
    expect(assessCapacity({
      availableBytes: 19 * GiB,
      growthBytesPerHour: 0,
    })).toEqual({
      status: "WARNING",
      projectedDays: null,
      reasons: ["available_below_20_gib"],
    });

    const exactTen = assessCapacity({
      availableBytes: 10 * GiB,
      growthBytesPerHour: 0,
    });
    expect(exactTen.status).toBe("WARNING");
    expect(exactTen.reasons).toEqual(["available_below_20_gib"]);
  });

  it("settles only below 10 GiB and gives the severe reason once", () => {
    const result = assessCapacity({
      availableBytes: 10 * GiB - 1,
      growthBytesPerHour: 0,
    });

    expect(result).toEqual({
      status: "SETTLE_ONLY",
      projectedDays: null,
      reasons: ["available_below_10_gib"],
    });
  });

  it("warns below seven projected days and settles only below three", () => {
    const warning = assessCapacity({
      availableBytes: 100 * GiB,
      growthBytesPerHour: 100 * GiB / (6 * 24),
    });
    expect(warning.status).toBe("WARNING");
    expect(warning.projectedDays).toBeCloseTo(6);
    expect(warning.reasons).toEqual(["projected_below_7_days"]);

    const exactThree = assessCapacity({
      availableBytes: 100 * GiB,
      growthBytesPerHour: 100 * GiB / (3 * 24),
    });
    expect(exactThree.status).toBe("WARNING");
    expect(exactThree.reasons).toEqual(["projected_below_7_days"]);

    const settleOnly = assessCapacity({
      availableBytes: 100 * GiB,
      growthBytesPerHour: 100 * GiB / (2 * 24),
    });
    expect(settleOnly.status).toBe("SETTLE_ONLY");
    expect(settleOnly.projectedDays).toBeCloseTo(2);
    expect(settleOnly.reasons).toEqual(["projected_below_3_days"]);
  });

  it("uses the strongest status while retaining independent severe and warning reasons", () => {
    const result = assessCapacity({
      availableBytes: 9 * GiB,
      growthBytesPerHour: 9 * GiB / (5 * 24),
    });

    expect(result.status).toBe("SETTLE_ONLY");
    expect(result.reasons).toEqual([
      "available_below_10_gib",
      "projected_below_7_days",
    ]);
  });

  it.each([0, -1, -GiB])("returns no projection when growth is %s", (growthBytesPerHour) => {
    const result = assessCapacity({
      availableBytes: 25 * GiB,
      growthBytesPerHour,
    });

    expect(result).toEqual({ status: "OK", projectedDays: null, reasons: [] });
  });

  it("rejects impossible or non-finite measurements", () => {
    expect(() => assessCapacity({ availableBytes: -1, growthBytesPerHour: 0 }))
      .toThrow(/availableBytes/i);
    expect(() => assessCapacity({ availableBytes: Number.NaN, growthBytesPerHour: 0 }))
      .toThrow(/availableBytes/i);
    expect(() => assessCapacity({ availableBytes: GiB, growthBytesPerHour: Infinity }))
      .toThrow(/growthBytesPerHour/i);
  });
});

describe("readFilesystemCapacity", () => {
  it("returns available bytes as a number without writing to the filesystem", () => {
    const dir = mkdtempSync(join(tmpdir(), "polymirror-capacity-"));
    dirs.push(dir);
    const before = readdirSync(dir);

    const availableBytes = readFilesystemCapacity(dir);

    expect(typeof availableBytes).toBe("number");
    expect(Number.isFinite(availableBytes)).toBe(true);
    expect(availableBytes).toBeGreaterThan(0);
    expect(readdirSync(dir)).toEqual(before);
  });
});

describe("readSqliteFootprintBytes", () => {
  it("counts the SQLite main database, WAL, and SHM files", () => {
    const dir = mkdtempSync(join(tmpdir(), "polymirror-sqlite-footprint-"));
    dirs.push(dir);
    const dbPath = join(dir, "preview.sqlite");
    writeFileSync(dbPath, Buffer.alloc(11));
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(13));
    writeFileSync(`${dbPath}-shm`, Buffer.alloc(17));

    expect(readSqliteFootprintBytes(dbPath)).toBe(41);
  });

  it("treats absent SQLite sidecars as zero bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "polymirror-sqlite-footprint-"));
    dirs.push(dir);
    const dbPath = join(dir, "preview.sqlite");
    writeFileSync(dbPath, Buffer.alloc(19));

    expect(readSqliteFootprintBytes(dbPath)).toBe(19);
  });
});

describe("recordRollingByteRate", () => {
  const minute = 60_000;

  it("warms up for 15 minutes and uses the rolling baseline instead of the adjacent point", () => {
    const samples: Array<{ bytes: number; sampledAt: number }> = [];

    expect(recordRollingByteRate(samples, { bytes: 100, sampledAt: 0 }, "increase")).toBeNull();
    expect(recordRollingByteRate(samples, { bytes: 114, sampledAt: 14 * minute }, "increase"))
      .toBeNull();
    expect(recordRollingByteRate(samples, { bytes: 115, sampledAt: 15 * minute }, "increase"))
      .toBe(60);
    expect(recordRollingByteRate(samples, { bytes: 115, sampledAt: 30 * minute }, "increase"))
      .toBe(30);
  });

  it("never uses a baseline older than the 60 minute rolling window", () => {
    const samples: Array<{ bytes: number; sampledAt: number }> = [];
    recordRollingByteRate(samples, { bytes: 100, sampledAt: 0 }, "increase");
    recordRollingByteRate(samples, { bytes: 110, sampledAt: 15 * minute }, "increase");

    const rate = recordRollingByteRate(
      samples,
      { bytes: 120, sampledAt: 61 * minute },
      "increase"
    );

    expect(rate).toBeCloseTo(10 * 60 / 46);
    expect(samples[0]?.sampledAt).toBe(15 * minute);
  });

  it("tracks rolling filesystem free-space decline without an unchanged adjacent sample erasing it", () => {
    const samples: Array<{ bytes: number; sampledAt: number }> = [];
    recordRollingByteRate(samples, { bytes: 100, sampledAt: 0 }, "decrease");
    expect(recordRollingByteRate(samples, { bytes: 90, sampledAt: 15 * minute }, "decrease"))
      .toBe(40);
    expect(recordRollingByteRate(samples, { bytes: 90, sampledAt: 30 * minute }, "decrease"))
      .toBe(20);
  });
});

describe("selectProjectedGrowthRate", () => {
  it("uses the larger of aggregate SQLite growth and filesystem free-space decline", () => {
    expect(selectProjectedGrowthRate([100, 200, null], 250)).toBe(300);
    expect(selectProjectedGrowthRate([100, 0, null], 250)).toBe(250);
  });
});
