import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { LeaderRegistry } from "../src/leaders/registry.js";
import type { GlobalConfig, LeaderConfig, WalletConfig } from "../src/config/types.js";

const leader: LeaderConfig = {
  id: "whale",
  address: "0x0000000000000000000000000000000000000001",
  enabled: true,
  weight: 1,
  strategy: { type: "PERCENTAGE", copySize: 10 },
};

const globalBase: GlobalConfig = {
  pollIntervalMs: 5000,
  activityLimit: 100,
  previewMode: true,
  copyTradesOnly: true,
  maxTradeAgeHours: 24,
  buyDedupWindowMs: 60_000,
  tradeAggregationWindowMs: 0,
  healthPort: 0,
  risk: {
    enableCopyTrading: true,
    dailyLossCapPct: 20,
    startingCapitalUsd: 500,
    maxDailyVolumeUsd: 2000,
    maxOpenMarkets: 30,
    maxOrderUsd: 50,
    minOrderUsd: 1,
    slippageTolerance: 0.03,
    maxPositionPerTokenUsd: 0,
    syncWalletBalance: true,
  },
  execution: {
    orderType: "GTC",
    retryLimit: 3,
    networkRetryLimit: 0,
    gtcFillTimeoutMs: 10_000,
    pendingOrderMaxAgeHours: 48,
    autoRedeemOnChain: true,
  },
  conflict: { mode: "priority_leader", priority: [] },
  notify: {
    telegramOnCopy: false,
    telegramOnError: false,
    telegramOnKillSwitch: false,
  },
  proxy: { mode: "none", staticUrl: "", dynamicUrl: "", dynamicRotateSession: true },
};

const wallet: WalletConfig = {
  privateKey: "0x" + "1".repeat(64),
  proxyAddress: "0x" + "2".repeat(40),
  signatureType: 0,
  chainId: 137,
  clobUrl: "https://clob.polymarket.com",
  dataApiUrl: "https://data-api.polymarket.com",
  tradingBackend: "secure",
};

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-settlement-"));
  store = new StateStore(join(dir, "test.db"));
  vi.resetModules();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedPosition(tokenId = "token-a") {
  store.recordCopySuccess({
    tradeKey: `seed-${tokenId}`,
    leaderId: "whale",
    tokenId,
    side: "BUY",
    filledShares: 10,
    price: 0.5,
    filledUsd: 5,
    auditReason: "seed",
    preview: true,
    cashInitialUsd: 500,
    market: {
      tokenId,
      conditionId: "0xcondition",
      slug: "market-slug",
      title: "Market",
      outcome: "Yes",
    },
  });
}

function startExperiment(preview: boolean): void {
  store.startOrResumeExperiment({
    accountId: "settlement-a",
    candidateAddresses: [leader.address!],
    config: { app: { global: { ...globalBase, previewMode: preview }, leaders: [leader] }, wallet },
    gitSha: "git-a",
    imageDigest: "image-a",
    lockfileHash: "a".repeat(64),
    trustClass: "verified",
  });
}

describe("processSettlements", () => {
  it("persists leader REDEEM evidence before size filters", async () => {
    startExperiment(true);
    vi.doMock("../src/monitor/data-api.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/monitor/data-api.js")>();
      return {
        ...actual,
        getActivity: vi.fn(async () => [{
          type: "REDEEM",
          asset: "tiny-token",
          size: 0.001,
          usdcSize: 0.001,
          timestamp: Date.now(),
          transactionHash: "0xtiny",
        }]),
      };
    });
    const { processSettlements, resetSettlementCache } = await import("../src/engine/settlement.js");
    resetSettlementCache();
    await processSettlements(new LeaderRegistry([leader]), globalBase, store, true);
    expect(store.listRawEvents()).toHaveLength(1);
    expect(store.listDecisions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "SKIP", reasonCode: "below_redeem_size" }),
    ]));
  });

  it("settles a preview leader REDEEM into local cash and REDEEM audit", async () => {
    seedPosition();
    startExperiment(true);

    vi.doMock("../src/monitor/data-api.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/monitor/data-api.js")>();
      return {
        ...actual,
        getActivity: vi.fn(async () => [
          {
            type: "REDEEM",
            asset: "token-a",
            size: 20,
            usdcSize: 20,
            conditionId: "0xcondition",
            timestamp: Date.now(),
            transactionHash: "0xredeem",
          },
        ]),
      };
    });

    const { processSettlements, resetSettlementCache } = await import("../src/engine/settlement.js");
    resetSettlementCache();
    const result = await processSettlements(
      new LeaderRegistry([leader]),
      globalBase,
      store,
      true
    );

    expect(result.leaderRedeems).toBe(1);
    expect(store.getPosition("whale", "token-a")).toBe(0);
    expect(store.getCashBalance(500)).toBe(505);
    expect(store.listAuditLog({ action: "REDEEM" }).total).toBe(1);
    expect(store.listRawEvents()).toEqual([
      expect.objectContaining({ sourceId: "0xredeem:token-a:REDEEM" }),
    ]);
    expect(store.listDecisions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "DETECT", reasonCode: "detected" }),
        expect.objectContaining({ action: "REDEEM", reasonCode: "redeem_settled" }),
      ])
    );
  });

  it("keeps live local positions open when on-chain redeem fails", async () => {
    seedPosition();

    vi.doMock("../src/monitor/data-api.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/monitor/data-api.js")>();
      return {
        ...actual,
        getActivity: vi.fn(async () => [
          {
            type: "REDEEM",
            asset: "token-a",
            size: 20,
            usdcSize: 20,
            conditionId: "0xcondition",
            timestamp: Date.now(),
            transactionHash: "0xredeem-fail",
          },
        ]),
      };
    });
    vi.doMock("../src/executor/redeem.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/executor/redeem.js")>();
      return {
        ...actual,
        listRedeemablePositions: vi.fn(async () => []),
        redeemConditionOnChain: vi.fn(async () => ({
          ok: false,
          conditionId: "0xcondition",
          error: "relayer rejected",
          benignFailure: false,
        })),
      };
    });

    const { processSettlements, resetSettlementCache } = await import("../src/engine/settlement.js");
    resetSettlementCache();
    const result = await processSettlements(
      new LeaderRegistry([leader]),
      { ...globalBase, previewMode: false },
      store,
      false,
      { wallet }
    );

    expect(result.leaderRedeems).toBe(0);
    expect(store.getPosition("whale", "token-a")).toBe(10);
    expect(store.hasSeen("0xredeem-fail:token-a:REDEEM")).toBe(false);
    expect(result.errors.some((e) => e.includes("relayer rejected"))).toBe(true);
  });

  it("clears live local positions only after on-chain redeem succeeds", async () => {
    seedPosition();
    startExperiment(false);

    vi.doMock("../src/monitor/data-api.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/monitor/data-api.js")>();
      return {
        ...actual,
        getActivity: vi.fn(async () => [
          {
            type: "REDEEM",
            asset: "token-a",
            size: 20,
            usdcSize: 20,
            conditionId: "0xcondition",
            timestamp: Date.now(),
            transactionHash: "0xredeem-ok",
          },
        ]),
      };
    });
    vi.doMock("../src/executor/redeem.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/executor/redeem.js")>();
      return {
        ...actual,
        listRedeemablePositions: vi.fn(async () => []),
        redeemConditionOnChain: vi.fn(async () => ({
          ok: true,
          conditionId: "0xcondition",
          txHash: "0xtx",
        })),
      };
    });

    const { processSettlements, resetSettlementCache } = await import("../src/engine/settlement.js");
    resetSettlementCache();
    const result = await processSettlements(
      new LeaderRegistry([leader]),
      { ...globalBase, previewMode: false },
      store,
      false,
      { wallet }
    );

    expect(result.leaderRedeems).toBe(1);
    expect(result.onChainRedeems).toBe(1);
    expect(store.getPosition("whale", "token-a")).toBe(0);
    expect(store.hasSeen("0xredeem-ok:token-a:REDEEM")).toBe(true);
    expect(store.listRawEvents().length).toBeGreaterThanOrEqual(1);
    expect(store.listDecisions().some((decision) => decision.action === "REDEEM")).toBe(true);
  });
});
