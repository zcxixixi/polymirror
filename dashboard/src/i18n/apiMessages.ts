type TFn = (key: string, vars?: Record<string, string | number>) => string;

const EXACT: Record<string, string> = {
  "连接成功": "apiMsg.proxyOk",
  "账户信息已更新。": "apiMsg.accountUpdated",
  "账户已创建。私钥已写入 .env，不会在此显示。切换账户后即可配置 Leader。": "apiMsg.accountCreated",
  "账户已更新，私钥已写入 .env（不会在此显示）。": "apiMsg.accountUpdatedWithKey",
  "Telegram 凭证已保存到 .env（不会回显）。重启引擎后通知即使用新凭证。": "apiMsg.telegramSaved",
  "订单已从 CLOB 撤销并移出 pending 列表": "apiMsg.orderCancelled",
  "订单已从 CLOB 撤销并移出 pending 列表（已对账部分成交）": "apiMsg.orderCancelled",
  "已停止跟单：Preview 模式，跟单开关已关闭。": "apiMsg.stopCopy",
  "无法拉取 Trader 详情，请检查网络或 HTTPS_PROXY": "apiMsg.traderFetchFailed",
  "无法连接 Polymarket Data API。请在「设置 → 网络」配置代理，或在 .env 设置 HTTPS_PROXY。":
    "apiMsg.dataApiFailed",
  "无法拉取 Polymarket 盈亏曲线。请在「设置 → 网络」配置代理。": "apiMsg.pnlFetchFailed",
  "代理连接失败，请检查地址、端口或认证信息": "apiMsg.proxyConnectFailed",
  "未配置代理。请在「设置 → 网络」选择固定 IP 或动态 IP 代理": "apiMsg.proxyNotConfigured",
  "未提供要更新的字段": "apiMsg.noFieldsToUpdate",
  "Bot Token 格式不正确（应形如 123456789:AA...）": "apiMsg.invalidBotToken",
  "Chat ID 应为数字（群组可为负数）": "apiMsg.invalidChatId",
  "固定 IP 模式需要填写代理地址": "apiMsg.staticProxyRequired",
  "动态 IP 模式需要填写代理地址": "apiMsg.dynamicProxyRequired",
  "无效的固定代理 URL（需 http:// 或 https:// 开头）": "apiMsg.invalidStaticProxyUrl",
  "无效的动态代理 URL（需 http:// 或 https:// 开头）": "apiMsg.invalidDynamicProxyUrl",
  "无效的固定代理 URL": "apiMsg.invalidStaticProxyUrlShort",
  "无效的动态代理 URL": "apiMsg.invalidDynamicProxyUrlShort",
  "当前代理出口仍被 Polymarket 判定为受限地区，请换美国等允许地区的 residential 代理。":
    "apiMsg.geoblockRestricted",
  "无法连接 Polymarket API。请在「设置 → 网络」配置代理，或在 .env 设置 HTTPS_PROXY。":
    "apiMsg.walletApiFailed",
  "链上 USDC 余额需通过 SecureClient 查询；请确认 .env 私钥与 Proxy 地址正确。":
    "apiMsg.walletSecureClientHint",
  "请稍后重试或在 CLOB 上手动取消。": "apiMsg.retryOrCancelClob",
};

function translateProxyHintSuffix(t: TFn, suffix: string): string {
  if (!suffix) return "";
  if (suffix.includes("中国大陆") || suffix.includes("HTTPS_PROXY")) {
    return t("apiMsg.proxyHintChina");
  }
  return suffix;
}

function translateFlushNote(t: TFn, note: string): string {
  if (!note) return "";
  const trimmed = note.trim();
  const m = trimmed.match(/^已处理 (\d+) 笔 Live 挂单。$/);
  if (m) return t("apiMsg.flushResolved", { resolved: m[1]! });
  const m2 = trimmed.match(
    /^已处理 (\d+) 笔 Live 挂单，仍有 (\d+) 笔未结束（请到 Polymarket 手动检查）。$/
  );
  if (m2) return t("apiMsg.flushPartial", { resolved: m2[1]!, remaining: m2[2]! });
  return note;
}

function translateMigrateNote(t: TFn, note: string): string {
  const m = note.match(/^已合并 Preview：(\d+) 条去重、(\d+) 条引擎持仓（仅跟踪，链上为准）。$/);
  if (m) return t("apiMsg.previewMerged", { seen: m[1]!, positions: m[2]! });
  return note;
}

function translateUnfollowMessage(t: TFn, message: string): string | null {
  const head = message.match(/^已撤销跟单：Leader ([^ ]+) 已从配置移除。/);
  if (!head) return null;

  const id = head[1]!;
  const parts = [t("apiMsg.leaderUnfollowed", { id })];

  const pending = message.match(/已撤销 (\d+) 笔挂单。/);
  if (pending) parts.push(t("apiMsg.leaderUnfollowPending", { count: pending[1]! }));

  const pendingFailed = message.match(/有 (\d+) 笔挂单未能撤销/);
  if (pendingFailed) {
    parts.push(t("apiMsg.leaderUnfollowPendingFailed", { count: pendingFailed[1]! }));
  }

  const positions = message.match(/仍有 (\d+) 条本地跟踪持仓未清空。/);
  if (positions) parts.push(t("apiMsg.leaderUnfollowPositions", { count: positions[1]! }));

  const sold = message.match(/已卖出 (\d+) 条持仓。/);
  if (sold) parts.push(t("apiMsg.leaderUnfollowSold", { count: sold[1]! }));

  const sellPending = message.match(/有 (\d+) 笔卖单挂单中/);
  if (sellPending) parts.push(t("apiMsg.leaderUnfollowSellPending", { count: sellPending[1]! }));

  const sellFailed = message.match(/(\d+) 条持仓未能卖出/);
  if (sellFailed) parts.push(t("apiMsg.leaderUnfollowSellFailed", { count: sellFailed[1]! }));

  const sellSkipped = message.match(/(\d+) 条持仓因金额过小或无余额跳过。/);
  if (sellSkipped) parts.push(t("apiMsg.leaderUnfollowSellSkipped", { count: sellSkipped[1]! }));

  return parts.join(" ");
}

function translateFlushReject(t: TFn, message: string): string | null {
  const preview = message.match(/^仍有 (\d+) 笔 Live 挂单未能取消，已拒绝切换 Preview。/);
  if (preview) {
    const rest = message.slice(preview[0].length).trim();
    const base = t("apiMsg.flushRejectPreview", { remaining: preview[1]! });
    return rest.includes("CLOB") ? `${base} ${t("apiMsg.retryOrCancelClob")}` : base;
  }
  const stop = message.match(/^仍有 (\d+) 笔 Live 挂单未能取消，已拒绝停止跟单。/);
  if (stop) {
    const rest = message.slice(stop[0].length).trim();
    const base = t("apiMsg.flushRejectStop", { remaining: stop[1]! });
    return rest.includes("CLOB") ? `${base} ${t("apiMsg.retryOrCancelClob")}` : base;
  }
  return null;
}

/** Translate backend Chinese toast/error/hint strings for the active UI locale. */
export function translateApiMessage(t: TFn, message: string): string {
  if (!message) return message;

  // Compound "error — hint" from Settings proxy test, etc.
  if (message.includes(" — ")) {
    return message
      .split(" — ")
      .map((part) => translateApiMessage(t, part))
      .join(" — ");
  }

  const exactKey = EXACT[message];
  if (exactKey) return t(exactKey);

  if (message.startsWith("订单已从 CLOB 撤销并移出 pending 列表")) {
    return t("apiMsg.orderCancelled");
  }

  const unfollow = translateUnfollowMessage(t, message);
  if (unfollow) return unfollow;

  const flushReject = translateFlushReject(t, message);
  if (flushReject) return flushReject;

  const preview = message.match(/^已切换 Preview（引擎已热重载 preview\.db）。(.*)$/);
  if (preview) {
    const note = translateFlushNote(t, preview[1] ?? "");
    return note ? `${t("apiMsg.switchedPreview")} ${note}` : t("apiMsg.switchedPreview");
  }

  const live = message.match(/^已切换 Live（引擎已热重载 polymirror\.db）。(.*)请确认钱包 USDC 充足。$/);
  if (live) {
    const middle = live[1] ?? "";
    const migrate = translateMigrateNote(t, middle);
    const base = migrate ? `${t("apiMsg.switchedLive")} ${migrate}` : t("apiMsg.switchedLive");
    return `${base} ${t("apiMsg.confirmUsdc")}`;
  }

  const stop = message.match(/^已停止跟单：Preview 模式，跟单开关已关闭。(.*)$/);
  if (stop) {
    const note = translateFlushNote(t, stop[1] ?? "");
    return note ? `${t("apiMsg.stopCopy")} ${note}` : t("apiMsg.stopCopy");
  }

  if (message.includes("config.yaml 已迁移为多账户格式")) {
    return message.replace("config.yaml 已迁移为多账户格式。", t("apiMsg.configMigrated"));
  }

  const connect = message.match(/^无法连接 ([^\s(]+)(.*)$/);
  if (connect) {
    return t("apiMsg.cannotConnectHost", {
      host: connect[1]!,
      hint: translateProxyHintSuffix(t, connect[2] ?? ""),
    });
  }

  if (message.startsWith("未配置代理")) {
    return t("apiMsg.proxyNotConfiguredGeoblock", {
      hint: translateProxyHintSuffix(t, message.slice("未配置代理".length).replace(/。$/, "")),
    });
  }

  const geoblockDetail = message.match(
    /^CLOB 地区限制：IP ([^\s]+) \(([^/]+)\/([^)]+)\) 被 geoblock。/
  );
  if (geoblockDetail) {
    return t("apiMsg.geoblockDetail", {
      ip: geoblockDetail[1]!,
      country: geoblockDetail[2]!,
      region: geoblockDetail[3]!,
    });
  }

  return message;
}
