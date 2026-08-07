import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  upsertEnvFile,
  walletEnvKeys,
  walletEnvSuffix,
  walletEnvSuffixesCollide,
} from "../src/config/env-file.js";

describe("walletEnvSuffix", () => {
  it("collapses default variants to empty suffix", () => {
    expect(walletEnvSuffix("default")).toBe("");
    expect(walletEnvSuffix("Default")).toBe("");
    expect(walletEnvSuffix("DEFAULT")).toBe("");
  });

  it("normalizes punctuation so acc-1 and acc_1 collide", () => {
    expect(walletEnvSuffix("acc-1")).toBe("ACC_1");
    expect(walletEnvSuffix("acc_1")).toBe("ACC_1");
    expect(walletEnvSuffixesCollide("acc-1", "acc_1")).toBe(true);
    expect(walletEnvSuffixesCollide("default", "Default")).toBe(true);
    expect(walletEnvSuffixesCollide("alpha", "beta")).toBe(false);
  });
});

describe("walletEnvKeys signatureType", () => {
  it("clears signature type env when rotating to EOA (0)", () => {
    const keys = walletEnvKeys("MAIN", {
      privateKey: "0xabc",
      address: "0x" + "1".repeat(40),
      signatureType: 0,
    });
    expect(keys.POLYMARKET_SIGNATURE_TYPE_MAIN).toBeNull();
  });

  it("writes signature type when proxy (1)", () => {
    const keys = walletEnvKeys("", {
      privateKey: "0xabc",
      address: "0x" + "1".repeat(40),
      signatureType: 1,
    });
    expect(keys.POLYMARKET_SIGNATURE_TYPE).toBe("1");
  });
});

describe("upsertEnvFile null deletes key", () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-env-"));
    envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "POLYMARKET_PRIVATE_KEY=0xold\nPOLYMARKET_SIGNATURE_TYPE=1\n",
      "utf8"
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes keys set to null", () => {
    upsertEnvFile(
      {
        POLYMARKET_PRIVATE_KEY: "0xnew",
        POLYMARKET_SIGNATURE_TYPE: null,
      },
      envPath
    );
    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("POLYMARKET_PRIVATE_KEY=0xnew");
    expect(text).not.toContain("POLYMARKET_SIGNATURE_TYPE");
  });
});
