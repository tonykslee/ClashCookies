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
  externalPlayerWeightCurrent: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
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

function makeRosterEmojiClient() {
  const makeEmoji = (name: string, rendered: string) => ({
    id: `${name}-id`,
    name,
    animated: false,
    toString: () => rendered,
  });

  const emojis = new Map([
    ["house", makeEmoji("house", "<:house:111>")],
    ["th18", makeEmoji("th18", "<:th18:118>")],
  ]);

  return {
    application: {
      fetch: vi.fn().mockResolvedValue(undefined),
      emojis: {
        fetch: vi.fn().mockResolvedValue(emojis),
      },
    },
  } as any;
}

function flattenComponentRows(components: any[]): any[] {
  return components.flatMap((row) => {
    const rowJson = row.toJSON?.() ?? row;
    return Array.isArray(rowJson?.components) ? rowJson.components : [];
  });
}

function makeValidRosterPlayerTag(index: number): string {
  const alphabet = ["0", "2", "8", "9"];
  const normalizedIndex = Math.max(0, Math.trunc(index));
  let remaining = normalizedIndex;
  const digits = [0, 0, 0, 0];
  for (let position = digits.length - 1; position >= 0; position -= 1) {
    digits[position] = remaining % alphabet.length;
    remaining = Math.trunc(remaining / alphabet.length);
  }
  return `#PQL${digits.map((digit) => alphabet[digit] ?? "0").join("")}`;
}

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
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.upsert.mockResolvedValue({} as never);
    prismaMock.externalPlayerWeightCurrent.deleteMany.mockResolvedValue({ count: 0 });
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

  it("logs town hall source diagnostics and reuses live refresh data when refreshed snapshots are still invisible", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      { playerTag: "#298CG8UJG", linkedName: "Player 298", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
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
      { playerTag: "#298CG8UJG", playerName: "Player 298", townHall: null },
    ]);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockImplementation(async ({ cocService }) => {
      await cocService?.getPlayerRaw("#298CG8UJG", { suppressTelemetry: true });
      return {
        playerCount: 1,
        updatedCount: 1,
      };
    });
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        townHallLevel: 15,
        clan: { tag: "#2QG2C08UP" },
      }),
    } as any;
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const result = await rosterService.signupLinkedAccounts({
        rosterId: "roster-1",
        groupKey: "confirmed",
        discordUserId: "111111111111111111",
        cocService,
      });

      expect(result).toMatchObject({
        outcome: "created",
        createdTags: ["#298CG8UJG"],
      });
      expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#298CG8UJG", {
        suppressTelemetry: true,
      });
      expect(todoSnapshotServiceMock.refreshSnapshotsForPlayerTags).toHaveBeenCalledWith({
        playerTags: ["#298CG8UJG"],
        cocService,
      });

      const lastCall = consoleInfoSpy.mock.calls[consoleInfoSpy.mock.calls.length - 1] ?? [];
      const logLine = String(lastCall[0] ?? "");
      expect(logLine).toContain("[roster-townhall] ");
      const payload = JSON.parse(logLine.replace(/^\[roster-townhall\]\s*/, ""));
      expect(payload).toMatchObject({
        roster_id: "roster-1",
        roster_type: "CWL",
        roster_clan_tag: "#2QG2C08UP",
        requested_player_tags: ["#298CG8UJG"],
        linked_tags: ["#298CG8UJG"],
        coc_service_present: true,
        live_refresh_invoked: true,
        blocked_unavailable_tags: [],
        blocked_out_of_range_tags: [],
        blocked_tags: [],
      });
      expect(payload.resolution).toEqual([
        expect.objectContaining({
          player_tag: "#298CG8UJG",
          source: "live_refresh",
          town_hall: 15,
          primary_source_hit: false,
          snapshot_hit: false,
          live_refresh_invoked: true,
        }),
      ]);
    } finally {
      consoleInfoSpy.mockRestore();
    }
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
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        latestTownHall: 16,
        latestKnownWeight: 42_000,
        lastSyncedAt: new Date("2026-04-20T01:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        latestTownHall: 15,
        latestKnownWeight: 55_000,
        lastSyncedAt: new Date("2026-04-20T01:05:00.000Z"),
      },
    ] as any);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValueOnce([
      {
        playerTag: "#PQL0289",
        trophies: 5200,
        weight: 99_000,
        sourceSyncedAt: new Date("2026-04-20T01:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        trophies: 5400,
        weight: 88_000,
        sourceSyncedAt: new Date("2026-04-20T01:05:00.000Z"),
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
        weight: 88_000,
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
      "**[CWL Alpha Signup](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP)** Champion League II",
    );
    expect(description).toContain("**Confirmed - 1**");
    expect(description).toContain("**Substitute - 1**");
    expect(description).toContain("TonyLee");
    expect(description).toContain("Rising Dawn");
    expect(description).toContain("Gabbar");
    expect(description).toContain("\nTotal 2/");
    expect(description).not.toContain("```");
    expect(description).not.toContain("<@");
    expect((headerLine ?? "").replace(/`/g, "").indexOf("PLAYER")).toBe((confirmedRow ?? "").replace(/`/g, "").indexOf("Alpha"));
    expect((headerLine ?? "").replace(/`/g, "").indexOf("USERNAME")).toBe((confirmedRow ?? "").replace(/`/g, "").indexOf("TonyLee"));
    expect((headerLine ?? "").replace(/`/g, "").indexOf("CLAN")).toBe((confirmedRow ?? "").replace(/`/g, "").indexOf("Rising Dawn"));
    expect((headerLine ?? "").replace(/`/g, "").indexOf("USERNAME")).toBe((substituteRow ?? "").replace(/`/g, "").indexOf("-"));
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

  it("renders a customized posted roster board using saved ordered columns and sort mode", async () => {
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
      maxMembers: 50,
      maxAccountsPerUser: null,
      minTownhall: 13,
      maxTownhall: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      sortBy: "weight",
      displayColumns: JSON.stringify([
        "player_name",
        "discord_username",
        "clan_name",
        "weight",
      ]),
      importMembers: false,
      postButtonMode: "standard",
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
    prismaMock.rosterSignup.findMany.mockResolvedValueOnce([
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
        groupId: "group-confirmed",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        discordUserId: "222222222222222222",
        signedUpAt: new Date("2026-04-20T00:05:00.000Z"),
        createdAt: new Date("2026-04-20T00:05:00.000Z"),
        updatedAt: new Date("2026-04-20T00:05:00.000Z"),
        group: {
          id: "group-confirmed",
          key: "confirmed",
          name: "Confirmed",
          description: "Primary roster members",
          sortOrder: 0,
        },
      },
    ] as any);
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      { playerTag: "#PQL0289", discordUsername: "alpha-user" },
      { playerTag: "#QGRJ2222", discordUsername: "bravo-user" },
    ] as any);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValueOnce([
      {
        playerTag: "#PQL0289",
        trophies: 5200,
        weight: 42_000,
        sourceSyncedAt: new Date("2026-04-20T01:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        trophies: 5400,
        weight: null,
        sourceSyncedAt: new Date("2026-04-20T01:05:00.000Z"),
      },
    ] as any);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValueOnce([
      {
        playerTag: "#PQL0289",
        weight: 40_000,
        measuredAt: new Date("2026-04-20T02:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        weight: 55_000,
        measuredAt: new Date("2026-04-20T02:05:00.000Z"),
      },
    ] as any);
    todoSnapshotServiceMock.listSnapshotsByClanTag.mockResolvedValueOnce([
      {
        playerTag: "#PQL0289",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Dawn",
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Dawn",
      },
    ] as any);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue(null as any);

    const payload = await rosterService.buildRosterSignupPayload("roster-1");

    expect(payload).toBeTruthy();
    const description = payload?.embed.toJSON().description ?? "";
    const lines = description.split("\n");
    const headerLine = lines.find((line) => line.startsWith("`PLAYER"));
    const bravoRowIndex = lines.findIndex((line) => line.startsWith("`") && line.includes("Bravo"));
    const alphaRowIndex = lines.findIndex((line) => line.startsWith("`") && line.includes("Alpha"));
    const bravoRowLine = lines.find((line) => line.startsWith("`") && line.includes("Bravo")) ?? "";
    expect(headerLine?.length).toBeGreaterThan(0);
    expect(headerLine?.length).toBe(bravoRowLine.length);
    expect(headerLine).toContain("PLAYER");
    expect(headerLine).toContain("USERNAME");
    expect(headerLine).toContain("CLAN");
    expect(headerLine).toContain("Weight");
    expect(headerLine).not.toContain("Player name");
    expect(headerLine).not.toContain("Discord username");
    expect(headerLine).not.toContain("Clan name");
    expect(bravoRowIndex).toBeGreaterThan(-1);
    expect(alphaRowIndex).toBeGreaterThan(-1);
    expect(bravoRowIndex).toBeLessThan(alphaRowIndex);
    expect(description).toContain("bravo-user");
    expect(description).toContain("55k");
    expect(description).toContain("40k");
    expect(description).toContain("Min. TH 13");
    expect(description).not.toContain("```");
  });

  it("renders optional weight source and weight age columns from the resolved current-weight source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    try {
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
        sortBy: null,
        displayColumns: JSON.stringify(["player_name", "weight", "weight_source", "weight_age"]),
        minTownhall: 13,
        maxTownhall: null,
        maxMembers: 50,
        maxAccountsPerUser: null,
        rosterRoleId: null,
        allowMultiSignup: true,
        importMembers: false,
      } as any);
      prismaMock.rosterSignup.findMany.mockResolvedValueOnce([
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
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-20T00:05:00.000Z"),
          createdAt: new Date("2026-04-20T00:05:00.000Z"),
          updatedAt: new Date("2026-04-20T00:05:00.000Z"),
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: "Primary roster members",
            sortOrder: 0,
          },
        },
      ] as any);
      prismaMock.playerLink.findMany.mockResolvedValueOnce([
        { playerTag: "#PQL0289", discordUsername: "alpha-user" },
        { playerTag: "#QGRJ2222", discordUsername: "bravo-user" },
      ] as any);
      prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
        {
          playerTag: "#PQL0289",
          latestTownHall: 16,
          latestKnownWeight: 42_000,
          lastSyncedAt: new Date("2026-04-22T10:00:00.000Z"),
        },
      ] as any);
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValueOnce([
        {
          playerTag: "#PQL0289",
          trophies: 5200,
          weight: 99_000,
          sourceSyncedAt: new Date("2026-04-22T10:00:00.000Z"),
        },
        {
          playerTag: "#QGRJ2222",
          trophies: 5400,
          weight: 88_000,
          sourceSyncedAt: new Date("2026-04-22T08:00:00.000Z"),
        },
      ] as any);
      prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValueOnce([
        {
          playerTag: "#QGRJ2222",
          weight: 55_000,
          measuredAt: new Date("2026-04-21T09:00:00.000Z"),
        },
      ] as any);
      todoSnapshotServiceMock.listSnapshotsByClanTag.mockResolvedValueOnce([
        {
          playerTag: "#PQL0289",
          clanTag: "#2QG2C08UP",
          clanName: "Rising Dawn",
        },
        {
          playerTag: "#QGRJ2222",
          clanTag: "#2QG2C08UP",
          clanName: "Rising Dawn",
        },
      ] as any);
      prismaMock.cwlTrackedClan.findFirst.mockResolvedValueOnce(null as any);

      const payload = await rosterService.buildRosterSignupPayload("roster-1");
      const description = payload?.embed.toJSON().description ?? "";
      expect(description).toContain("SOURCE");
      expect(description).toContain("AGE");
      expect(description).toContain("FWA");
      expect(description).toContain("Manual");
      expect(description).toContain("0d 2h");
      expect(description).toContain("1d 3h");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders townhall icons and row indexes in displayed order", async () => {
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
      sortBy: "player_name",
      displayColumns: JSON.stringify(["player_name", "townhall_icons", "index"]),
      minTownhall: 13,
      maxTownhall: null,
      maxMembers: 50,
      maxAccountsPerUser: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      importMembers: false,
    } as any);
    prismaMock.rosterSignup.findMany.mockResolvedValueOnce([
      {
        id: "signup-1",
        rosterId: "roster-1",
        groupId: "group-confirmed",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        discordUserId: "222222222222222222",
        signedUpAt: new Date("2026-04-20T00:05:00.000Z"),
        createdAt: new Date("2026-04-20T00:05:00.000Z"),
        updatedAt: new Date("2026-04-20T00:05:00.000Z"),
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
    prismaMock.playerLink.findMany.mockResolvedValueOnce([
      { playerTag: "#QGRJ2222", discordUsername: "bravo-user" },
      { playerTag: "#PQL0289", discordUsername: "alpha-user" },
    ] as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValueOnce([
      { playerTag: "#QGRJ2222", playerName: "Bravo", townHall: 18 },
      { playerTag: "#PQL0289", playerName: "Alpha", townHall: 8 },
    ] as any);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValueOnce([] as any);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([] as any);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValueOnce([] as any);
    todoSnapshotServiceMock.listSnapshotsByClanTag.mockResolvedValueOnce([
      { playerTag: "#QGRJ2222", clanTag: "#2QG2C08UP", clanName: "Rising Dawn" },
      { playerTag: "#PQL0289", clanTag: "#2QG2C08UP", clanName: "Rising Dawn" },
    ] as any);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValueOnce(null as any);

    const payload = await rosterService.buildRosterSignupPayload("roster-1", null, {
      emojiClient: makeRosterEmojiClient(),
    });
    const description = payload?.embed.toJSON().description ?? "";
    const lines = description.split("\n");
    const headerLine = lines.find((line) => line.startsWith("`PLAYER")) ?? "";
    const alphaRowIndex = lines.findIndex((line) => line.startsWith("`") && line.includes("Alpha"));
    const bravoRowIndex = lines.findIndex((line) => line.startsWith("`") && line.includes("Bravo"));
    const bravoRow = lines.find((line) => line.startsWith("`") && line.includes("Bravo")) ?? "";
    const alphaRow = lines.find((line) => line.startsWith("`") && line.includes("Alpha")) ?? "";

    expect(headerLine).toContain("PLAYER");
    expect(headerLine).toContain("<:house:111>");
    expect(headerLine).toContain("INDEX");
    expect(alphaRowIndex).toBeGreaterThan(-1);
    expect(bravoRowIndex).toBeGreaterThan(-1);
    expect(alphaRowIndex).toBeLessThan(bravoRowIndex);
    expect(bravoRow).toContain("<:th18:118>");
    expect(alphaRow).toContain("8");
    expect(alphaRow).toContain("1");
    expect(bravoRow).toContain("2");
  });

  it("renders Min. TH as a dash when no minimum town hall is configured", async () => {
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
      maxMembers: 50,
      maxAccountsPerUser: null,
      minTownhall: null,
      maxTownhall: null,
      rosterRoleId: null,
      allowMultiSignup: true,
      sortBy: null,
      displayColumns: null,
      importMembers: false,
      postButtonMode: "standard",
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
    prismaMock.rosterSignup.findMany.mockResolvedValueOnce([
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
    prismaMock.playerLink.findMany.mockResolvedValueOnce([] as any);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValueOnce([] as any);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([] as any);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([] as any);
    todoSnapshotServiceMock.listSnapshotsByClanTag.mockResolvedValueOnce([
      {
        playerTag: "#PQL0289",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Dawn",
      },
    ] as any);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue(null as any);

    const payload = await rosterService.buildRosterSignupPayload("roster-1");

    expect(payload).toBeTruthy();
    const description = payload?.embed.toJSON().description ?? "";
    expect(description).toContain("Min. TH -");
    expect(description).not.toContain("Min. TH ##");
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
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      name: "CWL Alpha",
      leagueLabel: "Champion League II",
    });
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
      "**[CWL Alpha Signup](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP)** Champion League II",
    );
  });

  it("keeps a live-recovered town hall visible when the posted roster payload is rebuilt", async () => {
    prismaMock.rosterSignup.findMany.mockResolvedValue([
      {
        id: "signup-1",
        rosterId: "roster-1",
        groupId: "group-confirmed",
        playerTag: "#298CG8UJG",
        playerName: "Player 298",
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
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockImplementation(async ({ cocService }) => {
      await cocService?.getPlayerRaw("#298CG8UJG", { suppressTelemetry: true });
      return {
        playerCount: 1,
        updatedCount: 1,
      };
    });
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([
      {
        playerTag: "#298CG8UJG",
        townHall: 15,
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        cwlClanTag: "#2QG2C08UP",
        cwlClanName: "CWL Alpha",
      },
    ] as any);
    cwlStateServiceMock.listSeasonRosterForClan.mockResolvedValue([
      {
        playerTag: "#298CG8UJG",
        playerName: "Player 298",
        townHall: null,
      },
    ] as any);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        townHallLevel: 15,
        clan: { tag: "#2QG2C08UP" },
      }),
    } as any;

    const payload = await rosterService.refreshRosterSignupPayload("roster-1", cocService);

    expect(todoSnapshotServiceMock.refreshSnapshotsForPlayerTags).toHaveBeenCalledWith({
      playerTags: ["#298CG8UJG"],
      cocService,
    });
    expect(cocService.getPlayerRaw).toHaveBeenCalledWith("#298CG8UJG", {
      suppressTelemetry: true,
    });
    expect(payload).toBeTruthy();
    const description = String(payload?.embed.toJSON().description ?? "");
    expect(description).toContain("`15 Player 298");
    expect(description).not.toContain("`- Player 298");
  });

  it("falls back cleanly when no persisted CWL league label is available", async () => {
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
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
      "**[CWL Alpha Signup](https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP)** CWL",
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

  it("builds the manager add-user panel with chunked linked-player menus and a disabled confirm button until required selections exist", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValueOnce(
      Array.from({ length: 30 }, (_, index) => {
        return {
          playerTag: makeValidRosterPlayerTag(index),
          linkedName: `Player ${index + 1}`,
          linkedAt: new Date("2026-04-20T00:00:00.000Z"),
        };
      }),
    );

    const opened = await rosterService.createRosterManagerUserSelectionPanel({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
      mode: "add_user",
    });
    expect(opened).toMatchObject({ outcome: "ready" });
    if (opened.outcome !== "ready") return;

    const openedJson = opened.panel.embed.toJSON();
    expect(String(openedJson.title ?? "")).toBe("Adding Roster Users");
    expect(String(openedJson.description ?? "")).toContain("Select a Discord user.");
    expect(String(openedJson.description ?? "")).toContain("Selected user: none");
    expect(String(openedJson.description ?? "")).toContain("Selected group: Confirmed");
    expect(String(openedJson.description ?? "")).toContain("Selected players: 0");

    const openedComponents = flattenComponentRows(opened.panel.components);
    expect(
      openedComponents
        .filter((component) => Array.isArray(component.options))
        .map((component) => component.placeholder ?? component.data?.placeholder),
    ).toEqual(["No linked players found"]);
    expect(
      openedComponents
        .filter((component) => typeof component.style === "number")
        .map((component) => ({ label: component.label ?? component.data?.label, disabled: Boolean(component.disabled ?? component.data?.disabled) })),
    ).toEqual([
      { label: "Select Group", disabled: false },
      { label: "Confirm", disabled: true },
      { label: "Cancel", disabled: false },
    ]);

    const selected = await rosterService.updateRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
      selectedDiscordUserId: "222222222222222222",
      selectedDiscordUserLabel: "Roster User (@rosteruser)",
    });
    expect(selected).toMatchObject({ outcome: "updated" });
    if (selected.outcome !== "updated") return;

    const selectedJson = selected.panel.embed.toJSON();
    expect(String(selectedJson.description ?? "")).toContain("Selected user: Roster User (@rosteruser)");
    expect(String(selectedJson.description ?? "")).toContain("Selected players: 0");
    const selectedComponents = flattenComponentRows(selected.panel.components);
    expect(
      selectedComponents
        .filter((component) => Array.isArray(component.options))
        .map((component) => component.placeholder ?? component.data?.placeholder),
    ).toEqual(["Select Players [1 - 25]", "Select Players [26 - 30]"]);
    expect(
      selectedComponents
        .filter((component) => typeof component.style === "number")
        .map((component) => ({ label: component.label ?? component.data?.label, disabled: Boolean(component.disabled ?? component.data?.disabled) })),
    ).toEqual([
      { label: "Select Group", disabled: false },
      { label: "Confirm", disabled: true },
      { label: "Cancel", disabled: false },
    ]);

    const selectedWithPlayers = await rosterService.updateRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
      selectedTags: [makeValidRosterPlayerTag(0), makeValidRosterPlayerTag(14)],
    });
    expect(selectedWithPlayers).toMatchObject({ outcome: "updated" });
    if (selectedWithPlayers.outcome !== "updated") return;
    expect(selectedWithPlayers.panel.selectedTags).toEqual([makeValidRosterPlayerTag(0), makeValidRosterPlayerTag(14)]);
    expect(
      flattenComponentRows(selectedWithPlayers.panel.components)
        .filter((component) => typeof component.style === "number")
        .map((component) => ({ label: component.label ?? component.data?.label, disabled: Boolean(component.disabled ?? component.data?.disabled) })),
    ).toEqual([
      { label: "Select Group", disabled: false },
      { label: "Confirm", disabled: false },
      { label: "Cancel", disabled: false },
    ]);

    const groupPicker = await rosterService.updateRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
      groupPickerVisible: true,
    });
    expect(groupPicker).toMatchObject({ outcome: "updated" });
    if (groupPicker.outcome !== "updated") return;
    expect(flattenComponentRows(groupPicker.panel.components)).toHaveLength(1);
    expect(String(groupPicker.panel.embed.toJSON().description ?? "")).toContain("Select a roster group to continue.");

    const restored = await rosterService.updateRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
      selectedGroupKey: "confirmed",
    });
    expect(restored).toMatchObject({ outcome: "updated" });
    if (restored.outcome !== "updated") return;
    expect(restored.panel.selectedTags).toEqual([makeValidRosterPlayerTag(0), makeValidRosterPlayerTag(14)]);
    expect(
      flattenComponentRows(restored.panel.components)
        .filter((component) => Array.isArray(component.options))
        .map((component) => component.placeholder ?? component.data?.placeholder),
    ).toEqual(["Select Players [1 - 25]", "Select Players [26 - 30]"]);
    expect(
      flattenComponentRows(restored.panel.components)
        .filter((component) => typeof component.style === "number")
        .map((component) => ({ label: component.label ?? component.data?.label, disabled: Boolean(component.disabled ?? component.data?.disabled) })),
    ).toEqual([
      { label: "Select Group", disabled: false },
      { label: "Confirm", disabled: false },
      { label: "Cancel", disabled: false },
    ]);
  });

  it("shows a clear empty state and keeps confirm disabled when the selected Discord user has no linked player accounts", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValueOnce([]);

    const opened = await rosterService.createRosterManagerUserSelectionPanel({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
      mode: "add_user",
    });
    if (opened.outcome !== "ready") {
      throw new Error("Expected roster selection panel to open.");
    }

    const updated = await rosterService.updateRosterSelectionPanel({
      sessionId: opened.panel.sessionId,
      discordUserId: "111111111111111111",
      selectedDiscordUserId: "222222222222222222",
      selectedDiscordUserLabel: "Empty User (@empty)",
    });
    expect(updated).toMatchObject({ outcome: "updated" });
    if (updated.outcome !== "updated") return;

    expect(String(updated.panel.embed.toJSON().description ?? "")).toContain(
      "No linked player accounts were found for that Discord user.",
    );
    expect(
      flattenComponentRows(updated.panel.components)
        .filter((component) => typeof component.style === "number")
        .map((component) => ({ label: component.label ?? component.data?.label, disabled: Boolean(component.disabled ?? component.data?.disabled) })),
    ).toEqual([
      { label: "Select Group", disabled: false },
      { label: "Confirm", disabled: true },
      { label: "Cancel", disabled: false },
    ]);
  });

  it("confirms manager add and remove flows through the roster mutation helpers", async () => {
    const addRosterSignupsForManagerSpy = vi
      .spyOn(rosterService, "addRosterSignupsForManager")
      .mockResolvedValue({
        outcome: "created",
        rosterId: "roster-1",
        groupKey: "confirmed",
        groupName: "Confirmed",
        requestedTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
        linkedTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
        createdTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
        duplicateTags: [],
        missingLinkedTags: [],
      } as any);
    const removeRosterSignupsAsManagerSpy = vi
      .spyOn(rosterService, "removeRosterSignupsAsManager")
      .mockResolvedValue({
        outcome: "removed",
        rosterId: "roster-1",
        removedTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
        missingTags: [],
      } as any);
    try {
      playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValueOnce([
        { playerTag: makeValidRosterPlayerTag(1), linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
        { playerTag: makeValidRosterPlayerTag(2), linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      ]);

      const addOpened = await rosterService.createRosterManagerUserSelectionPanel({
        rosterId: "roster-1",
        discordUserId: "111111111111111111",
        mode: "add_user",
      });
      if (addOpened.outcome !== "ready") throw new Error("Expected add panel to open.");
      await rosterService.updateRosterSelectionPanel({
        sessionId: addOpened.panel.sessionId,
        discordUserId: "111111111111111111",
        selectedDiscordUserId: "222222222222222222",
        selectedDiscordUserLabel: "Roster User (@rosteruser)",
      });
      await rosterService.updateRosterSelectionPanel({
        sessionId: addOpened.panel.sessionId,
        discordUserId: "111111111111111111",
        selectedTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
      });
      await rosterService.updateRosterSelectionPanel({
        sessionId: addOpened.panel.sessionId,
        discordUserId: "111111111111111111",
        selectedGroupKey: "confirmed",
      });
      const addConfirmed = await rosterService.confirmRosterSelectionPanel({
        sessionId: addOpened.panel.sessionId,
        discordUserId: "111111111111111111",
      });
      expect(addConfirmed).toMatchObject({
        outcome: "add_user",
        result: {
          outcome: "created",
          rosterId: "roster-1",
          groupKey: "confirmed",
          groupName: "Confirmed",
        },
      });
      expect(addRosterSignupsForManagerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rosterId: "roster-1",
          groupKey: "confirmed",
          playerTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
          updatedByDiscordUserId: "111111111111111111",
        }),
      );

      playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValueOnce([
        { playerTag: makeValidRosterPlayerTag(1), linkedName: "Alpha", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
        { playerTag: makeValidRosterPlayerTag(2), linkedName: "Bravo", linkedAt: new Date("2026-04-20T00:00:00.000Z") },
      ]);
      const removeOpened = await rosterService.createRosterManagerUserSelectionPanel({
        rosterId: "roster-1",
        discordUserId: "111111111111111111",
        mode: "remove_user",
      });
      if (removeOpened.outcome !== "ready") throw new Error("Expected remove panel to open.");
      await rosterService.updateRosterSelectionPanel({
        sessionId: removeOpened.panel.sessionId,
        discordUserId: "111111111111111111",
        selectedDiscordUserId: "222222222222222222",
        selectedDiscordUserLabel: "Roster User (@rosteruser)",
      });
      await rosterService.updateRosterSelectionPanel({
        sessionId: removeOpened.panel.sessionId,
        discordUserId: "111111111111111111",
        selectedTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
      });
      const removeConfirmed = await rosterService.confirmRosterSelectionPanel({
        sessionId: removeOpened.panel.sessionId,
        discordUserId: "111111111111111111",
      });
      expect(removeConfirmed).toMatchObject({
        outcome: "remove_user",
        result: {
          outcome: "removed",
          rosterId: "roster-1",
          removedTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
        },
      });
      expect(removeRosterSignupsAsManagerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rosterId: "roster-1",
          playerTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
          updatedByDiscordUserId: "111111111111111111",
        }),
      );
    } finally {
      addRosterSignupsForManagerSpy.mockRestore();
      removeRosterSignupsAsManagerSpy.mockRestore();
    }
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
    expect(todoSnapshotServiceMock.listSnapshotsByClanTag).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
      source: "clanTag",
    });
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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
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
