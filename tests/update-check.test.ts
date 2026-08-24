import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("version helpers", () => {
  it("parses and compares SemVer tags", async () => {
    const { parseSemver, isNewerVersion, normalizeVersionLabel } = await import(
      "../src/version.js"
    );
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("1.0.0-beta")).toEqual([1, 0, 0]);
    expect(normalizeVersionLabel("v2.1.0")).toBe("2.1.0");
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
  });

  it("reads version from package.json", async () => {
    const { getAppVersion, resetAppVersionCache } = await import("../src/version.js");
    resetAppVersionCache();
    expect(getAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("update check", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    delete process.env.POLYMIRROR_UPDATE_CHECK;
    delete process.env.POLYMIRROR_GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
    delete process.env.POLYMIRROR_GITHUB_TOKEN;
    delete process.env.POLYMIRROR_SELF_UPDATE;
    delete process.env.POLYMIRROR_IN_DOCKER;
    vi.doMock("../src/util/fetch.js", () => ({
      fetchWithTimeout: mockFetch,
    }));
  });

  afterEach(() => {
    vi.doUnmock("../src/util/fetch.js");
    vi.resetModules();
  });

  it("can be disabled via env", async () => {
    process.env.POLYMIRROR_UPDATE_CHECK = "false";
    const { checkForUpdate, resetUpdateCheckCache } = await import("../src/update/check.js");
    resetUpdateCheckCache();
    const result = await checkForUpdate();
    expect(result.enabled).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports update when GitHub latest release is newer", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v9.9.9",
        name: "PolyMirror 9.9.9",
        html_url: "https://github.com/laoshalab/polymirror/releases/tag/v9.9.9",
        published_at: "2026-08-01T00:00:00Z",
        draft: false,
        prerelease: false,
        tarball_url: "https://api.github.com/repos/laoshalab/polymirror/tarball/v9.9.9",
      }),
    });

    const { checkForUpdate, resetUpdateCheckCache } = await import("../src/update/check.js");
    resetUpdateCheckCache();
    const result = await checkForUpdate({ force: true });

    expect(result.enabled).toBe(true);
    expect(result.latestVersion).toBe("9.9.9");
    expect(result.updateAvailable).toBe(true);
    expect(result.releaseUrl).toContain("v9.9.9");
    expect(result.source).toBe("release");
    expect(result.error).toBeNull();
  });

  it("falls back to tags when releases/latest is 404", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ name: "v8.8.8" }, { name: "other" }],
      });

    const { checkForUpdate, resetUpdateCheckCache } = await import("../src/update/check.js");
    resetUpdateCheckCache();
    const result = await checkForUpdate({ force: true });

    expect(result.latestVersion).toBe("8.8.8");
    expect(result.source).toBe("tag");
    // Tag-only is visible but not an installable update.
    expect(result.updateAvailable).toBe(false);
  });

  it("caches successful checks within TTL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v9.9.9",
        name: "9.9.9",
        html_url: "https://example.com/r",
        draft: false,
        prerelease: false,
      }),
    });

    const { checkForUpdate, resetUpdateCheckCache } = await import("../src/update/check.js");
    resetUpdateCheckCache();
    await checkForUpdate({ force: true });
    await checkForUpdate();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not mark update when remote equals local", async () => {
    const { getAppVersion, resetAppVersionCache } = await import("../src/version.js");
    resetAppVersionCache();
    const current = getAppVersion();

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: `v${current}`,
        name: current,
        html_url: "https://example.com/r",
        draft: false,
        prerelease: false,
      }),
    });

    const { checkForUpdate, resetUpdateCheckCache } = await import("../src/update/check.js");
    resetUpdateCheckCache();
    const result = await checkForUpdate({ force: true });
    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe(current);
  });
});

describe("self-update gates", () => {
  let tmp: string;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.POLYMIRROR_SELF_UPDATE;
    delete process.env.POLYMIRROR_IN_DOCKER;
    tmp = mkdtempSync(join(tmpdir(), "pm-update-"));
    mkdirSync(join(tmp, "data", "updates"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it("requires confirmation phrase and opt-in", async () => {
    const { startApplyUpdate, applyConfirmPhrase } = await import("../src/update/apply.js");

    const denied = startApplyUpdate({
      version: "9.9.9",
      confirm: applyConfirmPhrase("9.9.9"),
      anyLive: false,
    });
    expect(denied.status).toBe(400);
    expect(String((denied.body as { error: string }).error)).toMatch(/POLYMIRROR_SELF_UPDATE/);

    process.env.POLYMIRROR_SELF_UPDATE = "true";
    vi.resetModules();
    const apply = await import("../src/update/apply.js");

    const badConfirm = apply.startApplyUpdate({
      version: "9.9.9",
      confirm: "yes",
      anyLive: false,
    });
    expect(badConfirm.status).toBe(400);
    expect((badConfirm.body as { confirmPhrase: string }).confirmPhrase).toBe("UPDATE_TO_9.9.9");

    const liveBlocked = apply.startApplyUpdate({
      version: "9.9.9",
      confirm: "UPDATE_TO_9.9.9",
      anyLive: true,
    });
    expect(liveBlocked.status).toBe(400);
    expect(String((liveBlocked.body as { error: string }).error)).toMatch(/Live/);
  });

  it("buildSelfUpdateInfo blocks tag-only apply", async () => {
    process.env.POLYMIRROR_SELF_UPDATE = "true";
    const { buildSelfUpdateInfo } = await import("../src/update/check.js");
    const info = buildSelfUpdateInfo(
      {
        enabled: true,
        currentVersion: "1.0.0",
        latestVersion: "9.9.9",
        updateAvailable: true,
        releaseUrl: "https://example.com",
        releaseName: "v9.9.9",
        publishedAt: null,
        checkedAt: Date.now(),
        source: "tag",
        prerelease: false,
        error: null,
      },
      { anyLive: false }
    );
    expect(info.canApply).toBe(false);
    expect(info.blockReason).toMatch(/formal GitHub Releases/i);
  });

  it("persists and reconciles restarting job", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { updateStatePath } = await import("../src/update/paths.js");
    const realPath = updateStatePath();
    mkdirSync(join(realPath, ".."), { recursive: true });
    const backup = existsSync(realPath) ? readFileSync(realPath, "utf8") : null;

    try {
      const { getAppVersion, resetAppVersionCache } = await import("../src/version.js");
      resetAppVersionCache();
      const current = getAppVersion();
      writeFileSync(
        realPath,
        JSON.stringify({
          job: {
            id: "apply-1",
            action: "apply",
            phase: "restarting",
            targetVersion: current,
            fromVersion: "0.9.0",
            error: null,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            logTail: [],
          },
          rollback: null,
          lastSuccess: null,
        }),
        "utf8"
      );

      const { reconcileJobAfterRestart, loadUpdateState } = await import(
        "../src/update/apply-state.js"
      );
      reconcileJobAfterRestart();
      const state = loadUpdateState();
      expect(state.job?.phase).toBe("succeeded");
      expect(state.lastSuccess?.version).toBe(current);
    } finally {
      if (backup == null) rmSync(realPath, { force: true });
      else writeFileSync(realPath, backup, "utf8");
    }
  });

  it("job lock is exclusive until released", async () => {
    const { tryAcquireUpdateJobLock, releaseUpdateJobLock, resetUpdateJobLockForTests } =
      await import("../src/update/job-lock.js");
    resetUpdateJobLockForTests();
    expect(tryAcquireUpdateJobLock()).toBe(true);
    expect(tryAcquireUpdateJobLock()).toBe(false);
    releaseUpdateJobLock();
    expect(tryAcquireUpdateJobLock()).toBe(true);
    releaseUpdateJobLock();
  });

  it("rejects second apply while lock held via startApplyUpdate", async () => {
    process.env.POLYMIRROR_SELF_UPDATE = "true";
    const { tryAcquireUpdateJobLock, releaseUpdateJobLock, resetUpdateJobLockForTests } =
      await import("../src/update/job-lock.js");
    resetUpdateJobLockForTests();
    expect(tryAcquireUpdateJobLock()).toBe(true);

    const { startApplyUpdate } = await import("../src/update/apply.js");
    const res = startApplyUpdate({
      version: "9.9.9",
      confirm: "UPDATE_TO_9.9.9",
      anyLive: false,
    });
    expect(res.status).toBe(409);
    releaseUpdateJobLock();
  });
});
