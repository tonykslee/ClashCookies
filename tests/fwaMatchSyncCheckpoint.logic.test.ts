import { describe, expect, it } from "vitest";

import {
  deriveProjectedOutcomeForTest,
  formatFwaPointsSyncDisplayForTest,
  resolveFinalActiveWarSyncNumberForTest,
  resolveRenderedSyncNumberForStoredSummaryForTest,
} from "../src/commands/Fwa";

describe("fwa sync checkpoint render", () => {
  const activeWar = {
    warId: "war-1",
    warStartTime: new Date("2026-08-26T09:00:00.000Z"),
  };

  it("promotes a same-war checkpoint/current observation over stale syncNum", () => {
    const canonicalSync = resolveFinalActiveWarSyncNumberForTest({
      baseSyncNumber: 552,
      row: {
        ...activeWar,
        syncNum: 552,
        lastKnownSyncNumber: 553,
        needsValidation: false,
      },
      observedSyncNumber: 553,
      siteCurrent: true,
      opponentNotFound: true,
      ...activeWar,
    });

    expect(canonicalSync).toBe(553);
    expect(
      formatFwaPointsSyncDisplayForTest(
        resolveRenderedSyncNumberForStoredSummaryForTest({
          canonicalSyncNum: canonicalSync,
        }),
      ),
    ).toBe("#553 (Low Sync)");
    expect(
      deriveProjectedOutcomeForTest("B000", "A000", 1000, 1000, canonicalSync),
    ).toBe("LOSE");
  });

  it("uses a current observation when the checkpoint row is unavailable", () => {
    expect(
      resolveFinalActiveWarSyncNumberForTest({
        baseSyncNumber: null,
        row: null,
        observedSyncNumber: 553,
        siteCurrent: true,
        opponentNotFound: true,
        ...activeWar,
      }),
    ).toBe(553);
  });

  it("does not promote an observed sync without current proof", () => {
    expect(
      resolveFinalActiveWarSyncNumberForTest({
        baseSyncNumber: 552,
        row: null,
        observedSyncNumber: 553,
        siteCurrent: false,
        opponentNotFound: true,
        ...activeWar,
      }),
    ).toBe(552);
  });

  it("does not promote a normal mismatch when opponent-not-found is absent", () => {
    expect(
      resolveFinalActiveWarSyncNumberForTest({
        baseSyncNumber: 552,
        row: {
          ...activeWar,
          syncNum: 552,
          lastKnownSyncNumber: 552,
          needsValidation: false,
        },
        observedSyncNumber: 553,
        siteCurrent: true,
        opponentNotFound: false,
        ...activeWar,
      }),
    ).toBe(552);
  });

  it("allows a separately proven checkpoint from a dirty row, not its raw syncNum", () => {
    expect(
      resolveFinalActiveWarSyncNumberForTest({
        baseSyncNumber: null,
        row: {
          ...activeWar,
          syncNum: 553,
          lastKnownSyncNumber: 553,
          needsValidation: true,
        },
        observedSyncNumber: null,
        siteCurrent: true,
        opponentNotFound: true,
        ...activeWar,
      }),
    ).toBe(553);

    expect(
      resolveFinalActiveWarSyncNumberForTest({
        baseSyncNumber: null,
        row: {
          ...activeWar,
          syncNum: 553,
          lastKnownSyncNumber: null,
          needsValidation: true,
        },
        observedSyncNumber: null,
        siteCurrent: true,
        opponentNotFound: true,
        ...activeWar,
      }),
    ).toBeNull();
  });

  it("rejects a prior-war checkpoint even when the current proof is positive", () => {
    expect(
      resolveFinalActiveWarSyncNumberForTest({
        baseSyncNumber: null,
        row: {
          warId: "old-war",
          warStartTime: new Date("2026-08-25T09:00:00.000Z"),
          syncNum: 552,
          lastKnownSyncNumber: 553,
          needsValidation: false,
        },
        observedSyncNumber: null,
        siteCurrent: true,
        opponentNotFound: true,
        ...activeWar,
      }),
    ).toBeNull();
  });

  it("renders the canonical sync instead of a stale persisted row", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      canonicalSyncNum: 475,
    });

    expect(renderedSync).toBe(475);
  });

  it("renders unknown when canonical resolution is unavailable", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      canonicalSyncNum: null,
    });

    expect(renderedSync).toBeNull();
  });

  it("does not allow a raw prior-war row to override canonical unknown", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      canonicalSyncNum: null,
    });

    expect(renderedSync).toBeNull();
  });

  it("preserves the exact canonical value for normal points-backed state", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      canonicalSyncNum: 475,
    });

    expect(renderedSync).toBe(475);
  });
});
