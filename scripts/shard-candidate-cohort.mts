import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { shardCandidateCohort, type MassCandidateCohortInput } from "../src/experiments/cohort-sharding.js";

const [, , inputArg, outputArg, shardSizeArg] = process.argv;
if (!inputArg || !outputArg) {
  throw new Error("usage: npx tsx scripts/shard-candidate-cohort.mts <mass-cohort.json> <output-dir> [shard-size]");
}
const inputPath = resolve(inputArg);
const outputDir = resolve(outputArg);
const shardSize = shardSizeArg ? Number(shardSizeArg) : 10;
const input = JSON.parse(readFileSync(inputPath, "utf8")) as MassCandidateCohortInput;
const shards = shardCandidateCohort(input, shardSize);
mkdirSync(outputDir, { recursive: false, mode: 0o700 });

const artifacts = shards.map(({ index, cohort, canonicalSha256 }) => {
  const fileName = `${cohort.cohortId}.json`;
  const path = resolve(outputDir, fileName);
  const payload = `${JSON.stringify(cohort, null, 2)}\n`;
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temp, path);
  return {
    index,
    fileName: basename(path),
    candidateCount: cohort.candidates.length,
    canonicalSha256,
    fileSha256: createHash("sha256").update(payload).digest("hex"),
  };
});
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  source: inputPath,
  cohortId: input.cohortId,
  candidateCount: input.candidates.length,
  shardSize,
  shardCount: artifacts.length,
  artifacts,
};
writeFileSync(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
process.stdout.write(`${JSON.stringify(manifest)}\n`);
