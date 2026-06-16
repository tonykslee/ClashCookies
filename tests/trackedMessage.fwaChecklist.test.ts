import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  currentWar: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import messageReactionAdd from "../src/listeners/messageReactionAdd";
import messageReactionRemove from "../src/listeners/messageReactionRemove";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  buildFwaMatchCompactCopyLine,
  buildFwaMatchChecklistContent,
  buildFwaMatchChecklistPublicationClaimKey,
  buildFwaMatchChecklistMessageContent,
  findLatestFwaMatchChecklistCheckedClanTags,
  normalizeFwaMatchChecklistKind,
  trackedMessageService,
} from "../src/services/TrackedMessageService";
import { repWorkActivityService } from "../src/services/RepWorkActivityService";
import {
  addFwaMatchChecklistReactionsForTest,
  buildFwaMatchChecklistRowsFromCopyView,
  buildFwaMatchChecklistTrackedMessageInput,
} from "../src/commands/Fwa";

function makeTrackedChecklistRow() {
  const rows = buildFwaMatchChecklistRowsFromCopyView({
    orderedTags: ["RR", "TWC"],
    copyText:
      "📬 | 🟢 | ☐ | RR vs `Bravo` (`#B1`)\n📭 | 🔴 | ☐ | TWC vs `Delta` (`#D2`)",
    badgeByTag: new Map([
      ["RR", "<:rr:111>"],
      ["TWC", "<:twc:222>"],
    ]),
  });
  return {
    id: "tracked-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "checklist-message-1",
    featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    referenceId: null,
    clanTag: null,
    expiresAt: null,
    metadata: {
      createdByUserId: "user-1",
      createdAtIso: "2026-05-13T00:00:00.000Z",
      scopeKey: "fwa_match_checklist|guild=guild-1|clan=all|rows=rr|twc",
      checkedClanTags: [],
      rows,
    },
  };
}

function makeTrackedChecklistRowWithState(checkedClanTags: string[]) {
  const row = makeTrackedChecklistRow();
  return {
    ...row,
    metadata: {
      ...row.metadata,
      checkedClanTags,
    },
  };
}

function makeBasesTrackedChecklistRow() {
  return {
    id: "tracked-bases-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "bases-message-1",
    featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    referenceId: "sync-message-1",
    clanTag: "#PYPY",
    expiresAt: new Date("2030-06-13T22:00:00.000Z"),
    createdAt: new Date("2026-06-13T17:00:00.000Z"),
    metadata: {
      kind: "bases_checklist",
      createdByUserId: "user-1",
      createdAtIso: "2026-06-13T17:00:00.000Z",
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
      checkedClanTags: [],
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
          badgeEmojiId: "111",
          badgeEmojiName: "alpha",
          badgeEmojiInline: "<:alpha:111>",
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-06-13T18:00:00.000Z",
          detailLines: null,
        },
      ],
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "bases-message-1",
      clanTag: "#PYPY",
      warId: 1001,
      opponentTag: "#OPP1",
      warStartTimeIso: "2026-06-13T18:00:00.000Z",
    },
  };
}

function makeUnscopedBaseSwapRow(params: {
  id: string;
  messageId: string;
  clanTag: string;
  createdAtIso: string;
}) {
  return {
    id: params.id,
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: params.messageId,
    featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    referenceId: null,
    clanTag: params.clanTag,
    createdAt: new Date(params.createdAtIso),
    expiresAt: new Date("2026-06-30T00:00:00.000Z"),
    metadata: {
      clanName: "Alpha",
      createdByUserId: "user-1",
      createdAtIso: params.createdAtIso,
      swapReminder: false,
      entries: [
        {
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          discordUserId: null,
          townhallLevel: 17,
          section: "war_bases",
          acknowledged: false,
        },
      ],
      layoutLinks: [],
    },
  } as any;
}

describe("fwa checklist tracked messages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.trackedMessage.findUnique.mockResolvedValue(null);
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.findFirst.mockResolvedValue(null);
    prismaMock.trackedMessage.upsert.mockResolvedValue(undefined);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);
    prismaMock.trackedMessage.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.trackedMessage.create.mockResolvedValue(undefined);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue({
      id: "sync-tracked-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-1",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-05-13T16:55:00.000Z"),
      expiresAt: null,
      metadata: {} as any,
    } as any);
    vi.spyOn(trackedMessageService, "resolveLatestRelevantSyncPostForClanWar").mockResolvedValue(
      null as any,
    );
  });

  it("renders the deliberate unknown opponent sentinel without tag parentheses", () => {
    expect(
      buildFwaMatchCompactCopyLine({
        mailStatusEmoji: "\u{1F4ED}",
        checklist: true,
        checklistChecked: false,
        clanShortName: "A",
        clanName: "Alpha",
        opponentName: "-",
        opponentTag: "-",
        matchType: "UNKNOWN",
        outcome: null,
      }),
    ).toBe("\u{1F4ED} | \u{1F518} | \u{2610} | A vs `-`");
  });

  it("renders a known opponent tag with a missing name as a hyphen", () => {
    expect(
      buildFwaMatchCompactCopyLine({
        mailStatusEmoji: "\u{1F4ED}",
        clanShortName: "A",
        clanName: "Alpha",
        opponentName: "",
        opponentTag: "#OPP1",
        matchType: "FWA",
        outcome: "WIN",
      }),
    ).toBe("\u{1F4ED} | \u{1F7E2} | A vs `-` (`#OPP1`)");
  });

  it("normalizes checklist kinds and keeps mail and bases claim keys separate", () => {
    expect(normalizeFwaMatchChecklistKind("mail")).toBe("mail_checklist");
    expect(normalizeFwaMatchChecklistKind("mail_checklist")).toBe("mail_checklist");
    expect(normalizeFwaMatchChecklistKind("bases")).toBe("bases_checklist");
    expect(normalizeFwaMatchChecklistKind("bases_checklist")).toBe("bases_checklist");

    const mailKey = buildFwaMatchChecklistPublicationClaimKey({
      guildId: "guild-1",
      syncMessageId: "sync-message-1",
      viewType: "Mail",
    });
    const basesKey = buildFwaMatchChecklistPublicationClaimKey({
      guildId: "guild-1",
      syncMessageId: "sync-message-1",
      viewType: "Bases",
    });

    expect(mailKey).toContain("kind=mail_checklist");
    expect(basesKey).toContain("kind=bases_checklist");
    expect(mailKey).not.toEqual(basesKey);
  });

  it("resolves the active sync post before falling back to the expired sync history", async () => {
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValueOnce({
      id: "active-sync-tracked",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "active-sync-message",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      expiresAt: null,
      metadata: {} as any,
    } as any);

    await expect(
      trackedMessageService.resolveFwaBaseSwapSyncIdentityForClanWar({
        guildId: "guild-1",
        clanTag: "#PYPY",
        battleDayStart: new Date("2026-06-10T00:00:00.000Z"),
        prepStartTime: new Date("2026-06-09T18:00:00.000Z"),
      }),
    ).resolves.toEqual({
      syncMessageId: "active-sync-message",
      source: "active_sync_post",
    });
  });

  it("falls back to the expired sync post when no active sync exists", async () => {
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValueOnce(null);
    vi.mocked(
      trackedMessageService.resolveLatestRelevantSyncPostForClanWar,
    ).mockResolvedValueOnce("expired-sync-message");

    await expect(
      trackedMessageService.resolveFwaBaseSwapSyncIdentityForClanWar({
        guildId: "guild-1",
        clanTag: "#PYPY",
        battleDayStart: new Date("2026-06-10T00:00:00.000Z"),
        prepStartTime: new Date("2026-06-09T18:00:00.000Z"),
      }),
    ).resolves.toEqual({
      syncMessageId: "expired-sync-message",
      source: "expired_sync_post_fallback",
    });
  });

  it("repairs eligible unscoped base-swap rows by backfilling the resolved sync identity", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValueOnce([
      makeUnscopedBaseSwapRow({
        id: "tracked-base-swap-1",
        messageId: "base-swap-message-1",
        clanTag: "#PYPY",
        createdAtIso: "2026-06-10T00:30:00.000Z",
      }),
    ]);
    prismaMock.currentWar.findMany.mockResolvedValueOnce([
      {
        clanTag: "#PYPY",
        state: "battle",
        prepStartTime: new Date("2026-06-09T18:00:00.000Z"),
        startTime: new Date("2026-06-10T00:00:00.000Z"),
        endTime: new Date("2026-06-10T01:00:00.000Z"),
        updatedAt: new Date("2026-06-10T00:05:00.000Z"),
      },
    ]);
    prismaMock.trackedMessage.findUnique.mockResolvedValueOnce({
      id: "sync-row-1",
      messageId: "expired-sync-message",
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
    });
    vi.mocked(trackedMessageService.resolveLatestActiveSyncPost).mockResolvedValueOnce(null);
    vi.mocked(
      trackedMessageService.resolveLatestRelevantSyncPostForClanWar,
    ).mockResolvedValueOnce("expired-sync-message");

    const summary = await trackedMessageService.repairUnscopedFwaBaseSwapSyncIdentity({
      guildId: "guild-1",
      apply: true,
      now: new Date("2026-06-10T02:00:00.000Z"),
    });

    expect(summary).toEqual(
      expect.objectContaining({
        guildId: "guild-1",
        scannedRows: 1,
        eligibleRows: 1,
        repairedRows: 1,
        skippedNoCurrentWar: 0,
        skippedNoSyncIdentity: 0,
        skippedInvalidMetadata: 0,
        skippedOutsideWindow: 0,
      }),
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tracked-base-swap-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            syncMessageId: "expired-sync-message",
          }),
        }),
      }),
    );
  });

  it("checklist post gets clan badge reactions", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    await addFwaMatchChecklistReactionsForTest(
      { id: "message-1", react },
      makeTrackedChecklistRow().metadata.rows,
    );

    expect(react).toHaveBeenCalledWith("<:rr:111>");
    expect(react).toHaveBeenCalledWith("<:twc:222>");
  });

  it("builds checklist tracked message input with a non-null expiresAt", () => {
    const input = buildFwaMatchChecklistTrackedMessageInput({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      clanTag: null,
      createdByUserId: "user-1",
      rows: makeTrackedChecklistRow().metadata.rows,
      createdAtIso: "2026-05-13T00:00:00.000Z",
    });

    expect(input.expiresAt).toBeInstanceOf(Date);
    expect(input.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(input.metadata.rows).toHaveLength(2);
  });

  it("marks an expired checklist as expired and does not mutate the content", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      ...makeTrackedChecklistRow(),
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map(),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any),
    ).resolves.toBe(false);

    expect(edit).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          status: TRACKED_MESSAGE_STATUS.EXPIRED,
        }),
      }),
    );
  });

  it("extends checklist expiry when refresh computes a later prep-day expiry", async () => {
    const currentExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const refreshedExpiresAt = new Date(Date.now() + 18 * 60 * 60 * 1000);
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      ...makeTrackedChecklistRow(),
      expiresAt: currentExpiresAt,
    });

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map(),
      },
      edit,
    };
    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, null, {
        expiresAt: refreshedExpiresAt,
      }),
    ).resolves.toBe(true);

    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          expiresAt: refreshedExpiresAt,
          metadata: expect.objectContaining({
            rows: expect.any(Array),
          }),
        }),
      }),
    );
  });

  it("extends checklist expiry from a sync-based fallback to the known war end", async () => {
    const currentExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const refreshedExpiresAt = new Date(Date.now() + 49 * 60 * 60 * 1000);
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      ...makeTrackedChecklistRow(),
      expiresAt: currentExpiresAt,
    });

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map(),
      },
      edit,
    };
    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, null, {
        expiresAt: refreshedExpiresAt,
      }),
    ).resolves.toBe(true);

    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          expiresAt: refreshedExpiresAt,
        }),
      }),
    );
  });

  it("keeps the current expiry when stale current-war timing would otherwise suggest an older expiry", async () => {
    const currentExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const staleRefreshedExpiresAt = new Date(Date.now() - 60 * 60 * 1000);
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      ...makeBasesTrackedChecklistRow(),
      expiresAt: currentExpiresAt,
    });
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1001,
        prepStartTime: new Date("2026-05-10T14:00:00.000Z"),
        startTime: new Date("2026-05-10T18:00:00.000Z"),
        endTime: new Date("2026-05-11T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: null,
        outcome: null,
        state: "battle",
      },
    ]);

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "bases-message-1",
      reactions: {
        cache: new Map(),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, null, {
        expiresAt: staleRefreshedExpiresAt,
      }),
    ).resolves.toBe(true);

    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "bases-message-1" },
        data: expect.objectContaining({
          expiresAt: currentExpiresAt,
        }),
      }),
    );
    expect(prismaMock.trackedMessage.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "bases-message-1" },
        data: expect.objectContaining({
          expiresAt: staleRefreshedExpiresAt,
        }),
      }),
    );
    expect(edit).toHaveBeenCalled();
  });

  it("stores and resolves bases completion for the current war identity", async () => {
    const currentWarStartTime = new Date("2026-05-13T18:00:00.000Z");
    await trackedMessageService.setFwaMatchChecklistBasesCompletion({
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      clanTag: "#PYPY",
      clanName: "Alpha",
      warId: 1001,
      warStartTime: currentWarStartTime,
      opponentTag: "#OPP1",
      checked: true,
    });

    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          messageId:
            "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-05-13T18:00:00.000Z",
        }),
        update: expect.objectContaining({
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        }),
        create: expect.objectContaining({
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        }),
      }),
    );

    prismaMock.trackedMessage.findUnique.mockResolvedValueOnce({
      id: "tracked-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId:
        "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-05-13T18:00:00.000Z",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: null,
      clanTag: "#PYPY",
      expiresAt: null,
      createdAt: new Date("2026-05-13T18:00:01.000Z"),
      metadata: {
        kind: "bases_completion",
        createdByUserId: "user-1",
        createdAtIso: "2026-05-13T18:00:00.000Z",
        clanTag: "#PYPY",
        clanName: "Alpha",
        checked: true,
        warId: "1001",
        opponentTag: "OPP1",
        warStartTimeIso: "2026-05-13T18:00:00.000Z",
      },
    });

    await expect(
      trackedMessageService.findLatestFwaMatchChecklistBasesCompletionForClan({
        guildId: "guild-1",
        clanTag: "#PYPY",
        warId: 1001,
        warStartTime: currentWarStartTime,
        opponentTag: "OPP1",
      }),
    ).resolves.toMatchObject({
      messageId:
        "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-05-13T18:00:00.000Z",
      metadata: expect.objectContaining({
        kind: "bases_completion",
        checked: true,
        clanTag: "#PYPY",
      }),
    });
  });

  it("clears bases completion for the current war identity", async () => {
    await trackedMessageService.setFwaMatchChecklistBasesCompletion({
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      clanTag: "#PYPY",
      clanName: "Alpha",
      warId: 1001,
      warStartTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "OPP1",
      checked: false,
    });

    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: TRACKED_MESSAGE_STATUS.REPLACED,
        }),
        create: expect.objectContaining({
          status: TRACKED_MESSAGE_STATUS.REPLACED,
        }),
      }),
    );
  });

  it("clears sync-scoped bases completion when a known-war unchecked action is saved", async () => {
    await trackedMessageService.setFwaMatchChecklistBasesCompletion({
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      clanTag: "#PYPY",
      clanName: "Alpha",
      warId: 1001,
      warStartTime: new Date("2026-05-13T18:00:00.000Z"),
      opponentTag: "OPP1",
      checked: false,
      syncMessageId: "sync-message-1",
    });

    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        messageId:
          "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=none|opponent=none|start=none|sync=sync-message-1",
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
      },
      data: { status: TRACKED_MESSAGE_STATUS.REPLACED },
    });

    prismaMock.trackedMessage.findUnique.mockResolvedValueOnce(null);
    prismaMock.trackedMessage.findMany.mockResolvedValueOnce([]);

    await expect(
      trackedMessageService.findLatestActiveFwaMatchChecklistBasesCompletionForClan({
        guildId: "guild-1",
        clanTag: "#PYPY",
        warId: 1001,
        warStartTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "OPP1",
        syncMessageId: "sync-message-1",
      }),
    ).resolves.toBeNull();
  });

  it("persists bases completion with sync identity when war identity is not known yet", async () => {
    await trackedMessageService.setFwaMatchChecklistBasesCompletion({
      guildId: "guild-1",
      channelId: "channel-1",
      createdByUserId: "user-1",
      clanTag: "#PYPY",
      clanName: "Alpha",
      checked: true,
      syncMessageId: "sync-message-1",
    });

    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          messageId:
            "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=none|opponent=none|start=none|sync=sync-message-1",
        },
        update: expect.objectContaining({
          referenceId: "sync-message-1",
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        }),
        create: expect.objectContaining({
          referenceId: "sync-message-1",
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        }),
      }),
    );
  });

  it("falls back to sync-scoped bases completion after war identity becomes known", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValueOnce(null);
    prismaMock.trackedMessage.findMany.mockResolvedValueOnce([
      {
        id: "tracked-sync-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId:
          "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=none|opponent=none|start=none|sync=sync-message-1",
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: "sync-message-1",
        clanTag: "#PYPY",
        expiresAt: null,
        createdAt: new Date("2026-05-13T17:00:00.000Z"),
        metadata: {
          kind: "bases_completion",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T17:00:00.000Z",
          clanTag: "#PYPY",
          clanName: "Alpha",
          checked: true,
          warId: null,
          opponentTag: null,
          warStartTimeIso: null,
          syncMessageId: "sync-message-1",
          syncReferenceId: null,
        },
      },
    ] as any);

    await expect(
      trackedMessageService.findLatestActiveFwaMatchChecklistBasesCompletionForClan({
        guildId: "guild-1",
        clanTag: "#PYPY",
        warId: 1001,
        warStartTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "OPP1",
        syncMessageId: "sync-message-1",
      }),
    ).resolves.toMatchObject({
      referenceId: "sync-message-1",
      metadata: expect.objectContaining({
        checked: true,
        syncMessageId: "sync-message-1",
      }),
    });
  });

  it("falls back to sync-scoped mail checked tags when the refreshed scope has no state", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValueOnce([
      {
        referenceId: "sync-message-1",
        metadata: {
          kind: "mail_checklist",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T17:00:00.000Z",
          scopeKey: "old-prematch-scope",
          checkedClanTags: ["#PYPY"],
          rows: [
            {
              clanTag: "#PYPY",
              compactCopyLine: "📭 | ❔ | Alpha vs `Unknown`",
              badgeEmojiInline: "<:rr:111>",
            },
          ],
        },
      },
    ] as any);

    await expect(
      findLatestFwaMatchChecklistCheckedClanTags({
        guildId: "guild-1",
        clanTag: null,
        scopeKey: "new-matched-scope",
        syncMessageId: "sync-message-1",
      }),
    ).resolves.toEqual(["#PYPY"]);
  });

  it("does not resurrect sync-scoped mail checked tags when an exact empty scope exists", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValueOnce([
      {
        referenceId: "sync-message-1",
        metadata: {
          kind: "mail_checklist",
          createdByUserId: "user-2",
          createdAtIso: "2026-05-13T18:00:00.000Z",
          scopeKey: "new-matched-scope",
          checkedClanTags: [],
          rows: [
            {
              clanTag: "#PYPY",
              compactCopyLine: "📭 | 🟢 | Alpha vs `Bravo` (`#B1`)",
              badgeEmojiInline: "<:rr:111>",
            },
          ],
        },
      },
      {
        referenceId: "sync-message-1",
        metadata: {
          kind: "mail_checklist",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T17:00:00.000Z",
          scopeKey: "old-prematch-scope",
          checkedClanTags: ["#PYPY"],
          rows: [
            {
              clanTag: "#PYPY",
              compactCopyLine: "📭 | ❔ | Alpha vs `Unknown`",
              badgeEmojiInline: "<:rr:111>",
            },
          ],
        },
      },
    ] as any);

    await expect(
      findLatestFwaMatchChecklistCheckedClanTags({
        guildId: "guild-1",
        clanTag: null,
        scopeKey: "new-matched-scope",
        syncMessageId: "sync-message-1",
      }),
    ).resolves.toEqual([]);
  });

  it("ignores bases completion rows for a different war identity", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValueOnce(null);

    await expect(
      trackedMessageService.findLatestFwaMatchChecklistBasesCompletionForClan({
        guildId: "guild-1",
        clanTag: "#PYPY",
        warId: 2002,
        warStartTime: new Date("2026-05-14T18:00:00.000Z"),
        opponentTag: "#OPP2",
      }),
    ).resolves.toBeNull();
  });

  it("does not treat a legacy active completion as current when the war identity does not match", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValueOnce(null);
    prismaMock.trackedMessage.findMany.mockResolvedValueOnce([
      {
        id: "tracked-legacy-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId:
          "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-05-13T18:00:00.000Z",
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: null,
        clanTag: "#PYPY",
        expiresAt: null,
        createdAt: new Date("2026-05-13T18:00:01.000Z"),
        metadata: {
          kind: "bases_completion",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T18:00:00.000Z",
          clanTag: "#PYPY",
          clanName: "Alpha",
          checked: true,
          warId: "1001",
          opponentTag: "OPP1",
          warStartTimeIso: "2026-05-13T18:00:00.000Z",
          syncMessageId: null,
          syncReferenceId: null,
        },
      },
    ] as any);

    await expect(
      trackedMessageService.findLatestActiveFwaMatchChecklistBasesCompletionForClan({
        guildId: "guild-1",
        clanTag: "#PYPY",
        warId: 1001,
        warStartTime: new Date("2026-05-14T18:00:00.000Z"),
        opponentTag: "OPP2",
      }),
    ).resolves.toBeNull();
  });

  it("replaces older public bases checklist rows and unpins pinned messages", async () => {
    const oldUnpin = vi.fn().mockResolvedValue(undefined);
    const resolveMessageForCleanup = vi.fn().mockResolvedValue({
      pinned: true,
      unpin: oldUnpin,
    });
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-old-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "old-bases-message-1",
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: null,
        clanTag: "#PYPY",
        expiresAt: new Date("2026-06-13T22:00:00.000Z"),
        createdAt: new Date("2026-06-13T17:00:00.000Z"),
        metadata: {
          kind: "bases_checklist",
          createdByUserId: "user-1",
          createdAtIso: "2026-06-13T17:00:00.000Z",
          scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
          checkedClanTags: [],
          rows: [
            {
              clanTag: "#PYPY",
              compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
              badgeEmojiId: "111",
              badgeEmojiName: "alpha",
              badgeEmojiInline: "<:alpha:111>",
              warId: "1001",
              opponentTag: "#OPP1",
              warStartTimeIso: "2026-06-13T18:00:00.000Z",
              detailLines: null,
            },
          ],
        },
      },
    ] as any);

    await expect(
      trackedMessageService.replaceOlderFwaMatchChecklistMessages({
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "new-bases-message-1",
        resolveMessageForCleanup,
      }),
    ).resolves.toBe(1);

    expect(resolveMessageForCleanup).toHaveBeenCalledWith({
      channelId: "channel-1",
      messageId: "old-bases-message-1",
    });
    expect(oldUnpin).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "old-bases-message-1" },
        data: expect.objectContaining({
          status: TRACKED_MESSAGE_STATUS.REPLACED,
        }),
      }),
    );
  });

  it("continues replacing older public bases checklist rows when an old message is missing", async () => {
    const resolveMessageForCleanup = vi.fn().mockResolvedValue(null);
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-old-2",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "missing-bases-message-1",
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: null,
        clanTag: "#PYPY",
        expiresAt: new Date("2026-06-13T22:00:00.000Z"),
        createdAt: new Date("2026-06-13T17:00:00.000Z"),
        metadata: {
          kind: "bases_checklist",
          createdByUserId: "user-1",
          createdAtIso: "2026-06-13T17:00:00.000Z",
          scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
          checkedClanTags: [],
          rows: [
            {
              clanTag: "#PYPY",
              compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
              badgeEmojiId: "111",
              badgeEmojiName: "alpha",
              badgeEmojiInline: "<:alpha:111>",
              warId: "1001",
              opponentTag: "#OPP1",
              warStartTimeIso: "2026-06-13T18:00:00.000Z",
              detailLines: null,
            },
          ],
        },
      },
    ] as any);

    await expect(
      trackedMessageService.replaceOlderFwaMatchChecklistMessages({
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "new-bases-message-1",
        resolveMessageForCleanup,
      }),
    ).resolves.toBe(1);

    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "missing-bases-message-1" },
        data: expect.objectContaining({
          status: TRACKED_MESSAGE_STATUS.REPLACED,
        }),
      }),
    );
  });

  it("does not replace older mail checklist rows when cleaning up bases checklists", async () => {
    const resolveMessageForCleanup = vi.fn().mockResolvedValue({
      pinned: true,
      unpin: vi.fn().mockResolvedValue(undefined),
    });
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-mail-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "old-mail-message-1",
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: null,
        clanTag: "#PYPY",
        expiresAt: new Date("2026-06-13T22:00:00.000Z"),
        createdAt: new Date("2026-06-13T17:00:00.000Z"),
        metadata: {
          createdByUserId: "user-1",
          createdAtIso: "2026-06-13T17:00:00.000Z",
          scopeKey: "fwa_match_mail|guild=guild-1|clan=all|rows=alpha",
          checkedClanTags: [],
          rows: [
            {
              clanTag: "#PYPY",
              compactCopyLine: "📬 | 🟢 | ✅ | Alpha vs `Opp` (`#OPP1`)",
              badgeEmojiId: "111",
              badgeEmojiName: "alpha",
              badgeEmojiInline: "<:alpha:111>",
              contextKey: null,
            },
          ],
        },
      },
      {
        id: "tracked-bases-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "old-bases-message-1",
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: null,
        clanTag: "#PYPY",
        expiresAt: new Date("2026-06-13T22:00:00.000Z"),
        createdAt: new Date("2026-06-13T17:00:00.000Z"),
        metadata: {
          kind: "bases_checklist",
          createdByUserId: "user-1",
          createdAtIso: "2026-06-13T17:00:00.000Z",
          scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
          checkedClanTags: [],
          rows: [
            {
              clanTag: "#PYPY",
              compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
              badgeEmojiId: "111",
              badgeEmojiName: "alpha",
              badgeEmojiInline: "<:alpha:111>",
              warId: "1001",
              opponentTag: "#OPP1",
              warStartTimeIso: "2026-06-13T18:00:00.000Z",
              detailLines: null,
            },
          ],
        },
      },
    ] as any);

    await expect(
      trackedMessageService.replaceOlderFwaMatchChecklistMessages({
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "new-bases-message-1",
        resolveMessageForCleanup,
      }),
    ).resolves.toBe(1);

    expect(prismaMock.trackedMessage.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "old-bases-message-1" },
        data: expect.objectContaining({
          status: TRACKED_MESSAGE_STATUS.REPLACED,
        }),
      }),
    );
  });

  it("ignores expired base-swap rows when resolving the latest active tracked message", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);

    const found = await trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan({
      guildId: "guild-1",
      clanTag: "#PYPY",
    });

    expect(found).toBeNull();
    expect(prismaMock.trackedMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          expiresAt: expect.objectContaining({
            gt: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it("resolves current-sync base-swap rows using explicit sync metadata", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "swap-unscoped",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "swap-message-unscoped",
        referenceId: null,
        clanTag: "#PYPY",
        createdAt: new Date("2026-05-13T16:30:00.000Z"),
        expiresAt: new Date("2026-05-13T18:30:00.000Z"),
        metadata: {
          clanKind: "FWA",
          clanName: "Alpha",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T16:30:00.000Z",
          clanRoleId: null,
          swapReminder: true,
          entries: [],
        },
      } as any,
      {
        id: "swap-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "swap-message-1",
        referenceId: "fwa-base-swap:split-1",
        clanTag: "#PYPY",
        createdAt: new Date("2026-05-13T17:00:00.000Z"),
        expiresAt: new Date("2026-05-13T19:00:00.000Z"),
        metadata: {
          clanKind: "FWA",
          clanName: "Alpha",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T17:00:00.000Z",
          syncMessageId: "sync-message-1",
          clanRoleId: null,
          swapReminder: false,
          renderVariant: "single",
          phaseTimingLine: null,
          alertEmoji: null,
          fwaAlertEmoji: null,
          layoutBulletEmoji: null,
          entries: [
            {
              position: 12,
              playerTag: "#P1",
              playerName: "PlayerOne",
              discordUserId: "discord-1",
              townhallLevel: 15,
              section: "base_errors",
              acknowledged: false,
            },
          ],
          layoutLinks: [],
        },
      } as any,
    ]);

    const found = await trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan({
      guildId: "guild-1",
      clanTag: "#PYPY",
      syncMessageId: "sync-message-1",
    });

    expect(found).toMatchObject({
      messageId: "swap-message-1",
      referenceId: "fwa-base-swap:split-1",
      metadata: expect.objectContaining({
        syncMessageId: "sync-message-1",
      }),
    });
  });

  it("resolves completed current-sync base-swap rows using explicit sync metadata", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "swap-completed-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "swap-message-completed-1",
        referenceId: "fwa-base-swap:split-1",
        clanTag: "#PYPY",
        createdAt: new Date("2026-05-13T17:10:00.000Z"),
        expiresAt: new Date("2026-05-13T19:10:00.000Z"),
        status: TRACKED_MESSAGE_STATUS.COMPLETED,
        metadata: {
          clanKind: "FWA",
          clanName: "Alpha",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T17:10:00.000Z",
          syncMessageId: "sync-message-1",
          clanRoleId: null,
          swapReminder: false,
          renderVariant: "single",
          phaseTimingLine: null,
          alertEmoji: null,
          fwaAlertEmoji: null,
          layoutBulletEmoji: null,
          entries: [
            {
              position: 12,
              playerTag: "#P1",
              playerName: "PlayerOne",
              discordUserId: "discord-1",
              townhallLevel: 15,
              section: "base_errors",
              acknowledged: true,
            },
          ],
          layoutLinks: [],
        },
      } as any,
    ]);

    const found = await trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan({
      guildId: "guild-1",
      clanTag: "#PYPY",
      syncMessageId: "sync-message-1",
    });

    expect(found).toMatchObject({
      messageId: "swap-message-completed-1",
      status: TRACKED_MESSAGE_STATUS.COMPLETED,
      metadata: expect.objectContaining({
        syncMessageId: "sync-message-1",
      }),
    });
  });

  it("does not fall back to an unscoped active base-swap row when a sync identity is supplied", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "swap-sync-other",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "swap-message-sync-other",
        referenceId: "fwa-base-swap:split-2",
        clanTag: "#PYPY",
        createdAt: new Date("2026-05-13T18:00:00.000Z"),
        expiresAt: new Date("2026-05-13T20:00:00.000Z"),
        metadata: {
          clanKind: "FWA",
          clanName: "Alpha",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T18:00:00.000Z",
          syncMessageId: "sync-message-2",
          clanRoleId: null,
          swapReminder: false,
          renderVariant: "single",
          phaseTimingLine: null,
          alertEmoji: null,
          fwaAlertEmoji: null,
          layoutBulletEmoji: null,
          entries: [],
          layoutLinks: [],
        },
      } as any,
      {
        id: "swap-unscoped",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "swap-message-unscoped",
        referenceId: null,
        clanTag: "#PYPY",
        createdAt: new Date("2026-05-13T17:30:00.000Z"),
        expiresAt: new Date("2026-05-13T19:30:00.000Z"),
        metadata: {
          clanKind: "FWA",
          clanName: "Alpha",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T17:30:00.000Z",
          clanRoleId: null,
          swapReminder: true,
          entries: [
            {
              position: 1,
              playerTag: "#AAA",
              playerName: "Alpha",
              discordUserId: null,
              townhallLevel: 15,
              section: "fwa_bases",
              acknowledged: false,
            },
          ],
        },
      } as any,
    ]);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const found = await trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan({
      guildId: "guild-1",
      clanTag: "#PYPY",
      syncMessageId: "sync-message-1",
    });

    expect(found).toBeNull();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("selection=rejected_stale_unscoped"),
    );
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("selection=no_match"));
  });

  it("resolves the latest relevant expired sync post for a clan war in the real 24h prep-window case", async () => {
    vi.mocked(trackedMessageService.resolveLatestRelevantSyncPostForClanWar).mockRestore();
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "sync-old-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "sync-message-old",
        referenceId: null,
        createdAt: new Date("2026-05-12T12:00:00.000Z"),
        expiresAt: new Date("2026-05-12T13:00:00.000Z"),
        metadata: {
          syncTimeIso: "2026-05-12T12:00:00.000Z",
          syncEpochSeconds: 1778587200,
          roleId: "role-1",
          clans: [
            {
              code: "RR",
              clanTag: "#PYPY",
              clanName: "Alpha",
              emojiId: "111",
              emojiName: "rr",
              emojiInline: "<:rr:111>",
            },
          ],
        },
      } as any,
      {
        id: "sync-relevant-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "sync-message-relevant",
        referenceId: null,
        createdAt: new Date("2026-06-05T11:20:00.000Z"),
        expiresAt: new Date("2026-06-05T12:20:00.000Z"),
        metadata: {
          syncTimeIso: "2026-06-05T11:20:00.000Z",
          syncEpochSeconds: Math.floor(new Date("2026-06-05T11:20:00.000Z").getTime() / 1000),
          roleId: "role-1",
          clans: [
            {
              code: "RR",
              clanTag: "#PYPY",
              clanName: "Alpha",
              emojiId: "111",
              emojiName: "rr",
              emojiInline: "<:rr:111>",
            },
          ],
        },
      } as any,
      {
        id: "sync-irrelevant-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "sync-message-irrelevant",
        referenceId: null,
        createdAt: new Date("2026-06-05T10:30:00.000Z"),
        expiresAt: new Date("2026-06-05T11:30:00.000Z"),
        metadata: {
          syncTimeIso: "2026-06-05T10:30:00.000Z",
          syncEpochSeconds: Math.floor(new Date("2026-06-05T10:30:00.000Z").getTime() / 1000),
          roleId: "role-1",
          clans: [
            {
              code: "TWC",
              clanTag: "#ZZZZ",
              clanName: "Other",
              emojiId: "222",
              emojiName: "twc",
              emojiInline: "<:twc:222>",
            },
          ],
        },
      } as any,
    ]);

    await expect(
      trackedMessageService.resolveLatestRelevantSyncPostForClanWar({
        guildId: "guild-1",
        clanTag: "#PYPY",
        battleDayStart: new Date("2026-06-06T11:20:00.000Z"),
        prepStartTime: new Date("2026-06-05T11:20:00.000Z"),
        now: new Date("2026-06-06T12:00:00.000Z"),
      }),
    ).resolves.toBe("sync-message-relevant");
  });

  it("rejects stale prior-sync rows that are too old for the current battle day", async () => {
    vi.mocked(trackedMessageService.resolveLatestRelevantSyncPostForClanWar).mockRestore();
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "sync-stale-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "sync-message-stale",
        referenceId: null,
        createdAt: new Date("2026-06-03T11:20:00.000Z"),
        expiresAt: new Date("2026-06-03T12:20:00.000Z"),
        metadata: {
          syncTimeIso: "2026-06-03T11:20:00.000Z",
          syncEpochSeconds: Math.floor(new Date("2026-06-03T11:20:00.000Z").getTime() / 1000),
          roleId: "role-1",
          clans: [
            {
              code: "RR",
              clanTag: "#PYPY",
              clanName: "Alpha",
              emojiId: "111",
              emojiName: "rr",
              emojiInline: "<:rr:111>",
            },
          ],
        },
      } as any,
    ]);

    await expect(
      trackedMessageService.resolveLatestRelevantSyncPostForClanWar({
        guildId: "guild-1",
        clanTag: "#PYPY",
        battleDayStart: new Date("2026-06-06T11:20:00.000Z"),
        prepStartTime: new Date("2026-06-05T11:20:00.000Z"),
        now: new Date("2026-06-06T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("rejects sync posts that do not include the clan in metadata", async () => {
    vi.mocked(trackedMessageService.resolveLatestRelevantSyncPostForClanWar).mockRestore();
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "sync-mismatch-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "sync-message-mismatch",
        referenceId: null,
        createdAt: new Date("2026-06-05T11:20:00.000Z"),
        expiresAt: new Date("2026-06-05T12:20:00.000Z"),
        metadata: {
          syncTimeIso: "2026-06-05T11:20:00.000Z",
          syncEpochSeconds: Math.floor(new Date("2026-06-05T11:20:00.000Z").getTime() / 1000),
          roleId: "role-1",
          clans: [
            {
              code: "RR",
              clanTag: "#AAAA",
              clanName: "Other",
              emojiId: "111",
              emojiName: "rr",
              emojiInline: "<:rr:111>",
            },
          ],
        },
      } as any,
    ]);

    await expect(
      trackedMessageService.resolveLatestRelevantSyncPostForClanWar({
        guildId: "guild-1",
        clanTag: "#PYPY",
        battleDayStart: new Date("2026-06-06T11:20:00.000Z"),
        prepStartTime: new Date("2026-06-05T11:20:00.000Z"),
        now: new Date("2026-06-06T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("repairs stale legacy bases checklist markers without touching current-sync base-swap rows", async () => {
    vi.spyOn(trackedMessageService, "resolveLatestSyncPost").mockResolvedValue({
      id: "sync-tracked-2",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-2",
      referenceId: null,
      clanTag: null,
      createdAt: new Date("2026-06-13T18:00:00.000Z"),
      expiresAt: null,
      metadata: {} as any,
    } as any);

    prismaMock.trackedMessage.findMany.mockImplementation(async ({ where }: any) => {
      if (
        where?.featureType === TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST &&
        where?.status === TRACKED_MESSAGE_STATUS.ACTIVE
      ) {
        return [
          {
            id: "legacy-bases-1",
            messageId:
              "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-06-13T18:00:00.000Z",
            referenceId: null,
            createdAt: new Date("2026-06-13T17:59:00.000Z"),
            metadata: {
              kind: "bases_completion",
              createdByUserId: "user-1",
              createdAtIso: "2026-06-13T17:59:00.000Z",
              clanTag: "#PYPY",
              clanName: "Alpha",
              checked: true,
              warId: "1001",
              opponentTag: "#OPP1",
              warStartTimeIso: "2026-06-13T18:00:00.000Z",
            },
          },
        ];
      }
      if (
        where?.featureType === TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP &&
        where?.status === TRACKED_MESSAGE_STATUS.ACTIVE
      ) {
        return [
          {
            id: "base-swap-old-1",
            createdAt: new Date("2026-06-13T17:30:00.000Z"),
            expiresAt: new Date("2026-06-13T19:00:00.000Z"),
            metadata: {
              clanKind: "FWA",
              clanName: "Alpha",
              createdByUserId: "user-1",
              createdAtIso: "2026-06-13T17:30:00.000Z",
              clanRoleId: null,
              swapReminder: true,
              entries: [
                {
                  position: 1,
                  playerTag: "#AAA",
                  playerName: "Alpha",
                  discordUserId: null,
                  townhallLevel: 15,
                  section: "fwa_bases",
                  acknowledged: false,
                },
              ],
            },
          },
          {
            id: "base-swap-expired-1",
            createdAt: new Date("2026-06-13T18:30:00.000Z"),
            expiresAt: new Date("2026-06-13T17:45:00.000Z"),
            metadata: {
              clanKind: "FWA",
              clanName: "Alpha",
              createdByUserId: "user-1",
              createdAtIso: "2026-06-13T18:30:00.000Z",
              clanRoleId: null,
              swapReminder: true,
              entries: [
                {
                  position: 1,
                  playerTag: "#BBB",
                  playerName: "Bravo",
                  discordUserId: null,
                  townhallLevel: 15,
                  section: "fwa_bases",
                  acknowledged: false,
                },
              ],
            },
          },
          {
            id: "base-swap-current-1",
            createdAt: new Date("2026-06-13T18:15:00.000Z"),
            expiresAt: new Date("2026-06-13T20:00:00.000Z"),
            metadata: {
              clanKind: "FWA",
              clanName: "Alpha",
              createdByUserId: "user-1",
              createdAtIso: "2026-06-13T18:15:00.000Z",
              syncMessageId: "sync-message-2",
              clanRoleId: null,
              swapReminder: true,
              entries: [
                {
                  position: 1,
                  playerTag: "#CCC",
                  playerName: "Charlie",
                  discordUserId: null,
                  townhallLevel: 15,
                  section: "fwa_bases",
                  acknowledged: false,
                },
              ],
            },
          },
          {
            id: "base-swap-future-1",
            createdAt: new Date("2026-06-13T19:30:00.000Z"),
            expiresAt: new Date("2026-06-13T20:00:00.000Z"),
            metadata: {
              clanKind: "FWA",
              clanName: "Alpha",
              createdByUserId: "user-1",
              createdAtIso: "2026-06-13T19:30:00.000Z",
              clanRoleId: null,
              swapReminder: true,
              entries: [
                {
                  position: 1,
                  playerTag: "#DDD",
                  playerName: "Delta",
                  discordUserId: null,
                  townhallLevel: 15,
                  section: "fwa_bases",
                  acknowledged: false,
                },
              ],
            },
          },
        ];
      }
      return [];
    });

    const summary = await trackedMessageService.repairStaleFwaBasesChecklistState({
      guildId: "guild-1",
      apply: true,
      now: new Date("2026-06-13T18:45:00.000Z"),
    });

    expect(summary).toMatchObject({
      guildId: "guild-1",
      currentSyncMessageId: "sync-message-2",
      dryRun: false,
      basesCompletionCandidates: 1,
      basesCompletionReplaced: 1,
      baseSwapCandidates: 2,
      baseSwapExpiredCandidates: 1,
      baseSwapOlderThanCurrentSyncCandidates: 1,
      baseSwapReplaced: 2,
    });
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["legacy-bases-1"] },
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        }),
        data: expect.objectContaining({
          status: TRACKED_MESSAGE_STATUS.REPLACED,
        }),
      }),
    );
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          id: {
            in: expect.arrayContaining([
              "base-swap-old-1",
              "base-swap-expired-1",
            ]),
          },
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        }),
        data: expect.objectContaining({
          status: TRACKED_MESSAGE_STATUS.REPLACED,
        }),
      }),
    );
  });

  it("ignores a future sync post when deciding whether to replace legacy bases completion rows", async () => {
    prismaMock.trackedMessage.findFirst.mockImplementation(async (query: any) => {
      expect(query).toMatchObject({
        where: expect.objectContaining({
          guildId: "guild-1",
          referenceId: null,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
          OR: [
            { remindAt: null },
            {
              remindAt: {
                lte: new Date("2026-06-13T18:45:00.000Z"),
              },
            },
          ],
        }),
      });
      return null;
    });

    prismaMock.trackedMessage.findMany.mockImplementation(async ({ where }: any) => {
      if (
        where?.featureType === TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST &&
        where?.status === TRACKED_MESSAGE_STATUS.ACTIVE
      ) {
        return [
          {
            id: "legacy-bases-current",
            messageId:
              "fwa_match_checklist_bases_completion|guild=guild-1|clan=#LQQ99UV8|war=1000418|opponent=OPP1|start=2026-06-13T18:00:00.000Z",
            referenceId: null,
            createdAt: new Date("2026-06-13T18:10:00.000Z"),
            metadata: {
              kind: "bases_completion",
              createdByUserId: "user-1",
              createdAtIso: "2026-06-13T18:10:00.000Z",
              clanTag: "#LQQ99UV8",
              clanName: "Zero Gravity",
              checked: true,
              warId: "1000418",
              opponentTag: "#902PQVRL",
              warStartTimeIso: "2026-06-13T18:00:00.000Z",
            },
          },
        ];
      }
      return [];
    });

    const summary = await trackedMessageService.repairStaleFwaBasesChecklistState({
      guildId: "guild-1",
      apply: true,
      now: new Date("2026-06-13T18:45:00.000Z"),
    });

    expect(summary).toMatchObject({
      guildId: "guild-1",
      currentSyncMessageId: null,
      dryRun: false,
      basesCompletionCandidates: 0,
      basesCompletionReplaced: 0,
      baseSwapCandidates: 0,
      baseSwapReplaced: 0,
    });
    expect(prismaMock.trackedMessage.updateMany).not.toHaveBeenCalled();
  });

  it("creates and dedupes a bases checklist reminder marker per clan war bucket", async () => {
    prismaMock.trackedMessage.create.mockResolvedValueOnce(undefined);

    await expect(
      trackedMessageService.claimFwaBasesChecklistReminderMarker({
        guildId: "guild-1",
        channelId: "channel-1",
        clanTag: "#PYPY",
        clanName: "Alpha",
        warId: 1001,
        opponentTag: "#OPP1",
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        bucketHours: 6,
        destinationChannelId: "leader-channel-1",
        destinationChannelKind: "leader",
        clanRoleId: "role-1",
        createdByUserId: "user-1",
        createdAtIso: "2026-06-13T12:00:00.000Z",
      }),
    ).resolves.toBe(true);

    expect(prismaMock.trackedMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messageId:
            "fwa_match_checklist_bases_reminder|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-06-13T18:00:00.000Z|bucket=6",
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          metadata: expect.objectContaining({
            kind: "bases_check_reminder",
            clanTag: "#PYPY",
            bucketHours: 6,
            destinationChannelKind: "leader",
          }),
        }),
      }),
    );

    prismaMock.trackedMessage.create.mockRejectedValueOnce({ code: "P2002" });
    await expect(
      trackedMessageService.claimFwaBasesChecklistReminderMarker({
        guildId: "guild-1",
        channelId: "channel-1",
        clanTag: "#PYPY",
        warId: 1001,
        opponentTag: "#OPP1",
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        bucketHours: 6,
      }),
    ).resolves.toBe(false);
  });

  it("keeps reminder markers scoped to the current war identity", async () => {
    prismaMock.trackedMessage.create.mockResolvedValue(undefined);

    await expect(
      trackedMessageService.claimFwaBasesChecklistReminderMarker({
        guildId: "guild-1",
        channelId: "channel-1",
        clanTag: "#PYPY",
        clanName: "Alpha",
        warId: 1001,
        opponentTag: "#OPP1",
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        bucketHours: 6,
        createdByUserId: "user-1",
        createdAtIso: "2026-06-13T12:00:00.000Z",
      }),
    ).resolves.toBe(true);

    await expect(
      trackedMessageService.claimFwaBasesChecklistReminderMarker({
        guildId: "guild-1",
        channelId: "channel-1",
        clanTag: "#PYPY",
        clanName: "Alpha",
        warId: 1002,
        opponentTag: "#OPP2",
        warStartTime: new Date("2026-06-20T18:00:00.000Z"),
        bucketHours: 6,
        createdByUserId: "user-1",
        createdAtIso: "2026-06-20T12:00:00.000Z",
      }),
    ).resolves.toBe(true);

    expect(prismaMock.trackedMessage.create).toHaveBeenCalledTimes(2);
    expect(String(prismaMock.trackedMessage.create.mock.calls[0]?.[0]?.data?.messageId ?? "")).toContain(
      "war=1001",
    );
    expect(String(prismaMock.trackedMessage.create.mock.calls[1]?.[0]?.data?.messageId ?? "")).toContain(
      "war=1002",
    );
  });

  it("builds checklist rows from compact copy text without duplicating the checklist column", () => {
    const rows = makeTrackedChecklistRow().metadata.rows;

    expect(rows[0]).toMatchObject({
      clanTag: "RR",
      compactCopyLine: "📬 | 🟢 | RR vs `Bravo` (`#B1`)",
      badgeEmojiId: "111",
      badgeEmojiName: "rr",
      badgeEmojiInline: "<:rr:111>",
    });
    expect(rows[1]).toMatchObject({
      clanTag: "TWC",
      compactCopyLine: "📭 | 🔴 | TWC vs `Delta` (`#D2`)",
      badgeEmojiId: "222",
      badgeEmojiName: "twc",
      badgeEmojiInline: "<:twc:222>",
    });

    expect(
      buildFwaMatchChecklistContent({
        rows,
        checkedClanTags: [],
      }),
    ).toBe(
      "📬 | 🟢 | ☐ | RR vs `Bravo` (`#B1`)\n📭 | 🔴 | ☐ | TWC vs `Delta` (`#D2`)",
    );
    expect(
      buildFwaMatchChecklistContent({
        rows,
        checkedClanTags: ["#RR"],
      }),
    ).toBe(
      "📬 | 🟢 | ✅ | RR vs `Bravo` (`#B1`)\n📭 | 🔴 | ☐ | TWC vs `Delta` (`#D2`)",
    );
  });

  it("reacting with one clan badge checks only that clan", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeTrackedChecklistRow());
    const setBasesCompletion = vi.spyOn(
      trackedMessageService,
      "setFwaMatchChecklistBasesCompletion",
    );

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map([
          [
            "rr",
            {
              emoji: { id: "111", name: "rr" },
              count: 2,
            },
          ],
          [
            "twc",
            {
              emoji: { id: "222", name: "twc" },
              count: 1,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any),
    ).resolves.toBe(true);

    const payload = edit.mock.calls[0]?.[0] as any;
    expect(payload.content).toBe(
      buildFwaMatchChecklistMessageContent({
        rows: makeTrackedChecklistRow().metadata.rows,
        checkedClanTags: ["#RR"],
      }),
    );
    expect(payload.content).toContain("# Clan Mail Checklist");
    expect(payload.content).toContain(
      "React with your clan's badge to indicate that the in-game mails have been sent.",
    );
    expect(payload.content).toContain("📬 | 🟢 | ✅ | RR vs `Bravo` (`#B1`)");
    expect(payload.content).toContain("📭 | 🔴 | ☐ | TWC vs `Delta` (`#D2`)");
    expect(setBasesCompletion).not.toHaveBeenCalled();
  });
  it("rebuilds refreshed checklist content from supplied current match rows", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeTrackedChecklistRow());

    const edit = vi.fn().mockResolvedValue(undefined);
    const currentRows = [
      {
        clanTag: "RR",
        compactCopyLine: "📬 | 🟢 | RR vs `Charlie` (`#C3`)",
        badgeEmojiId: "111",
        badgeEmojiName: "rr",
        badgeEmojiInline: "<:rr:111>",
        contextKey: "ctx-rr-current",
      },
      {
        clanTag: "TWC",
        compactCopyLine: "📭 | 🔴 | TWC vs `Delta` (`#D2`)",
        badgeEmojiId: "222",
        badgeEmojiName: "twc",
        badgeEmojiInline: "<:twc:222>",
        contextKey: "ctx-twc-current",
      },
    ];
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map([
          [
            "rr",
            {
              emoji: { id: "111", name: "rr" },
              count: 2,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(
        message as any,
        null,
        { rows: currentRows as any, scopeKey: "scope-key-current" },
      ),
    ).resolves.toBe(true);

    const payload = edit.mock.calls[0]?.[0] as any;
    expect(payload.content).toBe(
      buildFwaMatchChecklistMessageContent({
        rows: currentRows as any,
        checkedClanTags: ["#RR"],
      }),
    );
    expect(payload.content).toContain("# Clan Mail Checklist");
    expect(payload.content).toContain("Charlie");
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            scopeKey: "scope-key-current",
            rows: currentRows,
            checkedClanTags: ["RR"],
          }),
        }),
      }),
    );
  });
  it("persists checked state when a clan badge is reacted to", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeTrackedChecklistRow());

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map([
          [
            "rr",
            {
              emoji: { id: "111", name: "rr" },
              count: 2,
            },
          ],
          [
            "twc",
            {
              emoji: { id: "222", name: "twc" },
              count: 1,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any),
    ).resolves.toBe(true);

    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            checkedClanTags: ["RR"],
          }),
        }),
      }),
    );
  });

  it("merges persisted checked clans with a later reaction add on a different clan", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(
      makeTrackedChecklistRowWithState(["RR"]),
    );
    prismaMock.currentWar.findUnique.mockResolvedValueOnce({
      warId: 1001,
      startTime: new Date("2026-05-13T18:00:00.000Z"),
      opponentTag: "#OPP1",
    } as any);
    const recordMailChecked = vi
      .spyOn(repWorkActivityService, "recordMailChecked")
      .mockResolvedValue(true);

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map([
          [
            "rr",
            {
              emoji: { id: "111", name: "rr" },
              count: 1,
            },
          ],
          [
            "twc",
            {
              emoji: { id: "222", name: "twc" },
              count: 2,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, {
        kind: "add",
        reactorUserId: "111111111111111111",
        reaction: {
          emoji: { id: "222", name: "twc" },
          count: 2,
        },
      }),
    ).resolves.toBe(true);

    const payload = edit.mock.calls[0]?.[0] as any;
    expect(payload.content).toBe(
      buildFwaMatchChecklistMessageContent({
        rows: makeTrackedChecklistRow().metadata.rows,
        checkedClanTags: ["RR", "TWC"],
      }),
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            checkedClanTags: ["RR", "TWC"],
          }),
        }),
      }),
    );
    expect(recordMailChecked).toHaveBeenCalledTimes(1);
    expect(recordMailChecked).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        clanTag: "TWC",
        warStartTime: new Date("2026-05-13T18:00:00.000Z"),
        sourceMessageId: "checklist-message-1",
        sourceTrackedMessageId: "tracked-1",
      }),
    );
  });

  it("removes only the reacted clan from persisted checked state on reaction remove", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(
      makeTrackedChecklistRowWithState(["RR", "TWC"]),
    );
    const recordMailChecked = vi
      .spyOn(repWorkActivityService, "recordMailChecked")
      .mockResolvedValue(true);

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map([
          [
            "rr",
            {
              emoji: { id: "111", name: "rr" },
              count: 1,
            },
          ],
          [
            "twc",
            {
              emoji: { id: "222", name: "twc" },
              count: 2,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, {
        kind: "remove",
        reaction: {
          emoji: { id: "111", name: "rr" },
          count: 1,
        },
      }),
    ).resolves.toBe(true);

    const payload = edit.mock.calls[0]?.[0] as any;
    expect(payload.content).toBe(
      buildFwaMatchChecklistMessageContent({
        rows: makeTrackedChecklistRow().metadata.rows,
        checkedClanTags: ["TWC"],
      }),
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            checkedClanTags: ["TWC"],
          }),
        }),
      }),
    );
    expect(recordMailChecked).not.toHaveBeenCalled();
  });

  it("keeps persisted checked clans when a refresh sees only bot-seeded reactions", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(
      makeTrackedChecklistRowWithState(["RR"]),
    );

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map([
          [
            "rr",
            {
              emoji: { id: "111", name: "rr" },
              count: 1,
            },
          ],
          [
            "twc",
            {
              emoji: { id: "222", name: "twc" },
              count: 1,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any),
    ).resolves.toBe(true);

    const payload = edit.mock.calls[0]?.[0] as any;
    expect(payload.content).toBe(
      buildFwaMatchChecklistMessageContent({
        rows: makeTrackedChecklistRow().metadata.rows,
        checkedClanTags: ["RR"],
      }),
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            checkedClanTags: ["RR"],
          }),
        }),
      }),
    );
  });

  it("persists unchecked state when no clan badge is checked", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeTrackedChecklistRow());

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "checklist-message-1",
      reactions: {
        cache: new Map([
          [
            "rr",
            {
              emoji: { id: "111", name: "rr" },
              count: 1,
            },
          ],
          [
            "twc",
            {
              emoji: { id: "222", name: "twc" },
              count: 1,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any),
    ).resolves.toBe(true);

    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "checklist-message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            checkedClanTags: [],
          }),
        }),
      }),
    );
  });

  it("marks a public bases checklist clan all-good on reaction add and rerenders it", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PYPY",
        clanBadge: "<:alpha:111>",
        name: "Alpha",
        shortName: "A",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1001,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "fwa",
        inferredMatchType: "fwa",
        outcome: null,
        state: "battle",
      },
    ]);
    const recordBasesChecklistChecked = vi
      .spyOn(repWorkActivityService, "recordBasesChecklistChecked")
      .mockResolvedValue(true);
    const setCompletion = vi
      .spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion")
      .mockResolvedValue(true);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(
      null,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue({
      id: "completion-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId:
        "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-06-13T18:00:00.000Z",
      referenceId: null,
      clanTag: "#PYPY",
      createdAt: new Date("2026-06-13T18:00:01.000Z"),
      expiresAt: null,
      metadata: {
        kind: "bases_completion",
        createdByUserId: "user-1",
        createdAtIso: "2026-06-13T18:00:00.000Z",
        clanTag: "#PYPY",
        clanName: null,
        checked: true,
        warId: "1001",
        opponentTag: "OPP1",
        warStartTimeIso: "2026-06-13T18:00:00.000Z",
      },
    } as any);

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "bases-message-1",
      client: {} as any,
      reactions: {
        cache: new Map([
          [
            "alpha",
            {
              emoji: { id: "111", name: "alpha" },
              count: 2,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(
        message as any,
        {
          kind: "add",
          reactorUserId: "111111111111111111",
          reaction: {
            emoji: { id: "111", name: "alpha" },
            count: 2,
          },
        },
      ),
    ).resolves.toBe(true);

    expect(setCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "channel-1",
        createdByUserId: "user-1",
        clanTag: "#PYPY",
        checked: true,
        warId: "1001",
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
      }),
    );
    expect(
      trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#PYPY",
        syncMessageId: "sync-message-1",
      }),
    );
    expect(
      trackedMessageService.findLatestFwaMatchChecklistBasesCompletionForClan,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#PYPY",
        syncMessageId: "sync-message-1",
      }),
    );
    expect(recordBasesChecklistChecked).toHaveBeenCalledTimes(1);
    expect(recordBasesChecklistChecked).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        clanTag: "#PYPY",
        sourceMessageId: "bases-message-1",
        sourceTrackedMessageId: "tracked-bases-1",
      }),
    );
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Bases Checklist"),
        allowedMentions: { parse: [] },
      }),
    );
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("✅ Bases checked and all good");
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("A |");
  });


  it("persists refreshed bases checklist metadata for later reactions", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PYPY",
        clanBadge: "<:alpha:111>",
        name: "Alpha",
        shortName: "A",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1001,
        startTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: "BL",
        outcome: null,
        state: "battle",
      },
    ]);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(null);
    vi.spyOn(
      trackedMessageService,
      "findLatestFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue(null);

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "bases-message-1",
      client: {} as any,
      reactions: {
        cache: new Map(),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, null, {
        scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
        expiresAt: new Date("2026-06-13T22:00:00.000Z"),
      }),
    ).resolves.toBe(true);

    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "bases-message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            kind: "bases_checklist",
            scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
            checkedClanTags: [],
            rows: expect.arrayContaining([
              expect.objectContaining({
                clanTag: "#PYPY",
                warId: 1001,
                opponentTag: "#OPP1",
                warStartTimeIso: "2026-06-13T18:00:00.000Z",
              }),
            ]),
          }),
        }),
      }),
    );
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("Bases not checked");
  });

  it("hydrates bases reactions before refresh when the cache is empty", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PYPY",
        clanBadge: "<:alpha:111>",
        name: "Alpha",
        shortName: "A",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1001,
        startTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: "BL",
        outcome: null,
        state: "battle",
      },
    ]);
    const setCompletion = vi
      .spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion")
      .mockResolvedValue(true);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(null);
    vi.spyOn(
      trackedMessageService,
      "findLatestFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue({
      id: "completion-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId:
        "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-06-13T18:00:00.000Z",
      referenceId: null,
      clanTag: "#PYPY",
      createdAt: new Date("2026-06-13T18:00:01.000Z"),
      expiresAt: null,
      metadata: {
        kind: "bases_completion",
        createdByUserId: "user-1",
        createdAtIso: "2026-06-13T18:00:00.000Z",
        clanTag: "#PYPY",
        clanName: null,
        checked: true,
        warId: "1001",
        opponentTag: "#OPP1",
        warStartTimeIso: "2026-06-13T18:00:00.000Z",
      },
    } as any);

    const fetch = vi.fn().mockResolvedValue({
      reactions: {
        cache: new Map([
          [
            "alpha",
            {
              emoji: { id: "111", name: "alpha" },
              count: 2,
            },
          ],
        ]),
      },
    });
    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "bases-message-1",
      partial: true,
      fetch,
      client: {} as any,
      reactions: {
        cache: new Map(),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(
        message as any,
        null,
        {
          rows: makeBasesTrackedChecklistRow().metadata.rows,
          scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
          expiresAt: new Date("2026-06-13T22:00:00.000Z"),
        },
      ),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(setCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "channel-1",
        createdByUserId: "user-1",
        clanTag: "#PYPY",
        checked: true,
        warId: 1001,
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
      }),
    );
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: "bases-message-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            referenceId: "sync-message-1",
            rows: expect.arrayContaining([
              expect.objectContaining({
                clanTag: "#PYPY",
                warId: 1001,
                opponentTag: "#OPP1",
                compactCopyLine: expect.stringContaining("✅ Bases checked and all good"),
              }),
            ]),
          }),
        }),
      }),
    );
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("✅ Bases checked and all good");
    expect(edit.mock.calls.at(-1)?.[0]?.content).not.toContain("❌ Bases not checked");
  });

  it("ignores skipped bases rows when a badge reaction is added", async () => {
    const skippedRow = {
      ...makeBasesTrackedChecklistRow(),
      metadata: {
        ...makeBasesTrackedChecklistRow().metadata,
        rows: [
          {
            ...makeBasesTrackedChecklistRow().metadata.rows[0],
            basesStatus: "skipped",
            compactCopyLine: "Alpha | 🔘 | Skipped this sync 😴",
            warId: null,
            opponentTag: null,
            warStartTimeIso: null,
            contextKey: null,
          },
        ],
      },
    };
    prismaMock.trackedMessage.findUnique.mockResolvedValue(skippedRow as any);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1001,
        startTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: "BL",
        outcome: null,
        state: "notInWar",
      },
    ]);
    const setCompletion = vi
      .spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion")
      .mockResolvedValue(true);
    const recordBasesChecklistChecked = vi.spyOn(
      repWorkActivityService,
      "recordBasesChecklistChecked",
    );
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(
      null,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue(null);

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "bases-message-1",
      client: {} as any,
      reactions: {
        cache: new Map([
          [
            "alpha",
            {
              emoji: { id: "111", name: "alpha" },
              count: 2,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, {
        kind: "add",
        reaction: {
          emoji: { id: "111", name: "alpha" },
          count: 2,
        },
        reactorUserId: "111111111111111111",
      }),
    ).resolves.toBe(true);

    expect(setCompletion).not.toHaveBeenCalled();
    expect(recordBasesChecklistChecked).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalled();
  });

  it("logs hydration failures but preserves the supplied bases issue rows", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PYPY",
        clanBadge: "<:alpha:111>",
        name: "Alpha",
        shortName: "A",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1001,
        startTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "BL",
        inferredMatchType: "BL",
        outcome: null,
        state: "battle",
      },
    ]);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue({
      id: "swap-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "swap-message-1",
      referenceId: "fwa-base-swap:split-1",
      clanTag: "#PYPY",
      createdAt: new Date("2026-05-13T17:00:00.000Z"),
      expiresAt: new Date("2026-05-13T19:00:00.000Z"),
      metadata: {
        clanKind: "FWA",
        clanName: "Alpha",
        createdByUserId: "user-1",
        createdAtIso: "2026-05-13T17:00:00.000Z",
        syncMessageId: "sync-message-1",
        clanRoleId: null,
        swapReminder: false,
        renderVariant: "single",
        phaseTimingLine: null,
        alertEmoji: null,
        fwaAlertEmoji: null,
        layoutBulletEmoji: null,
        entries: [
          {
            position: 12,
            playerTag: "#P1",
            playerName: "PlayerOne",
            discordUserId: "discord-1",
            townhallLevel: 15,
            section: "base_errors",
            acknowledged: false,
          },
        ],
        layoutLinks: [],
      },
    } as any);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "bases-message-1",
      partial: true,
      fetch: vi.fn().mockRejectedValue(new Error("hydrate failed")),
      client: {} as any,
      reactions: {
        cache: new Map(),
      },
      edit,
    };
    const issueRows = makeBasesTrackedChecklistRow().metadata.rows.map((row) => ({
      ...row,
      compactCopyLine: "A | ⚫ | ⚠️ Bases checked - issues found: base-swap post",
    }));

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(message as any, null, {
        rows: issueRows,
        scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=alpha",
      }),
    ).resolves.toBe(true);

    expect(errorSpy).toHaveBeenCalled();
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("issues found");
    expect(edit.mock.calls.at(-1)?.[0]?.content).not.toContain("Bases not checked");
  });

  it("clears a public bases checklist clan when the last user reaction is removed", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PYPY",
        clanBadge: "<:alpha:111>",
        name: "Alpha",
        shortName: "A",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1001,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "fwa",
        inferredMatchType: "fwa",
        outcome: null,
        state: "battle",
      },
    ]);
    const setCompletion = vi
      .spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion")
      .mockResolvedValue(true);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(
      null,
    );
    vi.spyOn(
      trackedMessageService,
      "findLatestFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue(null);

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "bases-message-1",
      client: {} as any,
      reactions: {
        cache: new Map([
          [
            "alpha",
            {
              emoji: { id: "111", name: "alpha" },
              count: 1,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(
        message as any,
        {
          kind: "remove",
          reaction: {
            emoji: { id: "111", name: "alpha" },
            count: 1,
          },
        },
      ),
    ).resolves.toBe(true);

    expect(setCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTag: "#PYPY",
        checked: false,
        warId: "1001",
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
      }),
    );
    expect(
      trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#PYPY",
        syncMessageId: "sync-message-1",
      }),
    );
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("❌ Bases not checked");
  });

  it("keeps a base-swap issue ahead of an all-good bases completion on reaction add", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeBasesTrackedChecklistRow());
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PYPY",
        clanBadge: "<:alpha:111>",
        name: "Alpha",
        shortName: "A",
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYPY",
        warId: 1001,
        startTime: new Date("2026-05-13T18:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "fwa",
        inferredMatchType: "fwa",
        outcome: null,
        state: "battle",
      },
    ]);
    vi.spyOn(trackedMessageService, "setFwaMatchChecklistBasesCompletion").mockResolvedValue(true);
    vi.spyOn(
      trackedMessageService,
      "findLatestFwaMatchChecklistBasesCompletionForClan",
    ).mockResolvedValue({
      id: "completion-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId:
        "fwa_match_checklist_bases_completion|guild=guild-1|clan=#PYPY|war=1001|opponent=OPP1|start=2026-06-13T18:00:00.000Z",
      referenceId: null,
      clanTag: "#PYPY",
      createdAt: new Date("2026-06-13T18:00:01.000Z"),
      expiresAt: null,
      metadata: {
        kind: "bases_completion",
        createdByUserId: "user-1",
        createdAtIso: "2026-06-13T18:00:00.000Z",
        clanTag: "#PYPY",
        clanName: null,
        checked: true,
        warId: "1001",
        opponentTag: "OPP1",
        warStartTimeIso: "2026-06-13T18:00:00.000Z",
      },
    } as any);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue({
      id: "swap-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "swap-message-1",
      referenceId: "fwa-base-swap:split-1",
      clanTag: "#PYPY",
      createdAt: new Date("2026-05-13T17:00:00.000Z"),
      expiresAt: new Date("2026-05-13T19:00:00.000Z"),
      metadata: {
        clanKind: "FWA",
        clanName: "Alpha",
        createdByUserId: "user-1",
        createdAtIso: "2026-05-13T17:00:00.000Z",
        syncMessageId: "sync-message-1",
        clanRoleId: null,
        swapReminder: false,
        renderVariant: "single",
        phaseTimingLine: null,
        alertEmoji: null,
        fwaAlertEmoji: null,
        layoutBulletEmoji: null,
        entries: [
          {
            position: 12,
            playerTag: "#P1",
            playerName: "PlayerOne",
            discordUserId: "discord-1",
            townhallLevel: 15,
            section: "base_errors",
            acknowledged: false,
          },
        ],
        layoutLinks: [],
      },
    } as any);

    const edit = vi.fn().mockResolvedValue(undefined);
    const message = {
      id: "bases-message-1",
      client: {} as any,
      reactions: {
        cache: new Map([
          [
            "alpha",
            {
              emoji: { id: "111", name: "alpha" },
              count: 2,
            },
          ],
        ]),
      },
      edit,
    };

    await expect(
      trackedMessageService.refreshFwaMatchChecklistMessage(
        message as any,
        {
          kind: "add",
          reaction: {
            emoji: { id: "111", name: "alpha" },
            count: 2,
          },
        },
      ),
    ).resolves.toBe(true);

    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("⚠️ Bases checked - issues found");
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("[base-swap post](");
    expect(edit.mock.calls.at(-1)?.[0]?.content).not.toContain("War bases:");
    expect(edit.mock.calls.at(-1)?.[0]?.content).not.toContain("Base errors:");
  });

  it("wires checklist reaction removals to checklist refresh without touching sync tracking", async () => {
    const on = vi.fn();
    const client = { on } as any;
    messageReactionRemove(client);

    const handler = on.mock.calls.find((call) => call[0] === "messageReactionRemove")?.[1] as
      | ((reaction: any, user: any) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");

    const refreshChecklist = vi
      .spyOn(trackedMessageService, "refreshFwaMatchChecklistMessage")
      .mockResolvedValue(true);
    const recordSync = vi
      .spyOn(trackedMessageService, "removeSyncClaim")
      .mockResolvedValue(true);

    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeTrackedChecklistRow());

    await handler?.(
      {
        partial: false,
        fetch: vi.fn(),
        message: { id: "checklist-message-1" },
        emoji: { id: "111", name: "rr" },
        count: 1,
      },
      {
        partial: false,
        fetch: vi.fn(),
        bot: false,
        id: "111111111111111111",
      },
    );

    expect(refreshChecklist).toHaveBeenCalled();
    expect(refreshChecklist.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        kind: "remove",
        reactorUserId: "111111111111111111",
      }),
    );
    expect(recordSync).not.toHaveBeenCalled();
  });

  it("wires checklist reactions to checklist refresh without touching sync tracking", async () => {
    const on = vi.fn();
    const client = { on } as any;
    messageReactionAdd(client);

    const handler = on.mock.calls.find((call) => call[0] === "messageReactionAdd")?.[1] as
      | ((reaction: any, user: any) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");

    const refreshChecklist = vi
      .spyOn(trackedMessageService, "refreshFwaMatchChecklistMessage")
      .mockResolvedValue(true);
    const recordSync = vi
      .spyOn(trackedMessageService, "recordSyncClaim")
      .mockResolvedValue(true);

    prismaMock.trackedMessage.findUnique.mockResolvedValue(makeTrackedChecklistRow());

    await handler?.(
      {
        partial: false,
        fetch: vi.fn(),
        message: { id: "checklist-message-1" },
        emoji: { id: "111", name: "rr" },
        count: 2,
      },
      {
        partial: false,
        fetch: vi.fn(),
        bot: false,
        id: "111111111111111111",
      },
    );

    expect(refreshChecklist).toHaveBeenCalled();
    expect(refreshChecklist.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        kind: "add",
        reactorUserId: "111111111111111111",
      }),
    );
    expect(recordSync).not.toHaveBeenCalled();
  });

  it("ignores bot users for SYNC_TIME_POST reactions without recording sync claims", async () => {
    vi.resetModules();
    const { default: messageReactionAddFresh } = await import("../src/listeners/messageReactionAdd");
    const on = vi.fn();
    const client = { on } as any;
    messageReactionAddFresh(client);

    const handler = on.mock.calls.find((call) => call[0] === "messageReactionAdd")?.[1] as
      | ((reaction: any, user: any) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");

    const recordSync = vi
      .spyOn(trackedMessageService, "recordSyncClaim")
      .mockResolvedValue(true);
    const refreshSync = vi.spyOn(trackedMessageService, "refreshSyncSpinStatusMessage");
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      id: "sync-tracked-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-1",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: "source-sync-1",
    } as any);

    await handler?.(
      {
        partial: false,
        fetch: vi.fn(),
        message: { id: "sync-message-1" },
        emoji: { id: "111", name: "rr" },
        count: 2,
      },
      {
        partial: false,
        fetch: vi.fn(),
        bot: true,
        id: "bot-user-1",
      },
    );

    expect(recordSync).not.toHaveBeenCalled();
    expect(refreshSync).not.toHaveBeenCalled();
  });

  it("ignores bot users for SYNC_TIME_POST removals without removing sync claims", async () => {
    vi.resetModules();
    const { default: messageReactionRemoveFresh } = await import("../src/listeners/messageReactionRemove");
    const on = vi.fn();
    const client = { on } as any;
    messageReactionRemoveFresh(client);

    const handler = on.mock.calls.find((call) => call[0] === "messageReactionRemove")?.[1] as
      | ((reaction: any, user: any) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");

    const removeSync = vi
      .spyOn(trackedMessageService, "removeSyncClaim")
      .mockResolvedValue(true);
    const refreshSync = vi.spyOn(trackedMessageService, "refreshSyncSpinStatusMessage");
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      id: "sync-tracked-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "sync-message-1",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: "source-sync-1",
    } as any);

    await handler?.(
      {
        partial: false,
        fetch: vi.fn(),
        message: { id: "sync-message-1" },
        emoji: { id: "111", name: "rr" },
        count: 1,
      },
      {
        partial: false,
        fetch: vi.fn(),
        bot: true,
        id: "bot-user-1",
      },
    );

    expect(removeSync).not.toHaveBeenCalled();
    expect(refreshSync).not.toHaveBeenCalled();
  });

  it("logs checklist bot_user diagnostics while ignoring bot reactions", async () => {
    vi.resetModules();
    const { default: messageReactionAddFresh } = await import("../src/listeners/messageReactionAdd");
    const on = vi.fn();
    const client = { on } as any;
    messageReactionAddFresh(client);

    const handler = on.mock.calls.find((call) => call[0] === "messageReactionAdd")?.[1] as
      | ((reaction: any, user: any) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");

    const refreshChecklist = vi.spyOn(trackedMessageService, "refreshFwaMatchChecklistMessage");
    prismaMock.trackedMessage.findUnique.mockResolvedValue({
      ...makeTrackedChecklistRow(),
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
    } as any);

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    await handler?.(
      {
        partial: false,
        fetch: vi.fn(),
        message: { id: "checklist-message-1" },
        emoji: { id: "111", name: "rr" },
        count: 2,
      },
      {
        partial: false,
        fetch: vi.fn(),
        bot: true,
        id: "bot-user-1",
      },
    );

    expect(refreshChecklist).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("reason=bot_user"),
    );
  });
});

