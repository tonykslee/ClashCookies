import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  raidTrackedClan: {
    findMany: vi.fn(),
  },
}));

const cocQueueMock = vi.hoisted(() => {
  const state = { active: false };
  const defaultImpl = async (_context: unknown, run: () => Promise<unknown>) => {
    state.active = true;
    try {
      return await run();
    } finally {
      state.active = false;
    }
  };
  return {
    state,
    defaultImpl,
    runWithCoCQueueContext: vi.fn(defaultImpl),
  };
});

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CoCQueueContext", () => ({
  runWithCoCQueueContext: cocQueueMock.runWithCoCQueueContext,
}));

import {
  buildRaidIntelDescription,
  buildRaidDashboardOverviewDescription,
  buildRaidDashboardSelectChoices,
  buildRaidDashboardSingleClanDescription,
  normalizeRaidClanJoinRequirements,
  loadRaidDashboardSeasonDetailWithQueueContext,
  loadRaidIntelSeasonDetailWithQueueContext,
  listRaidDashboardRows,
  listRaidDashboardRowsWithQueueContext,
  parseRaidSeasonTimeMs,
} from "../src/services/RaidDashboardService";

describe("RaidDashboardService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cocQueueMock.state.active = false;
    cocQueueMock.runWithCoCQueueContext.mockImplementation(cocQueueMock.defaultImpl);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads live attacks for active raid seasons and renders the overview shell", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
      {
        clanTag: "2RVGJYLC0",
        name: "Bravo Raid",
        upgrades: null,
        joinType: "closed",
        createdAt: new Date("2026-05-02T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:30:00.000Z"),
      },
      {
        clanTag: "2XYZ12345",
        name: "Charlie Raid",
        upgrades: 400,
        joinType: "open",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:45:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        if (tag === "#2QG2C08UP") {
          return [
            {
              startTime: "2026-05-08T00:00:00.000Z",
              endTime: "2026-05-11T00:00:00.000Z",
              members: [{ attacks: 6 }, { attacks: 5 }],
              attackLog: [
                {
                  defender: { name: "Defender One", tag: "#DEF1" },
                  attackCount: 1,
                  districtCount: 2,
                  districtsDestroyed: 1,
                  districts: [
                    {
                      name: "Capital Hall",
                      districtHallLevel: 5,
                      attackCount: 3,
                      destructionPercent: 100,
                      stars: 3,
                    },
                    {
                      name: "Wizard Valley",
                      districtHallLevel: 4,
                      attackCount: 0,
                      destructionPercent: 0,
                      stars: 0,
                    },
                  ],
                },
              ],
              defenseLog: [
                {
                  attacker: { name: "Enemy Clan", tag: "#2QG2C08UR" },
                  districtCount: 2,
                  districtsDestroyed: 1,
                  districts: [
                    {
                      name: "Capital Hall",
                      districtHallLevel: 5,
                      destructionPercent: 100,
                      stars: 3,
                    },
                    {
                      name: "Barbarian Camp",
                      districtHallLevel: 4,
                      destructionPercent: 50,
                      stars: 1,
                    },
                  ],
                },
              ],
              raidsCompleted: null,
            },
          ];
        }
        if (tag === "#2RVGJYLC0") {
          return [
            {
              startTime: "2026-05-08T00:00:00.000Z",
              endTime: "2026-05-11T00:00:00.000Z",
              members: [{ attacks: 6 }, { attacks: 5 }],
              attackLog: [
                {
                  defender: { name: "Defender One", tag: "#2QG2C08UQ" },
                  districtCount: 2,
                  districtsDestroyed: 2,
                  districts: [
                    {
                      name: "Capital Hall",
                      districtHallLevel: 5,
                      attackCount: 3,
                      destructionPercent: 100,
                      stars: 3,
                    },
                    {
                      name: "Wizard Valley",
                      districtHallLevel: 4,
                      attackCount: 2,
                      destructionPercent: 100,
                      stars: 3,
                    },
                  ],
                },
              ],
              defenseLog: [
                {
                  attacker: { name: "Enemy Clan", tag: "#2QG2C08UR" },
                  districtCount: 2,
                  districtsDestroyed: 1,
                  districts: [
                    {
                      name: "Capital Hall",
                      districtHallLevel: 5,
                      destructionPercent: 100,
                      stars: 3,
                    },
                    {
                      name: "Barbarian Camp",
                      districtHallLevel: 4,
                      destructionPercent: 50,
                      stars: 1,
                    },
                  ],
                },
              ],
              raidsCompleted: null,
            },
          ];
        }
        return [];
      }),
      getClan: vi.fn(async (tag: string) => {
        expect(tag).toBe("#2QG2C08UR");
        return {
          type: "open",
          requiredTownhallLevel: 16,
          requiredBuilderBaseTrophies: 2600,
          requiredTrophies: 5000,
        };
      }),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.clanTag).toBe("2QG2C08UP");
    expect(rows[0]?.hasOngoingRaid).toBe(true);
    expect(rows[0]?.attacksCompleted).toBe(11);
    expect(rows[0]?.attacksMax).toBe(12);
    expect(rows[0]?.raidsCompleted).toBe(0);
    expect(rows[1]?.clanTag).toBe("2RVGJYLC0");
    expect(rows[1]?.hasOngoingRaid).toBe(false);
    expect(rows[1]?.raidsCompleted).toBe(1);
    expect(rows[2]?.clanTag).toBe("2XYZ12345");
    expect(rows[2]?.hasOngoingRaid).toBe(false);
    expect(rows[2]?.raidsCompleted).toBeNull();

    const overview = buildRaidDashboardOverviewDescription(rows);
    expect(overview).toContain("## Raid Clans");
    expect(overview).toContain("\u2694\ufe0f [Alpha Raid]");
    expect(overview).toContain("\ud83c\udf04 [Bravo Raid]");
    expect(overview).toContain(`#2QG2C08UP`);
    expect(overview).not.toContain("\ud83d\udd13 [Alpha Raid]");
    const alphaIndex = overview.indexOf("\u2694\ufe0f [Alpha Raid]");
    const bravoIndex = overview.indexOf("\ud83c\udf04 [Bravo Raid]");
    expect(alphaIndex).toBeGreaterThanOrEqual(0);
    expect(bravoIndex).toBeGreaterThan(alphaIndex);
    const enemyLine = overview.split("\n").find((line) => line.includes("[Enemy Clan]"));
    expect(enemyLine).toBeDefined();
    expect(enemyLine?.startsWith("- \ud83d\udee1\ufe0f [Enemy Clan]")).toBe(true);
    expect(enemyLine).toContain(`#2QG2C08UR`);
    expect(enemyLine).toContain("\u2014 1 districts remaining");
    expect(enemyLine?.startsWith("  -")).toBe(false);
    expect(overview).not.toContain("  -");
    expect(overview).not.toContain("Attacks:");
    expect(overview).not.toContain("Raids completed:");
    expect(overview).not.toContain("Updated:");
    expect(overview).not.toContain("Upgrades:");

    const single = buildRaidDashboardSingleClanDescription(rows[0]!);
    expect(single).toContain("## Raid Clan");
    expect(single).toContain("Join type: Open");
    expect(single).toContain("Upgrades: 2210");
    expect(single).toContain("Attacks: 11");
  });

  it("renders no status emoji when a tracked clan has no ongoing or completed raid", () => {
    const overview = buildRaidDashboardOverviewDescription([
      {
        clanTag: "2XYZ12345",
        clanName: "Charlie Raid",
        upgrades: 400,
        joinType: "open",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:45:00.000Z"),
        attacksCompleted: null,
        attacksMax: null,
        hasOngoingRaid: false,
        raidsCompleted: null,
      } as any,
    ]);

    expect(overview).toContain("Charlie Raid");
    expect(overview).not.toContain("⚔️");
    expect(overview).not.toContain("🌄");
  });

  it("parses compact Clash raid timestamps and selects the active season", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [
        {
          startTime: "20260508T070000.000Z",
          endTime: "20260511T070000.000Z",
          members: [{ attacks: 6 }, { attacks: 5 }],
          attackLog: [],
          defenseLog: [],
          raidsCompleted: null,
        },
      ]),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.attacksCompleted).toBe(11);
    expect(rows[0]?.attacksMax).toBe(12);
    expect(rows[0]?.raidsCompleted).toBeNull();
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Attacks:");
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Raids completed:");
  });

  it("parses compact raid timestamps without milliseconds and still selects the active season", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "20RLGVJPP",
        name: "Bravo Raid",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [
        {
          startTime: "20260508T070000Z",
          endTime: "20260511T070000Z",
          members: [{ attacks: 6 }, { attacks: 6 }, { attacks: 1 }],
          attackLog: [
            {
              defender: { name: "Defender One", tag: "#DEF1" },
              districtCount: 9,
              districtsDestroyed: 9,
              districts: [
                {
                  name: "Capital Hall",
                  districtHallLevel: 5,
                  attackCount: 3,
                  destructionPercent: 100,
                  stars: 3,
                },
              ],
            },
          ],
          defenseLog: [],
          raidsCompleted: null,
        },
      ]),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.attacksCompleted).toBe(13);
    expect(rows[0]?.attacksMax).toBe(18);
    expect(rows[0]?.raidsCompleted).toBe(1);
    expect(rows[0]?.hasOngoingRaid).toBe(false);
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Attacks:");
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Raids completed:");
  });

  it("treats started aggregate raid logs as not completed", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [
        {
          startTime: "2026-05-08T00:00:00.000Z",
          endTime: "2026-05-11T00:00:00.000Z",
          members: [{ attacks: 1 }],
          attackLog: [
            {
              defender: { name: "Defender One", tag: "#DEF1" },
              attackCount: 3,
              districtCount: 9,
              districtsDestroyed: 0,
              districts: [
                {
                  name: "Capital Hall",
                  districtHallLevel: 10,
                  attackCount: 3,
                  destructionPercent: 50,
                  stars: 1,
                },
              ],
            },
          ],
          defenseLog: [],
          raidsCompleted: null,
        },
      ]),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.raidsCompleted).toBe(0);
    expect(rows[0]?.hasOngoingRaid).toBe(true);
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Attacks:");
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Raids completed:");
  });

  it("treats aggregate attackCount zero and unusable logs as not ongoing", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [
        {
          startTime: "2026-05-08T00:00:00.000Z",
          endTime: "2026-05-11T00:00:00.000Z",
          members: [{ attacks: 1 }],
          attackLog: [
            {
              defender: { name: "Defender One", tag: "#DEF1" },
              attackCount: 0,
            },
            {
              defender: { name: "Defender Two", tag: "#DEF2" },
              attackCount: 0,
            },
          ],
          defenseLog: [],
          raidsCompleted: null,
        },
      ]),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.hasOngoingRaid).toBe(false);
    expect(rows[0]?.raidsCompleted).toBeNull();
  });

  it("treats incomplete per-district raid logs as not completed", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [
        {
          startTime: "2026-05-08T00:00:00.000Z",
          endTime: "2026-05-11T00:00:00.000Z",
          members: [{ attacks: 6 }],
          attackLog: [
            {
              defender: { name: "Defender One", tag: "#DEF1" },
              districts: [
                {
                  name: "Capital Hall",
                  districtHallLevel: 10,
                  attackCount: 3,
                  destructionPercent: 100,
                  stars: 3,
                },
                {
                  name: "Wizard Valley",
                  districtHallLevel: 5,
                  attacks: 2,
                  destructionPercent: 50,
                  stars: 1,
                },
              ],
            },
          ],
          defenseLog: [],
          raidsCompleted: null,
        },
      ]),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.raidsCompleted).toBe(0);
    expect(rows[0]?.hasOngoingRaid).toBe(true);
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Attacks:");
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Raids completed:");
  });

  it("treats fully destroyed per-district raid logs as completed", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [
        {
          startTime: "2026-05-08T00:00:00.000Z",
          endTime: "2026-05-11T00:00:00.000Z",
          members: [{ attacks: 6 }],
          attackLog: [
            {
              defender: { name: "Defender One", tag: "#DEF1" },
              districts: [
                {
                  name: "Capital Hall",
                  districtHallLevel: 10,
                  attackCount: 3,
                  destructionPercent: 100,
                  stars: 3,
                },
                {
                  name: "Barbarian Camp",
                  districtHallLevel: 5,
                  attackCount: 2,
                  destructionPercent: 100,
                  stars: 3,
                },
              ],
            },
          ],
          defenseLog: [],
          raidsCompleted: null,
        },
      ]),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.raidsCompleted).toBe(1);
    expect(rows[0]?.hasOngoingRaid).toBe(false);
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Attacks:");
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Raids completed:");
  });

  it("renders MAX for maxed raid district hall levels and falls back to DH labels otherwise", () => {
    const row = {
      clanTag: "2QG2C08UP",
      clanName: "Alpha Raid",
      upgrades: 2210,
      joinType: "open",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      attacksCompleted: 13,
      attacksMax: 18,
      raidsCompleted: 1,
    } as any;

    const detail = {
      activeSeason: { state: "ongoing" },
      attackSections: [
        {
          defenderName: "Defender One",
          defenderTag: "#DEF1",
          districts: [
            {
              name: "Capital Hall",
              districtHallLevel: 10,
              attackCount: 3,
              destructionPercent: 100,
              stars: 3,
            },
            {
              name: "Barbarian Camp",
              districtHallLevel: 5,
              attackCount: 2,
              destructionPercent: 100,
              stars: 3,
            },
            {
              name: "Skeleton Park",
              districtHallLevel: 3,
              attackCount: 4,
              destructionPercent: 100,
              stars: 3,
            },
            {
              name: "Unknown District",
              districtHallLevel: 7,
              attackCount: 1,
              destructionPercent: 100,
              stars: 3,
            },
          ],
        },
      ],
      defenseSections: [],
      raidsCompleted: 1,
    } as any;

    const description = buildRaidDashboardSingleClanDescription(row, detail);
    expect(description).toContain("Capital Hall MAX — 3 attacks");
    expect(description).toContain("Barbarian Camp MAX — 2 attacks");
    expect(description).toContain("Skeleton Park DH3 — 4 attacks");
    expect(description).toContain("Unknown District DH7 — 1 attacks");
  });

  it("treats invalid raid timestamps as missing", async () => {
    expect(parseRaidSeasonTimeMs(null)).toBeNull();
    expect(parseRaidSeasonTimeMs("")).toBeNull();
    expect(parseRaidSeasonTimeMs("not-a-timestamp")).toBeNull();
    expect(parseRaidSeasonTimeMs("20260508T070000.000Z")).toBe(Date.parse("2026-05-08T07:00:00.000Z"));
  });

  it("returns no active season when raid timestamps are invalid", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [
        {
          startTime: "not-a-time",
          endTime: "also-not-a-time",
          state: "ongoing",
          members: [{ attacks: 6 }, { attacks: 5 }],
          attackLog: [],
          defenseLog: [],
          raidsCompleted: null,
        },
      ]),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.attacksCompleted).toBeNull();
    expect(rows[0]?.attacksMax).toBeNull();
    expect(rows[0]?.raidsCompleted).toBeNull();
  });

  it("loads raid rows through a queue context wrapper for dashboard refreshes", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => []),
    };

    const rows = await listRaidDashboardRowsWithQueueContext({
      cocService: cocService as any,
      source: "raids:overview",
    });

    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:overview",
      }),
      expect.any(Function),
    );
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledTimes(1);
    expect(rows[0]?.attacksCompleted).toBeNull();
  });

  it("computes raids completed and renders attack and defense detail sections for a selected clan", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const activeSeason = {
      startTime: "2026-05-08T00:00:00.000Z",
      endTime: "2026-05-11T00:00:00.000Z",
      members: [{ attacks: 6 }, { attacks: 5 }],
      attackLog: [
        {
          defender: { name: "Defender One", tag: "#2QG2C08UQ" },
          districtCount: 2,
          districtsDestroyed: 2,
          districts: [
            {
              name: "Capital Hall",
              districtHallLevel: 5,
              attackCount: 3,
              destructionPercent: 100,
              stars: 3,
            },
            {
              name: "Wizard Valley",
              districtHallLevel: 4,
              attackCount: 2,
              destructionPercent: 100,
              stars: 3,
            },
          ],
        },
      ],
      defenseLog: [
        {
          attacker: { name: "Enemy Clan", tag: "#2QG2C08UR" },
          districtCount: 2,
          districtsDestroyed: 1,
          districts: [
            {
              name: "Capital Hall",
              districtHallLevel: 5,
              destructionPercent: 100,
              stars: 3,
            },
            {
              name: "Barbarian Camp",
              districtHallLevel: 4,
              destructionPercent: 50,
              stars: 1,
            },
          ],
        },
      ],
      raidsCompleted: null,
    };

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(tag).toBe("#2QG2C08UP");
        return [activeSeason];
      }),
      getClan: vi.fn(async (tag: string) => {
        expect(tag).toBe("#2QG2C08UR");
        return {
          type: "open",
          requiredTownhallLevel: 16,
          requiredVersusTrophies: 2600,
          requiredTrophies: 5000,
        };
      }),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.raidsCompleted).toBe(1);
    expect(rows[0]?.openDefenseSections).toHaveLength(1);
    expect(rows[0]?.openDefenseSections?.[0]?.joinType).toBe("open");

    const detail = await loadRaidDashboardSeasonDetailWithQueueContext({
      cocService: cocService as any,
      clanTag: "2QG2C08UP",
      source: "raids:overview:detail",
    });

    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:overview:detail",
      }),
      expect.any(Function),
    );
    expect(detail?.activeSeason).not.toBeNull();
    expect(detail?.attackSections).toHaveLength(1);
    expect(detail?.defenseSections).toHaveLength(1);
    expect(detail?.defenseSections[0]?.joinType).toBe("open");
    expect(detail?.defenseSections[0]?.joinRequirements).toEqual({
      requiredTownHall: 16,
      requiredTrophies: 5000,
      requiredBuilderBaseTrophies: 2600,
    });
    expect(detail?.defenseSections[0]?.districtsRemaining).toBe(1);
    expect(cocService.getClan).toHaveBeenCalledTimes(2);

    const description = buildRaidDashboardSingleClanDescription(rows[0]!, detail);
    expect(description).toContain("## Raid Clan");
    expect(description).toContain("Raids completed: 1");
    expect(description).toContain("## Attacking");
    expect(description).toContain("### [Defender One]");
    expect(description).toContain("Capital Hall DH5 — 3 attacks");
    expect(description).toContain("Wizard Valley DH4 — 2 attacks");
    expect(description).toContain("## Defending");
    expect(description).toContain("🔓 [Enemy Clan]");
    expect(description).toContain("`#2QG2C08UR`");
    expect(description).toContain("1 districts remaining");
    expect(description).toContain("Requirements: TH16, Builder Base: 2600+ trophies, Ranked: 5000+ trophies");
    const overview = buildRaidDashboardOverviewDescription(rows);
    const enemyLine = overview.split("\n").find((line) => line.includes("[Enemy Clan]"));
    expect(enemyLine).toBeDefined();
    expect(enemyLine).toMatch(/^- 🛡️ \[Enemy Clan\]/);
    expect(enemyLine).toContain("`#2QG2C08UR`");
    expect(enemyLine).toContain("— 1 districts remaining");
    expect(enemyLine).not.toContain("🔓");
    expect(enemyLine?.startsWith("  -")).toBe(false);
  });

  it("omits completed open-attacker rows and hides missing counts in overview", () => {
    const rows = [
      {
        clanTag: "2QG2C08UP",
        clanName: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
        attacksCompleted: null,
        attacksMax: null,
        raidsCompleted: null,
        openDefenseSections: [
          {
            attackerName: "Completed Clan",
            attackerTag: "#DONE",
            joinType: "open",
            joinRequirements: null,
            districtsRemaining: 0,
          },
          {
            attackerName: "Pending Clan",
            attackerTag: "#2PQQQ",
            joinType: "open",
            joinRequirements: null,
            districtsRemaining: null,
          },
        ],
      },
    ] as any;

    const overview = buildRaidDashboardOverviewDescription(rows);
    expect(overview).toContain("[Alpha Raid]");
    const pendingLine = overview.split("\n").find((line) => line.includes("[Pending Clan]"));
    expect(pendingLine).toBeDefined();
    expect(pendingLine?.startsWith("- 🛡️ [Pending Clan]")).toBe(true);
    expect(pendingLine).toContain("`#2PQQQ`");
    expect(pendingLine).not.toContain("districts remaining");
    expect(pendingLine).not.toContain("🔓");
    expect(pendingLine?.startsWith("  -")).toBe(false);
    expect(overview).not.toContain("  -");
    expect(overview).not.toContain("Completed Clan");
    expect(overview).not.toContain("#DONE");
    expect(overview).not.toContain("0 districts remaining");
    expect(overview).not.toContain("districts remaining");
    expect(overview).not.toContain("Attacks:");
    expect(overview).not.toContain("Raids completed:");
  });

  it("maps versus trophies to builder base requirements without mixing ranked trophies", async () => {
    const metadata = normalizeRaidClanJoinRequirements({
      requiredVersusTrophies: 2600,
    } as any);
    expect(metadata).toEqual({
      requiredTownHall: null,
      requiredTrophies: null,
      requiredBuilderBaseTrophies: 2600,
    });

    const section = {
      joinType: "open",
      joinRequirements: metadata,
      attackerName: "Enemy Clan",
      attackerTag: "#2C0",
      districtsRemaining: 1,
      districts: [],
    } as any;

    const text = buildRaidDashboardSingleClanDescription(
      {
        clanTag: "2QG2C08UP",
        clanName: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
        attacksCompleted: 13,
        attacksMax: 18,
        raidsCompleted: 1,
      } as any,
      {
        activeSeason: { state: "ongoing" },
        attackSections: [],
        defenseSections: [section],
        raidsCompleted: 1,
      } as any,
    );

    expect(text).toContain("Requirements: Builder Base: 2600+ trophies");
    expect(text).not.toContain("Ranked: 2600+ trophies");
  });

  it("renders ranked trophy requirements separately from builder base requirements", async () => {
    const metadata = normalizeRaidClanJoinRequirements({
      requiredTrophies: 5000,
    } as any);
    expect(metadata).toEqual({
      requiredTownHall: null,
      requiredTrophies: 5000,
      requiredBuilderBaseTrophies: null,
    });

    const text = buildRaidDashboardSingleClanDescription(
      {
        clanTag: "2QG2C08UP",
        clanName: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
        attacksCompleted: 13,
        attacksMax: 18,
        raidsCompleted: 1,
      } as any,
      {
        activeSeason: { state: "ongoing" },
        attackSections: [],
        defenseSections: [
          {
            attackerName: "Enemy Clan",
            attackerTag: "#2C1",
            joinType: "open",
            joinRequirements: metadata,
            districtsRemaining: 1,
            districts: [],
          },
        ],
        raidsCompleted: 1,
      } as any,
    );

    expect(text).toContain("Requirements: Ranked: 5000+ trophies");
    expect(text).not.toContain("Builder Base: 5000+ trophies");
  });

  it("renders no requirements text when open attacker metadata has no usable fields", async () => {
    const metadata = normalizeRaidClanJoinRequirements({} as any);
    expect(metadata).toEqual({
      requiredTownHall: null,
      requiredTrophies: null,
      requiredBuilderBaseTrophies: null,
    });

    const text = buildRaidDashboardSingleClanDescription(
      {
        clanTag: "2QG2C08UP",
        clanName: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
        attacksCompleted: 13,
        attacksMax: 18,
        raidsCompleted: 1,
      } as any,
      {
        activeSeason: { state: "ongoing" },
        attackSections: [],
        defenseSections: [
          {
            attackerName: "Enemy Clan",
            attackerTag: "#2C2",
            joinType: "open",
            joinRequirements: metadata,
            districtsRemaining: 1,
            districts: [],
          },
        ],
        raidsCompleted: 1,
      } as any,
    );

    expect(text).toContain("Requirements: —");
  });

  it("omits open attacker metadata when the live clan lookup fails", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const activeSeason = {
      startTime: "2026-05-08T00:00:00.000Z",
      endTime: "2026-05-11T00:00:00.000Z",
      members: [{ attacks: 6 }, { attacks: 5 }],
      attackLog: [],
      defenseLog: [
        {
          attacker: { name: "Enemy Clan", tag: "#2QG2C08UR" },
          districtCount: 2,
          districtsDestroyed: 1,
          districts: [
            {
              name: "Capital Hall",
              districtHallLevel: 5,
              destructionPercent: 100,
              stars: 3,
            },
            {
              name: "Barbarian Camp",
              districtHallLevel: 4,
              destructionPercent: 50,
              stars: 1,
            },
          ],
        },
      ],
      raidsCompleted: null,
    };

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [activeSeason]),
      getClan: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.openDefenseSections).toHaveLength(0);

    const detail = await loadRaidDashboardSeasonDetailWithQueueContext({
      cocService: cocService as any,
      clanTag: "2QG2C08UP",
      source: "raids:overview:detail",
    });

    expect(detail?.defenseSections[0]?.joinType).toBeNull();
    const description = buildRaidDashboardSingleClanDescription(rows[0]!, detail);
    expect(description).toContain("⚪ [Enemy Clan]");
    expect(description).not.toContain("Requirements:");
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Enemy Clan");
  });

  it("derives defense districts remaining from aggregate fields when available", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const activeSeason = {
      startTime: "2026-05-08T00:00:00.000Z",
      endTime: "2026-05-11T00:00:00.000Z",
      members: [{ attacks: 6 }, { attacks: 5 }],
      attackLog: [],
      defenseLog: [
        {
          attacker: { name: "Enemy Clan", tag: "#2QG2C08UR" },
          districtCount: 7,
          districtsDestroyed: 4,
          districts: [
            {
              name: "Capital Hall",
              districtHallLevel: 5,
              destructionPercent: 100,
              stars: 3,
            },
            {
              name: "Wizard Valley",
              districtHallLevel: 4,
              destructionPercent: null,
              stars: null,
            },
          ],
        },
      ],
      raidsCompleted: null,
    };

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [activeSeason]),
      getClan: vi.fn(async () => ({ type: "open" })),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    const detail = await loadRaidDashboardSeasonDetailWithQueueContext({
      cocService: cocService as any,
      clanTag: "2QG2C08UP",
      source: "raids:overview:detail",
    });

    expect(detail?.defenseSections[0]?.districtsRemaining).toBe(3);
    const description = buildRaidDashboardSingleClanDescription(rows[0]!, detail);
    expect(description).toContain("3 districts remaining");
  });

  it("loads raid intel details through a queue context wrapper and renders defender districts", async () => {
    const activeSeason = {
      startTime: "2026-05-08T00:00:00.000Z",
      endTime: "2026-05-11T00:00:00.000Z",
      members: [{ attacks: 6 }, { attacks: 5 }],
      attackLog: [
        {
          defender: { name: "Defender One", tag: "#2QG2C08UQ" },
          districtCount: 2,
          districtsDestroyed: 2,
          districts: [
            {
              name: "Capital Hall",
              districtHallLevel: 5,
              attackCount: 3,
              destructionPercent: 100,
              stars: 3,
            },
            {
              name: "Wizard Valley",
              districtHallLevel: 4,
              attackCount: 2,
              destructionPercent: 100,
              stars: 3,
            },
          ],
        },
      ],
      defenseLog: [],
      raidsCompleted: null,
    };

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(cocQueueMock.state.active).toBe(true);
        expect(tag).toBe("#2QG2C08UP");
        return [activeSeason];
      }),
    };

    const detail = await loadRaidIntelSeasonDetailWithQueueContext({
      cocService: cocService as any,
      clanTag: "2QG2C08UP",
      source: "raids:intel",
    });

    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:intel",
      }),
      expect.any(Function),
    );
    expect(detail.activeSeason).not.toBeNull();
    expect(detail.defenders).toHaveLength(1);
    expect(detail.defenders[0]?.districts).toHaveLength(2);

    const description = buildRaidIntelDescription({
      trackedClan: {
        clanTag: "2QG2C08UP",
        clanName: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      } as any,
      upgrades: null,
      detail,
    });

    expect(description).toContain("## Raid Intel");
    expect(description).toContain("Tracked clan: [Alpha Raid]");
    expect(description).toContain("`#2QG2C08UP`");
    expect(description).toContain("Upgrades: —");
    expect(description).toContain("Raid weekend: Active");
    expect(description).toContain("### [Defender One]");
    expect(description).toContain("Capital Hall DH5 \u2014 Grade: Unmarked");
    expect(description).toContain("Wizard Valley DH4 \u2014 Grade: Unmarked");
  });

  it("renders a clean empty intel message when no active raid weekend data is available", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => []),
    };

    const detail = await loadRaidIntelSeasonDetailWithQueueContext({
      cocService: cocService as any,
      clanTag: "2QG2C08UP",
      source: "raids:intel",
    });

    expect(detail.activeSeason).toBeNull();
    const description = buildRaidIntelDescription({
      trackedClan: {
        clanTag: "2QG2C08UP",
        clanName: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      } as any,
      upgrades: null,
      detail,
    });
    expect(description).toBe("No active raid weekend data available.");
  });

  it("renders a clean no-defender message when the active raid season has no attack log", async () => {
    const activeSeason = {
      startTime: "2026-05-08T00:00:00.000Z",
      endTime: "2026-05-11T00:00:00.000Z",
      members: [{ attacks: 6 }, { attacks: 5 }],
      attackLog: [],
      defenseLog: [],
      raidsCompleted: null,
    };

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [activeSeason]),
    };

    const detail = await loadRaidIntelSeasonDetailWithQueueContext({
      cocService: cocService as any,
      clanTag: "2QG2C08UP",
      source: "raids:intel",
    });

    const description = buildRaidIntelDescription({
      trackedClan: {
        clanTag: "2QG2C08UP",
        clanName: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      } as any,
      upgrades: null,
      detail,
    });

    expect(description).toContain("Raid weekend: Active");
    expect(description).toContain("No defender intel available yet.");
  });

  it("renders a clean empty message when no active raid weekend data is available", async () => {
    const row = {
      clanTag: "2QG2C08UP",
      clanName: "Alpha Raid",
      upgrades: 2210,
      joinType: "open",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      attacksCompleted: null,
      attacksMax: null,
      raidsCompleted: null,
    } as any;

    const description = buildRaidDashboardSingleClanDescription(row, {
      activeSeason: null,
      attackSections: [],
      defenseSections: [],
      raidsCompleted: null,
    });

    expect(description).toBe("No active raid weekend data available.");
    expect(description).not.toContain("No attack log available yet.");
    expect(description).not.toContain("No defense log available yet.");
  });

  it("renders a no-attack-log section when the active raid season has no attack sections", () => {
    const row = {
      clanTag: "2QG2C08UP",
      clanName: "Alpha Raid",
      upgrades: 2210,
      joinType: "open",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      attacksCompleted: 11,
      attacksMax: 12,
      raidsCompleted: 1,
    } as any;

    const description = buildRaidDashboardSingleClanDescription(row, {
      activeSeason: { state: "ongoing" } as any,
      attackSections: [],
      defenseSections: [
        {
          attackerName: "Enemy Clan",
          attackerTag: "#ENEMY",
          joinType: "open",
          districtsRemaining: 3,
        },
      ],
      raidsCompleted: 1,
    });

    expect(description).toContain("## Attacking");
    expect(description).toContain("No attack log available yet.");
  });

  it("renders a no-defense-log section when the active raid season has no defense sections", () => {
    const row = {
      clanTag: "2QG2C08UP",
      clanName: "Alpha Raid",
      upgrades: 2210,
      joinType: "open",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      attacksCompleted: 11,
      attacksMax: 12,
      raidsCompleted: 1,
    } as any;

    const description = buildRaidDashboardSingleClanDescription(row, {
      activeSeason: { state: "ongoing" } as any,
      attackSections: [
        {
          defenderName: "Defender One",
          defenderTag: "#DEF1",
          districts: [
            {
              name: "Capital Hall",
              districtHallLevel: 5,
              attackCount: 3,
              destructionPercent: 100,
              stars: 3,
            },
          ],
        },
      ],
      defenseSections: [],
      raidsCompleted: 1,
    });

    expect(description).toContain("## Defending");
    expect(description).toContain("No defense log available yet.");
  });

  it("truncates long raid detail descriptions gracefully", () => {
    const row = {
      clanTag: "2QG2C08UP",
      clanName: "Alpha Raid",
      upgrades: 2210,
      joinType: "open",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      attacksCompleted: 11,
      attacksMax: 12,
      raidsCompleted: 3,
    } as any;

    const detail = {
      activeSeason: { state: "active" },
      attackSections: Array.from({ length: 20 }, (_, sectionIndex) => ({
        defenderName: `Defender ${sectionIndex + 1}`,
        defenderTag: `#DEF${sectionIndex + 1}`,
        districts: Array.from({ length: 12 }, (_, districtIndex) => ({
          name: `District ${districtIndex + 1}`,
          districtHallLevel: 5,
          attackCount: 3,
          destructionPercent: 100,
          stars: 3,
        })),
      })),
      defenseSections: Array.from({ length: 20 }, (_, sectionIndex) => ({
        attackerName: `Enemy ${sectionIndex + 1}`,
        attackerTag: `#ENEMY${sectionIndex + 1}`,
        joinType: "open",
        districtsRemaining: 0,
      })),
      raidsCompleted: 3,
    } as any;

    const description = buildRaidDashboardSingleClanDescription(row, detail);
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description).toContain("…and ");
    expect(description).toContain("not shown.");
  });

  it("falls back to dash counts when no active raid season is available", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
    ]);

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => []),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.attacksCompleted).toBeNull();
    expect(rows[0]?.attacksMax).toBeNull();
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Attacks:");
    expect(buildRaidDashboardOverviewDescription(rows)).not.toContain("Raids completed:");
  });

  it("keeps dropdown order aligned with the sorted overview and caps options at 25", () => {
    const validSuffixes = "PYLQGRJCUV0289";
    const rows = Array.from({ length: 27 }, (_, index) => ({
      clanTag: `2QG2C08U${validSuffixes[index % validSuffixes.length]}${
        validSuffixes[Math.floor(index / validSuffixes.length)] ?? ""
      }`,
      clanName: `Clan ${index + 1}`,
      upgrades: index + 100,
      joinType: index % 2 === 0 ? "open" : "closed",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      attacksCompleted: null,
      attacksMax: null,
      raidsCompleted: null,
    })) as any;

    const choices = buildRaidDashboardSelectChoices(rows, rows[9]?.clanTag ?? null);
    expect(choices).toHaveLength(25);
    expect(choices[0]?.value).toBe(rows[0]?.clanTag);
    expect(choices[0]?.label).toBe("Clan 1");
    expect(choices[9]?.value).toBe(rows[9]?.clanTag);
    expect(choices[9]?.label).toBe("Clan 10");
    expect(choices[9]?.selected).toBe(true);
    expect(choices[9]?.description).toContain(`#${rows[9]?.clanTag}`);
  });
});
