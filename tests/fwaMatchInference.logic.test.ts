import { describe, expect, it } from "vitest";
import {
  getMailBlockedReasonFromStatusForTest,
  inferMatchTypeFromPointsSnapshotsForTest,
  resolveMatchTypeFromStoredSyncRowForTest,
} from "../src/commands/Fwa";

describe("fwa match inference from points snapshots", () => {
  it("infers MM when opponent points are unavailable", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: null, activeFwa: null }
    );

    expect(inferred).toMatchObject({
      matchType: "MM",
      source: "points_missing_opponent",
      syncIsFwa: false,
      parsedActiveFwa: null,
    });
  });

  it("infers BL when opponent points exist but Active FWA is NO", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 1234, activeFwa: false }
    );

    expect(inferred).toMatchObject({
      matchType: "BL",
      source: "points_active_fwa_no",
      syncIsFwa: false,
      parsedActiveFwa: false,
    });
  });

  it("infers FWA when opponent points exist and Active FWA is YES", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 1234, activeFwa: true }
    );

    expect(inferred).toMatchObject({
      matchType: "FWA",
      source: "points_active_fwa_yes",
      syncIsFwa: true,
      parsedActiveFwa: true,
    });
  });

  it("infers MM when points site reports clan not found", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: null, activeFwa: null, notFound: true }
    );

    expect(inferred).toMatchObject({
      matchType: "MM",
      source: "points_clan_not_found",
      syncIsFwa: false,
      parsedActiveFwa: null,
    });
  });

  it("infers FWA when opponent points exist and Active FWA signal is missing", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 1234, activeFwa: null }
    );

    expect(inferred).toMatchObject({
      matchType: "FWA",
      source: "points_unknown_signal",
      syncIsFwa: true,
      parsedActiveFwa: null,
    });
  });
});

describe("fwa match stored sync fallback", () => {
  it("maps sync isFwa=false to BL for matching opponent", () => {
    const resolved = resolveMatchTypeFromStoredSyncRowForTest({
      syncRow: {
        opponentTag: "#2ABC",
        isFwa: false,
        lastKnownMatchType: null,
      },
      opponentTag: "#2ABC",
    });

    expect(resolved).toMatchObject({
      matchType: "BL",
      source: "stored_sync",
      inferred: true,
      confirmed: false,
      syncIsFwa: false,
    });
  });

  it("maps sync isFwa=true to FWA for matching opponent", () => {
    const resolved = resolveMatchTypeFromStoredSyncRowForTest({
      syncRow: {
        opponentTag: "#2ABC",
        isFwa: true,
        lastKnownMatchType: null,
      },
      opponentTag: "#2ABC",
    });

    expect(resolved).toMatchObject({
      matchType: "FWA",
      source: "stored_sync",
      inferred: true,
      confirmed: false,
      syncIsFwa: true,
    });
  });
});

describe("fwa mail send gating", () => {
  it("blocks send mail whenever match type is inferred", () => {
    const reason = getMailBlockedReasonFromStatusForTest({
      inferredMatchType: true,
      hasMailChannel: true,
      mailStatus: "no_post_tracked",
    });

    expect(reason).toBe("Match type is inferred. Confirm match type before sending war mail.");
  });
});

