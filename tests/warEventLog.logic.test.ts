import { describe, expect, it } from "vitest";
import {
  advanceCocWarOutageStateForTest,
  applyWarEndedMaintenanceGuardForTest,
  buildNotifyWarEndedViewCustomId,
  buildBattleDayRefreshEditPayloadForTest,
  buildWarEndedMetadataValueForTest,
  buildNotifyEventPostedContentForTest,
  computeWarSnapshotAttackRowsForTest,
  computeWarComplianceForTest,
  computeWarPointsDeltaForTest,
  isNotifyWarEndedViewButtonCustomId,
  parseNotifyWarEndedViewCustomId,
  resolveEventRenderSyncNumberForTest,
  resolveActiveWarTimingForTest,
  sanitizeWarPlanForEmbedForTest,
} from "../src/services/WarEventLogService";
import { WarEventHistoryService } from "../src/services/war-events/history";

function dateAt(hour: number): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, 0, 0));
}

describe("War-end view custom IDs", () => {
  it("encodes and parses war-ended view context linkage", () => {
    const customId = buildNotifyWarEndedViewCustomId({
      view: "c",
      guildId: "123456789012345678",
      clanTag: "#Q2ABC9",
      warId: 1000055,
      messageId: "234567890123456789",
      timestampUnix: 1773407400,
      page: 2,
    });
    expect(isNotifyWarEndedViewButtonCustomId(customId)).toBe(true);
    expect(parseNotifyWarEndedViewCustomId(customId)).toEqual({
      view: "c",
      guildId: "123456789012345678",
      clanTag: "#Q2ABC9",
      warId: 1000055,
      messageId: "234567890123456789",
      timestampUnix: 1773407400,
      page: 2,
    });
  });

  it("rejects malformed custom ids", () => {
    expect(parseNotifyWarEndedViewCustomId("notify-war-end:c:g:#tag:1:2:3:0")).toBeNull();
    expect(parseNotifyWarEndedViewCustomId("notify-war-end:x:1:TAG:1:2:3:0")).toBeNull();
  });
});

describe("War-end metadata value", () => {
  it("groups war id, sync, and timestamp in one field", () => {
    expect(
      buildWarEndedMetadataValueForTest({
        warId: 1000055,
        syncNumber: 476,
        timestampUnix: 1773407400,
      })
    ).toBe("War ID: 1000055 - Sync: 476 - <t:1773407400:F>");
  });
});

describe("WarEventLogService resolved notify sync fallback", () => {
  it("prefers same-war sync over posted and derived values", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        sameWarSyncNumber: 482,
        postedSyncNumber: 481,
        previousSyncNumber: 480,
        currentState: "inWar",
      })
    ).toBe(482);
  });

  it("falls back to posted sync when same-war sync is unavailable", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        sameWarSyncNumber: null,
        postedSyncNumber: 482,
        previousSyncNumber: 480,
        currentState: "inWar",
      })
    ).toBe(482);
  });

  it("derives active-war sync as previous + 1 for preparation/inWar", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        sameWarSyncNumber: null,
        postedSyncNumber: null,
        previousSyncNumber: 481,
        currentState: "preparation",
      })
    ).toBe(482);
    expect(
      resolveEventRenderSyncNumberForTest({
        sameWarSyncNumber: null,
        postedSyncNumber: null,
        previousSyncNumber: 481,
        currentState: "inWar",
      })
    ).toBe(482);
  });

  it("falls back to previous sync when war is not active", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        sameWarSyncNumber: null,
        postedSyncNumber: null,
        previousSyncNumber: 481,
        currentState: "notInWar",
      })
    ).toBe(481);
  });
});

describe("WarEventLogService.computeWarPointsDeltaForTest", () => {
  it("BL war: returns +3 points when final result is WIN", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      finalResult: {
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 59,
        opponentDestruction: 58,
        warEndTime: null,
        resultLabel: "WIN",
      },
    });
    expect(delta).toBe(3);
  });

  it("BL war: returns +2 points when not a win but clan destruction is > 60%", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      finalResult: {
        clanStars: 90,
        opponentStars: 100,
        clanDestruction: 60.01,
        opponentDestruction: 70,
        warEndTime: null,
        resultLabel: "LOSE",
      },
    });
    expect(delta).toBe(2);
  });

  it("BL war: returns +1 point when not a win and clan destruction is < 60%", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      finalResult: {
        clanStars: 90,
        opponentStars: 100,
        clanDestruction: 59.99,
        opponentDestruction: 70,
        warEndTime: null,
        resultLabel: "LOSE",
      },
    });
    expect(delta).toBe(1);
  });

  it("FWA war: returns -1 on WIN", () => {
    expect(
      computeWarPointsDeltaForTest({
        matchType: "FWA",
        before: 1200,
        after: 1205,
        finalResult: {
          clanStars: 100,
          opponentStars: 99,
          clanDestruction: null,
          opponentDestruction: null,
          warEndTime: null,
          resultLabel: "WIN",
        },
      })
    ).toBe(-1);
  });

  it("MM war: always returns 0 points delta at war end", () => {
    expect(
      computeWarPointsDeltaForTest({
        matchType: "MM",
        before: 1200,
        after: 1197,
        finalResult: {
          clanStars: null,
          opponentStars: null,
          clanDestruction: null,
          opponentDestruction: null,
          warEndTime: null,
          resultLabel: "UNKNOWN",
        },
      })
    ).toBe(0);
  });

  it("FWA war: returns +1 on LOSE", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "FWA",
      before: 100,
      after: 100,
      finalResult: {
        clanStars: 99,
        opponentStars: 100,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "LOSE",
      },
    });
    expect(delta).toBe(1);
  });

  it("FWA war: returns 0 on TIE", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "FWA",
      before: 100,
      after: 100,
      finalResult: {
        clanStars: 100,
        opponentStars: 100,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "TIE",
      },
    });
    expect(delta).toBe(0);
  });

  it("FWA/MM war: returns null when before is unknown", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "FWA",
      before: null,
      after: 100,
      finalResult: {
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "UNKNOWN",
      },
    });
    expect(delta).toBeNull();
  });
});

describe("WarEventLogService.computeWarSnapshotAttackRowsForTest", () => {
  it("stores zero trueStars for later triples on already-tripled defenders", () => {
    const rows = computeWarSnapshotAttackRowsForTest({
      ownMembers: [
        {
          tag: "#A1",
          name: "Alice",
          mapPosition: 1,
          attacks: [{ order: 1, stars: 3, defenderTag: "#D1" }],
        },
        {
          tag: "#B1",
          name: "Bob",
          mapPosition: 2,
          attacks: [{ order: 2, stars: 3, defenderTag: "#D1" }],
        },
      ],
      opponentMembers: [{ tag: "#D1", name: "Def 1", mapPosition: 1 }],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.trueStars).toBe(3);
    expect(rows[1]?.trueStars).toBe(0);
  });

  it("computes cross-player incremental gains in global attack order", () => {
    const rows = computeWarSnapshotAttackRowsForTest({
      ownMembers: [
        {
          tag: "#A1",
          name: "Alice",
          mapPosition: 1,
          attacks: [{ order: 1, stars: 1, defenderTag: "#D1" }],
        },
        {
          tag: "#B1",
          name: "Bob",
          mapPosition: 2,
          attacks: [{ order: 2, stars: 3, defenderTag: "#D1" }],
        },
        {
          tag: "#C1",
          name: "Cara",
          mapPosition: 3,
          attacks: [{ order: 3, stars: 2, defenderTag: "#D1" }],
        },
      ],
      opponentMembers: [{ tag: "#D1", name: "Def 1", mapPosition: 1 }],
    });

    expect(rows.map((row) => row.trueStars)).toEqual([1, 2, 0]);
  });

  it("remains deterministic regardless of own-member iteration order", () => {
    const ownMembersA = [
      {
        tag: "#A1",
        name: "Alice",
        mapPosition: 1,
        attacks: [{ order: 1, stars: 1, defenderTag: "#D1" }],
      },
      {
        tag: "#B1",
        name: "Bob",
        mapPosition: 2,
        attacks: [{ order: 2, stars: 3, defenderTag: "#D1" }],
      },
      {
        tag: "#C1",
        name: "Cara",
        mapPosition: 3,
        attacks: [{ order: 3, stars: 2, defenderTag: "#D1" }],
      },
    ];
    const ownMembersB = [ownMembersA[2], ownMembersA[0], ownMembersA[1]];
    const opponentMembers = [{ tag: "#D1", name: "Def 1", mapPosition: 1 }];

    const rowsA = computeWarSnapshotAttackRowsForTest({ ownMembers: ownMembersA, opponentMembers });
    const rowsB = computeWarSnapshotAttackRowsForTest({ ownMembers: ownMembersB, opponentMembers });

    const signature = (rows: typeof rowsA) =>
      [...rows]
        .sort((a, b) => {
          if (a.playerTag < b.playerTag) return -1;
          if (a.playerTag > b.playerTag) return 1;
          return a.attackNumber - b.attackNumber;
        })
        .map((row) => `${row.playerTag}:${row.attackNumber}:${row.trueStars}`);

    expect(signature(rowsA)).toEqual(signature(rowsB));
  });

  it("uses deterministic order fallback and fail-safe trueStars when defender identity is missing", () => {
    const rows = computeWarSnapshotAttackRowsForTest({
      ownMembers: [
        {
          tag: "#A1",
          name: "Alice",
          mapPosition: 1,
          attacks: [
            { stars: 3, defenderPosition: 4 },
            { stars: 2 },
          ],
        },
        {
          tag: "#B1",
          name: "Bob",
          mapPosition: 2,
          attacks: [{ stars: 3, defenderPosition: 4 }],
        },
      ],
      opponentMembers: [],
    });

    expect(rows.map((row) => row.trueStars)).toEqual([3, 0, 0]);
    const missingDefenderRow = rows.find(
      (row) => row.defenderTag === null && row.defenderPosition === null
    );
    expect(missingDefenderRow).toBeDefined();
    expect(missingDefenderRow?.trueStars).toBe(0);
  });
});

describe("WarEventHistoryService.buildWarEndPointsLine", () => {
  const history = new WarEventHistoryService({} as any);
  const baseResult = {
    clanStars: 100,
    opponentStars: 99,
    clanDestruction: 59,
    opponentDestruction: 58,
    warEndTime: null,
    resultLabel: "WIN" as const,
  };

  it("BL win: renders persisted expected +3", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "BL",
        warStartFwaPoints: 100,
        warEndFwaPoints: 103,
      },
      baseResult
    );
    expect(line).toBe("Alpha: 100 -> 103 (+3) [BL]");
  });

  it("BL lose with 60%+ destruction: renders persisted expected +2", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "BL",
        warStartFwaPoints: 100,
        warEndFwaPoints: 102,
      },
      {
        ...baseResult,
        resultLabel: "LOSE",
        clanDestruction: 60.01,
      }
    );
    expect(line).toBe("Alpha: 100 -> 102 (+2) [BL]");
  });

  it("BL lose below 60% destruction: renders persisted expected +1", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "BL",
        warStartFwaPoints: 100,
        warEndFwaPoints: 101,
      },
      {
        ...baseResult,
        resultLabel: "LOSE",
        clanDestruction: 59.99,
      }
    );
    expect(line).toBe("Alpha: 100 -> 101 (+1) [BL]");
  });

  it("FWA win: renders persisted expected post-war points", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "FWA",
        warStartFwaPoints: 1200,
        warEndFwaPoints: 1199,
      },
      {
        ...baseResult,
        resultLabel: "WIN",
        clanDestruction: null,
        opponentDestruction: null,
      }
    );
    expect(line).toBe("Alpha: 1200 -> 1199 (-1)");
  });

  it("MM war: renders no points change at war end", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "MM",
        warStartFwaPoints: 1200,
        warEndFwaPoints: 1200,
      },
      {
        ...baseResult,
        resultLabel: "UNKNOWN",
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
      }
    );
    expect(line).toBe("Alpha: 1200 -> 1200 (+0) [MM]");
  });

  it("renders explicit unknown output when both before and expected are unknown", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "FWA",
        warStartFwaPoints: null,
        warEndFwaPoints: null,
      },
      {
        ...baseResult,
        resultLabel: "UNKNOWN",
      }
    );
    expect(line).toBe("Alpha: unknown -> unknown (expected post-war points unavailable)");
  });
});

describe("WarEventLogService.computeWarComplianceForTest", () => {
  const participants = [
    { playerName: "Alice", playerTag: "#A", attacksUsed: 2, playerPosition: 1 },
    { playerName: "Bob", playerTag: "#B", attacksUsed: 2, playerPosition: 2 },
    { playerName: "Cory", playerTag: "#C", attacksUsed: 0, playerPosition: 3 },
  ];

  it("BL war: returns empty missedBoth and notFollowingPlan because war-plan enforcement is disabled", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [],
      matchType: "BL",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });
    expect(result).toEqual({ missedBoth: [], notFollowingPlan: [] });
  });

  it("MM war: returns empty missedBoth and notFollowingPlan because war-plan enforcement is disabled", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 2,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
      ],
      matchType: "MM",
      expectedOutcome: null,
      loseStyle: "TRADITIONAL",
    });
    expect(result).toEqual({ missedBoth: [], notFollowingPlan: [] });
  });

  it("FWA WIN plan: flags players who miss required mirror triple during strict window and invalid non-mirror strict-window hits", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 2,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
        {
          playerTag: "#B",
          playerName: "Bob",
          playerPosition: 2,
          defenderPosition: 2,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(20),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "TRADITIONAL",
    });
    expect(result.missedBoth).toEqual(["Cory"]);
    expect(result.notFollowingPlan).toEqual(["Alice", "Bob"]);
  });

  it("FWA LOSE Triple-top-30 plan: flags attacks on defender positions 31-50", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 31,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(2),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRIPLE_TOP_30",
    });
    expect(result.notFollowingPlan).toEqual(["Alice"]);
  });

  it("FWA LOSE Traditional plan (late window <12h): flags mirror!=2-star and non-mirror!=1-star attacks", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 1,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
        {
          playerTag: "#B",
          playerName: "Bob",
          playerPosition: 2,
          defenderPosition: 1,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(20),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });
    expect(result.notFollowingPlan).toEqual(["Alice", "Bob"]);
  });

  it("FWA LOSE Traditional plan (early window >=12h): flags stars outside 1-2 and attacks that push cumulative stars over 100", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 1,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
        {
          playerTag: "#B",
          playerName: "Bob",
          playerPosition: 2,
          defenderPosition: 2,
          stars: 2,
          trueStars: 101,
          attackSeenAt: dateAt(2),
          warEndTime: dateAt(20),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });
    expect(result.notFollowingPlan).toEqual(["Alice", "Bob"]);
  });
});

describe("WarEventLogService.sanitizeWarPlanForEmbedForTest", () => {
  it("normalizes heading-style prefixes and keeps line order", () => {
    const text = [
      "# Title",
      "Line 1",
      "  ## Subtitle",
      "",
      "  - Keep this",
      "   ### Internal Header",
      "Line 2",
    ].join("\n");

    const sanitized = sanitizeWarPlanForEmbedForTest(text);

    expect(sanitized?.split("\n")).toEqual([
      "Title",
      "Line 1",
      "  Subtitle",
      "",
      "  - Keep this",
      "   Internal Header",
      "Line 2",
    ]);
  });

  it("keeps plans without heading lines unchanged", () => {
    const text = ["Line 1", "  - Keep this", "", "Line 2"].join("\n");

    const sanitized = sanitizeWarPlanForEmbedForTest(text);

    expect(sanitized).toBe(text);
  });

  it("returns null when heading-only lines sanitize to empty content", () => {
    const text = ["#   ", "  ##   ", "   ###"].join("\n");

    expect(sanitizeWarPlanForEmbedForTest(text)).toBeNull();
  });

  it("does not alter # characters that are not markdown heading prefixes", () => {
    const text = ["Line #1", "  - # keep", "#not-a-heading", "foo #bar baz"].join("\n");
    const sanitized = sanitizeWarPlanForEmbedForTest(text);
    expect(sanitized).toBe(text);
  });
});

describe("WarEventLogService notify event posted content", () => {
  it("places prep-day context line above role mention", () => {
    const content = buildNotifyEventPostedContentForTest({
      eventType: "war_started",
      opponentName: "Enemy Clan",
      notifyRoleId: "123456789",
      includeRoleMention: true,
      nowMs: 0,
    });
    expect(content).toBe("War declared against Enemy Clan\n<@&123456789>");
  });

  it("places battle-day context above mention and refresh line", () => {
    const content = buildNotifyEventPostedContentForTest({
      eventType: "battle_day",
      opponentName: "Enemy Clan",
      notifyRoleId: "123456789",
      includeRoleMention: true,
      nowMs: 0,
      nextScheduledRefreshAtMs: 1_200_000,
    });
    expect(content).toBe("War started against Enemy Clan\n<@&123456789>\nNext refresh <t:1200:R>");
  });

  it("places war-ended context line above role mention", () => {
    const content = buildNotifyEventPostedContentForTest({
      eventType: "war_ended",
      opponentName: "Enemy Clan",
      notifyRoleId: "123456789",
      includeRoleMention: true,
      nowMs: 0,
    });
    expect(content).toBe("War ended against Enemy Clan\n<@&123456789>");
  });

  it("uses fallback opponent label when name is unavailable", () => {
    const content = buildNotifyEventPostedContentForTest({
      eventType: "war_started",
      opponentName: " ",
      notifyRoleId: "123456789",
      includeRoleMention: true,
      nowMs: 0,
    });
    expect(content).toBe("War declared against Unknown Opponent\n<@&123456789>");
  });
});

describe("WarEventLogService battle-day refresh content", () => {
  it("preserves visible role mention with context-first order", () => {
    const payload = buildBattleDayRefreshEditPayloadForTest(
      "War started against Enemy Clan\n<@&123456789>\nNext refresh <t:999:R>",
      "Enemy Clan",
      0
    );
    expect(payload.content).toContain("War started against Enemy Clan\n<@&123456789>\nNext refresh <t:");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("preserves mention for legacy mention-first posts", () => {
    const payload = buildBattleDayRefreshEditPayloadForTest(
      "<@&123456789>\nNext refresh <t:999:R>",
      "Enemy Clan",
      0
    );
    expect(payload.content).toContain("War started against Enemy Clan\n<@&123456789>\nNext refresh <t:");
  });

  it("does not add mention if original message had none", () => {
    const payload = buildBattleDayRefreshEditPayloadForTest(
      "War started against Enemy Clan\nNext refresh <t:999:R>",
      "Enemy Clan",
      0
    );
    expect(payload.content).toContain("War started against Enemy Clan\nNext refresh <t:");
    expect(payload.content).not.toContain("<@&");
  });
});

describe("WarEventLogService.applyWarEndedMaintenanceGuardForTest", () => {
  const now = new Date("2026-03-11T08:33:49.914Z");

  it("suppresses war_ended when before known war end time", () => {
    const decision = applyWarEndedMaintenanceGuardForTest({
      eventType: "war_ended",
      previousState: "inWar",
      candidateState: "notInWar",
      warFetchFailed: false,
      maintenanceSuspected: false,
      knownWarEndTime: new Date("2026-03-11T14:21:56.000Z"),
      now,
    });

    expect(decision).toEqual({
      eventType: null,
      state: "inWar",
      suppressReason: "before_known_war_end_time",
    });
  });

  it("suppresses war_ended on transient upstream fetch failure", () => {
    const decision = applyWarEndedMaintenanceGuardForTest({
      eventType: "war_ended",
      previousState: "preparation",
      candidateState: "notInWar",
      warFetchFailed: true,
      maintenanceSuspected: false,
      knownWarEndTime: new Date("2026-03-11T14:21:56.000Z"),
      now,
    });

    expect(decision).toEqual({
      eventType: null,
      state: "preparation",
      suppressReason: "upstream_unavailable",
    });
  });

  it("suppresses war_ended while maintenance is suspected without end-time proof", () => {
    const decision = applyWarEndedMaintenanceGuardForTest({
      eventType: "war_ended",
      previousState: "inWar",
      candidateState: "notInWar",
      warFetchFailed: false,
      maintenanceSuspected: true,
      knownWarEndTime: null,
      now,
    });

    expect(decision).toEqual({
      eventType: null,
      state: "inWar",
      suppressReason: "maintenance_suspected",
    });
  });

  it("allows real post-end war_ended transitions", () => {
    const decision = applyWarEndedMaintenanceGuardForTest({
      eventType: "war_ended",
      previousState: "inWar",
      candidateState: "notInWar",
      warFetchFailed: false,
      maintenanceSuspected: false,
      knownWarEndTime: new Date("2026-03-11T08:30:00.000Z"),
      now,
    });

    expect(decision).toEqual({
      eventType: "war_ended",
      state: "notInWar",
      suppressReason: null,
    });
  });

  it("keeps non-war-ended transitions unchanged", () => {
    const decision = applyWarEndedMaintenanceGuardForTest({
      eventType: "battle_day",
      previousState: "preparation",
      candidateState: "inWar",
      warFetchFailed: false,
      maintenanceSuspected: true,
      knownWarEndTime: null,
      now,
    });

    expect(decision).toEqual({
      eventType: "battle_day",
      state: "inWar",
      suppressReason: null,
    });
  });
});

describe("WarEventLogService.advanceCocWarOutageStateForTest", () => {
  it("marks outage suspected after repeated mixed 503/500 failures", () => {
    const t1 = new Date("2026-03-11T08:00:00.000Z");
    const t2 = new Date("2026-03-11T08:02:00.000Z");
    const first = advanceCocWarOutageStateForTest(
      null,
      { kind: "failure", statusCode: 503 },
      t1
    );
    const second = advanceCocWarOutageStateForTest(
      first,
      { kind: "failure", statusCode: 500 },
      t2
    );

    expect(first.suspected).toBe(false);
    expect(second.suspected).toBe(true);
    expect(second.failureStreak).toBe(2);
    expect(second.lastFailureStatusCode).toBe(500);
  });

  it("clears outage suspicion only after sustained recovery", () => {
    const base = advanceCocWarOutageStateForTest(
      advanceCocWarOutageStateForTest(
        null,
        { kind: "failure", statusCode: 503 },
        new Date("2026-03-11T08:00:00.000Z")
      ),
      { kind: "failure", statusCode: 503 },
      new Date("2026-03-11T08:01:00.000Z")
    );

    const oneRecovery = advanceCocWarOutageStateForTest(
      base,
      { kind: "success" },
      new Date("2026-03-11T08:02:00.000Z")
    );
    const twoRecovery = advanceCocWarOutageStateForTest(
      oneRecovery,
      { kind: "success" },
      new Date("2026-03-11T08:03:00.000Z")
    );

    expect(oneRecovery.suspected).toBe(true);
    expect(twoRecovery.suspected).toBe(false);
    expect(twoRecovery.failureStreak).toBe(0);
  });
});

describe("WarEventLogService.resolveActiveWarTimingForTest", () => {
  it("updates endTime when same war identity reports a changed endTime", () => {
    const start = new Date("2026-03-10T20:00:00.000Z");
    const result = resolveActiveWarTimingForTest({
      observedWarStartTime: start,
      observedWarEndTime: new Date("2026-03-11T14:21:56.000Z"),
      previousWarStartTime: start,
      previousWarEndTime: new Date("2026-03-11T13:00:00.000Z"),
    });

    expect(result.sameWarIdentity).toBe(true);
    expect(result.warEndTime?.toISOString()).toBe("2026-03-11T14:21:56.000Z");
  });

  it("preserves same-war endTime on transient snapshots with no observed timing", () => {
    const start = new Date("2026-03-10T20:00:00.000Z");
    const end = new Date("2026-03-11T14:21:56.000Z");
    const result = resolveActiveWarTimingForTest({
      observedWarStartTime: null,
      observedWarEndTime: null,
      previousWarStartTime: start,
      previousWarEndTime: end,
    });

    expect(result.sameWarIdentity).toBe(true);
    expect(result.warStartTime?.toISOString()).toBe(start.toISOString());
    expect(result.warEndTime?.toISOString()).toBe(end.toISOString());
  });

  it("does not carry prior-war endTime into a new war identity", () => {
    const result = resolveActiveWarTimingForTest({
      observedWarStartTime: new Date("2026-03-12T20:00:00.000Z"),
      observedWarEndTime: null,
      previousWarStartTime: new Date("2026-03-10T20:00:00.000Z"),
      previousWarEndTime: new Date("2026-03-11T14:21:56.000Z"),
    });

    expect(result.sameWarIdentity).toBe(false);
    expect(result.warEndTime).toBeNull();
  });
});
