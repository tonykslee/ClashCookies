import { describe, expect, it } from "vitest";
import {
  resolveCurrentWarScopedSyncRowForTest,
  deriveProjectedOutcomeForTest,
  resolveRenderedSyncNumberForStoredSummaryForTest,
} from "../src/commands/Fwa";
import {
  buildActiveWarSyncIdentity,
  resolveActiveWarSyncNumber,
  resolveCurrentWarSyncIdentity,
} from "../src/services/ActiveWarSyncResolutionService";

describe("fwa match resolved current sync", () => {
  it("derives current sync as latest persisted + 1 for active wars when same-war sync is not persisted", () => {
    const resolved = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "2001",
      }),
      latestPersistedSyncNumber: 475,
      sameWarPersistedSyncNumber: null,
    });

    expect(resolved).toMatchObject({
      syncNumber: 476,
      source: "derived_latest_plus_one",
      isDerived: true,
    });
  });

  it("prefers same-war persisted sync over derived latest + 1", () => {
    const resolved = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "preparation",
        warId: "2002",
      }),
      latestPersistedSyncNumber: 475,
      sameWarPersistedSyncNumber: 478,
    });

    expect(resolved).toMatchObject({
      syncNumber: 478,
      source: "same_war_persisted",
      isDerived: false,
    });
  });

  it("drops stale CurrentWar warId when live war identity indicates rollover", () => {
    const identity = resolveCurrentWarSyncIdentity({
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
    expect(identity.positivelyResolved).toBe(true);
  });

  it("uses resolved current sync parity for tie-break projections instead of stale persisted sync", () => {
    const resolved = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "2003",
      }),
      latestPersistedSyncNumber: 475,
      sameWarPersistedSyncNumber: null,
    });

    const resolvedOutcome = deriveProjectedOutcomeForTest(
      "B000",
      "A000",
      1000,
      1000,
      resolved.syncNumber,
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

  it("prefers warStartTime over a stale same-warId sync row when both are available", () => {
    const resolved = resolveCurrentWarScopedSyncRowForTest({
      rows: [
        {
          warId: "1001",
          warStartTime: new Date("2026-03-10T09:00:00.000Z"),
          opponentTag: "#2OLD",
          needsValidation: false,
        } as any,
        {
          warId: "1001",
          warStartTime: new Date("2026-03-12T09:00:00.000Z"),
          opponentTag: "#2NEW",
          needsValidation: false,
        } as any,
      ],
      warId: "1001",
      warStartTime: new Date("2026-03-12T09:00:00.000Z"),
      opponentTag: "2NEW",
    });

    expect(resolved).toMatchObject({
      warId: "1001",
      opponentTag: "#2NEW",
    });
    expect(resolved?.warStartTime?.toISOString()).toBe("2026-03-12T09:00:00.000Z");
  });

  it("renders resolved fallback sync for active war when no same-war persisted row exists", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "2002",
      }),
      latestPersistedSyncNumber: 475,
      sameWarPersistedSyncNumber: null,
    });
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      syncRow: null,
      fallbackSyncNum: resolution.syncNumber,
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

  it("uses the same derived sync value for display and tie-break parity when same-war sync is missing", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "preparation",
        warId: "3001",
      }),
      latestPersistedSyncNumber: 481,
      sameWarPersistedSyncNumber: null,
    });
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      syncRow: null,
      fallbackSyncNum: resolution.syncNumber,
      warId: "3001",
      warStartTime: new Date("2026-03-25T04:20:57.000Z"),
      opponentNotFound: false,
      validationState: {
        siteCurrent: false,
        syncRowMissing: true,
        differences: [],
        statusLine: "",
      },
    });

    expect(renderedSync).toBe(482);
    expect(renderedSync).toBe(resolution.syncNumber);

    const outcomeFromResolved = deriveProjectedOutcomeForTest(
      "B000",
      "A000",
      1000,
      1000,
      resolution.syncNumber,
    );
    const outcomeFromRendered = deriveProjectedOutcomeForTest(
      "B000",
      "A000",
      1000,
      1000,
      renderedSync,
    );

    expect(outcomeFromResolved).toBe("WIN");
    expect(outcomeFromRendered).toBe(outcomeFromResolved);
  });

  it("uses the same confirmed same-war sync value for display and tie-break parity", () => {
    const resolution = resolveActiveWarSyncNumber({
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "3002",
      }),
      latestPersistedSyncNumber: 481,
      sameWarPersistedSyncNumber: 482,
    });
    const renderedSync = resolveRenderedSyncNumberForStoredSummaryForTest({
      syncRow: {
        syncNum: 482,
        lastKnownSyncNumber: 482,
        warId: "3002",
        warStartTime: new Date("2026-03-25T04:21:07.000Z"),
      },
      fallbackSyncNum: resolution.syncNumber,
      warId: "3002",
      warStartTime: new Date("2026-03-25T04:21:07.000Z"),
      opponentNotFound: false,
      validationState: {
        siteCurrent: false,
        syncRowMissing: false,
        differences: [],
        statusLine: "",
      },
    });

    expect(renderedSync).toBe(482);
    expect(renderedSync).toBe(resolution.syncNumber);

    const outcomeFromResolved = deriveProjectedOutcomeForTest(
      "B000",
      "A000",
      1000,
      1000,
      resolution.syncNumber,
    );
    const outcomeFromRendered = deriveProjectedOutcomeForTest(
      "B000",
      "A000",
      1000,
      1000,
      renderedSync,
    );

    expect(outcomeFromResolved).toBe("WIN");
    expect(outcomeFromRendered).toBe(outcomeFromResolved);
  });
});
