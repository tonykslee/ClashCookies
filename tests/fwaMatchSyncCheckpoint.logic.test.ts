import { describe, expect, it } from "vitest";

import { resolveRenderedSyncNumberForStoredSummaryForTest } from "../src/commands/Fwa";

const currentValidationState = {
  siteCurrent: true,
  syncRowMissing: false,
  differences: [],
  statusLine: "ok",
} as const;

describe("fwa sync checkpoint render precedence", () => {
  it("prefers newer observed sync when same-war persisted sync is stale and opponent page is not found", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      syncRow: {
        syncNum: 474,
        lastKnownSyncNumber: 474,
        warId: "2001",
        warStartTime: new Date("2026-03-11T08:00:00.000Z"),
      },
      fallbackSyncNum: 475,
      warId: 2001,
      warStartTime: new Date("2026-03-11T08:00:00.000Z"),
      opponentNotFound: true,
      validationState: currentValidationState,
    });

    expect(renderedSync).toBe(475);
  });

  it("keeps newer observed sync when no same-war ClanPointsSync row exists", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      syncRow: null,
      fallbackSyncNum: 475,
      warId: 2001,
      warStartTime: new Date("2026-03-11T08:00:00.000Z"),
      opponentNotFound: true,
      validationState: { ...currentValidationState, syncRowMissing: true },
    });

    expect(renderedSync).toBe(475);
  });

  it("does not allow prior-war persisted sync to override trusted observed sync for active war", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      syncRow: {
        syncNum: 474,
        lastKnownSyncNumber: 474,
        warId: "1999",
        warStartTime: new Date("2026-03-10T08:00:00.000Z"),
      },
      fallbackSyncNum: 475,
      warId: 2001,
      warStartTime: new Date("2026-03-11T08:00:00.000Z"),
      opponentNotFound: true,
      validationState: currentValidationState,
    });

    expect(renderedSync).toBe(475);
  });

  it("preserves normal points-backed precedence outside explicit clan-not-found path", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      syncRow: {
        syncNum: 474,
        lastKnownSyncNumber: 474,
        warId: "2001",
        warStartTime: new Date("2026-03-11T08:00:00.000Z"),
      },
      fallbackSyncNum: 475,
      warId: 2001,
      warStartTime: new Date("2026-03-11T08:00:00.000Z"),
      opponentNotFound: false,
      validationState: currentValidationState,
    });

    expect(renderedSync).toBe(474);
  });
});
