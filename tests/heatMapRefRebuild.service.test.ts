import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEAT_MAP_REF_SEED_ROWS } from "../src/services/HeatMapRefSeedData";
import { HeatMapRefRebuildService } from "../src/services/HeatMapRefRebuildService";
import { trackedMessageService } from "../src/services/TrackedMessageService";
import { CompoWarStateService } from "../src/services/CompoWarStateService";
import {
  buildHeatMapRefRebuildRows,
  getHeatMapRefSeedRowCountsByBandKey,
  type HeatMapRefBandDefinition,
} from "../src/helper/heatMapRefRebuild";

const prismaMock = vi.hoisted(() => ({
  fwaClanCatalog: {
    findMany: vi.fn(),
  },
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  heatMapRef: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  fwaTrackedClanWarRosterCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeMember(input: {
  clanTag: string;
  playerTag: string;
  position: number;
  effectiveWeight: number;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    position: input.position,
    townHall: 18,
    rawWeight: input.effectiveWeight,
    effectiveWeight: input.effectiveWeight,
    effectiveWeightStatus: "RAW" as const,
    opponentTag: null,
    opponentName: null,
  };
}

function makeCurrentHeatMapRows() {
  return HEAT_MAP_REF_SEED_ROWS.map((row) => ({
    weightMinInclusive: row.weightMinInclusive,
    weightMaxInclusive: row.weightMaxInclusive,
    th18Count: row.th18Count,
    th17Count: row.th17Count,
    th16Count: row.th16Count,
    th15Count: row.th15Count,
    th14Count: row.th14Count,
    th13Count: row.th13Count,
    th12Count: row.th12Count,
    th11Count: row.th11Count,
    th10OrLowerCount: row.th10OrLowerCount,
    contributingClanCount: row.contributingClanCount,
    sourceVersion: row.sourceVersion,
    refreshedAt: row.refreshedAt,
  }));
}

function makeNoopHeatMapRows(now: Date) {
  const seedBands: HeatMapRefBandDefinition[] = HEAT_MAP_REF_SEED_ROWS.map((row) => ({
    weightMinInclusive: row.weightMinInclusive,
    weightMaxInclusive: row.weightMaxInclusive,
  }));
  return buildHeatMapRefRebuildRows({
    sourceRosters: [],
    seedBands,
    seedRowsByBandKey: getHeatMapRefSeedRowCountsByBandKey(
      seedBands,
      HEAT_MAP_REF_SEED_ROWS.map((row) => ({
        th18Count: row.th18Count,
        th17Count: row.th17Count,
        th16Count: row.th16Count,
        th15Count: row.th15Count,
        th14Count: row.th14Count,
        th13Count: row.th13Count,
        th12Count: row.th12Count,
        th11Count: row.th11Count,
        th10OrLowerCount: row.th10OrLowerCount,
      })),
    ),
    now,
  }).rows;
}

function makeSyncPost(input: {
  messageId: string;
  syncTimeIso: string;
  roleId?: string | null;
}) {
  return {
    messageId: input.messageId,
    metadata: {
      syncTimeIso: input.syncTimeIso,
      syncEpochSeconds: Math.floor(new Date(input.syncTimeIso).getTime() / 1000),
      roleId: input.roleId ?? "role-1",
      clans: [
        {
          clanTag: "#AAA111",
          clanName: "Alpha",
          emojiId: null,
          emojiName: null,
          emojiInline: "<:alpha:1>",
        },
      ],
    },
  } as never;
}

function getStoredCheckpoint(settingsStore: Map<string, string>, guildId: string) {
  const raw = settingsStore.get(`heatmapref_rebuild_state:${guildId}`);
  expect(raw).toBeTruthy();
  return JSON.parse(String(raw)) as {
    cycleKey: string;
    anchoredSyncTimeIso: string;
    dueAtIso: string;
    status: string;
    lastAttemptAtIso: string | null;
    lastSuccessAtIso: string | null;
    failureReason: string | null;
    contentHash: string | null;
    roleId: string | null;
  };
}

describe("HeatMapRefRebuildService", () => {
  const settingsStore = new Map<string, string>();
  const settings = {
    get: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      settingsStore.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      settingsStore.delete(key);
    }),
  };
  const botLogChannels = {
    getChannelId: vi.fn(async () => "bot-log-1"),
  };
  const permissions = {
    getFwaLeaderRoleId: vi.fn(async () => "role-1"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    settingsStore.clear();
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([{ clanTag: "#AAA111" }]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", logChannelId: "log-1" },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue(makeCurrentHeatMapRows());
    prismaMock.heatMapRef.deleteMany.mockResolvedValue({ count: 11 });
    prismaMock.heatMapRef.createMany.mockResolvedValue({ count: 11 });
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(null as never);
  });

  it("returns noop when the rebuilt content already matches the stored HeatMapRef rows", async () => {
    const service = new HeatMapRefRebuildService({
      settings: settings as never,
      botLogChannels: botLogChannels as never,
      permissions: permissions as never,
    });
    const now = new Date("2026-04-13T00:00:00.000Z");

    prismaMock.heatMapRef.findMany.mockResolvedValue(makeNoopHeatMapRows(now) as never);

    const result = await service.rebuildHeatMapRef(now);

    expect(result.status).toBe("noop");
    expect(prismaMock.heatMapRef.createMany).not.toHaveBeenCalled();
    expect(result.summaryLines.join(" ")).toContain("rebuilt content matched");
  });

  it("includes qualifying untracked FWA clans from the persisted catalog", async () => {
    const service = new HeatMapRefRebuildService({
      settings: settings as never,
      botLogChannels: botLogChannels as never,
      permissions: permissions as never,
    });
    const now = new Date("2026-04-13T00:00:00.000Z");
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([
      { clanTag: "#TRACKED" },
      { clanTag: "#UNTRACKED" },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(
      [
        ...Array.from({ length: 50 }, (_, index) => ({
          clanTag: "#TRACKED",
          playerTag: `#T${String(index + 1).padStart(3, "0")}`,
          position: index + 1,
          townHall: 18,
          weight: 175_000,
          sourceSyncedAt: now,
        })),
        ...Array.from({ length: 50 }, (_, index) => ({
          clanTag: "#UNTRACKED",
          playerTag: `#U${String(index + 1).padStart(3, "0")}`,
          position: index + 1,
          townHall: 17,
          weight: 145_000,
          sourceSyncedAt: now,
        })),
      ] as never,
    );

    const result = await service.rebuildHeatMapRef(now);

    expect(result.status).toBe("success");
    expect(prismaMock.fwaWarMemberCurrent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clanTag: { in: ["#TRACKED", "#UNTRACKED"] } },
      }),
    );
    expect(result.qualifyingRosterCount).toBe(2);
    expect(result.trackedClanCount).toBe(2);
    expect(result.rowCount).toBeGreaterThan(0);
    expect(prismaMock.heatMapRef.createMany).toHaveBeenCalledTimes(1);
  });

  it("skips the scheduled rebuild in mirror mode", async () => {
    const service = new HeatMapRefRebuildService({
      settings: settings as never,
      botLogChannels: botLogChannels as never,
      permissions: permissions as never,
    });

    const result = await service.runScheduledRebuildCycle({
      client: {} as never,
      guildId: "guild-1",
      pollingMode: "mirror",
      now: new Date("2026-04-13T00:00:00.000Z"),
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("mirror mode");
    expect(prismaMock.heatMapRef.createMany).not.toHaveBeenCalled();
  });

  it("anchors the rebuild checkpoint to the first recognized sync cycle even if sync-time post changes later", async () => {
    const service = new HeatMapRefRebuildService({
      settings: settings as never,
      botLogChannels: botLogChannels as never,
      permissions: permissions as never,
    });
    const guildId = "guild-1";
    const firstSyncTimeIso = "2026-04-11T00:00:00.000Z";
    const secondSyncTimeIso = "2026-04-12T12:00:00.000Z";
    const firstDueAtIso = "2026-04-12T23:00:00.000Z";

    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost")
      .mockResolvedValueOnce(makeSyncPost({ messageId: "message-1", syncTimeIso: firstSyncTimeIso }))
      .mockResolvedValueOnce(makeSyncPost({ messageId: "message-2", syncTimeIso: secondSyncTimeIso }));

    const firstResult = await service.runScheduledRebuildCycle({
      client: {} as never,
      guildId,
      pollingMode: "active",
      now: new Date("2026-04-12T22:59:00.000Z"),
    });

    expect(firstResult.status).toBe("skipped");
    expect(firstResult.reason).toContain("not due yet");
    expect(getStoredCheckpoint(settingsStore, guildId)).toMatchObject({
      cycleKey: "message-1:1775865600",
      anchoredSyncTimeIso: firstSyncTimeIso,
      dueAtIso: firstDueAtIso,
      status: "scheduled",
    });

    const secondResult = await service.runScheduledRebuildCycle({
      client: {} as never,
      guildId,
      pollingMode: "active",
      now: new Date("2026-04-12T22:59:30.000Z"),
    });

    expect(secondResult.status).toBe("skipped");
    expect(secondResult.reason).toContain("not due yet");
    expect(getStoredCheckpoint(settingsStore, guildId)).toMatchObject({
      cycleKey: "message-1:1775865600",
      anchoredSyncTimeIso: firstSyncTimeIso,
      dueAtIso: firstDueAtIso,
      status: "scheduled",
    });
  });

  it("alerts bot-logs and records a failure checkpoint when the scheduled rebuild fails", async () => {
    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(
      makeSyncPost({ messageId: "message-1", syncTimeIso: "2026-04-11T00:00:00.000Z" }),
    );
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({
        clanTag: "#AAA111",
        playerTag: `#P${String(index + 1).padStart(3, "0")}`,
        position: index + 1,
        townHall: 18,
        weight: 175_000,
        sourceSyncedAt: new Date("2026-04-13T00:00:00.000Z"),
      })),
    );
    prismaMock.heatMapRef.createMany.mockRejectedValueOnce(new Error("write failed"));

    const send = vi.fn().mockResolvedValue(undefined);
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
    } as never;
    const service = new HeatMapRefRebuildService({
      settings: settings as never,
      botLogChannels: botLogChannels as never,
      permissions: permissions as never,
    });

    const result = await service.runScheduledRebuildCycle({
      client,
      guildId: "guild-1",
      pollingMode: "active",
      now: new Date("2026-04-13T00:00:00.000Z"),
    });

    expect(result.status).toBe("failed");
    expect(result.alertSent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0]?.content ?? send.mock.calls[0]?.[0] ?? "")).toContain(
      "HeatMapRef rebuild failed",
    );
    expect(settings.set).toHaveBeenCalled();
    const checkpoint = getStoredCheckpoint(settingsStore, "guild-1");
    expect(checkpoint.status).toBe("failed");
    expect(checkpoint.failureReason).toContain("write failed");
    expect(checkpoint.dueAtIso).toBe("2026-04-12T23:00:00.000Z");
  });

  it("creates a fresh checkpoint for the next cycle after the prior cycle completed", async () => {
    const service = new HeatMapRefRebuildService({
      settings: settings as never,
      botLogChannels: botLogChannels as never,
      permissions: permissions as never,
    });
    const guildId = "guild-1";
    const firstSyncTimeIso = "2026-04-11T00:00:00.000Z";
    const secondSyncTimeIso = "2026-04-13T00:00:00.000Z";
    const secondDueAtIso = "2026-04-14T23:00:00.000Z";

    settingsStore.set(
      `heatmapref_rebuild_state:${guildId}`,
      JSON.stringify({
        cycleKey: "message-1:1775865600",
        anchoredSyncTimeIso: firstSyncTimeIso,
        dueAtIso: "2026-04-12T23:00:00.000Z",
        status: "success",
        lastAttemptAtIso: "2026-04-12T23:00:00.000Z",
        lastSuccessAtIso: "2026-04-12T23:05:00.000Z",
        failureReason: null,
        contentHash: "hash-1",
        roleId: "role-1",
      }),
    );

    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(
      makeSyncPost({ messageId: "message-2", syncTimeIso: secondSyncTimeIso }),
    );
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({
        clanTag: "#AAA111",
        playerTag: `#Q${String(index + 1).padStart(3, "0")}`,
        position: index + 1,
        townHall: 18,
        weight: 175_000,
        sourceSyncedAt: new Date(secondSyncTimeIso),
      })),
    );

    const result = await service.runScheduledRebuildCycle({
      client: {} as never,
      guildId,
      pollingMode: "active",
      now: new Date("2026-04-15T00:00:00.000Z"),
    });

    expect(result.status).not.toBe("skipped");
    expect(getStoredCheckpoint(settingsStore, guildId)).toMatchObject({
      cycleKey: "message-2:1776038400",
      anchoredSyncTimeIso: secondSyncTimeIso,
      dueAtIso: secondDueAtIso,
      status: expect.stringMatching(/^(success|no_op)$/),
    });
  });

  it("skips duplicate work when a cycle is already running", async () => {
    const service = new HeatMapRefRebuildService({
      settings: settings as never,
      botLogChannels: botLogChannels as never,
      permissions: permissions as never,
    });
    const guildId = "guild-1";
    const syncTimeIso = "2026-04-11T00:00:00.000Z";

    settingsStore.set(
      `heatmapref_rebuild_state:${guildId}`,
      JSON.stringify({
        cycleKey: "message-1:1775865600",
        anchoredSyncTimeIso: syncTimeIso,
        dueAtIso: "2026-04-12T23:00:00.000Z",
        status: "running",
        lastAttemptAtIso: "2026-04-12T23:00:00.000Z",
        lastSuccessAtIso: null,
        failureReason: null,
        contentHash: null,
        roleId: "role-1",
      }),
    );

    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(
      makeSyncPost({ messageId: "message-1", syncTimeIso }),
    );

    const result = await service.runScheduledRebuildCycle({
      client: {} as never,
      guildId,
      pollingMode: "active",
      now: new Date("2026-04-13T00:00:00.000Z"),
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("already running");
    expect(prismaMock.fwaWarMemberCurrent.findMany).not.toHaveBeenCalled();
  });

  it("writes rebuilt HeatMapRef rows and the next consumer read uses the refreshed table", async () => {
    const service = new HeatMapRefRebuildService({
      settings: settings as never,
      botLogChannels: botLogChannels as never,
      permissions: permissions as never,
    });

    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({
        clanTag: "#AAA111",
        playerTag: `#P${String(index + 1).padStart(3, "0")}`,
        position: index + 1,
        townHall: 18,
        weight: 175_000,
        sourceSyncedAt: new Date("2026-04-13T00:00:00.000Z"),
      })),
    );
    prismaMock.heatMapRef.findMany.mockResolvedValueOnce(makeCurrentHeatMapRows());

    const rebuild = await service.rebuildHeatMapRef(new Date("2026-04-13T00:00:00.000Z"));
    expect(rebuild.status).toBe("success");
    expect(prismaMock.heatMapRef.createMany).toHaveBeenCalledTimes(1);

    const rebuiltRows = prismaMock.heatMapRef.createMany.mock.calls[0]?.[0]?.data as Array<{
      weightMinInclusive: number;
      weightMaxInclusive: number;
      th18Count: number;
      th17Count: number;
      th16Count: number;
      th15Count: number;
      th14Count: number;
      th13Count: number;
      th12Count: number;
      th11Count: number;
      th10OrLowerCount: number;
      contributingClanCount: number;
      sourceVersion: string | null;
      refreshedAt: Date;
    }>;

    prismaMock.heatMapRef.findMany.mockResolvedValue(rebuiltRows as never);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        clanName: "Alpha",
        totalEffectiveWeight: 8_750_000,
        rosterSize: 50,
        missingWeights: 0,
        bucketCounts: undefined,
        heatMapRef: rebuiltRows[rebuiltRows.length - 1],
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => makeMember({
        clanTag: "#AAA111",
        playerTag: `#P${String(index + 1).padStart(3, "0")}`,
        position: index + 1,
        effectiveWeight: 175_000,
      })),
    );

    const readState = await new CompoWarStateService().readState();
    const expectedDelta = String(50 - (rebuiltRows[rebuiltRows.length - 1]?.th18Count ?? 0));

    expect(readState.stateRows).not.toBeNull();
    expect(readState.stateRows?.[1]?.[4]).toBe(expectedDelta);
  });
});
