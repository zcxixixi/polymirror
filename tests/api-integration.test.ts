import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { assertLiveTradingAllowed, assertLiveTradingForAccounts } from "../src/engine/risk.js";
import { patchGlobalSettings } from "../src/api/settings.js";
import type { ApiContext } from "../src/api/routes.js";
import type { AccountApiContext } from "../src/accounts/manager.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

function writeSettingsConfig(dir: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    stringifyYaml({
      global: {
        preview_mode: true,
        copy_price_mode: "leader_limit",
        risk: { slippage_tolerance: 0.03 },
        execution: { order_type: "GTC" },
        conflict: {},
      },
      leaders: [],
    }),
    "utf8"
  );
  return path;
}

describe("assertLiveTradingAllowed", () => {
  it("allows preview mode without confirm env", () => {
    expect(() => assertLiveTradingAllowed(true)).not.toThrow();
  });

  it("blocks live trading without POLYMIRROR_LIVE_CONFIRM", () => {
    const prevConfirm = process.env.POLYMIRROR_LIVE_CONFIRM;
    const prevRequire = process.env.REQUIRE_LIVE_CONFIRM;
    delete process.env.POLYMIRROR_LIVE_CONFIRM;
    process.env.REQUIRE_LIVE_CONFIRM = "true";
    try {
      expect(() => assertLiveTradingAllowed(false)).toThrow(/I_UNDERSTAND_LIVE_TRADING/);
    } finally {
      if (prevConfirm !== undefined) process.env.POLYMIRROR_LIVE_CONFIRM = prevConfirm;
      else delete process.env.POLYMIRROR_LIVE_CONFIRM;
      if (prevRequire !== undefined) process.env.REQUIRE_LIVE_CONFIRM = prevRequire;
      else delete process.env.REQUIRE_LIVE_CONFIRM;
    }
  });

  it("allows live when confirm env is set", () => {
    const prevConfirm = process.env.POLYMIRROR_LIVE_CONFIRM;
    const prevRequire = process.env.REQUIRE_LIVE_CONFIRM;
    process.env.POLYMIRROR_LIVE_CONFIRM = "I_UNDERSTAND_LIVE_TRADING";
    process.env.REQUIRE_LIVE_CONFIRM = "true";
    try {
      expect(() => assertLiveTradingAllowed(false)).not.toThrow();
    } finally {
      if (prevConfirm !== undefined) process.env.POLYMIRROR_LIVE_CONFIRM = prevConfirm;
      else delete process.env.POLYMIRROR_LIVE_CONFIRM;
      if (prevRequire !== undefined) process.env.REQUIRE_LIVE_CONFIRM = prevRequire;
      else delete process.env.REQUIRE_LIVE_CONFIRM;
    }
  });
});

describe("assertLiveTradingForAccounts", () => {
  it("blocks when any account is live without confirm", () => {
    const prevConfirm = process.env.POLYMIRROR_LIVE_CONFIRM;
    const prevRequire = process.env.REQUIRE_LIVE_CONFIRM;
    delete process.env.POLYMIRROR_LIVE_CONFIRM;
    process.env.REQUIRE_LIVE_CONFIRM = "true";
    try {
      expect(() =>
        assertLiveTradingForAccounts([
          { config: { app: { global: { previewMode: true } } } },
          { config: { app: { global: { previewMode: false } } } },
        ])
      ).toThrow(/I_UNDERSTAND_LIVE_TRADING/);
    } finally {
      if (prevConfirm !== undefined) process.env.POLYMIRROR_LIVE_CONFIRM = prevConfirm;
      else delete process.env.POLYMIRROR_LIVE_CONFIRM;
      if (prevRequire !== undefined) process.env.REQUIRE_LIVE_CONFIRM = prevRequire;
      else delete process.env.REQUIRE_LIVE_CONFIRM;
    }
  });
});

describe("patchGlobalSettings live gate", () => {
  const mockRoot = {
    configPath: "/tmp/unused-config.yaml",
    reloadConfig: async () => {},
    manager: {
      buildAccountsSummary: () => [],
      list: () => [],
    },
  } as unknown as ApiContext;

  const mockActx = {
    accountId: "main",
  } as AccountApiContext;

  it("rejects previewMode:false without live confirm", async () => {
    const prevConfirm = process.env.POLYMIRROR_LIVE_CONFIRM;
    const prevRequire = process.env.REQUIRE_LIVE_CONFIRM;
    delete process.env.POLYMIRROR_LIVE_CONFIRM;
    process.env.REQUIRE_LIVE_CONFIRM = "true";
    try {
      const result = await patchGlobalSettings(mockRoot, mockActx, { previewMode: false });
      expect(result.status).toBe(400);
      expect(String((result.body as { error?: string }).error)).toMatch(/I_UNDERSTAND_LIVE_TRADING/);
    } finally {
      if (prevConfirm !== undefined) process.env.POLYMIRROR_LIVE_CONFIRM = prevConfirm;
      else delete process.env.POLYMIRROR_LIVE_CONFIRM;
      if (prevRequire !== undefined) process.env.REQUIRE_LIVE_CONFIRM = prevRequire;
      else delete process.env.REQUIRE_LIVE_CONFIRM;
    }
  });
});

describe("patchGlobalSettings guarded runtime validation", () => {
  const envKeys = ["POLYMARKET_PRIVATE_KEY", "POLYMARKET_ADDRESS", "POLYMARKET_SIGNATURE_TYPE"] as const;

  function withTestWallet<T>(fn: () => Promise<T>): Promise<T> {
    const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
    process.env.POLYMARKET_PRIVATE_KEY = `0x${"1".repeat(64)}`;
    process.env.POLYMARKET_ADDRESS = `0x${"2".repeat(40)}`;
    delete process.env.POLYMARKET_SIGNATURE_TYPE;
    return fn().finally(() => {
      for (const key of envKeys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  async function expectInvalidGuardedPatch(
    patch: { copyPriceMode: "executable_guarded"; risk?: { slippageTolerance: number }; execution?: { orderType: "FAK" } },
    expectedError: RegExp
  ) {
    const dir = mkdtempSync(join(tmpdir(), "pm-guarded-settings-"));
    const configPath = writeSettingsConfig(dir);
    const before = readFileSync(configPath);
    let reloads = 0;
    const config = previewRuntimeConfig();
    config.wallet.signatureType = 1;
    const root = {
      configPath,
      reloadConfig: async () => {
        reloads += 1;
      },
      manager: {
        buildAccountsSummary: () => [],
        list: () => [],
      },
    } as unknown as ApiContext;
    const actx = {
      accountId: "default",
      getConfig: () => config,
    } as AccountApiContext;

    try {
      const result = await withTestWallet(() => patchGlobalSettings(root, actx, patch));
      expect(result.status).toBe(400);
      expect(String((result.body as { error?: string }).error)).toMatch(expectedError);
      expect(readFileSync(configPath)).toEqual(before);
      expect(reloads).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rejects guarded mode with zero tolerance before writing or reloading", async () => {
    await expectInvalidGuardedPatch({
      copyPriceMode: "executable_guarded",
      risk: { slippageTolerance: 0 },
    }, /positive slippage_tolerance/);
  });

  it("rejects guarded mode with a non-FOK order before writing or reloading", async () => {
    await expectInvalidGuardedPatch({
      copyPriceMode: "executable_guarded",
      execution: { orderType: "FAK" },
    }, /execution\.order_type=FOK/);
  });

  it("validates the complete patch before touching live pending orders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-settings-side-effects-"));
    const configPath = writeSettingsConfig(dir);
    const config = previewRuntimeConfig();
    config.app.global.previewMode = false;
    config.wallet.signatureType = 1;
    let pendingReads = 0;
    const root = {
      configPath,
      reloadConfig: async () => {},
      manager: {
        buildAccountsSummary: () => [],
        list: () => [],
      },
    } as unknown as ApiContext;
    const actx = {
      accountId: "default",
      getConfig: () => config,
      store: {
        listPendingOrders: () => {
          pendingReads += 1;
          return [];
        },
      },
    } as unknown as AccountApiContext;

    try {
      const result = await withTestWallet(() =>
        patchGlobalSettings(root, actx, {
          previewMode: true,
          copyPriceMode: "executable_guarded",
          risk: { slippageTolerance: 0 },
        })
      );
      expect(result.status).toBe(400);
      expect(pendingReads).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the exact config and reloads it when hot reload fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-settings-rollback-"));
    const configPath = writeSettingsConfig(dir);
    const before = readFileSync(configPath);
    const config = previewRuntimeConfig();
    config.wallet.signatureType = 1;
    let reloads = 0;
    const root = {
      configPath,
      reloadConfig: async () => {
        reloads += 1;
        if (reloads === 1) throw new Error("reload failed");
      },
      manager: {
        buildAccountsSummary: () => [],
        list: () => [],
      },
    } as unknown as ApiContext;
    const actx = {
      accountId: "default",
      getConfig: () => config,
    } as AccountApiContext;

    try {
      const result = await withTestWallet(() =>
        patchGlobalSettings(root, actx, { risk: { slippageTolerance: 0.02 } })
      );
      expect(result.status).toBe(400);
      expect(String((result.body as { error?: string }).error)).toMatch(/reload failed/);
      expect(readFileSync(configPath)).toEqual(before);
      expect(reloads).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
