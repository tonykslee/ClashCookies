import { describe, expect, it } from "vitest";

import { buildSyncValidationStateForTest } from "../src/commands/Fwa";
import { buildActionableSyncStateLine } from "../src/commands/fwa/syncDisplay";

describe("fwa match needs-validation state contract", () => {
  it("does not mark needs-validation when explicit clan-not-found has trusted same-war sync and no persisted row", () => {
    const validation = buildSyncValidationStateForTest({
      syncRow: null,
      currentWarId: "2001",
      currentWarStartTime: new Date("2026-03-11T08:00:00.000Z"),
      siteCurrent: true,
      syncNum: 475,
      opponentTag: "2OPP",
      clanPoints: 1200,
      opponentPoints: null,
      outcome: null,
      isFwa: false,
      opponentNotFound: true,
    });

    expect(validation.differences).toEqual([]);
    expect(validation.statusLine).toBe(":interrobang: Clan not found on points.fwafarm");
    expect(
      buildActionableSyncStateLine({
        syncRow: null,
        siteCurrent: validation.siteCurrent,
        differenceCount: validation.differences.length,
      })
    ).toBe("");
  });

  it("keeps missing-row validation active for normal non-not-found flows", () => {
    const validation = buildSyncValidationStateForTest({
      syncRow: null,
      currentWarId: "2001",
      currentWarStartTime: new Date("2026-03-11T08:00:00.000Z"),
      siteCurrent: true,
      syncNum: 475,
      opponentTag: "2OPP",
      clanPoints: 1200,
      opponentPoints: 1000,
      outcome: null,
      isFwa: false,
      opponentNotFound: false,
    });

    expect(validation.differences).toEqual(["- Missing persisted sync validation row for this war"]);
    expect(
      buildActionableSyncStateLine({
        syncRow: null,
        siteCurrent: validation.siteCurrent,
        differenceCount: validation.differences.length,
      })
    ).toBe("State: Needs validation");
  });

  it("keeps missing-row validation active when war identity is not known", () => {
    const validation = buildSyncValidationStateForTest({
      syncRow: null,
      currentWarId: null,
      currentWarStartTime: null,
      siteCurrent: true,
      syncNum: 475,
      opponentTag: "2OPP",
      clanPoints: 1200,
      opponentPoints: null,
      outcome: null,
      isFwa: false,
      opponentNotFound: true,
    });

    expect(validation.differences).toEqual(["- Missing persisted sync validation row for this war"]);
    expect(
      buildActionableSyncStateLine({
        syncRow: null,
        siteCurrent: validation.siteCurrent,
        differenceCount: validation.differences.length,
      })
    ).toBe("State: Needs validation");
  });
});
