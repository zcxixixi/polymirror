import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPreviewAccountReport } from "../src/sim/preview-report.js";
import { generatePreviewAccountsReport } from "../src/sim/preview-report-runner.js";
import { StateStore } from "../src/state/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("copy price mode reporting", () => {
  it("defaults preview account reports to leader_limit and accepts executable_guarded", () => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-report-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "missing.db");

    expect(
      readPreviewAccountReport({ accountId: "default", dbPath }).copyPriceMode
    ).toBe("leader_limit");
    expect(
      readPreviewAccountReport({
        accountId: "guarded",
        dbPath,
        copyPriceMode: "executable_guarded",
      }).copyPriceMode
    ).toBe("executable_guarded");
  });

  it("passes copy price mode through the account mapping with a safe default", () => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-runner-"));
    temporaryDirectories.push(directory);
    const result = generatePreviewAccountsReport({
      accounts: ["guarded", "legacy"],
      dataDir: join(directory, "accounts"),
      outDir: join(directory, "reports"),
      copyPriceModeByAccount: { guarded: "executable_guarded" },
    });

    expect(
      result.reports.find((report) => report.accountId === "guarded")?.copyPriceMode
    ).toBe("executable_guarded");
    expect(
      result.reports.find((report) => report.accountId === "legacy")?.copyPriceMode
    ).toBe("leader_limit");
  });

  it("reports legacy COPY history as leader_limit even when guarded is requested", () => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-legacy-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "preview.db");
    const store = new StateStore(dbPath);
    try {
      store.audit({
        leaderId: "leader-a",
        action: "COPY",
        tokenId: "token-a",
        side: "BUY",
        preview: true,
      });
    } finally {
      store.close();
    }

    expect(
      readPreviewAccountReport({
        accountId: "legacy",
        dbPath,
        copyPriceMode: "executable_guarded",
      }).copyPriceMode
    ).toBe("leader_limit");
  });

  it("reports the persisted guarded mode instead of a conflicting report option", () => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-guarded-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "preview.db");
    const store = new StateStore(dbPath);
    try {
      expect(store.ensureCopyPriceMode("executable_guarded")).toMatchObject({
        mode: "executable_guarded",
        status: "bound",
      });
    } finally {
      store.close();
    }

    expect(
      readPreviewAccountReport({
        accountId: "guarded",
        dbPath,
        copyPriceMode: "leader_limit",
      }).copyPriceMode
    ).toBe("executable_guarded");
  });
});
