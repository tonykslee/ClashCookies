import { describe, expect, it } from "vitest";
import { buildActionableSyncStateLine } from "../src/commands/fwa/syncDisplay";

describe("fwa sync display state mapping", () => {
  it("shows needs validation when no sync checkpoint exists", () => {
    const line = buildActionableSyncStateLine({
      syncRow: null,
      siteCurrent: true,
      differenceCount: 0,
    });

    expect(line).toBe("State: Needs validation");
  });

  it("shows needs validation when lifecycle requires validation", () => {
    const line = buildActionableSyncStateLine({
      syncRow: { needsValidation: true },
      siteCurrent: true,
      differenceCount: 0,
    });

    expect(line).toBe("State: Needs validation");
  });

  it("shows needs validation when current site data has mismatches", () => {
    const line = buildActionableSyncStateLine({
      syncRow: { needsValidation: false },
      siteCurrent: true,
      differenceCount: 2,
    });

    expect(line).toBe("State: Needs validation");
  });

  it("shows confirmed/current for reconciled and in-sync data", () => {
    const line = buildActionableSyncStateLine({
      syncRow: { needsValidation: false },
      siteCurrent: true,
      differenceCount: 0,
    });

    expect(line).toBe("State: Confirmed and current");
    expect(line.includes("Reconciled")).toBe(false);
  });

  it("keeps confirmed/current when site has not published next snapshot yet", () => {
    const line = buildActionableSyncStateLine({
      syncRow: { needsValidation: false },
      siteCurrent: false,
      differenceCount: 0,
    });

    expect(line).toBe("State: Confirmed and current");
  });
});
