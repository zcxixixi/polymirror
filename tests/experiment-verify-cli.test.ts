import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("experiment verification CLI", () => {
  it("emits a stable structured failure for malformed or missing arguments", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/report-preview-experiment-verify.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect(result.stderr).toBe("");
  });
});
