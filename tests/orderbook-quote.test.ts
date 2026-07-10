import { describe, expect, it } from "vitest";
import { quoteExecutableOrderBook } from "../src/executor/orderbook.js";

describe("quoteExecutableOrderBook", () => {
  it("calculates a size-weighted BUY price across asks within the limit", () => {
    expect(
      quoteExecutableOrderBook(
        [
          { price: "0.52", size: "2" },
          { price: "0.50", size: "1" },
        ],
        "BUY",
        2,
        0.52
      )
    ).toMatchObject({
      bestPrice: 0.5,
      averagePrice: 0.51,
      availableShares: 3,
      fullyFillable: true,
      minOrderShares: 0,
      meetsMinOrderSize: true,
    });
  });

  it("reports insufficient BUY depth when the next ask exceeds the limit", () => {
    expect(
      quoteExecutableOrderBook(
        [
          { price: "0.53", size: "20" },
          { price: "0.50", size: "1" },
        ],
        "BUY",
        2,
        0.52
      )
    ).toMatchObject({
      bestPrice: 0.5,
      averagePrice: null,
      availableShares: 1,
      fullyFillable: false,
    });
  });

  it("walks SELL bids from highest to lowest without crossing the limit", () => {
    const quote = quoteExecutableOrderBook(
      [
        { price: "0.47", size: "100" },
        { price: "0.49", size: "2" },
        { price: "0.50", size: "1" },
      ],
      "SELL",
      3,
      0.48
    );

    expect(quote).toMatchObject({
      bestPrice: 0.5,
      availableShares: 3,
      fullyFillable: true,
    });
    expect(quote.averagePrice).toBeCloseTo(0.493333, 6);
  });

  it("reports when the requested size is below the market minimum", () => {
    expect(
      quoteExecutableOrderBook(
        [{ price: "0.50", size: "100" }],
        "BUY",
        2,
        0.52,
        5
      )
    ).toMatchObject({
      fullyFillable: true,
      minOrderShares: 5,
      meetsMinOrderSize: false,
    });
  });

  it("checks BUY FOK depth by dollars and reports the expected fill shares", () => {
    const quote = quoteExecutableOrderBook(
      [
        { price: "0.50", size: "1" },
        { price: "0.51", size: "10" },
      ],
      "BUY",
      1.93,
      0.52,
      1,
      1
    );

    expect(quote.fullyFillable).toBe(true);
    expect(quote.filledShares).toBeCloseTo(1.980392, 6);
    expect(quote.averagePrice).toBeCloseTo(0.50495, 5);
  });
});
