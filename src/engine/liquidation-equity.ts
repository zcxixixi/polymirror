import type { RuntimeConfig } from "../config/types.js";
import { calculatePlatformFeeUsd } from "../executor/fees.js";
import {
  fetchExecutableOrderBookSnapshot,
  type ExecutableOrderBookSnapshot,
} from "../executor/orderbook.js";
import type { StateStore } from "../state/store.js";

export type LiquidationEquityStore = Pick<
  StateStore,
  "listPositions" | "readCashBalance"
>;

export interface LiquidationEquityAssessment {
  cashUsd: number;
  liquidationValueUsd: number;
  equityUsd: number;
  openCostUsd: number;
  /** Share-weighted fraction of positive holdings covered by executable SELL depth. */
  quoteCoverage: number;
  /** Tokens with no quote or insufficient depth for all held shares. */
  missingTokenIds: string[];
  drawdownPct: number;
  peakEquityUsd: number;
}

interface AggregatedPosition {
  tokenId: string;
  shares: number;
  openCostUsd: number;
}

interface TokenLiquidationValue {
  filledShares: number;
  netValueUsd: number;
}

function round(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function aggregatePositivePositions(store: LiquidationEquityStore): AggregatedPosition[] {
  const byToken = new Map<string, AggregatedPosition>();
  for (const position of store.listPositions()) {
    const tokenId = String(position.tokenId ?? "").trim();
    const shares = Number(position.shares);
    if (!tokenId || !Number.isFinite(shares) || shares <= 0) continue;

    const avgEntryPrice = Number(position.avgEntryPrice);
    const cost = Number.isFinite(avgEntryPrice) && avgEntryPrice > 0
      ? shares * avgEntryPrice
      : 0;
    const current = byToken.get(tokenId);
    if (current) {
      current.shares += shares;
      current.openCostUsd += cost;
    } else {
      byToken.set(tokenId, { tokenId, shares, openCostUsd: cost });
    }
  }
  return [...byToken.values()].sort((a, b) => a.tokenId.localeCompare(b.tokenId));
}

function valueExecutableSellDepth(
  heldShares: number,
  snapshot: ExecutableOrderBookSnapshot | null
): TokenLiquidationValue {
  if (!snapshot || heldShares <= 0) return { filledShares: 0, netValueUsd: 0 };
  if (
    Number.isFinite(snapshot.minOrderShares) &&
    snapshot.minOrderShares > 0 &&
    heldShares + 1e-9 < snapshot.minOrderShares
  ) {
    return { filledShares: 0, netValueUsd: 0 };
  }

  const bids = snapshot.levels
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        level.price > 0 &&
        level.price < 1 &&
        Number.isFinite(level.size) &&
        level.size > 0
    )
    .sort((a, b) => b.price - a.price);

  let remainingShares = heldShares;
  let filledShares = 0;
  let grossValueUsd = 0;
  for (const bid of bids) {
    const filled = Math.min(remainingShares, bid.size);
    filledShares += filled;
    grossValueUsd += filled * bid.price;
    remainingShares -= filled;
    if (remainingShares <= 1e-9) break;
  }

  if (filledShares <= 0 || grossValueUsd <= 0) {
    return { filledShares: 0, netValueUsd: 0 };
  }
  const weightedPrice = grossValueUsd / filledShares;
  const feeUsd = calculatePlatformFeeUsd(
    filledShares,
    weightedPrice,
    snapshot.feeRate,
    snapshot.feeExponent
  );
  return {
    filledShares: round(filledShares),
    netValueUsd: round(Math.max(0, grossValueUsd - feeUsd)),
  };
}

export async function assessLiquidationEquity(
  config: RuntimeConfig,
  store: LiquidationEquityStore,
  peakEquityUsd?: number
): Promise<LiquidationEquityAssessment> {
  const startingCapitalUsd = config.app.global.risk.startingCapitalUsd;
  const rawCash = store.readCashBalance(startingCapitalUsd);
  const cashUsd = round(Number.isFinite(rawCash) ? rawCash : 0);
  const positions = aggregatePositivePositions(store);

  const valued = await Promise.all(
    positions.map(async (position) => {
      const snapshot = await fetchExecutableOrderBookSnapshot(
        config.wallet.clobUrl,
        config.wallet.chainId,
        position.tokenId,
        "SELL"
      ).catch(() => null);
      return {
        position,
        value: valueExecutableSellDepth(position.shares, snapshot),
      };
    })
  );

  const totalShares = positions.reduce((sum, position) => sum + position.shares, 0);
  const quotedShares = valued.reduce((sum, row) => sum + row.value.filledShares, 0);
  const liquidationValueUsd = round(
    valued.reduce((sum, row) => sum + row.value.netValueUsd, 0)
  );
  const openCostUsd = round(
    positions.reduce((sum, position) => sum + position.openCostUsd, 0)
  );
  const equityUsd = round(cashUsd + liquidationValueUsd);
  const quoteCoverage = totalShares > 0
    ? round(Math.min(1, Math.max(0, quotedShares / totalShares)))
    : 1;
  const missingTokenIds = valued
    .filter((row) => row.value.filledShares + 1e-9 < row.position.shares)
    .map((row) => row.position.tokenId);

  const suppliedPeak = Number.isFinite(peakEquityUsd) && (peakEquityUsd ?? 0) >= 0
    ? peakEquityUsd!
    : startingCapitalUsd;
  const peakEquity = round(Math.max(0, suppliedPeak, equityUsd));
  const drawdownPct = peakEquity > 0
    ? round(Math.max(0, ((peakEquity - equityUsd) / peakEquity) * 100))
    : 0;

  return {
    cashUsd,
    liquidationValueUsd,
    equityUsd,
    openCostUsd,
    quoteCoverage,
    missingTokenIds,
    drawdownPct,
    peakEquityUsd: peakEquity,
  };
}
