import {
  accountYamlSchema,
  globalYamlSchema,
  type GlobalYaml,
  type NormalizedConfigDocument,
} from "../config/document.js";
import { z } from "zod";
import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const candidateArmNames = ["conservative", "standard", "aggressive"] as const;
export type CandidateArmName = (typeof candidateArmNames)[number];

const idSchema = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const candidateArmSchema = z.object({
  fixedUsd: z.number().positive().max(10).optional(),
  maxPositionUsd: z.number().positive().max(50).optional(),
  maxDailyVolumeUsd: z.number().positive().max(200).optional(),
  maxOpenMarkets: z.number().int().min(1).max(30).optional(),
  dailyLossCapPct: z.number().positive().max(15).optional(),
  slippageTolerance: z.number().positive().max(0.05).optional(),
  minPrice: z.number().min(0).max(1).optional(),
  maxPrice: z.number().min(0).max(1).optional(),
}).strict().superRefine((arm, context) => {
  if (arm.minPrice !== undefined && arm.maxPrice !== undefined && arm.minPrice >= arm.maxPrice) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minPrice must be less than maxPrice",
      path: ["minPrice"],
    });
  }
  if (arm.fixedUsd !== undefined
    && arm.maxPositionUsd !== undefined
    && arm.fixedUsd > arm.maxPositionUsd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fixedUsd must be less than or equal to maxPositionUsd",
      path: ["fixedUsd"],
    });
  }
  if (arm.fixedUsd !== undefined
    && arm.maxDailyVolumeUsd !== undefined
    && arm.fixedUsd > arm.maxDailyVolumeUsd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fixedUsd must be less than or equal to maxDailyVolumeUsd",
      path: ["fixedUsd"],
    });
  }
});

export const candidateCohortSchema = z.object({
  cohortId: idSchema.max(24),
  candidates: z.array(z.object({
    id: idSchema.max(20),
    address: z.string().regex(/^0x[A-Fa-f0-9]{40}$/).optional(),
    username: z.string().min(1).optional(),
  }).strict()).min(1).max(10),
  arms: z.object({
    conservative: candidateArmSchema.optional(),
    standard: candidateArmSchema.optional(),
    aggressive: candidateArmSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((cohort, context) => {
  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const [index, candidate] of cohort.candidates.entries()) {
    if (ids.has(candidate.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate candidate id: ${candidate.id}`,
        path: ["candidates", index, "id"],
      });
    }
    ids.add(candidate.id);
    if (candidate.address) {
      const address = candidate.address.toLowerCase();
      if (addresses.has(address)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate candidate address: ${address}`,
          path: ["candidates", index, "address"],
        });
      }
      addresses.add(address);
    }
  }
});

export type CandidateArmInput = z.infer<typeof candidateArmSchema>;
export type CandidateCohortInput = z.infer<typeof candidateCohortSchema>;

interface CandidateArmRuleInput {
  fixedUsd?: number;
  maxPositionUsd?: number;
  maxDailyVolumeUsd?: number;
  minPrice?: number;
  maxPrice?: number;
}

interface CandidateRuleInput {
  candidates?: Array<{ id?: string; address?: string }>;
}

const candidateSchemaPath = fileURLToPath(
  new URL("../../config/candidate-cohort.schema.json", import.meta.url)
);
const publishedCandidateSchema = JSON.parse(
  readFileSync(candidateSchemaPath, "utf8")
) as AnySchema;
const candidateSchemaValidator = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addKeyword({
    keyword: "x-candidateArmRules",
    schemaType: "array",
    errors: false,
    validate: (_rules: string[], value: unknown) => {
      if (!value || typeof value !== "object") return true;
      const arm = value as CandidateArmRuleInput;
      return !(arm.minPrice !== undefined && arm.maxPrice !== undefined && arm.minPrice >= arm.maxPrice)
      && !(arm.fixedUsd !== undefined
        && arm.maxPositionUsd !== undefined
        && arm.fixedUsd > arm.maxPositionUsd)
      && !(arm.fixedUsd !== undefined
        && arm.maxDailyVolumeUsd !== undefined
        && arm.fixedUsd > arm.maxDailyVolumeUsd);
    },
  });
  ajv.addKeyword({
    keyword: "x-candidateCohortRules",
    schemaType: "array",
    errors: false,
    validate: (_rules: string[], value: unknown) => {
      if (!value || typeof value !== "object") return true;
      const cohort = value as CandidateRuleInput;
      if (!Array.isArray(cohort.candidates)) return true;
      const ids = new Set<string>();
      const addresses = new Set<string>();
      for (const candidate of cohort.candidates) {
        if (typeof candidate.id === "string") {
          if (ids.has(candidate.id)) return false;
          ids.add(candidate.id);
        }
        if (typeof candidate.address === "string") {
          const address = candidate.address.toLowerCase();
          if (addresses.has(address)) return false;
          addresses.add(address);
        }
      }
      return true;
    },
  });
  return ajv.compile(publishedCandidateSchema);
})();

export function validateCandidateCohortJson(input: unknown): unknown {
  if (!candidateSchemaValidator(input)) {
    throw new Error(`Candidate cohort JSON Schema validation failed: ${
      candidateSchemaValidator.errors
        ?.map((error: ErrorObject) => {
          if (error.keyword === "additionalProperties") {
            const key = (error.params as { additionalProperty?: string }).additionalProperty;
            return `${error.instancePath || "/"} unrecognized key: ${key ?? "unknown"}`;
          }
          if (error.keyword === "x-candidateCohortRules") {
            const candidates = (input as CandidateRuleInput).candidates ?? [];
            const ids = new Set<string>();
            const addresses = new Set<string>();
            for (const candidate of candidates) {
              if (candidate.id && ids.has(candidate.id)) {
                return `duplicate candidate id: ${candidate.id}`;
              }
              if (candidate.id) ids.add(candidate.id);
              const address = candidate.address?.toLowerCase();
              if (address && addresses.has(address)) {
                return `duplicate candidate address: ${address}`;
              }
              if (address) addresses.add(address);
            }
          }
          return `${error.instancePath || "/"} ${error.message ?? "is invalid"}`;
        })
        .join("; ")
    }`);
  }
  return input;
}

interface ResolvedArm {
  fixedUsd: number;
  maxPositionUsd: number;
  maxDailyVolumeUsd: number;
  maxOpenMarkets: number;
  dailyLossCapPct: number;
  slippageTolerance: number;
  minPrice: number;
  maxPrice: number;
}

const ARM_ORDER: readonly CandidateArmName[] = candidateArmNames;
const ARM_DEFAULTS: Record<CandidateArmName, ResolvedArm> = {
  conservative: {
    fixedUsd: 1,
    maxPositionUsd: 10,
    maxDailyVolumeUsd: 40,
    maxOpenMarkets: 10,
    dailyLossCapPct: 5,
    slippageTolerance: 0.015,
    minPrice: 0.1,
    maxPrice: 0.7,
  },
  standard: {
    fixedUsd: 2,
    maxPositionUsd: 20,
    maxDailyVolumeUsd: 80,
    maxOpenMarkets: 15,
    dailyLossCapPct: 8,
    slippageTolerance: 0.025,
    minPrice: 0.05,
    maxPrice: 0.8,
  },
  aggressive: {
    fixedUsd: 5,
    maxPositionUsd: 40,
    maxDailyVolumeUsd: 160,
    maxOpenMarkets: 20,
    dailyLossCapPct: 12,
    slippageTolerance: 0.04,
    minPrice: 0.02,
    maxPrice: 0.9,
  },
};

function assertId(label: string, value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, _ or -`);
  }
}

function resolveArm(name: CandidateArmName, override?: CandidateArmInput): ResolvedArm {
  const arm = { ...ARM_DEFAULTS[name], ...override };
  if (!(arm.fixedUsd > 0 && arm.fixedUsd <= 10)) {
    throw new Error(`${name}.fixedUsd must be > 0 and <= 10`);
  }
  if (!(arm.maxPositionUsd >= arm.fixedUsd && arm.maxPositionUsd <= 50)) {
    throw new Error(`${name}.maxPositionUsd must be between fixedUsd and 50`);
  }
  if (!(arm.maxDailyVolumeUsd >= arm.fixedUsd && arm.maxDailyVolumeUsd <= 200)) {
    throw new Error(`${name}.maxDailyVolumeUsd must be between fixedUsd and 200`);
  }
  if (!(Number.isInteger(arm.maxOpenMarkets) && arm.maxOpenMarkets > 0 && arm.maxOpenMarkets <= 30)) {
    throw new Error(`${name}.maxOpenMarkets must be an integer between 1 and 30`);
  }
  if (!(arm.dailyLossCapPct > 0 && arm.dailyLossCapPct <= 15)) {
    throw new Error(`${name}.dailyLossCapPct must be > 0 and <= 15`);
  }
  if (!(arm.slippageTolerance > 0 && arm.slippageTolerance <= 0.05)) {
    throw new Error(`${name}.slippageTolerance must be > 0 and <= 0.05`);
  }
  if (!(arm.minPrice >= 0 && arm.maxPrice <= 1 && arm.minPrice < arm.maxPrice)) {
    throw new Error(`${name} price range must satisfy 0 <= minPrice < maxPrice <= 1`);
  }
  return arm;
}

export function buildCandidateExperimentConfig(
  defaults: GlobalYaml,
  candidateInput: unknown
): NormalizedConfigDocument {
  validateCandidateCohortJson(candidateInput);
  const input = candidateCohortSchema.parse(candidateInput);
  assertId("cohortId", input.cohortId);
  if (input.candidates.length === 0) throw new Error("at least one candidate is required");
  if (input.candidates.length * ARM_ORDER.length > 30) {
    throw new Error("candidate cohort may generate at most 30 accounts");
  }

  const candidateIds = new Set<string>();
  const candidateAddresses = new Set<string>();
  for (const candidate of input.candidates) {
    assertId("candidate id", candidate.id);
    if (candidateIds.has(candidate.id)) throw new Error(`duplicate candidate id: ${candidate.id}`);
    candidateIds.add(candidate.id);
    if (candidate.address) {
      const address = candidate.address.toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(address)) {
        throw new Error(`candidate ${candidate.id} has invalid address`);
      }
      if (candidateAddresses.has(address)) {
        throw new Error(`duplicate candidate address: ${address}`);
      }
      candidateAddresses.add(address);
    }
  }

  const arms = Object.fromEntries(
    ARM_ORDER.map((name) => [name, resolveArm(name, input.arms?.[name])])
  ) as Record<CandidateArmName, ResolvedArm>;

  const accounts = input.candidates.flatMap((candidate) =>
    ARM_ORDER.map((armName) => {
      const arm = arms[armName];
      const configured = Boolean(candidate.address || candidate.username?.trim());
      const id = `exp_${input.cohortId}_${candidate.id}_${armName}_200`;
      if (id.length > 64) throw new Error(`generated account id exceeds 64 characters: ${id}`);

      const global = globalYamlSchema.parse({
        ...defaults,
        preview_mode: true,
        copy_price_mode: "executable_guarded",
        copy_trades_only: true,
        risk: {
          ...defaults.risk,
          enable_copy_trading: configured,
          starting_capital_usd: 200,
          daily_loss_cap_pct: arm.dailyLossCapPct,
          max_daily_volume_usd: arm.maxDailyVolumeUsd,
          max_open_markets: arm.maxOpenMarkets,
          max_order_usd: arm.fixedUsd,
          min_order_usd: 1,
          slippage_tolerance: arm.slippageTolerance,
          max_position_per_token_usd: arm.maxPositionUsd,
          position_cap_basis: "cost",
          sync_wallet_balance: false,
        },
        execution: {
          ...defaults.execution,
          order_type: "FOK",
        },
      });

      return accountYamlSchema.parse({
        id,
        label: `${input.cohortId} · ${candidate.id} · ${armName} · 200U preview`,
        enabled: configured,
        wallet_env: "",
        global,
        leaders: [
          {
            id: candidate.id,
            ...(candidate.address ? { address: candidate.address.toLowerCase() } : {}),
            ...(candidate.username?.trim() ? { username: candidate.username.trim() } : {}),
            enabled: configured,
            weight: 1,
            strategy: { type: "FIXED", copy_size: arm.fixedUsd },
            limits: {
              max_order_usd: arm.fixedUsd,
              max_position_usd: arm.maxPositionUsd,
              max_daily_volume_usd: arm.maxDailyVolumeUsd,
            },
            filters: {
              min_price: arm.minPrice,
              max_price: arm.maxPrice,
              sides: ["BUY", "SELL"],
            },
          },
        ],
      });
    })
  );

  return {
    format: "multi",
    defaultsGlobal: globalYamlSchema.parse(defaults),
    accounts,
  };
}
