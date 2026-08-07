import { describe, expect, it } from "vitest";

/** Mirrors dashboard/src/utils/leaderId.ts parseFollowTarget for daemon-side coverage. */
function parseFollowTarget(raw: string):
  | { mode: "address"; address: string }
  | { mode: "username"; username: string }
  | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
    return { mode: "address", address: value };
  }
  if (/^0x/i.test(value)) return null;
  const username = value.replace(/^@/, "").trim();
  if (!username || /\s/.test(username)) return null;
  return { mode: "username", username };
}

describe("parseFollowTarget", () => {
  it("accepts proxy addresses", () => {
    const address = "0x" + "AbCd".repeat(10);
    expect(parseFollowTarget(`  ${address}  `)).toEqual({ mode: "address", address });
  });

  it("accepts usernames with optional @", () => {
    expect(parseFollowTarget("@whale_1")).toEqual({ mode: "username", username: "whale_1" });
    expect(parseFollowTarget("whale_1")).toEqual({ mode: "username", username: "whale_1" });
  });

  it("rejects invalid input", () => {
    expect(parseFollowTarget("")).toBeNull();
    expect(parseFollowTarget("0x1234")).toBeNull();
    expect(parseFollowTarget("cool whale")).toBeNull();
  });
});
