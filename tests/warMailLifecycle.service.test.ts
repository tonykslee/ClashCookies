import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { prisma } from "../src/prisma";
import { WarMailLifecycleService } from "../src/services/WarMailLifecycleService";

function buildClient(params: {
  channelResult?: unknown;
  channelError?: unknown;
  messageResult?: unknown;
  messageError?: unknown;
}): Client {
  const fetchMessage = vi.fn();
  if (params.messageError) {
    fetchMessage.mockRejectedValue(params.messageError);
  } else {
    fetchMessage.mockResolvedValue(params.messageResult ?? { id: "456" });
  }

  const channelObject = {
    isTextBased: () => true,
    messages: {
      fetch: fetchMessage,
    },
  };

  const fetchChannel = vi.fn();
  if (params.channelError) {
    fetchChannel.mockRejectedValue(params.channelError);
  } else {
    fetchChannel.mockResolvedValue(params.channelResult ?? channelObject);
  }

  return {
    channels: {
      fetch: fetchChannel,
    },
  } as unknown as Client;
}

describe("WarMailLifecycleService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not_posted when no lifecycle row exists for current war", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValueOnce(null as never);
    const service = new WarMailLifecycleService();

    const result = await service.resolveStatusForCurrentWar({
      client: buildClient({}),
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      sentEmoji: "S",
      unsentEmoji: "U",
    });

    expect(result.status).toBe("not_posted");
    expect(result.mailStatusEmoji).toBe("U");
    expect(result.debug.winningSource).toBe("none");
  });

  it("returns posted when lifecycle row exists and message resolves", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      status: "POSTED",
      messageId: "456",
      channelId: "123",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const service = new WarMailLifecycleService();

    const result = await service.resolveStatusForCurrentWar({
      client: buildClient({}),
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      sentEmoji: "S",
      unsentEmoji: "U",
    });

    expect(result.status).toBe("posted");
    expect(result.mailStatusEmoji).toBe("S");
    expect(result.debug.reconciliationOutcome).toBe("exists");
  });

  it("marks lifecycle deleted when tracked message is definitively missing", async () => {
    const findSpy = vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      status: "POSTED",
      messageId: "456",
      channelId: "123",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const updateManySpy = vi
      .spyOn(prisma.warMailLifecycle, "updateMany")
      .mockResolvedValueOnce({ count: 1 } as never);
    const service = new WarMailLifecycleService();

    const result = await service.resolveStatusForCurrentWar({
      client: buildClient({
        messageError: { code: 10008, message: "Unknown Message" },
      }),
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      sentEmoji: "S",
      unsentEmoji: "U",
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(updateManySpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("deleted");
    expect(result.debug.trackingCleared).toBe(true);
    expect(result.debug.reconciliationOutcome).toBe("message_missing_confirmed");
  });

  it("keeps lifecycle posted on channel-inaccessible failures", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      status: "POSTED",
      messageId: "456",
      channelId: "123",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const updateManySpy = vi.spyOn(prisma.warMailLifecycle, "updateMany");
    const service = new WarMailLifecycleService();

    const result = await service.resolveStatusForCurrentWar({
      client: buildClient({
        channelError: { code: 50001, message: "Missing Access" },
      }),
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      sentEmoji: "S",
      unsentEmoji: "U",
    });

    expect(updateManySpy).not.toHaveBeenCalled();
    expect(result.status).toBe("posted");
    expect(result.debug.reconciliationOutcome).toBe("channel_inaccessible");
  });
});

