import { describe, expect, it } from "vitest";
import type { AccountDefinition, LeaderConfig } from "../src/config/types.js";
import type { Activity } from "../src/monitor/data-api.js";
import {
  assessLiveProbeSubmitGuard,
  buildLiveProbeOrderRequest,
  parseLiveProbeSubmitEnv,
  serializeLiveProbeOrderResult,
} from "../src/live/probe-submit.js";
import { createLiveProbeSnapshot } from "../src/live/probe.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

function account(): AccountDefinition {
  const config = previewRuntimeConfig();
  config.app.global.previewMode = false;
  config.app.global.risk.minOrderUsd = 1;
  config.app.global.risk.maxOrderUsd = 1;
  config.wallet.proxyAddress = "0x" + "1".repeat(40);
  config.wallet.apiKey = "key";
  config.wallet.apiSecret = "secret";
  config.wallet.apiPassphrase = "pass";
  config.wallet.relayerApiKey = "relayer";
  config.wallet.relayerApiKeyAddress = "0x" + "2".repeat(40);
  return {
    id: "live_probe_empty",
    label: "probe",
    enabled: false,
    walletEnv: "PROBE",
    config,
    dbPath: "data/accounts/live_probe_empty/preview.db",
  };
}

function leader(): LeaderConfig {
  return {
    id: "leader",
    address: "0x" + "3".repeat(40),
    enabled: true,
    weight: 1,
    strategy: { type: "FIXED", copySize: 1 },
  };
}

function buy(overrides: Partial<Activity> = {}): Activity {
  return {
    type: "TRADE",
    asset: "token-abc",
    side: "BUY",
    size: 100,
    price: 0.5,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("live probe submit guard", () => {
  it("requires explicit submit opt-in and a protected underfunded wallet", () => {
    const acct = account();
    const snapshot = createLiveProbeSnapshot({
      account: acct,
      geoblock: { blocked: false, ip: "52.210.124.101", country: "IE", region: "L" },
      candidateCount: 1,
      collateral: {
        cashUsd: 0.04,
        clobUsd: 0.04,
        clobAllowanceUsd: 0,
        chainUsd: 0,
        source: "clob",
        pusdAllowancesReady: null,
      },
    });

    const disabled = assessLiveProbeSubmitGuard({
      account: acct,
      snapshot,
      collateral: snapshot.collateral,
      options: parseLiveProbeSubmitEnv({}),
      env: { POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES: acct.config.wallet.proxyAddress },
    });
    expect(disabled.allow).toBe(false);
    expect(disabled.reason).toContain("disabled");

    const allowed = assessLiveProbeSubmitGuard({
      account: acct,
      snapshot,
      collateral: snapshot.collateral,
      options: parseLiveProbeSubmitEnv({
        LIVE_PROBE_SUBMIT_ORDER: "true",
        LIVE_PROBE_ALLOW_INSUFFICIENT_COLLATERAL: "true",
      }),
      env: { POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES: acct.config.wallet.proxyAddress },
    });
    expect(allowed).toMatchObject({ allow: true });
  });

  it("refuses submit when the protected wallet can fund the min order", () => {
    const acct = account();
    const snapshot = createLiveProbeSnapshot({
      account: acct,
      geoblock: { blocked: false, ip: "52.210.124.101", country: "IE", region: "L" },
      candidateCount: 1,
      collateral: {
        cashUsd: 1,
        clobUsd: 1,
        clobAllowanceUsd: 1,
        chainUsd: 0,
        source: "clob",
        pusdAllowancesReady: null,
      },
    });

    const guard = assessLiveProbeSubmitGuard({
      account: acct,
      snapshot,
      collateral: snapshot.collateral,
      options: parseLiveProbeSubmitEnv({
        LIVE_PROBE_SUBMIT_ORDER: "true",
        LIVE_PROBE_ALLOW_INSUFFICIENT_COLLATERAL: "true",
      }),
      env: { POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES: acct.config.wallet.proxyAddress },
    });

    expect(guard.allow).toBe(false);
    expect(guard.reason).toContain("can fund min order");
  });

  it("builds a single capped BUY order from the same sizing logic", () => {
    const req = buildLiveProbeOrderRequest({
      leader: leader(),
      global: account().config.app.global,
      activity: buy(),
      maxNotionalUsd: 1,
    });

    expect(req.allow).toBe(true);
    expect(req.order).toMatchObject({
      tokenId: "token-abc",
      side: "BUY",
      price: 0.5,
      size: 2,
    });
  });

  it("keeps the executor execution price in submitted probe reports", () => {
    expect(
      serializeLiveProbeOrderResult({
        preview: false,
        executionPrice: 0.12,
        error: "not enough balance",
        filledShares: 0,
        filledUsd: 0,
        pendingRemaining: 0,
      })
    ).toMatchObject({
      executionPrice: 0.12,
      error: "not enough balance",
    });
  });
});
