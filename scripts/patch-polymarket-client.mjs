/**
 * Patches the pinned @polymarket/client build to trust supplied CLOB credentials
 * when the authenticated fetchApiKeys request succeeds.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = process.env.POLYMIRROR_SDK_PATCH_ROOT
  ? resolve(process.env.POLYMIRROR_SDK_PATCH_ROOT)
  : repoRoot;
const packagePath = join(root, "node_modules/@polymarket/client/package.json");
const indexPath = join(root, "node_modules/@polymarket/client/dist/index.js");
const EXPECTED_VERSION = "0.1.0-beta.14";

const CREDENTIALS_NEEDLE =
  "try{if((await $a(Ce)).includes(s.credentials.key))return Ce}catch(T){if(!(T instanceof d)||T.status!==401)throw T}";
const CREDENTIALS_MARKER = "POLYMIRROR_TRUST_ENV_CREDENTIALS";
const CREDENTIALS_REPLACEMENT =
  `try{await $a(Ce);/*${CREDENTIALS_MARKER}*/return Ce}catch(T){if(!(T instanceof d)||T.status!==401)throw T}`;

class SdkPatchError extends Error {}

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function requirePinnedVersion() {
  if (!existsSync(packagePath)) {
    throw new SdkPatchError(
      `@polymarket/client package metadata not found at ${packagePath}. Run "npm ci" first.`
    );
  }
  const installedVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  if (installedVersion !== EXPECTED_VERSION) {
    throw new SdkPatchError(
      `expected @polymarket/client ${EXPECTED_VERSION}, found ${String(installedVersion)}`
    );
  }
}

function patchCredentials() {
  const label = "@polymarket/client/dist/index.js";
  const path = indexPath;
  if (!existsSync(path)) {
    throw new SdkPatchError(
      `${label} not found at ${path}. Run "npm ci" first.`
    );
  }
  const src = readFileSync(path, "utf8");
  const markerCount = occurrenceCount(src, CREDENTIALS_MARKER);
  const replacementCount = occurrenceCount(src, CREDENTIALS_REPLACEMENT);
  const targetCount = occurrenceCount(src, CREDENTIALS_NEEDLE);

  if (markerCount === 1 && replacementCount === 1 && targetCount === 0) {
    return false;
  }
  if (markerCount !== 0 || replacementCount !== 0) {
    throw new SdkPatchError(
      `${label}: credentials patch marker/replacement is inconsistent ` +
        `(marker=${markerCount}, replacement=${replacementCount}, target=${targetCount})`
    );
  }
  if (targetCount !== 1) {
    throw new SdkPatchError(
      `${label}: credentials patch target count was ${targetCount}, expected exactly 1. ` +
        `The pinned SDK build may have changed; review before updating this patch.`
    );
  }

  writeFileSync(path, src.replace(CREDENTIALS_NEEDLE, CREDENTIALS_REPLACEMENT), "utf8");
  console.log(`patch-polymarket-client: applied ${CREDENTIALS_MARKER} in ${label}`);
  return true;
}

function main() {
  try {
    requirePinnedVersion();
    patchCredentials();
  } catch (e) {
    if (e instanceof SdkPatchError) {
      console.error(`patch-polymarket-client: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
