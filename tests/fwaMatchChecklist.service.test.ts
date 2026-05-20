import { beforeEach, describe, expect, it, vi } from "vitest";

const trackedMessageMock = vi.hoisted(() => ({
  createFwaMatchChecklistTrackedMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/TrackedMessageService", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/TrackedMessageService",
  );
  return {
    ...actual,
    trackedMessageService: trackedMessageMock,
  };
});

import {
  buildFwaMatchChecklistMessageContent,
  buildFwaMatchChecklistRowsFromCopyView,
  postFwaMatchChecklistMessage,
} from "../src/services/FwaMatchChecklistService";

function buildRows() {
  return buildFwaMatchChecklistRowsFromCopyView({
    orderedTags: ["#PYPY", "#PYPL"],
    copyText:
      "📬 | 🟢 | RR vs `Bravo` (`#B1`)\n📭 | 🔴 | TWC vs `Delta` (`#D2`)",
    badgeByTag: new Map([
      ["#PYPY", "<:rr:111>"],
      ["#PYPL", "<:twc:222>"],
    ]),
  });
}

describe("FWA match checklist service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds checklist content with the mail checklist header and body", () => {
    const content = buildFwaMatchChecklistMessageContent({
      rows: buildRows(),
      checkedClanTags: ["#PYPY"],
    });

    expect(content).toContain("# Clan Mail Checklist");
    expect(content).toContain(
      "React with your clan's badge to indicate that the in-game mails have been sent.",
    );
    expect(content).toContain("📬 | 🟢 | ✅ | RR vs `Bravo` (`#B1`)");
    expect(content).toContain("📭 | 🔴 | ☐ | TWC vs `Delta` (`#D2`)");
  });

  it("publishes a public checklist with reactions and tracked-message persistence", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const fetchReply = vi.fn().mockResolvedValue({ id: "message-1", react });
    const interaction = {
      guildId: "guild-1",
      channelId: "channel-1",
      user: { id: "user-1" },
      editReply,
      fetchReply,
    } as any;

    await postFwaMatchChecklistMessage({
      interaction,
      isPublic: true,
      rows: buildRows(),
      clanTag: null,
      scopeKey: "scope-key",
      checkedClanTags: ["#PYPY"],
    });

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Mail Checklist"),
      }),
    );
    expect(fetchReply).toHaveBeenCalledTimes(1);
    expect(
      trackedMessageMock.createFwaMatchChecklistTrackedMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        clanTag: null,
        expiresAt: expect.any(Date),
        metadata: expect.objectContaining({
          scopeKey: "scope-key",
          checkedClanTags: ["#PYPY"],
          createdByUserId: "user-1",
          createdAtIso: expect.any(String),
          rows: expect.any(Array),
        }),
      }),
    );
    expect(react).toHaveBeenCalledWith("<:rr:111>");
    expect(react).toHaveBeenCalledWith("<:twc:222>");
  });

  it("renders a private checklist snapshot without reactions or tracked-message writes", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const fetchReply = vi.fn().mockResolvedValue({ id: "message-1", react });
    const interaction = {
      guildId: "guild-1",
      channelId: "channel-1",
      user: { id: "user-1" },
      editReply,
      fetchReply,
    } as any;

    await postFwaMatchChecklistMessage({
      interaction,
      isPublic: false,
      rows: buildRows(),
      clanTag: null,
      scopeKey: "scope-key",
      checkedClanTags: ["#PYPY"],
    });

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Mail Checklist"),
      }),
    );
    expect(fetchReply).not.toHaveBeenCalled();
    expect(
      trackedMessageMock.createFwaMatchChecklistTrackedMessage,
    ).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
  });
});
