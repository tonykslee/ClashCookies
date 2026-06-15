import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
} from "../src/services/TrackedMessageService";
import { BotLogChannelService } from "../src/services/BotLogChannelService";

type TrackedRow = Record<string, unknown>;

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  trackedMessageClaim: {
    findFirst: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeSyncMetadata(syncEpochSeconds: number) {
  return {
    syncTimeIso: new Date(syncEpochSeconds * 1000).toISOString(),
    syncEpochSeconds,
    roleId: "123456789012345678",
    clans: [
      {
        code: "RR",
        clanTag: "#PYLQ",
        clanName: "Rocky Road",
        emojiId: "111",
        emojiName: "rr",
        emojiInline: "<:rr:111>",
      },
    ],
  };
}

function makeRootRow(overrides: Partial<TrackedRow> = {}): TrackedRow {
  return {
    id: "tracked-a",
    guildId: "guild-1",
    channelId: "channel-a",
    messageId: "sync-message-a",
    featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    referenceId: null,
    remindAt: new Date("2026-06-15T23:25:00.000Z"),
    expiresAt: new Date("2026-06-16T02:30:00.000Z"),
    metadata: makeSyncMetadata(Math.floor(new Date("2026-06-16T00:30:00.000Z").getTime() / 1000)),
    claims: [{ clanTag: "#PYLQ", userId: "user-1" }],
    createdAt: new Date("2026-06-15T23:00:00.000Z"),
    updatedAt: new Date("2026-06-15T23:00:00.000Z"),
    ...overrides,
  };
}

function cloneRows(rows: TrackedRow[]): TrackedRow[] {
  return structuredClone(rows);
}

function compareValue(left: unknown, right: unknown): number {
  const leftMs = left instanceof Date ? left.getTime() : null;
  const rightMs = right instanceof Date ? right.getTime() : null;
  if (leftMs !== null || rightMs !== null) {
    return (leftMs ?? 0) - (rightMs ?? 0);
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function sortRows(rows: TrackedRow[], orderBy: Array<Record<string, "asc" | "desc">> = []) {
  return [...rows].sort((left, right) => {
    for (const order of orderBy) {
      const [field, direction] = Object.entries(order)[0] ?? [];
      if (!field || !direction) continue;
      const comparison = compareValue(left[field], right[field]);
      if (comparison !== 0) return direction === "desc" ? -comparison : comparison;
    }
    return 0;
  });
}

function matchesWhere(row: TrackedRow, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(value)) {
      if (!value.some((clause) => matchesWhere(row, clause as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === "AND" && Array.isArray(value)) {
      if (!value.every((clause) => matchesWhere(row, clause as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === "messageId" && value && typeof value === "object" && "not" in value) {
      if (row.messageId === (value as { not?: unknown }).not) return false;
      continue;
    }
    if (key === "status" && value && typeof value === "object" && "in" in value) {
      const statuses = (value as { in?: unknown[] }).in ?? [];
      if (!statuses.includes(row.status)) return false;
      continue;
    }
    if (key === "remindAt" && value && typeof value === "object" && "lte" in value) {
      const cutoff = (value as { lte?: Date }).lte;
      if (!(row.remindAt instanceof Date) || !(cutoff instanceof Date)) return false;
      if (row.remindAt.getTime() > cutoff.getTime()) return false;
      continue;
    }
    if (key === "guildId" || key === "featureType" || key === "referenceId") {
      if (row[key] !== value) return false;
      continue;
    }
    if (key === "status") {
      if (row.status !== value) return false;
      continue;
    }
    if (key === "id") {
      if (row.id !== value) return false;
      continue;
    }
  }
  return true;
}

function applyUpdate(row: TrackedRow, data: Record<string, unknown>): TrackedRow {
  return {
    ...row,
    ...data,
  };
}

function makeRepo(store: { rows: TrackedRow[] }, options?: { failOnUpsert?: boolean }) {
  const failOnUpsert = options?.failOnUpsert ?? false;
  return {
    $executeRaw: prismaMock.$executeRaw,
    trackedMessage: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const rows = store.rows.filter((row) => matchesWhere(row, where));
        return sortRows(rows, orderBy)[0] ?? null;
      }),
      findMany: vi.fn(async ({ where, orderBy, include }: any) => {
        const rows = sortRows(store.rows.filter((row) => matchesWhere(row, where)), orderBy);
        if (include?.claims) {
          return rows.map((row) => ({
            ...row,
            claims: cloneRows((row.claims as TrackedRow[] | undefined) ?? []),
          }));
        }
        return cloneRows(rows);
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const messageId = String(where?.messageId ?? where?.id ?? "").trim();
        return store.rows.find((row) => row.messageId === messageId || row.id === messageId) ?? null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        store.rows = store.rows.map((row) => {
          if (!matchesWhere(row, where)) return row;
          count += 1;
          return applyUpdate(row, data ?? {});
        });
        return { count };
      }),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        if (failOnUpsert) {
          throw new Error("tracked root write boom");
        }
        const messageId = String(where?.messageId ?? "").trim();
        const index = store.rows.findIndex((row) => row.messageId === messageId);
        if (index >= 0) {
          store.rows[index] = applyUpdate(store.rows[index], update ?? {});
          return store.rows[index];
        }
        const created = cloneRows([create ?? {}])[0];
        store.rows.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const index = store.rows.findIndex((row) => row.id === where?.id || row.messageId === where?.messageId);
        if (index < 0) {
          throw new Error("tracked row missing");
        }
        store.rows[index] = applyUpdate(store.rows[index], data ?? {});
        return store.rows[index];
      }),
    },
    trackedMessageClaim: {
      findFirst: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
  };
}

describe("TrackedMessageService sync root ownership", () => {
  let store: { rows: TrackedRow[] };
  let failOnUpsert = false;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    store = { rows: [] };
    failOnUpsert = false;
    const repo = makeRepo(store);
    prismaMock.$executeRaw.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
      const working = { rows: cloneRows(store.rows) };
      const tx = makeRepo(working, { failOnUpsert });
      const result = await callback(tx as any);
      store.rows = working.rows;
      return result;
    });
    prismaMock.trackedMessage.findFirst.mockImplementation(repo.trackedMessage.findFirst);
    prismaMock.trackedMessage.findMany.mockImplementation(repo.trackedMessage.findMany);
    prismaMock.trackedMessage.findUnique.mockImplementation(repo.trackedMessage.findUnique);
    prismaMock.trackedMessage.updateMany.mockImplementation(repo.trackedMessage.updateMany);
    prismaMock.trackedMessage.upsert.mockImplementation(repo.trackedMessage.upsert);
    prismaMock.trackedMessage.update.mockImplementation(repo.trackedMessage.update);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(BotLogChannelService.prototype, "getChannelIdForType").mockResolvedValue(null);
  });

  it("replaces prior active root sync rows and keeps non-root rows untouched when a corrected sync is published", async () => {
    const rootA = makeRootRow({
      id: "tracked-a",
      messageId: "sync-message-a",
      channelId: "channel-a",
      syncTime: new Date("2026-06-16T01:30:00.000Z"),
      remindAt: new Date("2026-06-15T23:25:00.000Z"),
      expiresAt: new Date("2026-06-16T02:30:00.000Z"),
      metadata: makeSyncMetadata(Math.floor(new Date("2026-06-16T01:30:00.000Z").getTime() / 1000)),
      claims: [{ clanTag: "#AAA", userId: "user-a" }],
      createdAt: new Date("2026-06-15T23:00:00.000Z"),
      updatedAt: new Date("2026-06-15T23:00:00.000Z"),
    });
    const readinessRow = makeRootRow({
      id: "tracked-readiness",
      messageId: "readiness-message",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
      status: TRACKED_MESSAGE_STATUS.COMPLETED,
      referenceId: "sync-message-a",
      remindAt: null,
      expiresAt: null,
      metadata: {
        readinessEnabled: true,
        createdAtIso: "2026-06-15T22:50:00.000Z",
      },
    });
    const childRow = makeRootRow({
      id: "tracked-child",
      messageId: "sync-child-message",
      referenceId: "sync-message-a",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      remindAt: null,
      claims: [{ clanTag: "#AAA", userId: "user-child" }],
    });
    const otherGuildRow = makeRootRow({
      id: "tracked-other-guild",
      guildId: "guild-2",
      messageId: "sync-message-other",
      channelId: "channel-other",
      createdAt: new Date("2026-06-15T22:55:00.000Z"),
      updatedAt: new Date("2026-06-15T22:55:00.000Z"),
    });
    const otherFeatureRow = makeRootRow({
      id: "tracked-other-feature",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
      messageId: "base-checklist-message",
      createdAt: new Date("2026-06-15T22:56:00.000Z"),
      updatedAt: new Date("2026-06-15T22:56:00.000Z"),
    });
    store.rows = cloneRows([rootA, readinessRow, childRow, otherGuildRow, otherFeatureRow]);

    const rootB = makeRootRow({
      id: "tracked-b",
      messageId: "sync-message-b",
      channelId: "channel-b",
      syncTime: new Date("2026-06-16T00:30:00.000Z"),
      remindAt: new Date("2026-06-15T22:55:00.000Z"),
      expiresAt: new Date("2026-06-16T01:30:00.000Z"),
      metadata: makeSyncMetadata(Math.floor(new Date("2026-06-16T00:30:00.000Z").getTime() / 1000)),
      claims: [],
      createdAt: new Date("2026-06-15T23:05:00.000Z"),
      updatedAt: new Date("2026-06-15T23:05:00.000Z"),
    });

    const replacedRootCount = await trackedMessageService.replacePriorRootSyncTimeTrackedMessagesForGuildAndCreate({
      guildId: "guild-1",
      channelId: "channel-b",
      messageId: rootB.messageId as string,
      remindAt: rootB.remindAt as Date,
      expiresAt: rootB.expiresAt as Date,
      metadata: rootB.metadata as any,
    });

    expect(replacedRootCount).toBe(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("sync_root_ownership_switched"),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("guild_id=guild-1"),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("new_message_id=sync-message-b"),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("replaced_root_count=1"),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`sync_epoch=${(rootB.metadata as any).syncEpochSeconds}`),
    );

    const storedA = store.rows.find((row) => row.messageId === "sync-message-a");
    const storedB = store.rows.find((row) => row.messageId === "sync-message-b");
    const storedChild = store.rows.find((row) => row.messageId === "sync-child-message");
    const storedReadiness = store.rows.find((row) => row.messageId === "readiness-message");
    const storedOtherGuild = store.rows.find((row) => row.messageId === "sync-message-other");
    const storedOtherFeature = store.rows.find((row) => row.messageId === "base-checklist-message");

    expect(storedA).toMatchObject({
      status: TRACKED_MESSAGE_STATUS.REPLACED,
      claims: [{ clanTag: "#AAA", userId: "user-a" }],
    });
    expect(storedB).toMatchObject({
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: null,
      channelId: "channel-b",
    });
    expect(storedChild).toMatchObject({
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: "sync-message-a",
    });
    expect(storedReadiness).toMatchObject({
      status: TRACKED_MESSAGE_STATUS.COMPLETED,
      referenceId: "sync-message-a",
    });
    expect(storedOtherGuild).toMatchObject({
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      guildId: "guild-2",
    });
    expect(storedOtherFeature).toMatchObject({
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
    });

    await expect(trackedMessageService.resolveLatestActiveSyncPost("guild-1")).resolves.toMatchObject({
      messageId: "sync-message-b",
      guildId: "guild-1",
    });
  });

  it("resolves the newest active root ownership even when the corrected sync time is earlier than the older announcement", async () => {
    store.rows = cloneRows([
      makeRootRow({
        id: "tracked-a",
        messageId: "sync-message-a",
        syncTime: new Date("2026-06-16T01:30:00.000Z"),
        remindAt: new Date("2026-06-15T23:25:00.000Z"),
        createdAt: new Date("2026-06-15T23:00:00.000Z"),
        updatedAt: new Date("2026-06-15T23:00:00.000Z"),
        metadata: makeSyncMetadata(Math.floor(new Date("2026-06-16T01:30:00.000Z").getTime() / 1000)),
      }),
      makeRootRow({
        id: "tracked-b",
        messageId: "sync-message-b",
        syncTime: new Date("2026-06-16T00:30:00.000Z"),
        remindAt: new Date("2026-06-15T22:55:00.000Z"),
        createdAt: new Date("2026-06-15T23:05:00.000Z"),
        updatedAt: new Date("2026-06-15T23:05:00.000Z"),
        metadata: makeSyncMetadata(Math.floor(new Date("2026-06-16T00:30:00.000Z").getTime() / 1000)),
      }),
    ]);

    await expect(trackedMessageService.resolveLatestActiveSyncPost("guild-1")).resolves.toMatchObject({
      messageId: "sync-message-b",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: null,
    });
    expect(prismaMock.trackedMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          guildId: "guild-1",
          referenceId: null,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        },
        orderBy: [{ createdAt: "desc" }, { messageId: "desc" }],
      }),
    );

    await expect(
      trackedMessageService.resolveFwaBaseSwapSyncIdentityForClanWar({
        guildId: "guild-1",
        clanTag: "#PYPY",
      }),
    ).resolves.toEqual({
      syncMessageId: "sync-message-b",
      source: "active_sync_post",
    });
  });

  it("keeps replaced sync rows out of the reminder sweep", async () => {
    const replacedRow = makeRootRow({
      id: "tracked-a",
      messageId: "sync-message-a",
      status: TRACKED_MESSAGE_STATUS.REPLACED,
      remindAt: new Date("2026-06-15T22:30:00.000Z"),
      claims: [{ clanTag: "#AAA", userId: "user-a" }],
      createdAt: new Date("2026-06-15T22:00:00.000Z"),
    });
    const activeRow = makeRootRow({
      id: "tracked-b",
      messageId: "sync-message-b",
      remindAt: new Date("2026-06-15T22:30:00.000Z"),
      claims: [{ clanTag: "#PYLQ", userId: "user-b" }],
      createdAt: new Date("2026-06-15T22:05:00.000Z"),
      metadata: {
        ...makeSyncMetadata(Math.floor(new Date("2026-06-16T00:30:00.000Z").getTime() / 1000)),
        reminderSentAt: null,
      },
    });
    store.rows = cloneRows([replacedRow, activeRow]);

    const send = vi.fn().mockResolvedValue({ id: "status-message-1", react: vi.fn() });
    const userSend = vi.fn().mockResolvedValue(undefined);
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue({
          channels: {
            fetch: vi.fn().mockResolvedValue({
              isTextBased: () => true,
              send,
            }),
          },
        }),
      },
      users: {
        fetch: vi.fn(async () => ({ send: userSend })),
      },
    } as any;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T23:00:00.000Z"));

    const result = await trackedMessageService.processDueSyncReminders(client);

    expect(result).toBe(1);
    expect(prismaMock.trackedMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          referenceId: null,
          remindAt: { lte: expect.any(Date) },
        },
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(userSend).toHaveBeenCalledTimes(1);
  });

  it("rolls back root replacement when the authoritative ownership write fails after the old row is marked replaced in-transaction", async () => {
    store.rows = cloneRows([
      makeRootRow({
        id: "tracked-a",
        messageId: "sync-message-a",
        createdAt: new Date("2026-06-15T23:00:00.000Z"),
        updatedAt: new Date("2026-06-15T23:00:00.000Z"),
        metadata: makeSyncMetadata(Math.floor(new Date("2026-06-16T01:30:00.000Z").getTime() / 1000)),
      }),
    ]);
    failOnUpsert = true;

    await expect(
      trackedMessageService.replacePriorRootSyncTimeTrackedMessagesForGuildAndCreate({
        guildId: "guild-1",
        channelId: "channel-b",
        messageId: "sync-message-b",
        remindAt: new Date("2026-06-15T22:55:00.000Z"),
        expiresAt: new Date("2026-06-16T01:30:00.000Z"),
        metadata: makeSyncMetadata(Math.floor(new Date("2026-06-16T00:30:00.000Z").getTime() / 1000)),
      }),
    ).rejects.toThrow("tracked root write boom");

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      messageId: "sync-message-a",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: null,
    });
    expect(store.rows.some((row) => row.messageId === "sync-message-b")).toBe(false);
  });
});
