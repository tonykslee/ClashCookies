import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  roster: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  rosterGroup: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  rosterSignup: {
    findMany: vi.fn(),
    count: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  todoPlayerSnapshot: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
    upsert: vi.fn(),
  },
}));

const playerLinkServiceMock = vi.hoisted(() => ({
  listPlayerLinksForDiscordUser: vi.fn(),
}));

const cwlStateServiceMock = vi.hoisted(() => ({
  listSeasonRosterForClan: vi.fn(),
  getCurrentRoundForClan: vi.fn(),
}));

const cocServiceMock = vi.hoisted(() => ({
  getClan: vi.fn(),
}));

const todoSnapshotServiceMock = vi.hoisted(() => ({
  listSnapshotsByPlayerTags: vi.fn(),
  listSnapshotsByClanTag: vi.fn(),
  refreshSnapshotsForPlayerTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PlayerLinkService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerLinkService")>(
    "../src/services/PlayerLinkService",
  );
  return {
    ...actual,
    listPlayerLinksForDiscordUser: playerLinkServiceMock.listPlayerLinksForDiscordUser,
  };
});

vi.mock("../src/services/CwlStateService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/CwlStateService")>(
    "../src/services/CwlStateService",
  );
  return {
    ...actual,
    cwlStateService: cwlStateServiceMock,
  };
});

vi.mock("../src/services/TodoSnapshotService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/TodoSnapshotService")>(
    "../src/services/TodoSnapshotService",
  );
  return {
    ...actual,
    todoSnapshotService: todoSnapshotServiceMock,
  };
});

import {
  ROSTER_DEFAULT_GROUPS,
  rosterService,
} from "../src/services/RosterService";
import { resolveCurrentCwlSeasonKey } from "../src/services/CwlRegistryService";

describe("RosterService", () => {
  function mockConflictLookupForLifecycleState(
    conflictLifecycleState: "ACTIVE" | "OPEN" | "CLOSED" | "ARCHIVED",
  ) {
    let rosterSignupFindManyCallCount = 0;
    prismaMock.rosterSignup.findMany.mockImplementation(async (args: any) => {
      rosterSignupFindManyCallCount += 1;
      if (rosterSignupFindManyCallCount === 1) {
        return [];
      }

      const lifecycleFilter = args?.where?.roster?.lifecycleState?.in as string[] | undefined;
      if (!Array.isArray(lifecycleFilter)) {
        return [{ playerTag: "#PQL0289", rosterId: "archived-roster" }];
      }

      return lifecycleFilter.includes(conflictLifecycleState)
        ? [{ playerTag: "#PQL0289", rosterId: "archived-roster" }]
        : [];
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) =>
      callback(prismaMock as any),
    );
    prismaMock.roster.create.mockResolvedValue({ id: "roster-1" });
    prismaMock.roster.findUnique.mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
    prismaMock.roster.findFirst.mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
    prismaMock.roster.findMany.mockResolvedValue([
      {
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        lifecycleState: "OPEN",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: "111111111111111111",
        updatedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        _count: {
          groups: 2,
          signups: 2,
        },
      },
    ]);
    prismaMock.roster.update.mockResolvedValue({} as never);
    prismaMock.roster.delete.mockResolvedValue({} as never);
    prismaMock.rosterGroup.createMany.mockResolvedValue({ count: 2 });
    prismaMock.rosterGroup.findMany.mockResolvedValue([
      {
        id: "group-confirmed",
        key: "confirmed",
        name: "Confirmed",
        description: "Primary roster members",
        sortOrder: 0,
      },
      {
        id: "group-substitute",
        key: "substitute",
        name: "Substitute",
        description: "Reserve roster members",
        sortOrder: 1,
      },
    ]);
    prismaMock.rosterGroup.findFirst.mockResolvedValue({
      id: "group-confirmed",
      key: "confirmed",
      name: "Confirmed",
      description: "Primary roster members",
      sortOrder: 0,
    });
    prismaMock.rosterSignup.findMany.mockResolvedValue([]);
    prismaMock.rosterSignup.count.mockResolvedValue(0);
    prismaMock.rosterSignup.createMany.mockResolvedValue({ count: 0 });
    prismaMock.rosterSignup.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.rosterSignup.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      name: "CWL Alpha",
      leagueLabel: "Champion League II",
    });
    prismaMock.cwlTrackedClan.createMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.todoPlayerSnapshot.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _max: { lastUpdatedAt: null, updatedAt: null },
    });
    prismaMock.todoPlayerSnapshot.upsert.mockResolvedValue({} as never);
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([]);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([]);
    cwlStateServiceMock.getCurrentRoundForClan.mockResolvedValue(null);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([]);
    todoSnapshotServiceMock.listSnapshotsByClanTag.mockResolvedValue([]);
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockResolvedValue({
      playerCount: 0,
      updatedCount: 0,
    });
    cocServiceMock.getClan.mockReset();
    cocServiceMock.getClan.mockResolvedValue({
      name: "CWL Alpha",
      warLeague: { name: "Champion League II" },
    });
  });

  it("creates a roster with default Confirmed and Substitute groups", async () => {
    await rosterService.createRoster({
      guildId: "guild-1",
      rosterType: "cwl",
      title: "CWL Alpha Signup",
      timezone: "PST",
      createdByDiscordUserId: "111111111111111111",
    });

    expect(prismaMock.roster.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          guildId: "guild-1",
          rosterType: "CWL",
          title: "CWL Alpha Signup",
          timezone: "America/Los_Angeles",
          displayTimezone: "America/Los_Angeles",
        }),
      }),
    );
    expect(prismaMock.rosterGroup.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining(
        ROSTER_DEFAULT_GROUPS.map((group) =>
          expect.objectContaining({
            key: group.key,
            name: group.name,
          }),
        ),
      ),
    });
  });

  it("hydrates CWL tracked-clan metadata while creating a CWL roster", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 1 });

    await rosterService.createRoster({
      guildId: "guild-1",
      rosterType: "cwl",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      timezone: "PST",
      createdByDiscordUserId: "111111111111111111",
      cocService: cocServiceMock as any,
    });

    const season = resolveCurrentCwlSeasonKey();
    expect(prismaMock.cwlTrackedClan.createMany).toHaveBeenCalledWith({
      data: [
        {
          season,
          tag: "#2QG2C08UP",
          name: null,
          leagueLabel: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(cocServiceMock.getClan).toHaveBeenCalledWith("#2QG2C08UP");
    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledWith({
      where: {
        season,
        tag: "#2QG2C08UP",
        OR: [{ name: null }, { name: "" }, { leagueLabel: null }, { leagueLabel: "" }],
      },
      data: {
        name: "CWL Alpha",
        leagueLabel: "Champion League II",
      },
    });
  });

  it("signs up only the selected linked accounts and skips duplicates by player tag", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.rosterSignup.findMany
      .mockResolvedValueOnce([{ playerTag: "#PQL0289" }])
      .mockResolvedValueOnce([]);

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
      playerTags: ["#PQL0289", "#QGRJ2222"],
    });

    expect(result).toMatchObject({
      outcome: "created",
      rosterId: "roster-1",
      groupKey: "confirmed",
      groupName: "Confirmed",
      linkedTags: ["#PQL0289", "#QGRJ2222"],
      createdTags: ["#QGRJ2222"],
      duplicateTags: ["#PQL0289"],
      missingLinkedTags: [],
    });
    expect(prismaMock.rosterSignup.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "111111111111111111",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("reports the specific linked accounts missing town hall data when town hall gating is configured", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      maxMembers: null,
      maxAccountsPerUser: null,
      minTownhall: 13,
      maxTownhall: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      sortBy: null,
      importMembers: false,
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({
      outcome: "townhall_unavailable",
      blockedTags: ["#PQL0289", "#QGRJ2222"],
      blockedAccounts: [
        { playerTag: "#PQL0289", playerName: "Alpha" },
        { playerTag: "#QGRJ2222", playerName: "Bravo" },
      ],
    });
    expect(cwlStateServiceMock.listSeasonRosterForClan).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
    });
  });

  it("uses the CWL season roster town hall before snapshot fallback when available", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      maxMembers: null,
      maxAccountsPerUser: null,
      minTownhall: 13,
      maxTownhall: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      sortBy: null,
      importMembers: false,
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([
      { playerTag: "#PQL0289", playerName: "Alpha", townHall: 16 },
    ]);

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({
      outcome: "created",
      createdTags: ["#PQL0289"],
    });
    expect(todoSnapshotServiceMock.listSnapshotsByPlayerTags).not.toHaveBeenCalled();
  });

  it("uses the FWA catalog town hall before snapshot fallback when available", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "FWA",
      rosterCategory: "signup",
      title: "FWA Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      maxMembers: null,
      maxAccountsPerUser: null,
      minTownhall: 13,
      maxTownhall: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      sortBy: null,
      importMembers: false,
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      { playerTag: "#PQL0289", latestTownHall: 15 },
    ]);

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({
      outcome: "created",
      createdTags: ["#PQL0289"],
    });
    expect(todoSnapshotServiceMock.listSnapshotsByPlayerTags).not.toHaveBeenCalled();
  });

  it("falls back to persisted player snapshots when the primary roster source misses town hall", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      maxMembers: null,
      maxAccountsPerUser: null,
      minTownhall: 13,
      maxTownhall: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      sortBy: null,
      importMembers: false,
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([
      { playerTag: "#PQL0289", playerName: "Alpha", townHall: null },
    ]);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([
      { playerTag: "#PQL0289", townHall: 15 },
    ]);

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({
      outcome: "created",
      createdTags: ["#PQL0289"],
    });
    expect(todoSnapshotServiceMock.listSnapshotsByPlayerTags).toHaveBeenCalledWith({
      playerTags: ["#PQL0289"],
    });
  });

  it("uses a live player refresh for only the still-missing tags and reuses the persisted snapshot on later checks", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.roster.findUnique.mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      maxMembers: null,
      maxAccountsPerUser: null,
      minTownhall: 13,
      maxTownhall: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      sortBy: null,
      importMembers: false,
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([
      { playerTag: "#PQL0289", playerName: "Alpha", townHall: null },
    ]);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ playerTag: "#PQL0289", townHall: 14 }])
      .mockResolvedValueOnce([{ playerTag: "#PQL0289", townHall: 14 }]);
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockResolvedValue({
      playerCount: 1,
      updatedCount: 1,
    });
    const cocService = { getPlayerRaw: vi.fn() } as any;

    const first = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
      cocService,
    });
    const second = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
      cocService,
    });

    expect(first).toMatchObject({
      outcome: "created",
      createdTags: ["#PQL0289"],
    });
    expect(second).toMatchObject({
      outcome: "created",
      createdTags: ["#PQL0289"],
    });
    expect(todoSnapshotServiceMock.refreshSnapshotsForPlayerTags).toHaveBeenCalledTimes(1);
    expect(todoSnapshotServiceMock.refreshSnapshotsForPlayerTags).toHaveBeenCalledWith({
      playerTags: ["#PQL0289"],
      cocService,
    });
  });

  it("still blocks when the recovered town hall is out of range", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      maxMembers: null,
      maxAccountsPerUser: null,
      minTownhall: 15,
      maxTownhall: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      sortBy: null,
      importMembers: false,
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([
      { playerTag: "#PQL0289", playerName: "Alpha", townHall: null },
    ]);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ playerTag: "#PQL0289", townHall: 13 }]);
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockResolvedValue({
      playerCount: 1,
      updatedCount: 1,
    });

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
      cocService: { getPlayerRaw: vi.fn() } as any,
    });

    expect(result).toMatchObject({
      outcome: "townhall_out_of_range",
      blockedTags: ["#PQL0289"],
      blockedAccounts: [{ playerTag: "#PQL0289", playerName: "Alpha" }],
    });
  });

  it("allows signup to proceed when town hall data is missing and no town hall gating is configured", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({
      outcome: "created",
      linkedTags: ["#PQL0289"],
      createdTags: ["#PQL0289"],
      duplicateTags: [],
      missingLinkedTags: [],
    });
    expect(cwlStateServiceMock.listSeasonRosterForClan).not.toHaveBeenCalled();
  });

  it.each(["OPEN", "CLOSED", "ACTIVE"] as const)(
    "blocks signup when the same player is already signed up on another relevant %s roster",
    async (conflictLifecycleState) => {
      playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
        { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      ]);
      mockConflictLookupForLifecycleState(conflictLifecycleState);

      const result = await rosterService.signupLinkedAccounts({
        rosterId: "roster-1",
        groupKey: "confirmed",
        discordUserId: "111111111111111111",
      });

      expect(result).toMatchObject({
        outcome: "roster_conflict",
        rosterId: "roster-1",
        blockedTags: ["#PQL0289"],
        conflictingRosterIds: ["archived-roster"],
      });
      expect(prismaMock.rosterSignup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roster: expect.objectContaining({
              lifecycleState: expect.objectContaining({
                in: expect.arrayContaining([conflictLifecycleState]),
              }),
            }),
          }),
        }),
      );
    },
  );

  it("does not block signup when the only prior signup is on an archived roster", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    mockConflictLookupForLifecycleState("ARCHIVED");

    const result = await rosterService.signupLinkedAccounts({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({
      outcome: "created",
      rosterId: "roster-1",
      groupKey: "confirmed",
      linkedTags: ["#PQL0289"],
      createdTags: ["#PQL0289"],
      duplicateTags: [],
      missingLinkedTags: [],
    });
    expect(prismaMock.rosterSignup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roster: expect.objectContaining({
            lifecycleState: expect.objectContaining({
              in: expect.not.arrayContaining(["ARCHIVED"]),
            }),
          }),
        }),
      }),
    );
  });

  it("renders grouped signup entries and shows the compact roster board header", async () => {
    prismaMock.rosterSignup.findMany.mockResolvedValue([
      {
        id: "signup-1",
        rosterId: "roster-1",
        groupId: "group-confirmed",
        playerTag: "#PQL0289",
        playerName: "Alpha",
        discordUserId: "111111111111111111",
        signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        group: {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: "Primary roster members",
          sortOrder: 0,
        },
      },
      {
        id: "signup-2",
        rosterId: "roster-1",
        groupId: "group-substitute",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        discordUserId: "222222222222222222",
        signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        group: {
          id: "group-substitute",
          key: "substitute",
          name: "Substitute",
          description: "Reserve roster members",
          sortOrder: 1,
        },
      },
    ] as any);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        discordUsername: "TonyLee",
      },
      {
        playerTag: "#QGRJ2222",
        discordUsername: null,
      },
    ] as any);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Dawn",
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#2QG2C08UP",
        clanName: "Gabbar",
      },
    ] as any);
    todoSnapshotServiceMock.listSnapshotsByClanTag.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Crowns",
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "Rising Crowns",
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Crowns",
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "Rising Crowns",
      },
    ] as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha",
        townHall: 16,
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
      },
      {
        playerTag: "#OLD1111",
        playerName: "OldTimer",
        townHall: 14,
      },
    ] as any);

    const payload = await rosterService.buildRosterSignupPayload("roster-1");

    expect(payload).toBeTruthy();
    const description = payload?.embed.toJSON().description ?? "";
    const embedTitle = payload?.embed.toJSON().title ?? "";
    const lines = description.split("\n");
    const headerLine = lines.find((line) => line.startsWith("`TH "));
    const confirmedRow = lines.find((line) => line.startsWith("`16 Alpha"));
    const substituteRow = lines.find((line) => line.startsWith("`15 Bravo"));
    expect(headerLine).toBeTruthy();
    expect(confirmedRow).toBeTruthy();
    expect(substituteRow).toBeTruthy();
    expect(embedTitle).toBe("Rising Crowns");
    expect(description).toContain(
      "## [CWL Alpha Signup](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP) Champion League II",
    );
    expect(description).toContain("**Confirmed - 1**");
    expect(description).toContain("**Substitute - 1**");
    expect(description).toContain("TonyLee");
    expect(description).toContain("Rising Dawn");
    expect(description).toContain("Gabbar");
    expect(description).toContain("\nTotal 2/");
    expect(description).not.toContain("```");
    expect(description).not.toContain("<@");
    expect((headerLine ?? "").replace(/`/g, "").indexOf("Player")).toBe((confirmedRow ?? "").replace(/`/g, "").indexOf("Alpha"));
    expect((headerLine ?? "").replace(/`/g, "").indexOf("Discord")).toBe((confirmedRow ?? "").replace(/`/g, "").indexOf("TonyLee"));
    expect((headerLine ?? "").replace(/`/g, "").indexOf("Clan")).toBe((confirmedRow ?? "").replace(/`/g, "").indexOf("Rising Dawn"));
    expect((headerLine ?? "").replace(/`/g, "").indexOf("Discord")).toBe((substituteRow ?? "").replace(/`/g, "").indexOf("-"));
    expect(cocServiceMock.getClan).not.toHaveBeenCalled();
    const componentIds = payload?.components.flatMap((row) => {
      const rowJson = row.toJSON() as any;
      return Array.isArray(rowJson.components)
        ? rowJson.components.map((component: any) => component.custom_id ?? component.customId ?? component.data?.custom_id ?? component.data?.customId)
        : [];
    }) ?? [];
    expect(componentIds).toEqual(
      expect.arrayContaining([
        "roster-post-action:refresh:roster-1",
        "roster-post-action:signup:roster-1",
        "roster-post-action:optout:roster-1",
        "roster-post-action:settings:roster-1",
      ]),
    );
    const buttonJson = payload?.components[0]?.toJSON() as any;
    const buttons = buttonJson?.components ?? [];
    const refreshButton = buttons.find((button: any) => button.custom_id === "roster-post-action:refresh:roster-1");
    const settingsButton = buttons.find((button: any) => button.custom_id === "roster-post-action:settings:roster-1");
    expect(refreshButton?.label ?? refreshButton?.data?.label ?? null).toBeNull();
    expect(settingsButton?.label ?? settingsButton?.data?.label ?? null).toBeNull();
  });

  it("refreshes only rostered player tags before rebuilding the posted roster payload", async () => {
    prismaMock.rosterSignup.findMany.mockResolvedValue([
      {
        id: "signup-1",
        rosterId: "roster-1",
        groupId: "group-confirmed",
        playerTag: "#PQL0289",
        playerName: "Alpha",
        discordUserId: "111111111111111111",
        signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        group: {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: "Primary roster members",
          sortOrder: 0,
        },
      },
    ] as any);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 1 });
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        townHall: 15,
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
      },
    ] as any);
    todoSnapshotServiceMock.listSnapshotsByClanTag.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha",
        townHall: 15,
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "CWL Alpha",
      },
    ] as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha",
        townHall: 15,
      },
    ] as any);
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockResolvedValue({
      playerCount: 1,
      updatedCount: 1,
    });

    const payload = await rosterService.refreshRosterSignupPayload("roster-1", cocServiceMock as any);

    expect(todoSnapshotServiceMock.refreshSnapshotsForPlayerTags).toHaveBeenCalledWith(
      expect.objectContaining({
        playerTags: ["#PQL0289"],
        cocService: cocServiceMock,
      }),
    );
    expect(cocServiceMock.getClan).toHaveBeenCalledWith("#2QG2C08UP");
    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledWith({
      where: {
        season: resolveCurrentCwlSeasonKey(),
        tag: "#2QG2C08UP",
        OR: [{ name: null }, { name: "" }, { leagueLabel: null }, { leagueLabel: "" }],
      },
      data: {
        name: "CWL Alpha",
        leagueLabel: "Champion League II",
      },
    });
    expect(payload).toBeTruthy();
    expect(String(payload?.embed.toJSON().title ?? "")).toBe("CWL Alpha");
    expect(String(payload?.embed.toJSON().description ?? "")).toContain(
      "## [CWL Alpha Signup](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP) Champion League II",
    );
  });

  it("falls back cleanly when no persisted CWL league label is available", async () => {
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValueOnce({
      name: "CWL Alpha",
      leagueLabel: null,
    });
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);
    prismaMock.rosterGroup.findMany.mockResolvedValueOnce([
      {
        id: "group-confirmed",
        rosterId: "roster-1",
        key: "confirmed",
        name: "Confirmed",
        description: "Primary roster members",
        sortOrder: 0,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
    ] as any);
    prismaMock.rosterSignup.findMany.mockResolvedValueOnce([] as any);
    prismaMock.rosterSignup.count.mockResolvedValueOnce(0);
    const payload = await rosterService.buildRosterSignupPayload("roster-1");
    expect(String(payload?.embed.toJSON().description ?? "")).toContain(
      "## [CWL Alpha Signup](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP) CWL",
    );
  });

  it("builds a signup selection panel that lets a user choose linked accounts", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.rosterSignup.findMany.mockResolvedValue([{ playerTag: "#PQL0289" }]);

    const result = await rosterService.createRosterSignupSelectionPanel({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({ outcome: "ready" });
    if (result.outcome !== "ready") return;
    const payload = result.panel;
    const description = payload.embed.toJSON().description ?? "";
    expect(description).toContain("Choose a group and linked accounts for Confirmed.");
    expect(description).toContain("Selected: 0 / 2");
    const selectIds = payload.components.flatMap((row) => {
      const rowJson = row.toJSON() as any;
      return Array.isArray(rowJson.components)
        ? rowJson.components.map((component: any) => component.custom_id ?? component.customId ?? component.data?.custom_id ?? component.data?.customId)
        : [];
    });
    expect(selectIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^roster-selection:group:/),
        expect.stringMatching(/^roster-selection:account:/),
      ]),
    );
    expect(payload.selectedTags).toEqual([]);
  });

  it("signs up multiple selected accounts through the roster selection session", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#PQL0289", linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      { playerTag: "#QGRJ2222", linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
    ]);
    prismaMock.rosterSignup.findMany.mockResolvedValue([]);
    prismaMock.rosterSignup.createMany.mockResolvedValue({ count: 2 });

    const opened = await rosterService.createRosterSignupSelectionPanel({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });
    if (opened.outcome !== "ready") {
      throw new Error("Expected roster selection panel to open.");
    }

    const updated = await rosterService.updateRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
      selectedTags: ["#PQL0289", "#QGRJ2222"],
    });
    if (updated.outcome !== "updated") {
      throw new Error("Expected roster selection panel to update.");
    }

    const confirmed = await rosterService.confirmRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
    });

    expect(confirmed).toMatchObject({
      outcome: "signup",
      result: {
        outcome: "created",
        rosterId: "roster-1",
        groupKey: "confirmed",
        groupName: "Confirmed",
        linkedTags: ["#PQL0289", "#QGRJ2222"],
        createdTags: ["#PQL0289", "#QGRJ2222"],
        duplicateTags: [],
        missingLinkedTags: [],
      },
    });
    expect(prismaMock.rosterSignup.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PQL0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
        }),
        expect.objectContaining({
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "111111111111111111",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("lets users remove only their own signup entries", async () => {
    prismaMock.rosterSignup.findMany.mockResolvedValue([
      { playerTag: "#PQL0289" },
    ] as any);
    prismaMock.rosterSignup.deleteMany.mockResolvedValue({ count: 1 });

    const result = await rosterService.removeRosterSignups({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
      playerTags: ["#PQL0289", "#QGRJ2222"],
    });

    expect(result).toMatchObject({
      outcome: "removed",
      rosterId: "roster-1",
      removedTags: ["#PQL0289"],
      notOwnedTags: ["#QGRJ2222"],
    });
    expect(prismaMock.rosterSignup.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rosterId: "roster-1",
          discordUserId: "111111111111111111",
        }),
      }),
    );
  });

  it.each([
    ["closed", "CLOSED"],
    ["archived", "ARCHIVED"],
  ] as const)("blocks signup selection when the roster is %s", async (_label, lifecycleState) => {
    prismaMock.roster.findUnique.mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState,
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });

    const result = await rosterService.createRosterSignupSelectionPanel({
      rosterId: "roster-1",
      groupKey: "confirmed",
      discordUserId: "111111111111111111",
    });

    expect(result).toMatchObject({
      outcome: "roster_closed",
      rosterId: "roster-1",
    });
  });

  it.each(["OPEN", "CLOSED"] as const)(
    "allows managers to add, move, and remove roster entries on %s rosters",
    async (lifecycleState) => {
      prismaMock.roster.findUnique.mockResolvedValue({
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        lifecycleState,
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: "111111111111111111",
        updatedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      });
      prismaMock.playerLink.findMany.mockResolvedValue([
        {
          playerTag: "#PQL0289",
          discordUserId: "111111111111111111",
          playerName: "Alpha",
        },
        {
          playerTag: "#QGRJ2222",
          discordUserId: "222222222222222222",
          playerName: "Bravo",
        },
      ]);
      prismaMock.rosterSignup.findMany
        .mockResolvedValueOnce([]) // add existing rows
        .mockResolvedValueOnce([
          { playerTag: "#PQL0289", groupId: "group-confirmed" },
          { playerTag: "#QGRJ2222", groupId: "group-confirmed" },
        ] as any)
        .mockResolvedValueOnce([
          { playerTag: "#PQL0289" },
          { playerTag: "#QGRJ2222" },
        ] as any);
      prismaMock.rosterSignup.createMany.mockResolvedValue({ count: 2 });
      prismaMock.rosterSignup.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.rosterSignup.deleteMany.mockResolvedValue({ count: 2 });
      prismaMock.rosterGroup.findFirst.mockResolvedValueOnce({
        id: "group-confirmed",
        key: "confirmed",
        name: "Confirmed",
        description: "Primary roster members",
        sortOrder: 0,
      });
      prismaMock.rosterGroup.findFirst.mockResolvedValueOnce({
        id: "group-substitute",
        key: "substitute",
        name: "Substitute",
        description: "Reserve roster members",
        sortOrder: 1,
      });

      const added = await rosterService.addRosterSignupsForManager({
        rosterId: "roster-1",
        groupKey: "confirmed",
        playerTags: ["#PQL0289", "#QGRJ2222"],
        updatedByDiscordUserId: "999999999999999999",
      });
      const moved = await rosterService.moveRosterSignups({
        rosterId: "roster-1",
        groupKey: "substitute",
        playerTags: ["#PQL0289", "#QGRJ2222"],
        updatedByDiscordUserId: "999999999999999999",
      });
      const removed = await rosterService.removeRosterSignupsAsManager({
        rosterId: "roster-1",
        playerTags: ["#PQL0289", "#QGRJ2222"],
        updatedByDiscordUserId: "999999999999999999",
      });

      expect(added).toMatchObject({
        outcome: "created",
        linkedTags: ["#PQL0289", "#QGRJ2222"],
        createdTags: ["#PQL0289", "#QGRJ2222"],
        duplicateTags: [],
        missingLinkedTags: [],
      });
      expect(prismaMock.rosterSignup.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              rosterId: "roster-1",
              groupId: "group-confirmed",
              playerTag: "#PQL0289",
              playerName: "Alpha",
              discordUserId: "111111111111111111",
            }),
            expect.objectContaining({
              rosterId: "roster-1",
              groupId: "group-confirmed",
              playerTag: "#QGRJ2222",
              playerName: "Bravo",
              discordUserId: "222222222222222222",
            }),
          ]),
          skipDuplicates: true,
        }),
      );

      expect(moved).toMatchObject({
        outcome: "moved",
        groupKey: "substitute",
        movedTags: ["#PQL0289", "#QGRJ2222"],
        duplicateTags: [],
        missingTags: [],
      });
      expect(prismaMock.rosterSignup.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            rosterId: "roster-1",
            playerTag: { in: ["#PQL0289", "#QGRJ2222"] },
          }),
          data: { groupId: "group-substitute" },
        }),
      );

      expect(removed).toMatchObject({
        outcome: "removed",
        removedTags: ["#PQL0289", "#QGRJ2222"],
        notOwnedTags: [],
      });
      expect(prismaMock.rosterSignup.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            rosterId: "roster-1",
            playerTag: { in: ["#PQL0289", "#QGRJ2222"] },
          }),
        }),
      );
    },
  );

  it("rejects archived roster mutations for manager add, move, and remove actions", async () => {
    prismaMock.roster.findUnique.mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState: "ARCHIVED",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });

    const added = await rosterService.addRosterSignupsForManager({
      rosterId: "roster-1",
      groupKey: "confirmed",
      playerTags: ["#PQL0289", "#QGRJ2222"],
      updatedByDiscordUserId: "999999999999999999",
    });
    const moved = await rosterService.moveRosterSignups({
      rosterId: "roster-1",
      groupKey: "substitute",
      playerTags: ["#PQL0289", "#QGRJ2222"],
      updatedByDiscordUserId: "999999999999999999",
    });
    const removed = await rosterService.removeRosterSignupsAsManager({
      rosterId: "roster-1",
      playerTags: ["#PQL0289", "#QGRJ2222"],
      updatedByDiscordUserId: "999999999999999999",
    });

    expect(added).toMatchObject({
      outcome: "roster_archived",
      rosterId: "roster-1",
      groupKey: "confirmed",
      groupName: null,
      requestedTags: ["#PQL0289", "#QGRJ2222"],
      linkedTags: [],
      createdTags: [],
      duplicateTags: [],
      missingLinkedTags: ["#PQL0289", "#QGRJ2222"],
    });
    expect(moved).toMatchObject({
      outcome: "roster_archived",
      rosterId: "roster-1",
      groupKey: "substitute",
      requestedTags: ["#PQL0289", "#QGRJ2222"],
      movedTags: [],
      duplicateTags: [],
      missingTags: ["#PQL0289", "#QGRJ2222"],
    });
    expect(removed).toMatchObject({
      outcome: "roster_archived",
      rosterId: "roster-1",
      removedTags: [],
      ignoredTags: ["#PQL0289", "#QGRJ2222"],
      notOwnedTags: [],
    });
    expect(prismaMock.playerLink.findMany).not.toHaveBeenCalled();
    expect(prismaMock.rosterGroup.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.rosterSignup.findMany).not.toHaveBeenCalled();
    expect(prismaMock.rosterSignup.createMany).not.toHaveBeenCalled();
    expect(prismaMock.rosterSignup.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.rosterSignup.deleteMany).not.toHaveBeenCalled();
  });

  it("builds a manager readiness view from current CWL clan members, not stale season roster participants", async () => {
    prismaMock.rosterSignup.findMany.mockResolvedValue([
      {
        id: "signup-1",
        rosterId: "roster-1",
        groupId: "group-confirmed",
        playerTag: "#PQL0289",
        playerName: "Alpha",
        discordUserId: "111111111111111111",
        signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        group: {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: "Primary roster members",
          sortOrder: 0,
        },
      },
      {
        id: "signup-2",
        rosterId: "roster-1",
        groupId: "group-substitute",
        playerTag: "#ZZZZ1111",
        playerName: "Outlier",
        discordUserId: "333333333333333333",
        signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        group: {
          id: "group-substitute",
          key: "substitute",
          name: "Substitute",
          description: "Reserve roster members",
          sortOrder: 1,
        },
      },
    ] as any);
    prismaMock.rosterGroup.findMany.mockResolvedValue([
      {
        id: "group-confirmed",
        key: "confirmed",
        name: "Confirmed",
        description: "Primary roster members",
        sortOrder: 0,
      },
      {
        id: "group-substitute",
        key: "substitute",
        name: "Substitute",
        description: "Reserve roster members",
        sortOrder: 1,
      },
    ]);
    todoSnapshotServiceMock.listSnapshotsByClanTag.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha",
        townHall: 16,
        clanTag: "#2QG2C08UP",
        clanName: "Rising Crowns",
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "Rising Crowns",
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
        clanTag: "#2QG2C08UP",
        clanName: "Rising Crowns",
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "Rising Crowns",
      },
    ] as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha",
        townHall: 16,
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
      },
      {
        playerTag: "#OLD1111",
        playerName: "OldTimer",
        townHall: 14,
      },
    ] as any);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        discordUserId: "111111111111111111",
        discordUsername: "alpha-user",
      },
      {
        playerTag: "#QGRJ2222",
        discordUserId: "222222222222222222",
        discordUsername: "bravo-user",
      },
    ] as any);

    const report = await rosterService.buildRosterManagerReadinessText({ rosterId: "roster-1" });

    expect(report).toContain("CWL Alpha Signup");
    expect(report).toContain("Current clan members:");
    expect(report).toContain("Unregistered members:");
    expect(report).toContain("- Bravo `#QGRJ2222` <@222222222222222222>");
    expect(report).not.toContain("None");
    expect(report).toContain("Out-of-clan signups:");
    expect(report).toContain("- Outlier `#ZZZZ1111` <@333333333333333333>");
    expect(report).not.toContain("#OLD1111");
  });

  it("builds a manager readiness view from the current FWA clan membership table", async () => {
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-2",
      guildId: "guild-1",
      rosterType: "FWA",
      rosterCategory: "signup",
      title: "FWA Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
    prismaMock.rosterSignup.findMany.mockResolvedValueOnce([
      {
        id: "signup-1",
        rosterId: "roster-2",
        groupId: "group-confirmed",
        playerTag: "#PQL0289",
        playerName: "Alpha",
        discordUserId: "111111111111111111",
        signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        group: {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: "Primary roster members",
          sortOrder: 0,
        },
      },
    ] as any);
    prismaMock.rosterGroup.findMany.mockResolvedValueOnce([
      {
        id: "group-confirmed",
        key: "confirmed",
        name: "Confirmed",
        description: "Primary roster members",
        sortOrder: 0,
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValueOnce([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#PQL0289",
        playerName: "Alpha",
        townHall: 16,
      },
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 15,
      },
    ] as any);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        discordUserId: "111111111111111111",
        discordUsername: "alpha-user",
      },
      {
        playerTag: "#QGRJ2222",
        discordUserId: "222222222222222222",
        discordUsername: "bravo-user",
      },
    ] as any);

    const report = await rosterService.buildRosterManagerReadinessText({ rosterId: "roster-2" });

    expect(report).toContain("FWA Alpha Signup");
    expect(report).toContain("Current clan members:");
    expect(report).toContain("Unregistered members:");
    expect(report).toContain("- Bravo `#QGRJ2222` <@222222222222222222>");
    expect(report).not.toContain("#OLD1111");
  });

  it("renders closed rosters with disabled signup controls", async () => {
    prismaMock.roster.findUnique.mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState: "CLOSED",
      postedChannelId: "channel-1",
      postedMessageId: "message-1",
      postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
      postedAt: new Date("2026-04-20T00:00:00.000Z"),
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });

    const payload = await rosterService.buildRosterSignupPayload("roster-1");

    expect(payload).toBeTruthy();
    const componentIds = payload?.components.flatMap((row) => {
      const rowJson = row.toJSON() as any;
      return Array.isArray(rowJson.components)
        ? rowJson.components.map((component: any) => component.custom_id ?? component.customId ?? component.data?.custom_id ?? component.data?.customId)
        : [];
    }) ?? [];
    expect(componentIds).toEqual(
      expect.arrayContaining([
        "roster-post-action:refresh:roster-1",
        "roster-post-action:signup:roster-1",
        "roster-post-action:optout:roster-1",
        "roster-post-action:settings:roster-1",
      ]),
    );
    const buttonJson = payload?.components[0]?.toJSON() as any;
    const firstButton = buttonJson?.components?.[1];
    expect(Boolean(firstButton?.disabled ?? firstButton?.data?.disabled)).toBe(true);
  });

  it("updates roster lifecycle state explicitly for managers", async () => {
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-1",
    } as any);

    const result = await rosterService.updateRosterLifecycleState({
      rosterId: "roster-1",
      lifecycleState: "ARCHIVED",
      updatedByDiscordUserId: "999999999999999999",
    });

    expect(result).toEqual({
      outcome: "updated",
      rosterId: "roster-1",
      lifecycleState: "ARCHIVED",
    });
    expect(prismaMock.roster.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "roster-1" },
        data: expect.objectContaining({
          lifecycleState: "ARCHIVED",
          updatedByDiscordUserId: "999999999999999999",
        }),
      }),
    );
  });

  it("updates roster metadata explicitly for roster edit flows", async () => {
    prismaMock.roster.findUnique.mockResolvedValueOnce({
      id: "roster-1",
    } as any);
    prismaMock.roster.update.mockResolvedValueOnce({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup (Updated)",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/New_York",
      displayTimezone: "America/New_York",
      lifecycleState: "OPEN",
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "999999999999999999",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    } as any);

    const result = await rosterService.updateRoster({
      rosterId: "roster-1",
      title: "CWL Alpha Signup (Updated)",
      clanTag: "#2QG2C08UP",
      timezone: "America/New_York",
      displayTimezone: "America/New_York",
      updatedByDiscordUserId: "999999999999999999",
    });

    expect(result).toMatchObject({
      id: "roster-1",
      title: "CWL Alpha Signup (Updated)",
      clanTag: "#2QG2C08UP",
      timezone: "America/New_York",
      displayTimezone: "America/New_York",
    });
    expect(prismaMock.roster.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "roster-1" },
        data: expect.objectContaining({
          title: "CWL Alpha Signup (Updated)",
          clanTag: "#2QG2C08UP",
          timezone: "America/New_York",
          displayTimezone: "America/New_York",
          updatedByDiscordUserId: "999999999999999999",
        }),
      }),
    );
  });

  it("lists guild rosters with roster metadata and posting state", async () => {
    const rosters = await rosterService.listGuildRosters({
      guildId: "guild-1",
    });

    expect(rosters).toEqual([
      expect.objectContaining({
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        groupCount: 2,
        signupCount: 2,
      }),
    ]);
    expect(prismaMock.roster.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
        }),
      }),
    );
  });

  it("finds guild rosters by id and hard-deletes rosters explicitly", async () => {
    const found = await rosterService.findGuildRosterById({
      guildId: "guild-1",
      rosterId: "roster-1",
    });
    expect(found).toMatchObject({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
    });

    const deleted = await rosterService.deleteRoster({
      rosterId: "roster-1",
    });
    expect(deleted).toMatchObject({
      outcome: "deleted",
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
      },
    });
    expect(prismaMock.roster.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "roster-1" },
      }),
    );
  });
});
