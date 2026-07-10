import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeaderConfig } from "../src/config/types.js";

const { resolveLeaderAddressesSpy } = vi.hoisted(() => ({
  resolveLeaderAddressesSpy: vi.fn(),
}));

vi.mock("../src/leaders/resolve.js", () => ({
  resolveLeaderAddresses: resolveLeaderAddressesSpy,
}));

import { AccountManager } from "../src/accounts/manager.js";
import {
  getProxyConfig,
  getProxySource,
  setProxyConfig,
} from "../src/util/proxy.js";

const TEST_PRIVATE_KEY = `0x${"1".repeat(64)}`;
const TEST_WALLET = `0x${"2".repeat(40)}`;
const LEADER_A = `0x${"a".repeat(40)}`;
const LEADER_B = `0x${"b".repeat(40)}`;

function account(id: string, label: string, leader: Record<string, unknown>, preview = true) {
  return {
    id,
    label,
    enabled: true,
    global: { preview_mode: preview },
    leaders: [
      {
        ...leader,
        enabled: true,
        weight: 1,
        strategy: { type: "FIXED", copy_size: 1 },
      },
    ],
  };
}

function writeConfig(
  pollIntervalMs: number,
  healthPort: number,
  proxy: Record<string, unknown>,
  accounts: Record<string, unknown>[],
  maxOrderUsd = 20
): void {
  writeFileSync(
    "config.yaml",
    stringifyYaml({
      defaults: {
        global: {
          poll_interval_ms: pollIntervalMs,
          activity_limit: 100,
          preview_mode: true,
          copy_price_mode: "leader_limit",
          copy_trades_only: true,
          max_trade_age_hours: 1,
          buy_dedup_window_ms: 60_000,
          trade_aggregation_window_ms: 0,
          health_port: healthPort,
          risk: {
            enable_copy_trading: true,
            daily_loss_cap_pct: 20,
            starting_capital_usd: 200,
            max_daily_volume_usd: 200,
            max_open_markets: 10,
            max_order_usd: maxOrderUsd,
            min_order_usd: 1,
            slippage_tolerance: 0.03,
            max_position_per_token_usd: 0,
            sync_wallet_balance: false,
          },
          execution: {
            order_type: "GTC",
            retry_limit: 3,
            network_retry_limit: 3,
            gtc_fill_timeout_ms: 10_000,
            pending_order_max_age_hours: 48,
          },
          conflict: { mode: "priority_leader", priority: [] },
          proxy,
        },
      },
      accounts,
    }),
    "utf8"
  );
}

describe("AccountManager.reloadConfig", () => {
  const originalCwd = process.cwd();
  const originalEnv = {
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
    address: process.env.POLYMARKET_ADDRESS,
    liveConfirm: process.env.POLYMIRROR_LIVE_CONFIRM,
    healthPort: process.env.HEALTH_PORT,
    dbPath: process.env.POLYMIRROR_DB_PATH,
  };

  afterEach(() => {
    process.chdir(originalCwd);
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("POLYMARKET_PRIVATE_KEY", originalEnv.privateKey);
    restore("POLYMARKET_ADDRESS", originalEnv.address);
    restore("POLYMIRROR_LIVE_CONFIRM", originalEnv.liveConfirm);
    restore("HEALTH_PORT", originalEnv.healthPort);
    restore("POLYMIRROR_DB_PATH", originalEnv.dbPath);
    resolveLeaderAddressesSpy.mockReset();
  });

  it("keeps every runtime and global unchanged when a later leader resolution fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-account-reload-"));
    process.chdir(dir);
    process.env.POLYMARKET_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.POLYMARKET_ADDRESS = TEST_WALLET;
    process.env.POLYMIRROR_LIVE_CONFIRM = "I_UNDERSTAND_LIVE_TRADING";
    delete process.env.HEALTH_PORT;
    delete process.env.POLYMIRROR_DB_PATH;

    resolveLeaderAddressesSpy.mockImplementation(async (leaders: LeaderConfig[]) => {
      if (leaders.some((leader) => leader.username === "fail-later")) {
        throw new Error("later leader resolution failed");
      }
      return leaders.map((leader) =>
        leader.address ? leader : { ...leader, address: LEADER_A }
      );
    });

    writeConfig(1_000, 8_080, { mode: "none" }, [
      account("first", "First original", { id: "first-leader", address: LEADER_A }),
      account("second", "Second original", { id: "second-leader", address: LEADER_B }),
    ]);

    const manager = await AccountManager.create("config.yaml");
    const firstBefore = manager.require("first");
    const secondBefore = manager.require("second");
    const firstStore = firstBefore.store;
    const firstDbPath = firstBefore.dbPath;
    const normalizedBefore = manager.getNormalized();
    const proxyBefore = { ...getProxyConfig() };
    const proxySourceBefore = getProxySource();

    try {
      writeConfig(
        2_000,
        9_090,
        { mode: "static", static_url: "http://127.0.0.1:9876" },
        [
          account(
            "first",
            "First changed",
            { id: "first-leader", username: "resolved-earlier" },
            false
          ),
          account("second", "Second changed", {
            id: "second-leader",
            username: "fail-later",
          }),
        ]
      );

      await expect(manager.reloadConfig()).rejects.toThrow("later leader resolution failed");

      expect(manager.require("first")).toBe(firstBefore);
      expect(manager.require("second")).toBe(secondBefore);
      expect(firstBefore.label).toBe("First original");
      expect(firstBefore.config.app.global.previewMode).toBe(true);
      expect(firstBefore.dbPath).toBe(firstDbPath);
      expect(firstBefore.store).toBe(firstStore);
      expect(manager.pollIntervalMs).toBe(1_000);
      expect(manager.healthPort).toBe(8_080);
      expect(manager.getNormalized()).toBe(normalizedBefore);
      expect(getProxyConfig()).toEqual(proxyBefore);
      expect(getProxySource()).toBe(proxySourceBefore);

      firstStore.markSeen("still-usable", "first-leader");
      expect(firstStore.hasSeen("still-usable")).toBe(true);
    } finally {
      manager.closeAll();
      setProxyConfig(proxyBefore, proxySourceBefore);
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts, resumes, and rotates the account experiment from decision config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-account-experiment-"));
    process.chdir(dir);
    process.env.POLYMARKET_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.POLYMARKET_ADDRESS = TEST_WALLET;
    resolveLeaderAddressesSpy.mockImplementation(async (leaders: LeaderConfig[]) => leaders);
    writeConfig(1_000, 8_080, { mode: "none" }, [
      account("candidate", "Original label", { id: "leader", address: LEADER_A }),
    ]);

    const manager = await AccountManager.create("config.yaml");
    try {
      const first = manager.require("candidate").store.getActiveExperiment("candidate");
      expect(first).toMatchObject({ accountId: "candidate", trustClass: "candidate" });

      writeConfig(1_000, 8_080, { mode: "none" }, [
        account("candidate", "Changed label", { id: "leader", address: LEADER_A }),
      ]);
      await manager.reloadConfig();
      expect(manager.require("candidate").store.getActiveExperiment("candidate")?.experimentId)
        .toBe(first?.experimentId);

      writeConfig(1_000, 8_080, { mode: "none" }, [
        account("candidate", "Changed label", { id: "leader", address: LEADER_A }),
      ], 19);
      await manager.reloadConfig();
      const rows = manager.require("candidate").store.listExperiments();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.endedAt).not.toBeNull();
      expect(rows[1]?.experimentId).not.toBe(first?.experimentId);
    } finally {
      manager.closeAll();
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
