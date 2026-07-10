import type { ApiContext } from "./routes.js";
import type { AccountApiContext } from "../accounts/manager.js";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { healthSnapshot, syncAggregateHealth } from "../notify/health.js";
import {
  applyAccountGlobalSettingsPatch,
  globalConfigToDto,
  globalSettingsPatchSchema,
  proxyConfigToPublicDto,
  validateProxyPatch,
} from "../config/settings-schema.js";
import { readNormalizedConfigDocument, writeNormalizedConfigDocument } from "../config/write.js";
import { applyEnvToProcess, upsertEnvFile } from "../config/env-file.js";
import { accountMergedGlobal } from "../config/document.js";
import { mapNormalizedAccounts, validateAllAccounts } from "../config/load.js";
import { assertLiveTradingAllowed } from "../engine/risk.js";
import { logInfo } from "../notify/logger.js";
import {
  getEffectiveProxyUrl,
  getProxyConfig,
  getProxySource,
  isProxyConfigured,
  maskProxyUrl,
} from "../util/proxy.js";
import { fetchWithTimeout } from "../util/fetch.js";
import { StateStore } from "../state/store.js";
import {
  flushLivePendingBeforePreview,
  migratePreviewToLiveDb,
} from "../engine/mode-transition.js";
import type { GlobalSettingsPatch } from "../config/settings-schema.js";
import { resolveAccountDbPath } from "../state/db-path.js";

function maskAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatPendingFlushNote(flush: { resolved: number; remaining: number }): string {
  if (flush.resolved === 0 && flush.remaining === 0) return "";
  let note = `已处理 ${flush.resolved} 笔 Live 挂单`;
  if (flush.remaining > 0) {
    note += `，仍有 ${flush.remaining} 笔未结束（请到 Polymarket 手动检查）`;
  }
  return note + "。";
}

type LegacyCtx = {
  getConfig: () => import("../config/types.js").RuntimeConfig;
  store: import("../state/store.js").StateStore;
  accountId: string;
};

async function writeConfigAndReload(
  root: ApiContext,
  next: ReturnType<typeof readNormalizedConfigDocument>
): Promise<void> {
  const previous = readFileSync(root.configPath);
  try {
    writeNormalizedConfigDocument(root.configPath, next);
    await root.reloadConfig();
  } catch (error) {
    try {
      writeFileSync(root.configPath, previous);
      await root.reloadConfig();
    } catch (rollbackError) {
      const primary = error instanceof Error ? error.message : String(error);
      const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`${primary}; config rollback failed: ${rollback}`);
    }
    throw error;
  }
}

function validateSettingsCandidate(
  next: ReturnType<typeof readNormalizedConfigDocument>,
  actx: AccountApiContext
): void {
  const accounts = mapNormalizedAccounts(next);
  const validationError = validateAllAccounts(accounts);
  if (validationError) throw new Error(validationError);

  const candidate = accounts.find((account) => account.id === actx.accountId);
  if (!candidate) throw new Error(`Account not found: ${actx.accountId}`);

  const currentPreviewMode = actx.getConfig().app.global.previewMode;
  const candidatePreviewMode = candidate.config.app.global.previewMode;
  const dbPaths =
    currentPreviewMode && !candidatePreviewMode
      ? [actx.dbPath, candidate.dbPath]
      : [candidatePreviewMode === currentPreviewMode ? actx.dbPath : candidate.dbPath];
  for (const dbPath of new Set(dbPaths)) {
    const compatibility = StateStore.getCopyPriceModeCompatibilityForPath(
      dbPath,
      candidate.config.app.global.copyPriceMode
    );
    if (compatibility.status === "mismatch") {
      throw new Error(
        `copy price mode mismatch: database=${compatibility.mode} config=${candidate.config.app.global.copyPriceMode}`
      );
    }
  }
}

export function buildRiskSnapshot(ctx: LegacyCtx) {
  const config = ctx.getConfig();
  const g = config.app.global;
  const store = ctx.store;
  const today = store.getTodayStats();
  const pnl = today?.realizedPnl ?? store.getDailyRealizedPnl();
  const volumeUsd = today?.volumeUsd ?? store.getDailyVolumeUsd();
  const lossPct =
    pnl < 0 && g.risk.startingCapitalUsd > 0
      ? (Math.abs(pnl) / g.risk.startingCapitalUsd) * 100
      : 0;

  const positions = store.listPositions();
  const tokenMap = new Map<string, { shares: number; costUsd: number }>();
  for (const p of positions) {
    const cur = tokenMap.get(p.tokenId) ?? { shares: 0, costUsd: 0 };
    cur.shares += p.shares;
    cur.costUsd += p.shares * p.avgEntryPrice;
    tokenMap.set(p.tokenId, cur);
  }

  const tokenExposure = [...tokenMap.entries()].map(([tokenId, v]) => ({
    tokenId,
    shares: v.shares,
    exposureUsd: v.costUsd,
    capUsd: g.risk.maxPositionPerTokenUsd > 0 ? g.risk.maxPositionPerTokenUsd : null,
  }));

  const leaderStats = store.listLeaderTodayStats();
  const leaderVolumes = config.app.leaders.map((l) => ({
    leaderId: l.id,
    enabled: l.enabled,
    volumeUsd: leaderStats.find((s) => s.leaderId === l.id)?.volumeUsd ?? 0,
    maxDailyVolumeUsd: l.limits?.maxDailyVolumeUsd ?? null,
  }));

  const rt = ctx as LegacyCtx & { walletDrifts?: string[]; lastError?: string | null };
  return {
    accountId: ctx.accountId,
    killSwitchActive: store.isKillSwitchActive(),
    copyTradingEnabled: g.risk.enableCopyTrading,
    previewMode: g.previewMode,
    daily: {
      date: today?.date ?? new Date().toISOString().slice(0, 10),
      volumeUsd,
      maxDailyVolumeUsd: g.risk.maxDailyVolumeUsd,
      realizedPnl: pnl,
      startingCapitalUsd: g.risk.startingCapitalUsd,
      dailyLossCapPct: g.risk.dailyLossCapPct,
      lossPct,
      copyCount: today?.copyCount ?? 0,
    },
    openMarkets: {
      current: store.countOpenMarkets(),
      max: g.risk.maxOpenMarkets,
    },
    leaderVolumes,
    tokenExposure,
    walletDrifts: healthSnapshot.walletDrifts,
    lastError: healthSnapshot.lastError,
  };
}

export function buildSettingsSnapshot(root: ApiContext, actx: AccountApiContext) {
  const config = actx.getConfig();
  const normalized = readNormalizedConfigDocument(root.configPath);
  const account = normalized.accounts.find((a) => a.id === actx.accountId);
  const mergedGlobal = account
    ? accountMergedGlobal(normalized, account)
    : normalized.defaultsGlobal;
  const global = {
    ...globalConfigToDto(mergedGlobal as Record<string, unknown>),
    proxy: proxyConfigToPublicDto(normalized.defaultsGlobal as Record<string, unknown>),
  };

  const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const tgChat = process.env.TELEGRAM_CHAT_ID?.trim();
  const liveConfirm = (process.env.POLYMIRROR_LIVE_CONFIRM ?? "").trim();
  const effectiveUrl = getEffectiveProxyUrl(false) ?? "";

  return {
    accountId: actx.accountId,
    accountLabel: actx.label,
    global,
    env: {
      telegramConfigured: Boolean(tgToken && tgChat),
      telegramTokenSet: Boolean(tgToken),
      telegramChatSet: Boolean(tgChat),
      liveConfirmSet: liveConfirm === "I_UNDERSTAND_LIVE_TRADING",
      requireLiveConfirm: (process.env.REQUIRE_LIVE_CONFIRM ?? "true").toLowerCase() !== "false",
      walletAddress: maskAddress(config.wallet.proxyAddress),
      hasHttpsProxy: isProxyConfigured(),
      proxy: {
        configured: isProxyConfigured(),
        mode: getProxyConfig().mode,
        source: getProxySource(),
        urlMasked: maskProxyUrl(effectiveUrl),
        envFallback: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY),
      },
    },
    configPath: root.configPath,
    dbPath: actx.dbPath,
    previewMode: config.app.global.previewMode,
    accounts: root.manager.buildAccountsSummary(),
  };
}

export async function patchGlobalSettings(
  root: ApiContext,
  actx: AccountApiContext,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  try {
    const patch = globalSettingsPatchSchema.parse(body);
    if (patch.previewMode === false) {
      assertLiveTradingAllowed(false);
      patch.risk = { ...patch.risk, enableCopyTrading: patch.risk?.enableCopyTrading ?? true };
    }
    const currentConfig = actx.getConfig();
    const normalized = readNormalizedConfigDocument(root.configPath);
    if (patch.proxy) {
      validateProxyPatch(patch.proxy, normalized.defaultsGlobal as Record<string, unknown>);
    }
    const next = applyAccountGlobalSettingsPatch(normalized, actx.accountId, patch);
    validateSettingsCandidate(next, actx);

    if (patch.previewMode === true && !currentConfig.app.global.previewMode) {
      await flushLivePendingBeforePreview(currentConfig, actx.store);
    }

    await writeConfigAndReload(root, next);
    syncAggregateHealth(root.manager.list());
    logInfo("Global settings updated via dashboard", { accountId: actx.accountId });
    return {
      status: 200,
      body: { ok: true, settings: buildSettingsSnapshot(root, actx) },
    };
  } catch (e) {
    return formatSettingsError(e);
  }
}

export async function testProxyConnection(): Promise<{ status: number; body: unknown }> {
  try {
    const { getPublicClient } = await import("../sdk/public-client.js");
    const client = await getPublicClient();
    const paginator = client.listActivity({ user: "0x0000000000000000000000000000000000000001", pageSize: 1 });
    await paginator.firstPage();
    return {
      status: 200,
      body: {
        ok: true,
        message: "连接成功",
        mode: getProxyConfig().mode,
        source: getProxySource(),
        urlMasked: maskProxyUrl(getEffectiveProxyUrl(false) ?? ""),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 502,
      body: {
        ok: false,
        error: msg,
        hint: isProxyConfigured()
          ? "代理连接失败，请检查地址、端口或认证信息"
          : "未配置代理。请在「设置 → 网络」选择固定 IP 或动态 IP 代理",
      },
    };
  }
}

const telegramSettingsSchema = z.object({
  botToken: z.string().trim().optional(),
  chatId: z.string().trim().optional(),
});

/**
 * Persist Telegram credentials to .env. Token is never echoed back.
 * The running TelegramNotifier captures credentials at engine start,
 * so new values apply on the next engine restart.
 */
export async function patchTelegramSettings(
  body: unknown
): Promise<{ status: number; body: unknown }> {
  try {
    const input = telegramSettingsSchema.parse(body);
    const updates: Record<string, string> = {};

    if (input.botToken !== undefined) {
      const token = input.botToken;
      if (token && !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        return {
          status: 400,
          body: { error: "Bot Token 格式不正确（应形如 123456789:AA...）" },
        };
      }
      updates.TELEGRAM_BOT_TOKEN = token;
    }

    if (input.chatId !== undefined) {
      const chatId = input.chatId;
      if (chatId && !/^-?\d+$/.test(chatId)) {
        return {
          status: 400,
          body: { error: "Chat ID 应为数字（群组可为负数）" },
        };
      }
      updates.TELEGRAM_CHAT_ID = chatId;
    }

    if (Object.keys(updates).length === 0) {
      return { status: 400, body: { error: "未提供要更新的字段" } };
    }

    upsertEnvFile(updates);
    applyEnvToProcess(updates);
    logInfo("Telegram settings updated via dashboard", {
      tokenUpdated: updates.TELEGRAM_BOT_TOKEN !== undefined,
      chatUpdated: updates.TELEGRAM_CHAT_ID !== undefined,
    });

    const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const tgChat = process.env.TELEGRAM_CHAT_ID?.trim();
    return {
      status: 200,
      body: {
        ok: true,
        telegramConfigured: Boolean(tgToken && tgChat),
        telegramTokenSet: Boolean(tgToken),
        telegramChatSet: Boolean(tgChat),
        message: "Telegram 凭证已保存到 .env（不会回显）。重启引擎后通知即使用新凭证。",
      },
    };
  } catch (e) {
    return formatSettingsError(e);
  }
}

export async function setPreviewMode(
  root: ApiContext,
  actx: AccountApiContext,
  preview: boolean
): Promise<{ status: number; body: unknown }> {
  try {
    const config = actx.getConfig();
    if (!preview) {
      assertLiveTradingAllowed(false);
    }

    let flush = { resolved: 0, remaining: 0, errors: [] as string[] };
    const normalized = readNormalizedConfigDocument(root.configPath);
    const patch: GlobalSettingsPatch = { previewMode: preview };
    if (!preview) {
      patch.risk = { enableCopyTrading: true };
    }
    const next = applyAccountGlobalSettingsPatch(normalized, actx.accountId, patch);
    validateSettingsCandidate(next, actx);

    if (preview && !config.app.global.previewMode) {
      flush = await flushLivePendingBeforePreview(config, actx.store);
    }

    await writeConfigAndReload(root, next);
    syncAggregateHealth(root.manager.list());
    const rt = root.manager.require(actx.accountId);
    rt.health.previewMode = preview;
    logInfo(`Mode switched via dashboard: account=${actx.accountId} preview=${preview}`, {
      pendingResolved: flush.resolved,
      pendingRemaining: flush.remaining,
    });

    const flushNote = formatPendingFlushNote(flush);
    const message = preview
      ? `已切换 Preview（引擎已热重载 preview.db）。${flushNote}`.trim()
      : "已切换 Live（引擎已热重载 polymirror.db）。请确认钱包 USDC 充足。";

    return {
      status: 200,
      body: {
        ok: true,
        accountId: actx.accountId,
        previewMode: preview,
        message,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 400, body: { error: msg } };
  }
}

export function resetKillSwitch(ctx: LegacyCtx): { status: number; body: unknown } {
  ctx.store.resetKillSwitch();
  logInfo("Kill switch reset via dashboard", { accountId: ctx.accountId });
  return { status: 200, body: { ok: true, risk: buildRiskSnapshot(ctx) } };
}

export async function stopCopyTrading(
  root: ApiContext,
  actx: AccountApiContext
): Promise<{ status: number; body: unknown }> {
  try {
    const config = actx.getConfig();
    const normalized = readNormalizedConfigDocument(root.configPath);
    const patch: GlobalSettingsPatch = {
      previewMode: true,
      risk: { enableCopyTrading: false },
    };
    const destinationMode = StateStore.getCopyPriceModeCompatibilityForPath(
      resolveAccountDbPath(actx.accountId, true),
      config.app.global.copyPriceMode
    );
    if (destinationMode.status !== "unbound") {
      patch.copyPriceMode = destinationMode.mode;
    }
    const next = applyAccountGlobalSettingsPatch(normalized, actx.accountId, patch);
    validateSettingsCandidate(next, actx);

    const flush = await flushLivePendingBeforePreview(config, actx.store);

    await writeConfigAndReload(root, next);
    syncAggregateHealth(root.manager.list());
    const rt = root.manager.require(actx.accountId);
    rt.health.previewMode = true;
    logInfo(`Copy trading stopped via dashboard: account=${actx.accountId}`, {
      pendingResolved: flush.resolved,
      pendingRemaining: flush.remaining,
    });

    const flushNote = formatPendingFlushNote(flush);
    const message =
      `已停止跟单：Preview 模式，跟单开关已关闭。${flushNote}`.trim() ||
      "已停止跟单：Preview 模式，跟单开关已关闭。";

    return {
      status: 200,
      body: {
        ok: true,
        accountId: actx.accountId,
        previewMode: true,
        copyTradingEnabled: false,
        message,
        risk: buildRiskSnapshot(actx),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 400, body: { error: msg } };
  }
}

function formatSettingsError(e: unknown): { status: number; body: unknown } {
  if (e instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        error: "Validation failed",
        details: e.errors.map((x) => ({ path: x.path.join("."), message: x.message })),
      },
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { status: 400, body: { error: msg } };
}
