import { describe, expect, it } from "vitest";
import { isDefiniteOrderRejection } from "../src/executor/clob.js";
import { assertDashboardAuthForBind, isLocalBindAddress } from "../src/api/auth.js";

describe("isDefiniteOrderRejection", () => {
  it("detects balance and validation errors", () => {
    expect(isDefiniteOrderRejection("insufficient balance")).toBe(true);
    expect(isDefiniteOrderRejection("Invalid price")).toBe(true);
    expect(isDefiniteOrderRejection("ECONNRESET")).toBe(false);
    expect(isDefiniteOrderRejection("fetch failed")).toBe(false);
  });
});

describe("assertDashboardAuthForBind", () => {
  it("allows localhost binds without token", () => {
    expect(isLocalBindAddress("127.0.0.1")).toBe(true);
    expect(() => assertDashboardAuthForBind("127.0.0.1")).not.toThrow();
  });

  it("requires token on public bind", () => {
    const prev = process.env.DASHBOARD_TOKEN;
    const prevEnabled = process.env.DASHBOARD_ENABLED;
    delete process.env.DASHBOARD_TOKEN;
    delete process.env.DASHBOARD_ENABLED;
    try {
      expect(() => assertDashboardAuthForBind("0.0.0.0")).toThrow(/DASHBOARD_TOKEN/);
    } finally {
      if (prev !== undefined) process.env.DASHBOARD_TOKEN = prev;
      if (prevEnabled !== undefined) process.env.DASHBOARD_ENABLED = prevEnabled;
    }
  });

  it("allows explicit unauthenticated public dashboard", () => {
    const prev = process.env.DASHBOARD_TOKEN;
    const prevEnabled = process.env.DASHBOARD_ENABLED;
    delete process.env.DASHBOARD_TOKEN;
    process.env.DASHBOARD_ENABLED = "false";
    try {
      expect(() => assertDashboardAuthForBind("0.0.0.0")).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.DASHBOARD_TOKEN = prev;
      else delete process.env.DASHBOARD_TOKEN;
      if (prevEnabled !== undefined) process.env.DASHBOARD_ENABLED = prevEnabled;
      else delete process.env.DASHBOARD_ENABLED;
    }
  });
});
