import { EmbedBuilder } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "../src/services/SettingsService";
import { trackedMessageService } from "../src/services/TrackedMessageService";
import {
  scheduledSyncReadinessPublisherService,
  syncTimePostPublisherService,
} from "../src/services/SyncTimePostPublisherService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/helper/syncBadgeEmoji", () => ({
  findSyncBadgeEmojiForClan: vi.fn(() => null),
  getSyncBadgeEmojis: vi.fn(() => [
    { code: "RR", label: "Rocky Road", name: "rr", id: "111" },
  ]),
}));

vi.mock("../src/services/SyncTimeFwaClanListViewService", async () => {
  const actual = await vi.importActual<any>(
    "../src/services/SyncTimeFwaClanListViewService",
  );
  return {
    ...actual,
    buildSyncReadinessMessagePayload: vi.fn(),
  };
});

describe("SyncTimePostPublisherService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#RR",
        name: "Rocky Road",
        clanBadge: "<:rr:111>",
        shortName: "RR",
      },
    ]);
    vi.spyOn(SettingsService.prototype, "set").mockResolvedValue(undefined);
    vi.spyOn(trackedMessageService, "createSyncTimeTrackedMessage").mockResolvedValue(undefined);
    vi.spyOn(
      trackedMessageService,
      "replacePriorSyncReadinessTrackedMessagesForGuildAndCreate",
    ).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes the immediate sync announcement and owns the active sync tracked row", async () => {
    const pinnedMessage = {
      id: "old-pinned-1",
      channelId: "channel-1",
      author: { bot: true },
      content: "# Sync time :gem: <t:1718501400:F> (<t:1718501400:R>)",
      unpin: vi.fn().mockResolvedValue(undefined),
    };
    const message = {
      id: "message-1",
      channelId: "channel-1",
      react: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
      unpin: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      id: "channel-1",
      isTextBased: () => true,
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
      messages: {
        fetch: vi.fn(),
        fetchPinned: vi.fn().mockResolvedValue(new Map([["old", pinnedMessage]])),
      },
      send: vi.fn().mockResolvedValue(message),
    };

    const result = await syncTimePostPublisherService.publishImmediateSyncTimePost({
      guild: {
        id: "guild-1",
        client: { user: { id: "bot-1" } },
        members: { me: { id: "bot-1" } },
      } as any,
      channel: channel as any,
      role: { id: "role-1", name: "War", mentionable: true },
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      createdByUserId: "user-1",
      settings: new SettingsService(),
      clientUserId: "bot-1",
      now: new Date("2026-06-15T23:00:00.000Z"),
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("# Sync time :gem:"),
        allowedMentions: { roles: ["role-1"] },
      }),
    );
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledTimes(1);
    expect(SettingsService.prototype.set).toHaveBeenCalledTimes(1);
    const trackedOrder = trackedMessageService.createSyncTimeTrackedMessage.mock
      .invocationCallOrder[0] as number;
    const settingsOrder = SettingsService.prototype.set.mock.invocationCallOrder[0] as number;
    const firstReactOrder = message.react.mock.invocationCallOrder[0] as number;
    expect(trackedOrder).toBeLessThan(settingsOrder);
    expect(settingsOrder).toBeLessThan(firstReactOrder);
    expect(message.react).toHaveBeenCalledWith("rr:111");
    expect(message.react).toHaveBeenCalledWith("\u{1F4A4}");
    expect(pinnedMessage.unpin).toHaveBeenCalledTimes(1);
    expect(message.pin).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "success",
      channelId: "channel-1",
      messageLink: "https://discord.com/channels/guild-1/channel-1/message-1",
      messageId: "message-1",
      trackedClanCount: 1,
      sentNewMessage: true,
      totalBadgeReactions: 1,
      successfulBadgeReactions: 1,
      badgeReactionCount: 1,
      badgeReactionsSucceeded: 1,
      unavailableReactionSucceeded: true,
      activeSettingsPointerSucceeded: true,
      pinSucceeded: true,
      trackedMessageCreated: true,
    });
  });

  it("attempts to delete the announcement when the authoritative tracked row cannot be written", async () => {
    vi.spyOn(trackedMessageService, "createSyncTimeTrackedMessage").mockRejectedValueOnce(
      new Error("tracked row boom"),
    );
    const message = {
      id: "message-2",
      channelId: "channel-1",
      react: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
      unpin: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      id: "channel-1",
      isTextBased: () => true,
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
      messages: {
        fetch: vi.fn(),
        fetchPinned: vi.fn().mockResolvedValue(new Map()),
      },
      send: vi.fn().mockResolvedValue(message),
    };

    const result = await syncTimePostPublisherService.publishImmediateSyncTimePost({
      guild: {
        id: "guild-1",
        client: { user: { id: "bot-1" } },
        members: { me: { id: "bot-1" } },
      } as any,
      channel: channel as any,
      role: { id: "role-1", name: "War", mentionable: true },
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      createdByUserId: "user-1",
      settings: new SettingsService(),
      clientUserId: "bot-1",
      now: new Date("2026-06-15T23:00:00.000Z"),
    });

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(message.react).not.toHaveBeenCalled();
    expect(SettingsService.prototype.set).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "partial_failure",
      trackedMessageCreated: false,
      rollbackAttempted: true,
      rollbackSucceeded: true,
      partialFailureReason: "tracked_message_failed",
      partialFailureMessage: expect.stringContaining("rolled back"),
    });
  });

  it("reports an explicit partial failure with a message link when rollback cleanup also fails", async () => {
    vi.spyOn(trackedMessageService, "createSyncTimeTrackedMessage").mockRejectedValueOnce(
      new Error("tracked row boom"),
    );
    const message = {
      id: "message-3",
      channelId: "channel-1",
      react: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockRejectedValue(new Error("delete boom")),
      pin: vi.fn().mockResolvedValue(undefined),
      unpin: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      id: "channel-1",
      isTextBased: () => true,
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
      messages: {
        fetch: vi.fn(),
        fetchPinned: vi.fn().mockResolvedValue(new Map()),
      },
      send: vi.fn().mockResolvedValue(message),
    };

    const result = await syncTimePostPublisherService.publishImmediateSyncTimePost({
      guild: {
        id: "guild-1",
        client: { user: { id: "bot-1" } },
        members: { me: { id: "bot-1" } },
      } as any,
      channel: channel as any,
      role: { id: "role-1", name: "War", mentionable: true },
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      createdByUserId: "user-1",
      settings: new SettingsService(),
      clientUserId: "bot-1",
      now: new Date("2026-06-15T23:00:00.000Z"),
    });

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "partial_failure",
      trackedMessageCreated: false,
      rollbackAttempted: true,
      rollbackSucceeded: false,
      partialFailureReason: "tracked_message_failed_and_delete_failed",
      messageLink: "https://discord.com/channels/guild-1/channel-1/message-3",
    });
    expect(result.partialFailureMessage).toContain("visible untracked message may remain");
  });

  it("keeps the tracked announcement functional when the compatibility settings pointer cannot be saved", async () => {
    vi.spyOn(SettingsService.prototype, "set").mockRejectedValueOnce(new Error("settings boom"));
    const message = {
      id: "message-4",
      channelId: "channel-1",
      react: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
      unpin: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      id: "channel-1",
      isTextBased: () => true,
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
      messages: {
        fetch: vi.fn(),
        fetchPinned: vi.fn().mockResolvedValue(new Map()),
      },
      send: vi.fn().mockResolvedValue(message),
    };

    const result = await syncTimePostPublisherService.publishImmediateSyncTimePost({
      guild: {
        id: "guild-1",
        client: { user: { id: "bot-1" } },
        members: { me: { id: "bot-1" } },
      } as any,
      channel: channel as any,
      role: { id: "role-1", name: "War", mentionable: true },
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      createdByUserId: "user-1",
      settings: new SettingsService(),
      clientUserId: "bot-1",
      now: new Date("2026-06-15T23:00:00.000Z"),
    });

    expect(message.react).toHaveBeenCalledTimes(2);
    expect(message.pin).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "success",
      activeSettingsPointerSucceeded: false,
      trackedMessageCreated: true,
      totalBadgeReactions: 1,
      successfulBadgeReactions: 1,
      unavailableReactionSucceeded: true,
      pinSucceeded: true,
    });
  });

  it("publishes the scheduled readiness dashboard without sync reactions or pinning", async () => {
    const { buildSyncReadinessMessagePayload } = await import(
      "../src/services/SyncTimeFwaClanListViewService"
    );
    vi.mocked(buildSyncReadinessMessagePayload).mockResolvedValue({
      content: "# FWA readiness",
      embeds: [new EmbedBuilder().setTitle("FWA Readiness (1)")],
      components: [],
      metadata: {
        readinessEnabled: true,
        createdAtIso: "2026-06-15T23:00:00.000Z",
        refreshExpiresAtIso: "2026-06-16T01:30:00.000Z",
      },
      trackedClanCount: 1,
    });

    const message = {
      id: "readiness-1",
      channelId: "channel-1",
      react: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
      unpin: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      id: "channel-1",
      isTextBased: () => true,
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
      messages: {
        fetch: vi.fn(),
        fetchPinned: vi.fn().mockResolvedValue(new Map()),
      },
      send: vi.fn().mockResolvedValue(message),
    };
    const markPublishedMessageId = vi.fn().mockResolvedValue({});
    const markPublished = vi.fn().mockResolvedValue({});

    const result = await scheduledSyncReadinessPublisherService.publishScheduledSyncReadinessPost({
      guild: {
        id: "guild-1",
        client: { user: { id: "bot-1" } },
        members: { me: { id: "bot-1" } },
      } as any,
      channel: channel as any,
      schedule: {
        id: "schedule-1",
        channelId: "channel-1",
        guildId: "guild-1",
        roleId: "role-1",
        syncTime: new Date("2026-06-16T01:30:00.000Z"),
        publishAt: new Date("2026-06-15T23:30:00.000Z"),
        publishedMessageId: null,
        claimToken: "claim-token-1",
      },
      claimToken: "claim-token-1",
      publicationMode: "scheduled",
      scheduleService: {
        verifyClaimOwnership: vi.fn().mockResolvedValue({
          owned: true,
          reason: "owned",
          schedule: {
            id: "schedule-1",
            channelId: "channel-1",
            guildId: "guild-1",
            roleId: "role-1",
            syncTime: new Date("2026-06-16T01:30:00.000Z"),
            publishAt: new Date("2026-06-15T23:30:00.000Z"),
            publishedMessageId: null,
            claimToken: "claim-token-1",
          },
        }),
        markPublishedMessageId,
        markPublished,
      },
      now: new Date("2026-06-15T23:00:00.000Z"),
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        content: "# FWA readiness",
        allowedMentions: { parse: [] },
      }),
    );
    expect(message.react).not.toHaveBeenCalled();
    expect(message.pin).not.toHaveBeenCalled();
    expect(SettingsService.prototype.set).not.toHaveBeenCalled();
    expect(trackedMessageService.createSyncTimeTrackedMessage).not.toHaveBeenCalled();
    expect(
      trackedMessageService.replacePriorSyncReadinessTrackedMessagesForGuildAndCreate,
    ).toHaveBeenCalledTimes(1);
    expect(markPublishedMessageId).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      channelId: "channel-1",
      messageId: "readiness-1",
      trackedClanCount: 1,
      publicationMode: "scheduled",
    });
  });

  it("reuses an already published readiness message without sending a duplicate", async () => {
    const { buildSyncReadinessMessagePayload } = await import(
      "../src/services/SyncTimeFwaClanListViewService"
    );
    vi.mocked(buildSyncReadinessMessagePayload).mockResolvedValue({
      content: "# FWA readiness",
      embeds: [new EmbedBuilder().setTitle("FWA Readiness (1)")],
      components: [],
      metadata: {
        readinessEnabled: true,
        createdAtIso: "2026-06-15T23:00:00.000Z",
        refreshExpiresAtIso: "2026-06-16T01:30:00.000Z",
      },
      trackedClanCount: 1,
    });

    const message = {
      id: "readiness-1",
      channelId: "channel-1",
      react: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
      unpin: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      id: "channel-1",
      isTextBased: () => true,
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
      messages: {
        fetch: vi.fn().mockResolvedValue(message),
        fetchPinned: vi.fn().mockResolvedValue(new Map()),
      },
      send: vi.fn(),
    };
    const markPublishedMessageId = vi.fn().mockResolvedValue({});
    const markPublished = vi.fn().mockResolvedValue({});

    const result = await scheduledSyncReadinessPublisherService.publishScheduledSyncReadinessPost({
      guild: {
        id: "guild-1",
        client: { user: { id: "bot-1" } },
        members: { me: { id: "bot-1" } },
      } as any,
      channel: channel as any,
      schedule: {
        id: "schedule-1",
        channelId: "channel-1",
        guildId: "guild-1",
        roleId: "role-1",
        syncTime: new Date("2026-06-16T01:30:00.000Z"),
        publishAt: new Date("2026-06-15T23:30:00.000Z"),
        publishedMessageId: "readiness-1",
        claimToken: "claim-token-1",
      },
      claimToken: "claim-token-1",
      publicationMode: "immediate",
      scheduleService: {
        verifyClaimOwnership: vi.fn().mockResolvedValue({
          owned: true,
          reason: "owned",
          schedule: {
            id: "schedule-1",
            channelId: "channel-1",
            guildId: "guild-1",
            roleId: "role-1",
            syncTime: new Date("2026-06-16T01:30:00.000Z"),
            publishAt: new Date("2026-06-15T23:30:00.000Z"),
            publishedMessageId: "readiness-1",
            claimToken: "claim-token-1",
          },
        }),
        markPublishedMessageId,
        markPublished,
      },
      now: new Date("2026-06-15T23:00:00.000Z"),
    });

    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.messages.fetch).toHaveBeenCalledWith("readiness-1");
    expect(markPublishedMessageId).not.toHaveBeenCalled();
    expect(markPublished).toHaveBeenCalledTimes(1);
    expect(result.sentNewMessage).toBe(false);
    expect(result.messageId).toBe("readiness-1");
  });
});
