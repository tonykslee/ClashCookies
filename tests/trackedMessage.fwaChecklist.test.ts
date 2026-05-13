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
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  buildFwaMatchChecklistContent,
  trackedMessageService,
} from "../src/services/TrackedMessageService";
import { addFwaMatchChecklistReactionsForTest } from "../src/commands/Fwa";

function makeTrackedChecklistRow() {
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
      rows: [
        {
          clanTag: "#RR",
          compactCopyLine: "📬 | 🟢 | RR vs `Bravo` (`#B1`)",
          badgeEmojiId: "111",
          badgeEmojiName: "rr",
          badgeEmojiInline: "<:rr:111>",
        },
        {
          clanTag: "#TWC",
          compactCopyLine: "📭 | 🔴 | TWC vs `Delta` (`#D2`)",
          badgeEmojiId: "222",
          badgeEmojiName: "twc",
          badgeEmojiInline: "<:twc:222>",
        },
      ],
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
      [
        {
          clanTag: "#RR",
          compactCopyLine: "📬 | 🟢 | RR vs `Bravo` (`#B1`)",
          badgeEmojiId: "111",
          badgeEmojiName: "rr",
          badgeEmojiInline: "<:rr:111>",
        },
        {
          clanTag: "#TWC",
          compactCopyLine: "📭 | 🔴 | TWC vs `Delta` (`#D2`)",
          badgeEmojiId: "222",
          badgeEmojiName: "twc",
          badgeEmojiInline: "<:twc:222>",
        },
      ],
    );

    expect(react).toHaveBeenCalledWith("<:rr:111>");
    expect(react).toHaveBeenCalledWith("<:twc:222>");
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
