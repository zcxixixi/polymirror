import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ReplayCoverage { buyPct: number; sellPct: number; totalPct: number }
export interface ReplayPosition { leaderId: string; tokenId: string; shares: number; avgEntryPrice: number }
export interface ReplayEvidenceSummary {
  decisionDigest: string;
  cashUsd: number;
  positions: ReplayPosition[];
  realizedPnlUsd: number;
  coverage: ReplayCoverage;
}

interface StoredDecision {
  decisionId: string; rawEventId: string; action: string; reasonCode: string;
  exactTermsJson: string; decidedAt: number;
}

function round(value: number): number { return Math.round((value + Number.EPSILON) * 1e8) / 1e8; }
function numberTerm(terms: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) if (typeof terms[key] === "number" && Number.isFinite(terms[key])) return terms[key] as number;
  return 0;
}
function stringTerm(terms: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof terms[key] === "string" ? terms[key] as string : fallback;
}
function pct(copied: number, detected: number): number { return detected === 0 ? 0 : Math.round(copied / detected * 10_000) / 100; }

function loadDecisions(db: Database.Database, experimentId: string): StoredDecision[] {
  const missing = db.prepare(`SELECT COUNT(*) AS count FROM decisions d
    LEFT JOIN raw_events r ON r.raw_event_id=d.raw_event_id AND r.experiment_id=d.experiment_id
    WHERE d.experiment_id=? AND r.raw_event_id IS NULL`).get(experimentId) as { count: number };
  if (missing.count) throw new Error("Replay evidence has decisions without stored raw events");
  const missingObservations = db.prepare(`SELECT COUNT(*) AS count FROM decisions d
    WHERE d.experiment_id=? AND NOT EXISTS (
      SELECT 1 FROM raw_event_observations o WHERE o.raw_event_id=d.raw_event_id
    )`).get(experimentId) as { count: number };
  if (missingObservations.count) throw new Error("Replay evidence has decisions without stored raw observation evidence");
  const payloads = db.prepare(`SELECT r.payload_hash AS payloadHash, r.normalized_payload_json AS payloadJson
    FROM raw_events r WHERE r.experiment_id=? UNION ALL
    SELECT o.payload_hash, o.normalized_payload_json FROM raw_event_observations o
    JOIN raw_events r ON r.raw_event_id=o.raw_event_id WHERE r.experiment_id=?`).all(experimentId, experimentId) as { payloadHash: string; payloadJson: string }[];
  for (const payload of payloads) {
    const actual = createHash("sha256").update(payload.payloadJson).digest("hex");
    if (actual !== payload.payloadHash) throw new Error("Replay raw observation payload checksum mismatch");
  }
  return db.prepare(`SELECT decision_id AS decisionId, raw_event_id AS rawEventId, action,
    reason_code AS reasonCode, exact_terms_json AS exactTermsJson, decided_at AS decidedAt
    FROM decisions WHERE experiment_id=? ORDER BY decided_at, decision_id`).all(experimentId) as StoredDecision[];
}

export function replayEvidence(dbPath: string, experimentId: string): ReplayEvidenceSummary {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const experiment = db.prepare(`SELECT canonical_config_json AS configJson, sealed_at AS sealedAt
      FROM experiments WHERE experiment_id=?`).get(experimentId) as { configJson: string; sealedAt: number | null } | undefined;
    if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
    if (experiment.sealedAt === null) throw new Error("Deterministic replay requires sealed experiment evidence");
    const config = JSON.parse(experiment.configJson) as { app?: { global?: { risk?: { startingCapitalUsd?: number } } } };
    let cash = config.app?.global?.risk?.startingCapitalUsd ?? 0;
    let realized = 0;
    const positions = new Map<string, ReplayPosition>();
    let detectedBuy = 0, detectedSell = 0, copiedBuy = 0, copiedSell = 0;
    const decisions = loadDecisions(db, experimentId);
    const tokenConditions = new Map(
      (db.prepare("SELECT token_id AS tokenId, condition_id AS conditionId FROM token_markets").all() as { tokenId: string; conditionId: string }[])
        .map((row) => [row.tokenId, row.conditionId])
    );
    for (const decision of decisions) {
      const terms = JSON.parse(decision.exactTermsJson) as Record<string, unknown>;
      const side = stringTerm(terms, "side").toUpperCase();
      if (decision.action === "DETECT") { if (side === "BUY") detectedBuy++; if (side === "SELL") detectedSell++; continue; }
      if (decision.action !== "COPY" && decision.action !== "SELL" && decision.action !== "REDEEM") continue;
      const leaderId = stringTerm(terms, "leaderId", "unknown");
      const tokenId = stringTerm(terms, "tokenId");
      if (decision.action === "REDEEM") {
        const payout = numberTerm(terms, "grossPayoutUsd", "payoutUsd", "size");
        const conditionId = stringTerm(terms, "conditionId");
        let removedCost = 0;
        for (const [key, position] of positions) {
          const sameLeader = leaderId === "unknown" || position.leaderId === leaderId;
          const sameOutcome = conditionId
            ? tokenConditions.get(position.tokenId) === conditionId
            : Boolean(tokenId && position.tokenId === tokenId);
          if (sameLeader && sameOutcome) {
            removedCost += position.shares * position.avgEntryPrice; positions.delete(key);
          }
        }
        const statedCost = numberTerm(terms, "costBasisUsd");
        const cost = statedCost || removedCost;
        cash += payout; realized += payout - cost;
        continue;
      }
      const effectiveSide = decision.action === "SELL" ? "SELL" : side;
      const shares = numberTerm(terms, "appliedShares", "filledShares", "size");
      const usd = numberTerm(terms, "filledUsd") || shares * numberTerm(terms, "executablePrice", "price", "requestedPrice");
      const fee = numberTerm(terms, "feeUsd", "matchedFeeUsd");
      const key = `${leaderId}\n${tokenId}`;
      const current = positions.get(key) ?? { leaderId, tokenId, shares: 0, avgEntryPrice: 0 };
      if (effectiveSide === "BUY") {
        const cost = usd + fee;
        const nextShares = current.shares + shares;
        current.avgEntryPrice = nextShares ? (current.shares * current.avgEntryPrice + cost) / nextShares : 0;
        current.shares = nextShares; positions.set(key, current); cash -= cost; copiedBuy++;
      } else {
        const sold = Math.min(shares, current.shares);
        const proportion = shares ? sold / shares : 0;
        const proceeds = usd * proportion - fee * proportion;
        const cost = sold * current.avgEntryPrice;
        cash += proceeds; realized += proceeds - cost; current.shares -= sold;
        if (current.shares <= 1e-12) positions.delete(key); else positions.set(key, current);
        copiedSell++;
      }
    }
    const digest = createHash("sha256").update(decisions.map((d) =>
      [d.decisionId, d.rawEventId, d.action, d.reasonCode, d.exactTermsJson, d.decidedAt].join("\n")
    ).join("\n---\n")).digest("hex");
    return {
      decisionDigest: digest, cashUsd: round(cash), realizedPnlUsd: round(realized),
      positions: [...positions.values()].map((p) => ({ ...p, shares: round(p.shares), avgEntryPrice: round(p.avgEntryPrice) }))
        .sort((a, b) => `${a.leaderId}\n${a.tokenId}`.localeCompare(`${b.leaderId}\n${b.tokenId}`)),
      coverage: { buyPct: pct(copiedBuy, detectedBuy), sellPct: pct(copiedSell, detectedSell), totalPct: pct(copiedBuy + copiedSell, detectedBuy + detectedSell) },
    };
  } finally { db.close(); }
}

export function captureStoredEvidenceBaseline(dbPath: string, experimentId: string): ReplayEvidenceSummary {
  const derived = replayEvidence(dbPath, experimentId);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const experiment = db.prepare("SELECT canonical_config_json AS configJson FROM experiments WHERE experiment_id=?")
      .get(experimentId) as { configJson: string };
    const config = JSON.parse(experiment.configJson) as { app?: { global?: { risk?: { startingCapitalUsd?: number } } } };
    const initial = config.app?.global?.risk?.startingCapitalUsd ?? 0;
    const cashRow = db.prepare("SELECT cash_usd AS cashUsd FROM cash_ledger WHERE scope='preview'").get() as { cashUsd: number } | undefined;
    const positions = (db.prepare(`SELECT leader_id AS leaderId, token_id AS tokenId, shares,
      avg_entry_price AS avgEntryPrice FROM positions WHERE ABS(shares)>1e-12 ORDER BY leader_id, token_id`).all() as ReplayPosition[])
      .map((position) => ({ ...position, shares: round(position.shares), avgEntryPrice: round(position.avgEntryPrice) }));
    const pnl = db.prepare("SELECT COALESCE(SUM(realized_pnl), 0) AS realizedPnlUsd FROM daily_stats").get() as { realizedPnlUsd: number };
    return { ...derived, cashUsd: round(cashRow?.cashUsd ?? initial), positions, realizedPnlUsd: round(pnl.realizedPnlUsd) };
  } finally { db.close(); }
}

export interface ReplayVerificationResult { match: boolean; expected: ReplayEvidenceSummary; actual: ReplayEvidenceSummary; mismatches: string[] }
export function verifyExperimentReplay(manifestPath: string): ReplayVerificationResult {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { experimentId: string; files: { path: string; sha256: string }[]; replayBaseline: ReplayEvidenceSummary };
  const artifact = manifest.files[0];
  const relative = artifact?.path;
  if (!relative || relative.split(/[\\/]/).includes("..") || relative.startsWith("/")) throw new Error("Unsafe snapshot path in archive manifest");
  const snapshotPath = resolve(dirname(manifestPath), relative);
  const checksum = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
  if (checksum !== artifact.sha256) throw new Error("Archived snapshot checksum mismatch");
  const actual = replayEvidence(snapshotPath, manifest.experimentId);
  const expected = manifest.replayBaseline;
  const mismatches = (["decisionDigest", "cashUsd", "positions", "realizedPnlUsd", "coverage"] as const)
    .filter((key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]));
  return { match: mismatches.length === 0, expected, actual, mismatches };
}
