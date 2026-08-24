import { createHash } from "node:crypto";
import { candidateCohortSchema, type CandidateCohortInput } from "./candidate-cohort.js";

export interface MassCandidateCohortInput {
  cohortId: string;
  experimentFactor?: CandidateCohortInput["experimentFactor"];
  candidates: CandidateCohortInput["candidates"];
  arms?: CandidateCohortInput["arms"];
}

export interface CandidateCohortShard {
  index: number;
  cohort: CandidateCohortInput;
  canonicalSha256: string;
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function shardId(base: string, index: number): string {
  const suffix = `_s${String(index).padStart(3, "0")}`;
  const prefix = base.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24 - suffix.length);
  if (!prefix) throw new Error("mass cohortId must contain an identifier character");
  return `${prefix}${suffix}`;
}

export function shardCandidateCohort(
  input: MassCandidateCohortInput,
  shardSize = 10
): CandidateCohortShard[] {
  if (!Number.isInteger(shardSize) || shardSize < 1 || shardSize > 10) {
    throw new Error("shardSize must be an integer from 1 to 10");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error("mass cohort requires at least one candidate");
  }
  if (input.candidates.length > 5_000) {
    throw new Error("mass cohort supports at most 5000 candidates per frozen universe");
  }

  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const candidate of input.candidates) {
    if (ids.has(candidate.id)) throw new Error(`duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    if (candidate.address) {
      const address = candidate.address.toLowerCase();
      if (addresses.has(address)) throw new Error(`duplicate candidate address: ${address}`);
      addresses.add(address);
    }
  }

  const shards: CandidateCohortShard[] = [];
  for (let offset = 0; offset < input.candidates.length; offset += shardSize) {
    const index = shards.length + 1;
    const raw = {
      cohortId: shardId(input.cohortId, index),
      ...(input.experimentFactor ? { experimentFactor: input.experimentFactor } : {}),
      candidates: input.candidates.slice(offset, offset + shardSize),
      ...(input.arms ? { arms: input.arms } : {}),
    };
    const cohort = candidateCohortSchema.parse(raw);
    shards.push({
      index,
      cohort,
      canonicalSha256: createHash("sha256").update(canonicalJson(cohort)).digest("hex"),
    });
  }
  return shards;
}
