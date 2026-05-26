import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  currentWar: {
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
  buildFwaMatchChecklistContent,
  buildFwaMatchChecklistMessageContent,
  trackedMessageService,
} from "../src/services/TrackedMessageService";
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

describe("fwa checklist tracked messages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.trackedMessage.findUnique.mockResolvedValue(null);
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.upsert.mockResolvedValue(undefined);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);
    prismaMock.trackedMessage.create.mockResolvedValue(undefined);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
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
  });

  it("removes only the reacted clan from persisted checked state on reaction remove", async () => {
    prismaMock.trackedMessage.findUnique.mockResolvedValue(
      makeTrackedChecklistRowWithState(["RR", "TWC"]),
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
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Bases Checklist"),
        allowedMentions: { parse: [] },
      }),
    );
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("✅ Bases checked and all good");
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("A |");
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
      referenceId: "swap-ref-1",
      clanTag: "#PYPY",
      createdAt: new Date("2026-05-13T17:00:00.000Z"),
      expiresAt: new Date("2026-05-13T19:00:00.000Z"),
      metadata: {
        clanKind: "FWA",
        clanName: "Alpha",
        createdByUserId: "user-1",
        createdAtIso: "2026-05-13T17:00:00.000Z",
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
    expect(edit.mock.calls.at(-1)?.[0]?.content).toContain("Base errors:");
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
        id: "user-1",
      },
    );

    expect(refreshChecklist).toHaveBeenCalled();
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
        id: "user-1",
      },
    );

    expect(refreshChecklist).toHaveBeenCalled();
    expect(recordSync).not.toHaveBeenCalled();
  });
});

