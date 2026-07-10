import { readFileSync } from "node:fs";
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
});
