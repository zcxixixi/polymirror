# PolyMirror Two-Week Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a trustworthy two-week, preview-only Candidate experiment cohort and an evidence-based funding decision, without treating the deadline as a promise to fund or profit.

**Architecture:** Keep the existing copy engine and quality reports. First make hot reload and fill accounting conservative and recoverable, then add an append-only experiment manifest and raw-event/decision lineage around the existing per-account SQLite stores. Deploy only sealed 200U preview experiments; live canary remains a separate, explicitly confirmed gate.

**Tech Stack:** TypeScript, Node.js 24, Vitest, better-sqlite3, YAML, Docker Compose, AWS SSM.

## Current Checkpoint (2026-07-10)

- Active branch: `codex/polymirror-stability-checkpoint-20260710`.
- Completed commits: `4534f17` (atomic config reload), `b27b6c0` (fee-aware recoverable fills), `07f3076` (confirmed fill evidence), and `2a58772` (isolated preview Candidate cohorts).
- Task 1 and Task 2 implementation are complete and covered by the full test suite. A fresh independent re-review of `b27b6c0..07f3076` remains required because the previous reviewer session closed without a final verdict.
- The Candidate cohort generator is implemented and locally smoke-tested, but no new cohort has been deployed. Historical PolyCop addresses remain a watchlist until their current leaderboard and copyability evidence is refreshed: `0xa1795199a227f8d68134f30bf26314a9918c9629`, `0x94016dfa721784b6ab42dd8c9a3a69b5a2b7ad7f`, `0x66f3b58702fa50aff254b4f84de82fe63a13787c`, `0x34b0d22d39b71562a2c8d31823cc83185b533c56`, `0x21168b1447aea2cdd4746cea893b38c50876eb8f`, and `0xe977b6270e1d6740117b4a56cc7595e4c9e4700f`.
- Next critical path: complete Task 3 and Task 4 lineage/replay work, obtain a clean whole-branch review, refresh Candidate evidence, then perform a transactional preview-only deployment.
- Last confirmed server snapshot: Docker healthy, `/health` OK, `previewMode=true`, kill switch off, no pending orders, no wallet drift, and no last error. Refresh this snapshot before any deployment.
- Fresh local verification at this checkpoint: `npm test` passed 63 files / 344 tests; `npm run lint` and `npm run build` passed. The dashboard build retains its existing non-fatal chunk-size warning.

## Global Constraints

- All deployed Candidate experiments remain `preview_mode: true`.
- Do not print `.env`, private keys, API credentials, or wallet secrets.
- Do not enable or fund live trading without a second explicit user confirmation.
- Preserve existing account history; classify it as partial or legacy instead of deleting it.
- Use additive schema migrations and keep backward compatibility with existing SQLite files.
- Every behavior change follows a failing-test, passing-test cycle.
- Funding review requires at least two low-correlation Candidates meeting the Goal thresholds; two weeks is a review point, not an automatic launch.

---

### Task 1: Atomic Config Reload and Safe Mode Transitions

**Files:**
- Modify: `src/accounts/manager.ts`
- Modify: `src/api/settings.ts`
- Test: `tests/account-manager-reload.test.ts`
- Test: `tests/api-integration.test.ts`

**Interfaces:**
- `AccountManager.reloadConfig(): Promise<void>` must finish all fallible resolution and store preparation before mutating live runtimes.
- `validateSettingsCandidate(...)` must validate both the source preview DB and destination live DB for Preview-to-Live migrations.
- `stopCopyTrading(...)` must align to the destination preview DB's bound copy-price mode so the emergency stop is not blocked by historical DB metadata.

- [x] Add a failing reload test where the second leader resolution fails after the first account is staged; assert every runtime, mode, store path, and global setting remains unchanged.
- [x] Run `npm test -- tests/account-manager-reload.test.ts` and confirm the atomicity assertion fails.
- [x] Stage resolved account configs and replacement stores, then commit the new runtime map synchronously only after all staging succeeds.
- [x] Run the focused reload test and existing account/mode tests.
- [x] Add a failing settings test for a combined `leader_limit` Preview DB to `executable_guarded` Live transition; assert preflight rejects before reload.
- [x] Add a failing emergency-stop test with a guarded Live DB and leader-limit Preview DB; assert stop succeeds and writes the destination mode.
- [x] Implement source/destination compatibility checks and destination-mode alignment for stop.
- [x] Run `npm test -- tests/api-integration.test.ts tests/mode-transition.test.ts tests/account-manager-reload.test.ts`.

### Task 2: Confirmed Fill Recovery, Actual Execution Price, and Fee-Aware Accounting

**Files:**
- Modify: `src/executor/trading-backend.ts`
- Modify: `src/executor/secure-backend.ts`
- Modify: `src/executor/clob.ts`
- Modify: `src/engine/order-reconcile.ts`
- Modify: `src/engine/pending-orders.ts`
- Modify: `src/engine/copy-cycle.ts`
- Modify: `src/state/store.ts`
- Modify: `src/executor/orderbook.ts`
- Test: `tests/secure-backend.test.ts`
- Test: `tests/clob-executor.test.ts`
- Test: `tests/order-reconcile.test.ts`
- Test: `tests/copy-cycle-pending.test.ts`
- Test: `tests/store-transactions.test.ts`
- Test: `tests/orderbook-quote.test.ts`

**Interfaces:**
- `CompletedOrderFill` adds `feeUsd` and `cashDeltaUsd` while preserving trade notional as `usd`.
- `OrderStatusSnapshot` adds cumulative actual `filledUsd`, `feeUsd`, and `averagePrice` when trade evidence is available.
- `live_order_intents` and `pending_orders` persist leader price, executable price, slippage, cumulative notional, and cumulative fees.
- Preview guarded quotes persist a fee estimate derived from the SDK market fee parameters; execution price remains fee-exclusive while position cost and realized PnL include fees.

- [x] Add failing tests proving `RETRYING`, `MATCHED`, `MINED`, and `FAILED` rows are not adopted as completed crash-recovery fills; only `CONFIRMED` is terminal.
- [x] Add a failing test proving a unique partial confirmed FAK fill is recovered and a fill above the intent price/size bound is rejected.
- [x] Add failing tests proving polled and recovered fills use trade-weighted execution prices rather than the order limit.
- [x] Add failing tests proving recovered COPY telemetry retains leader price and recomputes actual slippage.
- [x] Add failing tests proving BUY cost includes fees and SELL proceeds subtract fees without changing execution-price telemetry.
- [x] Implement one shared trade aggregation path for taker and maker order IDs, terminal-status filtering, fee calculation, and actual notional.
- [x] Extend additive SQLite migrations and transactional store methods for cumulative fill/fee state and intent telemetry.
- [x] Use actual cumulative fill deltas in pending reconciliation and actual fill telemetry in restart recovery.
- [x] Add preview fee parameters to guarded order-book snapshots and apply the same fee formula used by the installed Polymarket SDK.
- [x] Run all focused execution, reconciliation, store, and copy-cycle tests.

### Task 3: Immutable Experiment Manifest and Raw Event Lineage

**Files:**
- Create: `src/experiments/manifest.ts`
- Create: `src/experiments/provenance.ts`
- Modify: `src/state/store.ts`
- Modify: `src/accounts/manager.ts`
- Modify: `src/monitor/data-api.ts`
- Modify: `src/engine/copy-cycle.ts`
- Modify: `src/sim/preview-report.ts`
- Modify: `src/sim/preview-report-runner.ts`
- Test: `tests/experiment-manifest.test.ts`
- Test: `tests/raw-event-lineage.test.ts`
- Test: `tests/preview-report.test.ts`

**Interfaces:**
- `experiments` is append-only and stores experiment ID, account ID, Candidate addresses, redacted canonical config JSON and SHA-256, Git SHA, image digest, lockfile hash, schema version, start/end/sealed timestamps, and trust classification.
- `raw_events` stores a source ID or deterministic full-payload hash, raw normalized payload, source timestamp, observed timestamp, and experiment ID.
- `decisions` links each raw event to DETECT/SKIP/COPY/SELL/REDEEM with structured reason code and exact order/quote terms.

- [ ] Add failing tests for canonical redaction/hash stability and immutable manifest rows across hot reload.
- [ ] Add failing tests that duplicate source events retain one raw row but can link to deterministic decisions without losing source timestamps.
- [ ] Implement schema-version metadata plus additive manifest/raw-event/decision tables.
- [ ] Start or resume the active experiment when an account runtime is created; rotate to a new experiment when decision-affecting config changes.
- [ ] Persist raw events before filters and link every terminal decision to the raw event.
- [ ] Include experiment ID, config hash, code/image identifiers, schema version, and trust class in quality report output.
- [ ] Run focused manifest, lineage, report, replay, and copy-cycle tests.

### Task 4: Sealed Evidence, Backup, and Deterministic Replay Gate

**Files:**
- Create: `src/experiments/archive.ts`
- Create: `src/experiments/replay-verify.ts`
- Create: `src/report-preview-experiment-verify.ts`
- Modify: `src/sim/audit-log-prune.ts`
- Modify: `package.json`
- Test: `tests/experiment-archive.test.ts`
- Test: `tests/experiment-replay-verify.test.ts`
- Test: `tests/audit-log-prune.test.ts`

**Interfaces:**
- WAL-safe SQLite backup produces a SHA-256 checksum manifest and seals an experiment before evidence can be pruned.
- Replay verification consumes only stored manifest, raw events, quote evidence, and outcomes, then compares decision digest, cash, positions, realized PnL, and coverage.

- [ ] Add a failing test that pruning refuses unsealed experiment evidence.
- [ ] Add a failing test that a backup checksum changes when the source snapshot changes and verifies after restore.
- [ ] Add a failing deterministic replay test with a known BUY, SELL, and REDEEM sequence.
- [ ] Implement WAL-safe archive, checksum manifest, seal transition, and prune guard.
- [ ] Implement replay digest comparison and a CLI report command.
- [ ] Run archive, replay, prune, cash-reconcile, and preview-report tests.

### Task 5: Preview Candidate Matrix and Deployment Gate

**Files:**
- Create: `scripts/build-candidate-experiments.mts`
- Create: `config/candidate-cohort.schema.json`
- Create: `docs/EXPERIMENT_PROTOCOL.md`
- Test: `tests/candidate-experiment-config.test.ts`

**Interfaces:**
- Candidate input produces independent 200U accounts with a common baseline plus conservative/standard/aggressive arms only for promoted Candidates.
- Generated accounts are always preview-only, copy-enabled only when fully configured, FOK for guarded execution, and include immutable experiment labels.

- [x] Add failing tests for 200U isolation, unique IDs, preview-only enforcement, FOK enforcement, and hard exposure/slippage caps.
- [x] Implement deterministic config generation without modifying the root config.
- [x] Document Candidate intake, common baseline, promotion, elimination, correlation, and two-week review rules.
- [ ] Generate the candidate config in a temporary remote path and validate it against the built image.
- [x] Run full `npm test`, `npm run lint`, `npm run build`, and `git diff --check`.
- [ ] Obtain an independent whole-branch review and resolve every Critical/Important finding.
- [ ] Deploy transactionally with exact config rollback, keeping root preview-only and live probe disabled by default.
- [ ] Verify `/health`, dashboard, collector, per-experiment manifests, and 60m/6h/24h quality windows.

### Task 6: Two-Week Evaluation and Funding Review

**Files:**
- Generated artifacts only under `reports/` and remote archival storage.

**Interfaces:**
- Promotion requires at least two low-correlation Candidates satisfying every active Goal threshold with sealed, replay-verified evidence.

- [ ] Monitor data health and experiment completeness without globally loosening parameters.
- [ ] Add Candidates continuously while preserving the common baseline.
- [ ] Review conservative/standard/aggressive robustness by Candidate and reject narrow one-parameter winners.
- [ ] At the two-week checkpoint, issue `fund`, `extend preview`, or `reject` with metric and lineage evidence.
- [ ] If and only if `fund` is supported and the user explicitly confirms again, design a one-shot capped live canary before any 200U live allocation.
