import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  candidateCohortSchema,
  type CandidateCohortInput,
} from "./candidate-cohort.js";
import { normalizedPayloadJson, payloadSha256 } from "./provenance.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const candidateIntakeThresholds = Object.freeze({
  minTrades24h: 20,
  minSellOrRedeem24h: 3,
  minDistinctConditions24h: 5,
  maxMedianTicketUsd: 50,
  maxP90TicketUsd: 500,
});

export interface CandidateIntakeWindow {
  capturedAt: string;
  sinceMs: number;
  untilMs: number;
}

export interface CandidateIntakeFetcher {
  fetchActivity(address: string, window: CandidateIntakeWindow): Promise<unknown>;
  fetchLeaderboard(address: string, window: CandidateIntakeWindow): Promise<unknown>;
}

export interface CandidateIntakeMetrics {
  trades24h: number;
  sellOrRedeem24h: number;
  distinctConditions24h: number;
  medianTicketUsd: number | null;
  p90TicketUsd: number | null;
}

export interface CandidateIntakeGates {
  apiNoErrors: boolean;
  trades24h: boolean;
  sellOrRedeem24h: boolean;
  distinctConditions24h: boolean;
  medianTicketUsd: boolean;
  p90TicketUsd: boolean;
}

export interface CandidateIntakeEvidence {
  schemaVersion: 1;
  capturedAt: string;
  window: { since: string; until: string };
  candidate: { id: string; address: string; username?: string };
  thresholds: typeof candidateIntakeThresholds;
  rawResponses: { activity: unknown | null; leaderboard: unknown | null };
  apiErrors: string[];
  metrics: CandidateIntakeMetrics;
  gates: CandidateIntakeGates;
  failedGates: Array<keyof CandidateIntakeGates>;
  approved: boolean;
}

export interface CandidateIntakeArtifact {
  candidateId: string;
  address: string;
  fileName: string;
  evidence: CandidateIntakeEvidence;
  canonicalJson: string;
  sha256: string;
}

export interface CandidateIntakeManifest {
  schemaVersion: 1;
  capturedAt: string;
  seedCohortId: string;
  seedCanonicalSha256: string;
  approvedCohortCanonicalSha256: string;
  artifacts: Array<{
    candidateId: string;
    address: string;
    fileName: string;
    sha256: string;
    approved: boolean;
  }>;
}

export interface CandidateIntakeRefreshResult {
  approvedCohort: CandidateCohortInput;
  artifacts: CandidateIntakeArtifact[];
  manifest: CandidateIntakeManifest;
}

interface NormalizedActivity {
  type: string;
  side?: "BUY" | "SELL";
  timestampMs: number;
  conditionId?: string;
  ticketUsd?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function extractItems(response: unknown, label: string): unknown[] {
  if (Array.isArray(response)) {
    const looksLikePages = response.length > 0
      && response.every((page) => Array.isArray(object(page)?.items));
    if (looksLikePages) {
      return response.flatMap((page) => object(page)!.items as unknown[]);
    }
    return response;
  }
  const record = object(response);
  if (!record) throw new Error(`${label} response was not an object or array`);
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.pages)) {
    return record.pages.flatMap((page, index) => {
      const items = object(page)?.items;
      if (!Array.isArray(items)) {
        throw new Error(`${label} response page ${index} did not contain items`);
      }
      return items;
    });
  }
  throw new Error(`${label} response did not contain items`);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function nonemptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  const timestamp = finiteNumber(value);
  if (timestamp === undefined || timestamp <= 0) return undefined;
  return timestamp > 1e12 ? timestamp : timestamp * 1000;
}

function normalizeActivityRow(value: unknown, index: number): NormalizedActivity {
  const row = object(value);
  if (!row) throw new Error(`activity row ${index} was not an object`);
  const type = nonemptyText(row.type)?.toUpperCase();
  const timestampMs = normalizeTimestamp(row.timestamp);
  if (!type) throw new Error(`activity row ${index} had no type`);
  if (timestampMs === undefined) throw new Error(`activity row ${index} had no timestamp`);

  const normalized: NormalizedActivity = {
    type,
    timestampMs,
    conditionId: nonemptyText(row.conditionId ?? row.condition_id),
  };
  if (type !== "TRADE") return normalized;

  const side = nonemptyText(row.side)?.toUpperCase();
  if (side !== "BUY" && side !== "SELL") {
    throw new Error(`activity TRADE row ${index} had no valid side`);
  }
  normalized.side = side;
  const explicitTicket = finiteNumber(row.usdcSize ?? row.usdc_size ?? row.amount ?? row.cash);
  const size = finiteNumber(row.size ?? row.shares);
  const price = finiteNumber(row.price);
  const ticketUsd = explicitTicket ?? (
    size !== undefined && price !== undefined ? size * price : undefined
  );
  if (ticketUsd === undefined || ticketUsd <= 0) {
    throw new Error(`activity TRADE row ${index} had no positive ticket notional`);
  }
  normalized.ticketUsd = ticketUsd;
  return normalized;
}

function assertResponseAddresses(
  items: readonly unknown[],
  expectedAddress: string,
  label: string
): void {
  for (const [index, item] of items.entries()) {
    const row = object(item);
    if (!row) continue;
    const responseAddress = nonemptyText(
      row.wallet ?? row.proxyWallet ?? row.proxy_wallet
    );
    if (responseAddress && responseAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(`${label} response address mismatch at row ${index}`);
    }
  }
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index]!;
}

function calculateMetrics(
  rows: readonly NormalizedActivity[],
  window: CandidateIntakeWindow
): CandidateIntakeMetrics {
  const recent = rows.filter(
    (row) => row.timestampMs >= window.sinceMs && row.timestampMs <= window.untilMs
  );
  const trades = recent.filter((row) => row.type === "TRADE");
  const tickets = trades.map((row) => row.ticketUsd!).sort((a, b) => a - b);
  return {
    trades24h: trades.length,
    sellOrRedeem24h: recent.filter(
      (row) => row.type === "REDEEM" || (row.type === "TRADE" && row.side === "SELL")
    ).length,
    distinctConditions24h: new Set(
      recent
        .filter((row) => row.type === "TRADE" || row.type === "REDEEM")
        .map((row) => row.conditionId)
        .filter((value): value is string => Boolean(value))
    ).size,
    medianTicketUsd: median(tickets),
    p90TicketUsd: nearestRank(tickets, 0.9),
  };
}

function evaluateGates(
  metrics: CandidateIntakeMetrics,
  apiErrors: readonly string[]
): CandidateIntakeGates {
  return {
    apiNoErrors: apiErrors.length === 0,
    trades24h: metrics.trades24h >= candidateIntakeThresholds.minTrades24h,
    sellOrRedeem24h:
      metrics.sellOrRedeem24h >= candidateIntakeThresholds.minSellOrRedeem24h,
    distinctConditions24h:
      metrics.distinctConditions24h >= candidateIntakeThresholds.minDistinctConditions24h,
    medianTicketUsd: metrics.medianTicketUsd !== null
      && metrics.medianTicketUsd <= candidateIntakeThresholds.maxMedianTicketUsd,
    p90TicketUsd: metrics.p90TicketUsd !== null
      && metrics.p90TicketUsd <= candidateIntakeThresholds.maxP90TicketUsd,
  };
}

async function evaluateCandidate(
  candidate: CandidateCohortInput["candidates"][number],
  fetcher: CandidateIntakeFetcher,
  window: CandidateIntakeWindow
): Promise<CandidateIntakeArtifact> {
  if (!candidate.address) {
    throw new Error(`Candidate ${candidate.id} requires an exact address for fresh intake`);
  }
  const [activityResult, leaderboardResult] = await Promise.allSettled([
    fetcher.fetchActivity(candidate.address, window),
    fetcher.fetchLeaderboard(candidate.address, window),
  ]);
  const rawActivity = activityResult.status === "fulfilled" ? activityResult.value : null;
  const rawLeaderboard = leaderboardResult.status === "fulfilled" ? leaderboardResult.value : null;
  const apiErrors: string[] = [];
  let normalizedRows: NormalizedActivity[] = [];

  if (activityResult.status === "rejected") {
    apiErrors.push(`activity: ${errorMessage(activityResult.reason)}`);
  } else {
    try {
      const items = extractItems(activityResult.value, "activity");
      assertResponseAddresses(items, candidate.address, "activity");
      normalizedRows = items.map(normalizeActivityRow);
    } catch (error) {
      apiErrors.push(`activity: ${errorMessage(error)}`);
    }
  }
  if (leaderboardResult.status === "rejected") {
    apiErrors.push(`leaderboard: ${errorMessage(leaderboardResult.reason)}`);
  } else {
    try {
      const items = extractItems(leaderboardResult.value, "leaderboard");
      assertResponseAddresses(items, candidate.address, "leaderboard");
    } catch (error) {
      apiErrors.push(`leaderboard: ${errorMessage(error)}`);
    }
  }

  const metrics = calculateMetrics(normalizedRows, window);
  const gates = evaluateGates(metrics, apiErrors);
  const failedGates = (Object.entries(gates) as Array<[keyof CandidateIntakeGates, boolean]>)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const evidence: CandidateIntakeEvidence = {
    schemaVersion: 1,
    capturedAt: window.capturedAt,
    window: {
      since: new Date(window.sinceMs).toISOString(),
      until: new Date(window.untilMs).toISOString(),
    },
    candidate: {
      id: candidate.id,
      address: candidate.address,
      ...(candidate.username ? { username: candidate.username } : {}),
    },
    thresholds: candidateIntakeThresholds,
    rawResponses: { activity: rawActivity, leaderboard: rawLeaderboard },
    apiErrors,
    metrics,
    gates,
    failedGates,
    approved: failedGates.length === 0,
  };
  const canonicalJson = normalizedPayloadJson(evidence);
  return {
    candidateId: candidate.id,
    address: candidate.address,
    fileName: `${candidate.id}-${candidate.address.toLowerCase()}.json`,
    evidence,
    canonicalJson,
    sha256: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}

export async function refreshCandidateIntake(
  seedInput: unknown,
  fetcher: CandidateIntakeFetcher,
  options: { capturedAt?: string } = {}
): Promise<CandidateIntakeRefreshResult> {
  const seed = candidateCohortSchema.parse(seedInput);
  if (seed.candidates.some(
    (candidate) => candidate.freshIntakePassed || candidate.freshIntakeEvidenceSha256
  )) {
    throw new Error("Fresh Candidate intake requires a watchlist-only seed");
  }
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const untilMs = Date.parse(capturedAt);
  if (!Number.isFinite(untilMs)) throw new Error("capturedAt must be a valid ISO timestamp");
  const window: CandidateIntakeWindow = {
    capturedAt: new Date(untilMs).toISOString(),
    sinceMs: untilMs - DAY_MS,
    untilMs,
  };

  const artifacts: CandidateIntakeArtifact[] = [];
  for (const candidate of seed.candidates) {
    artifacts.push(await evaluateCandidate(candidate, fetcher, window));
  }
  const artifactByCandidate = new Map(
    artifacts.map((artifact) => [artifact.candidateId, artifact])
  );
  const approvedCohort = candidateCohortSchema.parse({
    ...seed,
    candidates: seed.candidates.map((candidate) => {
      const artifact = artifactByCandidate.get(candidate.id)!;
      const { freshIntakeEvidenceSha256: _oldEvidence, ...base } = candidate;
      return artifact.evidence.approved
        ? {
            ...base,
            freshIntakePassed: true,
            freshIntakeEvidenceSha256: artifact.sha256,
          }
        : { ...base, freshIntakePassed: false };
    }),
  });
  const manifest: CandidateIntakeManifest = {
    schemaVersion: 1,
    capturedAt: window.capturedAt,
    seedCohortId: seed.cohortId,
    seedCanonicalSha256: payloadSha256(seed),
    approvedCohortCanonicalSha256: payloadSha256(approvedCohort),
    artifacts: artifacts.map((artifact) => ({
      candidateId: artifact.candidateId,
      address: artifact.address,
      fileName: artifact.fileName,
      sha256: artifact.sha256,
      approved: artifact.evidence.approved,
    })),
  };
  return { approvedCohort, artifacts, manifest };
}

export interface PersistCandidateIntakeOptions {
  seedPath: string;
  outputPath: string;
  archiveDir: string;
}

export function persistCandidateIntakeRefresh(
  result: CandidateIntakeRefreshResult,
  options: PersistCandidateIntakeOptions
): void {
  const seedPath = resolve(options.seedPath);
  const outputPath = resolve(options.outputPath);
  const archiveDir = resolve(options.archiveDir);
  if (seedPath === outputPath) throw new Error("Approved cohort must not overwrite the seed");
  if (outputPath.startsWith(`${archiveDir}${sep}`)) {
    throw new Error("Approved cohort output must be outside the evidence directory");
  }
  if (existsSync(outputPath)) throw new Error(`Approved cohort already exists: ${outputPath}`);
  if (existsSync(archiveDir)) throw new Error(`Evidence path already exists: ${archiveDir}`);

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(archiveDir), { recursive: true });
  const nonce = `${process.pid}-${randomUUID()}`;
  const stagingDir = `${archiveDir}.tmp-${nonce}`;
  const stagingOutput = `${outputPath}.tmp-${nonce}`;
  let archivePublished = false;
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
    for (const artifact of result.artifacts) {
      writeFileSync(resolve(stagingDir, artifact.fileName), artifact.canonicalJson, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    writeFileSync(
      resolve(stagingDir, "manifest.json"),
      normalizedPayloadJson(result.manifest),
      { encoding: "utf8", mode: 0o600 }
    );
    writeFileSync(stagingOutput, `${JSON.stringify(result.approvedCohort, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(stagingDir, archiveDir);
    archivePublished = true;
    linkSync(stagingOutput, outputPath);
    unlinkSync(stagingOutput);
  } catch (error) {
    if (!archivePublished && existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    if (existsSync(stagingOutput)) rmSync(stagingOutput, { force: true });
    throw error;
  }
}
