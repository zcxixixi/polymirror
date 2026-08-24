export interface LeaderboardDiscoveryRow {
  category: string;
  timePeriod: string;
  rank: number;
  address: string;
  username?: string;
  pnlUsd: number;
  volumeUsd: number;
}

export interface RankedMassCandidate {
  id: string;
  address: string;
  username?: string;
  score: number;
  appearances: number;
  bestRank: number;
  categories: string[];
  timePeriods: string[];
  pnlObservationsUsd: number[];
  volumeObservationsUsd: number[];
}

interface Accumulator {
  address: string;
  usernames: Map<string, number>;
  slices: Set<string>;
  categories: Set<string>;
  timePeriods: Set<string>;
  bestRank: number;
  rankScore: number;
  pnlObservationsUsd: number[];
  volumeObservationsUsd: number[];
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function candidateId(username: string | undefined, address: string, used: Set<string>): string {
  const base = (username ?? "")
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20) || `w_${address.slice(2, 10)}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    const tail = `_${suffix++}`;
    id = `${base.slice(0, 20 - tail.length)}${tail}`;
  }
  used.add(id);
  return id;
}

export function rankMassCandidates(
  rows: readonly LeaderboardDiscoveryRow[],
  options: { limit?: number; excludeAddresses?: readonly string[] } = {}
): RankedMassCandidate[] {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("mass discovery limit must be an integer from 1 to 5000");
  }
  const excluded = new Set((options.excludeAddresses ?? []).map((value) => value.toLowerCase()));
  const byAddress = new Map<string, Accumulator>();
  for (const row of rows) {
    const address = row.address.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address) || excluded.has(address)) continue;
    const rank = Math.max(1, Math.floor(finite(row.rank)));
    const key = `${row.category.toUpperCase()}:${row.timePeriod.toUpperCase()}`;
    let candidate = byAddress.get(address);
    if (!candidate) {
      candidate = {
        address,
        usernames: new Map(),
        slices: new Set(),
        categories: new Set(),
        timePeriods: new Set(),
        bestRank: rank,
        rankScore: 0,
        pnlObservationsUsd: [],
        volumeObservationsUsd: [],
      };
      byAddress.set(address, candidate);
    }
    candidate.slices.add(key);
    candidate.categories.add(row.category.toUpperCase());
    candidate.timePeriods.add(row.timePeriod.toUpperCase());
    candidate.bestRank = Math.min(candidate.bestRank, rank);
    candidate.rankScore += 1 / Math.sqrt(rank);
    candidate.pnlObservationsUsd.push(finite(row.pnlUsd));
    candidate.volumeObservationsUsd.push(finite(row.volumeUsd));
    const username = row.username?.trim();
    if (username) candidate.usernames.set(username, (candidate.usernames.get(username) ?? 0) + 1);
  }

  const ranked = [...byAddress.values()].map((candidate) => {
    const username = [...candidate.usernames.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
    const positivePnl = candidate.pnlObservationsUsd.reduce(
      (sum, pnl) => sum + Math.max(0, pnl),
      0
    );
    return {
      address: candidate.address,
      ...(username ? { username } : {}),
      score: candidate.slices.size * 1_000_000
        + candidate.rankScore * 10_000
        + Math.log1p(positivePnl),
      appearances: candidate.slices.size,
      bestRank: candidate.bestRank,
      categories: [...candidate.categories].sort(),
      timePeriods: [...candidate.timePeriods].sort(),
      pnlObservationsUsd: candidate.pnlObservationsUsd,
      volumeObservationsUsd: candidate.volumeObservationsUsd,
    };
  }).sort((left, right) =>
    right.score - left.score
    || left.bestRank - right.bestRank
    || left.address.localeCompare(right.address)
  ).slice(0, limit);

  const usedIds = new Set<string>();
  return ranked.map((candidate) => ({
    id: candidateId(candidate.username, candidate.address, usedIds),
    ...candidate,
  }));
}
