import { beforeEach, describe, expect, it, vi } from "vitest";

const trackedMessageMock = vi.hoisted(() => ({
  createFwaMatchChecklistTrackedMessage: vi.fn().mockResolvedValue(undefined),
  refreshFwaMatchChecklistMessage: vi.fn().mockResolvedValue(true),
  getActiveByMessageId: vi.fn().mockResolvedValue({ status: "ACTIVE" }),
  replaceOlderFwaMatchChecklistMessages: vi.fn().mockResolvedValue(0),
}));
const fwaChecklistRenderStateMock = vi.hoisted(() => ({
  buildFwaMatchChecklistRenderStateForGuild: vi.fn().mockResolvedValue({
    rows: [
      {
        clanTag: "#PYPY",
        compactCopyLine: "ðŸ“¬ | ðŸŸ¢ | RR vs `Bravo` (`#B1`)",
        badgeEmojiId: "111",
        badgeEmojiName: "rr",
        badgeEmojiInline: "<:rr:111>",
        contextKey: "ctx-rr",
      },
    ],
    scopeKey: "fwa_match_checklist|guild=guild-1|clan=all|rows=ctx-rr",
    checkedClanTags: ["#PYPY"],
    referenceId: "sync-message-1",
    emptyMessage: null,
  }),
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

vi.mock("../src/services/CoCService", () => ({
  CoCService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/services/FwaMatchChecklistStateService", () => ({
  buildFwaMatchChecklistRenderStateForGuild:
    fwaChecklistRenderStateMock.buildFwaMatchChecklistRenderStateForGuild,
}));

import {
  buildFwaMatchChecklistMessageContent,
  buildFwaMatchBasesMessageContent,
  buildFwaMatchChecklistRowsFromCopyView,
  handleFwaMatchChecklistRefreshButton,
  postFwaMatchChecklistMessage,
  publishFwaMatchChecklistMessageToChannel,
} from "../src/services/FwaMatchChecklistService";

function buildRows() {
  return buildFwaMatchChecklistRowsFromCopyView({
    orderedTags: ["#PYPY", "#PYPL"],
    copyText:
      "ðŸ“¬ | ðŸŸ¢ | RR vs `Bravo` (`#B1`)\nðŸ“­ | ðŸ”´ | TWC vs `Delta` (`#D2`)",
    badgeByTag: new Map([
      ["#PYPY", "<:rr:111>"],
      ["#PYPL", "<:twc:222>"],
    ]),
  });
}

function buildMixedRows() {
  return buildFwaMatchChecklistRowsFromCopyView({
    orderedTags: ["#PYPY", "PYPL", "#MISS"],
    copyText:
      "ðŸ“¬ | ðŸŸ¢ | RR vs `Bravo` (`#B1`)\nðŸ“­ | ðŸ”´ | TWC vs `Delta` (`#D2`)\nðŸ“« | â | Missing badge (`#M9`)",
    badgeByTag: new Map([
      ["PYPY", "<:rr:111>"],
      ["#PYPL", "<:twc:222>"],
    ]),
  });
}


describe("FWA match checklist service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackedMessageMock.createFwaMatchChecklistTrackedMessage.mockResolvedValue(
      undefined,
    );
    trackedMessageMock.refreshFwaMatchChecklistMessage.mockResolvedValue(true);
    trackedMessageMock.getActiveByMessageId.mockResolvedValue({ status: "ACTIVE" });
    trackedMessageMock.replaceOlderFwaMatchChecklistMessages.mockResolvedValue(0);
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
    expect(content).toContain("RR vs `Bravo` (`#B1`)");
    expect(content).toContain("TWC vs `Delta` (`#D2`)");
  });

  it("builds bases content with issue details", () => {
    const content = buildFwaMatchBasesMessageContent({
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | ⚫ | ⚠️ Bases checked - issues found",
          badgeEmojiId: null,
          badgeEmojiName: null,
          badgeEmojiInline: "",
        },
        {
          clanTag: "#PYPL",
          compactCopyLine: "Beta | 🔘 | ❌ Bases not checked",
          badgeEmojiId: null,
          badgeEmojiName: null,
          badgeEmojiInline: "",
        },
      ],
    });

    expect(content).toContain("# Clan Bases Checklist");
    expect(content).toContain("Alpha | ⚫ | ⚠️ Bases checked - issues found");
    expect(content).toContain("Beta | 🔘 | ❌ Bases not checked");
    expect(content).not.toContain("War bases:");
    expect(content).not.toContain("Base errors:");
    expect(content.split("\n").filter((line) => line.length === 0)).toHaveLength(1);
  });

  it("normalizes mixed badge tag formats and leaves missing badges empty", () => {
    const rows = buildMixedRows();

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      clanTag: "#PYPY",
      badgeEmojiInline: "<:rr:111>",
    });
    expect(rows[1]).toMatchObject({
      clanTag: "#PYPL",
      badgeEmojiInline: "<:twc:222>",
    });
    expect(rows[2]).toMatchObject({
      clanTag: "MISS",
      badgeEmojiInline: "",
    });
  });


  it("publishes a public checklist with reactions and tracked-message persistence", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const pin = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const fetchReply = vi.fn().mockResolvedValue({ id: "message-1", react, pin });
    const expiresAt = new Date("2026-05-13T00:30:00.000Z");
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
      expiresAt,
    });

    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(String(payload?.content ?? "")).toContain("# Clan Mail Checklist");
    const refreshButton = payload?.components?.[0]?.toJSON?.().components?.[0];
    expect(refreshButton?.label).toBe("Refresh");
    expect(fetchReply).toHaveBeenCalledTimes(1);
    expect(
      trackedMessageMock.createFwaMatchChecklistTrackedMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        clanTag: null,
        expiresAt,
        metadata: expect.objectContaining({
          kind: "mail_checklist",
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
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it("reacts to each configured badge row even when badge keys use mixed tag formats", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const pin = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const fetchReply = vi.fn().mockResolvedValue({ id: "message-1", react, pin });
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
      rows: buildMixedRows(),
      clanTag: null,
      scopeKey: "scope-key",
      checkedClanTags: ["#PYPY"],
    });

    expect(react).toHaveBeenCalledWith("<:rr:111>");
    expect(react).toHaveBeenCalledWith("<:twc:222>");
    expect(react).toHaveBeenCalledTimes(2);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(
      trackedMessageMock.replaceOlderFwaMatchChecklistMessages,
    ).not.toHaveBeenCalled();
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
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          `${buildRows()[0].compactCopyLine.split(" | ").slice(0, 2).join(" | ")} | ✅ | RR vs \`Bravo\` (\`#B1\`)`,
        ),
      }),
    );
    expect(fetchReply).not.toHaveBeenCalled();
    expect(
      trackedMessageMock.createFwaMatchChecklistTrackedMessage,
    ).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
  });

  it("refreshes a public checklist message in place without clearing reactions", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const edit = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "fwa-match-checklist-refresh",
      guildId: "guild-1",
      deferUpdate,
      followUp,
      client: {} as any,
      message: {
        id: "message-1",
        reactions: {
          cache: {
            values: () =>
              [
                {
                  emoji: { id: "111", name: "rr" },
                  count: 2,
                },
                {
                  emoji: { id: "222", name: "twc" },
                  count: 1,
                },
              ][Symbol.iterator](),
          },
        },
        edit,
        react,
      },
    } as any;

    fwaChecklistRenderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce(
      {
        rows: [
          {
            clanTag: "#PYPY",
            compactCopyLine: "ðŸ“¬ | ðŸŸ¢ | RR vs `Charlie` (`#C3`)",
            badgeEmojiId: "111",
            badgeEmojiName: "rr",
            badgeEmojiInline: "<:rr:111>",
            contextKey: "ctx-rr",
          },
        ],
        scopeKey: "fwa_match_checklist|guild=guild-1|clan=all|rows=ctx-rr",
        checkedClanTags: ["#PYPY"],
        referenceId: "sync-message-1",
        expiresAt: new Date("2026-05-13T22:00:00.000Z"),
        emptyMessage: null,
      },
    );
    trackedMessageMock.refreshFwaMatchChecklistMessage.mockResolvedValueOnce(true);
    trackedMessageMock.getActiveByMessageId.mockResolvedValueOnce({
      status: "ACTIVE",
    });

    await handleFwaMatchChecklistRefreshButton(interaction);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        components: expect.any(Array),
      }),
    );
    expect(
      edit.mock.calls[0]?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.label,
    ).toBe("Refreshing...");
    expect(
      edit.mock.calls.at(-1)?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.label,
    ).toBe("Refresh");
    expect(
      fwaChecklistRenderStateMock.buildFwaMatchChecklistRenderStateForGuild,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        cocService: expect.any(Object),
        guildId: "guild-1",
        client: expect.any(Object),
        warLookupCache: expect.any(Map),
      }),
    );
    expect(trackedMessageMock.refreshFwaMatchChecklistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "message-1" }),
      null,
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            compactCopyLine: expect.stringContaining("Charlie"),
          }),
        ],
        scopeKey: "fwa_match_checklist|guild=guild-1|clan=all|rows=ctx-rr",
        expiresAt: new Date("2026-05-13T22:00:00.000Z"),
      }),
    );
    expect(react).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("refreshes a public bases checklist message in place with the bases render path", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const edit = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "fwa-match-checklist-refresh",
      guildId: "guild-1",
      deferUpdate,
      followUp,
      client: {} as any,
      message: {
        id: "message-1",
        edit,
        reactions: {
          cache: {
            values: () => [].values(),
          },
        },
      },
    } as any;

    trackedMessageMock.getActiveByMessageId.mockResolvedValueOnce({
      status: "ACTIVE",
      metadata: {
        kind: "bases_checklist",
      },
    } as any);
    fwaChecklistRenderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
          badgeEmojiId: "111",
          badgeEmojiName: "rr",
          badgeEmojiInline: "<:rr:111>",
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-13T18:00:00.000Z",
          detailLines: null,
        },
      ],
      scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-rr",
      checkedClanTags: [],
      referenceId: "sync-message-1",
      expiresAt: new Date("2026-05-13T22:00:00.000Z"),
      emptyMessage: null,
    });
    trackedMessageMock.refreshFwaMatchChecklistMessage.mockResolvedValueOnce(true);

    await handleFwaMatchChecklistRefreshButton(interaction);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(
      fwaChecklistRenderStateMock.buildFwaMatchChecklistRenderStateForGuild,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Bases",
      }),
    );
    expect(
      trackedMessageMock.refreshFwaMatchChecklistMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: "message-1" }),
      null,
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            compactCopyLine: expect.stringContaining("Bases not checked"),
          }),
        ],
        scopeKey: "fwa_match_bases|guild=guild-1|clan=all|rows=ctx-rr",
        expiresAt: new Date("2026-05-13T22:00:00.000Z"),
      }),
    );
    expect(edit.mock.calls[0]?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.label).toBe(
      "Refreshing...",
    );
    expect(edit.mock.calls.at(-1)?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.label).toBe(
      "Refresh",
    );
    expect(followUp).not.toHaveBeenCalled();
  });

  it("returns a clear failure response when a checklist refresh can no longer be applied", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const edit = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "fwa-match-checklist-refresh",
      guildId: "guild-1",
      deferUpdate,
      followUp,
      message: {
        id: "message-1",
        edit,
        reactions: {
          cache: {
            values: () => [].values(),
          },
        },
      },
    } as any;

    trackedMessageMock.refreshFwaMatchChecklistMessage.mockResolvedValueOnce(false);
    trackedMessageMock.getActiveByMessageId.mockResolvedValueOnce({
      status: "EXPIRED",
    });

    await handleFwaMatchChecklistRefreshButton(interaction);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls.at(-1)?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.label).toBe(
      "Expired",
    );
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: "This checklist post can no longer be refreshed.",
      }),
    );
  });

  it("restores the refresh button after a transient refresh error", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const edit = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "fwa-match-checklist-refresh",
      guildId: "guild-1",
      deferUpdate,
      followUp,
      client: {} as any,
      message: {
        id: "message-1",
        edit,
        reactions: {
          cache: {
            values: () => [].values(),
          },
        },
      },
    } as any;

    fwaChecklistRenderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockRejectedValueOnce(
      new Error("temporary render failure"),
    );
    trackedMessageMock.getActiveByMessageId.mockResolvedValueOnce({
      status: "ACTIVE",
    });

    await handleFwaMatchChecklistRefreshButton(interaction);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.label).toBe(
      "Refreshing...",
    );
    expect(edit.mock.calls.at(-1)?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.label).toBe(
      "Refresh",
    );
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: "This checklist post can no longer be refreshed.",
      }),
    );
  });

  it("warns and continues when pinning a public checklist fails", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const pin = vi.fn().mockRejectedValue({ code: 50013 });
    const followUp = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const fetchReply = vi.fn().mockResolvedValue({ id: "message-1", react, pin });
    const interaction = {
      guildId: "guild-1",
      channelId: "channel-1",
      user: { id: "user-1" },
      editReply,
      fetchReply,
      followUp,
    } as any;

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await postFwaMatchChecklistMessage({
      interaction,
      isPublic: true,
      rows: buildRows(),
      clanTag: null,
      scopeKey: "scope-key",
      checkedClanTags: ["#PYPY"],
    });

    expect(pin).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining("Checklist pin failed"),
      }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[fwa match checklist] pin failed message=message-1"),
    );
    consoleError.mockRestore();
  });

  it("publishes a public bases checklist with reactions and tracked-message persistence", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const pin = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      guildId: "guild-1",
      channelId: "channel-1",
      user: { id: "user-1" },
      editReply: vi.fn().mockResolvedValue(undefined),
      fetchReply: vi.fn().mockResolvedValue({
        id: "message-1",
        react,
        pin,
      }),
      followUp: vi.fn().mockResolvedValue(undefined),
    } as any;

    await postFwaMatchChecklistMessage({
      interaction,
      isPublic: true,
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
          badgeEmojiId: "111",
          badgeEmojiName: "rr",
          badgeEmojiInline: "<:rr:111>",
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-13T18:00:00.000Z",
        },
      ],
      clanTag: null,
      scopeKey: "scope-key",
      checkedClanTags: [],
    });

    expect(trackedMessageMock.createFwaMatchChecklistTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: "bases_checklist",
          rows: expect.arrayContaining([
            expect.objectContaining({
              badgeEmojiInline: "<:rr:111>",
              warId: 1001,
              opponentTag: "#OPP1",
              warStartTimeIso: "2026-05-13T18:00:00.000Z",
            }),
          ]),
        }),
      }),
    );
    expect(react).toHaveBeenCalledWith("<:rr:111>");
    expect(pin).toHaveBeenCalledTimes(1);
    expect(
      trackedMessageMock.replaceOlderFwaMatchChecklistMessages,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        resolveMessageForCleanup: expect.any(Function),
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Bases Checklist"),
        components: expect.any(Array),
      }),
    );
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(payload.components?.[0]?.toJSON?.().components?.[0]?.label).toBe("Refresh");
  });

  it("publishes a mail checklist directly to a channel with reactions, pinning, and tracked kind", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const pin = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({
      id: "mail-message-1",
      react,
      pin,
    });

    const messageId = await publishFwaMatchChecklistMessageToChannel({
      viewType: "Mail",
      channel: { send },
      guildId: "guild-1",
      channelId: "checklist-channel",
      rows: buildRows(),
      clanTag: null,
      scopeKey: "scope-key",
      checkedClanTags: ["#PYPY"],
      createdByUserId: "system",
      referenceId: "sync-message-1",
      expiresAt: new Date("2026-05-13T00:30:00.000Z"),
    });

    expect(messageId).toBe("mail-message-1");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Mail Checklist"),
        embeds: [],
        components: expect.any(Array),
      }),
    );
    expect(trackedMessageMock.createFwaMatchChecklistTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "checklist-channel",
        messageId: "mail-message-1",
        referenceId: "sync-message-1",
        metadata: expect.objectContaining({
          kind: "mail_checklist",
          checkedClanTags: ["#PYPY"],
        }),
      }),
    );
    expect(react).toHaveBeenCalledWith("<:rr:111>");
    expect(react).toHaveBeenCalledWith("<:twc:222>");
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it("publishes a bases checklist directly to a channel with reactions, pinning, and tracked kind", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const pin = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({
      id: "bases-message-1",
      react,
      pin,
    });
    const rows = [
      {
        clanTag: "#PYPY",
        compactCopyLine: "Alpha | ⚫ | ❌ Bases not checked",
        badgeEmojiId: "111",
        badgeEmojiName: "rr",
        badgeEmojiInline: "<:rr:111>",
        warId: 1001,
        opponentTag: "#OPP1",
        warStartTimeIso: "2026-05-13T18:00:00.000Z",
      },
    ];

    const messageId = await publishFwaMatchChecklistMessageToChannel({
      viewType: "Bases",
      channel: { send },
      guildId: "guild-1",
      channelId: "checklist-channel",
      rows,
      clanTag: null,
      scopeKey: "bases-scope-key",
      checkedClanTags: [],
      createdByUserId: "system",
      referenceId: "sync-message-1",
      expiresAt: new Date("2026-05-13T00:30:00.000Z"),
    });

    expect(messageId).toBe("bases-message-1");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("# Clan Bases Checklist"),
        embeds: [],
        components: expect.any(Array),
      }),
    );
    expect(trackedMessageMock.createFwaMatchChecklistTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "checklist-channel",
        messageId: "bases-message-1",
        referenceId: "sync-message-1",
        metadata: expect.objectContaining({
          kind: "bases_checklist",
          rows: expect.arrayContaining([
            expect.objectContaining({
              badgeEmojiInline: "<:rr:111>",
              warId: 1001,
            }),
          ]),
        }),
      }),
    );
    expect(react).toHaveBeenCalledWith("<:rr:111>");
    expect(pin).toHaveBeenCalledTimes(1);
  });
});
