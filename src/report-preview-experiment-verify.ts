#!/usr/bin/env node
import { resolve } from "node:path";
import { verifyExperimentArchive } from "./experiments/archive.js";
import { verifyExperimentReplay } from "./experiments/replay-verify.js";

const manifestPath = process.argv[2] ? resolve(process.argv[2]) : "";
if (!manifestPath) throw new Error("Usage: npm run preview:verify-experiment -- <archive/manifest.json>");
const archive = verifyExperimentArchive(manifestPath);
const replay = archive.valid ? verifyExperimentReplay(manifestPath) : undefined;
const report = { manifestPath, archive, replay };
console.log(JSON.stringify(report, null, 2));
if (!archive.valid || !replay?.match) process.exitCode = 1;
