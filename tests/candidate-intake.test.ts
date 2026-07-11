import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityType,
  type Activity as SdkActivity,
  type Page,
} from "@polymarket/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateCohortInput } from "../src/experiments/candidate-cohort.js";
import {
  fetchFilteredCandidateActivity,
  persistCandidateIntakeRefresh,
  refreshCandidateIntake,
  type CandidateActivityRequest,
  type CandidateIntakeFetcher,
} from "../src/experiments/candidate-intake.js";

const CAPTURED_AT = "2026-07-11T02:00:00.000Z";
const CAPTURED_MS = Date.parse(CAPTURED_AT);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function quality12Seed(): CandidateCohortInput {
  return JSON.parse(
    readFileSync("config/candidate-cohorts/quality12-20260711-v1.json", "utf8")
  ) as CandidateCohortInput;
}

function oneCandidateSeed(): CandidateCohortInput {
  const seed = quality12Seed();
  return { ...seed, candidates: [seed.candidates[0]!] };
}

function activity(options: {
  trades?: number;
  sells?: number;
  redeems?: number;
  conditions?: number;
  tickets?: number[];
  oldTrades?: number;
} = {}): Array<Record<string, unknown>> {
  const trades = options.trades ?? 20;
  const sells = options.sells ?? 3;
  const conditions = options.conditions ?? 5;
  const tickets = options.tickets ?? Array.from({ length: trades }, (_, index) => index + 1);
  const recent = Array.from({ length: trades }, (_, index) => ({
    type: "TRADE",
    side: index < sells ? "SELL" : "BUY",
    timestamp: Math.floor((CAPTURED_MS - (index + 1) * 60_000) / 1000),
    conditionId: `condition-${index % conditions}`,
    usdcSize: tickets[index] ?? 1,
    transactionHash: `0xtrade${index}`,
  }));
  const redeems = Array.from({ length: options.redeems ?? 0 }, (_, index) => ({
    type: "REDEEM",
    timestamp: Math.floor((CAPTURED_MS - (index + 1) * 90_000) / 1000),
    conditionId: `condition-${index % conditions}`,
    usdcSize: 1,
    transactionHash: `0xredeem${index}`,
  }));
  const old = Array.from({ length: options.oldTrades ?? 0 }, (_, index) => ({
    type: "TRADE",
    side: "SELL",
    timestamp: Math.floor((CAPTURED_MS - 25 * 60 * 60 * 1000 - index * 60_000) / 1000),
    conditionId: `old-${index}`,
    usdcSize: 1,
  }));
  return [...recent, ...redeems, ...old];
}

function fetcher(options: {
  rows?: Array<Record<string, unknown>>;
  activityError?: Error;
  leaderboardError?: Error;
  reverseLeaderboardKeys?: boolean;
  leaderboardAddress?: string;
} = {}): CandidateIntakeFetcher {
  return {
    async fetchActivity(address) {
      if (options.activityError) throw options.activityError;
      return { pages: [{ items: options.rows ?? activity(), hasMore: false }], address };
    },
    async fetchLeaderboard(address) {
      if (options.leaderboardError) throw options.leaderboardError;
      const wallet = options.leaderboardAddress ?? address;
      const row = options.reverseLeaderboardKeys
        ? { pnl: 123, wallet }
        : { wallet, pnl: 123 };
      return { items: [row], hasMore: false };
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("refreshCandidateIntake", () => {
  it("archives every filtered SDK page, then deduplicates and sorts derived rows", async () => {
    const address = oneCandidateSeed().candidates[0]!.address;
    const trade = {
      wallet: address,
      type: ActivityType.TRADE,
      side: "BUY",
      timestamp: Math.floor((CAPTURED_MS - 60_000) / 1000),
      transactionHash: "0xtrade",
      conditionId: "condition-trade",
      amount: 2,
    } as SdkActivity;
    const duplicateTrade = {
      amount: 2,
      conditionId: "condition-trade",
      transactionHash: "0xtrade",
      timestamp: trade.timestamp,
      side: "BUY",
      type: ActivityType.TRADE,
      wallet: address,
    } as SdkActivity;
    const olderTrade = {
      ...trade,
      timestamp: Math.floor((CAPTURED_MS - 120_000) / 1000),
      transactionHash: "0xolder",
    } as SdkActivity;
    const redeem = {
      wallet: address,
      type: ActivityType.REDEEM,
      timestamp: Math.floor((CAPTURED_MS - 30_000) / 1000),
      transactionHash: "0xredeem",
      conditionId: "condition-redeem",
    } as SdkActivity;
    const pageSets = new Map<string, Array<Page<SdkActivity[]>>>([
      [ActivityType.TRADE, [
        {
          items: [duplicateTrade],
          hasMore: true,
          nextCursor: "trade-page-2" as never,
          totalCount: 3,
        },
        { items: [olderTrade, trade], hasMore: false, totalCount: 3 },
      ]],
      [ActivityType.REDEEM, [
        { items: [redeem], hasMore: false, totalCount: 1 },
      ]],
    ]);
    const listActivity = vi.fn((request: CandidateActivityRequest) => ({
      async *[Symbol.asyncIterator]() {
        for (const page of pageSets.get(String(request.type?.[0])) ?? []) yield page;
      },
    }));
    const client = { listActivity };
    const window = {
      capturedAt: CAPTURED_AT,
      sinceMs: CAPTURED_MS - 24 * 60 * 60 * 1000,
      untilMs: CAPTURED_MS,
    };

    const result = await fetchFilteredCandidateActivity(client, address, window);

    expect(listActivity).toHaveBeenCalledTimes(2);
    expect(listActivity.mock.calls.map(([request]) => request.type)).toEqual([
      [ActivityType.TRADE],
      [ActivityType.REDEEM],
    ]);
    for (const [request] of listActivity.mock.calls) {
      expect(request.type).toHaveLength(1);
      expect(request).toMatchObject({
        user: address,
        pageSize: 500,
        start: Math.floor(window.sinceMs / 1000),
        end: Math.ceil(window.untilMs / 1000),
        sortBy: "TIMESTAMP",
        sortDirection: "DESC",
      });
    }
    expect(result.requests.map(({ activityType }) => activityType)).toEqual([
      ActivityType.TRADE,
      ActivityType.REDEEM,
    ]);
    expect(result.requests[0]?.pages).toHaveLength(2);
    expect(result.requests[0]?.pages[0]).toEqual({
      items: [duplicateTrade],
      hasMore: true,
      nextCursor: "trade-page-2",
      totalCount: 3,
    });
    expect(result.items.map((row) => row.transactionHash)).toEqual([
      "0xredeem",
      "0xtrade",
      "0xolder",
    ]);
  });

  it("uses all rows beyond the first 500 and preserves official REDEEM conditions", async () => {
    const address = oneCandidateSeed().candidates[0]!.address;
    const trades = Array.from({ length: 501 }, (_, index) => ({
      wallet: address,
      type: ActivityType.TRADE,
      side: index < 2 ? "SELL" : "BUY",
      timestamp: Math.floor((CAPTURED_MS - (index + 1) * 1_000) / 1000),
      transactionHash: `0xtrade${index}`,
      conditionId: `condition-${index % 5}`,
      amount: "2",
    } as SdkActivity));
    const redeem = {
      wallet: address,
      type: ActivityType.REDEEM,
      timestamp: Math.floor((CAPTURED_MS - 500) / 1000),
      transactionHash: "0xredeem",
      conditionId: "redeem-only-condition",
      amount: "3",
    } as SdkActivity;
    const listActivity = vi.fn((request: CandidateActivityRequest) => ({
      async *[Symbol.asyncIterator]() {
        if (request.type?.[0] === ActivityType.TRADE) {
          yield {
            items: trades.slice(0, 500),
            hasMore: true,
            nextCursor: "trade-page-2" as never,
            totalCount: 501,
          };
          yield { items: trades.slice(500), hasMore: false, totalCount: 501 };
          return;
        }
        yield { items: [redeem], hasMore: false, totalCount: 1 };
      },
    }));
    const window = {
      capturedAt: CAPTURED_AT,
      sinceMs: CAPTURED_MS - 24 * 60 * 60 * 1000,
      untilMs: CAPTURED_MS,
    };
    const rawActivity = await fetchFilteredCandidateActivity(
      { listActivity },
      address,
      window
    );
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      {
        async fetchActivity() {
          return rawActivity;
        },
        async fetchLeaderboard(candidateAddress) {
          return { items: [{ wallet: candidateAddress, pnl: 123 }] };
        },
      },
      { capturedAt: CAPTURED_AT }
    );

    expect(rawActivity.requests[0]?.pages.map((page) => page.items.length)).toEqual([500, 1]);
    expect(rawActivity.items).toHaveLength(502);
    expect(result.artifacts[0]?.evidence.metrics).toEqual({
      trades24h: 501,
      sellOrRedeem24h: 3,
      distinctConditions24h: 6,
      medianTicketUsd: 2,
      p90TicketUsd: 2,
    });
    expect(result.artifacts[0]?.evidence.approved).toBe(true);
  });

  it("fails closed and seals the error when a filtered SDK paginator rejects", async () => {
    const address = oneCandidateSeed().candidates[0]!.address;
    const client = {
      listActivity(request: CandidateActivityRequest) {
        return {
          async *[Symbol.asyncIterator]() {
            if (request.type?.[0] === ActivityType.TRADE) {
              throw new TypeError("Expected activity.outcomeIndex to be present");
            }
            yield { items: [], hasMore: false };
          },
        };
      },
    };
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      {
        fetchActivity(candidateAddress, window) {
          return fetchFilteredCandidateActivity(client, candidateAddress, window);
        },
        async fetchLeaderboard(candidateAddress) {
          return { items: [{ wallet: candidateAddress, pnl: 123 }] };
        },
      },
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.rawResponses.activity).toBeNull();
    expect(result.artifacts[0]?.evidence.apiErrors).toEqual([
      "activity: Expected activity.outcomeIndex to be present",
    ]);
    expect(result.artifacts[0]?.evidence.gates.apiNoErrors).toBe(false);
    expect(result.artifacts[0]?.evidence.approved).toBe(false);
    expect(result.approvedCohort.candidates[0]?.freshIntakePassed).toBe(false);
  });

  it("approves the exact quality12 roster only when every hard gate passes", async () => {
    const seed = quality12Seed();
    const original = JSON.stringify(seed);
    const result = await refreshCandidateIntake(seed, fetcher(), { capturedAt: CAPTURED_AT });

    expect(result.approvedCohort.cohortId).toBe("quality12-20260711-v1");
    expect(result.approvedCohort.candidates).toHaveLength(4);
    expect(result.approvedCohort.candidates.map(({ id, address }) => ({ id, address })))
      .toEqual(seed.candidates.map(({ id, address }) => ({ id, address })));
    expect(JSON.stringify(seed)).toBe(original);

    for (const candidate of result.approvedCohort.candidates) {
      expect(candidate.freshIntakePassed).toBe(true);
      expect(candidate.freshIntakeEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(result.artifacts).toHaveLength(4);
    for (const artifact of result.artifacts) {
      expect(artifact.evidence.capturedAt).toBe(CAPTURED_AT);
      expect(artifact.evidence.approved).toBe(true);
      expect(artifact.evidence.metrics).toMatchObject({
        trades24h: 20,
        sellOrRedeem24h: 3,
        distinctConditions24h: 5,
        medianTicketUsd: 10.5,
        p90TicketUsd: 18,
      });
      expect(artifact.evidence.apiErrors).toEqual([]);
      expect(artifact.sha256).toBe(sha256(artifact.canonicalJson));
      expect(JSON.parse(artifact.canonicalJson)).toEqual(artifact.evidence);
      const approved = result.approvedCohort.candidates.find(
        (candidate) => candidate.id === artifact.candidateId
      );
      expect(approved?.address).toBe(artifact.address);
      expect(approved?.freshIntakeEvidenceSha256).toBe(artifact.sha256);
    }
  });

  it.each([
    ["trades24h", activity({ trades: 19, sells: 3, conditions: 5 })],
    ["sellOrRedeem24h", activity({ trades: 20, sells: 2, conditions: 5 })],
    ["distinctConditions24h", activity({ trades: 20, sells: 3, conditions: 4 })],
    [
      "medianTicketUsd",
      activity({
        trades: 20,
        sells: 3,
        conditions: 5,
        tickets: [...Array(9).fill(10), ...Array(11).fill(51)],
      }),
    ],
    [
      "p90TicketUsd",
      activity({
        trades: 20,
        sells: 3,
        conditions: 5,
        tickets: [...Array(17).fill(10), ...Array(3).fill(501)],
      }),
    ],
  ])("keeps a Candidate watchlist-only when %s fails", async (failedGate, rows) => {
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ rows }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.failedGates).toContain(failedGate);
    expect(result.artifacts[0]?.evidence.approved).toBe(false);
    expect(result.approvedCohort.candidates[0]).toMatchObject({
      freshIntakePassed: false,
    });
    expect(result.approvedCohort.candidates[0]).not.toHaveProperty(
      "freshIntakeEvidenceSha256"
    );
  });

  it.each([
    ["activity", { activityError: new Error("activity unavailable") }],
    ["leaderboard", { leaderboardError: new Error("leaderboard unavailable") }],
  ])("fails closed and still seals evidence when the %s API errors", async (_name, errors) => {
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher(errors),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.gates.apiNoErrors).toBe(false);
    expect(result.artifacts[0]?.evidence.apiErrors).not.toEqual([]);
    expect(result.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.approvedCohort.candidates[0]?.freshIntakePassed).toBe(false);
    expect(result.approvedCohort.candidates[0]).not.toHaveProperty(
      "freshIntakeEvidenceSha256"
    );
  });

  it("counts only the fixed 24h window and combines SELL with REDEEM", async () => {
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ rows: activity({ trades: 20, sells: 2, redeems: 1, oldTrades: 50 }) }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.metrics).toMatchObject({
      trades24h: 20,
      sellOrRedeem24h: 3,
      distinctConditions24h: 5,
    });
    expect(result.artifacts[0]?.evidence.approved).toBe(true);
  });

  it("counts a redeemed condition toward recent market breadth", async () => {
    const rows = activity({ trades: 20, sells: 2, redeems: 1, conditions: 4 });
    const redeem = rows.find((row) => row.type === "REDEEM");
    if (redeem) redeem.conditionId = "condition-4";
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ rows }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.metrics.distinctConditions24h).toBe(5);
    expect(result.artifacts[0]?.evidence.approved).toBe(true);
  });

  it("hashes semantically identical raw responses identically", async () => {
    const first = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher(),
      { capturedAt: CAPTURED_AT }
    );
    const second = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ reverseLeaderboardKeys: true }),
      { capturedAt: CAPTURED_AT }
    );

    expect(first.artifacts[0]?.canonicalJson).toBe(second.artifacts[0]?.canonicalJson);
    expect(first.artifacts[0]?.sha256).toBe(second.artifacts[0]?.sha256);
  });

  it("rejects a previously approved cohort as the immutable seed", async () => {
    const seed = oneCandidateSeed();
    seed.candidates[0] = {
      ...seed.candidates[0]!,
      freshIntakePassed: true,
      freshIntakeEvidenceSha256: "a".repeat(64),
    };

    await expect(refreshCandidateIntake(seed, fetcher(), { capturedAt: CAPTURED_AT }))
      .rejects.toThrow(/watchlist-only seed/i);
  });

  it("fails closed when an API response belongs to a different address", async () => {
    const seed = oneCandidateSeed();
    const expectedAddress = seed.candidates[0]!.address;
    const result = await refreshCandidateIntake(
      seed,
      fetcher({ leaderboardAddress: "0x0000000000000000000000000000000000000001" }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.apiErrors.join(" ")).toMatch(/address mismatch/i);
    expect(result.approvedCohort.candidates[0]?.address).toBe(expectedAddress);
    expect(result.approvedCohort.candidates[0]?.freshIntakePassed).toBe(false);
    expect(result.approvedCohort.candidates[0]).not.toHaveProperty(
      "freshIntakeEvidenceSha256"
    );
  });
});

describe("persistCandidateIntakeRefresh", () => {
  it("writes a new cohort and per-address evidence without touching the seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polymirror-intake-"));
    dirs.push(dir);
    const seedPath = join(dir, "seed.json");
    const outputPath = join(dir, "approved.json");
    const archiveDir = join(dir, "evidence");
    const seedText = `${JSON.stringify(quality12Seed(), null, 2)}\n`;
    writeFileSync(seedPath, seedText);
    const result = await refreshCandidateIntake(
      quality12Seed(),
      fetcher(),
      { capturedAt: CAPTURED_AT }
    );

    persistCandidateIntakeRefresh(result, { seedPath, outputPath, archiveDir });

    expect(readFileSync(seedPath, "utf8")).toBe(seedText);
    const approved = JSON.parse(readFileSync(outputPath, "utf8")) as CandidateCohortInput;
    expect(approved.candidates).toHaveLength(4);
    expect(approved.candidates.every((candidate) => candidate.freshIntakePassed)).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(archiveDir, "manifest.json"), "utf8")
    ) as { artifacts: Array<{ fileName: string; sha256: string }> };
    expect(manifest.artifacts).toHaveLength(4);
    for (const artifact of manifest.artifacts) {
      const bytes = readFileSync(join(archiveDir, artifact.fileName), "utf8");
      expect(sha256(bytes)).toBe(artifact.sha256);
    }
  });

  it("refuses to overwrite the seed, an existing output, or an evidence directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polymirror-intake-"));
    dirs.push(dir);
    const seedPath = join(dir, "seed.json");
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher(),
      { capturedAt: CAPTURED_AT }
    );
    writeFileSync(seedPath, JSON.stringify(oneCandidateSeed()));

    expect(() => persistCandidateIntakeRefresh(result, {
      seedPath,
      outputPath: seedPath,
      archiveDir: join(dir, "same-seed-evidence"),
    })).toThrow(/must not overwrite the seed/i);

    const existingOutput = join(dir, "existing.json");
    writeFileSync(existingOutput, "existing");
    expect(() => persistCandidateIntakeRefresh(result, {
      seedPath,
      outputPath: existingOutput,
      archiveDir: join(dir, "existing-output-evidence"),
    })).toThrow(/already exists/i);

    const evidence = join(dir, "existing-evidence");
    writeFileSync(evidence, "not a directory");
    expect(() => persistCandidateIntakeRefresh(result, {
      seedPath,
      outputPath: join(dir, "new.json"),
      archiveDir: evidence,
    })).toThrow(/already exists/i);
  });
});
