import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveExperimentEvidence } from "../src/experiments/archive.js";
import { verifyExperimentReplay } from "../src/experiments/replay-verify.js";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "pm-replay-verify-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("sealed deterministic replay", () => {
  it("replays the exact production TOKEN_SETTLEMENT payload without leaderId", async () => {
    const dbPath = join(dir, "token-settlement.db"); const store = new StateStore(dbPath);
    const config = previewRuntimeConfig(); config.app.global.risk.startingCapitalUsd = 10;
    store.applyCopyFill("whale", "winner", "BUY", 2, 0.5); store.adjustCash(-1, 10);
    const exp = store.startOrResumeExperiment({ accountId: "token-settlement", candidateAddresses: [], config,
      gitSha: "git", imageDigest: "image", lockfileHash: "lock", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "token-settlement-observation:winner",
      payload: { type: "TOKEN_SETTLEMENT", tokenId: "winner", settlement: { settled: true, payoutPerShare: 1, conditionId: "condition" } },
      sourceTimestamp: 1, observedTimestamp: 1 });
    store.setDecisionRawEventIds([raw.rawEventId]);
    store.audit({ action: "DETECT", tokenId: "winner", side: "REDEEM", price: 1, reason: "token settlement detected", preview: true });
    store.recordTokenSettlement("winner", 1, true, 10, { settlementSource: "token_resolution", conditionId: "condition" });
    store.setDecisionRawEventIds([]); store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "token-settlement-archive") });
    expect(verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath }).match).toBe(true);
  });
  it("reconstructs a known BUY, SELL, and REDEEM sequence", async () => {
    const dbPath = join(dir, "source.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig();
    config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 2 };
    const exp = store.startOrResumeExperiment({
      accountId: "candidate-a", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate",
    }, 100);
    const raw = [
      { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-a", price: 0.5, size: 10, timestamp: 1 },
      { leaderId: "whale", type: "TRADE", side: "SELL", asset: "token-a", price: 0.75, size: 10, timestamp: 2 },
      { leaderId: "whale", type: "REDEEM", conditionId: "condition-a", timestamp: 3 },
    ].map((payload, index) => store.recordRawEvent({ sourceId: ["buy", "sell", "redeem"][index], payload, sourceTimestamp: index + 1, observedTimestamp: index + 1 }));
    store.upsertTokenMarket({ tokenId: "token-a", conditionId: "condition-a" });
    store.recordDecision({ rawEventId: raw[0]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY" }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw[0]!.rawEventId, action: "COPY", reasonCode: "copy_executed", exactTerms: { leaderId: "whale", tokenId: "token-a", side: "BUY", requestedShares: 4, requestedPrice: 0.5, filledShares: 4, filledUsd: 2, feeUsd: 0 }, decidedAt: 2 });
    store.applyCopyFill("whale", "token-a", "BUY", 4, 0.5);
    store.adjustCash(-2, 10);
    store.recordDecision({ rawEventId: raw[1]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "token-a", side: "SELL" }, decidedAt: 3 });
    store.recordDecision({ rawEventId: raw[1]!.rawEventId, action: "SELL", reasonCode: "sell_executed", exactTerms: { leaderId: "whale", tokenId: "token-a", side: "SELL", requestedShares: 2.67, requestedPrice: 0.75, filledShares: 2, filledUsd: 1.5, feeUsd: 0 }, decidedAt: 4 });
    const sell = store.applyCopyFill("whale", "token-a", "SELL", 2, 0.75);
    expect(sell.realizedPnl).toBe(0.5);
    store.adjustCash(1.5, 10);
    store.recordDecision({ rawEventId: raw[2]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "condition-a", side: "REDEEM" }, decidedAt: 5 });
    store.recordDecision({ rawEventId: raw[2]!.rawEventId, action: "REDEEM", reasonCode: "redeem_settled", exactTerms: { leaderId: "whale", tokenId: "token-a", conditionId: "condition-a", winnerTokenIds: ["token-a"], grossPayoutUsd: 2, costBasisUsd: 1, realizedPnlUsd: 1 }, decidedAt: 6 });
    store.applyCopyFill("whale", "token-a", "SELL", 2, 1);
    store.adjustCash(2, 10);
    store.close();

    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "archive"), sealedAt: 200 });
    const result = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
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
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-b", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "buy", payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token", price: 0.5, size: 10, timestamp: 1 }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY" }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "COPY", reasonCode: "copy_executed",
      exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY", requestedShares: 2, requestedPrice: 0.5, filledShares: 2, filledUsd: 1, feeUsd: 0 }, decidedAt: 2 });
    // Deliberately omit the corresponding cash/position outcome writes.
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "diverged-archive") });
    const result = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(result.match).toBe(false);
    expect(result.mismatches).toEqual(expect.arrayContaining(["cashUsd", "positions"]));
  });

  it("uses stored market outcomes so REDEEM closes only its condition", async () => {
    const dbPath = join(dir, "conditions.db");
    const store = new StateStore(dbPath);
    const config = previewRuntimeConfig(); config.app.global.risk.startingCapitalUsd = 10;
    config.app.leaders[0]!.strategy = { type: "FIXED", copySize: 1 };
    const exp = store.startOrResumeExperiment({ accountId: "candidate-c", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    store.upsertTokenMarket({ tokenId: "token-a", conditionId: "condition-a" });
    store.upsertTokenMarket({ tokenId: "token-b", conditionId: "condition-b" });
    const raws = [
      { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-a", price: 0.5, size: 10, timestamp: 1 },
      { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token-b", price: 0.5, size: 10, timestamp: 2 },
      { leaderId: "whale", type: "REDEEM", conditionId: "condition-a", timestamp: 3 },
    ].map((payload, index) => store.recordRawEvent({ sourceId: ["a", "b", "redeem-a"][index], payload, sourceTimestamp: index, observedTimestamp: index }));
    for (const [index, tokenId] of ["token-a", "token-b"].entries()) {
      store.recordDecision({ rawEventId: raws[index]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId, side: "BUY" }, decidedAt: index * 2 + 1 });
      store.recordDecision({ rawEventId: raws[index]!.rawEventId, action: "COPY", reasonCode: "copy_executed", exactTerms: { leaderId: "whale", tokenId, side: "BUY", requestedShares: 2, requestedPrice: 0.5, filledShares: 2, filledUsd: 1, feeUsd: 0 }, decidedAt: index * 2 + 2 });
      store.applyCopyFill("whale", tokenId, "BUY", 2, 0.5); store.adjustCash(-1, 10);
    }
    store.recordDecision({ rawEventId: raws[2]!.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "condition-a", side: "REDEEM" }, decidedAt: 5 });
    store.recordDecision({ rawEventId: raws[2]!.rawEventId, action: "REDEEM", reasonCode: "redeem_settled",
      exactTerms: { leaderId: "whale", conditionId: "condition-a", winnerTokenIds: ["token-a"], grossPayoutUsd: 2, costBasisUsd: 1 }, decidedAt: 6 });
    store.applyCopyFill("whale", "token-a", "SELL", 2, 1); store.adjustCash(2, 10);
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "conditions-archive") });
    const result = verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath });
    expect(result.match, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.actual.positions).toEqual([{ leaderId: "whale", tokenId: "token-b", shares: 2, avgEntryPrice: 0.5 }]);
  });

  it("refuses replay when the archived snapshot no longer matches its checksum manifest", async () => {
    const dbPath = join(dir, "tampered.db");
    const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "candidate-d", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    store.close();
    const archived = await archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "tampered-archive") });
    appendFileSync(archived.snapshotPath, "tampered");
    expect(() => verifyExperimentReplay(archived.manifestPath, { sourceDbPath: dbPath })).toThrow(/checksum|trust/i);
  });

  it("rejects a fabricated COPY decision even when the fabricated ledger matches", async () => {
    const dbPath = join(dir, "fabricated.db"); const store = new StateStore(dbPath);
    const config = previewRuntimeConfig(); config.app.global.risk.startingCapitalUsd = 10;
    const exp = store.startOrResumeExperiment({ accountId: "candidate-e", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "fake", payload: { leaderId: "whale", type: "TRADE", side: "BUY", asset: "token", price: 0.5, size: 10, timestamp: 1 }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", side: "BUY", tokenId: "token", size: 10, price: 0.5, preview: true }, decidedAt: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "COPY", reasonCode: "copy_executed", exactTerms: { leaderId: "whale", tokenId: "token", side: "BUY", filledShares: 20, filledUsd: 10, feeUsd: 0, requestedPrice: 0.5, requestedShares: 20, orderType: "GTC", orderStatus: "PREVIEW", preview: true }, decidedAt: 2 });
    store.applyCopyFill("whale", "token", "BUY", 20, 0.5); store.adjustCash(-10, 10); store.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "fabricated-archive") }))
      .rejects.toThrow(/decision digest|re-execution/i);
  });

  it("fails closed on missing accounting fields and oversells", async () => {
    const dbPath = join(dir, "invalid.db"); const store = new StateStore(dbPath); const config = previewRuntimeConfig();
    const exp = store.startOrResumeExperiment({ accountId: "candidate-f", candidateAddresses: [], config,
      gitSha: "git-a", imageDigest: "image-a", lockfileHash: "lock-a", trustClass: "candidate" });
    const raw = store.recordRawEvent({ sourceId: "bad", payload: { leaderId: "whale", type: "TRADE", side: "SELL", asset: "token", price: 0.5, size: 2, timestamp: 1 }, sourceTimestamp: 1, observedTimestamp: 1 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "DETECT", reasonCode: "detected", exactTerms: { leaderId: "whale", tokenId: "token", side: "SELL" }, decidedAt: 0 });
    store.recordDecision({ rawEventId: raw.rawEventId, action: "SELL", reasonCode: "sell_executed", exactTerms: { leaderId: "whale", tokenId: "token", side: "SELL", filledShares: 2 }, decidedAt: 1 });
    store.close();
    await expect(archiveExperimentEvidence({ dbPath, experimentId: exp.experimentId, archiveDir: join(dir, "invalid-archive") }))
      .rejects.toThrow(/filledUsd|oversell|accounting/i);
  });
});
