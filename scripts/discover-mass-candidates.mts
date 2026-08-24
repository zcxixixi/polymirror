import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPublicClient } from "../src/sdk/public-client.js";
import {
  rankMassCandidates,
  type LeaderboardDiscoveryRow,
} from "../src/experiments/mass-candidate-discovery.js";

const CATEGORIES = [
  "OVERALL", "POLITICS", "SPORTS", "CRYPTO", "CULTURE",
  "MENTIONS", "WEATHER", "ECONOMICS", "TECH", "FINANCE",
] as const;
const PERIODS = ["DAY", "WEEK", "MONTH"] as const;

const outputDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: npx tsx scripts/discover-mass-candidates.mts <output-dir> [limit]");
}
const limit = Number(process.argv[3] ?? process.env.MASS_DISCOVERY_LIMIT ?? 500);
const pagesPerSlice = Number(process.env.MASS_DISCOVERY_PAGES ?? 4);
if (!Number.isInteger(pagesPerSlice) || pagesPerSlice < 1 || pagesPerSlice > 20) {
  throw new Error("MASS_DISCOVERY_PAGES must be an integer from 1 to 20");
}
mkdirSync(outputDir, { recursive: false, mode: 0o700 });
const pagesDir = resolve(outputDir, "leaderboards");
mkdirSync(pagesDir, { mode: 0o700 });

const client = await getPublicClient();
const rows: LeaderboardDiscoveryRow[] = [];
const artifacts: Array<{
  category: string;
  timePeriod: string;
  page: number;
  fileName: string;
  rowCount: number;
  sha256: string;
}> = [];

for (const category of CATEGORIES) {
  for (const timePeriod of PERIODS) {
    const paginator = client.listTraderLeaderboard({
      category,
      timePeriod,
      orderBy: "PNL",
      pageSize: 50,
    });
    let pageNumber = 0;
    for await (const page of paginator) {
      pageNumber += 1;
      const payload = `${JSON.stringify({
        source: "@polymarket/client:listTraderLeaderboard",
        request: { category, timePeriod, orderBy: "PNL", pageSize: 50 },
        pageNumber,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
        totalCount: page.totalCount ?? null,
        items: page.items,
      }, null, 2)}\n`;
      const fileName = `${category.toLowerCase()}-${timePeriod.toLowerCase()}-${String(pageNumber).padStart(2, "0")}.json`;
      writeFileSync(resolve(pagesDir, fileName), payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      artifacts.push({
        category,
        timePeriod,
        page: pageNumber,
        fileName: `leaderboards/${fileName}`,
        rowCount: page.items.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
      });
      for (const item of page.items) {
        rows.push({
          category,
          timePeriod,
          rank: Number(item.rank ?? 0),
          address: String(item.wallet ?? ""),
          ...(item.userName ? { username: String(item.userName) } : {}),
          pnlUsd: Number(item.pnl ?? 0),
          volumeUsd: Number(item.vol ?? 0),
        });
      }
      if (!page.hasMore || pageNumber >= pagesPerSlice) break;
    }
  }
}

const excludePath = process.env.MASS_DISCOVERY_EXCLUDE_FILE?.trim();
const excludeAddresses = excludePath
  ? (JSON.parse(readFileSync(resolve(excludePath), "utf8")) as string[])
  : [];
const candidates = rankMassCandidates(rows, { limit, excludeAddresses });
const cohortId = `mass${new Date().toISOString().slice(2, 10).replace(/-/g, "")}`;
const massCohort = {
  cohortId,
  experimentFactor: "fixedUsd" as const,
  candidates: candidates.map((candidate) => ({
    id: candidate.id,
    address: candidate.address,
    ...(candidate.username ? { username: candidate.username } : {}),
    freshIntakePassed: false,
    simulationOnlyEnabled: true,
  })),
  arms: {
    conservative: { fixedUsd: 1, maxPositionUsd: 30, maxDailyVolumeUsd: 100, maxOpenMarkets: 20, dailyLossCapPct: 10, slippageTolerance: 0.025, minPrice: 0.05, maxPrice: 0.95 },
    standard: { fixedUsd: 2, maxPositionUsd: 30, maxDailyVolumeUsd: 100, maxOpenMarkets: 20, dailyLossCapPct: 10, slippageTolerance: 0.025, minPrice: 0.05, maxPrice: 0.95 },
    aggressive: { fixedUsd: 5, maxPositionUsd: 30, maxDailyVolumeUsd: 100, maxOpenMarkets: 20, dailyLossCapPct: 10, slippageTolerance: 0.025, minPrice: 0.05, maxPrice: 0.95 },
  },
};

function atomicJson(path: string, value: unknown): string {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temp, path);
  return createHash("sha256").update(payload).digest("hex");
}
const rankedSha256 = atomicJson(resolve(outputDir, "ranked-candidates.json"), candidates);
const cohortSha256 = atomicJson(resolve(outputDir, "mass-cohort.json"), massCohort);
const manifest = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  source: "official-polymarket-trader-leaderboards",
  parameters: { categories: CATEGORIES, timePeriods: PERIODS, pagesPerSlice, limit },
  rawRowCount: rows.length,
  uniqueCandidateCount: candidates.length,
  artifacts,
  rankedSha256,
  cohortSha256,
};
atomicJson(resolve(outputDir, "manifest.json"), manifest);
process.stdout.write(`${JSON.stringify({ outputDir, ...manifest })}\n`);
