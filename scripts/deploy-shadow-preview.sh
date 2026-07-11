#!/bin/sh
set -eu

# Starts an isolated preview-only cohort. It refuses any path alias to the
# production config/data/reports and never stops the port-8080 service.
production_root="${POLYMIRROR_PRODUCTION_ROOT:-/opt/polymirror}"
root="${SHADOW_ROOT:-$production_root/cohorts/quality12-20260711}"
export SHADOW_CONFIG="${SHADOW_CONFIG:-$root/config.yaml}"
export SHADOW_DATA_DIR="${SHADOW_DATA_DIR:-$root/data}"
export SHADOW_REPORTS_DIR="${SHADOW_REPORTS_DIR:-$root/reports}"
export SHADOW_APPROVED_COHORT="${SHADOW_APPROVED_COHORT:-$root/approved-cohort.json}"
export SHADOW_INTAKE_MANIFEST="${SHADOW_INTAKE_MANIFEST:-$root/intake/manifest.json}"
export SHADOW_HEALTH_PORT="${SHADOW_HEALTH_PORT:-8081}"
export POLYMIRROR_ENV_FILE="${POLYMIRROR_ENV_FILE:-$production_root/.env}"
project="${SHADOW_PROJECT_NAME:-polymirror-v10-shadow}"
compose_file="${SHADOW_COMPOSE_FILE:-docker-compose.shadow.yml}"
shadow_started=0
deployment_committed=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$deployment_committed" -eq 0 ] && [ "$status" -eq 0 ]; then
    status=1
  fi
  if [ "$shadow_started" -eq 1 ] && [ "$deployment_committed" -eq 0 ]; then
    docker compose -p "$project" -f "$compose_file" stop \
      polymirror-shadow polymirror-shadow-collector >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "$1" >&2
  exit 1
}

canonical_path() {
  node --input-type=module -e '
    import { realpathSync } from "node:fs";
    process.stdout.write(realpathSync(process.argv[1]));
  ' "$1"
}

is_within() {
  child=$1
  parent=$2
  [ "$child" = "$parent" ] && return 0
  case "$child" in
    "$parent"/*) return 0 ;;
    *) return 1 ;;
  esac
}

paths_overlap() {
  first=$1
  second=$2
  is_within "$first" "$second" || is_within "$second" "$first"
}

prepare_shadow_directory() {
  target=$1
  if [ -e "$target" ]; then
    [ -d "$target" ] || fail "shadow writable path is not a directory"
    return
  fi
  target_parent="$(dirname "$target")"
  [ -d "$target_parent" ] || fail "shadow directory parent must already exist"
  target_parent_real="$(canonical_path "$target_parent")"
  is_within "$target_parent_real" "$root_real" \
    || fail "shadow path escapes isolated cohort root"
  mkdir "$target"
}

head_sha="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  fail "refusing shadow deployment from a changed checkout"
fi
if ! printf '%s\n' "$head_sha" | grep -Eq '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'; then
  fail "invalid Git SHA"
fi
export POLYMIRROR_GIT_SHA="$head_sha"

for required in \
  "$SHADOW_CONFIG" \
  "$SHADOW_APPROVED_COHORT" \
  "$SHADOW_INTAKE_MANIFEST" \
  "$POLYMIRROR_ENV_FILE"; do
  [ -f "$required" ] || fail "shadow config, intake evidence, or environment file missing"
done

root_real="$(canonical_path "$root")"
production_real="$(canonical_path "$production_root")"
cohorts_real="$(canonical_path "$production_root/cohorts")"
if [ "$root_real" = "$cohorts_real" ] || ! is_within "$root_real" "$cohorts_real"; then
  fail "shadow path escapes isolated cohort root"
fi

prepare_shadow_directory "$SHADOW_DATA_DIR"
prepare_shadow_directory "$SHADOW_REPORTS_DIR"
config_real="$(canonical_path "$SHADOW_CONFIG")"
data_real="$(canonical_path "$SHADOW_DATA_DIR")"
reports_real="$(canonical_path "$SHADOW_REPORTS_DIR")"
approved_real="$(canonical_path "$SHADOW_APPROVED_COHORT")"
manifest_real="$(canonical_path "$SHADOW_INTAKE_MANIFEST")"
for shadow_path in \
  "$config_real" "$data_real" "$reports_real" "$approved_real" "$manifest_real"; do
  is_within "$shadow_path" "$root_real" || fail "shadow path escapes isolated cohort root"
done
paths_overlap "$data_real" "$reports_real" \
  && fail "shadow data and reports paths overlap"

if [ -e "$production_real/data" ]; then
  production_data_real="$(canonical_path "$production_real/data")"
  paths_overlap "$data_real" "$production_data_real" \
    && fail "shadow path overlaps production data"
fi
if [ -e "$production_real/reports" ]; then
  production_reports_real="$(canonical_path "$production_real/reports")"
  paths_overlap "$reports_real" "$production_reports_real" \
    && fail "shadow path overlaps production reports"
fi
if [ -e "$production_real/config.yaml" ]; then
  production_config_real="$(canonical_path "$production_real/config.yaml")"
  [ "$config_real" = "$production_config_real" ] \
    && fail "shadow config overlaps production config"
fi

# Bind every approval to the immutable evidence file and its canonical cohort
# hash before the generated YAML is considered deployable.
SHADOW_APPROVED_COHORT="$approved_real" \
SHADOW_INTAKE_MANIFEST="$manifest_real" \
SHADOW_MAX_INTAKE_AGE_HOURS="${SHADOW_MAX_INTAKE_AGE_HOURS:-6}" \
node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { readFileSync, realpathSync } from "node:fs";

const approvedPath = process.env.SHADOW_APPROVED_COHORT;
const manifestPath = process.env.SHADOW_INTAKE_MANIFEST;
if (!approvedPath || !manifestPath) throw new Error("intake paths missing");
const approved = JSON.parse(readFileSync(approvedPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const maxAgeHours = Number(process.env.SHADOW_MAX_INTAKE_AGE_HOURS);
const capturedAt = Date.parse(manifest.capturedAt);
const ageMs = Date.now() - capturedAt;
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0
  || !Number.isFinite(capturedAt) || ageMs > maxAgeHours * 3_600_000
  || ageMs < -5 * 60_000) {
  throw new Error("intake evidence is stale or has an invalid capture time");
}
const expected = [
  ["ec47", "0xec47cb4e0a4f4e375d9787debf7c874214f21119"],
  ["dance", "0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82"],
  ["linabell", "0xf0ed9e68e6cd3ee712260abeaec32de56a7d47d8"],
  ["pada", "0x714a685b5454ea4d52979563bbafa77b8168ab2f"],
];
const normalized = (value) => Array.isArray(value)
  ? value.map(normalized)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, normalized(child)]))
    : value;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalHash = (value) => sha256(JSON.stringify(normalized(value)));

if (approved.cohortId !== "quality12-20260711-v1") {
  throw new Error("approved cohort ID mismatch");
}
if (manifest.seedCohortId !== approved.cohortId) {
  throw new Error("intake manifest cohort mismatch");
}
if (canonicalHash(approved) !== manifest.approvedCohortCanonicalSha256) {
  throw new Error("approvedCohortCanonicalSha256 mismatch");
}
if (!Array.isArray(approved.candidates) || approved.candidates.length !== expected.length) {
  throw new Error("approved cohort roster mismatch");
}
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== expected.length) {
  throw new Error("intake evidence roster mismatch");
}
const evidenceRoot = realpathSync(dirname(manifestPath));
let approvedCount = 0;
for (const [id, address] of expected) {
  const candidate = approved.candidates.find((row) => row.id === id);
  const artifact = manifest.artifacts.find((row) => row.candidateId === id);
  if (!candidate || String(candidate.address).toLowerCase() !== address) {
    throw new Error(`approved Candidate identity mismatch: ${id}`);
  }
  if (!artifact || String(artifact.address).toLowerCase() !== address) {
    throw new Error(`intake artifact identity mismatch: ${id}`);
  }
  const evidencePath = realpathSync(resolve(evidenceRoot, artifact.fileName));
  if (!evidencePath.startsWith(`${evidenceRoot}${sep}`)) {
    throw new Error(`intake artifact escaped evidence root: ${id}`);
  }
  const evidenceBytes = readFileSync(evidencePath);
  if (sha256(evidenceBytes) !== artifact.sha256) {
    throw new Error(`intake artifact checksum mismatch: ${id}`);
  }
  const evidence = JSON.parse(evidenceBytes.toString("utf8"));
  if (evidence.candidate?.id !== id
    || String(evidence.candidate?.address).toLowerCase() !== address
    || evidence.capturedAt !== manifest.capturedAt
    || Boolean(evidence.approved) !== Boolean(artifact.approved)) {
    throw new Error(`intake evidence payload mismatch: ${id}`);
  }
  if (candidate.freshIntakePassed === true) {
    approvedCount += 1;
    if (candidate.freshIntakeEvidenceSha256 !== artifact.sha256 || artifact.approved !== true) {
      throw new Error(`freshIntakeEvidenceSha256 mismatch: ${id}`);
    }
  } else if (candidate.freshIntakePassed !== false
    || candidate.freshIntakeEvidenceSha256 !== undefined
    || artifact.approved !== false) {
    throw new Error(`watchlist-only Candidate approval mismatch: ${id}`);
  }
}
if (approvedCount === 0) throw new Error("no approved Candidate in intake evidence");
console.log(`validated ${approvedCount} approved Candidate(s)`);
NODE

capacity_fields="$(node --input-type=module -e '
  import { statfsSync } from "node:fs";
  const dataStats = statfsSync(process.argv[1], { bigint: true });
  const reportsStats = statfsSync(process.argv[2], { bigint: true });
  const availableBytes = Math.min(
    Number(dataStats.bavail * dataStats.bsize),
    Number(reportsStats.bavail * reportsStats.bsize)
  );
  const growthBytesPerHour = Number(process.argv[3]);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new Error("invalid available capacity");
  }
  if (!Number.isFinite(growthBytesPerHour)) throw new Error("invalid expected growth");
  const GiB = 1024 ** 3;
  const projectedDays = growthBytesPerHour > 0
    ? availableBytes / growthBytesPerHour / 24
    : null;
  let status = "OK";
  if (availableBytes < 10 * GiB || (projectedDays !== null && projectedDays < 3)) {
    status = "SETTLE_ONLY";
  } else if (availableBytes < 20 * GiB || (projectedDays !== null && projectedDays < 7)) {
    status = "WARNING";
  }
  process.stdout.write(`${status} ${availableBytes} ${projectedDays ?? "null"}`);
' "$data_real" "$reports_real" "${SHADOW_EXPECTED_GROWTH_BYTES_PER_HOUR:-0}")"
set -- $capacity_fields
capacity_status=$1
capacity_available=$2
capacity_days=$3
if [ "$capacity_status" = "SETTLE_ONLY" ]; then
  fail "shadow capacity preflight refused: availableBytes=$capacity_available projectedDays=$capacity_days"
fi
if [ "$capacity_status" = "WARNING" ]; then
  echo "shadow capacity warning: availableBytes=$capacity_available projectedDays=$capacity_days" >&2
fi

image="polymirror:$POLYMIRROR_GIT_SHA"
image_revision="$(docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
if [ "$image_revision" != "$head_sha" ]; then
  fail "image revision does not match HEAD"
fi
export POLYMIRROR_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "$image")"
if ! printf '%s\n' "$POLYMIRROR_IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-fA-F]{64}$'; then
  fail "shadow image does not expose an immutable sha256 image ID"
fi

# Validate the exact mounted document through the built application. This also
# proves that the generated YAML enables exactly the Candidates approved above.
docker run --rm \
  --env-file "$POLYMIRROR_ENV_FILE" \
  -v "$SHADOW_CONFIG:/app/config.yaml:ro" \
  -v "$SHADOW_APPROVED_COHORT:/app/approved-cohort.json:ro" \
  "$image" \
  node --input-type=module -e '
    const { readFileSync } = await import("node:fs");
    const { loadMultiAccountConfig } = await import("./dist/config/load.js");
    const loaded = loadMultiAccountConfig("/app/config.yaml");
    const approved = JSON.parse(readFileSync("/app/approved-cohort.json", "utf8"));
    const addresses = new Map(approved.candidates.map((row) => [row.id, {
      address: String(row.address).toLowerCase(),
      approved: row.freshIntakePassed === true,
    }]));
    const arms = new Map([
      ["conservative", { fixed: 1, position: 10, volume: 40, markets: 10, loss: 5, slip: 0.015, min: 0.1, max: 0.7 }],
      ["standard", { fixed: 2, position: 20, volume: 80, markets: 15, loss: 8, slip: 0.025, min: 0.05, max: 0.8 }],
      ["aggressive", { fixed: 5, position: 40, volume: 160, markets: 20, loss: 10, slip: 0.04, min: 0.02, max: 0.9 }],
    ]);
    if (loaded.accounts.length !== 12) throw new Error("quality12 requires exactly 12 accounts");
    let copyEnabled = 0;
    const expectedIds = new Set();
    for (const [candidateId, candidate] of addresses) {
      for (const [armName, arm] of arms) {
        const id = `exp_quality12-20260711-v1_${candidateId}_${armName}_200`;
        expectedIds.add(id);
        const account = loaded.accounts.find((row) => row.id === id);
        if (!account || account.enabled !== true) throw new Error(`missing enabled account: ${id}`);
        const g = account.config.app.global;
        const leader = account.config.app.leaders[0];
        if (!g.previewMode) throw new Error(`live account rejected: ${id}`);
        if (g.copyPriceMode !== "executable_guarded") throw new Error(`unguarded account rejected: ${id}`);
        if (g.execution.orderType !== "FOK") throw new Error(`non-FOK account rejected: ${id}`);
        if (g.risk.startingCapitalUsd !== 200) throw new Error(`non-200U account rejected: ${id}`);
        if (g.risk.enableCopyTrading !== candidate.approved
          || leader?.enabled !== candidate.approved) {
          throw new Error(`approval/copy mismatch: ${id}`);
        }
        if (leader?.id !== candidateId || leader?.address?.toLowerCase() !== candidate.address) {
          throw new Error(`leader identity mismatch: ${id}`);
        }
        if (leader.strategy.type !== "FIXED" || leader.strategy.copySize !== arm.fixed
          || leader.limits?.maxOrderUsd !== arm.fixed
          || leader.limits?.maxPositionUsd !== arm.position
          || leader.limits?.maxDailyVolumeUsd !== arm.volume
          || leader.filters?.minPrice !== arm.min
          || leader.filters?.maxPrice !== arm.max
          || JSON.stringify(leader.filters?.sides) !== JSON.stringify(["BUY", "SELL"])
          || g.risk.maxOrderUsd !== arm.fixed
          || g.risk.maxPositionPerTokenUsd !== arm.position
          || g.risk.maxDailyVolumeUsd !== arm.volume
          || g.risk.maxOpenMarkets !== arm.markets
          || g.risk.dailyLossCapPct !== arm.loss
          || g.risk.slippageTolerance !== arm.slip
          || g.risk.positionCapBasis !== "cost"
          || g.risk.syncWalletBalance !== false) {
          throw new Error(`quality12 arm mismatch: ${id}`);
        }
        if (candidate.approved) copyEnabled += 1;
      }
    }
    if (loaded.accounts.some((account) => !expectedIds.has(account.id))) {
      throw new Error("unexpected account in quality12 config");
    }
    if (copyEnabled === 0) throw new Error("no approved Candidate is copy-enabled");
    console.log(`validated ${loaded.accounts.length} preview accounts; ${copyEnabled} copy-enabled arms`);
  '

docker compose -p "$project" -f "$compose_file" config >/dev/null
existing_running="$(docker compose -p "$project" -f "$compose_file" \
  ps --status running -q 2>/dev/null || true)"
[ -z "$existing_running" ] \
  || fail "refusing to replace a running shadow cohort"
validated_digest="$POLYMIRROR_IMAGE_DIGEST"
current_digest="$(docker image inspect --format '{{.Id}}' "$image")"
[ "$current_digest" = "$validated_digest" ] \
  || fail "image tag changed after validation"

shadow_started=1
docker compose -p "$project" -f "$compose_file" up -d --no-build \
  polymirror-shadow polymirror-shadow-collector

attempt=0
main_ready=0
collector_ready=0
while [ "$attempt" -lt 60 ]; do
  running_services="$(docker compose -p "$project" -f "$compose_file" \
    ps --status running --services 2>/dev/null || true)"
  main_running=0
  collector_running=0
  printf '%s\n' "$running_services" | grep -qx 'polymirror-shadow' && main_running=1
  printf '%s\n' "$running_services" | grep -qx 'polymirror-shadow-collector' \
    && collector_running=1

  if [ "$main_running" -eq 1 ]; then
    main_id="$(docker compose -p "$project" -f "$compose_file" ps -q polymirror-shadow)"
    running_image="$(docker inspect --format '{{.Image}}' "$main_id")"
    [ "$running_image" = "$validated_digest" ] \
      || fail "container image does not match validated image"
    if health="$(curl -fsS "http://127.0.0.1:$SHADOW_HEALTH_PORT/health" 2>/dev/null)"; then
      if printf '%s' "$health" | node --input-type=module -e '
        let payload = "";
        for await (const chunk of process.stdin) payload += chunk;
        const health = JSON.parse(payload);
        if (health.status !== "ok" || health.previewMode !== true
          || !Number.isFinite(health.lastPollAt) || health.lastError !== null
          || health.pendingOrders !== 0
          || health.settlementFailures !== 0 || health.closedMarketOpenPositions !== 0
          || !Array.isArray(health.walletDrifts) || health.walletDrifts.length !== 0
          || health.enabledAccountCount !== 12 || health.polledAccountCount !== 12
          || !Array.isArray(health.experiments) || health.experiments.length !== 12) {
          process.exit(1);
        }
      '; then
        main_ready=1
      fi
    fi
  fi

  if [ "$collector_running" -eq 1 ]; then
    collector_id="$(docker compose -p "$project" -f "$compose_file" \
      ps -q polymirror-shadow-collector)"
    collector_image="$(docker inspect --format '{{.Image}}' "$collector_id")"
    [ "$collector_image" = "$validated_digest" ] \
      || fail "container image does not match validated image"
    collector_logs="$(docker compose -p "$project" -f "$compose_file" \
      logs --no-color --tail 200 polymirror-shadow-collector 2>/dev/null || true)"
    if printf '%s' "$collector_logs" | grep -q '"accountCount":12'; then
      collector_ready=1
    fi
  fi

  if [ "$main_ready" -eq 1 ] && [ "$collector_ready" -eq 1 ]; then
    deployment_committed=1
    echo "shadow preview cohort and first collector report healthy on 127.0.0.1:$SHADOW_HEALTH_PORT"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if [ "$collector_ready" -ne 1 ]; then
  echo "shadow collector first report did not succeed" >&2
fi
fail "shadow health gate failed; rollback armed and data preserved"
