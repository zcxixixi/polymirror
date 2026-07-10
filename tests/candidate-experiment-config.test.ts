import { describe, expect, it } from "vitest";
import { globalYamlSchema } from "../src/config/document.js";
import {
  buildCandidateExperimentConfig,
  type CandidateCohortInput,
} from "../src/experiments/candidate-cohort.js";

function cohort(overrides: Partial<CandidateCohortInput> = {}): CandidateCohortInput {
  return {
    cohortId: "2026w28-v1",
    candidates: [
      {
        id: "ec47",
        address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
      },
    ],
    ...overrides,
  };
}

function defaults() {
  return globalYamlSchema.parse({ risk: {}, execution: {}, conflict: {} });
}

describe("buildCandidateExperimentConfig", () => {
  it("creates isolated conservative, standard, and aggressive 200U guarded accounts", () => {
    const baseline = defaults();
    const result = buildCandidateExperimentConfig(baseline, cohort());

    expect(result.format).toBe("multi");
    expect(result.accounts).toHaveLength(3);
    expect(new Set(result.accounts.map((account) => account.id)).size).toBe(3);

    for (const account of result.accounts) {
      expect(account.enabled).toBe(true);
      expect(account.label).toContain("2026w28-v1");
      expect(account.label).toContain("ec47");
      expect(account.global).toMatchObject({
        preview_mode: true,
        copy_price_mode: "executable_guarded",
        risk: {
          enable_copy_trading: true,
          starting_capital_usd: 200,
        },
        execution: { order_type: "FOK" },
      });
      expect(account.leaders).toHaveLength(1);
      expect(account.leaders[0]).toMatchObject({
        address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
        enabled: true,
        strategy: { type: "FIXED" },
      });
    }

    expect(result.accounts.map((account) => account.id)).toEqual([
      "exp_2026w28-v1_ec47_conservative_200",
      "exp_2026w28-v1_ec47_standard_200",
      "exp_2026w28-v1_ec47_aggressive_200",
    ]);
    expect(baseline.preview_mode).toBe(true);
    expect(baseline.execution.order_type).toBe("GTC");
  });

  it("rejects duplicate candidates and unsafe arm overrides", () => {
    const baseline = defaults();
    expect(() =>
      buildCandidateExperimentConfig(
        baseline,
        cohort({
          candidates: [
            {
              id: "same",
              address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
            },
            {
              id: "same",
              address: "0x66f3b58702fa50aff254b4f84de82fe63a13787c",
            },
          ],
        })
      )
    ).toThrow(/duplicate candidate id/i);

    expect(() =>
      buildCandidateExperimentConfig(
        baseline,
        cohort({
          arms: {
            aggressive: { fixedUsd: 20 },
          },
        })
      )
    ).toThrow(/fixedUsd.*10/i);
  });

  it("keeps incomplete candidates disabled instead of silently running them", () => {
    const result = buildCandidateExperimentConfig(
      defaults(),
      cohort({ candidates: [{ id: "watch-only" }] })
    );

    expect(result.accounts.every((account) => account.enabled === false)).toBe(true);
    expect(result.accounts.every((account) => account.leaders[0]?.enabled === false)).toBe(true);
  });
});
