import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LayoutPostPublicationService,
} from "../src/services/LayoutPostPublicationService";
import { LayoutDiscordPostAlreadyBoundError } from "../src/services/LayoutService";

const LINK =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD18";

function buildLayout(overrides: Record<string, unknown> = {}) {
  return {
    id: "layout-1",
    layoutLink: LINK,
    title: null,
    description: null,
    imageUrl: null,
    postedByDiscordUserId: null,
    discordGuildId: null,
    discordChannelId: null,
    discordMessageId: null,
    submittedAt: null,
    lastConfirmedAt: null,
    lastConfirmedByDiscordUserId: null,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
    ...overrides,
  };
}

describe("LayoutPostPublicationService", () => {
  const layoutService = {
    attachDiscordPost: vi.fn(),
    findById: vi.fn(),
  };
  const send = vi.fn();
  let service: LayoutPostPublicationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LayoutPostPublicationService({ layoutService });
  });

  it("reuses an existing canonical provenance without sending another post", async () => {
    const layout = buildLayout({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "message-1",
    });

    const result = await service.publish({
      layout: layout as any,
      guildId: "guild-1",
      channel: { id: "channel-1", send },
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.jumpUrl).toBe(
      "https://discord.com/channels/guild-1/channel-1/message-1",
    );
  });

  it("sends and binds an unposted record without changing lifecycle state", async () => {
    const layout = buildLayout();
    const message = { id: "message-1", delete: vi.fn().mockResolvedValue(undefined) };
    const attached = buildLayout({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "message-1",
    });
    send.mockResolvedValue(message);
    layoutService.attachDiscordPost.mockResolvedValue(attached);

    const result = await service.publish({
      layout: layout as any,
      guildId: "guild-1",
      channel: { id: "channel-1", send },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(layoutService.attachDiscordPost).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "layout-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
      }),
    );
    expect(message.delete).not.toHaveBeenCalled();
    expect(result.messageId).toBe("message-1");
  });

  it("deletes a losing duplicate and returns the winning canonical post", async () => {
    const layout = buildLayout();
    const message = { id: "losing-message", delete: vi.fn().mockResolvedValue(undefined) };
    const winner = buildLayout({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "winning-message",
    });
    send.mockResolvedValue(message);
    layoutService.attachDiscordPost.mockRejectedValue(
      new LayoutDiscordPostAlreadyBoundError(layout.id),
    );
    layoutService.findById.mockResolvedValue(winner);

    const result = await service.publish({
      layout: layout as any,
      guildId: "guild-1",
      channel: { id: "channel-1", send },
    });

    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("winning-message");
    expect(result.jumpUrl).toContain("winning-message");
  });
});
