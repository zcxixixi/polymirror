import type { GlobalConfig, LeaderConfig, LeaderRateLimit } from "../config/types.js";
import type { StateStore } from "../state/store.js";
import { logError } from "../notify/logger.js";

export interface RiskCheckResult {
  allow: boolean;
  reason?: string;
}

export class RiskGate {
  constructor(
    private readonly global: GlobalConfig,
    private readonly store: StateStore
  ) {}

  canTrade(): RiskCheckResult {
    if (!this.global.risk.enableCopyTrading) {
      return { allow: false, reason: "copy trading disabled" };
    }
    if (this.store.isKillSwitchActive()) {
      return { allow: false, reason: "kill switch active" };
    }
    const lossCheck = this.checkDailyLossCap();
    if (!lossCheck.allow) return lossCheck;
    return { allow: true };
  }

  checkDailyLossCap(): RiskCheckResult {
    const pnl = this.store.getDailyRealizedPnl();
    if (pnl >= 0) return { allow: true };

    const capital = this.global.risk.startingCapitalUsd;
    if (capital <= 0) return { allow: true };

    const lossPct = (Math.abs(pnl) / capital) * 100;
    if (lossPct >= this.global.risk.dailyLossCapPct) {
      this.store.triggerKillSwitch();
      return {
        allow: false,
        reason: `daily loss cap ${lossPct.toFixed(1)}% >= ${this.global.risk.dailyLossCapPct}%`,
      };
    }
    return { allow: true };
  }

  canOpenNewMarket(tokenId: string, side: "BUY" | "SELL"): RiskCheckResult {
    if (side !== "BUY") return { allow: true };

    const open = this.store.countOpenMarkets();
    if (open >= this.global.risk.maxOpenMarkets && !this.store.hasOpenPosition(tokenId)) {
      return {
        allow: false,
        reason: `max open markets ${this.global.risk.maxOpenMarkets}`,
      };
    }
    return { allow: true };
  }

  /** Daily volume caps apply to BUY spend only — SELL exits must not be blocked. */
  canSpendUsd(
    leaderId: string,
    usd: number,
    side: "BUY" | "SELL",
    leaderMaxDaily?: number
  ): RiskCheckResult {
    if (side !== "BUY") return { allow: true };

    const today = this.store.getDailyVolumeUsd();
    if (today + usd > this.global.risk.maxDailyVolumeUsd) {
      return { allow: false, reason: "global max daily volume" };
    }
    if (leaderMaxDaily !== undefined) {
      const leaderToday = this.store.getLeaderDailyVolumeUsd(leaderId);
      if (leaderToday + usd > leaderMaxDaily) {
        return { allow: false, reason: `leader ${leaderId} max daily volume` };
      }
    }
    return { allow: true };
  }

  canAffordPreviewBuy(usd: number, startingCapitalUsd: number): RiskCheckResult {
    this.store.ensurePreviewCash(startingCapitalUsd);
    const cash = this.store.getPreviewCashUsd();
    if (cash + 0.01 < usd) {
      return {
        allow: false,
        reason: `insufficient preview cash $${cash.toFixed(2)} < need $${usd.toFixed(2)}`,
      };
    }
    return { allow: true };
  }

  canAddTokenExposure(
    tokenId: string,
    additionalUsd: number,
    price: number
  ): RiskCheckResult {
    const cap = this.global.risk.maxPositionPerTokenUsd;
    if (cap <= 0 || price <= 0) return { allow: true };

    const heldShares = this.store.getTotalTokenShares(tokenId);
    const exposureUsd = heldShares * price + additionalUsd;
    if (exposureUsd > cap) {
      return {
        allow: false,
        reason: `token exposure $${exposureUsd.toFixed(2)} > cap $${cap}`,
      };
    }
    return { allow: true };
  }

  checkSlippage(
    leaderPrice: number,
    referencePrice: number,
    tolerance?: number
  ): RiskCheckResult {
    const tol = tolerance ?? this.global.risk.slippageTolerance;
    if (tol <= 0) return { allow: true };
    if (Math.abs(referencePrice - leaderPrice) > tol) {
      return {
        allow: false,
        reason: `slippage ${Math.abs(referencePrice - leaderPrice).toFixed(4)} > ${tol}`,
      };
    }
    return { allow: true };
  }

  /** Throttle burst copies from a single fast leader. SELL exits are never blocked. */
  checkLeaderCopyRate(
    leaderId: string,
    side: "BUY" | "SELL",
    rateLimit?: LeaderRateLimit
  ): RiskCheckResult {
    if (side !== "BUY" || !rateLimit) return { allow: true };

    const minInterval = rateLimit.minCopyIntervalMs ?? 0;
    if (minInterval > 0) {
      const lastCopyTs = this.store.getLastLeaderCopyTs(leaderId);
      if (lastCopyTs !== null) {
        const elapsed = Date.now() - lastCopyTs;
        if (elapsed < minInterval) {
          return {
            allow: false,
            reason: `leader copy cooldown ${Math.ceil((minInterval - elapsed) / 1000)}s remaining`,
          };
        }
      }
    }

    const maxCopies = rateLimit.maxCopiesPerWindow;
    if (maxCopies !== undefined && maxCopies > 0) {
      const windowMs = rateLimit.copyRateWindowMs ?? 60_000;
      const since = Date.now() - windowMs;
      const count = this.store.countLeaderCopiesSince(leaderId, since);
      if (count >= maxCopies) {
        return {
          allow: false,
          reason: `leader copy rate ${count}/${maxCopies} in ${Math.round(windowMs / 1000)}s`,
        };
      }
    }

    return { allow: true };
  }

  recordBuyVolume(leaderId: string, usd: number): void {
    this.store.addDailyVolume(usd);
    this.store.addLeaderDailyVolume(leaderId, usd);
  }
}

export function assertLiveTradingAllowed(previewMode: boolean): void {
  if (previewMode) return;
  const require = (process.env.REQUIRE_LIVE_CONFIRM ?? "true").toLowerCase() !== "false";
  const confirm = (process.env.POLYMIRROR_LIVE_CONFIRM ?? "").trim();
  if (require && confirm !== "I_UNDERSTAND_LIVE_TRADING") {
    throw new Error(
      "Live trading blocked: set POLYMIRROR_LIVE_CONFIRM=I_UNDERSTAND_LIVE_TRADING in .env"
    );
  }
  // Escape hatch is intentional (automation) but must never be silent.
  if (!require && confirm !== "I_UNDERSTAND_LIVE_TRADING") {
    logError(
      "LIVE trading confirmation bypassed via REQUIRE_LIVE_CONFIRM=false — real orders may be placed",
    );
  }
}

export function assertLiveTradingForAccounts(
  accounts: Array<{ config: { app: { global: { previewMode: boolean } } } }>
): void {
  for (const def of accounts) {
    assertLiveTradingAllowed(def.config.app.global.previewMode);
  }
}

export function resolveLeaderAggregationWindow(
  leader: LeaderConfig,
  globalWindowMs: number
): number {
  const override = leader.rateLimit?.tradeAggregationWindowMs;
  return override !== undefined ? override : globalWindowMs;
}

export function resolveLeaderBuyDedupWindow(
  leader: LeaderConfig,
  globalWindowMs: number
): number {
  const override = leader.rateLimit?.buyDedupWindowMs;
  return override !== undefined ? override : globalWindowMs;
}

export function resolveLeaderSlippageTolerance(
  leader: LeaderConfig,
  globalTolerance: number
): number {
  const override = leader.rateLimit?.slippageTolerance;
  return override !== undefined ? override : globalTolerance;
}
