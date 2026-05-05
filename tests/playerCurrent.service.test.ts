import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerCurrent: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { playerCurrentService } from "../src/services/PlayerCurrentService";
import { todoSnapshotService } from "../src/services/TodoSnapshotService";

function makeCurrentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    playerTag: "#PQL0289",
    playerName: "Primary",
    townHall: 15,
    currentClanTag: "#PRIMARY",
    currentClanName: "Primary Clan",
    trophies: 6000,
    builderTrophies: 4000,
    warStars: 100,
    expLevel: 200,
    role: "leader",
    leagueName: "Legend League",
    currentWeight: 123,
    currentWeightSource: "primary",
    currentWeightMeasuredAt: new Date("2026-04-20T00:00:00.000Z"),
    achievementsJson: null,
    lastSeenAt: new Date("2026-04-20T00:00:00.000Z"),
    lastFetchedAt: new Date("2026-04-20T00:00:00.000Z"),
    lastSource: "player_current",
    createdAt: new Date("2026-04-20T00:00:00.000Z"),
    updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    ...overrides,
  };
}

function makeLivePlayer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Live Player",
    townHallLevel: 16,
    clan: {
      tag: "#2QG2C08UP",
      name: "Live Clan",
    },
    trophies: 6100,
    builderBaseTrophies: 4200,
    warStars: 101,
    expLevel: 201,
    role: "member",
    league: { name: "Legend League" },
    achievements: [{ name: "Friend in Need", value: 1 }],
    ...overrides,
  };
}

describe("PlayerCurrentService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.upsert.mockResolvedValue({} as never);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    vi.spyOn(todoSnapshotService, "listSnapshotsByPlayerTags").mockResolvedValue([] as never);
  });

  it("prefers PlayerCurrent over fallback sources and skips live fetch when town hall is already present", async () => {
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([
      makeCurrentRow({ playerTag: "#PQL0289", playerName: "Primary", townHall: 16 }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([
      { playerTag: "#PQL0289", latestName: "Fallback", latestTownHall: 14, latestKnownWeight: 111, firstSeenAt: new Date(), lastSeenAt: new Date(), lastSyncedAt: new Date() },
    ]);
    (todoSnapshotService.listSnapshotsByPlayerTags as any).mockResolvedValueOnce([
      { playerTag: "#PQL0289", playerName: "Snapshot", townHall: 12, clanTag: "#SNAP", clanName: "Snapshot Clan", updatedAt: new Date(), lastUpdatedAt: new Date() },
    ]);

    const cocService = { getPlayerRaw: vi.fn() } as any;
    const resolved = await playerCurrentService.resolveCurrentPlayersForTags({
      playerTags: ["#PQL0289"],
      cocService,
      requireFields: ["townHall"],
    });

    expect(resolved.get("#PQL0289")).toMatchObject({
      playerTag: "#PQL0289",
      playerName: "Primary",
      townHall: 16,
      currentClanTag: "#PRIMARY",
      currentClanName: "Primary Clan",
      source: "player_current",
    });
    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
  });

  it("falls back to FwaPlayerCatalog before TodoPlayerSnapshot for missing town hall", async () => {
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([
      { playerTag: "#QGRJ2222", latestName: "FWA Player", latestTownHall: 14, latestKnownWeight: 222, firstSeenAt: new Date(), lastSeenAt: new Date(), lastSyncedAt: new Date() },
    ]);
    (todoSnapshotService.listSnapshotsByPlayerTags as any).mockResolvedValueOnce([
      { playerTag: "#QGRJ2222", playerName: "Snapshot Player", townHall: 12, clanTag: "#SNAP", clanName: "Snapshot Clan", updatedAt: new Date(), lastUpdatedAt: new Date() },
    ]);

    const resolved = await playerCurrentService.resolveCurrentPlayersForTags({
      playerTags: ["#QGRJ2222"],
      requireFields: ["townHall"],
    });

    expect(resolved.get("#QGRJ2222")).toMatchObject({
      playerTag: "#QGRJ2222",
      playerName: "FWA Player",
      townHall: 14,
      currentWeight: 222,
      source: "fwa_player_catalog",
    });
  });

  it("falls back to TodoPlayerSnapshot before live fetch when persisted current-player data is still missing town hall", async () => {
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([]);
    (todoSnapshotService.listSnapshotsByPlayerTags as any).mockResolvedValueOnce([
      { playerTag: "#298CG8UJG", playerName: "Snapshot Player", townHall: 13, clanTag: "#2QG2C08UP", clanName: "Snapshot Clan", updatedAt: new Date(), lastUpdatedAt: new Date() },
    ]);
    const cocService = { getPlayerRaw: vi.fn() } as any;

    const resolved = await playerCurrentService.resolveCurrentPlayersForTags({
      playerTags: ["#298CG8UJG"],
      cocService,
      requireFields: ["townHall"],
    });

    expect(resolved.get("#298CG8UJG")).toMatchObject({
      playerTag: "#298CG8UJG",
      playerName: "Snapshot Player",
      townHall: 13,
      currentClanTag: "#2QG2C08UP",
      currentClanName: "Snapshot Clan",
      source: "todo_snapshot",
    });
    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
  });

  it("persists live town hall even when the live player has no clan tag", async () => {
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([]);
    (todoSnapshotService.listSnapshotsByPlayerTags as any).mockResolvedValueOnce([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue(makeLivePlayer({ clan: null })),
    } as any;

    const resolved = await playerCurrentService.resolveCurrentPlayersForTags({
      playerTags: ["#G99CVLG9Y"],
      cocService,
      requireFields: ["townHall"],
    });

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#G99CVLG9Y");
    expect(resolved.get("#G99CVLG9Y")).toMatchObject({
      playerTag: "#G99CVLG9Y",
      playerName: "Live Player",
      townHall: 16,
      currentClanTag: null,
      currentClanName: null,
      trophies: 6100,
      builderTrophies: 4200,
      warStars: 101,
      expLevel: 201,
      role: "member",
      leagueName: "Legend League",
      source: "live_refresh",
      liveRefreshInvoked: true,
    });
    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerTag: "#G99CVLG9Y" },
        create: expect.objectContaining({
          playerTag: "#G99CVLG9Y",
          townHall: 16,
          currentClanTag: null,
          currentClanName: null,
        }),
      }),
    );
  });

  it("persists an override current weight when upserting from a live player profile", async () => {
    const livePlayer = makeLivePlayer({
      clan: {
        tag: "#PQL0289",
        name: "Alpha Clan",
      },
    });

    await playerCurrentService.upsertPlayerCurrentFromLivePlayer({
      playerTag: "#PYLQ0289",
      livePlayer,
      currentWeight: 145000,
      source: "accounts-refresh",
    });

    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerTag: "#PYLQ0289" },
        create: expect.objectContaining({
          playerTag: "#PYLQ0289",
          playerName: "Live Player",
          townHall: 16,
          currentClanTag: "#PQL0289",
          currentClanName: "Alpha Clan",
          currentWeight: 145000,
        }),
      }),
    );
  });

  it("refreshes stale signup-path player current data even when town hall is already populated", async () => {
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([
      makeCurrentRow({
        playerTag: "#PQL0289",
        playerName: "Cached Player",
        townHall: 14,
        lastFetchedAt: new Date(Date.now() - (7 * 60 * 60 * 1000)),
      }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([]);
    (todoSnapshotService.listSnapshotsByPlayerTags as any).mockResolvedValueOnce([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue(makeLivePlayer({ townHallLevel: 15 })),
    } as any;

    const resolved = await playerCurrentService.resolveCurrentPlayersForTags({
      playerTags: ["#PQL0289"],
      cocService,
      requireFields: ["townHall"],
      refreshPolicy: "missing_or_stale",
      maxAcceptedAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#PQL0289");
    expect(resolved.get("#PQL0289")).toMatchObject({
      playerTag: "#PQL0289",
      playerName: "Live Player",
      townHall: 15,
      source: "live_refresh",
      liveRefreshInvoked: true,
    });
    expect(prismaMock.playerCurrent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerTag: "#PQL0289" },
        create: expect.objectContaining({
          playerTag: "#PQL0289",
          townHall: 15,
          lastSource: "live_refresh",
        }),
      }),
    );
  });

  it("keeps fresh signup-path player current data cached when town hall is already populated", async () => {
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([
      makeCurrentRow({
        playerTag: "#QGRJ2222",
        playerName: "Cached Player",
        townHall: 14,
        lastFetchedAt: new Date(Date.now() - (2 * 60 * 60 * 1000)),
      }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([]);
    (todoSnapshotService.listSnapshotsByPlayerTags as any).mockResolvedValueOnce([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue(makeLivePlayer({ townHallLevel: 15 })),
    } as any;

    const resolved = await playerCurrentService.resolveCurrentPlayersForTags({
      playerTags: ["#QGRJ2222"],
      cocService,
      requireFields: ["townHall"],
      refreshPolicy: "missing_or_stale",
      maxAcceptedAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(resolved.get("#QGRJ2222")).toMatchObject({
      playerTag: "#QGRJ2222",
      playerName: "Cached Player",
      townHall: 14,
      source: "player_current",
      liveRefreshInvoked: false,
    });
  });

  it("treats missing lastFetchedAt as stale for signup refresh", async () => {
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([
      makeCurrentRow({
        playerTag: "#298CG8UJG",
        playerName: "Cached Player",
        townHall: 14,
        lastFetchedAt: null,
      }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([]);
    (todoSnapshotService.listSnapshotsByPlayerTags as any).mockResolvedValueOnce([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue(makeLivePlayer({ townHallLevel: 15 })),
    } as any;

    const resolved = await playerCurrentService.resolveCurrentPlayersForTags({
      playerTags: ["#298CG8UJG"],
      cocService,
      requireFields: ["townHall"],
      refreshPolicy: "missing_or_stale",
      maxAcceptedAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#298CG8UJG");
    expect(resolved.get("#298CG8UJG")).toMatchObject({
      playerTag: "#298CG8UJG",
      playerName: "Live Player",
      townHall: 15,
      source: "live_refresh",
      liveRefreshInvoked: true,
    });
  });
});
