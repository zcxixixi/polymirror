import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRuntimeProvenance } from "../src/experiments/provenance.js";

describe("Candidate deployment provenance", () => {
  it("rejects malformed injected Git SHAs and image digests", () => {
    const oldGitSha = process.env.POLYMIRROR_GIT_SHA;
    const oldImageDigest = process.env.POLYMIRROR_IMAGE_DIGEST;
    process.env.POLYMIRROR_GIT_SHA = "branch-main";
    process.env.POLYMIRROR_IMAGE_DIGEST = "latest";
    try {
      expect(() => readRuntimeProvenance()).toThrow(/POLYMIRROR_GIT_SHA/i);
    } finally {
      if (oldGitSha === undefined) delete process.env.POLYMIRROR_GIT_SHA;
      else process.env.POLYMIRROR_GIT_SHA = oldGitSha;
      if (oldImageDigest === undefined) delete process.env.POLYMIRROR_IMAGE_DIGEST;
      else process.env.POLYMIRROR_IMAGE_DIGEST = oldImageDigest;
    }
  });

  it("rejects a malformed image digest even with a valid Git SHA", () => {
    const oldGitSha = process.env.POLYMIRROR_GIT_SHA;
    const oldImageDigest = process.env.POLYMIRROR_IMAGE_DIGEST;
    process.env.POLYMIRROR_GIT_SHA = "a".repeat(40);
    process.env.POLYMIRROR_IMAGE_DIGEST = "sha256:not-a-digest";
    try {
      expect(() => readRuntimeProvenance()).toThrow(/POLYMIRROR_IMAGE_DIGEST/i);
    } finally {
      if (oldGitSha === undefined) delete process.env.POLYMIRROR_GIT_SHA;
      else process.env.POLYMIRROR_GIT_SHA = oldGitSha;
      if (oldImageDigest === undefined) delete process.env.POLYMIRROR_IMAGE_DIGEST;
      else process.env.POLYMIRROR_IMAGE_DIGEST = oldImageDigest;
    }
  });

  it("accepts canonical immutable injected identifiers", () => {
    const oldGitSha = process.env.POLYMIRROR_GIT_SHA;
    const oldImageDigest = process.env.POLYMIRROR_IMAGE_DIGEST;
    process.env.POLYMIRROR_GIT_SHA = "a".repeat(40);
    process.env.POLYMIRROR_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
    try {
      expect(readRuntimeProvenance()).toMatchObject({
        gitSha: "a".repeat(40),
        imageDigest: `sha256:${"b".repeat(64)}`,
      });
    } finally {
      if (oldGitSha === undefined) delete process.env.POLYMIRROR_GIT_SHA;
      else process.env.POLYMIRROR_GIT_SHA = oldGitSha;
      if (oldImageDigest === undefined) delete process.env.POLYMIRROR_IMAGE_DIGEST;
      else process.env.POLYMIRROR_IMAGE_DIGEST = oldImageDigest;
    }
  });

  it("builds source and dashboard from pinned lockfiles in a multi-stage image", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(/FROM node:24-bookworm-slim AS builder/);
    expect(dockerfile).toContain("COPY package.json package-lock.json ./");
    expect(dockerfile).toContain("COPY dashboard/package.json dashboard/package-lock.json ./dashboard/");
    expect(dockerfile).toMatch(/npm ci\b/);
    expect(dockerfile).toMatch(/npm ci --prefix dashboard\b/);
    expect(dockerfile).toContain("npm run build");
    expect(dockerfile).toContain("COPY --from=builder /app/dist ./dist");
    expect(dockerfile).not.toMatch(/^COPY dist /m);
    expect(dockerfile).toContain("ARG POLYMIRROR_GIT_SHA");
    expect(dockerfile).toContain("org.opencontainers.image.revision=$POLYMIRROR_GIT_SHA");
  });

  it("copies the root postinstall patch before every root npm ci", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const stages = dockerfile.split(/(?=^FROM )/m).filter((stage) => stage.startsWith("FROM "));
    expect(stages).toHaveLength(2);
    for (const stage of stages) {
      const rootInstall = stage.search(/^RUN npm ci(?:\s|\\)/m);
      expect(rootInstall).toBeGreaterThan(-1);
      const patchCopy = stage.indexOf("COPY scripts ./scripts");
      expect(patchCopy).toBeGreaterThan(-1);
      expect(patchCopy).toBeLessThan(rootInstall);
    }
  });

  it("copies every dashboard repository-relative raw dependency before build", () => {
    const sourcePath = "dashboard/src/pages/Docs.tsx";
    const source = readFileSync(sourcePath, "utf8");
    const imports = [...source.matchAll(/from\s+["'](\.\.\/\.\.\/\.\.\/[^"']+\?raw)["']/g)]
      .map((match) => match[1]!.replace(/\?raw$/, ""));
    expect(imports.length).toBeGreaterThan(0);
    for (const imported of imports) {
      expect(existsSync(resolve(dirname(sourcePath), imported))).toBe(true);
    }

    const builder = readFileSync("Dockerfile", "utf8").split(/^FROM .* AS runner$/m)[0]!;
    const docsCopy = builder.indexOf("COPY docs ./docs");
    const build = builder.indexOf("RUN npm run build");
    expect(docsCopy).toBeGreaterThan(-1);
    expect(docsCopy).toBeLessThan(build);
  });

  it("requires Candidate provenance in Compose and provides a fail-closed deployment script", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    expect(compose).toContain("POLYMIRROR_GIT_SHA: ${POLYMIRROR_GIT_SHA:?POLYMIRROR_GIT_SHA is required}");
    expect(compose).toContain("POLYMIRROR_GIT_SHA=${POLYMIRROR_GIT_SHA:?POLYMIRROR_GIT_SHA is required}");
    expect(compose).toContain("POLYMIRROR_IMAGE_DIGEST=${POLYMIRROR_IMAGE_DIGEST:?POLYMIRROR_IMAGE_DIGEST is required}");

    const deploy = readFileSync("scripts/deploy-candidate-preview.sh", "utf8");
    expect(deploy).toContain("git rev-parse HEAD");
    expect(deploy).toMatch(/mktemp -d/);
    expect(deploy).toMatch(/trap .*EXIT/);
    expect(deploy).toMatch(/git archive/);
    expect(deploy).toMatch(/docker build/);
    expect(deploy).not.toMatch(/docker compose build/);
    expect(deploy).toMatch(/git status --porcelain/);
    expect(deploy).toMatch(/git rev-parse HEAD/);
    expect(deploy).toMatch(/docker image inspect/);
    expect(deploy).toMatch(/docker compose config/);
    expect(deploy).toMatch(/docker compose up -d --no-build/);
  });

  it("keeps the shadow cohort isolated, preview-validated, and rollback-safe", () => {
    const compose = readFileSync("docker-compose.shadow.yml", "utf8");
    expect(compose).toContain("127.0.0.1:${SHADOW_HEALTH_PORT:-8081}:8080");
    expect(compose).toContain("${SHADOW_CONFIG:?SHADOW_CONFIG is required}:/app/config.yaml:ro");
    expect(compose).toContain("${SHADOW_DATA_DIR:?SHADOW_DATA_DIR is required}:/app/data");
    expect(compose).not.toContain("./data:/app/data");
    expect(compose).not.toContain("/app/.env");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("polymirror-shadow-collector:");
    expect(compose).toContain("REPORT_COLLECT_INTERVAL_MINUTES=60");
    expect(compose).toContain("REPORT_WINDOW_MINUTES=1440");
    expect(compose).toContain("/app/data:ro");
    expect(compose).toMatch(/depends_on:\s+polymirror-shadow:\s+condition: service_healthy/s);
    expect(compose).toMatch(/polymirror-shadow:[\s\S]*healthcheck:[\s\S]*lastPollAt/);
    expect(compose).toMatch(/polymirror-shadow:[\s\S]*healthcheck:[\s\S]*status !== "ok"/);
    expect(compose).toMatch(/polymirror-shadow-collector:[\s\S]*healthcheck:\s+disable: true/);
    expect(compose).toContain('cpus: "${SHADOW_CPUS:-1.0}"');
    expect(compose).toContain('mem_limit: "${SHADOW_MEMORY_LIMIT:-1024m}"');
    expect(compose).toContain('cpus: "${SHADOW_COLLECTOR_CPUS:-0.5}"');
    expect(compose).toContain('mem_limit: "${SHADOW_COLLECTOR_MEMORY_LIMIT:-512m}"');
    expect(compose.match(/pids_limit:/g)).toHaveLength(2);

    const deploy = readFileSync("scripts/deploy-shadow-preview.sh", "utf8");
    expect(deploy).toContain("polymirror-v10-shadow");
    expect(deploy).toContain("g.previewMode");
    expect(deploy).toContain('g.copyPriceMode !== "executable_guarded"');
    expect(deploy).toContain('g.execution.orderType !== "FOK"');
    expect(deploy).toContain("g.risk.startingCapitalUsd !== 200");
    expect(deploy).toMatch(/docker compose .* up -d --no-build/s);
    expect(deploy).toMatch(/docker compose .* stop/s);
    expect(deploy).not.toMatch(/docker compose .* down -v/);
    expect(deploy).toContain("POLYMIRROR_PRODUCTION_ROOT");
    expect(deploy).toContain("realpathSync");
    expect(deploy).toContain("prepare_shadow_directory");
    expect(deploy).not.toContain('mkdir -p "$SHADOW_DATA_DIR"');
    expect(deploy).toContain("shadow path escapes isolated cohort root");
    expect(deploy).toContain("shadow path overlaps production data");
    expect(deploy).toContain("shadow path overlaps production reports");
    expect(deploy).toContain("shadow config overlaps production config");
    expect(deploy).toContain("trap cleanup EXIT HUP INT TERM");
    expect(deploy).toContain("deployment_committed=0");
    expect(deploy).toContain("deployment_committed=1");
    expect(deploy.indexOf("trap cleanup EXIT HUP INT TERM"))
      .toBeLessThan(deploy.indexOf('up -d --no-build'));
    expect(deploy).toContain("SHADOW_APPROVED_COHORT");
    expect(deploy).toContain("SHADOW_INTAKE_MANIFEST");
    expect(deploy).toContain("approvedCohortCanonicalSha256");
    expect(deploy).toContain("freshIntakeEvidenceSha256");
    expect(deploy).toContain("SHADOW_MAX_INTAKE_AGE_HOURS");
    expect(deploy).toContain("intake evidence is stale");
    expect(deploy).toContain("quality12-20260711-v1");
    expect(deploy).toContain("0xec47cb4e0a4f4e375d9787debf7c874214f21119");
    expect(deploy).toContain("0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82");
    expect(deploy).toContain("0xf0ed9e68e6cd3ee712260abeaec32de56a7d47d8");
    expect(deploy).toContain("0x714a685b5454ea4d52979563bbafa77b8168ab2f");
    expect(deploy).toContain("loaded.accounts.length !== 12");
    expect(deploy).toContain("no approved Candidate is copy-enabled");
    expect(deploy).toContain("org.opencontainers.image.revision");
    expect(deploy).toContain("image revision does not match HEAD");
    expect(deploy).toContain("container image does not match validated image");
    expect(deploy).toContain("statfsSync");
    expect(deploy).toMatch(/statfsSync\(process\.argv\[1\][\s\S]*statfsSync\(process\.argv\[2\]/);
    expect(deploy).toContain('"$data_real" "$reports_real" "${SHADOW_EXPECTED_GROWTH_BYTES_PER_HOUR:-0}"');
    expect(deploy).toContain("shadow capacity preflight refused");
    expect(deploy).toContain("shadow capacity warning");
    expect(deploy).toContain('ps --status running --services');
    expect(deploy).toContain("refusing to replace a running shadow cohort");
    expect(deploy).toContain('health.status !== "ok"');
    expect(deploy).toContain("Number.isFinite(health.lastPollAt)");
    expect(deploy).toContain("health.lastError !== null");
    expect(deploy).toContain("health.pendingOrders !== 0");
    expect(deploy).toContain("health.settlementFailures !== 0");
    expect(deploy).toContain("health.closedMarketOpenPositions !== 0");
    expect(deploy).toContain("health.walletDrifts.length !== 0");
    expect(deploy).toContain("health.enabledAccountCount !== 12");
    expect(deploy).toContain("health.polledAccountCount !== 12");
    expect(deploy).toContain('logs --no-color --tail 200');
    expect(deploy).toContain('"accountCount":12');
    expect(deploy).toContain("shadow collector first report did not succeed");
  });
});
