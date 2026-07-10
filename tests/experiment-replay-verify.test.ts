import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveExperimentEvidence } from "../src/experiments/archive.js";
import { verifyExperimentReplay } from "../src/experiments/replay-verify.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pm-replay-verify-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("sealed deterministic replay", () => {
  it("reconstructs a known BUY, SELL, and REDEEM sequence", async () => {
    const dbPath = join(dir, "source.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    const exp = store.startOrResumeExperiment({
      accountId: "candidate-a", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate",
    }, 100);
    const raw = ["buy", "sell", "redeem"].map((sourceId, index) => store.recordRawEvent({
      sourceId, payload: { sourceId }, sourceTimestamp: index + 1, observedTimestamp: index + 1,
    }));
    store.recordDecision({ rawEventId: raw[0]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { side: "BUY" }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw[0]!.rawEventId, action: "COPY", reasonCode: "copy_executed", exactTerms: { leaderId: "leader", tokenId: "token-a", side: "BUY", filledShares: 4, filledUsd: 2, feeUsd: 0 }, decidedAt: 2 });
    store.applyCopyFill("leader", "token-a", "BUY", 4, 0.5);
    store.adjustCash(-2, 10);
    store.recordDecision({ rawEventId: raw[1]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { side: "SELL" }, decidedAt: 3 });
    store.recordDecision({ rawEventId: raw[1]!.rawEventId, action: "SELL", reasonCode: "sell_executed", exactTerms: { leaderId: "leader", tokenId: "token-a", side: "SELL", filledShares: 2, filledUsd: 1.5, feeUsd: 0 }, decidedAt: 4 });
    const sell = store.applyCopyFill("leader", "token-a", "SELL", 2, 0.75);
    expect(sell.realizedPnl).toBe(0.5);
    store.adjustCash(1.5, 10);
    store.recordDecision({ rawEventId: raw[2]!.rawEventId, action: "REDEEM", reasonCode: "redeem_settled", exactTerms: { leaderId: "leader", tokenId: "token-a", grossPayoutUsd: 2, costBasisUsd: 1, realizedPnlUsd: 1 }, decidedAt: 5 });
    store.applyCopyFill("leader", "token-a", "SELL", 2, 1);
    store.adjustCash(2, 10);
    store.close();

    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "archive"), sealedAt: 200 });
    const result = verifyExperimentReplay(archived.manifestPath);
    expect(result.match, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.actual).toMatchObject({ cashUsd: 11.5, realizedPnlUsd: 1.5, coverage: { buyPct: 100, sellPct: 100, totalPct: 100 } });
    expect(result.actual.positions).toEqual([]);
    expect(result.actual.decisionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detects when stored outcomes diverge from the decision evidence", async () => {
    const dbPath = join(dir, "diverged.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    const exp = store.startOrResumeExperiment({ accountId: "candidate-b", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "buy", payload: { side: "BUY" }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { side: "BUY" }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "COPY", reasonCode: "copy_executed",
      exactTerms: { leaderId: "leader", tokenId: "token", side: "BUY", filledShares: 2, filledUsd: 1 }, decidedAt: 2 });
    // Deliberately omit the corresponding cash/position outcome writes.
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "diverged-archive") });
    const result = verifyExperimentReplay(archived.manifestPath);
    expect(result.match).toBe(false);
    expect(result.mismatches).toEqual(expect.arrayContaining(["cashUsd", "positions"]));
  });

  it("uses stored market outcomes so REDEEM closes only its condition", async () => {
    const dbPath = join(dir, "conditions.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig(); config.app.global.risk.startingCapitalUsd = 10;
    const exp = store.startOrResumeExperiment({ accountId: "candidate-c", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    store.upsertTokenMarket({ tokenId: "token-a", conditionId: "condition-a" });
    store.upsertTokenMarket({ tokenId: "token-b", conditionId: "condition-b" });
    const raws = ["a", "b", "redeem-a"].map((sourceId, index) => store.recordRawEvent({ sourceId, payload: { sourceId }, sourceTimestamp: index, observedTimestamp: index }));
    for (const [index, tokenId] of ["token-a", "token-b"].entries()) {
      store.recordDecision({ rawEventId: raws[index]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { side: "BUY" }, decidedAt: index * 2 + 1 });
      store.recordDecision({ rawEventId: raws[index]!.rawEventId, action: "COPY", reasonCode: "copy_executed", exactTerms: { leaderId: "leader", tokenId, side: "BUY", filledShares: 2, filledUsd: 1 }, decidedAt: index * 2 + 2 });
      store.applyCopyFill("leader", tokenId, "BUY", 2, 0.5); store.adjustCash(-1, 10);
    }
    store.recordDecision({ rawEventId: raws[2]!.rawEventId, action: "REDEEM", reasonCode: "redeem_settled",
      exactTerms: { leaderId: "leader", conditionId: "condition-a", grossPayoutUsd: 2, costBasisUsd: 1 }, decidedAt: 5 });
    store.applyCopyFill("leader", "token-a", "SELL", 2, 1); store.adjustCash(2, 10);
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "conditions-archive") });
    const result = verifyExperimentReplay(archived.manifestPath);
    expect(result.match, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.actual.positions).toEqual([{ leaderId: "leader", tokenId: "token-b", shares: 2, avgEntryPrice: 0.5 }]);
  });

  it("refuses replay when the archived snapshot no longer matches its checksum manifest", async () => {
    const dbPath = join(dir, "tampered.db");
    const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "candidate-d", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "tampered-archive") });
    appendFileSync(archived.snapshotPath, "tampered");
    expect(() => verifyExperimentReplay(archived.manifestPath)).toThrow(/checksum/i);
  });
});
