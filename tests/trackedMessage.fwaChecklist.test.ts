import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
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

describe("fwa checklist tracked messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findUnique.mockResolvedValue(null);
    prismaMock.trackedMessage.upsert.mockResolvedValue(undefined);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);
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

