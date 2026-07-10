import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalRedactedConfig, configSha256 } from "../src/experiments/manifest.js";
import { provenanceTrustClass, readRuntimeProvenance } from "../src/experiments/provenance.js";
import { execFileSync } from "node:child_process";
import { StateStore } from "../src/state/store.js";
import { previewRuntimeConfig } from "./helpers/fixtures.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("experiment manifest", () => {
  it("captures checkout and lockfile provenance when build metadata is not injected", () => {
    const previousGitSha = process.env.POLYMIRROR_GIT_SHA;
    const previousImageDigest = process.env.POLYMIRROR_IMAGE_DIGEST;
    delete process.env.POLYMIRROR_GIT_SHA;
    delete process.env.POLYMIRROR_IMAGE_DIGEST;
    try {
      const provenance = readRuntimeProvenance();
      expect(provenance.gitSha).toBe(
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
      );
      expect(provenance.lockfileHash).toMatch(/^[a-f0-9]{64}$/);
      expect(provenance.imageDigest).toBe("unknown");
      expect(provenanceTrustClass("candidate", provenance)).toBe("partial");
    } finally {
      if (previousGitSha === undefined) delete process.env.POLYMIRROR_GIT_SHA;
      else process.env.POLYMIRROR_GIT_SHA = previousGitSha;
      if (previousImageDigest === undefined) delete process.env.POLYMIRROR_IMAGE_DIGEST;
      else process.env.POLYMIRROR_IMAGE_DIGEST = previousImageDigest;
    }
  });

  it("canonicalizes decision config while redacting secrets", () => {
    const first = previewRuntimeConfig();
    first.wallet.privateKey = "secret-a";
    first.wallet.apiSecret = "api-secret-a";
    first.wallet.apiPassphrase = "pass-a";
    const second = structuredClone(first);
    second.wallet.privateKey = "secret-b";
    second.wallet.apiSecret = "api-secret-b";
    second.wallet.apiPassphrase = "pass-b";

    const canonical = canonicalRedactedConfig(first);
    expect(canonical).not.toContain("secret-a");
    expect(canonical).not.toContain("api-secret-a");
    expect(canonical).not.toContain("pass-a");
    expect(configSha256(first)).toBe(configSha256(second));
    expect(canonical).toBe(canonicalRedactedConfig(JSON.parse(JSON.stringify(first))));
  });

  it("ignores operational settings but hashes every decision and execution input", () => {
    const base = previewRuntimeConfig();
    const operational = structuredClone(base);
    operational.app.global.pollIntervalMs += 1000;
    operational.app.global.healthPort += 1;
    operational.app.global.notify.telegramOnCopy = !operational.app.global.notify.telegramOnCopy;
    operational.app.global.proxy = {
      mode: "static",
      staticUrl: "http://operational-only",
      dynamicUrl: "",
      dynamicRotateSession: false,
    };
    expect(configSha256(operational)).toBe(configSha256(base));

    const decision = structuredClone(base);
    decision.app.global.execution.orderType = "FOK";
    expect(configSha256(decision)).not.toBe(configSha256(base));
  });

  it("redacts unknown credential-like keys fail closed without hiding ordinary fields", () => {
    const config = previewRuntimeConfig() as unknown as Record<string, unknown>;
    config.futureCredentialToken = "do-not-leak";
    config.marketTokenId = "public-token-id";
    (config.wallet as Record<string, unknown>).relayerApiKeyAddress = "public-relayer-address";
    const canonical = canonicalRedactedConfig(config as never);
    expect(canonical).not.toContain("do-not-leak");
    expect(canonical).toContain("public-token-id");
    expect(canonical).toContain("public-relayer-address");
  });

  it("resumes the same immutable row and rotates only for a changed config hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-experiment-"));
    dirs.push(dir);
    const store = new StateStore(join(dir, "preview.db"));
    const config = previewRuntimeConfig();
    const metadata = {
      accountId: "candidate-a",
      candidateAddresses: config.app.leaders.map((leader) => leader.address!),
      config,
      gitSha: "git-a",
      imageDigest: "sha256:image-a",
      lockfileHash: "lock-a",
      trustClass: "candidate" as const,
    };

    const first = store.startOrResumeExperiment(metadata, 1000);
    const resumed = store.startOrResumeExperiment(metadata, 2000);
    expect(resumed.experimentId).toBe(first.experimentId);
    expect(store.listExperiments()).toHaveLength(1);
    expect(store.listExperiments()[0]).toMatchObject({ startedAt: 1000, endedAt: null });

    const changed = structuredClone(config);
    changed.app.global.risk.maxOrderUsd += 1;
    const rotated = store.startOrResumeExperiment({ ...metadata, config: changed }, 3000);
    expect(rotated.experimentId).not.toBe(first.experimentId);
    const rows = store.listExperiments();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ startedAt: 1000, endedAt: 3000 });
    expect(rows[1]).toMatchObject({ startedAt: 3000, endedAt: null });
    store.close();
  });

  it("rotates when candidates or immutable build provenance changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-experiment-identity-"));
    dirs.push(dir);
    const store = new StateStore(join(dir, "preview.db"));
    const config = previewRuntimeConfig();
    const base = {
      accountId: "candidate-a",
      candidateAddresses: ["0xaaa"],
      config,
      gitSha: "git-a",
      imageDigest: "image-a",
      lockfileHash: "lock-a",
      trustClass: "verified" as const,
    };
    const first = store.startOrResumeExperiment(base, 1000);
    const second = store.startOrResumeExperiment({ ...base, candidateAddresses: ["0xbbb"] }, 2000);
    const third = store.startOrResumeExperiment({ ...base, candidateAddresses: ["0xbbb"], gitSha: "git-b" }, 3000);
    expect(new Set([first.experimentId, second.experimentId, third.experimentId]).size).toBe(3);
    expect(store.listExperiments().slice(0, 2).every((row) => row.endedAt !== null)).toBe(true);
    store.close();
  });
});
