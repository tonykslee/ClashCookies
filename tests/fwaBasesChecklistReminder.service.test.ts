import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  trackedMessage: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}));

const renderStateMock = vi.hoisted(() => ({
  build: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/FwaMatchChecklistStateService", () => ({
  buildFwaMatchChecklistRenderStateForGuild: renderStateMock.build,
}));

import { trackedMessageService } from "../src/services/TrackedMessageService";
import {
  BASES_CHECKLIST_REMINDER_OFFSETS_HOURS,
  findPendingFwaBasesChecklistReminderCandidates,
  resolveDueFwaBasesChecklistDueOffsets,
  resolveRemainingFwaBasesChecklistDueOffsets,
} from "../src/services/fwa/basesChecklistReminderService";

describe("fwa bases checklist reminder service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(trackedMessageService, "getActiveByMessageId").mockResolvedValue(null as any);
    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(null as any);
    vi.spyOn(trackedMessageService, "resolveLatestRelevantSyncPostForClanWar").mockResolvedValue(
      null as any,
    );
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(
      null as any,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestActiveFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue(null as any);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PYPY",
        name: "Alpha Clan",
        shortName: "Alpha",
        leaderChannelId: "leader-channel-1",
        notifyChannelId: "notify-channel-1",
        logChannelId: "log-channel-1",
        clanRoleId: "role-1",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        guildId: "guild-1",
        clanTag: "#PYPY",
        state: "preparation",
      },
    ]);
    prismaMock.trackedMessage.findUnique.mockResolvedValue(null);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    renderStateMock.build.mockResolvedValue({
      viewType: "Bases",
      rows: [],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves due and remaining reminder buckets", () => {
    const battleDayStart = new Date("2026-05-26T18:00:00.000Z");
    const now = new Date("2026-05-26T14:00:00.000Z");

    expect(
      resolveDueFwaBasesChecklistDueOffsets({
        now,
        battleDayStart,
        offsets: BASES_CHECKLIST_REMINDER_OFFSETS_HOURS,
      }),
    ).toEqual([12, 6]);
    expect(
      resolveRemainingFwaBasesChecklistDueOffsets({
        now,
        battleDayStart,
        offsets: BASES_CHECKLIST_REMINDER_OFFSETS_HOURS,
      }),
    ).toEqual([3, 1]);
  });

  it("returns only the latest due unsent bucket for an unchecked clan", async () => {
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u274c Bases not checked`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });

    const candidates = await findPendingFwaBasesChecklistReminderCandidates({
      now: new Date("2026-05-26T15:00:00.000Z"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      guildId: "guild-1",
      clanTag: "#PYPY",
      clanName: "Alpha Clan",
      clanShortName: "Alpha",
      destinationChannelId: "leader-channel-1",
      destinationChannelKind: "leader",
      clanRoleId: "role-1",
      dueBucketHours: 3,
      remainingBucketHours: [1],
      warId: 1001,
      opponentTag: "#OPP1",
    });
    expect(candidates[0]?.reminderMessageId).toBe(
      "fwa_match_checklist_bases_reminder|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-05-26T18:00:00.000Z|bucket=3",
    );
    expect(trackedMessageService.getActiveByMessageId).toHaveBeenCalledWith(
      candidates[0]?.reminderMessageId,
    );
  });

  it("queries CurrentWar with both bare and hash clan-tag variants", async () => {
    prismaMock.currentWar.findMany.mockImplementation(async (args: any) => {
      const queryTags = Array.isArray(args?.where?.clanTag?.in)
        ? args.where.clanTag.in.map((value: unknown) => String(value))
        : [];
      expect(queryTags).toContain("PYPY");
      expect(queryTags).toContain("#PYPY");
      return [
        {
          guildId: "guild-1",
          clanTag: "#PYPY",
          state: "preparation",
        },
      ];
    });
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u274c Bases not checked`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });

    const candidates = await findPendingFwaBasesChecklistReminderCandidates({
      now: new Date("2026-05-26T15:00:00.000Z"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      clanTag: "#PYPY",
      dueBucketHours: 3,
      warId: 1001,
    });
  });

  it("skips clans that already have active base issues or an all-good completion", async () => {
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u26a0\ufe0f Bases checked - issues found`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: ["  War bases:", "    - #12 Player One"],
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });
    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u2705 Bases checked and all good`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });
    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
  });

  it("suppresses a reminder when an active current-sync base-swap row exists even if the render is unchecked", async () => {
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValueOnce({
      id: "sync-track-1",
      guildId: "guild-1",
      channelId: "sync-channel-1",
      messageId: "sync-message-1",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
      expiresAt: null,
      metadata: {},
    } as any);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockResolvedValueOnce({
      id: "base-swap-1",
      guildId: "guild-1",
      channelId: "base-swap-channel-1",
      messageId: "base-swap-message-1",
      referenceId: "sync-message-1",
      clanTag: "#PYPY",
      createdAt: new Date("2026-05-26T12:15:00.000Z"),
      expiresAt: new Date("2026-05-27T12:15:00.000Z"),
      metadata: {
        clanName: "Alpha Clan",
        createdByUserId: "user-1",
        createdAtIso: "2026-05-26T12:15:00.000Z",
        syncMessageId: "sync-message-1",
        swapReminder: false,
        entries: [],
      },
    } as any);
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u274c Bases not checked`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });

    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
    expect(
      trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan,
    ).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#PYPY",
      syncMessageId: "sync-message-1",
    });
  });

  it("suppresses a reminder when an active sync-scoped bases completion exists even if the render is unchecked", async () => {
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValueOnce({
      id: "sync-track-2",
      guildId: "guild-1",
      channelId: "sync-channel-1",
      messageId: "sync-message-2",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
      expiresAt: null,
      metadata: {},
    } as any);
    vi.mocked(
      trackedMessageService.findLatestActiveFwaMatchChecklistBasesCompletionForClan,
    ).mockResolvedValueOnce({
      id: "completion-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId:
        "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-05-26T18:00:00.000Z|sync=sync-message-2",
      referenceId: "sync-message-2",
      clanTag: "#PYPY",
      createdAt: new Date("2026-05-26T12:15:00.000Z"),
      expiresAt: null,
      metadata: {
        kind: "bases_completion",
        createdByUserId: "user-1",
        createdAtIso: "2026-05-26T12:15:00.000Z",
        syncMessageId: "sync-message-2",
        syncReferenceId: null,
        clanTag: "#PYPY",
        clanName: "Alpha Clan",
        checked: true,
        warId: "1001",
        opponentTag: "OPP1",
        warStartTimeIso: "2026-05-26T18:00:00.000Z",
      },
    } as any);
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u274c Bases not checked`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });

    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
    expect(
      trackedMessageService.findLatestActiveFwaMatchChecklistBasesCompletionForClan,
    ).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#PYPY",
      warId: 1001,
      warStartTime: new Date("2026-05-26T18:00:00.000Z"),
      opponentTag: "#OPP1",
      syncMessageId: "sync-message-2",
      syncReferenceId: "sync-message-2",
    });
  });

  it("still creates a reminder when only a stale prior-sync base-swap row exists", async () => {
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValueOnce({
      id: "sync-track-1",
      guildId: "guild-1",
      channelId: "sync-channel-1",
      messageId: "sync-message-1",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
      expiresAt: null,
      metadata: {},
    } as any);
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockResolvedValueOnce(null);
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u274c Bases not checked`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });

    const candidates = await findPendingFwaBasesChecklistReminderCandidates({
      now: new Date("2026-05-26T15:00:00.000Z"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      guildId: "guild-1",
      clanTag: "#PYPY",
      dueBucketHours: 3,
    });
    expect(
      trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan,
    ).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#PYPY",
      syncMessageId: "sync-message-1",
    });
  });

  it("suppresses a reminder when no active sync post exists but a relevant expired sync post does", async () => {
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValueOnce(null);
    vi.mocked(trackedMessageService.resolveLatestRelevantSyncPostForClanWar).mockResolvedValueOnce(
      "sync-message-expired",
    );
    vi.mocked(trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan).mockImplementationOnce(
      async ({ syncMessageId }) => {
        if (syncMessageId !== "sync-message-expired") return null;
        return {
          id: "base-swap-2",
          guildId: "guild-1",
          channelId: "base-swap-channel-2",
          messageId: "base-swap-message-2",
          referenceId: null,
          clanTag: "#PYPY",
          createdAt: new Date("2026-05-26T12:15:00.000Z"),
          expiresAt: new Date("2026-05-27T12:15:00.000Z"),
          metadata: {
            clanName: "Alpha Clan",
            createdByUserId: "user-1",
            createdAtIso: "2026-05-26T12:15:00.000Z",
            syncMessageId: "sync-message-expired",
            swapReminder: false,
            entries: [],
          },
        } as any;
      },
    );
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u274c Bases not checked`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });

    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
    expect(
      trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan,
    ).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#PYPY",
      syncMessageId: "sync-message-expired",
    });
    expect(trackedMessageService.resolveLatestRelevantSyncPostForClanWar).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#PYPY",
        battleDayStart: new Date("2026-05-26T18:00:00.000Z"),
      }),
    );
  });

  it("does not backfill reminders after battle day starts", async () => {
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u274c Bases not checked`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });

    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T19:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
  });

  it("skips an already-claimed reminder marker for the same clan war bucket", async () => {
    renderStateMock.build.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: `Alpha | \u26ab | \u274c Bases not checked`,
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          detailLines: null,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      ],
      expiresAt: new Date("2026-05-26T18:00:00.000Z"),
    });
    vi.mocked(trackedMessageService.getActiveByMessageId).mockResolvedValueOnce({
      id: "marker-1",
    } as any);

    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
  });
});
