function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function calculateCopySlippageLossPct(
  side: "BUY" | "SELL",
  leaderPrice: number,
  executablePrice: number | null
): number | null {
  if (
    executablePrice === null ||
    !Number.isFinite(leaderPrice) ||
    !Number.isFinite(executablePrice) ||
    leaderPrice <= 0 ||
    executablePrice <= 0
  ) {
    return null;
  }

  const adverseMove =
    side === "BUY"
      ? executablePrice - leaderPrice
      : leaderPrice - executablePrice;
  return round4(Math.max(0, (adverseMove / leaderPrice) * 100));
}
