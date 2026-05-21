import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InactiveWarService } from "../src/services/InactiveWarService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  heatMapRef: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
  fillerAccount: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { CompoReplacementService } from "../src/services/CompoReplacementService";

function makeTrackedClan(tag: string, name: string) {
  return {
    tag,
    name,
  };
}

function makeHeatMapRef() {
  return {
    weightMinInclusive: 0,
    weightMaxInclusive: 9_999_999,
    th18Count: 19,
    th17Count: 11,
    th16Count: 7,
    th15Count: 6,
    th14Count: 4,
    th13Count: 2,
    th12Count: 1,
    th11Count: 0,
    th10OrLowerCount: 0,
    sourceVersion: "test",
    refreshedAt: new Date("2026-04-10T16:00:00.000Z"),
  };
}

function makeMember(input: {
  clanTag: string;
  playerTag: string;
  playerName: string;
  weight: number | null;
  sourceSyncedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    playerName: input.playerName,
    townHall: 15,
    weight: input.weight,
    sourceSyncedAt: input.sourceSyncedAt ?? new Date("2026-04-10T16:30:00.000Z"),
  };
}

describe("CompoReplacementService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerActivity.findMany.mockReset();
    prismaMock.fillerAccount.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockResolvedValue([makeTrackedClan("#AAA111", "Alpha Clan")]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([
      { playerTag: "#P000000" },
      { playerTag: "#P000002" },
      { playerTag: "#P000028" },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves same-bucket replacement candidates from DB-only sources with stacked reasons", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({
        clanTag: "#AAA111",
        playerTag: "#P000000",
        playerName: "Alpha",
        weight: 145000,
      }),
      makeMember({
        clanTag: "#AAA111",
        playerTag: "#P000002",
        playerName: "Beta",
        weight: 145000,
      }),
      makeMember({
        clanTag: "#AAA111",
        playerTag: "#P000008",
        playerName: "Gamma",
        weight: 145000,
      }),
      makeMember({
        clanTag: "#AAA111",
        playerTag: "#P000020",
        playerName: "Delta",
        weight: 145000,
      }),
      makeMember({
        clanTag: "#AAA111",
        playerTag: "#P000028",
        playerName: "Epsilon",
        weight: 145000,
      }),
      makeMember({
        clanTag: "#AAA111",
        playerTag: "#P000080",
        playerName: "Zeta",
        weight: 165000,
      }),
      makeMember({
        clanTag: "#AAA111",
        playerTag: "#P000082",
        playerName: "Eta",
        weight: null,
      }),
      makeMember({
        clanTag: "#AAA111",
        playerTag: "#P000088",
        playerName: "Theta",
        weight: 145000,
      }),
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P000000", discordUserId: "111111111111111111" },
      { playerTag: "#P000002", discordUserId: null },
      { playerTag: "#P000008", discordUserId: "333333333333333333" },
      { playerTag: "#P000028", discordUserId: "555555555555555555" },
      { playerTag: "#P000088", discordUserId: "888888888888888888" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#P000008", lastSeenAt: new Date("2026-04-01T00:00:00.000Z") },
      { tag: "#P000020", lastSeenAt: new Date("2026-05-10T00:00:00.000Z") },
      { tag: "#P000028", lastSeenAt: new Date("2026-05-14T00:00:00.000Z") },
      { tag: "#P000088", lastSeenAt: new Date("2026-05-14T00:00:00.000Z") },
    ]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [
        {
          clanTag: "#AAA111",
          playerTag: "#P000020",
          playerName: "Delta",
          townHall: 15,
          missedWars: 2,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [],
        },
        {
          clanTag: "#AAA111",
          playerTag: "#P000028",
          playerName: "Epsilon",
          townHall: 15,
          missedWars: 1,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [],
        },
      ],
      trackedTags: ["#AAA111"],
      trackedNameByTag: new Map([
        ["#AAA111", "Alpha Clan"],
      ]),
      trackedBadgeByTag: new Map([
        ["#AAA111", null],
      ]),
      warnings: [],
      diagnosticNote: null,
    });

    const result = await new CompoReplacementService().resolveReplacementCandidates({
      guildId: "guild-1",
      weight: 145000,
    });

    expect(result.bucket).toBe("TH15");
    expect(result.inputWeight).toBe(145000);
    expect(prismaMock.fillerAccount.findMany).toHaveBeenCalled();
    expect(result.summaryByClan).toHaveLength(1);
    expect(result.summaryByClan[0]).toEqual({
      clanTag: "#AAA111",
      clanName: "Alpha Clan",
      uniqueCandidateCount: 5,
      fillerCount: 3,
      inactiveCount: 3,
      unlinkedCount: 2,
    });

    const byTag = new Map(result.candidates.map((row) => [row.playerTag, row] as const));
    expect([...byTag.keys()]).toEqual([
      "#P000000",
      "#P000002",
      "#P000020",
      "#P000028",
      "#P000008",
    ]);
    expect(result.candidates).toHaveLength(5);
    expect(byTag.get("#P000000")).toMatchObject({
      playerName: "Alpha",
      resolvedWeight: 145000,
      resolvedBucket: "TH15",
      discordUserId: "111111111111111111",
      discordMention: "<@111111111111111111>",
      reasons: {
        filler: true,
        inactive: false,
        unlinked: false,
      },
    });
    expect(byTag.get("#P000002")).toMatchObject({
      playerName: "Beta",
      resolvedWeight: 145000,
      resolvedBucket: "TH15",
      discordUserId: null,
      discordMention: null,
      reasons: {
        filler: true,
        inactive: false,
        unlinked: true,
      },
    });
    expect(byTag.get("#P000008")).toMatchObject({
      playerName: "Gamma",
      resolvedWeight: 145000,
      resolvedBucket: "TH15",
      discordUserId: "333333333333333333",
      discordMention: "<@333333333333333333>",
      reasons: {
        filler: false,
        inactive: true,
        unlinked: false,
      },
    });
    expect(byTag.get("#P000020")).toMatchObject({
      playerName: "Delta",
      resolvedWeight: 145000,
      resolvedBucket: "TH15",
      discordUserId: null,
      discordMention: null,
      reasons: {
        filler: false,
        inactive: true,
        unlinked: true,
      },
    });
    expect(byTag.get("#P000028")).toMatchObject({
      playerName: "Epsilon",
      resolvedWeight: 145000,
      resolvedBucket: "TH15",
      discordUserId: "555555555555555555",
      discordMention: "<@555555555555555555>",
      reasons: {
        filler: true,
        inactive: true,
        unlinked: false,
      },
    });

    expect(byTag.has("#P000080")).toBe(false);
    expect(byTag.has("#P000082")).toBe(false);
    expect(byTag.has("#P000088")).toBe(false);
  });
});
