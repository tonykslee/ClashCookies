import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordLayoutPostResolver,
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

  it("resolves an existing Discord message through the focused resolver", async () => {
    const message = {
      id: "message-1",
      delete: vi.fn(),
      edit: vi.fn(),
    };
    const fetch = vi.fn().mockResolvedValue(message);
    const resolver = createDiscordLayoutPostResolver({
      channels: { fetch: vi.fn().mockResolvedValue({ messages: { fetch } }) },
    });

    await expect(
      resolver.resolve({
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
      }),
    ).resolves.toBe(message);
    expect(fetch).toHaveBeenCalledWith("message-1");
  });

  it("reuses an existing canonical provenance without sending another post", async () => {
    const layout = buildLayout({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "message-1",
    });

    const edit = vi.fn().mockResolvedValue(undefined);
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        id: "message-1",
        delete: vi.fn().mockResolvedValue(undefined),
        edit,
        attachments: { first: vi.fn(() => undefined) },
      }),
    };
    const result = await service.publish({
      layout: layout as any,
      guildId: "guild-1",
      channel: { id: "channel-1", send },
      messageResolver: resolver,
    });

    expect(send).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(layoutService.attachDiscordPost).not.toHaveBeenCalled();
    expect(result.jumpUrl).toBe(
      "https://discord.com/channels/guild-1/channel-1/message-1",
    );
  });

  it("edits the existing canonical message when title presentation changes", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        id: "message-1",
        delete: vi.fn().mockResolvedValue(undefined),
        edit,
        attachments: { first: vi.fn(() => undefined) },
      }),
    };

    await service.publish({
      layout: buildLayout({
        title: "Updated title",
        discordGuildId: "guild-1",
        discordChannelId: "channel-1",
        discordMessageId: "message-1",
      }) as any,
      guildId: "guild-1",
      channel: { id: "channel-1", send },
      messageResolver: resolver,
    });

    const payload = edit.mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().title).toBe("Updated title");
    expect(send).not.toHaveBeenCalled();
  });

  it("edits the existing canonical message when external image presentation changes", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        id: "message-1",
        delete: vi.fn().mockResolvedValue(undefined),
        edit,
        attachments: { first: vi.fn(() => ({ name: "old.png", url: "https://cdn.example/old.png" })) },
      }),
    };

    await service.publish({
      layout: buildLayout({
        imageUrl: "https://example.com/new.png",
        discordGuildId: "guild-1",
        discordChannelId: "channel-1",
        discordMessageId: "message-1",
      }) as any,
      guildId: "guild-1",
      channel: { id: "channel-1", send },
      messageResolver: resolver,
    });

    const payload = edit.mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().image?.url).toBe("https://example.com/new.png");
    expect(send).not.toHaveBeenCalled();
  });

  it("fails instead of returning a dead jump link when the canonical message cannot be resolved", async () => {
    const resolver = { resolve: vi.fn().mockResolvedValue(null) };

    await expect(
      service.publish({
        layout: buildLayout({
          discordGuildId: "guild-1",
          discordChannelId: "channel-1",
          discordMessageId: "deleted-message",
        }) as any,
        guildId: "guild-1",
        channel: { id: "channel-1", send },
        messageResolver: resolver,
      }),
    ).rejects.toThrow("could not be resolved");
    expect(send).not.toHaveBeenCalled();
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
