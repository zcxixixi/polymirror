import { describe, it, expect } from "vitest";
import {
  leaderWriteSchema,
  leaderWriteToYaml,
  mergeLeaderWrite,
} from "../src/config/leader-schema.js";

describe("leader rate_limit write", () => {
  it("serializes rateLimit to YAML keys", () => {
    const input = leaderWriteSchema.parse({
      id: "hft",
      mode: "address",
      address: "0x0000000000000000000000000000000000000001",
      enabled: true,
      weight: 1,
      strategy: { type: "PERCENTAGE", copySize: 5 },
      rateLimit: {
        tradeAggregationWindowMs: 5000,
        minCopyIntervalMs: 30000,
        maxCopiesPerWindow: 5,
      },
    });
    const row = leaderWriteToYaml(input);
    expect(row.rate_limit).toEqual({
      trade_aggregation_window_ms: 5000,
      min_copy_interval_ms: 30000,
      max_copies_per_window: 5,
    });
  });

  it("clears rate_limit on merge when null", () => {
    const existing = {
      id: "hft",
      address: "0x0000000000000000000000000000000000000001",
      enabled: true,
      weight: 1,
      strategy: { type: "PERCENTAGE", copy_size: 5 },
      rate_limit: { min_copy_interval_ms: 30000 },
    };
    const merged = mergeLeaderWrite(existing, {
      id: "hft",
      address: "0x0000000000000000000000000000000000000001",
      enabled: true,
      weight: 1,
      strategy: { type: "PERCENTAGE", copy_size: 5 },
      rate_limit: null,
    });
    expect(merged.rate_limit).toBeUndefined();
  });
});
