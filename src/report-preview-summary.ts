#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPreviewSummaryReview,
  formatPreviewSummaryReview,
} from "./sim/preview-summary-review.js";
import type { PreviewReportSummary } from "./sim/preview-summary.js";

function latestSummaryPath(outDir: string): string {
  const files = readdirSync(outDir)
    .filter((name) => /^preview-summary-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  const latest = files[files.length - 1];
  if (!latest) throw new Error(`No preview-summary-*.jsonl found in ${outDir}`);
  return join(outDir, latest);
}

function readSummaries(path: string): PreviewReportSummary[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PreviewReportSummary);
}

const outDir = process.env.REPORT_OUT_DIR ?? "reports/preview-live";
const summaryPath = process.argv[2] ?? latestSummaryPath(outDir);
if (!existsSync(summaryPath)) throw new Error(`Summary file not found: ${summaryPath}`);

const review = createPreviewSummaryReview(readSummaries(summaryPath));
console.log(`Summary file: ${summaryPath}`);
for (const line of formatPreviewSummaryReview(review)) {
  console.log(line);
}
