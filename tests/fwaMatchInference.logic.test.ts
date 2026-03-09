import { describe, expect, it } from "vitest";
import {
  getMailBlockedReasonFromStatusForTest,
  inferMatchTypeFromPointsSnapshotsForTest,
  resolveMatchTypeFromStoredSyncRowForTest,
} from "../src/commands/Fwa";
import {
  chooseMatchTypeResolution,
  resolveCurrentWarMatchTypeSignal,
} from "../src/services/MatchTypeResolutionService";

describe("fwa match inference from points snapshots", () => {
  it("returns null when opponent evidence is unavailable", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: null, activeFwa: null }
    );

    expect(inferred).toBeNull();
  });

  it("infers BL when opponent points exist but Active FWA is NO", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 1234, activeFwa: false }
    );

    expect(inferred).toMatchObject({
      matchType: "BL",
      source: "live_points_active_fwa_no",
      syncIsFwa: false,
    });
  });

  it("infers FWA when opponent points exist and Active FWA is YES", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 1234, activeFwa: true }
    );

    expect(inferred).toMatchObject({
      matchType: "FWA",
      source: "live_points_active_fwa_yes",
      syncIsFwa: true,
    });
  });

  it("infers MM when points site reports clan not found", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: null, activeFwa: null, notFound: true }
    );

    expect(inferred).toMatchObject({
      matchType: "MM",
      source: "live_points_clan_not_found",
      syncIsFwa: false,
    });
  });

  it("returns null when Active FWA signal is missing", () => {
    const inferred = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 1234, activeFwa: null }
    );

    expect(inferred).toBeNull();
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

describe("fwa match precedence", () => {
  it("lets live BL evidence override unconfirmed current/stored FWA", () => {
    const current = resolveCurrentWarMatchTypeSignal({
      matchType: "FWA",
      inferredMatchType: true,
    });
    const stored = resolveMatchTypeFromStoredSyncRowForTest({
      syncRow: {
        opponentTag: "#2Q80R9PYU",
        isFwa: true,
        lastKnownMatchType: "FWA",
      },
      opponentTag: "#2Q80R9PYU",
    });
    const live = inferMatchTypeFromPointsSnapshotsForTest(
      { activeFwa: true },
      { balance: 2, activeFwa: false, notFound: false }
    );
    const resolved = chooseMatchTypeResolution({
      confirmedCurrent: current.confirmed,
      liveOpponent: live,
      storedSync: stored,
      unconfirmedCurrent: current.unconfirmed,
    });

    expect(resolved).toMatchObject({
      matchType: "BL",
      source: "live_points_active_fwa_no",
      inferred: true,
      confirmed: false,
      syncIsFwa: false,
    });
  });
});

