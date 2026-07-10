# PolyMirror Preview Experiment Protocol

## Purpose

Compare Candidate wallets and parameter robustness with independent 200U simulation ledgers. The experiment optimizes reproducibility and risk-adjusted copy quality, not trade count or short-window PnL.

## Cohort Rules

- One account contains exactly one Candidate and one parameter arm.
- Every Candidate receives conservative, standard, and aggressive arms from the same cohort start.
- All generated accounts use `preview_mode: true`, `copy_price_mode: executable_guarded`, and `order_type: FOK`.
- Starting capital is always 200U. Accounts never share cash, positions, dedup state, or experiment evidence.
- Incomplete Candidate entries remain disabled. Generation never edits the base config and refuses to overwrite its output.
- A cohort contains at most 10 Candidates and 30 accounts. Poll caching should be shared by leader address at runtime.

Default arms:

| Arm | Fixed order | Position cap | Daily volume | Slip limit | Price range |
| --- | ---: | ---: | ---: | ---: | ---: |
| Conservative | 1U | 10U | 40U | 1.5% | 0.10-0.70 |
| Standard | 2U | 20U | 80U | 2.5% | 0.05-0.80 |
| Aggressive | 5U | 40U | 160U | 4.0% | 0.02-0.90 |

## Candidate Intake

Prefer wallets with adequate history, recent activity, reproducible ticket sizes, low observed slip, diversified profit contribution, and a clear exit path. Record the source snapshot and selection reason. Do not promote from leaderboard PnL alone.

Use at least two plausibly low-correlation Candidate clusters. Examples include short-horizon crypto direction, slower event markets, and diversified cross-category trading. Hedged or market-making wallets require a separate replication test because copying only one leg can invert their risk.

## Promotion And Elimination

Review 60m, 6h, 24h, and 14d windows without changing a running account's identity. Parameter changes create a new experiment.

Funding review requires at least two low-correlation Candidates to meet all active Goal gates: REDEEM >= 30, realized PnL > 0, win rate >= 60%, Profit Factor >= 1.5, max drawdown <= 10%, no concentrated-winner dependency, correct COPY/SELL/REDEEM and ledger paths, no pending buildup, and no wallet drift.

Retire an arm for persistent loss, broken exit coverage, unexplained copy gaps, unsafe slip, or invalid evidence. Keep its sealed history; never merge it into a new parameter run.

Two weeks is a review checkpoint, not an automatic funding date. Live canary and funding remain separate, explicitly confirmed decisions.

## Generation

Prepare a cohort JSON matching `config/candidate-cohort.schema.json`, then generate a new file:

```bash
npx tsx scripts/build-candidate-experiments.mts config.yaml cohort.json /tmp/polymirror-cohort.yaml
```

Validate the generated file through the normal config loader and built container before any transactional preview deployment.

### Candidate image provenance

Candidate cohorts must be built and started from a clean checkout with immutable
runtime provenance. The deployment helper computes the checked-out Git SHA,
builds the current source and dashboard from both lockfiles, inspects the built
image ID, validates Compose interpolation, and starts the already-built image:

```bash
./scripts/deploy-candidate-preview.sh
```

Do not use a registry tag, branch name, or a digest guessed before the build as
provenance. `docker-compose.yml` deliberately refuses to configure or start when
`POLYMIRROR_GIT_SHA` or `POLYMIRROR_IMAGE_DIGEST` is absent.
