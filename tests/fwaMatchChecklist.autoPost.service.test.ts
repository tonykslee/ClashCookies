import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findMany: vi.fn(),
  },
}));

const botLogChannelServiceMock = vi.hoisted(() => ({
  getChannelIdForType: vi.fn(),
  clearChannelIdForType: vi.fn(),
}));

const renderStateMock = vi.hoisted(() => ({
  buildFwaMatchChecklistRenderStateForGuild: vi.fn(),
}));

const publishMock = vi.hoisted(() => ({
  publishFwaMatchChecklistMessageToChannel: vi.fn(),
}));

const SYNC_EPOCH_SECONDS = Math.floor(
  new Date("2026-05-13T00:00:00.000Z").getTime() / 1000,
);
const SYNC_FALLBACK_EXPIRES_AT = new Date(
  (SYNC_EPOCH_SECONDS * 1000) + 48 * 60 * 60 * 1000,
);

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/BotLogChannelService", () => ({
  BotLogChannelService: vi.fn().mockImplementation(() => botLogChannelServiceMock),
}));

vi.mock("../src/services/CoCService", () => ({
  CoCService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/services/FwaMatchChecklistStateService", () => ({
  buildFwaMatchChecklistRenderStateForGuild:
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild,
}));

vi.mock("../src/services/FwaMatchChecklistService", () => ({
  publishFwaMatchChecklistMessageToChannel:
    publishMock.publishFwaMatchChecklistMessageToChannel,
}));

import { FwaMatchChecklistAutoPostService } from "../src/services/fwa/matchChecklistAutoPostService";
import { trackedMessageService } from "../src/services/TrackedMessageService";

function makeClient(input?: {
  channel?: unknown | null;
  fetchError?: unknown;
}) {
  const fetch = input?.fetchError
    ? vi.fn().mockRejectedValue(input.fetchError)
    : vi.fn().mockResolvedValue(input?.channel ?? null);
  return {
    guilds: {
      fetch: vi.fn().mockResolvedValue({
        id: "guild-1",
        channels: {
          fetch,
        },
      }),
    },
  } as any;
}

function makeChecklistChannel() {
  return {
    id: "checklist-channel",
    type: ChannelType.GuildText,
    isTextBased: () => true,
    send: vi.fn(),
  };
}

describe("FwaMatchChecklistAutoPostService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    botLogChannelServiceMock.getChannelIdForType.mockResolvedValue("checklist-channel");
    botLogChannelServiceMock.clearChannelIdForType.mockResolvedValue(undefined);
    publishMock.publishFwaMatchChecklistMessageToChannel.mockResolvedValue({
      messageId: "posted-message",
      sent: true,
      finalized: true,
    });
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockImplementation(
      async ({
        viewType,
        fallbackExpiresAt,
      }: {
        viewType?: "Mail" | "Bases";
        fallbackExpiresAt?: Date | null;
      }) => ({
        viewType: viewType ?? "Mail",
        rows: [
          {
            clanTag: "#PYPY",
            compactCopyLine:
              (viewType ?? "Mail") === "Bases"
                ? "Alpha | ⚫ | ❌ Bases not checked"
                : "📬 | 🟢 | Alpha vs `Bravo` (`#B1`)",
            badgeEmojiId: "111",
            badgeEmojiName: "rr",
            badgeEmojiInline: "<:rr:111>",
          },
        ],
        scopeKey: `${viewType ?? "Mail"}-scope`,
        checkedClanTags: [],
        referenceId: "sync-message-1",
        expiresAt:
          fallbackExpiresAt ?? new Date("2026-05-13T00:30:00.000Z"),
        emptyMessage: null,
      }),
    );
    vi.spyOn(trackedMessageService, "claimFwaMatchChecklistPublication").mockResolvedValue({
      claimed: true,
      claimKey: "claim-key",
      sourceTrackedMessageId: "source-tracked-message-id",
    });
    vi.spyOn(
      trackedMessageService,
      "findFwaMatchChecklistPublicationBySyncReference",
    ).mockResolvedValue(null);
    vi.spyOn(
      trackedMessageService,
      "releaseFwaMatchChecklistPublicationClaim",
    ).mockResolvedValue(true);
  });

  it("posts only the Mail checklist when requested", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        expiresAt: new Date("2026-05-13T01:00:00.000Z"),
      },
      createdByUserId: "user-1",
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(botLogChannelServiceMock.getChannelIdForType).toHaveBeenCalledWith(
      "guild-1",
      "checklist",
    );
    expect(cocFactory).toHaveBeenCalledTimes(1);
    expect(renderStateMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "guild-1", viewType: "Mail" }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Mail",
        channel,
        guildId: "guild-1",
        channelId: "checklist-channel",
        referenceId: "sync-message-1",
      }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledTimes(1);
  });

  it("uses a sync-based fallback expiry when war timing is still unknown", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        fallbackExpiresAt: SYNC_FALLBACK_EXPIRES_AT,
      },
      createdByUserId: "user-1",
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(renderStateMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        viewType: "Mail",
        fallbackExpiresAt: SYNC_FALLBACK_EXPIRES_AT,
      }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Mail",
        referenceId: "sync-message-1",
        expiresAt: SYNC_FALLBACK_EXPIRES_AT,
      }),
    );
  });

  it("preserves a known war-end expiry when render state already knows it", async () => {
    const knownWarEnd = new Date("2026-05-14T22:00:00.000Z");
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValueOnce({
      viewType: "Bases",
      rows: [
        {
          clanTag: "#PYPY",
          compactCopyLine: "Alpha | âš« | âŒ Bases not checked",
          badgeEmojiId: "111",
          badgeEmojiName: "rr",
          badgeEmojiInline: "<:rr:111>",
        },
      ],
      scopeKey: "Bases-scope",
      checkedClanTags: [],
      referenceId: "sync-message-1",
      expiresAt: knownWarEnd,
      emptyMessage: null,
    });

    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        fallbackExpiresAt: SYNC_FALLBACK_EXPIRES_AT,
      },
      createdByUserId: "user-1",
      viewType: "Bases",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Bases",
        referenceId: "sync-message-1",
        expiresAt: knownWarEnd,
      }),
    );
  });

  it("posts only the Bases checklist when requested", async () => {
    const channel = makeChecklistChannel();
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
        expiresAt: new Date("2026-05-13T01:00:00.000Z"),
      },
      createdByUserId: "user-1",
      viewType: "Bases",
    });

    expect(result).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(cocFactory).toHaveBeenCalledTimes(1);
    expect(renderStateMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "guild-1", viewType: "Bases" }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Bases",
        channel,
        guildId: "guild-1",
        channelId: "checklist-channel",
        referenceId: "sync-message-1",
      }),
    );
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledTimes(1);
  });

  it("skips without throwing when no checklist channel is configured", async () => {
    botLogChannelServiceMock.getChannelIdForType.mockResolvedValue(null);
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(cocFactory).not.toHaveBeenCalled();
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
  });

  it("clears only checklist config when the configured channel is missing", async () => {
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: null }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(cocFactory).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.clearChannelIdForType).toHaveBeenCalledWith(
      "guild-1",
      "checklist",
    );
    expect(botLogChannelServiceMock.clearChannelIdForType).not.toHaveBeenCalledWith(
      "guild-1",
      "sync",
    );
  });

  it("does not clear config when the configured channel is inaccessible", async () => {
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ fetchError: { code: 50013 } }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Bases",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(cocFactory).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.clearChannelIdForType).not.toHaveBeenCalled();
  });

  it("does not duplicate the Mail checklist for the same sync identity", async () => {
    vi.mocked(trackedMessageService.claimFwaMatchChecklistPublication).mockResolvedValueOnce({
      claimed: false,
      claimKey: "claim-key",
      sourceTrackedMessageId: "source-tracked-message-id",
    });
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    const client = makeClient({ channel: makeChecklistChannel() });

    const result = await service.postForSyncTrackedMessage({
      client,
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(client.guilds.fetch).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.getChannelIdForType).not.toHaveBeenCalled();
    expect(cocFactory).not.toHaveBeenCalled();
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
  });

  it("does not duplicate the Bases checklist for the same sync identity", async () => {
    vi.mocked(trackedMessageService.claimFwaMatchChecklistPublication).mockResolvedValueOnce({
      claimed: false,
      claimKey: "claim-key",
      sourceTrackedMessageId: "source-tracked-message-id",
    });
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);
    const client = makeClient({ channel: makeChecklistChannel() });

    const result = await service.postForSyncTrackedMessage({
      client,
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Bases",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(client.guilds.fetch).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.getChannelIdForType).not.toHaveBeenCalled();
    expect(cocFactory).not.toHaveBeenCalled();
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
  });

  it("skips when an existing checklist row is already stored for the same source sync and kind", async () => {
    vi.mocked(
      trackedMessageService.findFwaMatchChecklistPublicationBySyncReference,
    ).mockResolvedValueOnce({
      id: "tracked-checklist-1",
      messageId: "message-1",
      referenceId: "sync-message-1",
      status: "ACTIVE",
      metadata: {
        kind: "mail_checklist",
      },
    } as any);
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).not.toHaveBeenCalled();
  });

  it("blocks reposting when the prior checklist row was deleted", async () => {
    vi.mocked(
      trackedMessageService.findFwaMatchChecklistPublicationBySyncReference,
    ).mockResolvedValueOnce({
      id: "tracked-checklist-1",
      messageId: "deleted-message-1",
      referenceId: "sync-message-1",
      status: "DELETED",
      metadata: {
        kind: "mail_checklist",
      },
    } as any);
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).not.toHaveBeenCalled();
  });

  it("releases the claim when Discord send fails before persistence", async () => {
    publishMock.publishFwaMatchChecklistMessageToChannel.mockResolvedValueOnce({
      messageId: null,
      sent: false,
      finalized: false,
    });
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).toHaveBeenCalledWith({
      sourceTrackedMessageId: "source-tracked-message-id",
      claimKey: "claim-key",
    });
  });

  it("retains the claim when send succeeds but persistence fails", async () => {
    publishMock.publishFwaMatchChecklistMessageToChannel.mockResolvedValueOnce({
      messageId: "posted-message",
      sent: true,
      finalized: false,
    });
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).not.toHaveBeenCalled();
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when checklist rendering fails before send", async () => {
    renderStateMock.buildFwaMatchChecklistRenderStateForGuild.mockRejectedValueOnce(
      new Error("COC_QUEUE_CONTEXT_MISSING:getCurrentWar"),
    );
    const cocFactory = vi.fn(() => ({} as any));
    const service = new FwaMatchChecklistAutoPostService(undefined, cocFactory);

    const result = await service.postForSyncTrackedMessage({
      client: makeClient({ channel: makeChecklistChannel() }),
      tracked: {
        guildId: "guild-1",
        channelId: "source-channel",
        messageId: "sync-message-1",
      },
      viewType: "Mail",
    });

    expect(result).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(trackedMessageService.releaseFwaMatchChecklistPublicationClaim).toHaveBeenCalledWith({
      sourceTrackedMessageId: "source-tracked-message-id",
      claimKey: "claim-key",
    });
    expect(publishMock.publishFwaMatchChecklistMessageToChannel).not.toHaveBeenCalled();
  });

  it("can import the singleton without constructing the real CoC service", async () => {
    vi.resetModules();
    vi.doUnmock("../src/services/CoCService");
    const originalToken = process.env.COC_API_TOKEN;
    delete process.env.COC_API_TOKEN;
    try {
      await expect(
        import("../src/services/fwa/matchChecklistAutoPostService"),
      ).resolves.toHaveProperty("fwaMatchChecklistAutoPostService");
    } finally {
      if (originalToken === undefined) {
        delete process.env.COC_API_TOKEN;
      } else {
        process.env.COC_API_TOKEN = originalToken;
      }
    }
  });
});
