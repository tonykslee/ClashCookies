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

function buildWarMailLifecycleRow(params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "war-mail-lifecycle-row",
    guildId: "guild-1",
    clanTag: "#AAA111",
    warId: 1001,
    warStartTime: new Date("2026-03-12T00:00:00.000Z"),
    opponentTag: "2NEW",
    status: "POSTED",
    channelId: "channel-1",
    messageId: "message-1",
    postedAt: new Date("2026-03-12T00:01:00.000Z"),
    deletedAt: null,
    sendClaimToken: null,
    sendClaimKey: null,
    sendClaimedAt: null,
    lastCompletedSendKey: null,
    createdAt: new Date("2026-03-12T00:00:00.000Z"),
    updatedAt: new Date("2026-03-12T00:00:00.000Z"),
    ...params,
  };
}

function cloneWarMailLifecycleRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  return row ? { ...row } : null;
}

function matchesExactWarMailIdentity(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  const identityKeys = ["guildId", "clanTag", "warId", "opponentTag"] as const;
  for (const key of identityKeys) {
    if (where[key] !== undefined && row[key] !== where[key]) {
      return false;
    }
  }
  const warStartTime = where.warStartTime;
  if (warStartTime instanceof Date) {
    const rowWarStart = row.warStartTime;
    if (!(rowWarStart instanceof Date) || rowWarStart.getTime() !== warStartTime.getTime()) {
      return false;
    }
  }
  return true;
}

function matchesSendClaimUpdateWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  if (!matchesExactWarMailIdentity(row, where)) return false;
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.sendClaimToken !== undefined && row.sendClaimToken !== where.sendClaimToken) {
    return false;
  }
  if (where.sendClaimKey !== undefined && row.sendClaimKey !== where.sendClaimKey) {
    return false;
  }
  if (where.sendClaimedAt !== undefined && row.sendClaimedAt !== where.sendClaimedAt) {
    return false;
  }
  const orConditions = Array.isArray(where.OR) ? (where.OR as Array<Record<string, unknown>>) : [];
  if (orConditions.length > 0) {
    const currentLastCompleted = row.lastCompletedSendKey;
    const matchesAny = orConditions.some((condition) => {
      if (condition.lastCompletedSendKey === null) {
        return currentLastCompleted === null || currentLastCompleted === undefined;
      }
      const notValue = (condition.lastCompletedSendKey as { not?: unknown } | undefined)?.not;
      if (notValue !== undefined) {
        return currentLastCompleted !== notValue;
      }
      return false;
    });
    if (!matchesAny) return false;
  }
  return true;
}

function applyWarMailLifecycleUpdate(
  row: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    next[key] = value;
  }
  return next;
}

function installWarMailLifecycleStateMock(initialRow: Record<string, unknown> | null) {
  const state = {
    row: cloneWarMailLifecycleRow(initialRow),
  };

  const upsert = vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    if (state.row) {
      return cloneWarMailLifecycleRow(state.row);
    }
    state.row = {
      id: "war-mail-lifecycle-row",
      status: "NOT_POSTED",
      messageId: null,
      channelId: null,
      postedAt: null,
      deletedAt: null,
      sendClaimToken: null,
      sendClaimKey: null,
      sendClaimedAt: null,
      lastCompletedSendKey: null,
      createdAt: new Date("2026-03-12T00:00:00.000Z"),
      updatedAt: new Date("2026-03-12T00:00:00.000Z"),
      ...args.create,
    };
    return cloneWarMailLifecycleRow(state.row);
  });

  const updateMany = vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (!state.row || !matchesSendClaimUpdateWhere(state.row, args.where)) {
      return { count: 0 };
    }
    state.row = applyWarMailLifecycleUpdate(state.row, args.data);
    return { count: 1 };
  });

  const findUnique = vi.fn(async () => cloneWarMailLifecycleRow(state.row));
  const findFirst = vi.fn(async (args: { where?: Record<string, unknown> }) => {
    if (!state.row || !args.where) return cloneWarMailLifecycleRow(state.row);
    return matchesExactWarMailIdentity(state.row, args.where)
      ? cloneWarMailLifecycleRow(state.row)
      : null;
  });

  const tx = {
    warMailLifecycle: {
      upsert,
      updateMany,
      findUnique,
      findFirst,
    },
  };

  const transactionSpy = vi
    .spyOn(prisma, "$transaction")
    .mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx as any));

  const findFirstSpy = vi.spyOn(prisma.warMailLifecycle, "findFirst").mockImplementation(findFirst as any);
  const updateManySpy = vi.spyOn(prisma.warMailLifecycle, "updateMany").mockImplementation(updateMany as any);

  return {
    state,
    tx,
    upsert,
    updateMany,
    findUnique,
    findFirst,
    transactionSpy,
    findFirstSpy,
    updateManySpy,
  };
}

describe("WarMailLifecycleService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not_posted when no lifecycle row exists for current war", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce(null as never);
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
    vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
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
    const findSpy = vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
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

  it("skips deletion when a failing explicit target is stale versus current tracked lifecycle message", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      status: "POSTED",
      messageId: "new-message",
      channelId: "new-channel",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const updateManySpy = vi.spyOn(prisma.warMailLifecycle, "updateMany");
    const service = new WarMailLifecycleService();

    const result = await service.markDeletedIfTrackedMessageMatches({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      channelId: "old-channel",
      messageId: "old-message",
    });

    expect(result).toBe("stale_target");
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it("deletes lifecycle when failing explicit target still matches current tracked lifecycle identity", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      status: "POSTED",
      messageId: "current-message",
      channelId: "current-channel",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const updateManySpy = vi
      .spyOn(prisma.warMailLifecycle, "updateMany")
      .mockResolvedValueOnce({ count: 1 } as never);
    const service = new WarMailLifecycleService();

    const result = await service.markDeletedIfTrackedMessageMatches({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      channelId: "current-channel",
      messageId: "current-message",
    });

    expect(result).toBe("deleted");
    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          clanTag: "#AAA111",
          warId: 1001,
          status: "POSTED",
          channelId: "current-channel",
          messageId: "current-message",
        }),
      }),
    );
  });

  it("marks lifecycle deleted when tracked channel is inaccessible for active-war mail", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
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

    expect(updateManySpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("deleted");
    expect(result.debug.reconciliationOutcome).toBe("channel_inaccessible");
  });

  it("keeps lifecycle posted on transient reconciliation errors", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
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
      channelError: { code: 0, message: "Transient" },
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
    expect(result.debug.reconciliationOutcome).toBe("transient_error");
  });

  it("logs POSTED at info for first lifecycle transition", async () => {
    const findSpy = vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce(null as never);
    const createSpy = vi.spyOn(prisma.warMailLifecycle, "create").mockResolvedValueOnce({} as never);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    await service.markPosted({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      channelId: "123",
      messageId: "456",
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0] ?? "")).toContain("status=POSTED");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("does not repeat POSTED info for no-op upserts with same message identity", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      status: "POSTED",
      channelId: "123",
      messageId: "456",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const updateSpy = vi.spyOn(prisma.warMailLifecycle, "update").mockResolvedValueOnce({} as never);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    await service.markPosted({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      channelId: "123",
      messageId: "456",
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0]?.[0] ?? "")).toContain("status=POSTED");
  });

  it("logs POSTED info when posted message identity changes", async () => {
    vi.spyOn(prisma.warMailLifecycle, "findFirst").mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      status: "POSTED",
      channelId: "123",
      messageId: "old-message",
      postedAt: new Date(),
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const updateSpy = vi.spyOn(prisma.warMailLifecycle, "update").mockResolvedValueOnce({} as never);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    await service.markPosted({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      channelId: "123",
      messageId: "new-message",
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("resolves active-war lifecycle rows by warStartTime before warId", async () => {
    const findFirstSpy = vi
      .spyOn(prisma.warMailLifecycle, "findFirst")
      .mockResolvedValueOnce({
        id: "row-1",
        guildId: "guild-1",
        clanTag: "#AAA111",
        warId: 9999,
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
        opponentTag: "#2NEW",
        status: "POSTED",
        channelId: "123",
        messageId: "456",
        postedAt: new Date(),
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
    const service = new WarMailLifecycleService();

    const result = await service.getLifecycleForWar({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#2NEW",
    });

    expect(findFirstSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          clanTag: "#AAA111",
          warStartTime: new Date("2026-03-12T00:00:00.000Z"),
        }),
      }),
    );
    expect(result?.warId).toBe(9999);
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

  it("acquires a send claim for an unclaimed active-war lifecycle row", async () => {
    const lifecycle = installWarMailLifecycleStateMock(null);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new WarMailLifecycleService();
    const claimedAt = new Date("2026-03-12T01:02:03.000Z");

    const result = await service.acquireSendClaim({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#2new",
      sendKey: "mail-revision-1",
      claimToken: "claim-token-1",
      claimedAt,
    });

    expect(result).toEqual({ result: "acquired" });
    expect(lifecycle.upsert).toHaveBeenCalledTimes(1);
    expect(lifecycle.updateMany).toHaveBeenCalledTimes(1);
    expect(lifecycle.state.row).toMatchObject({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      opponentTag: "2NEW",
      status: "NOT_POSTED",
      sendClaimToken: "claim-token-1",
      sendClaimKey: "mail-revision-1",
      sendClaimedAt: claimedAt,
      lastCompletedSendKey: null,
      channelId: null,
      messageId: null,
      postedAt: null,
      deletedAt: null,
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0] ?? "")).toContain("result=acquired");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns already_in_flight when another claim is still active for the same war", async () => {
    const lifecycle = installWarMailLifecycleStateMock(
      buildWarMailLifecycleRow({
        sendClaimToken: "active-token",
        sendClaimKey: "mail-revision-1",
        sendClaimedAt: new Date("2026-03-12T01:00:00.000Z"),
        lastCompletedSendKey: null,
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    const result = await service.acquireSendClaim({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#2new",
      sendKey: "mail-revision-2",
      claimToken: "claim-token-2",
    });

    expect(result).toEqual({ result: "already_in_flight" });
    expect(lifecycle.updateMany).toHaveBeenCalledTimes(1);
    expect(lifecycle.state.row).toMatchObject({
      status: "POSTED",
      channelId: "channel-1",
      messageId: "message-1",
      postedAt: new Date("2026-03-12T00:01:00.000Z"),
      deletedAt: null,
      sendClaimToken: "active-token",
      sendClaimKey: "mail-revision-1",
      sendClaimedAt: new Date("2026-03-12T01:00:00.000Z"),
      lastCompletedSendKey: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toContain("result=already_in_flight");
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("returns already_completed when the same send key was already finalized", async () => {
    const lifecycle = installWarMailLifecycleStateMock(
      buildWarMailLifecycleRow({
        sendClaimToken: null,
        sendClaimKey: null,
        sendClaimedAt: null,
        lastCompletedSendKey: "mail-revision-2",
      }),
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    const result = await service.acquireSendClaim({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#2new",
      sendKey: "mail-revision-2",
      claimToken: "claim-token-3",
    });

    expect(result).toEqual({ result: "already_completed" });
    expect(lifecycle.updateMany).toHaveBeenCalledTimes(1);
    expect(lifecycle.state.row).toMatchObject({
      lastCompletedSendKey: "mail-revision-2",
      sendClaimToken: null,
      sendClaimKey: null,
      sendClaimedAt: null,
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0] ?? "")).toContain("result=already_completed");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the exact active-war identity does not match the lifecycle row", async () => {
    const lifecycle = installWarMailLifecycleStateMock(
      buildWarMailLifecycleRow({
        warId: 2002,
        opponentTag: "3NEW",
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    const result = await service.acquireSendClaim({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#2new",
      sendKey: "mail-revision-4",
      claimToken: "claim-token-4",
    });

    expect(result).toEqual({ result: "invalid_identity" });
    expect(lifecycle.updateMany).not.toHaveBeenCalled();
    expect(lifecycle.state.row).toMatchObject({
      warId: 2002,
      opponentTag: "3NEW",
      sendClaimToken: null,
      sendClaimKey: null,
      sendClaimedAt: null,
      lastCompletedSendKey: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toContain("result=invalid_identity");
  });

  it("finalizes a reserved send claim and clears the in-flight token", async () => {
    const lifecycle = installWarMailLifecycleStateMock(
      buildWarMailLifecycleRow({
        status: "POSTED",
        channelId: "old-channel",
        messageId: "old-message",
        postedAt: new Date("2026-03-12T00:01:00.000Z"),
        deletedAt: new Date("2026-03-12T00:02:00.000Z"),
        sendClaimToken: "claim-token-5",
        sendClaimKey: "mail-revision-5",
        sendClaimedAt: new Date("2026-03-12T01:00:00.000Z"),
        lastCompletedSendKey: "mail-revision-4",
      }),
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    const result = await service.finalizeSendClaim({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#2new",
      claimToken: "claim-token-5",
      sendKey: "mail-revision-5",
      channelId: "new-channel",
      messageId: "new-message",
      postedAt: new Date("2026-03-12T01:05:00.000Z"),
    });

    expect(result).toBe(true);
    expect(lifecycle.updateMany).toHaveBeenCalledTimes(1);
    expect(lifecycle.state.row).toMatchObject({
      status: "POSTED",
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      opponentTag: "2NEW",
      channelId: "new-channel",
      messageId: "new-message",
      postedAt: new Date("2026-03-12T01:05:00.000Z"),
      deletedAt: null,
      sendClaimToken: null,
      sendClaimKey: null,
      sendClaimedAt: null,
      lastCompletedSendKey: "mail-revision-5",
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0] ?? "")).toContain("status=POSTED");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("refuses to finalize when the claim token is stale and preserves the authoritative row", async () => {
    const lifecycle = installWarMailLifecycleStateMock(
      buildWarMailLifecycleRow({
        sendClaimToken: "new-token",
        sendClaimKey: "mail-revision-6",
        sendClaimedAt: new Date("2026-03-12T01:10:00.000Z"),
        lastCompletedSendKey: "mail-revision-5",
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    const result = await service.finalizeSendClaim({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#2new",
      claimToken: "stale-token",
      sendKey: "mail-revision-6",
      channelId: "new-channel",
      messageId: "new-message",
      postedAt: new Date("2026-03-12T01:15:00.000Z"),
    });

    expect(result).toBe(false);
    expect(lifecycle.updateMany).toHaveBeenCalledTimes(1);
    expect(lifecycle.state.row).toMatchObject({
      status: "POSTED",
      channelId: "channel-1",
      messageId: "message-1",
      sendClaimToken: "new-token",
      sendClaimKey: "mail-revision-6",
      sendClaimedAt: new Date("2026-03-12T01:10:00.000Z"),
      lastCompletedSendKey: "mail-revision-5",
      deletedAt: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toContain("result=stale");
  });

  it("releases a send claim without changing the posted lifecycle state", async () => {
    const lifecycle = installWarMailLifecycleStateMock(
      buildWarMailLifecycleRow({
        status: "POSTED",
        channelId: "old-channel",
        messageId: "old-message",
        postedAt: new Date("2026-03-12T00:01:00.000Z"),
        deletedAt: new Date("2026-03-12T00:02:00.000Z"),
        sendClaimToken: "claim-token-7",
        sendClaimKey: "mail-revision-7",
        sendClaimedAt: new Date("2026-03-12T01:20:00.000Z"),
        lastCompletedSendKey: "mail-revision-6",
      }),
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new WarMailLifecycleService();

    const result = await service.releaseSendClaim({
      guildId: "guild-1",
      clanTag: "AAA111",
      warId: 1001,
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#2new",
      claimToken: "claim-token-7",
      sendKey: "mail-revision-7",
      reason: "discord_send_failed",
    });

    expect(result).toBe(true);
    expect(lifecycle.updateMany).toHaveBeenCalledTimes(1);
    expect(lifecycle.state.row).toMatchObject({
      status: "POSTED",
      channelId: "old-channel",
      messageId: "old-message",
      postedAt: new Date("2026-03-12T00:01:00.000Z"),
      deletedAt: new Date("2026-03-12T00:02:00.000Z"),
      sendClaimToken: null,
      sendClaimKey: null,
      sendClaimedAt: null,
      lastCompletedSendKey: "mail-revision-6",
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0] ?? "")).toContain("reason=discord_send_failed");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

