import { describe, expect, it } from "vitest";
import { shardCandidateCohort } from "../src/experiments/cohort-sharding.js";

const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;

describe("shardCandidateCohort", () => {
  it("splits a large frozen universe into valid ten-candidate shards", () => {
    const shards = shardCandidateCohort({
      cohortId: "mass-official-20260824",
      candidates: Array.from({ length: 23 }, (_, index) => ({
        id: `candidate_${index + 1}`,
        address: address(index + 1),
        freshIntakePassed: false,
        simulationOnlyEnabled: true,
      })),
    });

    expect(shards.map((shard) => shard.cohort.candidates.length)).toEqual([10, 10, 3]);
    expect(new Set(shards.map((shard) => shard.cohort.cohortId)).size).toBe(3);
    expect(shards.every((shard) => /^[a-f0-9]{64}$/.test(shard.canonicalSha256))).toBe(true);
  });

  it("rejects duplicate identities before any shard is produced", () => {
    expect(() => shardCandidateCohort({
      cohortId: "mass",
      candidates: [
        { id: "same", address: address(1), freshIntakePassed: false },
        { id: "same", address: address(2), freshIntakePassed: false },
      ],
    })).toThrow(/duplicate candidate id/);
  });
});
