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
  fetchCandidateClosedPositions,
  fetchCandidateResolvedMarkets,
  persistCandidateIntakeRefresh,
  refreshCandidateIntake,
  type CandidateActivityRequest,
  type CandidateClosedPositionRequest,
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

function closedPositions(options: {
  wins?: number;
  losses?: number;
  winPnl?: number;
  lossPnl?: number;
  largestWinPnl?: number;
  totalBought?: number;
} = {}): Array<Record<string, unknown>> {
  const wins = options.wins ?? 6;
  const losses = options.losses ?? 4;
  const winPnl = options.winPnl ?? 2;
  const lossPnl = options.lossPnl ?? -1;
  const largestWinPnl = options.largestWinPnl ?? winPnl;
  const totalBought = options.totalBought ?? 10;
  return [
    ...Array.from({ length: wins }, (_, index) => ({
      wallet: oneCandidateSeed().candidates[0]!.address,
      conditionId: `closed-win-${index}`,
      realizedPnl: index === 0 ? largestWinPnl : winPnl,
      totalBought,
      timestamp: CAPTURED_MS - (index + 1) * 60_000,
    })),
    ...Array.from({ length: losses }, (_, index) => ({
      wallet: oneCandidateSeed().candidates[0]!.address,
      conditionId: `closed-loss-${index}`,
      realizedPnl: lossPnl,
      totalBought,
      timestamp: CAPTURED_MS - (wins + index + 1) * 60_000,
    })),
  ];
}

function fetcher(options: {
  rows?: Array<Record<string, unknown>>;
  closedRows?: Array<Record<string, unknown>>;
  resolvedRows?: Array<Record<string, unknown>>;
  activityError?: Error;
  leaderboardError?: Error;
  closedPositionsError?: Error;
  resolvedMarketsError?: Error;
  reverseLeaderboardKeys?: boolean;
  leaderboardAddress?: string;
  closedPositionAddress?: string;
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
    async fetchClosedPositions(address) {
      if (options.closedPositionsError) throw options.closedPositionsError;
      const wallet = options.closedPositionAddress ?? address;
      const rows = options.closedRows ?? closedPositions();
      return {
        items: rows.map((row) => ({ ...row, wallet })),
        hasMore: false,
      };
    },
    async fetchResolvedMarkets(conditionIds) {
      if (options.resolvedMarketsError) throw options.resolvedMarketsError;
      return {
        items: options.resolvedRows ?? conditionIds.map((conditionId) => ({
          conditionId,
          state: {
            closed: false,
            endDate: new Date(CAPTURED_MS + 60 * 60 * 1000).toISOString(),
          },
        })),
        hasMore: false,
      };
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
        async fetchClosedPositions(candidateAddress) {
          return {
            items: closedPositions().map((row) => ({
              ...row,
              wallet: candidateAddress,
            })),
          };
        },
        async fetchResolvedMarkets(conditionIds) {
          return {
            items: conditionIds.map((conditionId) => ({
              conditionId,
              state: {
                closed: false,
                endDate: new Date(CAPTURED_MS + 60 * 60 * 1000).toISOString(),
              },
            })),
          };
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
      buyTrades24h: 499,
      activityMarketEndCoveragePct: 100,
      copyableBuyTrades24h: 499,
      copyableBuySharePct: 100,
      medianBuyLeadSeconds: 3852,
      p10BuyLeadSeconds: 3652,
      closedPositions: 10,
      closedRealizedPnlUsd: 8,
      closedTotalBoughtUsd: 100,
      closedWins: 6,
      closedLosses: 4,
      closedWinRatePct: 60,
      closedProfitFactor: 3,
      closedProfitFactorInfinite: false,
      largestClosedWinUsd: 2,
      largestClosedWinSharePct: (2 / 12) * 100,
      closedPnlWithoutLargestWinUsd: 6,
      profitabilityPositions: 10,
      profitabilityPnlUsd: 8,
      profitabilityWins: 6,
      profitabilityLosses: 4,
      profitabilityWinRatePct: 60,
      profitabilityProfitFactor: 3,
      profitabilityProfitFactorInfinite: false,
      largestProfitabilityWinUsd: 2,
      largestProfitabilityWinSharePct: (2 / 12) * 100,
      profitabilityPnlWithoutLargestWinUsd: 6,
      derivedResolvedPositions: 0,
      unreconciledResolvedPositions: 0,
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
        async fetchClosedPositions(candidateAddress) {
          return {
            items: closedPositions().map((row) => ({
              ...row,
              wallet: candidateAddress,
            })),
          };
        },
        async fetchResolvedMarkets(conditionIds) {
          return {
            items: conditionIds.map((conditionId) => ({
              conditionId,
              state: {
                closed: false,
                endDate: new Date(CAPTURED_MS + 60 * 60 * 1000).toISOString(),
              },
            })),
          };
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
        activityMarketEndCoveragePct: 100,
        copyableBuySharePct: 100,
        closedPositions: 10,
        closedRealizedPnlUsd: 8,
        closedWinRatePct: 60,
        closedProfitFactor: 3,
        largestClosedWinSharePct: (2 / 12) * 100,
        closedPnlWithoutLargestWinUsd: 6,
        profitabilityPositions: 10,
        profitabilityPnlUsd: 8,
        profitabilityWinRatePct: 60,
        profitabilityProfitFactor: 3,
        largestProfitabilityWinSharePct: (2 / 12) * 100,
        profitabilityPnlWithoutLargestWinUsd: 6,
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

  it("rejects a source whose BUYs arrive too close to market expiry to copy", async () => {
    const rows = activity({ trades: 20, sells: 3, conditions: 20 });
    const resolvedRows = rows
      .filter((row) => row.type === "TRADE")
      .map((row) => ({
        conditionId: row.conditionId,
        state: {
          closed: true,
          endDate: new Date(Number(row.timestamp) * 1000 + 5_000).toISOString(),
        },
      }));
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ rows, resolvedRows }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.metrics).toMatchObject({
      buyTrades24h: 17,
      activityMarketEndCoveragePct: 100,
      copyableBuyTrades24h: 0,
      copyableBuySharePct: 0,
      medianBuyLeadSeconds: 5,
      p10BuyLeadSeconds: 5,
    });
    expect(result.artifacts[0]?.evidence.failedGates).toContain("copyableBuyShare");
    expect(result.artifacts[0]?.evidence.approved).toBe(false);
  });

  it("fails closed when official market end-time coverage is incomplete", async () => {
    const rows = activity();
    const conditionIds = [...new Set(rows
      .filter((row) => row.type === "TRADE")
      .map((row) => String(row.conditionId)))];
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({
        rows,
        resolvedRows: conditionIds.slice(0, -1).map((conditionId) => ({
          conditionId,
          state: {
            closed: false,
            endDate: new Date(CAPTURED_MS + 60 * 60 * 1000).toISOString(),
          },
        })),
      }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.metrics.activityMarketEndCoveragePct).toBe(80);
    expect(result.artifacts[0]?.evidence.failedGates).toContain(
      "activityMarketEndCoverage"
    );
    expect(result.artifacts[0]?.evidence.approved).toBe(false);
  });

  it("counts a TRADE without conditionId as missing end-time coverage", async () => {
    const rows = activity();
    delete rows[0]?.conditionId;
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ rows }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.metrics.activityMarketEndCoveragePct).toBe(95);
    expect(result.artifacts[0]?.evidence.failedGates).toContain(
      "activityMarketEndCoverage"
    );
  });

  it("fails closed when the market response duplicates a condition", async () => {
    const rows = activity();
    const conditionIds = [...new Set(rows
      .filter((row) => row.type === "TRADE")
      .map((row) => String(row.conditionId)))];
    const markets = conditionIds.map((conditionId) => ({
      conditionId,
      state: {
        closed: false,
        endDate: new Date(CAPTURED_MS + 60 * 60 * 1000).toISOString(),
      },
    }));
    markets.push({ ...markets[0]! });
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ rows, resolvedRows: markets }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.apiErrors.join(" ")).toMatch(
      /duplicated condition/i
    );
    expect(result.artifacts[0]?.evidence.rawResponses.resolvedMarkets).toMatchObject({
      items: markets,
    });
    expect(result.artifacts[0]?.evidence.approved).toBe(false);
  });

  it.each([
    ["profitabilitySample", closedPositions({ wins: 5, losses: 4 })],
    ["profitabilityPnl", closedPositions({ wins: 5, losses: 5, winPnl: 1, lossPnl: -2 })],
    ["profitabilityWinRate", closedPositions({ wins: 4, losses: 6, winPnl: 4, lossPnl: -1 })],
    ["profitabilityProfitFactor", closedPositions({ wins: 6, losses: 4, winPnl: 1, lossPnl: -2 })],
    [
      "profitabilityWinnerConcentration",
      closedPositions({ wins: 6, losses: 4, winPnl: 1, largestWinPnl: 20, lossPnl: -1 }),
    ],
    [
      "profitabilityPnlWithoutLargestWin",
      closedPositions({ wins: 6, losses: 4, winPnl: 1, largestWinPnl: 5, lossPnl: -1.5 }),
    ],
  ])("keeps a Candidate watchlist-only when %s fails", async (failedGate, closedRows) => {
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ closedRows }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.failedGates).toContain(failedGate);
    expect(result.artifacts[0]?.evidence.approved).toBe(false);
    expect(result.approvedCohort.candidates[0]?.freshIntakePassed).toBe(false);
  });

  it.each([
    ["activity", { activityError: new Error("activity unavailable") }],
    ["leaderboard", { leaderboardError: new Error("leaderboard unavailable") }],
    ["closed positions", { closedPositionsError: new Error("closed positions unavailable") }],
    ["resolved markets", { resolvedMarketsError: new Error("resolved markets unavailable") }],
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

  it("fails closed when closed-position evidence belongs to a different address", async () => {
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({ closedPositionAddress: "0x0000000000000000000000000000000000000001" }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.apiErrors.join(" ")).toMatch(
      /closed positions response address mismatch/i
    );
    expect(result.approvedCohort.candidates[0]?.freshIntakePassed).toBe(false);
  });

  it("reconciles resolved losing markets omitted by the closed-positions API", async () => {
    const rows = activity();
    rows[3] = {
      ...rows[3],
      side: "BUY",
      conditionId: "missing-loss",
      tokenId: "losing-token",
      shares: 40,
      usdcSize: 20,
    };
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({
        rows,
        resolvedRows: [{
          conditionId: "missing-loss",
          state: { closed: true },
          resolution: { umaResolutionStatus: "resolved" },
          outcomes: {
            yes: { tokenId: "winning-token", price: "1" },
            no: { tokenId: "losing-token", price: "0" },
          },
        }],
      }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.metrics).toMatchObject({
      closedPositions: 10,
      closedRealizedPnlUsd: 8,
      profitabilityPositions: 11,
      profitabilityPnlUsd: -12,
      derivedResolvedPositions: 1,
      unreconciledResolvedPositions: 0,
    });
    expect(result.artifacts[0]?.evidence.failedGates).toContain("profitabilityPnl");
    expect(result.artifacts[0]?.evidence.approved).toBe(false);
    });
  });

  it("fails closed when an omitted resolved position cannot be reconstructed", async () => {
    const rows = activity();
    rows[3] = {
      ...rows[3],
      side: "SELL",
      conditionId: "unreconciled-loss",
      tokenId: "losing-token",
      shares: 40,
      usdcSize: 20,
    };
    const result = await refreshCandidateIntake(
      oneCandidateSeed(),
      fetcher({
        rows,
        resolvedRows: [
          ...[...new Set(rows
            .filter((row) => row.type === "TRADE")
            .map((row) => String(row.conditionId)))]
            .filter((conditionId) => conditionId !== "unreconciled-loss")
            .map((conditionId) => ({
              conditionId,
              state: {
                closed: false,
                endDate: new Date(CAPTURED_MS + 60 * 60 * 1000).toISOString(),
              },
            })),
          {
            conditionId: "unreconciled-loss",
            state: {
              closed: true,
              endDate: new Date(CAPTURED_MS + 60 * 60 * 1000).toISOString(),
            },
            resolution: { umaResolutionStatus: "resolved" },
            outcomes: {
              yes: { tokenId: "winning-token", price: "1" },
              no: { tokenId: "losing-token", price: "0" },
            },
          },
        ],
      }),
      { capturedAt: CAPTURED_AT }
    );

    expect(result.artifacts[0]?.evidence.metrics.unreconciledResolvedPositions).toBe(1);
    expect(result.artifacts[0]?.evidence.failedGates).toContain(
      "profitabilityReconciled"
    );
    expect(result.artifacts[0]?.evidence.approved).toBe(false);
  });

  it("splits dense activity windows when the official offset limit is reached", async () => {
    const address = oneCandidateSeed().candidates[0]!.address;
    const window = {
      capturedAt: CAPTURED_AT,
      sinceMs: CAPTURED_MS - 7_000,
      untilMs: CAPTURED_MS,
    };
    const listActivity = vi.fn((request: CandidateActivityRequest) => ({
      async *[Symbol.asyncIterator]() {
        const start = Number(request.start);
        const end = Number(request.end);
        if (request.type?.[0] === ActivityType.TRADE && end - start > 1) {
          throw new Error("max historical activity offset of 3000 exceeded");
        }
        const items = request.type?.[0] === ActivityType.TRADE
          ? [{
              wallet: address,
              type: ActivityType.TRADE,
              side: "BUY",
              timestamp: end,
              transactionHash: `0x${start}-${end}`,
              conditionId: `condition-${start}`,
              amount: "2",
            } as SdkActivity]
          : [];
        yield { items, hasMore: false, totalCount: items.length };
      },
    }));

    const result = await fetchFilteredCandidateActivity({ listActivity }, address, window);
    const tradeRequests = result.requests.filter(
      ({ activityType }) => activityType === ActivityType.TRADE
    );

    expect(tradeRequests.length).toBeGreaterThan(1);
    expect(tradeRequests.every(({ request }) =>
      Number(request.end) - Number(request.start) <= 1
    )).toBe(true);
    expect(result.items).toHaveLength(tradeRequests.length);
    expect(new Set(result.items.map((row) => row.transactionHash)).size).toBe(
      tradeRequests.length
    );
  });

describe("fetchCandidateResolvedMarkets", () => {
  it("batches condition ids without excluding still-open activity markets", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      listMarkets(request: Record<string, unknown>) {
        calls.push(request);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              items: (request.conditionIds as string[]).map((conditionId) => ({ conditionId })),
              hasMore: false,
            };
          },
        };
      },
    };
    const conditionIds = Array.from({ length: 51 }, (_, index) =>
      `0x${index.toString(16).padStart(64, "0")}`
    );

    const result = await fetchCandidateResolvedMarkets(client, conditionIds);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ pageSize: 100 });
    expect(calls[0]).not.toHaveProperty("closed");
    expect(calls[0]?.conditionIds).toHaveLength(50);
    expect(calls[1]?.conditionIds).toHaveLength(1);
    expect(result.items).toHaveLength(51);
    expect(result.requests).toHaveLength(2);
  });

  it("falls back to the official single-market endpoint when listMarkets omits a slug", async () => {
    const conditionId = `0x${"a".repeat(64)}`;
    const client = {
      listMarkets() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { items: [], hasMore: false };
          },
        };
      },
      fetchMarket: vi.fn(async ({ slug }: { slug: string }) => ({
        conditionId,
        slug,
        state: { closed: true, endDate: CAPTURED_AT },
      })),
    };

    const result = await fetchCandidateResolvedMarkets(client, [conditionId], [{
      conditionId,
      slug: "short-expiry-market",
    }]);

    expect(client.fetchMarket).toHaveBeenCalledWith({ slug: "short-expiry-market" });
    expect(result.items).toHaveLength(1);
    expect(result.fallbackRequests).toHaveLength(1);
    expect(result.fallbackRequests[0]).toMatchObject({
      conditionId,
      request: { slug: "short-expiry-market" },
    });
  });
});

describe("fetchCandidateClosedPositions", () => {
  it("archives every official page instead of silently using the first 50 rows", async () => {
    const address = oneCandidateSeed().candidates[0]!.address!;
    const listClosedPositions = vi.fn((request: CandidateClosedPositionRequest) => ({
      async *[Symbol.asyncIterator]() {
        yield {
          items: [{ wallet: address, realizedPnl: "1", totalBought: "2" }],
          hasMore: true,
          nextCursor: "page-2",
          totalCount: 2,
        };
        yield {
          items: [{ wallet: address, realizedPnl: "-1", totalBought: "2" }],
          hasMore: false,
          totalCount: 2,
        };
      },
    }));

    const result = await fetchCandidateClosedPositions(
      { listClosedPositions },
      address
    );

    expect(listClosedPositions).toHaveBeenCalledWith({
      user: address,
      pageSize: 50,
      sortBy: "TIMESTAMP",
      sortDirection: "DESC",
    });
    expect(result.pages).toHaveLength(2);
    expect(result.items).toHaveLength(2);
    expect(result.pages.at(-1)?.hasMore).toBe(false);
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
