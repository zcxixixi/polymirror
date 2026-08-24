# Preview Cash Redeem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make preview copy trading recycle capital correctly for short-duration Polymarket markets by using a cash ledger, letting exits bypass buy-spend caps, settling resolved REDEEM events, and auto-settling ended markets whose winner is inferable from official market prices.

**Architecture:** Keep the existing copy-cycle and SQLite store. Add small persistent state for preview cash and token-to-market metadata, then process REDEEM activities and preview-only automatic market settlement through the same audit pipeline without changing live order execution.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, @polymarket/client public SDK.

---

### Task 1: Stop Current Server Simulations

**Files:**
- Remote config only: `/opt/polymirror/config.yaml`

- [x] **Step 1: Backup and disable tests**

Run:
```bash
ssh -i /Users/kaijimima1234/Downloads/cenxi.pem ubuntu@54.252.59.87 \
  'cd /opt/polymirror && cp config.yaml config.yaml.bak-$(date +%Y%m%d-%H%M%S)-hard-disable-tests'
```

- [x] **Step 2: Set all accounts and leaders disabled**

Change every account to:
```yaml
enabled: false
global:
  risk:
    enable_copy_trading: false
leaders:
  - enabled: false
```

- [x] **Step 3: Restart and verify no enabled leaders**

Run:
```bash
docker compose restart polymirror
curl -fsS http://127.0.0.1:8080/health
```
Expected: `"enabledLeaders":[]` and `"lastPollAt":null` after restart.

### Task 2: Add Failing Regression Tests

**Files:**
- Modify: `tests/copy-cycle.test.ts`
- Modify: `tests/store-transactions.test.ts`

- [x] **Step 1: Test SELL bypasses buy-spend cap**

Add a test that fills the daily buy volume, creates a local position, then copies a `SELL` activity. Expected after the fix: SELL copies, position reaches zero, and daily buy volume stays unchanged.

- [x] **Step 2: Test preview cash moves on BUY and SELL**

Add a store-level test using `cashInitialUsd: 200`. Expected: BUY $50 leaves cash $150; SELL $20 brings cash to $170.

- [x] **Step 3: Test REDEEM settles resolved winning token**

Add a copy-cycle test with a BUY carrying `conditionId`, `slug`, and token metadata, then a REDEEM for that condition. Mock market resolution to return the bought token as winner. Expected: position clears, cash returns by shares redeemed, and audit contains `REDEEM`.

- [x] **Step 4: Verify red**

Run:
```bash
npm test -- tests/copy-cycle.test.ts tests/store-transactions.test.ts
```
Expected: new tests fail because cash ledger, REDEEM settlement, and SELL cap bypass do not exist yet.

### Task 3: Implement Store State

**Files:**
- Modify: `src/state/store.ts`

- [x] **Step 1: Add SQLite tables**

Add:
```sql
CREATE TABLE IF NOT EXISTS cash_ledger (
  scope TEXT PRIMARY KEY,
  cash_usd REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS token_markets (
  token_id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  title TEXT,
  slug TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_markets_condition ON token_markets(condition_id);
```

- [x] **Step 2: Add cash methods**

Add methods:
```ts
getCashBalance(initialUsd: number): number
adjustCash(deltaUsd: number, initialUsd: number): number
```

- [x] **Step 3: Add market metadata methods**

Add methods:
```ts
upsertTokenMarket(entry: TokenMarketEntry): void
listPositionsByCondition(leaderId: string, conditionId: string): PositionWithMarketRow[]
listOpenConditions(): OpenConditionRow[]
settleCondition(entry: SettleConditionEntry): SettleConditionResult
```

- [x] **Step 4: Wire cash into existing copy records**

Extend `recordCopySuccess`, `recordLiveOrderAccepted`, and `commitPendingOrderProgress` so BUY adds daily buy volume and debits preview cash; SELL does not add buy volume and credits preview cash.

### Task 4: Implement Poll and REDEEM Flow

**Files:**
- Modify: `src/monitor/data-api.ts`
- Modify: `src/monitor/poll.ts`
- Modify: `src/engine/aggregate.ts`
- Modify: `src/engine/copy-cycle.ts`
- Create: `src/monitor/market-resolve.ts`

- [x] **Step 1: Preserve REDEEM fields**

Map non-trade REDEEM fields:
```ts
conditionId, usdcSize/amount, title, slug, eventSlug
```

- [x] **Step 2: Poll TRADE and REDEEM**

When `copyTradesOnly` is true, poll `TRADE` and `REDEEM` separately, then filter candidates by age. REDEEM candidates require `conditionId`.

- [x] **Step 3: Resolve winner token**

Use `client.fetchMarket({ slug })`, read `market.outcomes.yes/no.price`, and return token IDs where resolved price is at least `0.99`.

- [x] **Step 4: Process REDEEM before order path**

In `runCopyCycle`, handle `activity.type === "REDEEM"` before requiring `asset/side`. If local positions exist for the condition and market is resolved, call `settleCondition`.

- [x] **Step 5: Auto-settle resolved preview positions**

Before normal copy processing in preview mode, scan open local conditions and use `fetchResolvedMarketOutcome(slug)` to settle positions even when the leader REDEEM event is delayed or absent. Treat a market as settlable when official closed/resolved is true, or when `endDate` has passed and one outcome price is at least `0.99`.

### Task 5: Verify and Deploy

**Files:**
- Remote: `/opt/polymirror`

- [x] **Step 1: Verify locally**

Run:
```bash
npm test -- tests/copy-cycle.test.ts tests/store-transactions.test.ts
npm run lint
npm run build:daemon
```

- [x] **Step 2: Deploy to AWS**

Run:
```bash
rsync -az --delete --exclude node_modules --exclude data --exclude .git \
  ./ ubuntu@54.252.59.87:/opt/polymirror/
ssh ubuntu@54.252.59.87 'cd /opt/polymirror && docker compose up -d --build'
```

- [x] **Step 3: Start fresh simulation**

Backup old account data and start fresh:
```bash
mv data/accounts data/accounts.bak-$(date +%Y%m%d-%H%M%S)-pre-cash-redeem
```

Enable only the requested fresh test account first:
```yaml
id: ceshi
enabled: true
global:
  max_trade_age_hours: 0.05
  buy_dedup_window_ms: 0
  risk:
    starting_capital_usd: 200
    max_daily_volume_usd: 100000
    max_open_markets: 200
    max_order_usd: 1
strategy:
  type: FIXED
  copy_size: 1
```

- [x] **Step 4: Runtime verification**

After 20-30 minutes, verify:
```sql
SELECT * FROM cash_ledger;
SELECT action, side, COUNT(*) FROM audit_log GROUP BY action, side;
SELECT COUNT(*), SUM(shares * avg_entry_price) FROM positions WHERE shares > 0;
```
Expected: BUY reduces cash, REDEEM increases cash and clears resolved positions, SELL is not blocked by daily volume.

Observed on AWS:
- 25% run: settled three 2:15-2:30 ET conditions after resolver fix, but exhausted 200U cash quickly.
- Final `ceshi` run: only `ceshi_b55fa129` enabled, strategy `FIXED $1`, starting cash 200U, 77 COPY rows, open cost about 77.0055U, cash about 123U, errors empty.

### Task 6: Parameter Sweep and Parallel Preview Accounts

**Files:**
- Create: `src/sim/preview-replay.ts`
- Create: `src/sim/preview-report.ts`
- Create: `tests/preview-replay.test.ts`
- Create: `tests/preview-report.test.ts`
- Create: `scripts/sweep-preview-params.mts`
- Create: `scripts/report-preview-accounts.mts`
- Remote config only: `/opt/polymirror/config.yaml`

- [x] **Step 1: Add offline replay tests**

Add tests proving replay uses the same cash ledger and can auto-settle ended markets without a REDEEM activity.

- [x] **Step 2: Add replay module**

Use existing `calculateOrderSize`, `passActivityFilters`, `RiskGate`, and `StateStore` instead of a separate fake strategy engine.

- [x] **Step 3: Add sweep script**

Run:
```bash
SWEEP_LIMIT=500 node --import tsx scripts/sweep-preview-params.mts
```

Observed report:
```text
reports/preview-sweeps/sweep-2026-07-06T06-56-18-409Z.json
```

Key results from 500 TRADE + 500 REDEEM replay:
```text
fixed_5u               copy=433 pnl=197.37 cash=2.37   open=394.9887
fixed_2u               copy=486 pnl=79.03  cash=15.03  open=264.0309
fixed_2u_token_cap_12u copy=435 pnl=79.03  cash=117.05 open=161.9747
fixed_1u               copy=486 pnl=39.44  cash=107.44 open=132.0128
fixed_1u_token_cap_8u  copy=446 pnl=39.44  cash=147.44 open=91.9968
pct_10_cap_20u         copy=191 pnl=2.08   cash=0.66   open=201.4833
pct_5_cap_20u          copy=104 pnl=-18.52 cash=84.59  open=96.9321
pct_25_cap_20u         copy=74  pnl=-69.89 cash=0.15   open=130.0307
adaptive_10_5_20       copy=77  pnl=-85.45 cash=0.23   open=114.3397
```

- [x] **Step 4: Start three isolated AWS preview accounts**

Enabled only:
```text
ceshi                  FIXED 1U baseline
ceshi_fixed1_cap8      FIXED 1U, max_position_usd=8, position_cap_basis=cost
ceshi_fixed2_cap12     FIXED 2U, max_position_usd=12, position_cap_basis=cost
```

All three use:
```yaml
starting_capital_usd: 200
min_order_usd: 1
max_trade_age_hours: 0.05
buy_dedup_window_ms: 0
filters:
  min_price: 0.05
  max_price: 0.95
  sides: [BUY, SELL]
```

- [x] **Step 5: Verify server runtime**

Observed after restart:
```text
enabledLeaders:
- ceshi_b55fa129
- ceshi_fixed1_cap8_b55fa129
- ceshi_fixed2_cap12_b55fa129
errors: []
```

First filtered DB snapshot:
```text
ceshi:               52 COPY, cost 51.9970U, cash 148U
ceshi_fixed1_cap8:   28 COPY, cost 27.9934U, cash 172U
ceshi_fixed2_cap12:  23 COPY, cost 46.0015U, cash 154U
```

Second online snapshot after the first 15m settlement window:
```text
health: ok
errors: []

ceshi:
  195 COPY
  4 REDEEM
  realized_pnl: +0.06U
  open_cost: 132.9883U
  cash: 67.04U

ceshi_fixed1_cap8:
  108 COPY
  4 REDEEM
  realized_pnl: +7.38U
  open_cost: 64.9906U
  cash: 142.36U

ceshi_fixed2_cap12:
  93 COPY
  4 REDEEM
  realized_pnl: +21.91U
  open_cost: 111.9874U
  cash: 109.92U
```

Interpretation:
- `ceshi_fixed2_cap12` currently has the best realized PnL.
- `ceshi_fixed1_cap8` has lower PnL but much lower capital occupancy.
- baseline `ceshi` over-allocates capital without improving realized PnL in this sample.
- unresolved 15m positions remained only where official market data still returned no winner.

Third online report generated by `scripts/report-preview-accounts.mts`:
```text
Report: reports/preview-live/preview-report-2026-07-06T07-23-24-492Z.json

ceshi:
  realized_pnl: +10.47U
  open_cost: 127.9783U
  cash: 82.46U
  copies: 219
  redeems: 5
  errors: 0

ceshi_fixed1_cap8:
  realized_pnl: +12.86U
  open_cost: 66.9906U
  cash: 145.84U
  copies: 125
  redeems: 5
  errors: 0

ceshi_fixed2_cap12:
  realized_pnl: +32.47U
  open_cost: 119.9913U
  cash: 112.48U
  copies: 109
  redeems: 5
  errors: 0
```

Current read:
- `ceshi_fixed2_cap12` still leads realized PnL with acceptable remaining cash.
- `ceshi_fixed1_cap8` remains the conservative choice with the best cash buffer.
- baseline `ceshi` is no longer preferred: more copies and higher occupancy without matching `fixed2_cap12` PnL.

- [x] **Step 6: Full local verification**

Run:
```bash
npm test
npm run lint
npm run build
```

Observed:
```text
29 test files passed
113 tests passed
tsc --noEmit passed
production build passed
```

## Follow-up: Settlement Audit Tool

Added a read-only settlement audit path to avoid guessing whether open preview positions are genuinely pending or should already be cash again.

Created:
- `src/sim/settlement-audit.ts`
- `scripts/audit-preview-settlements.mts`
- `tests/settlement-audit.test.ts`

Behavior:
- Reads preview DB positions and token market metadata.
- Checks official market resolution through the existing `fetchResolvedMarketOutcome` resolver.
- Classifies each open condition as:
  - `ready_to_settle`
  - `pending`
  - `missing_metadata`
  - `resolver_error`
- Uses resolver timeout protection so an external API stall cannot hang the audit.
- Checks markets concurrently.
- Reuses the existing project proxy helpers, matching the sweep script path.

Observed from the 2026-07-06 15:34 local DB snapshot:
```text
reports/preview-live/settlement-audit-2026-07-06T08-04-24-213Z.json

ceshi:
  open: 12
  ready_to_settle: 9
  pending: 2
  resolver_error: 1

ceshi_fixed1_cap8:
  open: 12
  ready_to_settle: 10
  pending: 2
  resolver_error: 0

ceshi_fixed2_cap12:
  open: 12
  ready_to_settle: 10
  pending: 2
  resolver_error: 0
```

Important caveat:
- This audit used an older copied DB snapshot, so markets that became resolved after the copy can appear `ready_to_settle` even if the live server later auto-settled them.
- A fresh server check was attempted after adding the audit, but both SSH `22` and health port `8080` to `54.252.59.87` timed out from the local machine at that moment. This was a connectivity check failure, not evidence of an app-layer failure.
