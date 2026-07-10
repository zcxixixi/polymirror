import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { pollLeaders } from "../src/monitor/poll.js";
import { runCopyCycle } from "../src/engine/copy-cycle.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

vi.mock("../src/monitor/poll.js", () => ({
  pollLeaders: vi.fn(),
}));

vi.mock("../src/executor/geoblock.js", () => ({
  getCachedGeoblockStatus: vi.fn().mockResolvedValue(null),
  formatGeoblockMessage: vi.fn(),
}));

vi.mock("../src/engine/order-reconcile.js", () => ({
  adoptUntrackedOpenOrders: vi.fn().mockResolvedValue({ adopted: 0, warnings: [] }),
}));

const mockCollateral = vi.hoisted(() => ({
  value: {
    cashUsd: 1,
    clobUsd: 1,
    clobAllowanceUsd: 1,
    chainUsd: 0,
    source: "clob" as const,
    pusdAllowancesReady: null,
  },
}));

vi.mock("../src/executor/balance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/executor/balance.js")>();
  return {
    ...actual,
    checkWalletDrifts: vi.fn().mockResolvedValue([]),
    fetchWalletCollateral: vi.fn().mockImplementation(() =>
      Promise.resolve(mockCollateral.value)
    ),
  };
});

const mockPollLeaders = vi.mocked(pollLeaders);

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-empty-probe-"));
  store = new StateStore(join(dir, "test.db"));
    mockPollLeaders.mockReset();
    mockCollateral.value = {
      cashUsd: 1,
      clobUsd: 1,
      clobAllowanceUsd: 1,
      chainUsd: 0,
      source: "clob",
      pusdAllowancesReady: null,
    };
    process.env.POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES =
      "0xbf0d5dda97844322baf1dbd91e6a4fe610105105";
    delete process.env.POLYMIRROR_EMPTY_LIVE_PROBE_MAX_COLLATERAL_USD;
});

afterEach(() => {
    delete process.env.POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES;
    delete process.env.POLYMIRROR_EMPTY_LIVE_PROBE_MAX_COLLATERAL_USD;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("empty live probe", () => {
  it("refuses live buys if the protected probe wallet can meet the 1U min order", async () => {
    const activity = {
      type: "TRADE" as const,
      asset: "token-probe",
      side: "BUY" as const,
      size: 100,
      price: 0.5,
      timestamp: Date.now(),
      transactionHash: "0xprobe",
    };
    const config = previewRuntimeConfig();
    config.app.global.previewMode = false;
    config.app.global.risk.slippageTolerance = 0;
    config.wallet.proxyAddress = "0xbf0d5dda97844322baf1dbd91e6a4fe610105105";

    mockPollLeaders.mockResolvedValue([
      { leaderId: "whale", fetched: 1, candidates: [activity] },
    ]);

    const result = await runCopyCycle(config, store);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(store.countPendingOrders()).toBe(0);
    expect(
      store
        .listAuditLog({ action: "SKIP" })
        .items.some((row) => row.reason?.includes("empty live probe has tradeable funds"))
    ).toBe(true);
  });
});
