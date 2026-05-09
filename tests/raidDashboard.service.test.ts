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
  buildRaidDashboardOverviewDescription,
  buildRaidDashboardSelectChoices,
  buildRaidDashboardSingleClanDescription,
  loadRaidDashboardSeasonDetailWithQueueContext,
  listRaidDashboardRows,
  listRaidDashboardRowsWithQueueContext,
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
            },
          ];
        }
        return [];
      }),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.attacksCompleted).toBe(11);
    expect(rows[0]?.attacksMax).toBe(12);
    expect(rows[0]?.raidsCompleted).toBe(1);
    expect(rows[1]?.attacksCompleted).toBeNull();
    expect(rows[1]?.raidsCompleted).toBeNull();

    const overview = buildRaidDashboardOverviewDescription(rows);
    expect(overview).toContain("## Raid Clans");
    expect(overview).toContain("🔓 [Alpha Raid]");
    expect(overview).toContain("Attacks: 11/12");
    expect(overview).toContain("Raids completed: 1");
    expect(overview).toContain("Updated:");

    const single = buildRaidDashboardSingleClanDescription(rows[0]!);
    expect(single).toContain("## Raid Clan");
    expect(single).toContain("Join type: Open");
    expect(single).toContain("Upgrades: 2210");
    expect(single).toContain("Attacks: 11/12");
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
        };
      }),
    };

    const rows = await listRaidDashboardRows({ cocService: cocService as any });
    expect(rows[0]?.raidsCompleted).toBe(1);

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
    expect(detail?.defenseSections[0]?.districtsRemaining).toBe(1);
    expect(cocService.getClan).toHaveBeenCalledTimes(1);

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
    expect(buildRaidDashboardOverviewDescription(rows)).toContain("Attacks: —");
    expect(buildRaidDashboardOverviewDescription(rows)).toContain("Raids completed: —");
  });

  it("prioritizes the selected clan in the dropdown and caps options at 25", () => {
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
    expect(choices[0]?.value).toBe(rows[9]?.clanTag);
    expect(choices[0]?.label).toBe("Clan 10");
    expect(choices[0]?.description).toContain(`#${rows[9]?.clanTag}`);
  });
});
