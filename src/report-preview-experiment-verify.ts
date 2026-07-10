#!/usr/bin/env node
import { resolve } from "node:path";
import { verifyExperimentArchive } from "./experiments/archive.js";
import { verifyExperimentReplay } from "./experiments/replay-verify.js";

function fail(code: string, message: string): never {
  console.log(JSON.stringify({ ok: false, error: { code, message } }));
  process.exitCode = 1;
  throw new CliExit();
}
class CliExit extends Error {}

try {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf("--source-db");
  if (!args[0] || sourceIndex < 0 || !args[sourceIndex + 1]) {
    fail("INVALID_ARGUMENT", "Usage: preview:verify-experiment <manifest.json> --source-db <source.db>");
  }
  const manifestPath = resolve(args[0]!);
  const sourceDbPath = resolve(args[sourceIndex + 1]!);
  const archive = verifyExperimentArchive(manifestPath, { sourceDbPath });
  if (!archive.valid) fail("ARCHIVE_VERIFICATION_FAILED", archive.errors.join("; "));
  const replay = verifyExperimentReplay(manifestPath, { sourceDbPath });
  if (!replay.match) fail("REPLAY_MISMATCH", replay.mismatches.join(", "));
  console.log(JSON.stringify({ ok: true, manifestPath, sourceDbPath, archive, replay }, null, 2));
} catch (error) {
  if (!(error instanceof CliExit)) {
    console.log(JSON.stringify({ ok: false, error: { code: "VERIFICATION_ERROR", message: error instanceof Error ? error.message : String(error) } }));
    process.exitCode = 1;
  }
}
