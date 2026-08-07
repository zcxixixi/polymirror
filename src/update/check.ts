import { fetchWithTimeout } from "../util/fetch.js";
import {
  getAppVersion,
  isNewerVersion,
  normalizeVersionLabel,
} from "../version.js";
import { getUpdateJobView, loadUpdateState, reconcileJobAfterRestart } from "./apply-state.js";
import { isRunningInDocker, selfUpdateEnabled } from "./paths.js";

const DEFAULT_REPO = "laoshalab/polymirror";
const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

export interface UpdateCheckResult {
  enabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  checkedAt: number | null;
  /** Apply requires a formal GitHub Release (not tag-only). */
  source: "release" | "tag" | null;
  prerelease: boolean;
  error: string | null;
}

export interface SelfUpdateInfo {
  enabled: boolean;
  supported: boolean;
  blockReason: string | null;
  canApply: boolean;
  canRollback: boolean;
  rollbackVersion: string | null;
  confirmPhrase: string | null;
  rollbackConfirmPhrase: string | null;
  job: ReturnType<typeof getUpdateJobView>;
}

export interface UpdateApiResponse extends UpdateCheckResult {
  selfUpdate: SelfUpdateInfo;
}

interface CacheEntry {
  result: UpdateCheckResult;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<UpdateCheckResult> | null = null;

export function githubRepoSlug(): string {
  const raw = process.env.POLYMIRROR_GITHUB_REPO?.trim();
  if (raw && /^[\w.-]+\/[\w.-]+$/.test(raw)) return raw;
  return DEFAULT_REPO;
}

export function updatesCheckEnabled(): boolean {
  const v = process.env.POLYMIRROR_UPDATE_CHECK?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

export function githubHeaders(accept = "application/vnd.github+json"): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": `PolyMirror/${getAppVersion()}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.POLYMIRROR_GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function disabledResult(currentVersion: string, error: string | null = null): UpdateCheckResult {
  return {
    enabled: false,
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseName: null,
    publishedAt: null,
    checkedAt: null,
    source: null,
    prerelease: false,
    error,
  };
}

export interface GhRelease {
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  tarball_url?: string;
}

interface GhTag {
  name?: string;
}

export interface ResolvedRelease {
  latestVersion: string;
  tagName: string;
  releaseUrl: string;
  releaseName: string | null;
  publishedAt: string | null;
  source: "release" | "tag";
  prerelease: boolean;
  tarballUrl: string;
}

function tagToTarballUrl(repo: string, tag: string): string {
  return `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
}

export async function fetchLatestFromGithub(repo: string): Promise<ResolvedRelease> {
  const headers = githubHeaders();

  const releaseRes = await fetchWithTimeout(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { headers, timeoutMs: FETCH_TIMEOUT_MS }
  );

  if (releaseRes.ok) {
    const data = (await releaseRes.json()) as GhRelease;
    const tag = data.tag_name?.trim();
    if (tag && !data.draft) {
      return {
        latestVersion: normalizeVersionLabel(tag),
        tagName: tag,
        releaseUrl: data.html_url || `https://github.com/${repo}/releases/tag/${tag}`,
        releaseName: data.name?.trim() || tag,
        publishedAt: data.published_at ?? null,
        source: "release",
        prerelease: !!data.prerelease,
        tarballUrl: data.tarball_url || tagToTarballUrl(repo, tag),
      };
    }
  } else if (releaseRes.status !== 404) {
    const text = await releaseRes.text();
    throw new Error(`GitHub releases HTTP ${releaseRes.status}: ${text.slice(0, 200)}`);
  }

  const tagsRes = await fetchWithTimeout(
    `https://api.github.com/repos/${repo}/tags?per_page=20`,
    { headers, timeoutMs: FETCH_TIMEOUT_MS }
  );
  if (!tagsRes.ok) {
    const text = await tagsRes.text();
    throw new Error(`GitHub tags HTTP ${tagsRes.status}: ${text.slice(0, 200)}`);
  }

  const tags = (await tagsRes.json()) as GhTag[];
  for (const tag of tags) {
    const name = tag.name?.trim();
    if (!name) continue;
    if (!normalizeVersionLabel(name).match(/^\d+\.\d+\.\d+/)) continue;
    return {
      latestVersion: normalizeVersionLabel(name),
      tagName: name,
      releaseUrl: `https://github.com/${repo}/releases/tag/${name}`,
      releaseName: name,
      publishedAt: null,
      source: "tag",
      prerelease: false,
      tarballUrl: tagToTarballUrl(repo, name),
    };
  }

  throw new Error("No versioned GitHub release or tag found");
}

/** Resolve a specific SemVer to a published (non-draft) GitHub Release — required for apply. */
export async function fetchReleaseByVersion(version: string): Promise<ResolvedRelease> {
  const repo = githubRepoSlug();
  const want = normalizeVersionLabel(version);
  const headers = githubHeaders();
  const tagCandidates = [`v${want}`, want];

  for (const tag of tagCandidates) {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { headers, timeoutMs: FETCH_TIMEOUT_MS }
    );
    if (res.status === 404) continue;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub release lookup HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as GhRelease;
    const tagName = data.tag_name?.trim();
    if (!tagName || data.draft) {
      throw new Error(`GitHub release ${tag} is missing or draft`);
    }
    if (data.prerelease) {
      throw new Error(`Refusing prerelease ${tagName} — only stable Releases can be applied`);
    }
    return {
      latestVersion: normalizeVersionLabel(tagName),
      tagName,
      releaseUrl: data.html_url || `https://github.com/${repo}/releases/tag/${tagName}`,
      releaseName: data.name?.trim() || tagName,
      publishedAt: data.published_at ?? null,
      source: "release",
      prerelease: false,
      tarballUrl: data.tarball_url || tagToTarballUrl(repo, tagName),
    };
  }

  throw new Error(
    `No formal GitHub Release for v${want}. Tag-only sources cannot be auto-applied.`
  );
}

async function fetchFresh(): Promise<UpdateCheckResult> {
  const currentVersion = getAppVersion();
  if (!updatesCheckEnabled()) {
    return disabledResult(currentVersion);
  }

  const repo = githubRepoSlug();
  try {
    const remote = await fetchLatestFromGithub(repo);
    const newer = isNewerVersion(remote.latestVersion, currentVersion);
    // Installable updates = formal stable Release only. Prereleases / tag-only
    // still surface in latestVersion but do not flip updateAvailable.
    const installable =
      newer && remote.source === "release" && !remote.prerelease;
    return {
      enabled: true,
      currentVersion,
      latestVersion: remote.latestVersion,
      updateAvailable: installable,
      releaseUrl: remote.releaseUrl,
      releaseName: remote.releaseName,
      publishedAt: remote.publishedAt,
      checkedAt: Date.now(),
      source: remote.source,
      prerelease: remote.prerelease,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      enabled: true,
      currentVersion,
      latestVersion: cache?.result.latestVersion ?? null,
      updateAvailable: cache?.result.updateAvailable ?? false,
      releaseUrl: cache?.result.releaseUrl ?? `https://github.com/${repo}/releases`,
      releaseName: cache?.result.releaseName ?? null,
      publishedAt: cache?.result.publishedAt ?? null,
      checkedAt: Date.now(),
      source: cache?.result.source ?? null,
      prerelease: cache?.result.prerelease ?? false,
      error: msg,
    };
  }
}

/**
 * Check GitHub for a newer release/tag than the local package version.
 * Results are cached (~30m). Pass `force` to bypass TTL.
 */
export async function checkForUpdate(opts: { force?: boolean } = {}): Promise<UpdateCheckResult> {
  const currentVersion = getAppVersion();
  if (!updatesCheckEnabled()) {
    return disabledResult(currentVersion);
  }

  const now = Date.now();
  if (!opts.force && cache && cache.expiresAt > now) {
    return cache.result;
  }

  if (!opts.force && inFlight) {
    return inFlight;
  }

  inFlight = fetchFresh()
    .then((result) => {
      if (result.error && cache?.result && !cache.result.error) {
        const merged: UpdateCheckResult = {
          ...cache.result,
          currentVersion: result.currentVersion,
          checkedAt: result.checkedAt,
          error: result.error,
        };
        cache = { result: merged, expiresAt: now + Math.min(CACHE_TTL_MS, 5 * 60 * 1000) };
        return merged;
      }
      cache = { result, expiresAt: now + CACHE_TTL_MS };
      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export function buildSelfUpdateInfo(
  check: UpdateCheckResult,
  opts: { anyLive: boolean }
): SelfUpdateInfo {
  reconcileJobAfterRestart();
  const state = loadUpdateState();
  const job = getUpdateJobView(state);
  const rollbackVersion = state.rollback?.version ?? null;
  const enabled = selfUpdateEnabled();
  const inDocker = isRunningInDocker();

  const reasons: string[] = [];
  if (!enabled) {
    reasons.push("Self-update is disabled. Set POLYMIRROR_SELF_UPDATE=true in .env to opt in.");
  } else if (inDocker) {
    reasons.push(
      "Self-update is not supported inside Docker. Rebuild/redeploy the image on the host instead."
    );
  }

  if (job?.active || job?.phase === "restarting") {
    reasons.push(`Update job in progress (${job.phase}).`);
  }

  if (opts.anyLive) {
    reasons.push("Switch all accounts to Preview (or stop Live) before applying or rolling back.");
  }

  if (check.updateAvailable && check.source && check.source !== "release") {
    reasons.push("Only formal GitHub Releases can be applied (tag-only is not enough).");
  }
  if (check.prerelease) {
    reasons.push("Refusing prerelease — only stable GitHub Releases can be applied.");
  }
  if (check.error) {
    reasons.push(check.error);
  }

  const envOk = enabled && !inDocker;
  const idle = !job?.active && job?.phase !== "restarting";

  const canApply =
    envOk &&
    idle &&
    !opts.anyLive &&
    !!check.updateAvailable &&
    !!check.latestVersion &&
    check.source === "release" &&
    !check.prerelease &&
    !check.error;

  const canRollback = envOk && idle && !opts.anyLive && !!rollbackVersion;

  return {
    enabled,
    supported: envOk,
    blockReason: reasons[0] ?? null,
    canApply,
    canRollback,
    rollbackVersion,
    confirmPhrase: check.latestVersion ? `UPDATE_TO_${check.latestVersion}` : null,
    rollbackConfirmPhrase: rollbackVersion ? `ROLLBACK_TO_${rollbackVersion}` : null,
    job,
  };
}

export async function getUpdateApiResponse(opts: {
  force?: boolean;
  anyLive: boolean;
}): Promise<UpdateApiResponse> {
  const check = await checkForUpdate({ force: opts.force });
  return {
    ...check,
    selfUpdate: buildSelfUpdateInfo(check, { anyLive: opts.anyLive }),
  };
}

/** Test helper. */
export function resetUpdateCheckCache(): void {
  cache = null;
  inFlight = null;
}
