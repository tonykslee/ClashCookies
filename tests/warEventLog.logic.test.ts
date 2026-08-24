import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
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
  resolveSameWarPersistedMatchEvidenceForTest,
  WarEventLogService,
} from "../src/services/WarEventLogService";
import { BotLogChannelService } from "../src/services/BotLogChannelService";
import { trackedMessageService } from "../src/services/TrackedMessageService";
import { cwlStateService } from "../src/services/CwlStateService";
import {
  resolveParticipationGuildId,
  WarEventHistoryService,
} from "../src/services/war-events/history";
import {
  buildAttackContextByAttack,
  evaluateFwaTraditionalLossComplianceForTest,
  TRADITIONAL_UNCLEARED_MIRROR_AFTER_OPEN_REASON,
} from "../src/services/war-events/core";
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
  warPlanComplianceEvaluation: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  clanWarHistory: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  clanWarParticipation: {
    findMany: vi.fn(),
  },
  warLookup: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  warPlanViolation: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  clanNotifyConfig: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  clanPostedMessage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  clanPointsSync: {
    findFirst: vi.fn(),
  },
  roster: {
    findMany: vi.fn(),
  },
  trackedMessage: {
    findMany: vi.fn(),
  },
  warEvent: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  warAttacks: {
    findFirst: vi.fn(),
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
  prismaMock.warPlanComplianceEvaluation.findMany.mockResolvedValue([]);
  prismaMock.warPlanComplianceEvaluation.findUnique.mockResolvedValue(null);
  prismaMock.warPlanComplianceEvaluation.create.mockResolvedValue({});
  prismaMock.warPlanComplianceEvaluation.update.mockResolvedValue({});
  prismaMock.warPlanComplianceEvaluation.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.warPlanComplianceEvaluation.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.clanWarHistory.findUnique.mockResolvedValue(null);
  prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
  prismaMock.clanWarParticipation.findMany.mockResolvedValue([]);
  prismaMock.warLookup.findUnique.mockResolvedValue(null);
  prismaMock.warLookup.findMany.mockResolvedValue([]);
  prismaMock.warPlanViolation.findMany.mockResolvedValue([]);
  prismaMock.warPlanViolation.createMany.mockResolvedValue({ count: 0 });
  prismaMock.warPlanViolation.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.clanNotifyConfig.findMany.mockResolvedValue([]);
  prismaMock.clanNotifyConfig.findUnique.mockResolvedValue(null);
  prismaMock.clanPostedMessage.findFirst.mockResolvedValue(null);
  prismaMock.clanPostedMessage.findMany.mockResolvedValue([]);
  prismaMock.clanPostedMessage.create.mockResolvedValue({});
  prismaMock.clanPostedMessage.update.mockResolvedValue({});
  prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
  prismaMock.roster.findMany.mockResolvedValue([]);
  prismaMock.trackedMessage.findMany.mockResolvedValue([]);
  prismaMock.warEvent.findFirst.mockResolvedValue(null);
  prismaMock.warEvent.findUnique.mockResolvedValue(null);
  prismaMock.warEvent.findMany.mockResolvedValue([]);
  prismaMock.warEvent.create.mockResolvedValue({ createdAt: new Date() });
  prismaMock.warEvent.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.warEvent.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.warAttacks.findFirst.mockResolvedValue(null);
  vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue(null);
  vi.spyOn(cwlStateService, "getCurrentPreparationSnapshotForClan").mockResolvedValue(null);
});

const testGuildId = "guild-1";
const testClanTag = "2QG2C08UP";
const mailChannelId = "mail-channel-1";
const baseSwapChannelId = "base-channel";
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

function makeWarEventSubscription(overrides?: Partial<Record<string, unknown>>) {
  return {
    guildId: testGuildId,
    clanTag: "#C0CU2Q82",
    channelId: notifyChannelId,
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
    ...overrides,
  };
}

function makeWarStartedEventPayload(overrides?: Partial<Record<string, unknown>>) {
  return {
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
    ...overrides,
  };
}

function makeWarEventDeliveryService(send: ReturnType<typeof vi.fn>) {
  const service = new WarEventLogService(
    {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          guildId: testGuildId,
          type: ChannelType.GuildText,
          isTextBased: () => true,
          send,
        }),
      },
    } as any,
    {} as any,
  );
  (service as any).history = {
    buildWarPlanText: vi.fn().mockResolvedValue(""),
  };
  return service;
}

function makeFwaBaseSwapCandidate(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "tracked-1",
    guildId: testGuildId,
    channelId: mailChannelId,
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
    ).toBeNull();
  });

  it("leaves active-war sync unknown without current-war evidence", () => {
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
    ).toBeNull();
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
    ).toBeNull();
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

  it("FWA WIN plan: uses the legacy 100/12 fallback when winGateConfig is omitted", () => {
    const winParticipants = [
      { playerName: "strict13", playerTag: "#S13", attacksUsed: 1, playerPosition: 1 },
      { playerName: "open12", playerTag: "#O12", attacksUsed: 1, playerPosition: 2 },
      { playerName: "open11", playerTag: "#O11", attacksUsed: 1, playerPosition: 3 },
    ];
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: winParticipants,
      attacks: [
        {
          playerTag: "#S13",
          playerName: "strict13",
          playerPosition: 1,
          defenderPosition: 4,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#O12",
          playerName: "open12",
          playerPosition: 2,
          defenderPosition: 5,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(12),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
        {
          playerTag: "#O11",
          playerName: "open11",
          playerPosition: 3,
          defenderPosition: 6,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 3,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "TRADITIONAL",
    });
    expect(result.notFollowingPlan).toEqual(["strict13"]);
  });

  it("FWA WIN plan: keeps explicit 101/0 strict-window config unchanged", () => {
    const winParticipants = [
      { playerName: "strict13", playerTag: "#S13", attacksUsed: 1, playerPosition: 1 },
      { playerName: "open12", playerTag: "#O12", attacksUsed: 1, playerPosition: 2 },
      { playerName: "open11", playerTag: "#O11", attacksUsed: 1, playerPosition: 3 },
    ];
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: winParticipants,
      attacks: [
        {
          playerTag: "#S13",
          playerName: "strict13",
          playerPosition: 1,
          defenderPosition: 4,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#O12",
          playerName: "open12",
          playerPosition: 2,
          defenderPosition: 5,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(12),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
        {
          playerTag: "#O11",
          playerName: "open11",
          playerPosition: 3,
          defenderPosition: 6,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 3,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "TRADITIONAL",
      winGateConfig: {
        nonMirrorTripleMinClanStars: 101,
        allBasesOpenHoursLeft: 0,
      },
    });
    expect(result.notFollowingPlan).toEqual(["open11", "open12", "strict13"]);
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

  it("FWA LOSE Traditional plan (open final 12 hours): allows 0-2 star attacks", () => {
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
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#B",
          playerName: "Bob",
          playerPosition: 2,
          defenderPosition: 1,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(12),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });
    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: allows strict-window 1-star cleanup after the mirror", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(2),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: allows strict-window 0-star cleanup after the mirror", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars: 0,
          trueStars: 0,
          attackSeenAt: dateAt(2),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it.each([1, 0])(
    "FWA LOSE Traditional plan: strict-window %s-star cleanup on the own mirror remains a target violation",
    (cleanupStars) => {
      const warEndTime = dateAt(24);
      const attacks = [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(1),
          warEndTime,
          attackOrder: 1,
        },
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 5,
          stars: cleanupStars,
          trueStars: cleanupStars,
          attackSeenAt: dateAt(2),
          warEndTime,
          attackOrder: 2,
        },
      ];
      const evaluation = evaluateFwaTraditionalLossComplianceForTest({
        participants: [
          { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
        ],
        attacks: attacks as any,
        attackContextByAttack: buildAttackContextByAttack(attacks as any, {
          nonMirrorTripleMinClanStars: 150,
          allBasesOpenHoursLeft: 12,
        }),
      });
      const result = evaluation.resultsByPlayerTag.get("#0WNER");

      expect(result?.hasViolation).toBe(true);
      expect(result?.attackDetails[1]?.isBreach).toBe(true);
      expect(result?.reason.label).toBe(
        "strict-window cleanup must target a non-mirror base in traditional loss",
      );
    },
  );

  it.each([0, 1])(
    "FWA LOSE Traditional plan: a strict-window %s-star cleanup before the mirror does not erase the obligation",
    (cleanupStars) => {
      const result = computeWarComplianceForTest({
        clanTag: "#CLAN",
        participants: [
          { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
        ],
        attacks: [
          {
            playerTag: "#OWNER",
            playerName: "owner",
            playerPosition: 5,
            defenderPosition: 1,
            stars: cleanupStars,
            trueStars: cleanupStars,
            attackSeenAt: dateAt(1),
            warEndTime: dateAt(24),
            attackOrder: 1,
          },
          {
            playerTag: "#OWNER",
            playerName: "owner",
            playerPosition: 5,
            defenderPosition: 5,
            stars: 2,
            trueStars: 2,
            attackSeenAt: dateAt(2),
            warEndTime: dateAt(24),
            attackOrder: 2,
          },
        ],
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      });

      expect(result.notFollowingPlan).toEqual([]);
    },
  );

  it.each([
    [2, "early non-mirror 2-star in traditional loss"],
    [3, "any 3-star in traditional loss"],
  ] as const)(
    "FWA LOSE Traditional plan: strict-window %s-star non-mirror remains a violation",
    (stars, expectedReason) => {
      const attacks = [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars,
          trueStars: stars,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
      ];
      const evaluation = evaluateFwaTraditionalLossComplianceForTest({
        participants: [
          { playerName: "owner", playerTag: "#OWNER", attacksUsed: 1, playerPosition: 5 },
        ],
        attacks: attacks as any,
        attackContextByAttack: buildAttackContextByAttack(attacks as any, {
          nonMirrorTripleMinClanStars: 150,
          allBasesOpenHoursLeft: 12,
        }),
      });
      const result = evaluation.resultsByPlayerTag.get("#0WNER");

      expect(result?.hasViolation).toBe(true);
      expect(result?.reason.label).toBe(expectedReason);
    },
  );

  it("FWA LOSE Traditional plan: reproduces the 66-star, 9h32m Ronuso mirror cleanup scenario", () => {
    const warEndTime = new Date("2026-08-11T18:00:00.000Z");
    const attackSeenAt = new Date("2026-08-11T08:28:00.000Z");
    const attacks = [
      {
        playerTag: "#SEED",
        playerName: "seed",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 2,
        trueStars: 66,
        attackSeenAt: new Date("2026-08-11T08:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#RONUSO",
        playerName: "Ronuso",
        playerPosition: 8,
        defenderPosition: 8,
        stars: 2,
        trueStars: 2,
        attackSeenAt,
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#RONUSO",
        playerName: "Ronuso",
        playerPosition: 8,
        defenderPosition: 14,
        stars: 1,
        trueStars: 1,
        attackSeenAt: new Date("2026-08-11T08:29:00.000Z"),
        warEndTime,
        attackOrder: 3,
      },
    ];
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "Ronuso", playerTag: "#RONUSO", attacksUsed: 2, playerPosition: 8 },
      ],
      attacks: attacks as any,
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: reproduces the 66-star, 9h32m arbitrary 1-star scenario", () => {
    const warEndTime = new Date("2026-08-11T18:00:00.000Z");
    const attacks = [
      {
        playerTag: "#SEED",
        playerName: "seed",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 2,
        trueStars: 66,
        attackSeenAt: new Date("2026-08-11T08:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#RONUSO",
        playerName: "Ronuso",
        playerPosition: 10,
        defenderPosition: 14,
        stars: 1,
        trueStars: 1,
        attackSeenAt: new Date("2026-08-11T08:28:00.000Z"),
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#RONUSO",
        playerName: "Ronuso",
        playerPosition: 10,
        defenderPosition: 15,
        stars: 1,
        trueStars: 1,
        attackSeenAt: new Date("2026-08-11T08:29:00.000Z"),
        warEndTime,
        attackOrder: 3,
      },
    ];
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "Ronuso", playerTag: "#RONUSO", attacksUsed: 2, playerPosition: 10 },
      ],
      attacks: attacks as any,
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: open-window 0-star plus 2-star attacks are compliant", () => {
    const warEndTime = new Date("2026-08-11T18:00:00.000Z");
    const attacks = [
      {
        playerTag: "#RONUSO",
        playerName: "Ronuso",
        playerPosition: 10,
        defenderPosition: 14,
        stars: 0,
        trueStars: 0,
        attackSeenAt: new Date("2026-08-11T08:28:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#RONUSO",
        playerName: "Ronuso",
        playerPosition: 10,
        defenderPosition: 15,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date("2026-08-11T08:29:00.000Z"),
        warEndTime,
        attackOrder: 2,
      },
    ];
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "Ronuso", playerTag: "#RONUSO", attacksUsed: 2, playerPosition: 10 },
      ],
      attacks: attacks as any,
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it.each([0, 1, 2])(
    "FWA LOSE Traditional plan: open-window %s-star attack on the own mirror remains compliant",
    (stars) => {
      const result = computeWarComplianceForTest({
        clanTag: "#CLAN",
        participants: [
          { playerName: "owner", playerTag: "#OWNER", attacksUsed: 1, playerPosition: 5 },
        ],
        attacks: [
          {
            playerTag: "#OWNER",
            playerName: "owner",
            playerPosition: 5,
            defenderPosition: 5,
            stars,
            trueStars: stars,
            attackSeenAt: dateAt(13),
            warEndTime: dateAt(24),
            attackOrder: 1,
          },
        ],
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      });

      expect(result.notFollowingPlan).toEqual([]);
    },
  );

  it.each([0, 1, 2])(
    "FWA LOSE Traditional plan: enabled mirror-after-open flag still allows one open-window %s-star own-mirror attack",
    (stars) => {
      const result = computeWarComplianceForTest({
        clanTag: "#CLAN",
        participants: [
          { playerName: "owner", playerTag: "#OWNER", attacksUsed: 1, playerPosition: 5 },
        ],
        attacks: [
          {
            playerTag: "#OWNER",
            playerName: "owner",
            playerPosition: 5,
            defenderPosition: 5,
            stars,
            trueStars: stars,
            attackSeenAt: dateAt(13),
            warEndTime: dateAt(24),
            attackOrder: 1,
          },
        ],
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
        winGateConfig: {
          nonMirrorTripleMinClanStars: 150,
          allBasesOpenHoursLeft: 12,
          traditionalRequireMirrorAfterOpen: true,
        },
      });

      expect(result.notFollowingPlan).toEqual([]);
    },
  );

  it("FWA LOSE Traditional plan: disabled mirror-after-open flag does not carry a strict obligation into open window", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars: 0,
          trueStars: 0,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      winGateConfig: {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
        traditionalRequireMirrorAfterOpen: false,
      },
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it.each([0, 1])(
    "FWA LOSE Traditional plan: strict non-mirror %s-star followed by open attack expires the disabled obligation",
    (stars) => {
      const result = computeWarComplianceForTest({
        clanTag: "#CLAN",
        participants: [
          { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
        ],
        attacks: [
          {
            playerTag: "#OWNER",
            playerName: "owner",
            playerPosition: 5,
            defenderPosition: 1,
            stars,
            trueStars: stars,
            attackSeenAt: dateAt(1),
            warEndTime: dateAt(24),
            attackOrder: 1,
          },
          {
            playerTag: "#OWNER",
            playerName: "owner",
            playerPosition: 5,
            defenderPosition: 2,
            stars: 0,
            trueStars: 0,
            attackSeenAt: dateAt(13),
            warEndTime: dateAt(24),
            attackOrder: 2,
          },
        ],
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      });

      expect(result.notFollowingPlan).toEqual([]);
    },
  );

  it("FWA LOSE Traditional plan: two strict attacks with uncleared mirror retain the strict mirror-miss reason", () => {
    const attacks = [
      {
        playerTag: "#OWNER",
        playerName: "owner",
        playerPosition: 5,
        defenderPosition: 1,
        stars: 0,
        trueStars: 0,
        attackSeenAt: dateAt(1),
        warEndTime: dateAt(24),
        attackOrder: 1,
      },
      {
        playerTag: "#OWNER",
        playerName: "owner",
        playerPosition: 5,
        defenderPosition: 2,
        stars: 1,
        trueStars: 1,
        attackSeenAt: dateAt(2),
        warEndTime: dateAt(24),
        attackOrder: 2,
      },
    ];
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: attacks as any,
      attackContextByAttack: buildAttackContextByAttack(attacks as any, {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
      }),
    });

    const result = evaluation.resultsByPlayerTag.get("#0WNER");
    expect(result?.hasViolation).toBe(true);
    expect(result?.reason.label).toBe("strict-window mirror miss in traditional loss");
  });

  it("FWA LOSE Traditional plan: enabled mirror-after-open uses the distinct open-phase mirror reason", () => {
    const attacks = [
      {
        playerTag: "#OWNER",
        playerName: "owner",
        playerPosition: 5,
        defenderPosition: 1,
        stars: 1,
        trueStars: 1,
        attackSeenAt: dateAt(1),
        warEndTime: dateAt(24),
        attackOrder: 1,
      },
      {
        playerTag: "#OWNER",
        playerName: "owner",
        playerPosition: 5,
        defenderPosition: 2,
        stars: 0,
        trueStars: 0,
        attackSeenAt: dateAt(13),
        warEndTime: dateAt(24),
        attackOrder: 2,
      },
    ];
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: attacks as any,
      attackContextByAttack: buildAttackContextByAttack(attacks as any, {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
      }),
      traditionalRequireMirrorAfterOpen: true,
    });

    const result = evaluation.resultsByPlayerTag.get("#0WNER");
    expect(result?.hasViolation).toBe(true);
    expect(result?.reason.label).toBe(
      TRADITIONAL_UNCLEARED_MIRROR_AFTER_OPEN_REASON,
    );
  });

  it("FWA LOSE Traditional plan: open-only two attacks with the enabled option use the distinct open-phase mirror reason", () => {
    const attacks = [
      {
        playerTag: "#OWNER",
        playerName: "owner",
        playerPosition: 5,
        defenderPosition: 1,
        stars: 0,
        trueStars: 0,
        attackSeenAt: dateAt(13),
        warEndTime: dateAt(24),
        attackOrder: 1,
      },
      {
        playerTag: "#OWNER",
        playerName: "owner",
        playerPosition: 5,
        defenderPosition: 2,
        stars: 1,
        trueStars: 1,
        attackSeenAt: dateAt(14),
        warEndTime: dateAt(24),
        attackOrder: 2,
      },
    ];
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: attacks as any,
      attackContextByAttack: buildAttackContextByAttack(attacks as any, {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
      }),
      traditionalRequireMirrorAfterOpen: true,
    });

    expect(evaluation.resultsByPlayerTag.get("#0WNER")?.reason.label).toBe(
      TRADITIONAL_UNCLEARED_MIRROR_AFTER_OPEN_REASON,
    );
  });

  it("FWA LOSE Traditional plan: enabled mirror-after-open flag reports two open attacks without a mirror", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars: 0,
          trueStars: 0,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 2,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(14),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      winGateConfig: {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
        traditionalRequireMirrorAfterOpen: true,
      },
    });

    expect(result.notFollowingPlan).toEqual(["owner"]);
  });

  it("FWA LOSE Traditional plan: enabled mirror-after-open flag does not flag a player with one open attack remaining", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 1, playerPosition: 5 },
      ],
      attacks: [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars: 0,
          trueStars: 0,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      winGateConfig: {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
        traditionalRequireMirrorAfterOpen: true,
      },
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: a later open-window 2-star mirror retrospectively satisfies the enabled obligation", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars: 0,
          trueStars: 0,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      winGateConfig: {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
        traditionalRequireMirrorAfterOpen: true,
      },
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: open-window 3-star remains an ANY_3STAR violation", () => {
    const attacks = [
      {
        playerTag: "#OWNER",
        playerName: "owner",
        playerPosition: 5,
        defenderPosition: 1,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-08-11T08:28:00.000Z"),
        warEndTime: new Date("2026-08-11T18:00:00.000Z"),
        attackOrder: 1,
      },
    ];
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 1, playerPosition: 5 },
      ],
      attacks: attacks as any,
      attackContextByAttack: buildAttackContextByAttack(attacks as any, {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
      }),
    });
    const result = evaluation.resultsByPlayerTag.get("#0WNER");

    expect(result?.hasViolation).toBe(true);
    expect(result?.reason.label).toBe("any 3-star in traditional loss");
  });

  it.each([0, 1, 2])(
    "FWA LOSE Traditional plan: open-window raw %s-star with trueStars=0 is not invalid",
    (stars) => {
      const attacks = [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars,
          trueStars: 0,
          attackSeenAt: new Date("2026-08-11T08:28:00.000Z"),
          warEndTime: new Date("2026-08-11T18:00:00.000Z"),
          attackOrder: 1,
        },
      ];
      const evaluation = evaluateFwaTraditionalLossComplianceForTest({
        participants: [
          { playerName: "owner", playerTag: "#OWNER", attacksUsed: 1, playerPosition: 5 },
        ],
        attacks: attacks as any,
        attackContextByAttack: buildAttackContextByAttack(attacks as any, {
          nonMirrorTripleMinClanStars: 150,
          allBasesOpenHoursLeft: 12,
        }),
      });
      const result = evaluation.resultsByPlayerTag.get("#0WNER");

      expect(result?.hasViolation).toBe(false);
    },
  );

  it.each([0, 1, 2])(
    "FWA LOSE Traditional plan: legal raw %s-star still violates the 100 true-star cap when it crosses it",
    (stars) => {
      const attacks = [
        {
          playerTag: "#SEED",
          playerName: "seed",
          playerPosition: 1,
          defenderPosition: 1,
          stars: 2,
          trueStars: 100,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars,
          trueStars: 1,
          attackSeenAt: dateAt(2),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ];
      const evaluation = evaluateFwaTraditionalLossComplianceForTest({
        participants: [
          { playerName: "owner", playerTag: "#OWNER", attacksUsed: 1, playerPosition: 5 },
        ],
        attacks: attacks as any,
        attackContextByAttack: buildAttackContextByAttack(attacks as any, {
          nonMirrorTripleMinClanStars: 150,
          allBasesOpenHoursLeft: 12,
        }),
      });
      const result = evaluation.resultsByPlayerTag.get("#0WNER");

      expect(result?.hasViolation).toBe(true);
      expect(result?.reason.label).toBe("clan star cap exceeded");
    },
  );

  it("FWA LOSE Traditional plan: uses the legacy 150/12 fallback when winGateConfig is omitted", () => {
    const winParticipants = [
      { playerName: "strict13", playerTag: "#S13", attacksUsed: 1, playerPosition: 1 },
      { playerName: "open12", playerTag: "#O12", attacksUsed: 1, playerPosition: 2 },
      { playerName: "open11", playerTag: "#O11", attacksUsed: 1, playerPosition: 3 },
    ];
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: winParticipants,
      attacks: [
        {
          playerTag: "#S13",
          playerName: "strict13",
          playerPosition: 1,
          defenderPosition: 4,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#O12",
          playerName: "open12",
          playerPosition: 2,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(12),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
        {
          playerTag: "#O11",
          playerName: "open11",
          playerPosition: 3,
          defenderPosition: 6,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 3,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });
    expect(result.notFollowingPlan).toEqual(["strict13"]);
  });

  it("FWA LOSE Traditional plan: keeps explicit 101/0 config unchanged", () => {
    const winParticipants = [
      { playerName: "strict13", playerTag: "#S13", attacksUsed: 1, playerPosition: 1 },
      { playerName: "open12", playerTag: "#O12", attacksUsed: 1, playerPosition: 2 },
      { playerName: "open11", playerTag: "#O11", attacksUsed: 1, playerPosition: 3 },
    ];
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: winParticipants,
      attacks: [
        {
          playerTag: "#S13",
          playerName: "strict13",
          playerPosition: 1,
          defenderPosition: 4,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#O12",
          playerName: "open12",
          playerPosition: 2,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(12),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
        {
          playerTag: "#O11",
          playerName: "open11",
          playerPosition: 3,
          defenderPosition: 6,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 3,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      winGateConfig: {
        nonMirrorTripleMinClanStars: 101,
        allBasesOpenHoursLeft: 0,
      },
    });
    expect(result.notFollowingPlan).toEqual(["strict13", "open12", "open11"]);
  });

  it("FWA LOSE Traditional plan: consumes an exact linked substitution without flagging it twice", () => {
    const winParticipants = [
      { playerName: "owner4", playerTag: "#P1", attacksUsed: 2, playerPosition: 4 },
      { playerName: "owner5", playerTag: "#P2", attacksUsed: 2, playerPosition: 5 },
    ];
    const linkedGroups = [
      {
        key: "user:111111111111111111",
        isLinked: true,
        memberTags: ["#P1", "#P2"],
        memberTagSet: new Set(["#P1", "#P2"]),
      },
    ];
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: winParticipants,
      attacks: [
        {
          playerTag: "#P1",
          playerName: "owner4",
          playerPosition: 4,
          defenderPosition: 4,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#P1",
          playerName: "owner4",
          playerPosition: 4,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
        {
          playerTag: "#P2",
          playerName: "owner5",
          playerPosition: 5,
          defenderPosition: 1,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 3,
        },
        {
          playerTag: "#P2",
          playerName: "owner5",
          playerPosition: 5,
          defenderPosition: 2,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 4,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      linkedGroups,
    });
    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: allows cleanup before later exact mirror satisfaction", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "owner", playerTag: "#OWNER", attacksUsed: 2, playerPosition: 5 },
      ],
      attacks: [
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 1,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(10),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#OWNER",
          playerName: "owner",
          playerPosition: 5,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: uses canonical participant positions even when attack rows omit playerPosition", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "mirror", playerTag: "#MIRROR", attacksUsed: 1, playerPosition: 5 },
      ],
      attacks: [
        {
          playerTag: "#MIRROR",
          playerName: "mirror",
          playerPosition: 99,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(10),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: keeps open-phase-only 2-stars valid without strict participation", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "open", playerTag: "#OPEN", attacksUsed: 2, playerPosition: 4 },
      ],
      attacks: [
        {
          playerTag: "#OPEN",
          playerName: "open",
          playerPosition: 4,
          defenderPosition: 11,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(13),
          warEndTime: dateAt(24),
          attackOrder: 1,
        },
        {
          playerTag: "#OPEN",
          playerName: "open",
          playerPosition: 4,
          defenderPosition: 12,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(14),
          warEndTime: dateAt(24),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual([]);
  });

  it("FWA LOSE Traditional plan: keeps consumed substitution metadata isolated to each exact attack", () => {
    const warEndTime = dateAt(24);
    const participants = [
      { playerName: "helperA", playerTag: "#A444", attacksUsed: 1, playerPosition: 4 },
      { playerName: "helperB", playerTag: "#B555", attacksUsed: 1, playerPosition: 5 },
    ];
    const attacks = [
      {
        playerTag: "#A444",
        playerName: "helperA",
        playerPosition: 4,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#B555",
        playerName: "helperB",
        playerPosition: 5,
        defenderPosition: 4,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: 2,
      },
    ];
    const attackContextByAttack = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 150,
      allBasesOpenHoursLeft: 12,
    });
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: participants as any,
      attacks: attacks as any,
      attackContextByAttack,
      linkedGroups: [
        {
          key: "user:linked",
          isLinked: true,
          memberTags: ["#A444", "#B555"],
          memberTagSet: new Set(["#A444", "#B555"]),
        },
      ] as any,
    });

    expect(evaluation.resultsByPlayerTag.get("#A444")?.consumedSubstitutionAttackIndexes).toEqual([
      0,
    ]);
    expect(evaluation.resultsByPlayerTag.get("#A444")?.consumedSubstitutionAttackOrders).toEqual([
      1,
    ]);
    expect(evaluation.resultsByPlayerTag.get("#B555")?.consumedSubstitutionAttackIndexes).toEqual([
      1,
    ]);
    expect(evaluation.resultsByPlayerTag.get("#B555")?.consumedSubstitutionAttackOrders).toEqual([
      2,
    ]);
  });

  it("FWA LOSE Traditional plan: keeps duplicate-order metadata attached only to the consumed attack", () => {
    const warEndTime = dateAt(24);
    const participants = [
      { playerName: "owner", playerTag: "#A444", attacksUsed: 1, playerPosition: 4 },
      { playerName: "breach", playerTag: "#B555", attacksUsed: 1, playerPosition: 5 },
    ];
    const attacks = [
      {
        playerTag: "#A444",
        playerName: "owner",
        playerPosition: 4,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: 7,
      },
      {
        playerTag: "#B555",
        playerName: "breach",
        playerPosition: 5,
        defenderPosition: 12,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: 7,
      },
    ];
    const attackContextByAttack = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 150,
      allBasesOpenHoursLeft: 12,
    });
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: participants as any,
      attacks: attacks as any,
      attackContextByAttack,
      linkedGroups: [
        {
          key: "user:linked",
          isLinked: true,
          memberTags: ["#A444", "#B555"],
          memberTagSet: new Set(["#A444", "#B555"]),
        },
      ] as any,
    });

    const owner = evaluation.resultsByPlayerTag.get("#A444");
    const breach = evaluation.resultsByPlayerTag.get("#B555");

    expect(owner?.consumedSubstitutionAttackIndexes).toEqual([0]);
    expect(owner?.consumedSubstitutionAttackOrders).toEqual([7]);
    expect(breach?.consumedSubstitutionAttackIndexes).toEqual([]);
    expect(breach?.consumedSubstitutionAttackOrders).toEqual([]);
    expect(breach?.attackDetails.map((detail) => detail.isBreach)).toEqual([true]);
  });

  it("FWA LOSE Traditional plan: records missing-order consumed substitutions by index only", () => {
    const warEndTime = dateAt(24);
    const participants = [
      { playerName: "owner", playerTag: "#A444", attacksUsed: 1, playerPosition: 4 },
      { playerName: "mirror", playerTag: "#B555", attacksUsed: 1, playerPosition: 5 },
    ];
    const attacks = [
      {
        playerTag: "#A444",
        playerName: "owner",
        playerPosition: 4,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: undefined as any,
      },
      {
        playerTag: "#B555",
        playerName: "mirror",
        playerPosition: 5,
        defenderPosition: 12,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date(Date.UTC(2026, 0, 1, 11, 10, 0)),
        warEndTime,
        attackOrder: undefined as any,
      },
    ];
    const attackContextByAttack = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 150,
      allBasesOpenHoursLeft: 12,
    });
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: participants as any,
      attacks: attacks as any,
      attackContextByAttack,
      linkedGroups: [
        {
          key: "user:linked",
          isLinked: true,
          memberTags: ["#A444", "#B555"],
          memberTagSet: new Set(["#A444", "#B555"]),
        },
      ] as any,
    });

    const owner = evaluation.resultsByPlayerTag.get("#A444");
    const mirror = evaluation.resultsByPlayerTag.get("#B555");

    expect(owner?.consumedSubstitutionAttackIndexes).toEqual([0]);
    expect(owner?.consumedSubstitutionAttackOrders).toEqual([]);
    expect(owner?.hasViolation).toBe(false);
    expect(mirror?.consumedSubstitutionAttackIndexes).toEqual([]);
    expect(mirror?.consumedSubstitutionAttackOrders).toEqual([]);
    expect(mirror?.hasViolation).toBe(true);
    expect(mirror?.reason.label).toBe("early non-mirror 2-star in traditional loss");
  });

  it("FWA LOSE Traditional plan: consumes a missing-order linked substitution before a later valid-order outsider attack", () => {
    const warEndTime = dateAt(24);
    const participants = [
      { playerName: "owner5", playerTag: "#P555", attacksUsed: 1, playerPosition: 5 },
      { playerName: "helper", playerTag: "#H444", attacksUsed: 1, playerPosition: 10 },
      { playerName: "outsider", playerTag: "#U333", attacksUsed: 1, playerPosition: 11 },
    ];
    const attacks = [
      {
        playerTag: "#H444",
        playerName: "helper",
        playerPosition: 10,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: undefined as any,
      },
      {
        playerTag: "#U333",
        playerName: "outsider",
        playerPosition: 11,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date(Date.UTC(2026, 0, 1, 11, 10, 0)),
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#P555",
        playerName: "owner5",
        playerPosition: 5,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date(Date.UTC(2026, 0, 1, 11, 20, 0)),
        warEndTime,
        attackOrder: undefined as any,
      },
    ];
    const attackContextByAttack = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 150,
      allBasesOpenHoursLeft: 12,
    });
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: participants as any,
      attacks: attacks as any,
      attackContextByAttack,
      linkedGroups: [
        {
          key: "user:linked",
          isLinked: true,
          memberTags: ["#P555", "#H444"],
          memberTagSet: new Set(["#P555", "#H444"]),
        },
      ] as any,
    });

    const owner5 = evaluation.resultsByPlayerTag.get("#P555");
    const helper = evaluation.resultsByPlayerTag.get("#H444");
    const outsider = evaluation.resultsByPlayerTag.get("#U333");

    expect(owner5?.ownerSatisfied).toBe(true);
    expect(helper?.consumedSubstitutionAttackIndexes).toEqual([0]);
    expect(helper?.consumedSubstitutionAttackOrders).toEqual([]);
    expect(helper?.hasViolation).toBe(false);
    expect(outsider?.consumedSubstitutionAttackIndexes).toEqual([]);
    expect(outsider?.consumedSubstitutionAttackOrders).toEqual([]);
    expect(outsider?.hasViolation).toBe(true);
    expect(outsider?.reason.label).toBe("early non-mirror 2-star in traditional loss");
  });

  it("FWA LOSE Traditional plan: lets a missing-order outsider satisfy the obligation before a later linked helper attack", () => {
    const warEndTime = dateAt(24);
    const participants = [
      { playerName: "owner5", playerTag: "#P555", attacksUsed: 1, playerPosition: 5 },
      { playerName: "helper", playerTag: "#H444", attacksUsed: 1, playerPosition: 10 },
      { playerName: "outsider", playerTag: "#U333", attacksUsed: 1, playerPosition: 11 },
    ];
    const attacks = [
      {
        playerTag: "#U333",
        playerName: "outsider",
        playerPosition: 11,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: undefined as any,
      },
      {
        playerTag: "#H444",
        playerName: "helper",
        playerPosition: 10,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date(Date.UTC(2026, 0, 1, 11, 10, 0)),
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#P555",
        playerName: "owner5",
        playerPosition: 5,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date(Date.UTC(2026, 0, 1, 11, 20, 0)),
        warEndTime,
        attackOrder: undefined as any,
      },
    ];
    const attackContextByAttack = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 150,
      allBasesOpenHoursLeft: 12,
    });
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: participants as any,
      attacks: attacks as any,
      attackContextByAttack,
      linkedGroups: [
        {
          key: "user:linked",
          isLinked: true,
          memberTags: ["#P555", "#H444"],
          memberTagSet: new Set(["#P555", "#H444"]),
        },
      ] as any,
    });

    const owner5 = evaluation.resultsByPlayerTag.get("#P555");
    const helper = evaluation.resultsByPlayerTag.get("#H444");
    const outsider = evaluation.resultsByPlayerTag.get("#U333");

    expect(owner5?.ownerSatisfied).toBe(true);
    expect(outsider?.consumedSubstitutionAttackIndexes).toEqual([]);
    expect(outsider?.consumedSubstitutionAttackOrders).toEqual([]);
    expect(outsider?.hasViolation).toBe(true);
    expect(outsider?.reason.label).toBe("early non-mirror 2-star in traditional loss");
    expect(helper?.consumedSubstitutionAttackIndexes).toEqual([]);
    expect(helper?.consumedSubstitutionAttackOrders).toEqual([]);
    expect(helper?.hasViolation).toBe(true);
    expect(helper?.reason.label).toBe("early non-mirror 2-star in traditional loss");
  });

  it.each([0, -3])(
    "FWA LOSE Traditional plan: treats invalid attack order %s as non-reportable consumed metadata",
    (invalidOrder) => {
      const warEndTime = dateAt(24);
      const participants = [
        { playerName: "owner5", playerTag: "#P555", attacksUsed: 1, playerPosition: 5 },
        { playerName: "helper", playerTag: "#H444", attacksUsed: 1, playerPosition: 10 },
        { playerName: "outsider", playerTag: "#U333", attacksUsed: 1, playerPosition: 11 },
      ];
      const attacks = [
        {
          playerTag: "#H444",
          playerName: "helper",
          playerPosition: 10,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(11),
          warEndTime,
          attackOrder: invalidOrder,
        },
        {
          playerTag: "#U333",
          playerName: "outsider",
          playerPosition: 11,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: new Date(Date.UTC(2026, 0, 1, 11, 10, 0)),
          warEndTime,
          attackOrder: 2,
        },
        {
          playerTag: "#P555",
          playerName: "owner5",
          playerPosition: 5,
          defenderPosition: 5,
          stars: 2,
          trueStars: 2,
          attackSeenAt: new Date(Date.UTC(2026, 0, 1, 11, 20, 0)),
          warEndTime,
          attackOrder: undefined as any,
        },
      ];
      const attackContextByAttack = buildAttackContextByAttack(attacks as any, {
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
      });
      const evaluation = evaluateFwaTraditionalLossComplianceForTest({
        participants: participants as any,
        attacks: attacks as any,
        attackContextByAttack,
        linkedGroups: [
          {
            key: "user:linked",
            isLinked: true,
            memberTags: ["#P555", "#H444"],
            memberTagSet: new Set(["#P555", "#H444"]),
          },
        ] as any,
      });

      const helper = evaluation.resultsByPlayerTag.get("#H444");
      const outsider = evaluation.resultsByPlayerTag.get("#U333");

      expect(helper?.consumedSubstitutionAttackIndexes).toEqual([0]);
      expect(helper?.consumedSubstitutionAttackOrders).toEqual([]);
      expect(helper?.hasViolation).toBe(false);
      expect(outsider?.consumedSubstitutionAttackIndexes).toEqual([]);
      expect(outsider?.consumedSubstitutionAttackOrders).toEqual([]);
      expect(outsider?.hasViolation).toBe(true);
      expect(outsider?.reason.label).toBe("early non-mirror 2-star in traditional loss");
      expect([...evaluation.consumedSubstitutionAttackOrders]).toEqual([]);
    },
  );

  it("FWA LOSE Traditional plan: consumes the lower attackOrder even when it is seen later", () => {
    const warEndTime = dateAt(24);
    const participants = [
      { playerName: "owner5", playerTag: "#P555", attacksUsed: 1, playerPosition: 5 },
      { playerName: "helper", playerTag: "#H444", attacksUsed: 1, playerPosition: 10 },
      { playerName: "outsider", playerTag: "#U333", attacksUsed: 1, playerPosition: 11 },
    ];
    const attacks = [
      {
        playerTag: "#U333",
        playerName: "outsider",
        playerPosition: 11,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(10),
        warEndTime,
        attackOrder: 3,
      },
      {
        playerTag: "#H444",
        playerName: "helper",
        playerPosition: 10,
        defenderPosition: 5,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#P555",
        playerName: "owner5",
        playerPosition: 5,
        defenderPosition: 1,
        stars: 1,
        trueStars: 1,
        attackSeenAt: dateAt(11),
        warEndTime,
        attackOrder: 1,
      },
    ];
    const attackContextByAttack = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 150,
      allBasesOpenHoursLeft: 12,
    });
    const evaluation = evaluateFwaTraditionalLossComplianceForTest({
      participants: participants as any,
      attacks: attacks as any,
      attackContextByAttack,
      linkedGroups: [
        {
          key: "user:linked",
          isLinked: true,
          memberTags: ["#P555", "#H444"],
          memberTagSet: new Set(["#P555", "#H444"]),
        },
      ] as any,
    });

    const owner5 = evaluation.resultsByPlayerTag.get("#P555");
    const helper = evaluation.resultsByPlayerTag.get("#H444");
    const outsider = evaluation.resultsByPlayerTag.get("#U333");

    expect(owner5?.ownerSatisfied).toBe(true);
    expect(helper?.consumedSubstitutionAttackIndexes).toEqual([1]);
    expect(helper?.consumedSubstitutionAttackOrders).toEqual([2]);
    expect(helper?.hasViolation).toBe(false);
    expect(outsider?.consumedSubstitutionAttackIndexes).toEqual([]);
    expect(outsider?.consumedSubstitutionAttackOrders).toEqual([]);
    expect(outsider?.hasViolation).toBe(true);
    expect(outsider?.reason.label).toBe("early non-mirror 2-star in traditional loss");
  });

  it("FWA LOSE Traditional plan: flags only the exact cap-crossing attack in shared chronology", () => {
    const warEndTime = dateAt(24);
    const attacks = [
      {
        playerTag: "#EARLY",
        playerName: "early",
        playerPosition: 1,
        defenderPosition: 11,
        stars: 2,
        trueStars: 100,
        attackSeenAt: dateAt(13),
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#LATE",
        playerName: "lateCap",
        playerPosition: 2,
        defenderPosition: 12,
        stars: 2,
        trueStars: 3,
        attackSeenAt: dateAt(14),
        warEndTime,
        attackOrder: 1,
      },
    ];

    const contexts = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 150,
      allBasesOpenHoursLeft: 12,
    });

    expect(contexts.get(attacks[0] as any)?.starsBeforeAttack).toBe(3);
    expect(contexts.get(attacks[1] as any)?.starsBeforeAttack).toBe(0);

    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants: [
        { playerName: "early", playerTag: "#EARLY", attacksUsed: 1, playerPosition: 1 },
        { playerName: "lateCap", playerTag: "#LATE", attacksUsed: 1, playerPosition: 2 },
      ],
      attacks: attacks as any,
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });

    expect(result.notFollowingPlan).toEqual(["early"]);
  });
});

describe("WarEventLogService.shared chronology", () => {
  it("counts prior trueStars from zero for each valid attack order", () => {
    const warEndTime = dateAt(20);
    const attacks = [
      {
        playerTag: "#A",
        playerName: "A",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 1,
        trueStars: 1,
        attackSeenAt: dateAt(1),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#B",
        playerName: "B",
        playerPosition: 2,
        defenderPosition: 2,
        stars: 2,
        trueStars: 2,
        attackSeenAt: dateAt(2),
        warEndTime,
        attackOrder: 2,
      },
      {
        playerTag: "#C",
        playerName: "C",
        playerPosition: 3,
        defenderPosition: 3,
        stars: 0,
        trueStars: 0,
        attackSeenAt: dateAt(3),
        warEndTime,
        attackOrder: 3,
      },
      {
        playerTag: "#D",
        playerName: "D",
        playerPosition: 4,
        defenderPosition: 4,
        stars: 3,
        trueStars: 3,
        attackSeenAt: dateAt(4),
        warEndTime,
        attackOrder: 4,
      },
    ];

    const contexts = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 2,
      allBasesOpenHoursLeft: 12,
    });

    expect(contexts.get(attacks[0] as any)?.starsBeforeAttack).toBe(0);
    expect(contexts.get(attacks[1] as any)?.starsBeforeAttack).toBe(1);
    expect(contexts.get(attacks[2] as any)?.starsBeforeAttack).toBe(3);
    expect(contexts.get(attacks[3] as any)?.starsBeforeAttack).toBe(3);
  });

  it("keeps a 2-star gate strict when only 1 true star has been earned", () => {
    const warEndTime = dateAt(20);
    const attacks = [
      {
        playerTag: "#A",
        playerName: "A",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 3,
        trueStars: 1,
        attackSeenAt: dateAt(1),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#B",
        playerName: "B",
        playerPosition: 2,
        defenderPosition: 2,
        stars: 3,
        trueStars: 3,
        attackSeenAt: dateAt(2),
        warEndTime,
        attackOrder: 2,
      },
    ];

    const contexts = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 2,
      allBasesOpenHoursLeft: 12,
    });

    expect(contexts.get(attacks[1] as any)?.starsBeforeAttack).toBe(1);
    expect(contexts.get(attacks[1] as any)?.isStrictWindow).toBe(true);
  });

  it("opens the gate once prior trueStars reach the configured threshold", () => {
    const warEndTime = dateAt(20);
    const attacks = [
      {
        playerTag: "#A",
        playerName: "A",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 3,
        trueStars: 2,
        attackSeenAt: dateAt(1),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#B",
        playerName: "B",
        playerPosition: 2,
        defenderPosition: 2,
        stars: 3,
        trueStars: 3,
        attackSeenAt: dateAt(2),
        warEndTime,
        attackOrder: 2,
      },
    ];

    const contexts = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 2,
      allBasesOpenHoursLeft: 12,
    });

    expect(contexts.get(attacks[1] as any)?.starsBeforeAttack).toBe(2);
    expect(contexts.get(attacks[1] as any)?.isStrictWindow).toBe(false);
  });

  it("does not open the gate from displayed stars when trueStars remain below the threshold", () => {
    const warEndTime = dateAt(20);
    const attacks = [
      {
        playerTag: "#A",
        playerName: "A",
        playerPosition: 1,
        defenderPosition: 1,
        stars: 3,
        trueStars: 0,
        attackSeenAt: dateAt(1),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#B",
        playerName: "B",
        playerPosition: 2,
        defenderPosition: 2,
        stars: 3,
        trueStars: 0,
        attackSeenAt: dateAt(2),
        warEndTime,
        attackOrder: 2,
      },
    ];

    const contexts = buildAttackContextByAttack(attacks as any, {
      nonMirrorTripleMinClanStars: 2,
      allBasesOpenHoursLeft: 12,
    });

    expect(contexts.get(attacks[1] as any)?.starsBeforeAttack).toBe(0);
    expect(contexts.get(attacks[1] as any)?.isStrictWindow).toBe(true);
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
  it("builds reminder content with the tracked clan role mention", () => {
    expect(
      buildFwaBaseSwapBattleDayReminderContentForTest({
        clanRoleId: "123456789",
        matchType: "BL",
      }),
    ).toBe(
      "### Battle Day Started!\nThanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.\n<@&123456789>",
    );
  });

  it("builds CWL reminder content without a role mention when no roster role exists", () => {
    expect(
      buildFwaBaseSwapBattleDayReminderContentForTest({
        clanRoleId: null,
        matchType: "CWL",
      }),
    ).toBe(
      "### Battle Day Started!\nThanks everyone for swapping to war bases for the serious CWL. Please swap back to your FWA base for the next FWA war.",
    );
  });

  it("sends the BL reminder to the tracked base-swap channel with a clan role ping", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: null }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-1",
      url: `https://discord.com/channels/${testGuildId}/${baseSwapChannelId}/reminder-1`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const fetchSpy = vi.fn().mockImplementation(async (channelId: string) => {
      if (channelId === baseSwapChannelId) return makeTextChannel(reminderSend);
      if (channelId === botLogChannelId) return makeTextChannel(botLogSend);
      throw new Error(`unexpected channel lookup: ${channelId}`);
    });

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate({ channelId: baseSwapChannelId }));
    vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    ).mockResolvedValue(true);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = {
      channels: {
        fetch: fetchSpy,
      },
    } as any;

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
        "### Battle Day Started!\nThanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.\n<@&123456789>",
      allowedMentions: { roles: ["123456789"] },
    });
    expect(fetchSpy).toHaveBeenCalledWith(baseSwapChannelId);
    expect(fetchSpy).not.toHaveBeenCalledWith(mailChannelId);
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toBe(
      buildFwaBaseSwapBattleDayReminderLogContentForTest({
        clanName: "Test Clan",
        clanTag: testClanTag,
        targetChannelId: baseSwapChannelId,
        reminderMessageUrl: `https://discord.com/channels/${testGuildId}/${baseSwapChannelId}/reminder-1`,
        referenceId: "fwa-base-swap:split-key",
        clanRoleMentionIncluded: true,
      }),
    );
  });

  it("returns false and logs tracked_channel_unavailable when the tracked base-swap channel is unavailable", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: null }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-2",
      url: `https://discord.com/channels/${testGuildId}/${baseSwapChannelId}/reminder-2`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const claimSpy = vi.spyOn(trackedMessageService, "claimFwaBaseSwapBattleDayReminder");

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate({ channelId: baseSwapChannelId }));
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
        clanRoleId: null,
        channelId: notifyChannelId,
      },
      payload: {
        eventType: "battle_day",
        matchType: "BL",
      },
    });

    expect(sent).toBe(false);
    expect(reminderSend).not.toHaveBeenCalled();
    expect(claimSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=tracked_channel_unavailable"),
    );
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain("FWA base-swap battle-day reminder failed");
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain("Failure reason: tracked_channel_unavailable");
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain(`/fwa base-swap reminder tied to Test Clan (#${testClanTag})`);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain(
      `Target channel: <#${baseSwapChannelId}>`,
    );
  });

  it("skips when the tracked base-swap channel is unavailable and does not claim", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: null }]);
    const reminderSend = vi.fn();
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate({ channelId: baseSwapChannelId }));
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=tracked_channel_unavailable"),
    );
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain(`Target channel: <#${baseSwapChannelId}>`);
  });

  it("skips when the tracked base-swap channel is not text-based or sendable", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: null }]);
    const reminderSend = vi.fn();
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate({ channelId: baseSwapChannelId }));
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
      extraChannels: {
        [baseSwapChannelId]: {
          guildId: testGuildId,
          isTextBased: () => false,
          send: reminderSend,
        },
      },
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
      expect.stringContaining("reason=tracked_channel_unavailable"),
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

  it("skips the BL reminder when swap-reminder is false", async () => {
    const reminderSend = vi.fn();
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapTrackedMessageForClan",
    ).mockResolvedValue(
      makeFwaBaseSwapCandidate({
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "FWA",
          swapReminder: false,
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
      }),
    );

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
  });

  it("skips the BL reminder when no fwa_bases entry exists", async () => {
    const reminderSend = vi.fn();
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapTrackedMessageForClan",
    ).mockResolvedValue(
      makeFwaBaseSwapCandidate({
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "FWA",
          swapReminder: true,
          entries: [
            {
              position: 1,
              playerTag: "#AAA111",
              playerName: "Alpha",
              discordUserId: "100",
              townhallLevel: 18,
              section: "war_bases",
              acknowledged: true,
            },
          ],
          layoutLinks: [],
        },
      }),
    );

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
  });

  it("sends the CWL reminder to the tracked base-swap channel with the best-matching roster role", async () => {
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-cwl-1",
      url: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-cwl-1`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const currentRound = {
      season: "2026-06",
      clanTag: testClanTag,
      clanName: "Test Clan",
      roundDay: 2,
      roundState: "inWar",
      opponentTag: "#OPP",
      opponentName: "Enemy",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-06-03T09:00:00.000Z"),
      startTime: new Date("2026-06-03T12:00:00.000Z"),
      endTime: new Date("2026-06-03T14:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-06-03T12:00:00.000Z"),
      members: [],
    };
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        guildId: testGuildId,
        clanTag: testClanTag,
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "CWL",
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
      },
    ]);
    prismaMock.roster.findMany.mockResolvedValue([
      {
        id: "roster-1",
        rosterRoleId: "role-closed",
        lifecycleState: "CLOSED",
        startsAt: new Date("2026-05-01T00:00:00.000Z"),
        endsAt: new Date("2026-06-01T00:00:00.000Z"),
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        guildId: testGuildId,
        rosterType: "CWL",
        clanTag: testClanTag,
      },
      {
        id: "roster-2",
        rosterRoleId: "role-best",
        lifecycleState: "ACTIVE",
        startsAt: new Date("2026-05-20T00:00:00.000Z"),
        endsAt: new Date("2026-06-10T00:00:00.000Z"),
        createdAt: new Date("2026-05-20T00:00:00.000Z"),
        guildId: testGuildId,
        rosterType: "CWL",
        clanTag: testClanTag,
      },
      {
        id: "roster-3",
        rosterRoleId: "role-open",
        lifecycleState: "OPEN",
        startsAt: new Date("2026-05-25T00:00:00.000Z"),
        endsAt: new Date("2026-06-08T00:00:00.000Z"),
        createdAt: new Date("2026-05-25T00:00:00.000Z"),
        guildId: testGuildId,
        rosterType: "CWL",
        clanTag: testClanTag,
      },
    ] as any);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue(
      currentRound as any,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapTrackedMessageForClan",
    ).mockResolvedValue(
      makeFwaBaseSwapCandidate({
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "CWL",
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
      }),
    );
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
    const sentCount = await (service as any).sendCwlBaseSwapBattleDayReminders();

    expect(sentCount).toBe(1);
    expect(reminderSend).toHaveBeenCalledTimes(1);
    expect(reminderSend).toHaveBeenCalledWith({
      content:
        "### Battle Day Started!\nThanks everyone for swapping to war bases for the serious CWL. Please swap back to your FWA base for the next FWA war.\n<@&role-best>",
      allowedMentions: { roles: ["role-best"] },
    });
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain(`Target channel: <#${mailChannelId}>`);
    expect(
      String(botLogSend.mock.calls[0]?.[0]?.content ?? ""),
    ).toContain("Clan role ping included: yes");
  });

  it("sends the CWL reminder without a ping when no roster role exists", async () => {
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-cwl-2",
      url: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-cwl-2`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const currentRound = {
      season: "2026-06",
      clanTag: testClanTag,
      clanName: "Test Clan",
      roundDay: 2,
      roundState: "inWar",
      opponentTag: "#OPP",
      opponentName: "Enemy",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-06-03T09:00:00.000Z"),
      startTime: new Date("2026-06-03T12:00:00.000Z"),
      endTime: new Date("2026-06-03T14:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-06-03T12:00:00.000Z"),
      members: [],
    };
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        guildId: testGuildId,
        clanTag: testClanTag,
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "CWL",
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
      },
    ]);
    prismaMock.roster.findMany.mockResolvedValue([]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue(
      currentRound as any,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapTrackedMessageForClan",
    ).mockResolvedValue(
      makeFwaBaseSwapCandidate({
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "CWL",
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
      }),
    );
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
    const sentCount = await (service as any).sendCwlBaseSwapBattleDayReminders();

    expect(sentCount).toBe(1);
    expect(reminderSend).toHaveBeenCalledTimes(1);
    expect(reminderSend).toHaveBeenCalledWith({
      content:
        "### Battle Day Started!\nThanks everyone for swapping to war bases for the serious CWL. Please swap back to your FWA base for the next FWA war.",
      allowedMentions: { parse: [] },
    });
  });

  it("skips the CWL reminder when swap-reminder is false", async () => {
    const reminderSend = vi.fn();
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        guildId: testGuildId,
        clanTag: testClanTag,
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "CWL",
          swapReminder: false,
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
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-06",
      clanTag: testClanTag,
      clanName: "Test Clan",
      roundDay: 2,
      roundState: "inWar",
      opponentTag: "#OPP",
      opponentName: "Enemy",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-06-03T09:00:00.000Z"),
      startTime: new Date("2026-06-03T12:00:00.000Z"),
      endTime: new Date("2026-06-03T14:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-06-03T12:00:00.000Z"),
      members: [],
    } as any);

    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
    });
    const service = new WarEventLogService(client, {} as any);

    const sentCount = await (service as any).sendCwlBaseSwapBattleDayReminders();

    expect(sentCount).toBe(0);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(reminderSend).not.toHaveBeenCalled();
  });

  it("skips the CWL reminder when no fwa_bases entry exists", async () => {
    const reminderSend = vi.fn();
    const claimSpy = vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    );
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        guildId: testGuildId,
        clanTag: testClanTag,
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "CWL",
          swapReminder: true,
          entries: [
            {
              position: 1,
              playerTag: "#AAA111",
              playerName: "Alpha",
              discordUserId: "100",
              townhallLevel: 18,
              section: "war_bases",
              acknowledged: true,
            },
          ],
          layoutLinks: [],
        },
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-06",
      clanTag: testClanTag,
      clanName: "Test Clan",
      roundDay: 2,
      roundState: "inWar",
      opponentTag: "#OPP",
      opponentName: "Enemy",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-06-03T09:00:00.000Z"),
      startTime: new Date("2026-06-03T12:00:00.000Z"),
      endTime: new Date("2026-06-03T14:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-06-03T12:00:00.000Z"),
      members: [],
    } as any);

    const client = makeReminderClient({
      mailChannel: makeTextChannel(reminderSend),
    });
    const service = new WarEventLogService(client, {} as any);

    const sentCount = await (service as any).sendCwlBaseSwapBattleDayReminders();

    expect(sentCount).toBe(0);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(reminderSend).not.toHaveBeenCalled();
  });

  it("sends only once when the same CWL reference identity is claimed twice", async () => {
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-cwl-3",
      url: `https://discord.com/channels/${testGuildId}/${mailChannelId}/reminder-cwl-3`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const currentRound = {
      season: "2026-06",
      clanTag: testClanTag,
      clanName: "Test Clan",
      roundDay: 2,
      roundState: "inWar",
      opponentTag: "#OPP",
      opponentName: "Enemy",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-06-03T09:00:00.000Z"),
      startTime: new Date("2026-06-03T12:00:00.000Z"),
      endTime: new Date("2026-06-03T14:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-06-03T12:00:00.000Z"),
      members: [],
    };
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        guildId: testGuildId,
        clanTag: testClanTag,
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "CWL",
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
      },
    ]);
    prismaMock.roster.findMany.mockResolvedValue([
      {
        id: "roster-2",
        rosterRoleId: "role-best",
        lifecycleState: "ACTIVE",
        startsAt: new Date("2026-05-20T00:00:00.000Z"),
        endsAt: new Date("2026-06-10T00:00:00.000Z"),
        createdAt: new Date("2026-05-20T00:00:00.000Z"),
        guildId: testGuildId,
        rosterType: "CWL",
        clanTag: testClanTag,
      },
    ] as any);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue(
      currentRound as any,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapTrackedMessageForClan",
    ).mockResolvedValue(
      makeFwaBaseSwapCandidate({
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-03-20T00:05:00.000Z",
          clanKind: "CWL",
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
      }),
    );
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
    const first = await (service as any).sendCwlBaseSwapBattleDayReminders();
    const second = await (service as any).sendCwlBaseSwapBattleDayReminders();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(reminderSend).toHaveBeenCalledTimes(1);
  expect(botLogSend).toHaveBeenCalledTimes(1);
  });

  it("sends the reminder even when notify is disabled", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: null }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-1",
      url: `https://discord.com/channels/${testGuildId}/${baseSwapChannelId}/reminder-1`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const fetchSpy = vi.fn().mockImplementation(async (channelId: string) => {
      if (channelId === baseSwapChannelId) return makeTextChannel(reminderSend);
      if (channelId === botLogChannelId) return makeTextChannel(botLogSend);
      throw new Error(`unexpected channel lookup: ${channelId}`);
    });

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate({ channelId: baseSwapChannelId }));
    vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    ).mockResolvedValue(true);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = {
      channels: {
        fetch: fetchSpy,
      },
    } as any;
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
        "### Battle Day Started!\nThanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.\n<@&123456789>",
      allowedMentions: { roles: ["123456789"] },
    });
    expect(fetchSpy).toHaveBeenCalledWith(baseSwapChannelId);
    expect(fetchSpy).not.toHaveBeenCalledWith(mailChannelId);
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
    prismaMock.$queryRaw.mockResolvedValue([{ mailChannelId: null }]);
    const reminderSend = vi.fn().mockResolvedValue({
      id: "reminder-1",
      url: `https://discord.com/channels/${testGuildId}/${baseSwapChannelId}/reminder-1`,
    });
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const fetchSpy = vi.fn().mockImplementation(async (channelId: string) => {
      if (channelId === baseSwapChannelId) return makeTextChannel(reminderSend);
      if (channelId === botLogChannelId) return makeTextChannel(botLogSend);
      throw new Error(`unexpected channel lookup: ${channelId}`);
    });

    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaBaseSwapReminderCandidate",
    ).mockResolvedValue(makeFwaBaseSwapCandidate({ channelId: baseSwapChannelId }));
    vi.spyOn(
      trackedMessageService,
      "claimFwaBaseSwapBattleDayReminder",
    ).mockResolvedValue(true);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      botLogChannelId,
    );

    const client = {
      channels: {
        fetch: fetchSpy,
      },
    } as any;
    const service = new WarEventLogService(client, {} as any);
    vi.spyOn(service as any, "reserveEventDelivery").mockResolvedValue({
      state: "in_flight",
      warId: "123",
      reason: "reservation_in_flight",
    });

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
        "### Battle Day Started!\nThanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.\n<@&123456789>",
      allowedMentions: { roles: ["123456789"] },
    });
    expect(fetchSpy).toHaveBeenCalledWith(baseSwapChannelId);
    expect(fetchSpy).not.toHaveBeenCalledWith(mailChannelId);
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
  it("uses exact same-war persisted FWA evidence for an inferred live goal", async () => {
    const send = vi.fn().mockResolvedValue({ id: "inferred-goal-message" });
    const service = new WarEventLogService(
      {
        channels: { fetch: vi.fn().mockResolvedValue(makeTextChannel(send)) },
      } as any,
      {} as any,
    );
    vi.spyOn((service as any).botLogChannels, "getRoutingConfigForType").mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "999999999999999991",
      legacy: false,
      configured: true,
    });
    prismaMock.warEvent.create.mockResolvedValue({ createdAt: new Date() });
    prismaMock.warEvent.updateMany.mockResolvedValue({ count: 1 });

    await (service as any).evaluateAndDeliverLiveWarClanGoals({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
      },
      currentState: "inWar",
      matchType: "FWA",
      inferredMatchType: true,
      authoritativeMatchType: "FWA",
      outcome: "WIN",
      clanStars: 150,
      resolvedWarId: 777,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("#2QG2C08UP"),
      allowedMentions: { parse: [] },
    });
    expect(prismaMock.warEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          warId: 777,
          eventType: "clan_goal:FWA_WIN_150_STARS",
        }),
      }),
    );
  });

  it("routes live clan goals through the tracked clan chat channel", async () => {
    const send = vi.fn().mockResolvedValue({ id: "clan-chat-goal-message" });
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn().mockResolvedValue(makeTextChannel(send)) } } as any,
      {} as any,
    );
    vi.spyOn((service as any).botLogChannels, "getRoutingConfigForType").mockResolvedValue({
      routingMode: "CLAN_CHAT",
      channelId: null,
      legacy: false,
      configured: true,
    });
    prismaMock.warEvent.create.mockResolvedValue({ createdAt: new Date() });
    prismaMock.warEvent.updateMany.mockResolvedValue({ count: 1 });

    await (service as any).evaluateAndDeliverLiveWarClanGoals({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
        trackedChatChannelId: "888888888888888888",
      },
      currentState: "inWar",
      matchType: "FWA",
      inferredMatchType: false,
      authoritativeMatchType: "FWA",
      outcome: "LOSE",
      clanStars: 103,
      resolvedWarId: 778,
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("matches exact physical-war identity while treating war IDs as supplemental", () => {
    const startTime = new Date("2026-08-06T11:34:09.000Z");
    const base = {
      effectiveWarIdentityChanged: false,
      sub: {
        startTime,
        pointsWarStartTime: startTime,
        warId: 1000736,
        pointsWarId: "1000736",
        opponentTag: "#YUL2L098",
        pointsOpponentTag: "#yul2l098",
        pointsIsFwa: true,
        pointsLastKnownMatchType: "FWA",
      },
    };

    // 1. Exact start/opponent + matching IDs + positive FWA evidence.
    expect(resolveSameWarPersistedMatchEvidenceForTest(base as any)).toBe("FWA");

    // 2. Current war ID can be present while the nullable points ID is absent.
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, pointsWarId: null },
      } as any),
    ).toBe("FWA");

    // 3. Points war ID can be present while the current ID is absent.
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, warId: null },
      } as any),
    ).toBe("FWA");

    // 4. Two populated but conflicting IDs still fail closed.
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, pointsWarId: "1000737" },
      } as any),
    ).toBeNull();

    // 5. Physical-war start mismatch.
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: {
          ...base.sub,
          startTime: new Date(startTime.getTime() - 24 * 60 * 60 * 1000),
        },
      } as any),
    ).toBeNull();

    // 6. Physical-war opponent mismatch.
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, pointsOpponentTag: "#DIFFERENT" },
      } as any),
    ).toBeNull();

    // 7. A poll-detected identity change invalidates the evidence.
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        effectiveWarIdentityChanged: true,
      } as any),
    ).toBeNull();

    // 8. FWA evidence must be explicitly positive.
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, pointsIsFwa: false },
      } as any),
    ).toBeNull();
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, pointsIsFwa: null },
      } as any),
    ).toBeNull();

    // 9. A conflicting stored classification cannot authorize live FWA goals.
    for (const lastKnownMatchType of ["BL", "MM"]) {
      expect(
        resolveSameWarPersistedMatchEvidenceForTest({
          ...base,
          sub: { ...base.sub, pointsLastKnownMatchType: lastKnownMatchType },
        } as any),
      ).toBeNull();
    }
  });

  it("requires explicit same-war BL evidence when points identify a non-FWA war", () => {
    const startTime = new Date("2026-08-06T11:34:09.000Z");
    const base = {
      effectiveWarIdentityChanged: false,
      sub: {
        startTime,
        pointsWarStartTime: startTime,
        warId: 1000736,
        pointsWarId: "1000736",
        opponentTag: "#YUL2L098",
        pointsOpponentTag: "#yul2l098",
        pointsIsFwa: false,
        pointsLastKnownMatchType: "BL",
      },
    };

    expect(resolveSameWarPersistedMatchEvidenceForTest(base as any)).toBe("BL");
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, pointsLastKnownMatchType: "MM" },
      } as any),
    ).toBeNull();
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, pointsLastKnownMatchType: "" },
      } as any),
    ).toBeNull();
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: {
          ...base.sub,
          pointsWarStartTime: new Date(startTime.getTime() - 60_000),
        },
      } as any),
    ).toBeNull();
    expect(
      resolveSameWarPersistedMatchEvidenceForTest({
        ...base,
        sub: { ...base.sub, pointsOpponentTag: "#DIFFERENT" },
      } as any),
    ).toBeNull();
  });

  it("deduplicates threshold diagnostics for unresolved live classifications", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as any, {} as any);
    const input = {
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
      },
      currentState: "inWar",
      matchType: "FWA",
      inferredMatchType: true,
      outcome: "WIN",
      clanStars: 150,
      resolvedWarId: 777,
    };

    await (service as any).evaluateAndDeliverLiveWarClanGoals(input);
    await (service as any).evaluateAndDeliverLiveWarClanGoals(input);

    expect(debugSpy).toHaveBeenCalledTimes(4);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("event=live_war_evaluation outcome=skip"),
    );
  });

  it("posts qualified live-war clan goals through custom routing and never pings", async () => {
    const send = vi.fn().mockResolvedValue({ id: "goal-message-1" });
    const service = new WarEventLogService(
      {
      channels: { fetch: vi.fn().mockResolvedValue(makeTextChannel(send)) },
      } as any,
      {} as any,
    );
    vi.spyOn((service as any).botLogChannels, "getRoutingConfigForType").mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "999999999999999991",
      legacy: false,
      configured: true,
    });
    prismaMock.warEvent.create.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prismaMock.warEvent.updateMany.mockResolvedValue({ count: 1 });

    await (service as any).evaluateAndDeliverLiveWarClanGoals({
      sub: {
        guildId: testGuildId,
        clanTag: "#2QG2C08UP",
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
      },
      currentState: "inWar",
      matchType: "FWA",
      inferredMatchType: false,
      outcome: "LOSE",
      clanStars: 103,
      resolvedWarId: 123,
    });

    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("#2QG2C08UP"),
      allowedMentions: { parse: [] },
    });
    expect(prismaMock.warEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          warId: 123,
          eventType: "clan_goal:FWA_LOSE_TRADITIONAL_100_STARS",
        }),
      }),
    );
  });

  it("does not claim a disabled goal and releases a failed send for retry", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary Discord failure"))
      .mockResolvedValueOnce({ id: "goal-message-2" });
    const service = new WarEventLogService(
      {
        channels: { fetch: vi.fn().mockResolvedValue(makeTextChannel(send)) },
      } as any,
      {} as any,
    );
    const routeSpy = vi
      .spyOn((service as any).botLogChannels, "getRoutingConfigForType")
      .mockResolvedValue({
        routingMode: "DISABLED",
        channelId: null,
        legacy: false,
        configured: false,
      });
    await (service as any).evaluateAndDeliverLiveWarClanGoals({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
      },
      currentState: "inWar",
      matchType: "FWA",
      inferredMatchType: false,
      outcome: "LOSE",
      clanStars: 103,
      resolvedWarId: 123,
    });
    expect(routeSpy).toHaveBeenCalled();
    expect(prismaMock.warEvent.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    routeSpy.mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "999999999999999991",
      legacy: false,
      configured: true,
    });
    prismaMock.warEvent.create.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prismaMock.warEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.warEvent.deleteMany.mockResolvedValue({ count: 1 });
    await (service as any).evaluateAndDeliverLiveWarClanGoals({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
      },
      currentState: "inWar",
      matchType: "FWA",
      inferredMatchType: false,
      outcome: "LOSE",
      clanStars: 103,
      resolvedWarId: 123,
    });
    await (service as any).evaluateAndDeliverLiveWarClanGoals({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
      },
      currentState: "inWar",
      matchType: "FWA",
      inferredMatchType: false,
      outcome: "LOSE",
      clanStars: 103,
      resolvedWarId: 123,
    });
    prismaMock.warEvent.findUnique.mockResolvedValue({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      payload: { kind: "clan_goal_delivery", status: "delivered" },
    });
    await (service as any).evaluateAndDeliverLiveWarClanGoals({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
      },
      currentState: "inWar",
      matchType: "FWA",
      inferredMatchType: false,
      outcome: "LOSE",
      clanStars: 103,
      resolvedWarId: 123,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(prismaMock.warEvent.deleteMany).toHaveBeenCalled();
  });

  it("checks durable delivery before routing or fetching an already-delivered goal", async () => {
    const fetch = vi.fn();
    const service = new WarEventLogService({ channels: { fetch } } as any, {} as any);
    const routeSpy = vi.spyOn(
      (service as any).botLogChannels,
      "getRoutingConfigForType",
    );
    prismaMock.warEvent.findUnique.mockResolvedValue({
      createdAt: new Date(),
      payload: { kind: "clan_goal_delivery", status: "delivered" },
    });
    await (service as any).deliverLiveWarClanGoal({
      sub: {
        guildId: testGuildId,
        clanTag: testClanTag,
        clanName: "Goal Clan",
        loseStyle: "TRADITIONAL",
        trackedLogChannelId: null,
        trackedLeaderChannelId: null,
      },
      goalId: "FWA_NO_VIOLATIONS",
      warId: 123,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it("evaluates canonical war-end facts and delivers both qualified goals", async () => {
    const send = vi.fn().mockResolvedValue({ id: "canonical-goal-message" });
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn().mockResolvedValue(makeTextChannel(send)) } } as any,
      {} as any,
    );
    vi.spyOn((service as any).botLogChannels, "getRoutingConfigForType").mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "999999999999999991",
      legacy: false,
      configured: true,
    });
    prismaMock.clanWarHistory.findUnique.mockResolvedValue({
      warId: 123,
      clanTag: "#2QG2C08UP",
      clanName: "Canonical Clan",
      matchType: "FWA",
      expectedOutcome: "LOSE",
      warEndTime: new Date("2026-01-02T00:00:00.000Z"),
    });
    prismaMock.warLookup.findUnique.mockResolvedValue({
      payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" } },
    });
    prismaMock.warPlanComplianceEvaluation.findUnique.mockResolvedValue({
      guildId: testGuildId,
      warId: 123,
      status: "COMPLETED",
      matchType: "FWA",
      expectedOutcome: "LOSE",
      violations: [],
    });
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      { guildId: testGuildId, warId: "123", clanTag: "#2QG2C08UP", playerTag: "#P1", attacksMissed: 0 },
      { guildId: testGuildId, warId: "123", clanTag: "#2QG2C08UP", playerTag: "#P2", attacksMissed: 0 },
    ]);
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      name: "Canonical Clan",
      loseStyle: "TRADITIONAL",
      logChannelId: null,
      leaderChannelId: null,
      chatChannelId: "888888888888888888",
    });
    prismaMock.warEvent.findUnique.mockResolvedValue(null);
    prismaMock.warEvent.create.mockResolvedValue({ createdAt: new Date() });
    prismaMock.warEvent.updateMany.mockResolvedValue({ count: 1 });

    await (service as any).evaluateAndDeliverCanonicalWarEndGoals({
      guildId: testGuildId,
      clanTag: "#2QG2C08UP",
      warId: 123,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(prismaMock.warEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "clan_goal:FWA_NO_VIOLATIONS" }),
      }),
    );
    expect(prismaMock.warEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "clan_goal:WAR_NO_MISSED_ATTACKS" }),
      }),
    );
  });

  it("reconciles canonical goals in one batch and skips delivered identities before Discord", async () => {
    const send = vi.fn().mockResolvedValue({ id: "batch-goal-message" });
    const fetch = vi.fn().mockResolvedValue(makeTextChannel(send));
    const service = new WarEventLogService({ channels: { fetch } } as any, {} as any);
    vi.spyOn((service as any).botLogChannels, "getRoutingConfigForType").mockResolvedValue({
      routingMode: "CLAN_CHAT",
      channelId: null,
      legacy: false,
      configured: true,
    });
    const warEndTime = new Date();
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      {
        warId: 321,
        clanTag: "#2QG2C08UP",
        clanName: "Batch Clan",
        matchType: "FWA",
        expectedOutcome: "LOSE",
        warEndTime,
      },
    ]);
    prismaMock.warPlanComplianceEvaluation.findMany.mockResolvedValue([
      {
        guildId: testGuildId,
        warId: 321,
        completedAt: warEndTime,
        status: "COMPLETED",
        matchType: "FWA",
        expectedOutcome: "LOSE",
        violations: [],
      },
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      { guildId: testGuildId, warId: "321", clanTag: "#2QG2C08UP", playerTag: "#P1", attacksMissed: 0 },
      { guildId: testGuildId, warId: "321", clanTag: "#2QG2C08UP", playerTag: "#P2", attacksMissed: 0 },
    ]);
    prismaMock.warLookup.findMany.mockResolvedValue([
      { warId: "321", payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" } } },
    ]);
    prismaMock.warEvent.findMany.mockResolvedValue([
      {
        warId: 321,
        clanTag: "#2QG2C08UP",
        eventType: "clan_goal:FWA_NO_VIOLATIONS",
        createdAt: new Date(),
        payload: { status: "delivered" },
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Batch Clan",
        loseStyle: "TRADITIONAL",
        logChannelId: null,
        leaderChannelId: null,
        chatChannelId: "888888888888888888",
      },
    ]);
    prismaMock.warEvent.create.mockResolvedValue({ createdAt: new Date() });
    prismaMock.warEvent.updateMany.mockResolvedValue({ count: 1 });

    await (service as any).reconcileCanonicalWarEndGoals();

    expect(prismaMock.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.warPlanComplianceEvaluation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "COMPLETED",
          completedAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
    expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.warLookup.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.warEvent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.warPlanComplianceEvaluation.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.clanWarHistory.findUnique).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.warEvent.create).toHaveBeenCalledTimes(1);
  });

  it("discovers an old war from a recently completed compliance evaluation", async () => {
    const send = vi.fn().mockResolvedValue({ id: "late-compliance-message" });
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn().mockResolvedValue(makeTextChannel(send)) } } as any,
      {} as any,
    );
    vi.spyOn((service as any).botLogChannels, "getRoutingConfigForType").mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "999999999999999991",
      legacy: false,
      configured: true,
    });
    const completedAt = new Date();
    prismaMock.clanWarHistory.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          warId: 654,
          clanTag: "#2QG2C08UP",
          clanName: "Late Compliance Clan",
          matchType: "FWA",
          expectedOutcome: "LOSE",
          warEndTime: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        },
      ]);
    prismaMock.warPlanComplianceEvaluation.findMany
      .mockResolvedValueOnce([{ warId: 654, completedAt }])
      .mockResolvedValueOnce([
        {
          guildId: testGuildId,
          warId: 654,
          status: "COMPLETED",
          matchType: "FWA",
          expectedOutcome: "LOSE",
          violations: [],
        },
      ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([]);
    prismaMock.warLookup.findMany.mockResolvedValue([]);
    prismaMock.warEvent.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Late Compliance Clan",
        loseStyle: "TRADITIONAL",
        logChannelId: null,
        leaderChannelId: null,
      },
    ]);
    prismaMock.warEvent.create.mockResolvedValue({ createdAt: new Date() });
    prismaMock.warEvent.updateMany.mockResolvedValue({ count: 1 });

    await (service as any).reconcileCanonicalWarEndGoals();

    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.warEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "clan_goal:FWA_NO_VIOLATIONS" }),
      }),
    );
    expect(prismaMock.warEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanWarHistory.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { warEndTime: expect.objectContaining({ gte: expect.any(Date) }) },
      }),
    );
  });

  it("does not sweep an old war without a recent compliance completion", async () => {
    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as any, {} as any);
    prismaMock.clanWarHistory.findMany.mockResolvedValueOnce([]);
    prismaMock.warPlanComplianceEvaluation.findMany.mockResolvedValueOnce([]);

    await (service as any).reconcileCanonicalWarEndGoals();

    expect(prismaMock.clanWarHistory.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanWarParticipation.findMany).not.toHaveBeenCalled();
    expect(prismaMock.warEvent.create).not.toHaveBeenCalled();
  });

  it("selects the tracked clan role in the poll subscription query", async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    const service = new WarEventLogService({} as any, {} as any);

    const result = await (service as any).processSubscription(
      "guild-42",
      "#C0CU2Q82",
      { previousSync: null, activeSync: null },
    );

    expect(result).toBe(false);
    const queryArg = prismaMock.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    expect(queryArg?.strings?.join("")).toContain('tc."clanRoleId" AS "clanRoleId"');
    expect(queryArg?.strings?.join("")).toContain('tc."chatChannelId" AS "trackedChatChannelId"');
  });

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
      state: "claimed",
      warId: "1001",
      guardCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
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

  it("returns in_flight when another worker still owns the active delivery lease", async () => {
    const service = makeWarEventDeliveryService(vi.fn());
    const inFlightCreatedAt = new Date(Date.now() - 60_000);
    prismaMock.clanPostedMessage.findFirst.mockResolvedValue(null);
    prismaMock.warEvent.findFirst.mockResolvedValue({
      createdAt: inFlightCreatedAt,
    });

    const result = await (service as any).dispatchDetectedEvent({
      sub: makeWarEventSubscription(),
      payload: makeWarStartedEventPayload(),
      resolvedWarId: 1001,
    });

    expect(result).toEqual({
      state: "in_flight",
      warId: "1001",
      reason: "reservation_in_flight",
    });
    expect(prismaMock.warEvent.create).not.toHaveBeenCalled();
  });

  it("reclaims an expired lease and retains the completed WarEvent after durable delivery", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "message-1",
      createdTimestamp: Date.parse("2026-01-01T00:02:00.000Z"),
    });
    const service = makeWarEventDeliveryService(send);
    const expiredCreatedAt = new Date("2025-12-31T23:50:00.000Z");
    const claimedCreatedAt = new Date("2026-01-01T00:03:00.000Z");
    const warEventRows: Array<{
      warId: number;
      clanTag: string;
      eventType: string;
      createdAt: Date;
      payload: Record<string, unknown>;
    }> = [
      {
        warId: 1001,
        clanTag: "#C0CU2Q82",
        eventType: "war_started",
        createdAt: expiredCreatedAt,
        payload: {},
      },
    ];
    prismaMock.clanPostedMessage.findFirst.mockResolvedValue(null);
    prismaMock.warEvent.findFirst.mockImplementation(async ({ where }) => {
      return (
        warEventRows.find(
          (row) =>
            row.warId === where.warId &&
            row.clanTag === where.clanTag &&
            row.eventType === where.eventType,
        ) ?? null
      );
    });
    prismaMock.warEvent.deleteMany.mockImplementation(async ({ where }) => {
      const before = warEventRows.length;
      for (let i = warEventRows.length - 1; i >= 0; i -= 1) {
        const row = warEventRows[i];
        if (
          row.warId === where.warId &&
          row.clanTag === where.clanTag &&
          row.eventType === where.eventType &&
          row.createdAt.getTime() === where.createdAt.getTime()
        ) {
          warEventRows.splice(i, 1);
        }
      }
      return { count: before - warEventRows.length };
    });
    prismaMock.warEvent.create.mockImplementation(async ({ data }) => {
      const createdRow = {
        warId: data.warId,
        clanTag: data.clanTag,
        eventType: data.eventType,
        createdAt: claimedCreatedAt,
        payload: data.payload,
      };
      warEventRows.push(createdRow);
      return createdRow;
    });
    prismaMock.clanPostedMessage.create.mockResolvedValue({
      id: "posted-1",
    });

    const result = await (service as any).dispatchDetectedEvent({
      sub: makeWarEventSubscription(),
      payload: makeWarStartedEventPayload(),
      resolvedWarId: 1001,
    });

    expect(result).toMatchObject({
      state: "delivered_new",
      warId: "1001",
      guardCreatedAt: claimedCreatedAt,
    });
    expect(prismaMock.warEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(warEventRows).toEqual([
      expect.objectContaining({
        warId: 1001,
        clanTag: "#C0CU2Q82",
        eventType: "war_started",
        createdAt: claimedCreatedAt,
      }),
    ]);
  });

  it("releases the reservation when Discord send fails after the lease is claimed", async () => {
    const send = vi.fn().mockRejectedValue(new Error("discord send failed"));
    const service = makeWarEventDeliveryService(send);
    const claimedCreatedAt = new Date("2026-01-01T00:04:00.000Z");
    prismaMock.clanPostedMessage.findFirst.mockResolvedValue(null);
    prismaMock.warEvent.findFirst.mockResolvedValue(null);
    prismaMock.warEvent.create.mockResolvedValue({
      createdAt: claimedCreatedAt,
    });
    prismaMock.warEvent.deleteMany.mockResolvedValue({ count: 1 });

    const result = await (service as any).dispatchDetectedEvent({
      sub: makeWarEventSubscription(),
      payload: makeWarStartedEventPayload(),
      resolvedWarId: 1001,
    });

    expect(result).toEqual({
      state: "failed",
      warId: "1001",
      reason: "delivery_failed",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.warEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.warEvent.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          warId: 1001,
          clanTag: "#C0CU2Q82",
          eventType: "war_started",
          createdAt: claimedCreatedAt,
        }),
      }),
    );
    expect(prismaMock.clanPostedMessage.create).not.toHaveBeenCalled();
  });

  it("releases the reservation when posted-message persistence fails after a successful send", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "message-2",
      createdTimestamp: Date.parse("2026-01-01T00:05:00.000Z"),
    });
    const service = makeWarEventDeliveryService(send);
    const claimedCreatedAt = new Date("2026-01-01T00:06:00.000Z");
    prismaMock.clanPostedMessage.findFirst.mockResolvedValue(null);
    prismaMock.warEvent.findFirst.mockResolvedValue(null);
    prismaMock.warEvent.create.mockResolvedValue({
      createdAt: claimedCreatedAt,
    });
    prismaMock.warEvent.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.clanPostedMessage.create.mockRejectedValue(
      new Error("persist failed"),
    );

    const result = await (service as any).dispatchDetectedEvent({
      sub: makeWarEventSubscription(),
      payload: makeWarStartedEventPayload(),
      resolvedWarId: 1001,
    });

    expect(result).toEqual({
      state: "failed",
      warId: "1001",
      reason: "delivery_failed",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.warEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.warEvent.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          warId: 1001,
          clanTag: "#C0CU2Q82",
          eventType: "war_started",
          createdAt: claimedCreatedAt,
        }),
      }),
    );
  });

  it("fails closed when posted-message lookup errors before any delivery reservation is touched", async () => {
    const send = vi.fn();
    const service = makeWarEventDeliveryService(send);
    prismaMock.clanPostedMessage.findFirst.mockRejectedValueOnce(
      new Error("lookup failed"),
    );

    const result = await (service as any).dispatchDetectedEvent({
      sub: makeWarEventSubscription(),
      payload: makeWarStartedEventPayload(),
      resolvedWarId: 1001,
    });

    expect(result).toEqual({
      state: "unavailable",
      warId: "1001",
      reason: "existing_message_lookup_failed",
    });
    expect(prismaMock.warEvent.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.warEvent.create).not.toHaveBeenCalled();
    expect(prismaMock.warEvent.deleteMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(prismaMock.clanPostedMessage.create).not.toHaveBeenCalled();
    expect(prismaMock.clanPostedMessage.update).not.toHaveBeenCalled();
  });

  it("keeps the completed WarEvent and dedupes later deliveries from the saved posted message", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "message-1",
      createdTimestamp: Date.parse("2026-01-01T00:02:00.000Z"),
    });
    const service = makeWarEventDeliveryService(send);
    const createdAt = new Date("2026-01-01T00:03:00.000Z");
    const warEventRows: Array<{
      warId: number;
      clanTag: string;
      eventType: string;
      createdAt: Date;
      payload: Record<string, unknown>;
    }> = [];
    const postedMessages: Array<{
      guildId: string;
      clanTag: string;
      warId: string | null;
      type: string;
      event: string | null;
      channelId: string;
      messageId: string;
      messageUrl: string;
      syncNum: number | null;
      configHash: string | null;
    }> = [];
    prismaMock.clanPostedMessage.findFirst.mockImplementation(async ({ where }) => {
      return (
        postedMessages.find(
          (row) =>
            row.guildId === where.guildId &&
            row.clanTag === where.clanTag &&
            row.warId === where.warId &&
            row.type === where.type &&
            row.event === where.event,
        ) ?? null
      );
    });
    prismaMock.clanPostedMessage.create.mockImplementation(async ({ data }) => {
      const row = {
        guildId: data.guildId,
        clanTag: data.clanTag,
        warId: data.warId ?? null,
        type: data.type,
        event: data.event ?? null,
        channelId: data.channelId,
        messageId: data.messageId,
        messageUrl: data.messageUrl,
        syncNum: data.syncNum ?? null,
        configHash: data.configHash ?? null,
      };
      postedMessages.push(row);
      return row;
    });
    prismaMock.warEvent.findFirst.mockImplementation(async ({ where }) => {
      return (
        warEventRows.find(
          (row) =>
            row.warId === where.warId &&
            row.clanTag === where.clanTag &&
            row.eventType === where.eventType,
        ) ?? null
      );
    });
    prismaMock.warEvent.create.mockImplementation(async ({ data }) => {
      const row = {
        warId: data.warId,
        clanTag: data.clanTag,
        eventType: data.eventType,
        createdAt,
        payload: data.payload,
      };
      warEventRows.push(row);
      return row;
    });
    prismaMock.warEvent.deleteMany.mockImplementation(async ({ where }) => {
      const before = warEventRows.length;
      for (let i = warEventRows.length - 1; i >= 0; i -= 1) {
        const row = warEventRows[i];
        if (
          row.warId === where.warId &&
          row.clanTag === where.clanTag &&
          row.eventType === where.eventType &&
          row.createdAt.getTime() === where.createdAt.getTime()
        ) {
          warEventRows.splice(i, 1);
        }
      }
      return { count: before - warEventRows.length };
    });

    const firstResult = await (service as any).dispatchDetectedEvent({
      sub: makeWarEventSubscription(),
      payload: makeWarStartedEventPayload(),
      resolvedWarId: 1001,
    });
    const secondResult = await (service as any).dispatchDetectedEvent({
      sub: makeWarEventSubscription(),
      payload: makeWarStartedEventPayload(),
      resolvedWarId: 1001,
    });

    expect(firstResult).toMatchObject({
      state: "delivered_new",
      warId: "1001",
      guardCreatedAt: createdAt,
    });
    expect(secondResult).toEqual({
      state: "delivered_existing",
      warId: "1001",
      existingMessage: {
        channelId: notifyChannelId,
        messageId: "message-1",
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.warEvent.deleteMany).not.toHaveBeenCalled();
    expect(warEventRows).toHaveLength(1);
    expect(postedMessages).toHaveLength(1);
  });

  it("skips send when the posted message already exists", async () => {
    const send = vi.fn();
    const service = makeWarEventDeliveryService(send);
    prismaMock.clanPostedMessage.findFirst.mockResolvedValue({
      channelId: notifyChannelId,
      messageId: "message-existing",
    });

    const result = await (service as any).dispatchDetectedEvent({
      sub: makeWarEventSubscription(),
      payload: makeWarStartedEventPayload(),
      resolvedWarId: 1001,
    });

    expect(result).toEqual({
      state: "delivered_existing",
      warId: "1001",
      existingMessage: {
        channelId: notifyChannelId,
        messageId: "message-existing",
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(prismaMock.warEvent.create).not.toHaveBeenCalled();
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

  it("caches current-war snapshots in the cycle context and reuses successful nulls", async () => {
    const getCurrentWar = vi.fn().mockResolvedValue({
      state: "inWar",
      clan: {
        tag: "#ABC123",
        name: "Clan A",
        members: [],
      },
      opponent: {
        tag: "#OPP",
        name: "Opponent",
        members: [],
      },
      startTime: "20260311T120000.000Z",
      endTime: "20260311T140000.000Z",
    });
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as any,
      { getCurrentWar } as any,
    );
    const context = {
      currentWarSnapshotByClanTag: new Map<string, any>(),
    };

    const first = await (service as any).getCurrentWarSnapshot("#ABC123", context);
    const second = await (service as any).getCurrentWarSnapshot("#ABC123", context);

    expect(getCurrentWar).toHaveBeenCalledTimes(1);
    expect(first.war).toEqual(second.war);
    expect(first.observation).toEqual({ kind: "success" });
    expect(second.observation).toEqual({ kind: "success" });
    expect(context.currentWarSnapshotByClanTag.size).toBe(1);
    expect(context.currentWarSnapshotByClanTag.get("#ABC123")).toEqual(first.war);

    const nullContext = {
      currentWarSnapshotByClanTag: new Map<string, any>([["#NULLCLAN", null]]),
    };
    const nullSnapshot = await (service as any).getCurrentWarSnapshot(
      "#NULLCLAN",
      nullContext,
    );

    expect(getCurrentWar).toHaveBeenCalledTimes(1);
    expect(nullSnapshot.war).toBeNull();
    expect(nullSnapshot.observation).toEqual({ kind: "success" });
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
