import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { StateStore } from "../src/state/store.js";
import { syncApiServer, type ApiServerState } from "../src/api/server.js";
import { healthSnapshot } from "../src/notify/health.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";
import type { ApiContext } from "../src/api/routes.js";
import type { AccountManager } from "../src/accounts/manager.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForListen(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function buildApiContext(
  dir: string,
  store: StateStore,
  runtimeOverride?: unknown[]
): ApiContext {
  const config = previewRuntimeConfig();
  const runtime = {
    id: "main",
    label: "Main",
    enabled: true,
    walletEnv: "",
    config,
    store,
    dbPath: join(dir, "test.db"),
    health: {
      previewMode: config.app.global.previewMode,
      lastPollAt: null,
      lastPollResult: null,
      get killSwitchActive() {
        return healthSnapshot.killSwitchActive;
      },
      enabledLeaders: [],
      lastError: null,
      pendingOrders: 0,
      walletDrifts: [],
    },
  };
  const runtimes = (runtimeOverride ?? [runtime]) as typeof runtime[];
  const manager = {
    defaultAccountId: "main",
    toApiContext: () => ({
      accountId: "main",
      label: "Main",
      enabled: true,
      getConfig: () => config,
      store,
      dbPath: join(dir, "test.db"),
      configPath: join(dir, "config.yaml"),
      reloadConfig: async () => {},
    }),
    require: () => runtime,
    buildAccountsSummary: () => [],
    list: () => runtimes,
    enabled: () => runtimes.filter((rt) => rt.enabled),
  } as unknown as AccountManager;

  return {
    manager,
    configPath: join(dir, "config.yaml"),
    configFileKey: "config.yaml",
    reloadConfig: async () => {},
  };
}

function resetHealthSnapshot(): void {
  healthSnapshot.startedAt = Date.now();
  healthSnapshot.previewMode = true;
  healthSnapshot.lastPollAt = null;
  healthSnapshot.lastPollResult = null;
  healthSnapshot.killSwitchActive = false;
  healthSnapshot.enabledLeaders = [];
  healthSnapshot.lastError = null;
  healthSnapshot.pendingOrders = 0;
  healthSnapshot.walletDrifts = [];
}

describe("syncApiServer", () => {
  let dir: string;
  let store: StateStore;
  let apiState: ApiServerState;
  let ctx: ApiContext;
  let portA = 0;
  let portB = 0;

  beforeEach(async () => {
    resetHealthSnapshot();
    dir = mkdtempSync(join(tmpdir(), "pm-api-server-"));
    store = new StateStore(join(dir, "test.db"));
    apiState = { server: null, port: 0 };
    portA = await freePort();
    portB = await freePort();
    while (portB === portA) {
      portB = await freePort();
    }
    ctx = buildApiContext(dir, store);
  });

  afterEach(async () => {
    if (apiState.server) {
      await closeServer(apiState.server);
      apiState.server = null;
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves /health on the configured port", async () => {
    const server = syncApiServer(apiState, portA, ctx);
    expect(server).not.toBeNull();
    await waitForListen(server!);

    const res = await fetchJson(`http://127.0.0.1:${portA}/health`);
    expect(res.status).toBe(200);
    expect((res.body as { status?: string }).status).toBe("ok");
  });

  it("keeps preview health HTTP-ok when a sandbox kill switch is active", async () => {
    healthSnapshot.previewMode = true;
    healthSnapshot.killSwitchActive = true;

    const server = syncApiServer(apiState, portA, ctx);
    expect(server).not.toBeNull();
    await waitForListen(server!);

    const res = await fetchJson(`http://127.0.0.1:${portA}/health`);
    expect(res.status).toBe(200);
    expect((res.body as { status?: string }).status).toBe("degraded");

    const status = await fetchJson(`http://127.0.0.1:${portA}/api/status`);
    expect(status.status).toBe(200);
    expect((status.body as { status?: string }).status).toBe("degraded");
  });

  it("defaults quality diagnostics to enabled accounts and keeps disabled history opt-in", async () => {
    const config = previewRuntimeConfig();
    const enabledRuntime = {
      id: "main",
      label: "Main",
      enabled: true,
      walletEnv: "",
      config,
      store,
      dbPath: join(dir, "test.db"),
      health: {
        previewMode: true,
        lastPollAt: null,
        lastPollResult: null,
        killSwitchActive: false,
        enabledLeaders: [],
        lastError: null,
        pendingOrders: 0,
        walletDrifts: [],
      },
    };
    const disabledRuntime = {
      ...enabledRuntime,
      id: "disabled-history",
      label: "Disabled history",
      enabled: false,
      dbPath: join(dir, "missing-disabled.db"),
    };
    ctx = buildApiContext(dir, store, [enabledRuntime, disabledRuntime]);

    const server = syncApiServer(apiState, portA, ctx);
    expect(server).not.toBeNull();
    await waitForListen(server!);

    const current = await fetchJson(`http://127.0.0.1:${portA}/api/quality`);
    expect(current.status).toBe(200);
    expect((current.body as { reports?: { accountId: string }[] }).reports?.map((r) => r.accountId)).toEqual([
      "main",
    ]);
    expect(
      (
        current.body as {
          summary?: {
            totalAccounts?: number;
            enabledAccounts?: number;
            stabilityGoal?: {
              requiredQualifiedStrategies: number;
              qualifiedStrategies: number;
              independentQualifiedStrategies: number;
              strategyRequirementPassed: boolean;
            };
          };
        }
      ).summary
    ).toMatchObject({
      totalAccounts: 2,
      enabledAccounts: 1,
      stabilityGoal: {
        requiredQualifiedStrategies: 2,
        qualifiedStrategies: 0,
        independentQualifiedStrategies: 0,
        strategyRequirementPassed: false,
      },
    });
    expect(
      (
        current.body as {
          reports?: Array<{
            accountId: string;
            enabledLeaderIds?: string[];
            stabilityGoal?: { passed: boolean };
          }>;
        }
      ).reports?.[0]
    ).toMatchObject({
      accountId: "main",
      enabledLeaderIds: ["0x0000000000000000000000000000000000000001"],
      stabilityGoal: { passed: false },
    });

    const withHistory = await fetchJson(
      `http://127.0.0.1:${portA}/api/quality?includeDisabled=1`
    );
    expect(withHistory.status).toBe(200);
    expect(
      (withHistory.body as { reports?: { accountId: string }[] }).reports?.map((r) => r.accountId)
    ).toEqual(["main", "disabled-history"]);
  });

  it("summarizes unexplained copy gaps for enabled quality reports", async () => {
    for (let i = 0; i < 6; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `gap-token-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        preview: true,
      });
    }
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "gap-token-explained",
      side: "BUY",
      reason: "price 0.02 < min 0.05",
      preview: true,
    });

    const server = syncApiServer(apiState, portA, ctx);
    expect(server).not.toBeNull();
    await waitForListen(server!);

    const res = await fetchJson(`http://127.0.0.1:${portA}/api/quality?windowMinutes=60`);

    expect(res.status).toBe(200);
    expect(
      (
        res.body as {
          summary?: {
            copyGap?: {
              accountsWithUnclassified: number;
              unclassifiedBuy: number;
              unclassifiedSell: number;
              unclassifiedTotal: number;
            };
          };
        }
      ).summary?.copyGap
    ).toMatchObject({
      accountsWithUnclassified: 1,
      unclassifiedBuy: 5,
      unclassifiedSell: 0,
      unclassifiedTotal: 5,
    });
  });

  it("separates active copy accounts from settle-only enabled accounts", async () => {
    const config = previewRuntimeConfig();
    const activeRuntime = {
      id: "main",
      label: "Main",
      enabled: true,
      walletEnv: "",
      config,
      store,
      dbPath: join(dir, "test.db"),
      health: {
        previewMode: true,
        lastPollAt: null,
        lastPollResult: null,
        killSwitchActive: false,
        enabledLeaders: ["leader-a"],
        lastError: null,
        pendingOrders: 0,
        walletDrifts: [],
      },
    };
    const settleOnlyConfig = {
      ...config,
      app: {
        ...config.app,
        leaders: config.app.leaders.map((leader) => ({ ...leader, enabled: false })),
      },
    };
    const settleOnlyRuntime = {
      ...activeRuntime,
      id: "settle-only",
      label: "Settle only",
      config: settleOnlyConfig,
      dbPath: join(dir, "missing-settle-only.db"),
      health: {
        ...activeRuntime.health,
        enabledLeaders: [],
      },
    };
    ctx = buildApiContext(dir, store, [activeRuntime, settleOnlyRuntime]);

    const server = syncApiServer(apiState, portA, ctx);
    expect(server).not.toBeNull();
    await waitForListen(server!);

    const res = await fetchJson(`http://127.0.0.1:${portA}/api/quality`);

    expect(res.status).toBe(200);
    const body = res.body as {
      reports?: { accountId: string; copyingActive?: boolean; enabledLeaderCount?: number }[];
      summary?: {
        enabledAccounts?: number;
        activeCopyAccounts?: number;
        settleOnlyAccounts?: number;
      };
    };
    expect(body.summary).toMatchObject({
      enabledAccounts: 2,
      activeCopyAccounts: 1,
      settleOnlyAccounts: 1,
    });
    expect(body.reports?.find((r) => r.accountId === "main")).toMatchObject({
      copyingActive: true,
      enabledLeaderCount: 1,
    });
    expect(body.reports?.find((r) => r.accountId === "settle-only")).toMatchObject({
      copyingActive: false,
      enabledLeaderCount: 0,
    });
  });

  it("keeps settle-only quality issues out of active copy pool summaries", async () => {
    const config = previewRuntimeConfig();
    const settleOnlyStore = new StateStore(join(dir, "settle-only.db"));
    try {
      for (let i = 0; i < 6; i++) {
        settleOnlyStore.audit({
          leaderId: "leader-archived",
          action: "DETECT",
          tokenId: `settle-gap-token-${i}`,
          side: "BUY",
          size: 1,
          price: 0.5,
          preview: true,
        });
      }

      const activeRuntime = {
        id: "main",
        label: "Main",
        enabled: true,
        walletEnv: "",
        config,
        store,
        dbPath: join(dir, "test.db"),
        health: {
          previewMode: true,
          lastPollAt: null,
          lastPollResult: null,
          killSwitchActive: false,
          enabledLeaders: ["leader-a"],
          lastError: null,
          pendingOrders: 0,
          walletDrifts: [],
        },
      };
      const settleOnlyConfig = {
        ...config,
        app: {
          ...config.app,
          leaders: config.app.leaders.map((leader) => ({ ...leader, enabled: false })),
        },
      };
      const settleOnlyRuntime = {
        ...activeRuntime,
        id: "settle-only",
        label: "Settle only",
        config: settleOnlyConfig,
        store: settleOnlyStore,
        dbPath: join(dir, "settle-only.db"),
        health: {
          ...activeRuntime.health,
          enabledLeaders: [],
        },
      };
      ctx = buildApiContext(dir, store, [activeRuntime, settleOnlyRuntime]);

      const server = syncApiServer(apiState, portA, ctx);
      expect(server).not.toBeNull();
      await waitForListen(server!);

      const res = await fetchJson(`http://127.0.0.1:${portA}/api/quality?windowMinutes=60`);

      expect(res.status).toBe(200);
      const summary = (
        res.body as {
          summary?: {
            issueCounts?: Record<string, number>;
            activeIssueCounts?: Record<string, number>;
            gateCounts?: Record<string, number>;
            activeGateCounts?: Record<string, number>;
            copyGap?: { unclassifiedTotal: number };
            activeCopyGap?: { unclassifiedTotal: number };
          };
        }
      ).summary;
      expect(summary?.issueCounts?.no_data).toBe(1);
      expect(summary?.issueCounts?.not_buying).toBe(1);
      expect(summary?.activeIssueCounts).toMatchObject({ no_data: 1 });
      expect(summary?.activeIssueCounts?.not_buying).toBeUndefined();
      expect(summary?.gateCounts?.watch).toBe(2);
      expect(summary?.activeGateCounts).toMatchObject({ watch: 1 });
      expect(summary?.copyGap?.unclassifiedTotal).toBe(6);
      expect(summary?.activeCopyGap).toMatchObject({ unclassifiedTotal: 0 });
    } finally {
      settleOnlyStore.close();
    }
  });

  it("summarizes fresh active copy gaps separately from older window pollution", async () => {
    const config = previewRuntimeConfig();
    for (let i = 0; i < 6; i++) {
      store.audit({
        leaderId: "leader-a",
        action: "DETECT",
        tokenId: `old-gap-token-${i}`,
        side: "BUY",
        size: 1,
        price: 0.5,
        preview: true,
      });
    }
    store.audit({
      leaderId: "leader-a",
      action: "DETECT",
      tokenId: "fresh-explained-token",
      side: "BUY",
      size: 1,
      price: 0.5,
      preview: true,
    });
    store.audit({
      leaderId: "leader-a",
      action: "SKIP",
      tokenId: "fresh-explained-token",
      side: "BUY",
      reason: "recent buy dedup",
      preview: true,
    });
    const db = new Database(join(dir, "test.db"));
    db.prepare("UPDATE audit_log SET ts = ? WHERE token_id LIKE 'old-gap-token-%'")
      .run(Date.now() - 30 * 60_000);
    db.close();

    const activeRuntime = {
      id: "main",
      label: "Main",
      enabled: true,
      walletEnv: "",
      config,
      store,
      dbPath: join(dir, "test.db"),
      health: {
        previewMode: true,
        lastPollAt: null,
        lastPollResult: null,
        killSwitchActive: false,
        enabledLeaders: ["leader-a"],
        lastError: null,
        pendingOrders: 0,
        walletDrifts: [],
      },
    };
    ctx = buildApiContext(dir, store, [activeRuntime]);

    const server = syncApiServer(apiState, portA, ctx);
    expect(server).not.toBeNull();
    await waitForListen(server!);

    const res = await fetchJson(`http://127.0.0.1:${portA}/api/quality?windowMinutes=60`);

    expect(res.status).toBe(200);
    const summary = (
      res.body as {
        summary?: {
          activeCopyGap?: { unclassifiedTotal: number };
          freshActiveCopyGap?: {
            windowMinutes: number;
            copyGap: { unclassifiedTotal: number };
          };
        };
      }
    ).summary;
    expect(summary?.activeCopyGap?.unclassifiedTotal).toBe(6);
    expect(summary?.freshActiveCopyGap).toMatchObject({
      windowMinutes: 15,
      copyGap: { unclassifiedTotal: 0 },
    });
  });

  it("returns 503 for live kill switch health", async () => {
    healthSnapshot.previewMode = false;
    healthSnapshot.killSwitchActive = true;

    const server = syncApiServer(apiState, portA, ctx);
    expect(server).not.toBeNull();
    await waitForListen(server!);

    const res = await fetchJson(`http://127.0.0.1:${portA}/health`);
    expect(res.status).toBe(503);
    expect((res.body as { status?: string }).status).toBe("degraded");
  });

  it("restarts when health_port changes", async () => {
    syncApiServer(apiState, portA, ctx);
    await waitForListen(apiState.server!);

    syncApiServer(apiState, portB, ctx);
    await waitForListen(apiState.server!);

    const oldPort = await fetch(`http://127.0.0.1:${portA}/health`).catch(() => null);
    expect(oldPort).toBeNull();

    const res = await fetchJson(`http://127.0.0.1:${portB}/health`);
    expect(res.status).toBe(200);
    expect(apiState.port).toBe(portB);
  });

  it("stops server when port is set to 0", async () => {
    syncApiServer(apiState, portA, ctx);
    await waitForListen(apiState.server!);

    syncApiServer(apiState, 0, ctx);
    expect(apiState.server).toBeNull();

    const res = await fetch(`http://127.0.0.1:${portA}/health`).catch(() => null);
    expect(res).toBeNull();
  });
});

describe("API auth", () => {
  let dir: string;
  let store: StateStore;
  let apiState: ApiServerState;
  let ctx: ApiContext;
  let port = 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pm-api-auth-"));
    store = new StateStore(join(dir, "test.db"));
    apiState = { server: null, port: 0 };
    port = await freePort();
    ctx = buildApiContext(dir, store);
  });

  afterEach(async () => {
    if (apiState.server) {
      await closeServer(apiState.server);
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("exposes /api/auth/config without token", async () => {
    vi.stubEnv("DASHBOARD_TOKEN", "");
    syncApiServer(apiState, port, ctx);
    await waitForListen(apiState.server!);

    const res = await fetchJson(`http://127.0.0.1:${port}/api/auth/config`);
    expect(res.status).toBe(200);
    expect((res.body as { authRequired?: boolean }).authRequired).toBe(false);
  });

  it("requires Bearer token for protected routes when DASHBOARD_TOKEN is set", async () => {
    vi.stubEnv("DASHBOARD_TOKEN", "secret-test-token");
    syncApiServer(apiState, port, ctx);
    await waitForListen(apiState.server!);

    const denied = await fetchJson(`http://127.0.0.1:${port}/api/positions`);
    expect(denied.status).toBe(401);

    const ok = await fetchJson(`http://127.0.0.1:${port}/api/positions`, {
      headers: { Authorization: "Bearer secret-test-token" },
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { positions?: unknown[] }).positions).toEqual([]);
  });
});
