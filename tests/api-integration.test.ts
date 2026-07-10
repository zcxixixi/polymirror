import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { assertLiveTradingAllowed, assertLiveTradingForAccounts } from "../src/engine/risk.js";
import { patchGlobalSettings, setPreviewMode, stopCopyTrading } from "../src/api/settings.js";
import type { ApiContext } from "../src/api/routes.js";
import type { AccountApiContext } from "../src/accounts/manager.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";
import { StateStore } from "../src/state/store.js";

const { migratePreviewToLiveDbSpy } = vi.hoisted(() => ({
  migratePreviewToLiveDbSpy: vi.fn(),
}));

vi.mock("../src/engine/mode-transition.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine/mode-transition.js")>()),
  migratePreviewToLiveDb: migratePreviewToLiveDbSpy,
}));

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

function withRuntimeWallet<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["POLYMARKET_PRIVATE_KEY", "POLYMARKET_ADDRESS", "POLYMARKET_SIGNATURE_TYPE"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.POLYMARKET_PRIVATE_KEY = `0x${"1".repeat(64)}`;
  process.env.POLYMARKET_ADDRESS = `0x${"2".repeat(40)}`;
  delete process.env.POLYMARKET_SIGNATURE_TYPE;
  return fn().finally(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
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

  function withLiveConfirm<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.POLYMIRROR_LIVE_CONFIRM;
    process.env.POLYMIRROR_LIVE_CONFIRM = "I_UNDERSTAND_LIVE_TRADING";
    return fn().finally(() => {
      if (previous === undefined) delete process.env.POLYMIRROR_LIVE_CONFIRM;
      else process.env.POLYMIRROR_LIVE_CONFIRM = previous;
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

  it("rejects a guarded mode change against a legacy database before write or reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-settings-copy-mode-preflight-"));
    const configPath = writeSettingsConfig(dir);
    const before = readFileSync(configPath);
    const store = new StateStore(join(dir, "preview.db"));
    const config = previewRuntimeConfig();
    config.wallet.signatureType = 1;
    let reloads = 0;
    const root = {
      configPath,
      reloadConfig: async () => {
        reloads += 1;
      },
      manager: { buildAccountsSummary: () => [], list: () => [] },
    } as unknown as ApiContext;
    const actx = {
      accountId: "default",
      dbPath: join(dir, "preview.db"),
      getConfig: () => config,
      store,
    } as AccountApiContext;

    try {
      store.applyCopyFill("leader-a", "token-a", "BUY", 1, 0.5);
      const result = await withTestWallet(() =>
        patchGlobalSettings(root, actx, {
          copyPriceMode: "executable_guarded",
          execution: { orderType: "FOK" },
        })
      );
      expect(result.status).toBe(400);
      expect(String((result.body as { error?: string }).error)).toMatch(/copy price mode mismatch/);
      expect(readFileSync(configPath)).toEqual(before);
      expect(reloads).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves preview-to-live migration to the rollback-protected reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-settings-reload-migration-"));
    const configPath = writeSettingsConfig(dir);
    const before = readFileSync(configPath);
    const config = previewRuntimeConfig();
    config.wallet.signatureType = 1;
    let reloads = 0;
    migratePreviewToLiveDbSpy.mockReset();
    const root = {
      configPath,
      reloadConfig: async () => {
        reloads += 1;
        if (reloads === 1) throw new Error("reload failed");
      },
      manager: { buildAccountsSummary: () => [], list: () => [] },
    } as unknown as ApiContext;
    const actx = {
      accountId: "default",
      dbPath: join(dir, "preview.db"),
      getConfig: () => config,
      store: new StateStore(join(dir, "preview.db")),
    } as AccountApiContext;

    try {
      const result = await withLiveConfirm(() =>
        withTestWallet(() => patchGlobalSettings(root, actx, { previewMode: false }))
      );
      expect(result.status).toBe(400);
      expect(readFileSync(configPath)).toEqual(before);
      expect(reloads).toBe(2);
      expect(migratePreviewToLiveDbSpy).not.toHaveBeenCalled();
    } finally {
      actx.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mode settings writes", () => {
  it("validates a set-preview candidate before flushing pending orders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-set-preview-validation-"));
    const configPath = writeSettingsConfig(dir);
    writeFileSync(
      configPath,
      stringifyYaml({
        global: {
          preview_mode: false,
          copy_price_mode: "executable_guarded",
          risk: { slippage_tolerance: 0.03 },
          execution: { order_type: "GTC" },
          conflict: {},
        },
        leaders: [],
      })
    );
    const config = previewRuntimeConfig();
    config.app.global.previewMode = false;
    config.app.global.copyPriceMode = "executable_guarded";
    config.app.global.execution.orderType = "GTC";
    let pendingReads = 0;
    const root = {
      configPath,
      reloadConfig: async () => {},
      manager: { buildAccountsSummary: () => [], list: () => [] },
    } as unknown as ApiContext;
    const actx = {
      accountId: "default",
      getConfig: () => config,
      store: { listPendingOrders: () => (pendingReads += 1, []) },
    } as unknown as AccountApiContext;

    try {
      const result = await setPreviewMode(root, actx, true);
      expect(result.status).toBe(400);
      expect(pendingReads).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates a stop-copy candidate before flushing pending orders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-stop-copy-validation-"));
    const configPath = writeSettingsConfig(dir);
    writeFileSync(
      configPath,
      stringifyYaml({
        global: {
          preview_mode: false,
          copy_price_mode: "executable_guarded",
          risk: { slippage_tolerance: 0.03 },
          execution: { order_type: "GTC" },
          conflict: {},
        },
        leaders: [],
      })
    );
    const config = previewRuntimeConfig();
    config.app.global.previewMode = false;
    config.app.global.copyPriceMode = "executable_guarded";
    config.app.global.execution.orderType = "GTC";
    let pendingReads = 0;
    const root = {
      configPath,
      reloadConfig: async () => {},
      manager: { buildAccountsSummary: () => [], list: () => [] },
    } as unknown as ApiContext;
    const actx = {
      accountId: "default",
      getConfig: () => config,
      store: { listPendingOrders: () => (pendingReads += 1, []) },
    } as unknown as AccountApiContext;

    try {
      const result = await stopCopyTrading(root, actx);
      expect(result.status).toBe(400);
      expect(pendingReads).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["setPreviewMode", (root: ApiContext, actx: AccountApiContext) => setPreviewMode(root, actx, true)],
    ["stopCopyTrading", (root: ApiContext, actx: AccountApiContext) => stopCopyTrading(root, actx)],
  ])("restores the exact config and reloads it when %s reload fails", async (_name, action) => {
    const dir = mkdtempSync(join(tmpdir(), "pm-mode-settings-rollback-"));
    const configPath = writeSettingsConfig(dir);
    const before = readFileSync(configPath);
    const config = previewRuntimeConfig();
    let reloads = 0;
    const root = {
      configPath,
      reloadConfig: async () => {
        reloads += 1;
        if (reloads === 1) throw new Error("reload failed");
      },
      manager: { buildAccountsSummary: () => [], list: () => [] },
    } as unknown as ApiContext;
    const actx = {
      accountId: "default",
      dbPath: join(dir, "preview.db"),
      getConfig: () => config,
      store: { listPendingOrders: () => [] },
    } as unknown as AccountApiContext;

    try {
      const result = await withRuntimeWallet(() => action(root, actx));
      expect(result.status).toBe(400);
      expect(readFileSync(configPath)).toEqual(before);
      expect(reloads).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
