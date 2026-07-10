import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { readNormalizedConfigDocument } from "../src/config/write.js";
import { toMultiDocument } from "../src/config/document.js";
import {
  buildCandidateExperimentConfig,
} from "../src/experiments/candidate-cohort.js";

function usage(): never {
  throw new Error(
    "usage: npx tsx scripts/build-candidate-experiments.mts <base-config.yaml> <cohort.json> <output.yaml>"
  );
}

const [, , baseArg, cohortArg, outputArg] = process.argv;
if (!baseArg || !cohortArg || !outputArg) usage();

const basePath = resolve(baseArg);
const cohortPath = resolve(cohortArg);
const outputPath = resolve(outputArg);
if (outputPath === basePath) throw new Error("output must not replace the base config");
if (existsSync(outputPath)) throw new Error(`output already exists: ${outputPath}`);

const base = readNormalizedConfigDocument(basePath);
const cohort: unknown = JSON.parse(readFileSync(cohortPath, "utf8"));
const generated = buildCandidateExperimentConfig(base.defaultsGlobal, cohort);
const payload = stringifyYaml(toMultiDocument(generated), { lineWidth: 0 });
const tempPath = `${outputPath}.tmp-${process.pid}`;
writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600 });
renameSync(tempPath, outputPath);

process.stdout.write(`${outputPath}\n`);
