import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  persistCandidateIntakeRefresh,
  refreshCandidateIntake,
  type CandidateIntakeFetcher,
  type CandidateIntakeWindow,
} from "../src/experiments/candidate-intake.js";
import { getPublicClient } from "../src/sdk/public-client.js";

function usage(): never {
  throw new Error(
    "usage: npx tsx scripts/refresh-candidate-intake.mts "
    + "<watchlist-seed.json> <evidence-dir> <approved-cohort.json>"
  );
}

const [, , seedArg, evidenceArg, approvedArg] = process.argv;
if (!seedArg || !evidenceArg || !approvedArg) usage();

const seedPath = resolve(seedArg);
const archiveDir = resolve(evidenceArg);
const outputPath = resolve(approvedArg);
const seed: unknown = JSON.parse(readFileSync(seedPath, "utf8"));
const capturedAt = new Date().toISOString();
const client = await getPublicClient();

function sdkWindow(window: CandidateIntakeWindow): { start: number; end: number } {
  return {
    start: Math.floor(window.sinceMs / 1000),
    end: Math.ceil(window.untilMs / 1000),
  };
}

const fetcher: CandidateIntakeFetcher = {
  async fetchActivity(address, window) {
    const request = {
      user: address,
      pageSize: 500,
      ...sdkWindow(window),
      sortBy: "TIMESTAMP" as const,
      sortDirection: "DESC" as const,
    };
    const pages = [];
    for await (const page of client.listActivity(request)) {
      pages.push({
        items: page.items,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
        totalCount: page.totalCount ?? null,
      });
    }
    return { source: "@polymarket/client:listActivity", request, pages };
  },

  async fetchLeaderboard(address) {
    const request = {
      user: address,
      category: "OVERALL" as const,
      timePeriod: "MONTH" as const,
      orderBy: "PNL" as const,
      pageSize: 1,
    };
    const page = await client.listTraderLeaderboard(request).firstPage();
    return {
      source: "@polymarket/client:listTraderLeaderboard",
      request,
      page: {
        items: page.items,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
        totalCount: page.totalCount ?? null,
      },
      items: page.items,
    };
  },
};

const result = await refreshCandidateIntake(seed, fetcher, { capturedAt });
persistCandidateIntakeRefresh(result, { seedPath, archiveDir, outputPath });

const approved = result.artifacts.filter((artifact) => artifact.evidence.approved).length;
process.stdout.write(`${JSON.stringify({
  capturedAt: result.manifest.capturedAt,
  candidates: result.artifacts.length,
  approved,
  watchlistOnly: result.artifacts.length - approved,
  evidenceDir: archiveDir,
  approvedCohort: outputPath,
})}\n`);
