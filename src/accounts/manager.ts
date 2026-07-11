import { resolveLeaderAddresses } from "../leaders/resolve.js";
import {
  loadMultiAccountConfig,
  mapNormalizedAccounts,
  mapAccountToRuntime,
  readNormalizedConfig,
  validateAllAccounts,
} from "../config/load.js";
import type { AccountDefinition, MultiAccountConfig, RuntimeConfig } from "../config/types.js";
import { StateStore } from "../state/store.js";
import {
  newAccountHealth,
  updateAccountHealthAfterPoll,
  type AccountRuntime,
} from "./runtime.js";
import { resolveAccountDbPath } from "../state/db-path.js";
import { logInfo } from "../notify/logger.js";
import type { CopyCycleResult } from "../engine/copy-cycle.js";
import { readSqliteFootprintBytes } from "../engine/capacity-guard.js";
import {
  readNormalizedConfigDocument,
  writeNormalizedConfigDocument,
  type NormalizedConfigDocument,
} from "../config/write.js";
import { assertLiveTradingAllowed, assertLiveTradingForAccounts } from "../engine/risk.js";
import { migrateExistingPreviewToLiveDb } from "../engine/mode-transition.js";
import { applyProxyFromYaml } from "../util/proxy.js";
import { provenanceTrustClass, readRuntimeProvenance } from "../experiments/provenance.js";
import type { ExperimentManifestRow } from "../experiments/manifest.js";

function startAccountExperiment(
  accountId: string,
  config: RuntimeConfig,
  store: StateStore
): ExperimentManifestRow {
  const provenance = readRuntimeProvenance();
  const activeTrust = store.getActiveExperiment(accountId)?.trustClass;
  const requestedTrust = activeTrust === "legacy"
    ? "legacy"
    : activeTrust === "verified"
      ? "verified"
      : store.hasLegacyEvidence() && !activeTrust
        ? "legacy"
        : "candidate";
  return store.startOrResumeExperiment({
    accountId,
    candidateAddresses: config.app.leaders
      .filter((leader) => leader.enabled && leader.address)
      .map((leader) => leader.address!),
    config,
    ...provenance,
    trustClass: provenanceTrustClass(requestedTrust, provenance),
  });
}

export interface AccountApiContext {
  accountId: string;
  label: string;
  enabled: boolean;
  getConfig: () => RuntimeConfig;
  store: StateStore;
  dbPath: string;
  configPath: string;
  reloadConfig: () => Promise<void>;
}

export class AccountManager {
  private runtimes = new Map<string, AccountRuntime>();
  private normalized: NormalizedConfigDocument;
  readonly configPath: string;
  readonly configFileKey: string;
  readonly defaultAccountId: string;
  pollIntervalMs: number;
  healthPort: number;

  private constructor(
    configPath: string,
    configFileKey: string,
    multi: MultiAccountConfig,
    normalized: NormalizedConfigDocument,
    runtimes: AccountRuntime[]
  ) {
    this.configPath = configPath;
    this.configFileKey = configFileKey;
    this.defaultAccountId = multi.defaultAccountId;
    this.pollIntervalMs = multi.pollIntervalMs;
    this.healthPort = multi.healthPort;
    this.normalized = normalized;
    for (const rt of runtimes) {
      this.runtimes.set(rt.id, rt);
    }
  }

  static async create(configFileKey = "config.yaml"): Promise<AccountManager> {
    const multi = loadMultiAccountConfig(configFileKey);
    const validationError = validateAllAccounts(multi.accounts);
    if (validationError) {
      throw new Error(validationError);
    }

    const normalized = readNormalizedConfig(configFileKey);
    const runtimes: AccountRuntime[] = [];

    for (const def of multi.accounts) {
      const resolvedLeaders = await resolveLeaderAddresses(def.config.app.leaders);
      const config: RuntimeConfig = {
        wallet: def.config.wallet,
        app: { ...def.config.app, leaders: resolvedLeaders },
      };

      if (!config.app.global.previewMode) {
        migrateExistingPreviewToLiveDb(def.id);
      }

      const store = new StateStore(def.dbPath);
      startAccountExperiment(def.id, config, store);
      runtimes.push({
        id: def.id,
        label: def.label,
        enabled: def.enabled,
        walletEnv: def.walletEnv,
        config,
        store,
        dbPath: def.dbPath,
        health: newAccountHealth(config),
      });
    }

    return new AccountManager(multi.configPath, configFileKey, multi, normalized, runtimes);
  }

  list(): AccountRuntime[] {
    return [...this.runtimes.values()];
  }

  enabled(): AccountRuntime[] {
    return this.list().filter((a) => a.enabled);
  }

  get(accountId: string): AccountRuntime | undefined {
    return this.runtimes.get(accountId);
  }

  require(accountId: string): AccountRuntime {
    const rt = this.get(accountId);
    if (!rt) throw new Error(`Account not found: ${accountId}`);
    return rt;
  }

  resolveAccountId(accountId?: string | null): string {
    const id = accountId?.trim();
    if (id && this.runtimes.has(id)) return id;
    if (id && !this.runtimes.has(id)) throw new Error(`Account not found: ${id}`);
    return this.defaultAccountId;
  }

  toApiContext(accountId?: string | null): AccountApiContext {
    const id = this.resolveAccountId(accountId);
    const manager = this;
    return {
      accountId: id,
      get label() {
        return manager.require(id).label;
      },
      get enabled() {
        return manager.require(id).enabled;
      },
      getConfig: () => manager.require(id).config,
      get store() {
        return manager.require(id).store;
      },
      get dbPath() {
        return manager.require(id).dbPath;
      },
      configPath: this.configPath,
      reloadConfig: () => this.reloadConfig(),
    };
  }

  getNormalized(): NormalizedConfigDocument {
    return this.normalized;
  }

  async reloadConfig(): Promise<void> {
    const normalized = readNormalizedConfig(this.configFileKey);
    const accounts = mapNormalizedAccounts(normalized);
    if (accounts.length === 0) {
      throw new Error("No valid accounts in config.yaml");
    }
    if (!accounts.some((account) => account.enabled)) {
      console.warn("Warning: no enabled accounts in config.yaml");
    }
    const validationError = validateAllAccounts(accounts);
    if (validationError) throw new Error(validationError);
    assertLiveTradingForAccounts(accounts);

    const stagedRuntimes = new Map<string, AccountRuntime>();
    const replacementStores: StateStore[] = [];
    try {
      for (const def of accounts) {
        const resolvedLeaders = await resolveLeaderAddresses(def.config.app.leaders);
        const config: RuntimeConfig = {
          wallet: def.config.wallet,
          app: { ...def.config.app, leaders: resolvedLeaders },
        };
        const previewMode = config.app.global.previewMode;
        const dbPath = resolveAccountDbPath(def.id, previewMode);
        if (!previewMode) {
          migrateExistingPreviewToLiveDb(def.id);
        }

        const current = this.runtimes.get(def.id);
        const store =
          current?.dbPath === dbPath
            ? current.store
            : (() => {
                const replacement = new StateStore(dbPath);
                replacementStores.push(replacement);
                return replacement;
              })();
        const health = current
          ? {
              ...current.health,
              previewMode,
              enabledLeaders: config.app.leaders
                .filter((leader) => leader.enabled)
                .map((leader) => leader.id),
              walletDrifts: [...current.health.walletDrifts],
            }
          : newAccountHealth(config);

        stagedRuntimes.set(def.id, {
          id: def.id,
          label: def.label,
          enabled: def.enabled,
          walletEnv: def.walletEnv,
          config,
          store,
          dbPath,
          health,
        });
      }
    } catch (error) {
      for (const store of replacementStores) {
        try {
          store.close();
        } catch {
          // Preserve the staging error.
        }
      }
      throw error;
    }

    const experimentStores = [...new Set([...stagedRuntimes.values()].map((runtime) => runtime.store))];
    const transitionIds = new Map<StateStore, string[]>();
    try {
      for (const store of experimentStores) store.beginExperimentBatch();
      for (const runtime of stagedRuntimes.values()) {
        const experiment = startAccountExperiment(runtime.id, runtime.config, runtime.store);
        if (experiment.state === "PREPARED") {
          const ids = transitionIds.get(runtime.store) ?? [];
          ids.push(experiment.experimentId);
          transitionIds.set(runtime.store, ids);
        }
      }
      for (const store of experimentStores) store.commitExperimentBatch();
      for (const store of experimentStores) {
        store.finalizePreparedExperiments(transitionIds.get(store) ?? []);
      }
    } catch (error) {
      for (const store of experimentStores) {
        try {
          store.rollbackExperimentBatch();
        } catch {
          // Preserve the manifest staging error.
        }
      }
      for (const store of experimentStores) {
        try {
          store.abortPreparedExperiments(transitionIds.get(store) ?? []);
        } catch {
          // Preserve the manifest staging error.
        }
      }
      for (const store of replacementStores) {
        try {
          store.close();
        } catch {
          // Preserve the manifest staging error.
        }
      }
      throw error;
    }

    const previousRuntimes = this.runtimes;
    applyProxyFromYaml(normalized.defaultsGlobal.proxy);
    this.runtimes = stagedRuntimes;
    this.normalized = normalized;
    this.pollIntervalMs = Math.min(
      ...accounts.map((account) => account.config.app.global.pollIntervalMs)
    );
    this.healthPort = accounts[0]!.config.app.global.healthPort;

    const retainedStores = new Set([...stagedRuntimes.values()].map((runtime) => runtime.store));
    for (const [id, runtime] of previousRuntimes) {
      if (!retainedStores.has(runtime.store)) runtime.store.close();
      if (!stagedRuntimes.has(id)) {
        logInfo("Account removed on config reload", { accountId: id });
      }
    }

    logInfo("Config reloaded", {
      accounts: [...this.runtimes.keys()],
    });
  }

  updateHealthAfterPoll(
    accountId: string,
    result: CopyCycleResult,
    walletDrifts: string[]
  ): void {
    const rt = this.require(accountId);
    const control = rt.store.getExperimentControl();
    const activeFailures = rt.store.listActiveSettlementFailures();
    const failedConditions = new Set(
      activeFailures.map((failure) => `${failure.leaderId}\n${failure.conditionId}`)
    );
    const closedMarketOpenPositions = [...failedConditions].reduce((sum, key) => {
      const [leaderId, conditionId] = key.split("\n");
      return sum + rt.store.listPositionsByCondition(leaderId!, conditionId!).length;
    }, 0);
    const equity = rt.store.getLatestEquitySnapshot();
    const dbSizeBytes = readSqliteFootprintBytes(rt.dbPath);
    updateAccountHealthAfterPoll(
      rt.health,
      result,
      rt.store.isKillSwitchActive(),
      rt.store.listPendingOrders().length,
      walletDrifts,
      {
        experimentState: control?.state ?? "ACTIVE",
        experimentReason: control?.reasonCode ?? null,
        settlementFailures: activeFailures.length,
        closedMarketOpenPositions,
        liquidationEquityUsd: equity?.equityUsd ?? null,
        liquidationDrawdownPct: equity?.drawdownPct ?? null,
        quoteCoveragePct: equity ? equity.quoteCoverage * 100 : null,
        dbSizeBytes,
      }
    );
  }

  closeAll(): void {
    for (const rt of this.runtimes.values()) {
      rt.store.close();
    }
  }

  buildAccountsSummary() {
    return this.list().map((rt) => {
      const today = rt.store.getTodayStats();
      const initialCapitalUsd = rt.config.app.global.risk.startingCapitalUsd;
      const positionSummary = rt.store.getOpenPositionSummary();
      const todayRealizedPnl = today?.realizedPnl ?? rt.store.getDailyRealizedPnl();
      const cashUsd = rt.config.app.global.previewMode
        ? rt.store.readCashBalance(initialCapitalUsd)
        : null;
      return {
        id: rt.id,
        label: rt.label,
        enabled: rt.enabled,
        walletAddress: rt.config.wallet.proxyAddress,
        walletEnv: rt.walletEnv || null,
        previewMode: rt.config.app.global.previewMode,
        dbPath: rt.dbPath,
        killSwitchActive: rt.store.isKillSwitchActive(),
        enabledLeaders: rt.health.enabledLeaders,
        lastPollAt: rt.health.lastPollAt,
        lastPoll: rt.health.lastPollResult,
        todayVolumeUsd: today?.volumeUsd ?? rt.store.getDailyVolumeUsd(),
        todayCopyCount: today?.copyCount ?? 0,
        todayRealizedPnl,
        initialCapitalUsd,
        cashUsd,
        openCostUsd: positionSummary.openCostUsd,
        openPositions: positionSummary.openPositions,
        pendingOrders: rt.store.listPendingOrders().length,
        reconcilingOrders: rt.store.countReconcilingOrders(),
        quarantinedOrderIntents: rt.store.countQuarantinedLiveOrderIntents(),
        experimentState: rt.store.getExperimentControl()?.state ?? "ACTIVE",
        experimentReason: rt.store.getExperimentControl()?.reasonCode ?? null,
        settlementFailures: rt.store.listActiveSettlementFailures().length,
        liquidationEquityUsd: rt.store.getLatestEquitySnapshot()?.equityUsd ?? null,
        liquidationDrawdownPct: rt.store.getLatestEquitySnapshot()?.drawdownPct ?? null,
        dbSizeBytes: rt.health.dbSizeBytes ?? 0,
        dbGrowthBytesPerHour: rt.health.dbGrowthBytesPerHour ?? null,
      };
    });
  }

  writeNormalized(normalized: NormalizedConfigDocument): void {
    writeNormalizedConfigDocument(this.configPath, normalized);
    this.normalized = normalized;
  }

  readNormalizedFromDisk(): NormalizedConfigDocument {
    return readNormalizedConfigDocument(this.configPath);
  }

  mapDefinition(accountId: string): AccountDefinition {
    return mapAccountToRuntime(this.normalized, accountId);
  }
}
