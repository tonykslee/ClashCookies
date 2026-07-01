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

function buildCwlTrackedClanSeasonRow(input: {
  tag: string;
  name: string;
  leagueLabel: string | null;
  season?: string;
  createdAt?: Date;
}) {
  return {
    season: input.season ?? "2026-07",
    tag: input.tag,
    name: input.name,
    leagueLabel: input.leagueLabel,
    createdAt: input.createdAt ?? new Date("2026-07-01T00:00:00.000Z"),
  };
}

function buildCwlRosterRow(input: {
  tag: string;
  title: string | null;
  lifecycleState?: "OPEN" | "ACTIVE" | "CLOSED";
  postedMessageUrl?: string | null;
  postedAt?: Date | null;
  createdAt?: Date;
}) {
  return {
    id: `${String(input.tag ?? "").replace(/^#/, "")}-roster`,
    title: input.title ?? "",
    clanTag: input.tag,
    lifecycleState: input.lifecycleState ?? "OPEN",
    postedMessageUrl: input.postedMessageUrl ?? null,
    postedAt: input.postedAt ?? null,
    createdAt: input.createdAt ?? new Date("2026-07-01T00:00:00.000Z"),
  };
}

const CWL_TAG_ALPHABET = "PYLQGRJCUV0289";

function buildValidCwlTag(index: number): string {
  const first = CWL_TAG_ALPHABET[index % CWL_TAG_ALPHABET.length] ?? "P";
  const second = CWL_TAG_ALPHABET[Math.floor(index / CWL_TAG_ALPHABET.length) % CWL_TAG_ALPHABET.length] ?? "Y";
  return `#PYLQ${first}${second}`;
}

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

  it("sorts CWL rows by planned roster league, division, and bracket with title precedence over league label", async () => {
    const orderedRows = [
      {
        tag: buildValidCwlTag(0),
        name: "Delta Clan",
        leagueLabel: "Champion League III",
        rosterTitle: "Champions 3 | Serious CWL (Invite-only)",
      },
      {
        tag: buildValidCwlTag(1),
        name: "Alpha Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 1 [A] | TH18 175k+",
      },
      {
        tag: buildValidCwlTag(2),
        name: "Charlie Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 1 [B] | TH18 175k+",
      },
      {
        tag: buildValidCwlTag(14),
        name: "Papa Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 1 [C] | TH18 175k+",
      },
      {
        tag: buildValidCwlTag(12),
        name: "November Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 1 [D] | TH18 175k+",
      },
      {
        tag: buildValidCwlTag(13),
        name: "Oscar Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 1 [E] | TH18 175k+",
      },
      {
        tag: buildValidCwlTag(3),
        name: "Echo Clan",
        leagueLabel: "Master League II",
        rosterTitle: "Masters 2 [A] | TH17 - 18",
      },
      {
        tag: buildValidCwlTag(4),
        name: "Foxtrot Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 2 [B] | TH17 - 18",
      },
      {
        tag: buildValidCwlTag(5),
        name: "Golf Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 2 [C] | TH17 - 18",
      },
      {
        tag: buildValidCwlTag(6),
        name: "Hotel Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 2 [D] | TH17 - 18",
      },
      {
        tag: buildValidCwlTag(7),
        name: "India Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 2 [E] | TH17 - 18",
      },
      {
        tag: buildValidCwlTag(8),
        name: "Juliet Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 3 [A] | TH14 - 16",
      },
      {
        tag: buildValidCwlTag(9),
        name: "Kilo Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 3 [B] | TH14 - 16",
      },
      {
        tag: buildValidCwlTag(10),
        name: "Lima Clan",
        leagueLabel: "Unranked",
        rosterTitle: "Masters 3 [C] | TH14 - 16",
      },
      {
        tag: buildValidCwlTag(11),
        name: "Mike Clan",
        leagueLabel: "Crystal League I",
        rosterTitle: "Crystal 1 | TH13 and below",
      },
    ];

    const shuffledRows = [...orderedRows].reverse();
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce(
      shuffledRows.map((row) => buildCwlTrackedClanSeasonRow(row)),
    );
    prismaMock.roster.findMany.mockResolvedValueOnce(
      shuffledRows.map((row, index) =>
        buildCwlRosterRow({
          tag: row.tag,
          title: row.rosterTitle,
          lifecycleState: index % 3 === 0 ? "OPEN" : index % 3 === 1 ? "ACTIVE" : "CLOSED",
          postedMessageUrl: index % 2 === 0 ? `https://discord.com/channels/1/2/${index + 10}` : null,
          postedAt: index % 2 === 0 ? new Date(`2026-07-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`) : null,
          createdAt: new Date(`2026-07-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`),
        }),
      ),
    );

    const rows = await listCwlTrackedClansForDetailedDisplay({
      season: "2026-07",
      guildId: "guild-1",
    });

    expect(rows.map((row) => row.tag)).toEqual(orderedRows.map((row) => row.tag));
  });

  it.each([
    {
      name: "accepts Masters 1 [A] as a valid planned roster key",
      rows: [
        {
          tag: buildValidCwlTag(40),
          name: "Masters 2 Anchor",
          leagueLabel: "Unranked",
          rosterTitle: "Masters 2 [A] | TH17 - 18",
        },
        {
          tag: buildValidCwlTag(41),
          name: "Masters 1 Anchor",
          leagueLabel: "Unranked",
          rosterTitle: "Masters 1 [A] | TH18 175k+",
        },
      ],
      expectedOrder: [buildValidCwlTag(41), buildValidCwlTag(40)],
    },
    {
      name: "accepts Masters II [B] as a valid planned roster key",
      rows: [
        {
          tag: buildValidCwlTag(42),
          name: "Masters II B",
          leagueLabel: "Unranked",
          rosterTitle: "Masters II [B] | TH18 175k+",
        },
        {
          tag: buildValidCwlTag(43),
          name: "Masters II A",
          leagueLabel: "Unranked",
          rosterTitle: "Masters II [A] | TH18 175k+",
        },
      ],
      expectedOrder: [buildValidCwlTag(43), buildValidCwlTag(42)],
    },
    {
      name: "accepts Master League III as a valid planned roster key",
      rows: [
        {
          tag: buildValidCwlTag(44),
          name: "Master League III",
          leagueLabel: "Unranked",
          rosterTitle: "Master League III | TH14 - 16",
        },
        {
          tag: buildValidCwlTag(45),
          name: "Master League II",
          leagueLabel: "Unranked",
          rosterTitle: "Master League II | TH14 - 16",
        },
      ],
      expectedOrder: [buildValidCwlTag(45), buildValidCwlTag(44)],
    },
    {
      name: "rejects Masters 4 [A] and falls back to Crystal League I",
      rows: [
        {
          tag: buildValidCwlTag(46),
          name: "Gold Anchor",
          leagueLabel: "Gold League I",
          rosterTitle: "Gold 1 | TH13 and below",
        },
        {
          tag: buildValidCwlTag(47),
          name: "Crystal Fallback",
          leagueLabel: "Crystal League I",
          rosterTitle: "Masters 4 [A] | TH17 - 18",
        },
        {
          tag: buildValidCwlTag(48),
          name: "Crystal Anchor",
          leagueLabel: "Crystal League I",
          rosterTitle: "Crystal 1 | TH13 and below",
        },
      ],
      expectedOrder: [buildValidCwlTag(48), buildValidCwlTag(47), buildValidCwlTag(46)],
    },
    {
      name: "rejects Legend 2 as malformed Legend syntax and leaves it in the unknown group",
      rows: [
        {
          tag: buildValidCwlTag(49),
          name: "Legend Exact",
          leagueLabel: "Unranked",
          rosterTitle: "Legend | Showcase",
        },
        {
          tag: buildValidCwlTag(50),
          name: "Legend League",
          leagueLabel: "Unranked",
          rosterTitle: "Legend League | Showcase",
        },
        {
          tag: buildValidCwlTag(51),
          name: "Broken Alpha",
          leagueLabel: null,
          rosterTitle: "Broken Roster",
        },
        {
          tag: buildValidCwlTag(52),
          name: "Broken Zulu",
          leagueLabel: null,
          rosterTitle: "Broken Roster",
        },
        {
          tag: buildValidCwlTag(53),
          name: "Legend Invalid",
          leagueLabel: null,
          rosterTitle: "Legend 2 | Showcase",
        },
      ],
      expectedOrder: [
        buildValidCwlTag(49),
        buildValidCwlTag(50),
        buildValidCwlTag(51),
        buildValidCwlTag(52),
        buildValidCwlTag(53),
      ],
    },
  ])("$name", async ({ rows, expectedOrder }) => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce(rows.map((row) => buildCwlTrackedClanSeasonRow(row)));
    prismaMock.roster.findMany.mockResolvedValueOnce(
      rows.map((row, index) =>
        buildCwlRosterRow({
          tag: row.tag,
          title: row.rosterTitle,
          lifecycleState: index % 3 === 0 ? "OPEN" : index % 3 === 1 ? "ACTIVE" : "CLOSED",
          postedMessageUrl: index % 2 === 0 ? `https://discord.com/channels/1/2/${index + 50}` : null,
          postedAt: index % 2 === 0 ? new Date(`2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`) : null,
          createdAt: new Date(`2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
        }),
      ),
    );

    const rowsResult = await listCwlTrackedClansForDetailedDisplay({
      season: "2026-07",
      guildId: "guild-1",
    });

    expect(rowsResult.map((row) => row.tag)).toEqual(expectedOrder);
  });

  it("falls back to leagueLabel when the roster title is missing or unparseable", async () => {
    const fallbackRows = [
      {
        tag: buildValidCwlTag(20),
        name: "Fallback Champion",
        leagueLabel: "Champion League I",
        rosterTitle: null,
      },
      {
        tag: buildValidCwlTag(21),
        name: "Fallback Master",
        leagueLabel: "Master League II",
        rosterTitle: "Not a CWL roster",
      },
      {
        tag: buildValidCwlTag(22),
        name: "Fallback Unknown",
        leagueLabel: null,
        rosterTitle: null,
      },
    ];

    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce(
      fallbackRows.map((row) => buildCwlTrackedClanSeasonRow(row)),
    );
    prismaMock.roster.findMany.mockResolvedValueOnce(
      fallbackRows.map((row, index) =>
        buildCwlRosterRow({
          tag: row.tag,
          title: row.rosterTitle,
          lifecycleState: index === 0 ? "OPEN" : "ACTIVE",
          postedMessageUrl: null,
          postedAt: null,
          createdAt: new Date(`2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
        }),
      ),
    );

    const rows = await listCwlTrackedClansForDetailedDisplay({
      season: "2026-07",
      guildId: "guild-1",
    });

    expect(rows.map((row) => row.tag)).toEqual([
      fallbackRows[0].tag,
      fallbackRows[1].tag,
      fallbackRows[2].tag,
    ]);
  });

  it("keeps malformed and unknown rows at the end with deterministic tie-breakers", async () => {
    const validRow = {
      tag: buildValidCwlTag(30),
      name: "Valid Champion",
      leagueLabel: "Champion League I",
      rosterTitle: "Champion 3 | Serious CWL",
    };
    const malformedRows = [
      {
        tag: buildValidCwlTag(31),
        name: "Alpha Broken",
        leagueLabel: null,
        rosterTitle: null,
      },
      {
        tag: buildValidCwlTag(32),
        name: "Beta Broken",
        leagueLabel: "Unranked",
        rosterTitle: "Broken Roster",
      },
      {
        tag: buildValidCwlTag(33),
        name: "Alpha Broken 2",
        leagueLabel: "Unknown",
        rosterTitle: "Broken Roster",
      },
      {
        tag: buildValidCwlTag(34),
        name: "Legend Invalid",
        leagueLabel: null,
        rosterTitle: "Legend 2 | Showcase",
      },
      {
        tag: buildValidCwlTag(35),
        name: "Foxtrot Broken",
        leagueLabel: null,
        rosterTitle: "Masters 1 [F] | TH18 175k+",
      },
      {
        tag: buildValidCwlTag(36),
        name: "Zulu Broken",
        leagueLabel: null,
        rosterTitle: "Masters 1 [Z] | TH18 175k+",
      },
    ];

    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce(
      [validRow, ...malformedRows].map((row) => buildCwlTrackedClanSeasonRow(row)),
    );
    prismaMock.roster.findMany.mockResolvedValueOnce(
      [validRow, ...malformedRows].map((row, index) =>
        buildCwlRosterRow({
          tag: row.tag,
          title: row.rosterTitle,
          lifecycleState: index % 2 === 0 ? "OPEN" : "ACTIVE",
          postedMessageUrl: null,
          postedAt: null,
          createdAt: new Date(`2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
        }),
      ),
    );

    const rows = await listCwlTrackedClansForDetailedDisplay({
      season: "2026-07",
      guildId: "guild-1",
    });

    expect(rows.map((row) => row.tag)).toEqual([
      validRow.tag,
      malformedRows[0].tag,
      malformedRows[2].tag,
      malformedRows[1].tag,
      malformedRows[3].tag,
      malformedRows[4].tag,
      malformedRows[5].tag,
    ]);
  });
});
