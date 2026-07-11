import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/patch-polymarket-client.mjs");
const credentialsNeedle =
  "try{if((await $a(Ce)).includes(s.credentials.key))return Ce}catch(T){if(!(T instanceof d)||T.status!==401)throw T}";
const roots: string[] = [];

function makeSdkRoot(indexSource: string, version = "0.1.0-beta.14") {
  const root = mkdtempSync(join(tmpdir(), "pm-sdk-patch-"));
  roots.push(root);
  const packagePath = join(root, "node_modules/@polymarket/client/package.json");
  const indexPath = join(root, "node_modules/@polymarket/client/dist/index.js");
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(packagePath, JSON.stringify({ version }), "utf8");
  writeFileSync(indexPath, indexSource, "utf8");
  return { root, indexPath };
}

function runPatch(root: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, POLYMIRROR_SDK_PATCH_ROOT: root },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("@polymarket/client postinstall patch", () => {
  it("patches beta.14 credentials exactly once and is idempotent", () => {
    const { root, indexPath } = makeSdkRoot(`prefix;${credentialsNeedle};suffix`);

    const first = runPatch(root);
    expect(first.status, first.stderr).toBe(0);
    const patched = readFileSync(indexPath, "utf8");
    expect(patched.match(/POLYMIRROR_TRUST_ENV_CREDENTIALS/g)).toHaveLength(1);
    expect(patched).not.toContain(credentialsNeedle);

    const second = runPatch(root);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(indexPath, "utf8")).toBe(patched);
  });

  it("fails closed when the pinned SDK build does not match", () => {
    const { root } = makeSdkRoot(credentialsNeedle, "0.1.0-beta.15");
    const result = runPatch(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected @polymarket/client 0.1.0-beta.14");
  });

  it("fails closed when the expected credentials target is absent", () => {
    const { root } = makeSdkRoot("export const changedSdkBuild = true;");
    const result = runPatch(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("credentials patch target count was 0");
  });

  it("contains no legacy wallet-classification patch or bypass", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).not.toContain("__POLYMIRROR_RELAYER_WALLETS__");
    expect(script).not.toContain("POLYMIRROR_ALLOW_UNPATCHED_SDK");
  });
});
