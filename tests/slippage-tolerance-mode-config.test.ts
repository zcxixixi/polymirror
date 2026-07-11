import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalYamlSchema } from "../src/config/document.js";
import { loadConfig } from "../src/config/load.js";
import {
  applyGlobalSettingsPatch,
  globalConfigToDto,
  globalSettingsPatchSchema,
} from "../src/config/settings-schema.js";

const dirs: string[] = [];
const walletEnvKeys = [
  "POLYMARKET_PRIVATE_KEY",
  "POLYMARKET_ADDRESS",
  "POLYMARKET_SIGNATURE_TYPE",
] as const;
const previousWalletEnv = new Map<string, string | undefined>();

function minimalGlobal(risk: Record<string, unknown> = {}) {
  return { risk, execution: {}, conflict: {} };
}

function writeConfig(risk: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "polymirror-slippage-mode-"));
  dirs.push(dir);
  const path = join(dir, "config.yaml");
  writeFileSync(path, stringifyYaml({
    global: minimalGlobal(risk),
    leaders: [],
  }));
  return path;
}

beforeEach(() => {
  for (const key of walletEnvKeys) previousWalletEnv.set(key, process.env[key]);
  process.env.POLYMARKET_PRIVATE_KEY = `0x${"1".repeat(64)}`;
  process.env.POLYMARKET_ADDRESS = `0x${"2".repeat(40)}`;
  process.env.POLYMARKET_SIGNATURE_TYPE = "1";
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of walletEnvKeys) {
    const value = previousWalletEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousWalletEnv.clear();
});

describe("slippage tolerance mode config compatibility", () => {
  it("defaults old YAML to absolute_price and accepts explicit relative_pct", () => {
    expect(globalYamlSchema.parse(minimalGlobal()).risk.slippage_tolerance_mode)
      .toBe("absolute_price");
    expect(globalYamlSchema.parse(minimalGlobal({
      slippage_tolerance_mode: "relative_pct",
    })).risk.slippage_tolerance_mode).toBe("relative_pct");
    expect(() => globalYamlSchema.parse(minimalGlobal({
      slippage_tolerance_mode: "unknown",
    }))).toThrow();
  });

  it("maps both omitted legacy mode and explicit relative_pct into runtime config", () => {
    const legacy = loadConfig(writeConfig({ slippage_tolerance: 0.03 }));
    const relative = loadConfig(writeConfig({
      slippage_tolerance: 0.04,
      slippage_tolerance_mode: "relative_pct",
    }));

    expect(legacy.app.global.risk.slippageToleranceMode).toBe("absolute_price");
    expect(relative.app.global.risk).toMatchObject({
      slippageTolerance: 0.04,
      slippageToleranceMode: "relative_pct",
    });
  });

  it("round-trips relative_pct through the settings DTO and YAML patch", () => {
    const patch = globalSettingsPatchSchema.parse({
      risk: { slippageToleranceMode: "relative_pct" },
    });
    const doc = {
      global: globalYamlSchema.parse(minimalGlobal()) as unknown as Record<string, unknown>,
    };

    applyGlobalSettingsPatch(doc, patch);

    expect((doc.global.risk as Record<string, unknown>).slippage_tolerance_mode)
      .toBe("relative_pct");
    expect(globalConfigToDto(doc.global).risk.slippageToleranceMode)
      .toBe("relative_pct");
    expect(globalConfigToDto({ risk: {} }).risk.slippageToleranceMode)
      .toBe("absolute_price");
  });
});
