import {
  accountYamlSchema,
  globalYamlSchema,
  type GlobalYaml,
  type NormalizedConfigDocument,
} from "../config/document.js";

export type CandidateArmName = "conservative" | "standard" | "aggressive";

export interface CandidateArmInput {
  fixedUsd?: number;
  maxPositionUsd?: number;
  maxDailyVolumeUsd?: number;
  maxOpenMarkets?: number;
  dailyLossCapPct?: number;
  slippageTolerance?: number;
  minPrice?: number;
  maxPrice?: number;
}

export interface CandidateCohortInput {
  cohortId: string;
  candidates: Array<{
    id: string;
    address?: string;
    username?: string;
  }>;
  arms?: Partial<Record<CandidateArmName, CandidateArmInput>>;
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

const ARM_ORDER: CandidateArmName[] = ["conservative", "standard", "aggressive"];
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
  input: CandidateCohortInput
): NormalizedConfigDocument {
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
