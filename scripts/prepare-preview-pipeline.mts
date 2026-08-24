import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(".");
const seed = resolve(
  process.argv[2] ?? "config/candidate-cohorts/retained3-20260824-v1.json"
);
const baseConfig = resolve(process.argv[3] ?? "config.preview.template.yaml");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const runDir = resolve(process.argv[4] ?? `reports/preview-pipeline/${stamp}`);
const intakeDir = resolve(runDir, "intake");
const cohortPath = resolve(runDir, "approved-cohort.json");
const configPath = resolve(runDir, "config.preview.yaml");

mkdirSync(runDir, { recursive: false, mode: 0o700 });

function run(args: string[]): void {
  const result = spawnSync("npx", ["tsx", ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    throw new Error(`pipeline step failed (${result.status ?? "signal"}): ${args.join(" ")}`);
  }
}

run([
  "scripts/refresh-candidate-intake.mts",
  seed,
  intakeDir,
  cohortPath,
]);
run([
  "scripts/build-candidate-experiments.mts",
  baseConfig,
  cohortPath,
  configPath,
]);

process.stdout.write(`${JSON.stringify({
  runDir,
  seed,
  intakeDir,
  cohortPath,
  configPath,
  dataDir: resolve(runDir, "data"),
  reportDir: resolve(runDir, "reports"),
  start: `npm run preview:pipeline:start -- ${runDir}`,
})}\n`);
