import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerActivity: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  externalPlayerWeightCurrent: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
}));

const playerCurrentServiceMock = vi.hoisted(() => ({
  listPlayerCurrentByTags: vi.fn(),
}));

const weightInputDefermentServiceMock = vi.hoisted(() => ({
  listOpenDeferredWeightsByClanAndPlayerTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PlayerCurrentService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerCurrentService")>(
    "../src/services/PlayerCurrentService",
  );
  return {
    ...actual,
    playerCurrentService: playerCurrentServiceMock,
  };
});

vi.mock("../src/services/WeightInputDefermentService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/WeightInputDefermentService")>(
    "../src/services/WeightInputDefermentService",
  );
  return {
    ...actual,
    listOpenDeferredWeightsByClanAndPlayerTags: weightInputDefermentServiceMock.listOpenDeferredWeightsByClanAndPlayerTags,
  };
});

import { buildAccountsRows } from "../src/services/AccountRowsService";

describe("AccountRowsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(new Map());
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    weightInputDefermentServiceMock.listOpenDeferredWeightsByClanAndPlayerTags.mockResolvedValue(new Map());
  });

  it("starts bulk hydration reads together before awaiting deferred weights", async () => {
    const promise = buildAccountsRows({
      guildId: "guild-1",
      linkedNameByTag: new Map(),
      tags: ["#PYLQ0289"],
    });

    expect(playerCurrentServiceMock.listPlayerCurrentByTags).toHaveBeenCalledTimes(1);
    expect(prismaMock.playerActivity.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaPlayerCatalog.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.externalPlayerWeightCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();

    await promise;
  });

  it("hydrates representative account state and preserves the existing weight precedence", async () => {
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(
      new Map([
        [
          "#PYLQ0289",
          {
            playerTag: "#PYLQ0289",
            playerName: "Current Alpha",
            townHall: 16,
            currentClanTag: "#CURR1",
            currentClanName: "Current Clan",
            trophies: 6000,
            builderTrophies: 4000,
            warStars: 100,
            expLevel: 200,
            role: "leader",
            leagueName: "Legend League",
            currentWeight: 179000,
            currentWeightSource: "accounts-refresh",
            currentWeightMeasuredAt: new Date("2026-04-20T00:00:00.000Z"),
            achievementsJson: null,
            lastSeenAt: new Date("2026-04-20T00:00:00.000Z"),
            lastFetchedAt: new Date("2026-04-20T00:00:00.000Z"),
            lastSource: "accounts-refresh",
            createdAt: new Date("2026-04-20T00:00:00.000Z"),
            updatedAt: new Date("2026-04-20T00:00:00.000Z"),
            source: "accounts-refresh",
            liveRefreshInvoked: false,
          },
        ],
        [
          "#QGRJ2222",
          {
            playerTag: "#QGRJ2222",
            playerName: null,
            townHall: null,
            currentClanTag: null,
            currentClanName: null,
            trophies: null,
            builderTrophies: null,
            warStars: null,
            expLevel: null,
            role: null,
            leagueName: null,
            currentWeight: null,
            currentWeightSource: null,
            currentWeightMeasuredAt: null,
            achievementsJson: null,
            lastSeenAt: null,
            lastFetchedAt: null,
            lastSource: "fwa_player_catalog",
            createdAt: null,
            updatedAt: null,
            source: "player_current",
            liveRefreshInvoked: false,
          },
        ],
        [
          "#CUV9082",
          {
            playerTag: "#CUV9082",
            playerName: "Clanless Current",
            townHall: 15,
            currentClanTag: null,
            currentClanName: null,
            trophies: null,
            builderTrophies: null,
            warStars: null,
            expLevel: null,
            role: null,
            leagueName: null,
            currentWeight: 178000,
            currentWeightSource: null,
            currentWeightMeasuredAt: null,
            achievementsJson: null,
            lastSeenAt: null,
            lastFetchedAt: null,
            lastSource: "accounts-refresh",
            createdAt: null,
            updatedAt: null,
            source: "player_current",
            liveRefreshInvoked: false,
          },
        ],
      ]),
    );

    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#PYLQ0289",
        name: "Activity Alpha",
        clanTag: "#CURR1",
        clanName: "Current Clan",
      },
      {
        tag: "#QGRJ2222",
        name: "Activity Bravo",
        clanTag: "#CURR1",
        clanName: "Current Clan",
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#CURR1",
        townHall: 17,
        weight: 210000,
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#CURR1",
        townHall: 15,
        weight: null,
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        latestTownHall: 18,
        latestKnownWeight: 145000,
      },
      {
        playerTag: "#QGRJ2222",
        latestTownHall: 14,
        latestKnownWeight: 145000,
      },
    ]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        weight: 165000,
        measuredAt: new Date("2026-04-01T00:00:00.000Z"),
        source: "manual",
      },
      {
        playerTag: "#QGRJ2222",
        weight: 166000,
        measuredAt: new Date("2026-04-01T00:00:00.000Z"),
        source: "manual",
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#CURR1", name: "Current Clan" },
    ]);
    weightInputDefermentServiceMock.listOpenDeferredWeightsByClanAndPlayerTags.mockResolvedValue(
      new Map([
        ["#CURR1", new Map([["#PYLQ0289", 175000], ["#QGRJ2222", 177000]])],
      ]),
    );

    const rows = await buildAccountsRows({
      guildId: "guild-1",
      linkedNameByTag: new Map([
        ["#PYLQ0289", "Linked Alpha"],
        ["#QGRJ2222", "Linked Bravo"],
        ["#CUV9082", "Linked Charlie"],
      ]),
      tags: ["#PYLQ0289", "#QGRJ2222", "#CUV9082"],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        tag: "#PYLQ0289",
        name: "Current Alpha",
        townHall: 16,
        weight: 210000,
        weightSource: "FwaClanMemberCurrent",
        clanTag: "#CURR1",
        clanName: "Current Clan",
        clanRole: "leader",
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      }),
      expect.objectContaining({
        tag: "#QGRJ2222",
        name: "Linked Bravo",
        townHall: 15,
        weight: 177000,
        weightSource: "WeightInputDeferment",
        clanTag: "#CURR1",
        clanName: "Current Clan",
        clanRole: null,
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 0,
      }),
        expect.objectContaining({
          tag: "#CUV9082",
          name: "Clanless Current",
          townHall: 15,
          weight: 178000,
          weightSource: "PlayerCurrent",
          clanTag: null,
          clanName: null,
          clanRole: null,
        clanState: "no_clan",
        isTrackedFwaClan: false,
        trackedClanSortOrder: null,
      }),
    ]);
  });

  it("uses the persisted current FWA membership clan when PlayerCurrent is stale", async () => {
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(
      new Map([
        [
          "#PYLQ0289",
          {
            playerTag: "#PYLQ0289",
            playerName: "Moved Alpha",
            townHall: 16,
            currentClanTag: "#CLANA",
            currentClanName: "Clan A",
            role: "member",
            currentWeight: null,
            lastSource: "fwa_feed",
          },
        ],
      ]),
    );
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#PYLQ0289", name: "Moved Alpha", clanTag: "#CLANA", clanName: "Clan A" },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#CLANB",
        townHall: 17,
        weight: 210000,
        sourceSyncedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#CLANA", name: "Clan A" },
      { tag: "#CLANB", name: "Clan B" },
    ]);

    const rows = await buildAccountsRows({
      guildId: "guild-1",
      linkedNameByTag: new Map([["#PYLQ0289", "Moved Alpha"]]),
      tags: ["#PYLQ0289"],
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        tag: "#PYLQ0289",
        clanTag: "#CLANB",
        clanName: "Clan B",
        clanState: "known",
        isTrackedFwaClan: true,
        trackedClanSortOrder: 1,
      }),
    );
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "asc" },
      where: { tag: { in: ["#CLANA", "#CLANB"] } },
      select: { tag: true, name: true },
    });
  });

  it("keeps a live-confirmed clanless PlayerCurrent row from inheriting stale PlayerActivity clan data", async () => {
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(
      new Map([
        [
          "#PYLQ0289",
          {
            playerTag: "#PYLQ0289",
            playerName: "Clanless Alpha",
            townHall: 16,
            currentClanTag: null,
            currentClanName: null,
            currentWeight: null,
            lastSource: "activity_observe",
          },
        ],
      ]),
    );
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#PYLQ0289", name: "Clanless Alpha", clanTag: "#CLANA", clanName: "Clan A" },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#CLANA", name: "Clan A" },
    ]);

    const rows = await buildAccountsRows({
      guildId: "guild-1",
      linkedNameByTag: new Map([["#PYLQ0289", "Clanless Alpha"]]),
      tags: ["#PYLQ0289"],
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        clanTag: null,
        clanName: null,
        clanState: "no_clan",
        isTrackedFwaClan: false,
      }),
    );
  });

  it("uses the freshest current FWA membership row during a transient cross-clan overlap", async () => {
    playerCurrentServiceMock.listPlayerCurrentByTags.mockResolvedValue(
      new Map([
        [
          "#PYLQ0289",
          {
            playerTag: "#PYLQ0289",
            playerName: "Overlap Alpha",
            townHall: 16,
            currentClanTag: "#CLANA",
            currentClanName: "Clan A",
            role: "member",
            currentWeight: null,
            lastSource: "fwa_feed",
          },
        ],
      ]),
    );
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#CLANA",
        townHall: 16,
        weight: 200000,
        sourceSyncedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      {
        playerTag: "#PYLQ0289",
        clanTag: "#CLANB",
        townHall: 17,
        weight: 210000,
        sourceSyncedAt: new Date("2026-04-20T01:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#CLANA", name: "Clan A" },
      { tag: "#CLANB", name: "Clan B" },
    ]);

    const rows = await buildAccountsRows({
      guildId: "guild-1",
      linkedNameByTag: new Map([["#PYLQ0289", "Overlap Alpha"]]),
      tags: ["#PYLQ0289"],
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        clanTag: "#CLANB",
        clanName: "Clan B",
        weight: 210000,
        weightSource: "FwaClanMemberCurrent",
      }),
    );
  });
});
