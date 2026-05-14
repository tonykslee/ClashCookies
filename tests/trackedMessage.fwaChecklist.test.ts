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
      buildFwaMatchChecklistContent({
        rows: makeTrackedChecklistRow().metadata.rows,
        checkedClanTags: ["#RR"],
      }),
    );
    expect(payload.content).toContain("📬 | 🟢 | ✅ | RR vs `Bravo` (`#B1`)");
    expect(payload.content).toContain("📭 | 🔴 | ☐ | TWC vs `Delta` (`#D2`)");
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
