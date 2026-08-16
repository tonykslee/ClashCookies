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

import {
  CompoReplacementService,
  filterAndSortCompoReplacementCandidates,
  type CompoReplacementCandidate,
} from "../src/services/CompoReplacementService";

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

  it("stacks surplus and existing reasons across buckets, and allows multiple surplus buckets in one clan", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P000098", discordUserId: "333333333333333333" },
      { playerTag: "#P000099", discordUserId: "444444444444444444" },
      { playerTag: "#P000090", discordUserId: "555555555555555555" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([
      { playerTag: "#P000099" },
      { playerTag: "#P000090" },
    ]);
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
        heatMapRef: makeHeatMapRef({ th16Count: 0, th15Count: 0, th17Count: 0 }),
      }),
    });

    expect(result.candidates.map((candidate) => candidate.playerTag)).toEqual([
      "#P000098",
      "#P000090",
      "#P000099",
    ]);
    const byTag = new Map(result.candidates.map((candidate) => [candidate.playerTag, candidate] as const));
    expect(byTag.get("#P000099")).toMatchObject({
      surplusDelta: 1,
      reasons: { filler: true, inactive: false, unlinked: false, surplus: true },
    });
    expect(byTag.get("#P000090")).toMatchObject({
      resolvedBucket: "TH17",
      surplusDelta: 1,
      reasons: { filler: true, inactive: false, unlinked: false, surplus: true },
    });
    expect(result.summaryByClan[0]).toMatchObject({
      uniqueCandidateCount: 3,
      fillerCount: 2,
      surplusCount: 3,
    });
  });

  it("enriches candidates with clan-scoped 30-day violation counts without changing eligibility", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P000090", discordUserId: "111111111111111111" },
      { playerTag: "#P000092", discordUserId: "222222222222222222" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [],
    } as any);
    const getViolationCounts = vi.fn().mockResolvedValue({
      period: "30d",
      cutoff: new Date("2026-04-20T12:00:00.000Z"),
      clanTag: "#AAA111",
      hasCompletedEvaluations: true,
      evaluatedWarCount: 3,
      violationCountByPlayerTag: new Map([["#P000090", 3]]),
    });

    const result = await new CompoReplacementService(undefined, {
      getClanPlayerViolationCounts: getViolationCounts,
    } as any).resolveReplacementCandidates({
      guildId: "guild-1",
      weight: 145000,
      includeViolationCounts: true,
      context: makeContext({
        members: [
          { playerTag: "#P000090", playerName: "Violator", resolvedWeight: 145000 },
          { playerTag: "#P000092", playerName: "No Violations", resolvedWeight: 145000 },
        ],
        bucketCounts: { TH15: 2 },
        heatMapRef: makeHeatMapRef({ th15Count: 0 }),
      }),
    });

    expect(getViolationCounts).toHaveBeenCalledTimes(1);
    expect(getViolationCounts).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#AAA111",
      playerTags: ["#P000090", "#P000092"],
      period: "30d",
    });
    expect(result.candidates.map((candidate) => [candidate.playerTag, candidate.violationCount30d])).toEqual([
      ["#P000092", 0],
      ["#P000090", 3],
    ]);
  });

  it("does not query violation history by default and returns zero counts", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P000090", discordUserId: "111111111111111111" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [],
    } as any);
    const getViolationCounts = vi.fn();

    const result = await new CompoReplacementService(undefined, {
      getClanPlayerViolationCounts: getViolationCounts,
    } as any).resolveReplacementCandidates({
      guildId: "guild-1",
      weight: 145000,
      context: makeContext({
        members: [
          { playerTag: "#P000090", playerName: "Candidate", resolvedWeight: 145000 },
        ],
        bucketCounts: { TH15: 1 },
        heatMapRef: makeHeatMapRef({ th15Count: 0 }),
      }),
    });

    expect(getViolationCounts).not.toHaveBeenCalled();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.violationCount30d).toBe(0);
  });

  it("does not make violations alone broaden replacement eligibility", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P000090", discordUserId: "111111111111111111" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [],
    } as any);
    const getViolationCounts = vi.fn().mockResolvedValue({
      period: "30d",
      cutoff: new Date("2026-04-20T12:00:00.000Z"),
      clanTag: "#AAA111",
      hasCompletedEvaluations: true,
      evaluatedWarCount: 3,
      violationCountByPlayerTag: new Map([["#P000090", 5]]),
    });

    const result = await new CompoReplacementService(undefined, {
      getClanPlayerViolationCounts: getViolationCounts,
    } as any).resolveReplacementCandidates({
      guildId: "guild-1",
      weight: 145000,
      includeViolationCounts: true,
      context: makeContext({
        members: [
          { playerTag: "#P000090", playerName: "Healthy TH17", resolvedWeight: 165000 },
        ],
        bucketCounts: { TH17: 1 },
        heatMapRef: makeHeatMapRef({ th17Count: 1 }),
      }),
    });

    expect(result.candidates).toEqual([]);
    expect(getViolationCounts).not.toHaveBeenCalled();
  });
});

function makeFilterCandidate(input: {
  playerTag: string;
  playerName: string;
  clanTag?: string;
  filler?: boolean;
  inactive?: boolean;
  unlinked?: boolean;
  surplus?: boolean;
  violationCount30d?: number;
}): CompoReplacementCandidate {
  const reasons = {
    filler: input.filler ?? false,
    inactive: input.inactive ?? false,
    unlinked: input.unlinked ?? false,
    surplus: input.surplus ?? false,
  };
  return {
    clanTag: input.clanTag ?? "#PYLQ",
    clanName: input.clanTag === "#GRJC" ? "Rising Dawn" : "Rocky Road",
    playerTag: input.playerTag,
    playerName: input.playerName,
    resolvedWeight: 145000,
    resolvedBucket: "TH15",
    discordUserId: reasons.unlinked ? null : "111111111111111111",
    discordMention: reasons.unlinked ? null : "<@111111111111111111>",
    inactiveLabel: reasons.inactive ? "4d" : null,
    surplusDelta: reasons.surplus ? 3 : null,
    violationCount30d: input.violationCount30d ?? 0,
    reasons,
  };
}

describe("filterAndSortCompoReplacementCandidates", () => {
  const candidates = [
    makeFilterCandidate({ playerTag: "#P000001", playerName: "Filler", filler: true }),
    makeFilterCandidate({ playerTag: "#P000002", playerName: "Inactive", inactive: true }),
    makeFilterCandidate({ playerTag: "#P000003", playerName: "Violator", violationCount30d: 3 }),
    makeFilterCandidate({ playerTag: "#P000004", playerName: "Healthy Surplus", surplus: true }),
    makeFilterCandidate({ playerTag: "#P000005", playerName: "Unlinked", unlinked: true }),
  ];
  const extendedCandidates = [
    ...candidates,
    makeFilterCandidate({
      playerTag: "#P000006",
      playerName: "RR Surplus Violator",
      clanTag: "#PYLQ",
      surplus: true,
      violationCount30d: 2,
    }),
    makeFilterCandidate({
      playerTag: "#P000007",
      playerName: "RD Surplus Violator",
      clanTag: "#GRJC",
      surplus: true,
      violationCount30d: 5,
    }),
  ];

  it("supports priority, all, clan, type, OR, threshold, and combined filters", () => {
    const priority = filterAndSortCompoReplacementCandidates({
      candidates,
      filter: { view: "priority" },
    });
    expect(priority.candidates.map((candidate) => candidate.playerName)).toEqual([
      "Filler",
      "Violator",
      "Inactive",
    ]);
    expect(priority.totalCandidateCount).toBe(5);
    expect(priority.filteredCount).toBe(3);

    expect(filterAndSortCompoReplacementCandidates({
      candidates,
      filter: { view: "all" },
    }).filteredCount).toBe(5);
    expect(filterAndSortCompoReplacementCandidates({
      candidates,
      filter: { view: "priority", clanTag: "#PYLQ" },
    }).candidates.every((candidate) => candidate.clanTag === "#PYLQ")).toBe(true);
    expect(filterAndSortCompoReplacementCandidates({
      candidates: extendedCandidates,
      filter: { view: "priority", types: ["surplus"] },
    }).candidates.map((candidate) => candidate.playerName)).toEqual([
      "RD Surplus Violator",
      "RR Surplus Violator",
      "Healthy Surplus",
    ]);
    expect(filterAndSortCompoReplacementCandidates({
      candidates,
      filter: { view: "all", types: ["filler", "inactive"] },
    }).candidates.map((candidate) => candidate.playerName)).toEqual(["Filler", "Inactive"]);

    for (const [threshold, expected] of [[1, 3], [2, 3], [3, 2], [5, 1]] as const) {
      expect(filterAndSortCompoReplacementCandidates({
        candidates: extendedCandidates,
        filter: { view: "all", types: ["violations"], minimumViolations: threshold },
      }).filteredCount).toBe(expected);
    }

    const combined = filterAndSortCompoReplacementCandidates({
      candidates: extendedCandidates,
      filter: {
        view: "priority",
        clanTag: "#PYLQ",
        types: ["surplus"],
        minimumViolations: 2,
      },
    });
    expect(combined.candidates.map((candidate) => candidate.playerName)).toEqual([
      "RR Surplus Violator",
    ]);
  });

  it("ranks deterministically by filler, violations, inactivity, unlinked, then surplus-only", () => {
    const result = filterAndSortCompoReplacementCandidates({
      candidates: [
        makeFilterCandidate({ playerTag: "#P000012", playerName: "Zulu", surplus: true }),
        makeFilterCandidate({ playerTag: "#P000011", playerName: "Alpha", unlinked: true }),
        makeFilterCandidate({ playerTag: "#P000010", playerName: "Bravo", inactive: true }),
        makeFilterCandidate({ playerTag: "#P000009", playerName: "Charlie", violationCount30d: 2 }),
        makeFilterCandidate({ playerTag: "#P000008", playerName: "Delta", filler: true }),
      ],
      filter: { view: "all" },
    });
    expect(result.candidates.map((candidate) => candidate.playerName)).toEqual([
      "Delta",
      "Charlie",
      "Bravo",
      "Alpha",
      "Zulu",
    ]);
  });
});
