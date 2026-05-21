import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceCocWarOutageStateForTest,
  applyWarEndedMaintenanceGuardForTest,
  buildFwaBaseSwapBattleDayReminderContentForTest,
  buildFwaBaseSwapBattleDayReminderLogContentForTest,
  buildNotifyWarEndedViewCustomId,
  buildBattleDayRefreshEditPayloadForTest,
  buildWarEndedMetadataValueForTest,
  buildNotifyEventPostedContentForTest,
  buildWarEndDiscrepancyContentForTest,
  computeWarSnapshotAttackRowsForTest,
  computeWarComplianceForTest,
  computeWarPointsDeltaForTest,
  isWarPhaseExpectedActiveForTest,
  isNotifyWarEndedViewButtonCustomId,
  parseNotifyWarEndedViewCustomId,
  resolveEventRenderSyncNumberForTest,
  resolveActiveWarTimingForTest,
  sanitizeWarPlanForEmbedForTest,
  shouldPreserveWarIdentityDuringOutageRecoveryForTest,
  WarEventLogService,
} from "../src/services/WarEventLogService";
import { BotLogChannelService } from "../src/services/BotLogChannelService";
import { trackedMessageService } from "../src/services/TrackedMessageService";
import {
  resolveParticipationGuildId,
  WarEventHistoryService,
} from "../src/services/war-events/history";
import { buildActiveWarSyncIdentity } from "../src/services/ActiveWarSyncResolutionService";
import * as reminderSchedulerService from "../src/services/reminders/ReminderSchedulerService";

function dateAt(hour: number): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, 0, 0));
}

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  trackedClan: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  reminder: {
    findMany: vi.fn(),
  },
  reminderFireLog: {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  clanNotifyConfig: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  clanPointsSync: {
    findFirst: vi.fn(),
  },
  warEvent: {
    create: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.trackedClan.findMany.mockResolvedValue([]);
  prismaMock.trackedClan.findUnique.mockResolvedValue(null);
  prismaMock.currentWar.findFirst.mockResolvedValue(null);
  prismaMock.currentWar.findMany.mockResolvedValue([]);
  prismaMock.currentWar.upsert.mockResolvedValue({});
  prismaMock.reminder.findMany.mockResolvedValue([]);
  prismaMock.reminderFireLog.findUnique.mockResolvedValue(null);
  prismaMock.reminderFireLog.create.mockResolvedValue({ id: "fire-1" });
  prismaMock.reminderFireLog.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.reminderFireLog.update.mockResolvedValue({});
  prismaMock.clanNotifyConfig.findMany.mockResolvedValue([]);
  prismaMock.clanNotifyConfig.findUnique.mockResolvedValue(null);
  prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
  prismaMock.warEvent.create.mockResolvedValue({});
});

const testGuildId = "guild-1";
const testClanTag = "2QG2C08UP";
const mailChannelId = "mail-channel-1";
const botLogChannelId = "bot-log-1";
const notifyChannelId = "notify-channel-1";

function makeTextChannel(send: ReturnType<typeof vi.fn>) {
  return {
    guildId: testGuildId,
    isTextBased: () => true,
    send,
  };
}

function makeReminderClient(params: {
  mailChannel: unknown;
  botLogChannel?: unknown;
  extraChannels?: Record<string, unknown>;
}) {
  return {
    channels: {
      fetch: vi.fn().mockImplementation(async (channelId: string) => {
        if (channelId === mailChannelId) return params.mailChannel;
        if (channelId === botLogChannelId) return params.botLogChannel ?? null;
        if (params.extraChannels && channelId in params.extraChannels) {
          return params.extraChannels[channelId];
        }
        throw new Error(`unexpected channel lookup: ${channelId}`);
      }),
    },
  } as any;
}

function makeFwaBaseSwapCandidate(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "tracked-1",
    guildId: testGuildId,
    channelId: "base-channel",
    messageId: "base-message-1",
    referenceId: "fwa-base-swap:split-key",
    clanTag: testClanTag,
    createdAt: new Date("2026-03-20T00:05:00.000Z"),
    expiresAt: new Date("2026-03-22T00:00:00.000Z"),
    metadata: {
      clanName: "Test Clan",
      createdByUserId: "user-1",
      createdAtIso: "2026-03-20T00:05:00.000Z",
      swapReminder: true,
      entries: [
        {
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          discordUserId: "100",
          townhallLevel: 18,
          section: "fwa_bases",
          acknowledged: true,
        },
      ],
      layoutLinks: [],
    },
    ...overrides,
  };
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

describe("WarEventHistoryService participation guild resolution", () => {
  it("prefers payload guild over snapshot guild to avoid cross-guild writes", () => {
    expect(
      resolveParticipationGuildId({
        payloadGuildId: "prod-guild",
        snapshotGuildId: "staging-guild",
      }),
    ).toBe("prod-guild");
  });

  it("falls back to snapshot guild when payload guild is unavailable", () => {
    expect(
      resolveParticipationGuildId({
        payloadGuildId: "",
        snapshotGuildId: "snapshot-guild",
      }),
    ).toBe("snapshot-guild");
  });

  it("returns null when neither guild source is available", () => {
    expect(
      resolveParticipationGuildId({
        payloadGuildId: null,
        snapshotGuildId: undefined,
      }),
    ).toBeNull();
  });
});

describe("WarEventLogService resolved notify sync fallback", () => {
  it("prefers same-war sync over posted and derived values", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        identity: buildActiveWarSyncIdentity({
          warState: "inWar",
          warId: "1001",
        }),
        sameWarSyncNumber: 482,
        postedSyncNumber: 481,
        latestPersistedSyncNumber: 480,
        allowPostedSyncReuse: true,
      })
    ).toBe(482);
  });

  it("falls back to posted sync only for refresh continuity", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        identity: buildActiveWarSyncIdentity({
          warState: "inWar",
          warId: "1001",
        }),
        sameWarSyncNumber: null,
        postedSyncNumber: 482,
        latestPersistedSyncNumber: 480,
        allowPostedSyncReuse: true,
      })
    ).toBe(482);
    expect(
      resolveEventRenderSyncNumberForTest({
        identity: buildActiveWarSyncIdentity({
          warState: "inWar",
          warId: "1001",
        }),
        sameWarSyncNumber: null,
        postedSyncNumber: 482,
        latestPersistedSyncNumber: 480,
      }),
    ).toBe(481);
  });

  it("derives active-war sync as latest persisted + 1 for preparation/inWar", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        identity: buildActiveWarSyncIdentity({
          warState: "preparation",
          warId: "1002",
        }),
        sameWarSyncNumber: null,
        postedSyncNumber: null,
        latestPersistedSyncNumber: 481,
      })
    ).toBe(482);
    expect(
      resolveEventRenderSyncNumberForTest({
        identity: buildActiveWarSyncIdentity({
          warState: "inWar",
          warId: "1003",
        }),
        sameWarSyncNumber: null,
        postedSyncNumber: null,
        latestPersistedSyncNumber: 481,
      })
    ).toBe(482);
  });

  it("falls back to latest persisted sync when war is not active", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        identity: buildActiveWarSyncIdentity({
          warState: "notInWar",
        }),
        sameWarSyncNumber: null,
        postedSyncNumber: null,
        latestPersistedSyncNumber: 481,
      })
    ).toBe(481);
  });

  it("returns unknown when active-looking sync fallback is not positively resolved", () => {
    expect(
      resolveEventRenderSyncNumberForTest({
        identity: buildActiveWarSyncIdentity({
          warState: "preparation",
        }),
        sameWarSyncNumber: null,
        postedSyncNumber: null,
        latestPersistedSyncNumber: 481,
      }),
    ).toBeNull();
  });
});

describe("WarEventLogService.computeWarPointsDeltaForTest", () => {
  it("BL war: returns +3 points when final result is WIN", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      teamSize: 50,
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

  it("BL war: returns +3 points for a perfect 50v50 war on TIE", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
        before: 100,
        after: 100,
        teamSize: 50,
        finalResult: {
          clanStars: 150,
          opponentStars: 150,
          clanDestruction: 60,
          opponentDestruction: 60,
          warEndTime: null,
          resultLabel: "TIE",
      },
    });
    expect(delta).toBe(3);
  });

  it("BL war: returns +3 points for a perfect 45v45 war on TIE", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
        before: 100,
        after: 100,
        teamSize: 45,
        finalResult: {
          clanStars: 135,
          opponentStars: 135,
          clanDestruction: 60,
          opponentDestruction: 60,
          warEndTime: null,
          resultLabel: "TIE",
      },
    });
    expect(delta).toBe(3);
  });

  it("BL war: does not treat 135 stars as perfect for a 50v50 war", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      teamSize: 50,
      finalResult: {
        clanStars: 135,
        opponentStars: 134,
        clanDestruction: 60,
        opponentDestruction: 60,
        warEndTime: null,
        resultLabel: "LOSE",
      },
    });
    expect(delta).toBe(1);
  });

  it("BL war: returns +2 points when not a win but clan destruction is > 60%", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      teamSize: 50,
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
      teamSize: 50,
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

  it("FWA WIN plan: clears mirror obligation once someone else already tripled that mirror while still flagging strict-window non-mirror triples", () => {
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
    expect(result.notFollowingPlan).toEqual(["Alice"]);
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

  it("omits the battle-day role mention when mismatch suppression is active", () => {
    const content = buildNotifyEventPostedContentForTest({
      eventType: "battle_day",
      opponentName: "Enemy Clan",
      notifyRoleId: "123456789",
      includeRoleMention: false,
      nowMs: 0,
      nextScheduledRefreshAtMs: 1_200_000,
    });
    expect(content).toBe("War started against Enemy Clan\nNext refresh <t:1200:R>");
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

  it("drops a previously posted mention when battle-day mismatch suppression is active", () => {
    const payload = buildBattleDayRefreshEditPayloadForTest(
      "War started against Enemy Clan\n<@&123456789>\nNext refresh <t:999:R>",
      "Enemy Clan",
      0,
      false,
    );
    expect(payload.content).toContain("War started against Enemy Clan\nNext refresh <t:");
    expect(payload.content).not.toContain("<@&123456789>");
  });
});

describe("WarEventLogService FWA battle-day reminder", () => {
  it("builds reminder content with an optional clan role mention", () => {
    expect(
      buildFwaBaseSwapBattleDayReminderContentForTest({
        clanRoleId: "123456789",
      }),
    ).toBe(
      "<@&123456789>\n\nThanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.",
    );
    expect(
      buildFwaBaseSwapBattleDayReminderContentForTest({ clanRoleId: null }),
    ).toBe(
      "Thanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.",
    );
  });

  it("sends the clan-wide reminder to the tracked clan mail channel with a role ping", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-1",
      url: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-1`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate());
    vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    ).mockResolvedValue(true);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
      botLogChannel: makeTextChannel(botLogSend),
    });

    const service = new WarEventLogService(client, {} as any);
    const sent = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        channelId: notifyChannelId,
      },
      payload: {
        eventType: "battle_day",
        matchType: "BL",
      },
    });

    expect(sent).toBe(true);
    expect(reminderSend).toHaveBeenCalledTimes(1);
    expect(reminderSend).toHaveBeenCalledWith({
      content:
        "<@&123456789>\n\nThanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.",
      allowedMentions: { roles: ["123456789"] },
    });
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toBe(
      buildFwaBaseSwapBattleDayReminderLogContentForTest({
        clanName: "Test Clan",
        clanTag: testClanTag,
        targetChannelId: mailChannelId,
        reminderMessageUrl: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-1`,
        referenceId: "fwa-base-swap:split-key",
        clanRoleMentionIncluded: true,
      }),
    );
  });

  it("sends the clan-wide reminder without a role ping when no clan role is configured", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-2",
      url: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-2`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate({
      referenceId: null,
      metadata: {
        clanName: "Test Clan",
        createdByUserId: "user-1",
        createdAtIso: "2026-03-20T00:05:00.000Z",
        swapReminder: true,
        entries: [
          {
            position: 1,
            playerTag: "#AAA111",
            playerName: "Alpha",
            discordUserId: "100",
            townhallLevel: 18,
            section: "fwa_bases",
            acknowledged: false,
          },
        ],
        layoutLinks: [],
      },
    }));
    vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    ).mockResolvedValue(true);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
      botLogChannel: makeTextChannel(botLogSend),
    });

    const service = new WarEventLogService(client, {} as any);
    const sent = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: null,
        channelId: notifyChannelId,
      },
      payload: {
        eventType: "battle_day",
        matchType: "BL",
      },
    });

    expect(sent).toBe(true);
    expect(reminderSend).toHaveBeenCalledTimes(1);
    expect(reminderSend).toHaveBeenCalledWith({
      content:
        "Thanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.",
      allowedMentions: { parse: [] },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("battle-day reminder role missing"),
    );
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toBe(
      buildFwaBaseSwapBattleDayReminderLogContentForTest({
        clanName: "Test Clan",
        clanTag: testClanTag,
        targetChannelId: mailChannelId,
        reminderMessageUrl: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-2`,
        referenceId: "base-message-1",
        clanRoleMentionIncluded: false,
      }),
    );
  });

  it("skips when mail channel is missing and does not claim", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: null }]);
    const reminderSend = vi.fn();
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate());
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
      botLogChannel: makeTextChannel(botLogSend),
    });

    const service = new WarEventLogService(client, {} as any);
    const sent = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        channelId: notifyChannelId,
      },
      payload: {
        eventType: "battle_day",
        matchType: "BL",
      },
    });

    expect(sent).toBe(false);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(reminderSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=mail_channel_missing"),
    );
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain("Target channel: unknown");
  });

  it("skips when mail channel is unavailable and does not claim", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn();
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate());
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = makeReminderClient({
      mailChannel: null,
      botLogChannel: makeTextChannel(botLogSend),
    });

    const service = new WarEventLogService(client, {} as any);
    const sent = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        channelId: notifyChannelId,
      },
      payload: {
        eventType: "battle_day",
        matchType: "BL",
      },
    });

    expect(sent).toBe(false);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(reminderSend).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=mail_channel_unavailable"),
    );
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain(`Target channel: <#${mailChannelId}>`);
  });

  it("skips when mail channel is not text-based or sendable", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn();
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate());
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = makeReminderClient({
      mailChannel: {
        guildId: testGuildId,
        isTextBased: () => false,
        send: reminderSend,
      },
      botLogChannel: makeTextChannel(botLogSend),
    });

    const service = new WarEventLogService(client, {} as any);
    const sent = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        channelId: notifyChannelId,
      },
      payload: {
        eventType: "battle_day",
        matchType: "BL",
      },
    });

    expect(sent).toBe(false);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(reminderSend).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=mail_channel_unavailable"),
    );
    expect(botLogSend).toHaveBeenCalledTimes(1);
  });

  it("sends only once when the same reference is claimed twice", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-1",
      url: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-1`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate());
    vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    )
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
      botLogChannel: makeTextChannel(botLogSend),
    });

    const service = new WarEventLogService(client, {} as any);
    const payload = {
      eventType: "battle_day",
      matchType: "BL",
    } as const;

    const first = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        channelId: notifyChannelId,
      },
      payload,
    });
    const second = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        channelId: notifyChannelId,
      },
      payload,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(reminderSend).toHaveBeenCalledTimes(1);
    expect(botLogSend).toHaveBeenCalledTimes(1);
  });

  it("sends the reminder even when notify is disabled", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-1",
      url: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-1`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate());
    vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    ).mockResolvedValue(true);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
      botLogChannel: makeTextChannel(botLogSend),
    });
    const service = new WarEventLogService(client, {} as any);

    await (service as any).dispatchDetectedEvent({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        notify: false,
        channelId: null,
      },
      payload: {
        eventType: "battle_day",
        clanTag: testClanTag,
        clanName: "Test Clan",
        opponentTag: "#OPP",
        opponentName: "Enemy",
        syncNumber: 1,
        notifyRole: null,
        pingRole: false,
        pointsNeedsValidation: null,
        fwaPoints: null,
        opponentFwaPoints: null,
        outcome: null,
        matchType: "BL",
        warStartFwaPoints: null,
        warEndFwaPoints: null,
        clanStars: null,
        opponentStars: null,
        prepStartTime: null,
        warStartTime: null,
        warEndTime: null,
        clanAttacks: null,
        opponentAttacks: null,
        teamSize: null,
        attacksPerMember: null,
        clanDestruction: null,
        opponentDestruction: null,
      },
      resolvedWarId: 123,
      sendBattleDaySwapReminders: true,
    });

    expect(reminderSend).toHaveBeenCalledTimes(1);
    expect(reminderSend).toHaveBeenCalledWith({
      content:
        "<@&123456789>\n\nThanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.",
      allowedMentions: { roles: ["123456789"] },
    });
    expect(botLogSend).toHaveBeenCalledTimes(1);
  });

  it("triggers 24h WAR reminder fire on battle-day transition", async () => {
    const transitionSpy = vi
      .spyOn(
        reminderSchedulerService,
        "fireBattleDayTransitionWar24hRemindersForClan",
      )
      .mockResolvedValue({ evaluated: 1, fired: 1, deduped: 0, failed: 0 });
    const client = makeReminderClient({});
    const service = new WarEventLogService(client, {} as any);
    const battleDayEndTime = new Date(Date.UTC(2026, 0, 2, 1, 0, 0));
    const battleDayStartTime = new Date(Date.UTC(2026, 0, 1, 1, 0, 0));

    await (service as any).dispatchDetectedEvent({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        notify: false,
        channelId: null,
        warId: 123,
      },
      payload: {
        eventType: "battle_day",
        clanTag: testClanTag,
        clanName: "Test Clan",
        opponentTag: "#OPP",
        opponentName: "Enemy",
        syncNumber: 1,
        notifyRole: null,
        pingRole: false,
        pointsNeedsValidation: null,
        fwaPoints: null,
        opponentFwaPoints: null,
        outcome: null,
        matchType: "BL",
        warStartFwaPoints: null,
        warEndFwaPoints: null,
        clanStars: null,
        opponentStars: null,
        prepStartTime: battleDayStartTime,
        warStartTime: battleDayStartTime,
        warEndTime: battleDayEndTime,
        clanAttacks: null,
        opponentAttacks: null,
        teamSize: null,
        attacksPerMember: null,
        clanDestruction: null,
        opponentDestruction: null,
      },
      resolvedWarId: 123,
    });

    expect(transitionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        warId: 123,
        warStartTime: battleDayStartTime,
        warEndTime: battleDayEndTime,
        nowMs: expect.any(Number),
      }),
    );
  });

  it("sends the reminder even when notify reservation is blocked", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-1",
      url: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-1`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate());
    vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    ).mockResolvedValue(true);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
      botLogChannel: makeTextChannel(botLogSend),
    });
    const service = new WarEventLogService(client, {} as any);
    vi.spyOn(service as any, "tryCreateEventGuard").mockResolvedValue(false);

    await (service as any).dispatchDetectedEvent({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        notify: true,
        channelId: notifyChannelId,
        warId: 123,
      },
      payload: {
        eventType: "battle_day",
        clanTag: testClanTag,
        clanName: "Test Clan",
        opponentTag: "#OPP",
        opponentName: "Enemy",
        syncNumber: 1,
        notifyRole: null,
        pingRole: false,
        pointsNeedsValidation: null,
        fwaPoints: null,
        opponentFwaPoints: null,
        outcome: null,
        matchType: "BL",
        warStartFwaPoints: null,
        warEndFwaPoints: null,
        clanStars: null,
        opponentStars: null,
        prepStartTime: null,
        warStartTime: null,
        warEndTime: null,
        clanAttacks: null,
        opponentAttacks: null,
        teamSize: null,
        attacksPerMember: null,
        clanDestruction: null,
        opponentDestruction: null,
      },
      resolvedWarId: 123,
      sendBattleDaySwapReminders: true,
    });

    expect(reminderSend).toHaveBeenCalledTimes(1);
    expect(reminderSend).toHaveBeenCalledWith({
      content:
        "<@&123456789>\n\nThanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.",
      allowedMentions: { roles: ["123456789"] },
    });
    expect(botLogSend).toHaveBeenCalledTimes(1);
  });

  it("skips non-BL wars before claiming or sending", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn();
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapReminderCandidate");
    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
    });

    const service = new WarEventLogService(client, {} as any);
    const sent = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        channelId: notifyChannelId,
      },
      payload: {
        eventType: "battle_day",
        matchType: "MM",
      },
    });

    expect(sent).toBe(false);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(reminderSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=non_bl_match_type"),
    );
  });

  it("skips when no qualifying candidate exists", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: mailChannelId }]);
    const reminderSend = vi.fn();
    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(null);
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
    });

    const service = new WarEventLogService(client, {} as any);
    const sent = await (service as any).sendFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Test Clan",
        clanRoleId: "123456789",
        channelId: notifyChannelId,
      },
      payload: {
        eventType: "battle_day",
        matchType: "BL",
      },
    });

    expect(sent).toBe(false);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(reminderSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=no_reminder_candidate"),
    );
  });
});

describe("WarEventLogService war-event poll targets", () => {
  it("includes a tracked clan with ClanNotifyConfig even when no CurrentWar row exists", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#C0CU2Q82",
        name: "Configured Clan",
        notifyChannelId: null,
        notifyRole: null,
        notifyEnabled: false,
        mailChannelId: null,
        logChannelId: null,
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.clanNotifyConfig.findMany.mockResolvedValue([
      {
        guildId: "guild-42",
        clanTag: "c0cu2q82",
        channelId: "notify-channel-42",
        roleId: "notify-role-42",
        pingEnabled: false,
        embedEnabled: true,
      },
    ]);
    const service = new WarEventLogService({} as any, {} as any);

    const targets = await (service as any).listPollTargets();

    expect(targets).toEqual([
      {
        guildId: "guild-42",
        clanTag: "#C0CU2Q82",
        channelId: "notify-channel-42",
        notify: true,
        pingRole: false,
        inferredMatchType: true,
        notifyRole: "notify-role-42",
        clanName: "Configured Clan",
      },
    ]);
  });

  it("uses the effective notify config when ensuring the CurrentWar baseline", async () => {
    const service = new WarEventLogService({} as any, {} as any);
    const target = {
      guildId: "guild-42",
      clanTag: "#C0CU2Q82",
      channelId: "notify-channel-42",
      notify: true,
      pingRole: false,
      inferredMatchType: true,
      notifyRole: "notify-role-42",
      clanName: "Configured Clan",
    };

    await (service as any).ensureCurrentWarBaseline(target);

    expect(prismaMock.currentWar.upsert).toHaveBeenCalledWith({
      where: {
        clanTag_guildId: {
          clanTag: "#C0CU2Q82",
          guildId: "guild-42",
        },
      },
      update: {
        channelId: "notify-channel-42",
        notify: true,
        pingRole: false,
        inferredMatchType: true,
        notifyRole: "notify-role-42",
        clanName: "Configured Clan",
      },
      create: {
        guildId: "guild-42",
        clanTag: "#C0CU2Q82",
        channelId: "notify-channel-42",
        notify: true,
        pingRole: false,
        inferredMatchType: true,
        notifyRole: "notify-role-42",
        clanName: "Configured Clan",
        state: "notInWar",
      },
    });
  });

  it("keeps legacy TrackedClan notify fallback working when no ClanNotifyConfig row exists", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#2QVGPQP0U",
        name: "Legacy Clan",
        notifyChannelId: "legacy-channel-42",
        notifyRole: "legacy-role-42",
        notifyEnabled: true,
        mailChannelId: "mail-channel-42",
        logChannelId: "log-channel-42",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        guildId: "guild-77",
        clanTag: "2qvgpqp0u",
        channelId: null,
        notify: null,
        pingRole: null,
        inferredMatchType: null,
        notifyRole: null,
        clanName: null,
      },
    ]);
    prismaMock.clanNotifyConfig.findMany.mockResolvedValue([]);
    const service = new WarEventLogService({} as any, {} as any);

    const targets = await (service as any).listPollTargets();

    expect(targets).toEqual([
      {
        guildId: "guild-77",
        clanTag: "#2QVGPQP0U",
        channelId: "legacy-channel-42",
        notify: true,
        pingRole: true,
        inferredMatchType: true,
        notifyRole: "legacy-role-42",
        clanName: "Legacy Clan",
      },
    ]);
  });

  it("collects maintenance-over guilds across poll targets and retries once per guild after the loop", async () => {
    const service = new WarEventLogService({} as any, {} as any);
    const targets = [
      {
        guildId: "guild-1",
        clanTag: "#AAA111",
        channelId: "channel-1",
        notify: true,
        pingRole: true,
        inferredMatchType: true,
        notifyRole: null,
        clanName: "Clan A",
      },
      {
        guildId: "guild-1",
        clanTag: "#BBB222",
        channelId: "channel-1",
        notify: true,
        pingRole: true,
        inferredMatchType: true,
        notifyRole: null,
        clanName: "Clan B",
      },
    ];
    const listTargetsSpy = vi
      .spyOn(service as any, "listPollTargets")
      .mockResolvedValue(targets);
    const ensureBaselineSpy = vi
      .spyOn(service as any, "ensureCurrentWarBaseline")
      .mockResolvedValue(undefined);
    let observedMaintenanceOver = false;
    const processSpy = vi
      .spyOn(service as any, "processSubscription")
      .mockImplementation(async (_guildId, _clanTag, _syncContext, options) => {
        if (!observedMaintenanceOver) {
          observedMaintenanceOver = true;
          options?.maintenanceOverGuildIds?.add("guild-1");
        }
        return false;
      });
    const guildRetrySpy = vi
      .spyOn(
        reminderSchedulerService,
        "fireBattleDayTransitionWar24hRemindersForGuild",
      )
      .mockResolvedValue({ evaluated: 0, fired: 0, deduped: 0, failed: 0 });

    await service.poll({ sendBattleDaySwapReminders: false });

    expect(listTargetsSpy).toHaveBeenCalledTimes(1);
    expect(ensureBaselineSpy).toHaveBeenCalledTimes(2);
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(guildRetrySpy).toHaveBeenCalledTimes(1);
    expect(guildRetrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        triggerSource: "maintenance_over",
      }),
    );
    expect(processSpy.mock.invocationCallOrder[1]).toBeLessThan(
      guildRetrySpy.mock.invocationCallOrder[0],
    );
  });

  it("corrects stale CurrentWar notify=false when ClanNotifyConfig enables embeds", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#C0CU2Q82",
        name: "Configured Clan",
        notifyChannelId: null,
        notifyRole: null,
        notifyEnabled: false,
        mailChannelId: null,
        logChannelId: null,
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        guildId: "guild-42",
        clanTag: "#c0cu2q82",
        channelId: "old-channel",
        notify: false,
        pingRole: false,
        inferredMatchType: true,
        notifyRole: "old-role",
        clanName: "Old Clan Name",
      },
    ]);
    prismaMock.clanNotifyConfig.findMany.mockResolvedValue([
      {
        guildId: "guild-42",
        clanTag: "#C0CU2Q82",
        channelId: "notify-channel-42",
        roleId: "notify-role-42",
        pingEnabled: false,
        embedEnabled: true,
      },
    ]);
    const service = new WarEventLogService({} as any, {} as any);

    const targets = await (service as any).listPollTargets();

    expect(targets).toEqual([
      {
        guildId: "guild-42",
        clanTag: "#C0CU2Q82",
        channelId: "notify-channel-42",
        notify: true,
        pingRole: false,
        inferredMatchType: true,
        notifyRole: "notify-role-42",
        clanName: "Old Clan Name",
      },
    ]);
  });
});

describe("WarEventLogService notify config ownership", () => {
  it("resolves a subscription from ClanNotifyConfig routing without legacy notifyChannelId", async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      {
        guildId: "guild-42",
        clanTag: "#C0CU2Q82",
        warId: 1001,
        syncNum: 10,
        channelId: "notify-channel-42",
        notify: true,
        pingRole: false,
        embedEnabled: true,
        notifyRole: "notify-role-42",
        inferredMatchType: true,
        fwaPoints: 1200,
        opponentFwaPoints: 1201,
        outcome: "WIN",
        matchType: "FWA",
        warStartFwaPoints: 1200,
        warEndFwaPoints: null,
        clanStars: 100,
        opponentStars: 99,
        state: "inWar",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Configured Clan",
        pointsConfirmedByClanMail: false,
        pointsNeedsValidation: true,
        pointsLastSuccessfulFetchAt: null,
        pointsLastKnownSyncNumber: null,
        pointsLastKnownPoints: null,
        pointsLastKnownMatchType: null,
        pointsLastKnownOutcome: null,
        pointsWarId: null,
        pointsOpponentTag: null,
        pointsWarStartTime: null,
      },
    ]);
    const service = new WarEventLogService({} as any, {} as any);

    const sub = await (service as any).findSubscriptionByGuildAndTag(
      "guild-42",
      "#C0CU2Q82",
    );

    expect(sub).toMatchObject({
      guildId: "guild-42",
      clanTag: "#C0CU2Q82",
      channelId: "notify-channel-42",
      notify: true,
      pingRole: false,
      notifyRole: "notify-role-42",
    });
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("passes dispatchDetectedEvent guard when the resolved subscription has notify and channel", async () => {
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as any, {} as any);
    const reserveSpy = vi.spyOn(service as any, "reserveEventDelivery").mockResolvedValue({
      allowed: true,
      existingMessage: null,
      warId: 1001,
    });
    const emitSpy = vi.spyOn(service as any, "emitEvent").mockResolvedValue(undefined);

    await (service as any).dispatchDetectedEvent({
      sub: {
        guildId: "guild-42",
        clanTag: "#C0CU2Q82",
        channelId: "notify-channel-42",
        notify: true,
        pingRole: false,
        embedEnabled: true,
        notifyRole: "notify-role-42",
        warId: null,
        syncNum: null,
        inferredMatchType: true,
        fwaPoints: null,
        opponentFwaPoints: null,
        outcome: null,
        matchType: "FWA",
        warStartFwaPoints: null,
        warEndFwaPoints: null,
        clanStars: null,
        opponentStars: null,
        state: "notInWar",
        prepStartTime: null,
        startTime: null,
        endTime: null,
        opponentTag: null,
        opponentName: null,
        clanName: "Configured Clan",
        pointsConfirmedByClanMail: null,
        pointsNeedsValidation: null,
        pointsLastSuccessfulFetchAt: null,
        pointsLastKnownSyncNumber: null,
        pointsLastKnownPoints: null,
        pointsLastKnownMatchType: null,
        pointsLastKnownOutcome: null,
        pointsWarId: null,
        pointsOpponentTag: null,
        pointsWarStartTime: null,
      },
      payload: {
        eventType: "battle_day",
        clanTag: "#C0CU2Q82",
        clanName: "Configured Clan",
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        syncNumber: 10,
        notifyRole: "notify-role-42",
        pingRole: false,
        fwaPoints: null,
        opponentFwaPoints: null,
        outcome: null,
        matchType: "FWA",
        warStartFwaPoints: null,
        warEndFwaPoints: null,
        clanStars: null,
        opponentStars: null,
        prepStartTime: null,
        warStartTime: null,
        warEndTime: null,
        clanAttacks: null,
        opponentAttacks: null,
        teamSize: null,
        attacksPerMember: null,
        clanDestruction: null,
        opponentDestruction: null,
      },
      resolvedWarId: 1001,
    });

    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it("builds a /notify preview using ClanNotifyConfig channel ownership when legacy notifyChannelId is missing", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      name: "Configured Clan",
      notifyChannelId: null,
      notifyRole: null,
      notifyEnabled: false,
      mailChannelId: null,
      logChannelId: null,
    });
    prismaMock.clanNotifyConfig.findUnique.mockResolvedValue({
      guildId: "guild-42",
      clanTag: "C0CU2Q82",
      channelId: "notify-channel-42",
      roleId: "notify-role-42",
      pingEnabled: false,
      embedEnabled: true,
    });
    prismaMock.$queryRaw.mockResolvedValue([]);
    const service = new WarEventLogService({} as any, {} as any);
    vi.spyOn(service as any, "findSubscriptionByGuildAndTag").mockResolvedValue(null);
    vi.spyOn(service as any, "buildTestEventPayload").mockResolvedValue({
      eventType: "war_started",
      clanTag: "#C0CU2Q82",
      clanName: "Configured Clan",
      opponentTag: "#OPP123",
      opponentName: "Enemy",
      syncNumber: 10,
      notifyRole: "notify-role-42",
      pingRole: false,
      fwaPoints: null,
      opponentFwaPoints: null,
      outcome: null,
      matchType: "FWA",
      warStartFwaPoints: null,
      warEndFwaPoints: null,
      clanStars: null,
      opponentStars: null,
      prepStartTime: null,
      warStartTime: null,
      warEndTime: null,
      clanAttacks: null,
      opponentAttacks: null,
      teamSize: null,
      attacksPerMember: null,
      clanDestruction: null,
      opponentDestruction: null,
      resolvedWarIdHint: null,
    });
    vi.spyOn(service as any, "buildEventMessage").mockResolvedValue({
      embeds: [{ data: { title: "preview" } }],
    });

    const result = await service.buildTestEventPreviewForClan({
      guildId: "guild-42",
      clanTag: "#C0CU2Q82",
      eventType: "war_started",
      source: "current",
    });

    expect(result.ok).toBe(true);
    expect(result.channelId).toBe("notify-channel-42");
    expect(result.clanName).toBe("Configured Clan");
  });

  it("preserves the raw CoC maintenance response on current-war snapshot failures", async () => {
    const maintenanceError = {
      message: "CoC API error 503",
      status: 503,
      response: {
        status: 503,
        data: {
          message: "Service temporarily unavailable because of maintenance.",
        },
      },
    };
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as any,
      {
        getCurrentWar: vi.fn().mockRejectedValue(maintenanceError),
      } as any,
    );

    const snapshot = await (service as any).getCurrentWarSnapshot("#ABC123");

    expect(snapshot.observation).toEqual({
      kind: "failure",
      statusCode: 503,
    });
    expect(snapshot.error).toMatchObject({
      message: "CoC API error 503",
      response: {
        status: 503,
        data: {
          message: "Service temporarily unavailable because of maintenance.",
        },
      },
    });
  });
});

describe("WarEventLogService war-end discrepancy content", () => {
  it("builds the visible mismatch warning without adding a leader mention", () => {
    const payload = buildWarEndDiscrepancyContentForTest({
      existingPostedContent: "War ended against Enemy Clan",
      clanTag: "#AAA111",
      opponentName: "Enemy Clan",
      expectedPoints: 100,
      actualPoints: 99,
    });

    expect(payload.content).toContain(
      "⚠️ War-end points mismatch detected. [points.fwafarm](<https://points.fwafarm.com/clan?tag=AAA111>)",
    );
    expect(payload.content).toContain("Expected points: 100");
    expect(payload.content).toContain("Actual points: 99");
    expect(payload.content).not.toContain("<@&");
    expect(payload.allowedMentions).toEqual({ parse: [] });
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

describe("WarEventLogService.isWarPhaseExpectedActiveForTest", () => {
  it("returns true for preparation before known battle start", () => {
    expect(
      isWarPhaseExpectedActiveForTest({
        state: "preparation",
        knownWarStartTime: new Date("2026-03-11T14:00:00.000Z"),
        knownWarEndTime: new Date("2026-03-12T14:00:00.000Z"),
        now: new Date("2026-03-11T08:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("returns false for inWar after known battle end", () => {
    expect(
      isWarPhaseExpectedActiveForTest({
        state: "inWar",
        knownWarStartTime: new Date("2026-03-10T14:00:00.000Z"),
        knownWarEndTime: new Date("2026-03-11T08:00:00.000Z"),
        now: new Date("2026-03-11T08:00:01.000Z"),
      }),
    ).toBe(false);
  });
});

describe(
  "WarEventLogService.shouldPreserveWarIdentityDuringOutageRecoveryForTest",
  () => {
    it("preserves identity for outage recovery timestamp shifts in expected active window", () => {
      const shouldPreserve = shouldPreserveWarIdentityDuringOutageRecoveryForTest(
        {
          previousState: "preparation",
          candidateState: "preparation",
          previousWarStartTime: new Date("2026-03-11T14:21:56.000Z"),
          previousWarEndTime: new Date("2026-03-12T14:21:56.000Z"),
          warIdentityChanged: true,
          eventDerivedFromIdentityShift: true,
          warFetchFailed: false,
          maintenanceSuspected: true,
          now: new Date("2026-03-11T08:33:49.914Z"),
        },
      );

      expect(shouldPreserve).toBe(true);
    });

    it("does not preserve identity when active window should already be over", () => {
      const shouldPreserve = shouldPreserveWarIdentityDuringOutageRecoveryForTest(
        {
          previousState: "inWar",
          candidateState: "inWar",
          previousWarStartTime: new Date("2026-03-10T14:21:56.000Z"),
          previousWarEndTime: new Date("2026-03-11T08:30:00.000Z"),
          warIdentityChanged: true,
          eventDerivedFromIdentityShift: true,
          warFetchFailed: false,
          maintenanceSuspected: true,
          now: new Date("2026-03-11T08:33:49.914Z"),
        },
      );

      expect(shouldPreserve).toBe(false);
    });
  },
);

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
