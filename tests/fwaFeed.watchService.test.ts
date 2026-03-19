import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  trackedMessage: {
    findMany: vi.fn(),
  },
  fwaClanWarsWatchState: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  fwaClanWarLogCurrent: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { FwaClanWarsWatchService } from "../src/services/fwa-feeds/FwaClanWarsWatchService";

function buildSyncMetadata(params: {
  syncEpochSeconds: number;
  clanTags: string[];
}) {
  return {
    syncTimeIso: new Date(params.syncEpochSeconds * 1000).toISOString(),
    syncEpochSeconds: params.syncEpochSeconds,
    roleId: "role-1",
    clans: params.clanTags.map((tag) => ({
      clanTag: tag,
      clanName: tag,
      emojiId: null,
      emojiName: null,
      emojiInline: `:${tag}:`,
    })),
    reminderSentAt: null,
  };
}

describe("FwaClanWarsWatchService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("polls only tracked clans with active watch windows", async () => {
    const now = new Date("2026-03-19T11:57:00.000Z");
    const syncEpoch = Math.floor(new Date("2026-03-19T12:00:00.000Z").getTime() / 1000);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111" }, { tag: "#BBB222" }]);
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        messageId: "sync-msg-1",
        metadata: buildSyncMetadata({
          syncEpochSeconds: syncEpoch,
          clanTags: ["#AAA111", "#BBB222"],
        }),
      },
    ]);
    prismaMock.fwaClanWarsWatchState.findMany
      .mockResolvedValueOnce([
        {
          clanTag: "#BBB222",
          pollingActive: false,
          currentWarCycleKey: "#BBB222:2026-03-19T12:00:00.000Z",
          stopReason: "update_acquired",
          lastObservedContentHash: "hash-b",
        },
      ])
      .mockResolvedValueOnce([
        {
          clanTag: "#AAA111",
          pollingActive: true,
          currentWarCycleKey: "#AAA111:2026-03-19T12:00:00.000Z",
          stopReason: null,
          lastObservedContentHash: "oldhash",
        },
      ]);
    prismaMock.fwaClanWarLogCurrent.findFirst.mockResolvedValue({ endTime: new Date("2026-03-19T10:00:00.000Z") });

    const clanWarsSync = {
      syncClan: vi.fn().mockResolvedValue({
        rowCount: 3,
        changedRowCount: 3,
        contentHash: "oldhash",
        status: "SUCCESS",
      }),
    } as any;
    const service = new FwaClanWarsWatchService(clanWarsSync);

    const result = await service.runWatchTick({ now, concurrency: 2 });

    expect(clanWarsSync.syncClan).toHaveBeenCalledTimes(1);
    expect(clanWarsSync.syncClan).toHaveBeenCalledWith("#AAA111", expect.any(Object));
    expect(result.trackedClanCount).toBe(2);
    expect(result.activeClanCount).toBe(1);
    expect(result.polledClanCount).toBe(1);
  });

  it("stops polling once update is acquired (content hash changed)", async () => {
    const now = new Date("2026-03-19T11:57:00.000Z");
    const syncEpoch = Math.floor(new Date("2026-03-19T12:00:00.000Z").getTime() / 1000);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111" }]);
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        messageId: "sync-msg-1",
        metadata: buildSyncMetadata({
          syncEpochSeconds: syncEpoch,
          clanTags: ["#AAA111"],
        }),
      },
    ]);
    prismaMock.fwaClanWarsWatchState.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          clanTag: "#AAA111",
          pollingActive: true,
          currentWarCycleKey: "#AAA111:2026-03-19T12:00:00.000Z",
          stopReason: null,
          lastObservedContentHash: "oldhash",
        },
      ]);
    prismaMock.fwaClanWarLogCurrent.findFirst.mockResolvedValue({ endTime: new Date("2026-03-19T10:00:00.000Z") });

    const clanWarsSync = {
      syncClan: vi.fn().mockResolvedValue({
        rowCount: 3,
        changedRowCount: 3,
        contentHash: "newhash",
        status: "SUCCESS",
      }),
    } as any;
    const service = new FwaClanWarsWatchService(clanWarsSync);

    const result = await service.runWatchTick({ now, concurrency: 1 });

    expect(result.updateAcquiredCount).toBe(1);
    expect(prismaMock.fwaClanWarsWatchState.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clanTag: "#AAA111" },
        data: expect.objectContaining({
          pollingActive: false,
          stopReason: "update_acquired",
        }),
      }),
    );
  });
});
