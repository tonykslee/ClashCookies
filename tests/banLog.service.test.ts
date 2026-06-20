import { beforeEach, describe, expect, it, vi } from "vitest";
import { BanTargetKind } from "@prisma/client";
import { banLogService } from "../src/services/BanLogService";
import { botLogChannelService } from "../src/services/BotLogChannelService";

function makeClient() {
  const send = vi.fn().mockResolvedValue(undefined);
  const channel = { send };
  const channelId = "123456789012345678";
  const guild = {
    channels: {
      cache: new Map([[channelId, channel]]),
      fetch: vi.fn().mockResolvedValue(channel),
    },
  };
  const client = {
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: vi.fn().mockResolvedValue(guild),
    },
  };
  return { client, send };
}

describe("banLogService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts player ban logs with the shared backticked player label", async () => {
    const { client, send } = makeClient();
    vi.spyOn(botLogChannelService, "getRoutingConfigForType").mockResolvedValue({
      configured: true,
      routingMode: "CUSTOM",
      channelId: "123456789012345678",
      legacy: false,
    } as any);

    await banLogService.postBanActionLog({
      client: client as any,
      guildId: "guild-1",
      action: "created",
      actorDiscordUserId: "111111111111111111",
      record: {
        id: "ban-1",
        guildId: "guild-1",
        targetKind: BanTargetKind.PLAYER,
        playerTag: "#PYLQ0289",
        targetPlayerName: "Alpha Player",
        discordUserId: null,
        targetDiscordUsername: null,
        targetDiscordDisplayName: null,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        reason: "spam",
        bannedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
        expiresAt: null,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
        updatedAt: new Date("2026-06-08T12:00:00.000Z"),
        linkedPlayerTags: [],
      } as any,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("Ban created: PLAYER | Alpha Player `#PYLQ0289`"),
      allowedMentions: { parse: [] },
    });
    expect((send.mock.calls[0]?.[0] as any).content).toContain("Ban clan: Alpha Clan `#2QG2C08UP`");
  });

  it("posts user ban logs with the persisted username and display name snapshot", async () => {
    const { client, send } = makeClient();
    vi.spyOn(botLogChannelService, "getRoutingConfigForType").mockResolvedValue({
      configured: true,
      routingMode: "CUSTOM",
      channelId: "123456789012345678",
      legacy: false,
    } as any);

    await banLogService.postBanActionLog({
      client: client as any,
      guildId: "guild-1",
      action: "updated",
      actorDiscordUserId: "111111111111111111",
      record: {
        id: "ban-2",
        guildId: "guild-1",
        targetKind: BanTargetKind.USER,
        playerTag: null,
        discordUserId: "222222222222222222",
        targetDiscordUsername: "someuser",
        targetDiscordDisplayName: "Some Display Name",
        clanTag: null,
        clanName: null,
        reason: null,
        bannedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-06-08T12:00:00.000Z"),
        expiresAt: null,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
        updatedAt: new Date("2026-06-08T12:00:00.000Z"),
        linkedPlayerTags: [],
        targetPlayerName: null,
      } as any,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining(
        "Ban updated: USER | <@222222222222222222> | username: someuser | display: Some Display Name",
      ),
      allowedMentions: { parse: [] },
    });
  });
});
