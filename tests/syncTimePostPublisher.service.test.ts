import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import { SettingsService } from "../src/services/SettingsService";
import { trackedMessageService } from "../src/services/TrackedMessageService";
import { syncTimePostPublisherService } from "../src/services/SyncTimePostPublisherService";

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
    buildSyncTimeFwaClanListMessagePayload: vi.fn(),
  };
});

describe("SyncTimePostPublisherService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    vi.spyOn(SettingsService.prototype, "set").mockResolvedValue(undefined);
    vi.spyOn(trackedMessageService, "createSyncTimeTrackedMessage").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to plain sync content when readiness rendering fails", async () => {
    const { buildSyncTimeFwaClanListMessagePayload } = await import(
      "../src/services/SyncTimeFwaClanListViewService"
    );
    vi.mocked(buildSyncTimeFwaClanListMessagePayload).mockRejectedValue(new Error("boom"));

    const message = {
      id: "message-1",
      channelId: "channel-1",
      react: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
      unpin: vi.fn().mockResolvedValue(undefined),
    };
    const markPublishedMessageId = vi.fn().mockResolvedValue({});
    const markPublished = vi.fn().mockResolvedValue({});
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
    const result = await syncTimePostPublisherService.publishScheduledSyncTimePost({
      guild: {
        id: "guild-1",
        client: { user: { id: "bot-1" } },
        members: { me: { id: "bot-1" } },
      } as any,
      channel: channel as any,
      role: { id: "role-1", name: "War", mentionable: true },
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
      scheduleService: {
        markPublishedMessageId,
        markPublished,
      },
      now: new Date("2026-06-15T23:00:00.000Z"),
      settings: new SettingsService(),
      clientUserId: "bot-1",
    });

    const syncEpochSeconds = Math.floor(new Date("2026-06-16T01:30:00.000Z").getTime() / 1000);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(message.react).toHaveBeenCalled();
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledTimes(1);
    expect(result.usedFallbackRender).toBe(true);
    expect(result.sentNewMessage).toBe(true);
    expect(markPublishedMessageId).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(`# Sync time :gem:`),
        embeds: [],
        components: [],
      }),
    );
    expect(channel.send.mock.calls[0]?.[0].content).toContain(
      `<t:${syncEpochSeconds}:F>`,
    );
    expect(channel.send.mock.calls[0]?.[0].content).toContain("<@&role-1>");
  });

  it("reuses an existing published message when one is already tracked", async () => {
    const { buildSyncTimeFwaClanListMessagePayload } = await import(
      "../src/services/SyncTimeFwaClanListViewService"
    );
    vi.mocked(buildSyncTimeFwaClanListMessagePayload).mockResolvedValue({
      content: "rendered",
      embeds: [new EmbedBuilder().setTitle("Readiness")],
      components: [],
      metadata: {
        syncTimeIso: "2026-06-16T01:30:00.000Z",
        syncEpochSeconds: 1718501400,
        roleId: "role-1",
        clans: [],
      },
      trackedClanCount: 0,
    });

    const message = {
      id: "message-1",
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

    const result = await syncTimePostPublisherService.publishScheduledSyncTimePost({
      guild: {
        id: "guild-1",
        client: { user: { id: "bot-1" } },
        members: { me: { id: "bot-1" } },
      } as any,
      channel: channel as any,
      role: { id: "role-1", name: "War", mentionable: true },
      schedule: {
        id: "schedule-1",
        channelId: "channel-1",
        guildId: "guild-1",
        roleId: "role-1",
        syncTime: new Date("2026-06-16T01:30:00.000Z"),
        publishAt: new Date("2026-06-15T23:30:00.000Z"),
        publishedMessageId: "message-1",
        claimToken: "claim-token-1",
      },
      claimToken: "claim-token-1",
      scheduleService: {
        markPublishedMessageId,
        markPublished,
      },
      now: new Date("2026-06-15T23:00:00.000Z"),
      settings: new SettingsService(),
      clientUserId: "bot-1",
    });

    expect(channel.send).not.toHaveBeenCalled();
    expect(markPublishedMessageId).not.toHaveBeenCalled();
    expect(markPublished).toHaveBeenCalledTimes(1);
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledTimes(1);
    expect(result.sentNewMessage).toBe(false);
    expect(result.messageId).toBe("message-1");
  });
});
