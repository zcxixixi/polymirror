import { describe, expect, it } from "vitest";
import { buildMassPreviewConfig } from "../src/experiments/mass-preview-config.js";
import { readNormalizedConfigDocument } from "../src/config/write.js";

const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;

describe("buildMassPreviewConfig", () => {
  it("fans fifty leaders into one shared-process 150-account config", () => {
    const defaults = readNormalizedConfigDocument("config.preview.template.yaml").defaultsGlobal;
    const result = buildMassPreviewConfig(defaults, {
      cohortId: "mass500",
      candidates: Array.from({ length: 60 }, (_, index) => ({
        id: `c${index + 1}`,
        address: address(index + 1),
        freshIntakePassed: false,
        simulationOnlyEnabled: true,
      })),
    }, { candidateLimit: 50, pollIntervalMs: 60_000, activityLimit: 50 });

    expect(result.accounts).toHaveLength(150);
    expect(result.defaultsGlobal.poll_interval_ms).toBe(60_000);
    expect(result.defaultsGlobal.activity_limit).toBe(50);
    expect(new Set(result.accounts.map((account) => account.id)).size).toBe(150);
  });
});
