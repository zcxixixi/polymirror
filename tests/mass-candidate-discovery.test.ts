import { describe, expect, it } from "vitest";
import { rankMassCandidates } from "../src/experiments/mass-candidate-discovery.js";

const wallet = (number: number) => `0x${number.toString(16).padStart(40, "0")}`;

describe("rankMassCandidates", () => {
  it("prefers wallets repeated across independent leaderboard slices", () => {
    const ranked = rankMassCandidates([
      { category: "SPORTS", timePeriod: "DAY", rank: 10, address: wallet(1), username: "repeat", pnlUsd: 10, volumeUsd: 100 },
      { category: "SPORTS", timePeriod: "WEEK", rank: 20, address: wallet(1), username: "repeat", pnlUsd: 20, volumeUsd: 200 },
      { category: "CRYPTO", timePeriod: "DAY", rank: 1, address: wallet(2), username: "single", pnlUsd: 1000, volumeUsd: 5000 },
    ]);
    expect(ranked[0]).toMatchObject({ address: wallet(1), appearances: 2 });
    expect(ranked[1]).toMatchObject({ address: wallet(2), appearances: 1 });
  });

  it("deduplicates usernames and excludes frozen addresses", () => {
    const ranked = rankMassCandidates([
      { category: "OVERALL", timePeriod: "DAY", rank: 1, address: wallet(1), username: "same name", pnlUsd: 1, volumeUsd: 1 },
      { category: "OVERALL", timePeriod: "DAY", rank: 2, address: wallet(2), username: "same name", pnlUsd: 1, volumeUsd: 1 },
    ], { excludeAddresses: [wallet(1)] });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.id).toBe("same_name");
    expect(ranked[0]?.address).toBe(wallet(2));
  });
});
