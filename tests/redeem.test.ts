import { beforeEach, describe, expect, it, vi } from "vitest";
import { isBenignRedeemError } from "../src/executor/redeem.js";

describe("isBenignRedeemError", () => {
  it("treats already-redeemed or empty redeem errors as benign", () => {
    expect(isBenignRedeemError("Position already redeemed")).toBe(true);
    expect(isBenignRedeemError("nothing to redeem")).toBe(true);
    expect(isBenignRedeemError("no positions to redeem")).toBe(true);
  });

  it("keeps auth, balance, and generic revert failures non-benign", () => {
    expect(isBenignRedeemError("execution reverted")).toBe(false);
    expect(isBenignRedeemError("invalid authorization")).toBe(false);
    expect(isBenignRedeemError("insufficient balance")).toBe(false);
  });
});

describe("redeemConditionOnChain", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the transaction hash after SecureClient redeem succeeds", async () => {
    vi.doMock("../src/executor/secure-client.js", () => ({
      getSecureClient: vi.fn(async () => ({
        redeemPositions: vi.fn(async () => ({
          wait: vi.fn(async () => ({ transactionHash: "0xredeemtx" })),
        })),
      })),
    }));

    const { redeemConditionOnChain } = await import("../src/executor/redeem.js");
    const result = await redeemConditionOnChain(
      {
        privateKey: "0x" + "1".repeat(64),
        proxyAddress: "0x" + "2".repeat(40),
        signatureType: 0,
        chainId: 137,
        clobUrl: "https://clob.polymarket.com",
        dataApiUrl: "https://data-api.polymarket.com",
        tradingBackend: "secure",
      },
      "0xcondition"
    );

    expect(result).toMatchObject({
      ok: true,
      conditionId: "0xcondition",
      txHash: "0xredeemtx",
    });
  });
});
