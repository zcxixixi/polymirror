import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { aggregateTrades, aggregateTradesPerLeader } from "../src/engine/aggregate.js";
import type { Activity } from "../src/monitor/data-api.js";

function act(ts: number, size: number, price: number): Activity {
  return {
    type: "TRADE",
    asset: "tok1",
    side: "BUY",
    size,
    price,
    timestamp: ts,
  };
}

describe("aggregateTrades", () => {
  it("passes through when window is 0", () => {
    const items = [{ leaderId: "a", activity: act(1000, 10, 0.5) }];
    const out = aggregateTrades(items, 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceCount).toBe(1);
  });

  it("merges same leader/token/side within window", () => {
    const items = [
      { leaderId: "a", activity: act(2001, 10, 0.5) },
      { leaderId: "a", activity: act(2000, 20, 0.6) },
    ];
    const out = aggregateTrades(items, 5000);
    expect(out).toHaveLength(1);
    expect(out[0]!.activity.size).toBe(30);
    expect(out[0]!.sourceCount).toBe(2);
    expect(out[0]!.sourceTradeKeys).toHaveLength(2);
  });

  it("does not merge outside window", () => {
    const items = [
      { leaderId: "a", activity: act(10000, 10, 0.5) },
      { leaderId: "a", activity: act(1000, 20, 0.6) },
    ];
    const out = aggregateTrades(items, 1000);
    expect(out).toHaveLength(2);
  });
});

describe("aggregateTradesPerLeader", () => {
  it("applies per-leader windows", () => {
    const items = [
      { leaderId: "fast", activity: act(2001, 10, 0.5) },
      { leaderId: "fast", activity: act(2000, 20, 0.6) },
      { leaderId: "slow", activity: act(2001, 5, 0.4) },
      { leaderId: "slow", activity: act(1000, 5, 0.45) },
    ];
    const out = aggregateTradesPerLeader(items, 0, (id) =>
      id === "fast" ? 5000 : undefined
    );
    expect(out).toHaveLength(3);
    const fast = out.filter((t) => t.leaderId === "fast");
    const slow = out.filter((t) => t.leaderId === "slow");
    expect(fast).toHaveLength(1);
    expect(fast[0]!.sourceCount).toBe(2);
    expect(slow).toHaveLength(2);
  });
});
