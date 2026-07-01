import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  cwlEventClan: {
    findMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    findMany: vi.fn(),
  },
  trackedClanRep: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    groupBy: vi.fn(),
  },
  roster: {
    findMany: vi.fn(),
  },
  currentCwlRound: {
    findMany: vi.fn(),
  },
  currentCwlPrepSnapshot: {
    findMany: vi.fn(),
  },
  cwlRoundHistory: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

const queueContextMock = vi.hoisted(() => ({
  runWithCoCQueueContext: vi.fn(async (_context: unknown, run: () => Promise<unknown>) => run()),
}));

const metadataRefreshMock = vi.hoisted(() => vi.fn().mockResolvedValue({
  season: "2026-07",
  requestedCount: 1,
  ensuredCount: 0,
  hydratedCount: 0,
  skippedCount: 0,
}));

const memberRefreshMock = vi.hoisted(() => vi.fn().mockResolvedValue({
  clanCount: 0,
  rowCount: 0,
  changedRowCount: 0,
  failedClans: [],
}));

vi.mock("../src/services/CoCQueueContext", () => ({
  runWithCoCQueueContext: queueContextMock.runWithCoCQueueContext,
}));

vi.mock("../src/services/CwlRegistryService", () => ({
  refreshCwlTrackedClanMetadataForSeason: metadataRefreshMock,
  resolveCurrentCwlSeasonKey: vi.fn(() => "2026-07"),
}));

vi.mock("../src/services/fwa-feeds/FwaClanMembersSyncService", () => ({
  FwaClanMembersSyncService: class {
    refreshCurrentClanMembersForClanTags = memberRefreshMock;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

import {
  buildFwaTrackedClanMinimalListRender,
  listCwlTrackedClansForDetailedDisplay,
  listFwaTrackedClansForDisplay,
  loadFwaTrackedClanMinimalListState,
  refreshCwlTrackedClanDetailedDisplayWithQueueContext,
} from "../src/services/TrackedClanListService";

describe("TrackedClanListService FWA minimal helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlEventClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValue([]);
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.currentCwlPrepSnapshot.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findMany.mockResolvedValue([]);
    metadataRefreshMock.mockResolvedValue({
      season: "2026-07",
      requestedCount: 1,
      ensuredCount: 0,
      hydratedCount: 0,
      skippedCount: 0,
    });
    memberRefreshMock.mockResolvedValue({
      clanCount: 0,
      rowCount: 0,
      changedRowCount: 0,
      failedClans: [],
    });
  });

  it("loads tracked clans and persisted member counts for the minimal FWA list", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: "leader-channel-1",
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
    ]);

    const state = await loadFwaTrackedClanMinimalListState();

    expect(state.refreshTags).toEqual(["#2QG2C08UP"]);
    expect(state.memberCountByTag.get("#2QG2C08UP")).toBe(49);
    expect(state.trackedClans).toHaveLength(1);
    expect(state.trackedClans[0]).toMatchObject({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      leadRoleId: "lead-role-1",
    });
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanMemberCurrent.groupBy).toHaveBeenCalledTimes(1);
  });

  it("loads rep player tags for detailed FWA rows in bulk", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: null,
        clanRoleId: null,
        leadRoleId: null,
        clanBadge: null,
        shortName: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", playerTag: "#2RVGJYLC0" },
      { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
    ]);

    const rows = await listFwaTrackedClansForDisplay();

    expect(rows).toEqual([
      expect.objectContaining({
        tag: "#2QG2C08UP",
        repPlayerTags: ["#2RVGJYLC0", "#PYLQ0289"],
      }),
    ]);
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledWith({
      where: {
        clanTag: { in: ["#2QG2C08UP"] },
      },
      orderBy: [{ clanTag: "asc" }, { playerTag: "asc" }],
      select: {
        clanTag: true,
        playerTag: true,
      },
    });
  });

  it("renders the exact minimal FWA list embed and refresh button", () => {
    const render = buildFwaTrackedClanMinimalListRender({
      refreshPrefix: "tracked-clan-list:fwa-summary:test",
      trackedClans: [
        {
          tag: "#2QG2C08UP",
          name: "Alpha Clan",
          loseStyle: "TRADITIONAL",
          mailChannelId: null,
          logChannelId: null,
          leaderChannelId: "leader-channel-1",
          clanRoleId: null,
          leadRoleId: "lead-role-1",
          clanBadge: null,
          shortName: "AC",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ],
      memberCountByTag: new Map([["#2QG2C08UP", 49]]),
      refreshing: false,
    });

    const embed = render.embeds[0]?.toJSON() as any;
    const buttonRow = render.components[0]?.toJSON() as any;

    expect(embed?.title).toBe("Tracked Clans (FWA) (1)");
    expect(String(embed?.description ?? "")).toContain("**FWA**");
    expect(String(embed?.description ?? "")).toContain(
      "- [Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>) `#2QG2C08UP` | 49 👥",
    );
    expect(buttonRow?.components?.[0]?.custom_id).toBe("tracked-clan-list:fwa-summary:test:refresh");
    expect(buttonRow?.components?.[0]?.label).toBe("Refresh");
    expect(buttonRow?.components?.[0]?.disabled).toBe(false);
  });
});

describe("TrackedClanListService CWL detailed helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlEventClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.currentCwlPrepSnapshot.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValue([]);
    metadataRefreshMock.mockResolvedValue({
      season: "2026-07",
      requestedCount: 1,
      ensuredCount: 0,
      hydratedCount: 0,
      skippedCount: 0,
    });
    memberRefreshMock.mockResolvedValue({
      clanCount: 0,
      rowCount: 0,
      changedRowCount: 0,
      failedClans: [],
    });
  });

  it("shows an empty current-season CWL roster with idle spin state when only stale prior-season evidence exists", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-07",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Champion League I",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlEventClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "#PYLQ0289",
        eventInstance: {
          id: "event-june",
          season: "2026-06",
          anchorWarTag: "#JUNE",
          firstObservedAt: new Date("2026-06-01T00:00:00.000Z"),
          lastObservedAt: new Date("2026-06-01T01:00:00.000Z"),
        },
      },
    ]);

    const rows = await listCwlTrackedClansForDetailedDisplay({
      season: "2026-07",
      guildId: "guild-1",
    });

    expect(rows).toEqual([
      expect.objectContaining({
        season: "2026-07",
        tag: "#PYLQ0289",
        observedCwlRosterCount: 0,
        spinStatus: "idle",
      }),
    ]);
    expect(prismaMock.cwlPlayerClanSeason.findMany).not.toHaveBeenCalled();
    expect(prismaMock.currentCwlRound.findMany).not.toHaveBeenCalled();
    expect(prismaMock.currentCwlPrepSnapshot.findMany).not.toHaveBeenCalled();
    expect(prismaMock.cwlRoundHistory.findMany).not.toHaveBeenCalled();
  });

  it("counts duplicate registered player tags once and downgrades stale live league groups to idle", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      {
        season: "2026-07",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Champion League I",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlEventClan.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        eventInstance: {
          id: "event-july",
          season: "2026-07",
          anchorWarTag: "#JULY",
          firstObservedAt: new Date("2026-07-01T00:00:00.000Z"),
          lastObservedAt: new Date("2026-07-01T01:00:00.000Z"),
        },
      },
    ]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([
      { cwlClanTag: "#PYLQ0289", playerTag: "#PYLQ0289" },
      { cwlClanTag: "#PYLQ0289", playerTag: "#pylq0289" },
      { cwlClanTag: "#PYLQ0289", playerTag: "#QGRJ2222" },
    ]);
    prismaMock.roster.findMany.mockResolvedValue([
      {
        id: "roster-1",
        title: "July Roster",
        clanTag: "#PYLQ0289",
        lifecycleState: "ACTIVE",
        postedMessageUrl: "https://discord.com/channels/1/2/3",
        postedAt: new Date("2026-07-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-06",
        state: "ended",
      }),
      getClan: vi.fn(),
    };

    const result = await refreshCwlTrackedClanDetailedDisplayWithQueueContext({
      season: "2026-07",
      guildId: "guild-1",
      cocService: cocService as any,
    });

    expect(result).toMatchObject({
      season: "2026-07",
      displayedClanCount: 1,
      matchedCount: 0,
      searchingCount: 0,
      idleCount: 1,
    });
    expect(result.rows).toEqual([
      expect.objectContaining({
        season: "2026-07",
        tag: "#PYLQ0289",
        observedCwlRosterCount: 2,
        spinStatus: "idle",
      }),
    ]);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledWith("#PYLQ0289");
    const logLines = (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      String(call[0] ?? ""),
    );
    expect(logLines.some((line) => line.includes("raw_reason=stale_group_season"))).toBe(true);
    expect(logLines.some((line) => line.includes("returned_season=2026-06"))).toBe(true);
    expect(queueContextMock.runWithCoCQueueContext).toHaveBeenCalled();
  });
});
