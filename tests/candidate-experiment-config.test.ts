import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { globalYamlSchema } from "../src/config/document.js";
import {
  buildCandidateExperimentConfig,
  candidateCohortSchema,
  validateCandidateCohortJson,
  type CandidateCohortInput,
} from "../src/experiments/candidate-cohort.js";

const FRESH_INTAKE_SHA256 = "a".repeat(64);

function cohort(overrides: Partial<CandidateCohortInput> = {}): CandidateCohortInput {
  return {
    cohortId: "2026w28-v1",
    candidates: [
      {
        id: "ec47",
        address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
        freshIntakePassed: true,
        freshIntakeEvidenceSha256: FRESH_INTAKE_SHA256,
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

  it("builds the deterministic quality12 watchlist without silently enabling copy", () => {
    const input = JSON.parse(
      readFileSync("config/candidate-cohorts/quality12-20260711-v1.json", "utf8")
    ) as CandidateCohortInput;
    const result = buildCandidateExperimentConfig(defaults(), input);
    const expectedCandidates = [
      ["ec47", "0xec47cb4e0a4f4e375d9787debf7c874214f21119"],
      ["dance", "0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82"],
      ["linabell", "0xf0ed9e68e6cd3ee712260abeaec32de56a7d47d8"],
      ["pada", "0x714a685b5454ea4d52979563bbafa77b8168ab2f"],
    ] as const;
    const expectedArms = {
      conservative: {
        fixedUsd: 1, maxPositionUsd: 10, maxDailyVolumeUsd: 40,
        maxOpenMarkets: 10, dailyLossCapPct: 5, slippageTolerance: 0.015,
      },
      standard: {
        fixedUsd: 2, maxPositionUsd: 20, maxDailyVolumeUsd: 80,
        maxOpenMarkets: 15, dailyLossCapPct: 8, slippageTolerance: 0.025,
      },
      aggressive: {
        fixedUsd: 5, maxPositionUsd: 40, maxDailyVolumeUsd: 160,
        maxOpenMarkets: 20, dailyLossCapPct: 10, slippageTolerance: 0.04,
      },
    } as const;

    expect(result.accounts).toHaveLength(12);
    expect(result.accounts.map((account) => account.id)).toEqual(
      expectedCandidates.flatMap(([candidateId]) =>
        (["conservative", "standard", "aggressive"] as const).map(
          (arm) => `exp_quality12-20260711-v1_${candidateId}_${arm}_200`
        )
      )
    );

    for (const [candidateId, address] of expectedCandidates) {
      for (const [armName, arm] of Object.entries(expectedArms)) {
        const account = result.accounts.find(
          (candidate) => candidate.id === `exp_quality12-20260711-v1_${candidateId}_${armName}_200`
        );
        expect(account).toBeDefined();
        expect(account).toMatchObject({
          enabled: true,
          global: {
            preview_mode: true,
            copy_price_mode: "executable_guarded",
            risk: {
              enable_copy_trading: false,
              starting_capital_usd: 200,
              daily_loss_cap_pct: arm.dailyLossCapPct,
              max_daily_volume_usd: arm.maxDailyVolumeUsd,
              max_open_markets: arm.maxOpenMarkets,
              max_order_usd: arm.fixedUsd,
              slippage_tolerance: arm.slippageTolerance,
              slippage_tolerance_mode: "relative_pct",
              max_position_per_token_usd: arm.maxPositionUsd,
            },
            execution: { order_type: "FOK" },
          },
          leaders: [{
            id: candidateId,
            address,
            enabled: false,
            strategy: { type: "FIXED", copy_size: arm.fixedUsd },
            limits: {
              max_order_usd: arm.fixedUsd,
              max_position_usd: arm.maxPositionUsd,
              max_daily_volume_usd: arm.maxDailyVolumeUsd,
            },
            filters: { sides: ["BUY", "SELL"] },
          }],
        });
        const filters = account!.leaders[0]!.filters;
        expect(filters?.min_price).toBeUndefined();
        expect(filters?.max_price).toBeUndefined();
      }
    }
  });

  it("builds the user-authorized b55 and dance simulation-only cohort into six active preview arms", () => {
    const input = validateCandidateCohortJson(JSON.parse(
      readFileSync("config/candidate-cohorts/quality6-20260711-v1.json", "utf8")
    ));
    const result = buildCandidateExperimentConfig(defaults(), input);

    expect(input.candidates.map(({ id, address }) => [id, address])).toEqual([
      ["b55", "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4"],
      ["dance", "0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82"],
    ]);
    expect(result.accounts).toHaveLength(6);
    expect(result.accounts.every((account) =>
      account.global.risk.enable_copy_trading === true
      && account.global.risk.daily_loss_cap_pct === 100
      && account.global.risk.max_liquidation_drawdown_pct === 100
      && account.leaders[0]?.enabled === true
      && account.global.preview_mode === true
    )).toBe(true);
    expect(result.accounts.map((account) => account.id)).toEqual([
      "exp_quality6-20260711-v1_b55_conservative_200",
      "exp_quality6-20260711-v1_b55_standard_200",
      "exp_quality6-20260711-v1_b55_aggressive_200",
      "exp_quality6-20260711-v1_dance_conservative_200",
      "exp_quality6-20260711-v1_dance_standard_200",
      "exp_quality6-20260711-v1_dance_aggressive_200",
    ]);
  });

  it("omits price filters by default while preserving explicit paired overrides", () => {
    const result = buildCandidateExperimentConfig(defaults(), cohort({
      arms: {
        standard: { minPrice: 0.2, maxPrice: 0.85 },
      },
    }));

    const conservative = result.accounts.find((account) =>
      account.id.endsWith("_conservative_200")
    );
    const standard = result.accounts.find((account) =>
      account.id.endsWith("_standard_200")
    );
    expect(conservative?.leaders[0]?.filters).toEqual({ sides: ["BUY", "SELL"] });
    expect(standard?.leaders[0]?.filters).toEqual({
      min_price: 0.2,
      max_price: 0.85,
      sides: ["BUY", "SELL"],
    });
  });

  it.each([
    ["minimum only", { minPrice: 0.2 }],
    ["maximum only", { maxPrice: 0.8 }],
  ])("requires explicit price overrides to be paired: %s", (_name, arm) => {
    const input = cohort({ arms: { standard: arm } });
    expect(() => validateCandidateCohortJson(input)).toThrow(/minPrice.*maxPrice|paired/i);
    expect(() => candidateCohortSchema.parse(input)).toThrow(/minPrice.*maxPrice|paired/i);
  });

  it("publishes paired price overrides as a standard JSON Schema constraint", () => {
    const published = JSON.parse(
      readFileSync("config/candidate-cohort.schema.json", "utf8")
    );
    const validate = new Ajv2020({ strict: false }).compile(published);

    expect(validate(cohort({ arms: { standard: { minPrice: 0.2 } } }))).toBe(false);
    expect(validate(cohort({
      arms: { standard: { minPrice: 0.2, maxPrice: 0.8 } },
    }))).toBe(true);
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
              freshIntakePassed: true,
              freshIntakeEvidenceSha256: FRESH_INTAKE_SHA256,
            },
            {
              id: "same",
              address: "0x66f3b58702fa50aff254b4f84de82fe63a13787c",
              freshIntakePassed: true,
              freshIntakeEvidenceSha256: "b".repeat(64),
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
    ).toThrow(/<= 10/i);
  });

  it("keeps incomplete candidates disabled instead of silently running them", () => {
    const result = buildCandidateExperimentConfig(
      defaults(),
      cohort({ candidates: [{ id: "watch-only", freshIntakePassed: false }] })
    );

    expect(result.accounts.every((account) => account.enabled === false)).toBe(true);
    expect(result.accounts.every((account) => account.leaders[0]?.enabled === false)).toBe(true);
  });

  it("keeps configured watchlist accounts visible but copy-disabled until fresh intake passes", () => {
    const result = buildCandidateExperimentConfig(
      defaults(),
      cohort({
        candidates: [{
          id: "watch-only",
          address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
          freshIntakePassed: false,
        }],
      })
    );

    expect(result.accounts).toHaveLength(3);
    expect(result.accounts.every((account) => account.enabled === true)).toBe(true);
    expect(result.accounts.every(
      (account) => account.global.risk.enable_copy_trading === false
    )).toBe(true);
    expect(result.accounts.every((account) => account.leaders[0]?.enabled === false)).toBe(true);
  });

  it("retains failed-intake candidates beside passed candidates instead of replacing them", () => {
    const result = buildCandidateExperimentConfig(defaults(), cohort({
      candidates: [
        {
          id: "passed",
          address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
          freshIntakePassed: true,
          freshIntakeEvidenceSha256: FRESH_INTAKE_SHA256,
        },
        {
          id: "watch",
          address: "0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82",
          freshIntakePassed: false,
        },
      ],
    }));

    expect(result.accounts).toHaveLength(6);
    expect(result.accounts.filter((account) => account.id.includes("_passed_")))
      .toHaveLength(3);
    expect(result.accounts.filter((account) => account.id.includes("_watch_")))
      .toHaveLength(3);
    expect(result.accounts.filter((account) => account.id.includes("_passed_"))
      .every((account) => account.leaders[0]?.enabled === true)).toBe(true);
    expect(result.accounts.filter((account) => account.id.includes("_watch_"))
      .every((account) => account.leaders[0]?.enabled === false)).toBe(true);
  });

  it("requires an explicit fresh-intake decision instead of silently opting in", () => {
    const candidateWithoutDecision = {
      ...cohort(),
      candidates: [{
        id: "ec47",
        address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
      }],
    };

    expect(() => validateCandidateCohortJson(candidateWithoutDecision)).toThrow(
      /freshIntakePassed/i
    );
    expect(() => candidateCohortSchema.parse(candidateWithoutDecision)).toThrow(
      /freshIntakePassed/i
    );
  });

  it("requires fresh intake approval to reference immutable evidence", () => {
    const passedWithoutEvidence = {
      ...cohort(),
      candidates: [{
        id: "ec47",
        address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
        freshIntakePassed: true,
      }],
    };

    expect(() => validateCandidateCohortJson(passedWithoutEvidence)).toThrow(
      /freshIntakeEvidenceSha256/i
    );
    expect(() => candidateCohortSchema.parse(passedWithoutEvidence)).toThrow(
      /freshIntakeEvidenceSha256/i
    );
  });

  it("rejects unknown and misspelled cohort fields before generation", () => {
    expect(() =>
      buildCandidateExperimentConfig(defaults(), {
        ...cohort(),
        arms: { standard: { fixedUSD: 3 } },
      })
    ).toThrow(/unrecognized key.*fixedUSD/i);

    expect(() =>
      buildCandidateExperimentConfig(defaults(), {
        ...cohort(),
        candidate: [],
      })
    ).toThrow(/unrecognized key.*candidate/i);
  });

  it("runtime schema rejects invalid types, ranges, ordering, and duplicate identities", () => {
    expect(() => candidateCohortSchema.parse({ ...cohort(), cohortId: 123 })).toThrow();
    expect(() => candidateCohortSchema.parse({ ...cohort(), cohortId: "x".repeat(25) })).toThrow();
    expect(() => candidateCohortSchema.parse({
      ...cohort(),
      arms: { standard: { minPrice: 0.8, maxPrice: 0.2 } },
    })).toThrow(/minPrice.*maxPrice/i);
    expect(() => candidateCohortSchema.parse({
      ...cohort(),
      candidates: [
        { id: "one", address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119", freshIntakePassed: true, freshIntakeEvidenceSha256: FRESH_INTAKE_SHA256 },
        { id: "two", address: "0xEC47CB4E0A4F4E375D9787DEBF7C874214F21119", freshIntakePassed: true, freshIntakeEvidenceSha256: "b".repeat(64) },
      ],
    })).toThrow(/duplicate candidate address/i);
  });

  it("keeps runtime and published JSON Schema fields aligned", () => {
    const published = JSON.parse(
      readFileSync("config/candidate-cohort.schema.json", "utf8")
    ) as {
      properties: Record<string, unknown>;
      "x-candidateCohortRules": string[];
      $defs: { arm: { properties: Record<string, unknown>; "x-candidateArmRules": string[] } };
    };
    expect(Object.keys(published.properties).sort()).toEqual(["arms", "candidates", "cohortId"]);
    const candidateItems = (published.properties.candidates as {
      items: {
        properties: Record<string, unknown>;
        required: string[];
        "x-candidateFreshIntakeRules": string[];
      };
    }).items;
    expect(Object.keys(candidateItems.properties).sort()).toEqual([
      "address", "freshIntakeEvidenceSha256", "freshIntakePassed", "id",
      "simulationOnlyEnabled", "username",
    ]);
    expect(candidateItems.required.sort()).toEqual(["freshIntakePassed", "id"]);
    expect(candidateItems["x-candidateFreshIntakeRules"]).toContain(
      "passed requires evidence sha256"
    );
    expect(Object.keys(published.$defs.arm.properties).sort()).toEqual([
      "dailyLossCapPct",
      "fixedUsd",
      "maxDailyVolumeUsd",
      "maxOpenMarkets",
      "maxPositionUsd",
      "maxPrice",
      "minPrice",
      "slippageTolerance",
    ]);
    expect(published["x-candidateCohortRules"]).toContain("unique candidate IDs");
    expect(published.$defs.arm["x-candidateArmRules"]).toContain("minPrice < maxPrice");
    expect(published.$defs.arm["x-candidateArmRules"]).toContain(
      "minPrice and maxPrice must be supplied together"
    );
  });

  it.each([
    ["equal prices", { arms: { standard: { minPrice: 0.5, maxPrice: 0.5 } } }],
    ["inverted prices", { arms: { standard: { minPrice: 0.8, maxPrice: 0.2 } } }],
    ["fixed above position", { arms: { standard: { fixedUsd: 5, maxPositionUsd: 4 } } }],
    ["fixed above daily volume", { arms: { standard: { fixedUsd: 5, maxDailyVolumeUsd: 4 } } }],
    ["duplicate IDs", { candidates: [
      { id: "same", address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119", freshIntakePassed: true, freshIntakeEvidenceSha256: FRESH_INTAKE_SHA256 },
      { id: "same", address: "0x66f3b58702fa50aff254b4f84de82fe63a13787c", freshIntakePassed: true, freshIntakeEvidenceSha256: "b".repeat(64) },
    ] }],
    ["duplicate addresses", { candidates: [
      { id: "one", address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119", freshIntakePassed: true, freshIntakeEvidenceSha256: FRESH_INTAKE_SHA256 },
      { id: "two", address: "0xEC47CB4E0A4F4E375D9787DEBF7C874214F21119", freshIntakePassed: true, freshIntakeEvidenceSha256: "b".repeat(64) },
    ] }],
    ["watchlist carrying approval evidence", { candidates: [{
      id: "watch",
      address: "0xec47cb4e0a4f4e375d9787debf7c874214f21119",
      freshIntakePassed: false,
      freshIntakeEvidenceSha256: FRESH_INTAKE_SHA256,
    }] }],
    ["typo", { arms: { standard: { fixedUSD: 2 } } }],
  ])("rejects the invalid corpus identically through JSON Schema and Zod: %s", (_name, patch) => {
    const input = { ...cohort(), ...patch };
    expect(() => validateCandidateCohortJson(input)).toThrow();
    expect(() => candidateCohortSchema.parse(input)).toThrow();
  });
});
