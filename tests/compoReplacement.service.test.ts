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

function makeHeatMapRef(input: Partial<Record<
  "th18Count" | "th17Count" | "th16Count" | "th15Count" | "th14Count" | "th13Count" | "th12Count" | "th11Count" | "th10OrLowerCount",
  number
>> = {}) {
  return {
    weightMinInclusive: 0,
    weightMaxInclusive: 9_999_999,
    th18Count: input.th18Count ?? 19,
    th17Count: input.th17Count ?? 11,
    th16Count: input.th16Count ?? 7,
    th15Count: input.th15Count ?? 6,
    th14Count: input.th14Count ?? 4,
    th13Count: input.th13Count ?? 2,
    th12Count: input.th12Count ?? 1,
    th11Count: input.th11Count ?? 0,
    th10OrLowerCount: input.th10OrLowerCount ?? 0,
    sourceVersion: "test",
    refreshedAt: new Date("2026-04-10T16:00:00.000Z"),
  };
}

function makeContext(input: {
  members: Array<{ playerTag: string; playerName: string; resolvedWeight: number }>;
  bucketCounts: Record<string, number>;
  heatMapRef: ReturnType<typeof makeHeatMapRef>;
}) {
  return {
    trackedClanTags: ["#AAA111"],
    renderableClanTags: ["#AAA111"],
    latestSourceSyncedAt: null,
    heatMapRefs: [input.heatMapRef],
    clans: [
      {
        clanTag: "#AAA111",
        clanName: "Alpha Clan",
        shortName: "AA",
        base: {
          resolvedTotalWeight: input.members.reduce((sum, member) => sum + member.resolvedWeight, 0),
          unresolvedWeightCount: 0,
          memberCount: input.members.length,
          bucketCounts: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: 0,
            TH13: 0,
            TH12: 0,
            TH11: 0,
            TH10: 0,
            TH9: 0,
            TH8_OR_LOWER: 0,
            ...input.bucketCounts,
          },
        },
        members: input.members.map((member) => ({
          clanTag: "#AAA111",
          playerTag: member.playerTag,
          playerName: member.playerName,
          townHall: 15,
          resolvedWeight: member.resolvedWeight,
          resolvedBucket: null,
          resolvedWeightSource: "member",
        })),
      },
    ],
  } as any;
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
      surplusCount: 0,
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

  it("includes ordinary members from positive ACTUAL Auto-Detect surplus buckets and excludes non-surplus buckets", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P000090", discordUserId: "111111111111111111" },
      { playerTag: "#P000092", discordUserId: "222222222222222222" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [],
    } as any);

    const result = await new CompoReplacementService().resolveReplacementCandidates({
      guildId: "guild-1",
      weight: 145000,
      context: makeContext({
        members: [
          { playerTag: "#P000090", playerName: "Active TH17", resolvedWeight: 165000 },
          { playerTag: "#P000092", playerName: "Active TH15", resolvedWeight: 145000 },
        ],
        bucketCounts: { TH17: 1, TH15: 1 },
        heatMapRef: makeHeatMapRef({ th17Count: 0, th15Count: 2 }),
      }),
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      playerTag: "#P000090",
      resolvedBucket: "TH17",
      surplusDelta: 1,
      reasons: { filler: false, inactive: false, unlinked: false, surplus: true },
    });
    expect(result.summaryByClan[0]?.surplusCount).toBe(1);
  });

  it("normalizes lower weights into the <=TH13 display bucket for surplus detection", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P000088", discordUserId: "666666666666666666" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [],
    } as any);

    const result = await new CompoReplacementService().resolveReplacementCandidates({
      guildId: "guild-1",
      weight: 145000,
      context: makeContext({
        members: [
          { playerTag: "#P000088", playerName: "Lower TH", resolvedWeight: 100000 },
        ],
        bucketCounts: { TH11: 1 },
        heatMapRef: makeHeatMapRef({
          th18Count: 0,
          th17Count: 0,
          th16Count: 0,
          th15Count: 0,
          th14Count: 0,
          th13Count: 0,
          th12Count: 0,
          th11Count: 0,
          th10OrLowerCount: 0,
        }),
      }),
    });

    expect(result.candidates[0]).toMatchObject({
      resolvedBucket: "<=TH13",
      surplusDelta: 1,
      reasons: { surplus: true },
    });
  });

  it("stacks surplus and existing reasons, and allows multiple surplus buckets in one clan", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P000098", discordUserId: "333333333333333333" },
      { playerTag: "#P000099", discordUserId: "444444444444444444" },
      { playerTag: "#P000090", discordUserId: "555555555555555555" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([{ playerTag: "#P000099" }]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [],
    } as any);

    const result = await new CompoReplacementService().resolveReplacementCandidates({
      guildId: "guild-1",
      weight: 145000,
      context: makeContext({
        members: [
          { playerTag: "#P000098", playerName: "Active TH16", resolvedWeight: 155000 },
          { playerTag: "#P000099", playerName: "Filler TH15", resolvedWeight: 145000 },
          { playerTag: "#P000090", playerName: "Balanced TH17", resolvedWeight: 165000 },
        ],
        bucketCounts: { TH16: 1, TH15: 1, TH17: 1 },
        heatMapRef: makeHeatMapRef({ th16Count: 0, th15Count: 0, th17Count: 1 }),
      }),
    });

    expect(result.candidates.map((candidate) => candidate.playerTag)).toEqual([
      "#P000098",
      "#P000099",
    ]);
    const byTag = new Map(result.candidates.map((candidate) => [candidate.playerTag, candidate] as const));
    expect(byTag.get("#P000099")).toMatchObject({
      surplusDelta: 1,
      reasons: { filler: true, inactive: false, unlinked: false, surplus: true },
    });
    expect(byTag.get("#P000098")).toMatchObject({
      resolvedBucket: "TH16",
      surplusDelta: 1,
      reasons: { filler: false, inactive: false, unlinked: false, surplus: true },
    });
    expect(result.summaryByClan[0]).toMatchObject({
      uniqueCandidateCount: 2,
      fillerCount: 1,
      surplusCount: 2,
    });
  });
});
