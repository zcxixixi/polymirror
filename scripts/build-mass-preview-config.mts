import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { readNormalizedConfigDocument } from "../src/config/write.js";
import { toMultiDocument } from "../src/config/document.js";
import { buildMassPreviewConfig } from "../src/experiments/mass-preview-config.js";
import type { MassCandidateCohortInput } from "../src/experiments/cohort-sharding.js";

const [, , baseArg, cohortArg, outputArg, limitArg] = process.argv;
if (!baseArg || !cohortArg || !outputArg) {
  throw new Error("usage: npx tsx scripts/build-mass-preview-config.mts <base.yaml> <mass-cohort.json> <output.yaml> [candidate-limit]");
}
const basePath = resolve(baseArg);
const cohortPath = resolve(cohortArg);
const outputPath = resolve(outputArg);
if (existsSync(outputPath)) throw new Error(`output already exists: ${outputPath}`);
const base = readNormalizedConfigDocument(basePath);
const input = JSON.parse(readFileSync(cohortPath, "utf8")) as MassCandidateCohortInput;
const generated = buildMassPreviewConfig(base.defaultsGlobal, input, {
  candidateLimit: Number(limitArg ?? process.env.MASS_PREVIEW_CANDIDATES ?? 50),
  pollIntervalMs: Number(process.env.MASS_PREVIEW_POLL_INTERVAL_MS ?? 30_000),
  activityLimit: Number(process.env.MASS_PREVIEW_ACTIVITY_LIMIT ?? 100),
});
const payload = stringifyYaml(toMultiDocument(generated), { lineWidth: 0 });
const temp = `${outputPath}.tmp-${process.pid}`;
writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
renameSync(temp, outputPath);
process.stdout.write(`${JSON.stringify({
  outputPath,
  accountCount: generated.accounts.length,
  candidateCount: generated.accounts.length / 3,
  pollIntervalMs: generated.defaultsGlobal.poll_interval_ms,
  activityLimit: generated.defaultsGlobal.activity_limit,
})}\n`);
