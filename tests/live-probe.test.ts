import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountDefinition } from "../src/config/types.js";
import {
  createLiveProbeSnapshot,
  writeLiveProbeJsonl,
} from "../src/live/probe.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

function account(overrides: Partial<AccountDefinition> = {}): AccountDefinition {
  const config = previewRuntimeConfig();
  config.app.global.previewMode = false;
  config.app.global.risk.minOrderUsd = 1;
  config.app.global.risk.maxOrderUsd = 1;
  config.wallet.apiKey = "key";
  config.wallet.apiSecret = "secret";
  config.wallet.apiPassphrase = "passphrase";
  config.wallet.relayerApiKey = "relayer";
  config.wallet.relayerApiKeyAddress = "0x" + "3".repeat(40);
  return {
    id: "live_probe_empty",
    label: "probe",
    enabled: false,
    walletEnv: "PROBE",
    config,
    dbPath: "data/accounts/live_probe_empty/polymirror.db",
    ...overrides,
  };
}

describe("live probe snapshot", () => {
  afterEach(() => {
    delete process.env.POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES;
    delete process.env.POLYMIRROR_EMPTY_LIVE_PROBE_MAX_COLLATERAL_USD;
  });

  it("blocks before order submission when geoblock is active", () => {
    const snapshot = createLiveProbeSnapshot({
      account: account(),
      now: "2026-07-07T04:00:00.000Z",
      geoblock: { blocked: true, ip: "54.252.59.87", country: "AU", region: "NSW" },
      candidateCount: 12,
    });

    expect(snapshot.accountId).toBe("live_probe_empty");
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.previewMode).toBe(false);
    expect(snapshot.wallet.hasClobCredentials).toBe(true);
    expect(snapshot.wallet.hasRelayerCredentials).toBe(true);
    expect(snapshot.stage.status).toBe("blocked_geoblock");
    expect(snapshot.stage.canAttemptOrder).toBe(false);
    expect(snapshot.candidates.count).toBe(12);
  });

  it("reports ready for order attempt only when live wallet cash and allowance pass", () => {
    const snapshot = createLiveProbeSnapshot({
      account: account({ enabled: true }),
      now: "2026-07-07T04:00:00.000Z",
      geoblock: { blocked: false, ip: "1.2.3.4", country: "US", region: "CA" },
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

    expect(snapshot.stage.status).toBe("ready_for_order_attempt");
    expect(snapshot.stage.canAttemptOrder).toBe(true);
  });

  it("does not report protected empty probes as ready when the wallet can fund a min order", () => {
    const probe = account({ enabled: true });
    process.env.POLYMIRROR_EMPTY_LIVE_PROBE_ADDRESSES =
      probe.config.wallet.proxyAddress;

    const snapshot = createLiveProbeSnapshot({
      account: probe,
      now: "2026-07-07T04:00:00.000Z",
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

    expect(snapshot.stage.status).toBe("protected_probe_funded");
    expect(snapshot.stage.canAttemptOrder).toBe(false);
    expect(snapshot.stage.reason).toContain("protected max $0.99");
  });


  it("records collateral check errors without allowing an order attempt", () => {
    const snapshot = createLiveProbeSnapshot({
      account: account({ enabled: true }),
      now: "2026-07-07T04:00:00.000Z",
      geoblock: { blocked: false, ip: "52.210.124.101", country: "IE", region: "L" },
      candidateCount: 1,
      collateral: null,
      collateralError: "collateral timed out after 30000ms",
    });

    expect(snapshot.collateralError).toBe("collateral timed out after 30000ms");
    expect(snapshot.stage.status).toBe("collateral_unchecked");
    expect(snapshot.stage.reason).toContain("collateral timed out");
    expect(snapshot.stage.canAttemptOrder).toBe(false);
  });

  it("appends snapshots to jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-live-probe-"));
    try {
      const path = join(dir, "probe.jsonl");
      const snapshot = createLiveProbeSnapshot({
        account: account(),
        now: "2026-07-07T04:00:00.000Z",
        geoblock: null,
        candidateCount: 0,
      });

      writeLiveProbeJsonl(path, snapshot);

      const rows = readFileSync(path, "utf8").trim().split("\n");
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!).accountId).toBe("live_probe_empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
