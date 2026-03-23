import { describe, expect, it } from "vitest";
import {
  deriveProjectedOutcomeForTest,
  resolveCurrentSyncNumberForMatchForTest,
  resolveCurrentWarSyncIdentityForTest,
  resolveRenderedSyncNumberForStoredSummaryForTest,
} from "../src/commands/Fwa";

describe("fwa match resolved current sync", () => {
  it("derives current sync as previous + 1 for active wars when same-war sync is not persisted", () => {
    const resolved = resolveCurrentSyncNumberForMatchForTest({
      warState: "inWar",
      previousSyncNum: 475,
      currentWarSyncNum: null,
    });

    expect(resolved).toEqual({
      resolvedCurrentSyncNum: 476,
      derivedCurrentSyncNum: 476,
      confirmedCurrentSyncNum: null,
    });
  });

  it("prefers same-war persisted sync over derived previous + 1", () => {
    const resolved = resolveCurrentSyncNumberForMatchForTest({
      warState: "preparation",
      previousSyncNum: 475,
      currentWarSyncNum: 478,
    });

    expect(resolved).toEqual({
      resolvedCurrentSyncNum: 478,
      derivedCurrentSyncNum: 476,
      confirmedCurrentSyncNum: 478,
    });
  });

  it("drops stale CurrentWar warId when live war identity indicates rollover", () => {
    const identity = resolveCurrentWarSyncIdentityForTest({
      warState: "inWar",
      liveWarStartTime: "20260312T090000.000Z",
      liveOpponentTag: "#2NEW",
      currentWarId: 1001,
      currentWarStartTime: new Date("2026-03-10T09:00:00.000Z"),
      currentWarOpponentTag: "#2OLD",
    });

    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-03-12T09:00:00.000Z");
    expect(identity.opponentTag).toBe("2NEW");
  });

  it("uses resolved current sync parity for tie-break projections instead of stale previous sync", () => {
    const resolved = resolveCurrentSyncNumberForMatchForTest({
      warState: "inWar",
      previousSyncNum: 475,
      currentWarSyncNum: null,
    });

    const resolvedOutcome = deriveProjectedOutcomeForTest(
      "B000",
      "A000",
      1000,
      1000,
      resolved.resolvedCurrentSyncNum,
    );
    const staleOutcome = deriveProjectedOutcomeForTest(
      "B000",
      "A000",
      1000,
      1000,
      475,
    );

    expect(resolvedOutcome).toBe("WIN");
    expect(staleOutcome).toBe("LOSE");
  });

  it("renders resolved fallback sync for active war when no same-war persisted row exists", () => {
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      syncRow: null,
      fallbackSyncNum: 476,
      warId: "2002",
      warStartTime: new Date("2026-03-12T09:00:00.000Z"),
      opponentNotFound: false,
      validationState: {
        siteCurrent: false,
        syncRowMissing: true,
        differences: [],
        statusLine: "",
      },
    });

    expect(renderedSync).toBe(476);
  });
});
