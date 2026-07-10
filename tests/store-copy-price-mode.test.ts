import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("StateStore copy price mode", () => {
  it("preflights an empty database without binding the requested mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-preflight-"));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, "preview.db"));
    try {
      expect(store.getCopyPriceModeCompatibility("executable_guarded")).toEqual({
        mode: "executable_guarded",
        status: "unbound",
      });
      expect(store.ensureCopyPriceMode("leader_limit")).toEqual({
        mode: "leader_limit",
        status: "bound",
      });
    } finally {
      store.close();
    }
  });

  it("binds an empty database once and rejects later mode changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-store-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "preview.db");
    const store = new StateStore(dbPath);
    try {
      expect(store.ensureCopyPriceMode("executable_guarded")).toMatchObject({
        mode: "executable_guarded",
        status: "bound",
      });
      expect(store.ensureCopyPriceMode("leader_limit")).toEqual({
        mode: "executable_guarded",
        status: "mismatch",
      });
    } finally {
      store.close();
    }

    const reopened = new StateStore(dbPath);
    try {
      expect(reopened.ensureCopyPriceMode("executable_guarded")).toEqual({
        mode: "executable_guarded",
        status: "matched",
      });
    } finally {
      reopened.close();
    }
  });

  it("backfills legacy COPY history as leader_limit before checking a requested mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-legacy-store-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "preview.db");
    const legacy = new StateStore(dbPath);
    try {
      legacy.audit({
        leaderId: "leader-a",
        action: "COPY",
        tokenId: "token-a",
        side: "BUY",
        preview: true,
      });
    } finally {
      legacy.close();
    }

    const store = new StateStore(dbPath);
    try {
      expect(store.ensureCopyPriceMode("executable_guarded")).toEqual({
        mode: "leader_limit",
        status: "mismatch",
      });
      expect(store.ensureCopyPriceMode("leader_limit")).toEqual({
        mode: "leader_limit",
        status: "matched",
      });
    } finally {
      store.close();
    }
  });

  it("backfills a pending-only legacy database as leader_limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-pending-store-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "preview.db");
    const legacy = new StateStore(dbPath);
    try {
      legacy.upsertPendingOrder({
        orderId: "legacy-gtc",
        leaderId: "leader-a",
        tokenId: "token-a",
        side: "BUY",
        price: 0.5,
        size: 2,
        filledShares: 0,
        tradeKey: "legacy-key",
        reasoning: "legacy",
      });
    } finally {
      legacy.close();
    }

    const store = new StateStore(dbPath);
    try {
      expect(store.ensureCopyPriceMode("executable_guarded")).toEqual({
        mode: "leader_limit",
        status: "mismatch",
      });
    } finally {
      store.close();
    }
  });

  it.each([
    ["positions", (store: StateStore) => store.applyCopyFill("leader-a", "token-a", "BUY", 2, 0.5)],
    ["seen trades", (store: StateStore) => store.markSeen("legacy-key", "leader-a")],
    ["cash ledger", (store: StateStore) => store.adjustCash(-1, 100)],
    ["daily state", (store: StateStore) => store.addDailyVolume(1)],
    [
      "live order intents",
      (store: StateStore) =>
        store.recordLiveOrderIntent({
          tradeKeys: ["legacy-key"],
          leaderId: "leader-a",
          tokenId: "token-a",
          side: "BUY",
          price: 0.5,
          orderSize: 2,
          auditReason: "legacy",
        }),
    ],
    [
      "COPY audit history",
      (store: StateStore) =>
        store.audit({ action: "COPY", leaderId: "leader-a", tokenId: "token-a", preview: true }),
    ],
    [
      "REDEEM audit history",
      (store: StateStore) =>
        store.audit({ action: "REDEEM", leaderId: "leader-a", tokenId: "token-a", preview: true }),
    ],
  ])("treats %s as legacy state", (_name, seed) => {
    const directory = mkdtempSync(join(tmpdir(), "polymirror-copy-price-legacy-state-"));
    temporaryDirectories.push(directory);
    const store = new StateStore(join(directory, "preview.db"));
    try {
      seed(store);
      expect(store.getCopyPriceModeCompatibility("executable_guarded")).toEqual({
        mode: "leader_limit",
        status: "mismatch",
      });
    } finally {
      store.close();
    }
  });
});
