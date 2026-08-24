import { globalYamlSchema, type GlobalYaml, type NormalizedConfigDocument } from "../config/document.js";
import { buildCandidateExperimentConfig } from "./candidate-cohort.js";
import { shardCandidateCohort, type MassCandidateCohortInput } from "./cohort-sharding.js";

export interface MassPreviewConfigOptions {
  candidateLimit?: number;
  pollIntervalMs?: number;
  activityLimit?: number;
}

export function buildMassPreviewConfig(
  defaults: GlobalYaml,
  input: MassCandidateCohortInput,
  options: MassPreviewConfigOptions = {}
): NormalizedConfigDocument {
  const candidateLimit = options.candidateLimit ?? 50;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const activityLimit = options.activityLimit ?? 100;
  if (!Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 100) {
    throw new Error("candidateLimit must be an integer from 1 to 100 per process");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 5_000 || pollIntervalMs > 3_600_000) {
    throw new Error("pollIntervalMs must be an integer from 5000 to 3600000");
  }
  if (!Number.isInteger(activityLimit) || activityLimit < 1 || activityLimit > 500) {
    throw new Error("activityLimit must be an integer from 1 to 500");
  }
  const candidates = input.candidates.slice(0, candidateLimit);
  const scaledDefaults = globalYamlSchema.parse({
    ...defaults,
    poll_interval_ms: pollIntervalMs,
    activity_limit: activityLimit,
    preview_mode: true,
  });
  const shards = shardCandidateCohort({ ...input, candidates }, 10);
  const accounts = shards.flatMap(({ cohort }) =>
    buildCandidateExperimentConfig(scaledDefaults, cohort).accounts
  );
  if (accounts.length !== candidates.length * 3) {
    throw new Error("mass preview account fan-out mismatch");
  }
  return { format: "multi", defaultsGlobal: scaledDefaults, accounts };
}
