import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { prisma } from "../src/prisma";
import { WarMailLifecycleService } from "../src/services/WarMailLifecycleService";

function buildClient(params: {
  channelResult?: unknown;
  channelError?: unknown;
  messageResult?: unknown;
  messageError?: unknown;
}): {
  client: Client;
  fetchMessage: ReturnType<typeof vi.fn>;
  fetchChannel: ReturnType<typeof vi.fn>;
} {
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

  const client = {
    channels: {
      fetch: fetchChannel,
    },
  } as unknown as Client;
  return {
    client,
    fetchMessage,
    fetchChannel,
  };
}

describe("WarMailLifecycleService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not_posted when no lifecycle row exists for current war", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValueOnce(null as never);
    const service = new WarMailLifecycleService();
    const { client } = buildClient({});

    const result = await service.resolveStatusForCurrentWar({
      client,
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
    const { client, fetchMessage } = buildClient({});

    const result = await service.resolveStatusForCurrentWar({
      client,
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      sentEmoji: "S",
      unsentEmoji: "U",
    });

    expect(result.status).toBe("posted");
    expect(result.mailStatusEmoji).toBe("S");
    expect(result.debug.reconciliationOutcome).toBe("exists");
    expect(fetchMessage).toHaveBeenCalledWith({ message: "456", force: true });
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
    const { client, fetchMessage } = buildClient({
      messageError: { code: 10008, message: "Unknown Message" },
    });

    const result = await service.resolveStatusForCurrentWar({
      client,
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
    expect(fetchMessage).toHaveBeenCalledWith({ message: "456", force: true });
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
    const { client } = buildClient({
      channelError: { code: 50001, message: "Missing Access" },
    });

    const result = await service.resolveStatusForCurrentWar({
      client,
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

  it("logs POSTED at info for first lifecycle transition", async () => {
    const findSpy = vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValueOnce(null as never);
    const upsertSpy = vi.spyOn(prisma.warMailLifecycle, "upsert").mockResolvedValueOnce({} as never);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    await service.markPosted({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      channelId: "123",
      messageId: "456",
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0] ?? "")).toContain("status=POSTED");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("does not repeat POSTED info for no-op upserts with same message identity", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      status: "POSTED",
      channelId: "123",
      messageId: "456",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.spyOn(prisma.warMailLifecycle, "upsert").mockResolvedValueOnce({} as never);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    await service.markPosted({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      channelId: "123",
      messageId: "456",
    });

    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0]?.[0] ?? "")).toContain("status=POSTED");
  });

  it("logs POSTED info when posted message identity changes", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      status: "POSTED",
      channelId: "123",
      messageId: "old-message",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.spyOn(prisma.warMailLifecycle, "upsert").mockResolvedValueOnce({} as never);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    await service.markPosted({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      channelId: "123",
      messageId: "new-message",
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("scopes message lookup to one war identity when warId is provided", async () => {
    const findFirstSpy = vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
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

    await service.findLifecycleByMessage({
      guildId: "guild-1",
      channelId: "123",
      messageId: "456",
      warId: 1001,
    });

    expect(findFirstSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          channelId: "123",
          messageId: "456",
          status: "POSTED",
          warId: 1001,
        }),
      }),
    );
  });
});

