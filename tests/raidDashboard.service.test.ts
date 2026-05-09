import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  raidTrackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildRaidDashboardOverviewDescription,
  buildRaidDashboardSelectChoices,
  buildRaidDashboardSingleClanDescription,
  listRaidDashboardRows,
} from "../src/services/RaidDashboardService";

describe("RaidDashboardService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(rows[1]?.attacksCompleted).toBeNull();
    expect(rows[1]?.raidsCompleted).toBeNull();

    const overview = buildRaidDashboardOverviewDescription(rows);
    expect(overview).toContain("## Raid Clans");
    expect(overview).toContain("🔓 [Alpha Raid]");
    expect(overview).toContain("Attacks: 11/12");
    expect(overview).toContain("Raids completed: —");
    expect(overview).toContain("Updated:");

    const single = buildRaidDashboardSingleClanDescription(rows[0]!);
    expect(single).toContain("## Raid Clan");
    expect(single).toContain("Join type: Open");
    expect(single).toContain("Upgrades: 2210");
    expect(single).toContain("Attacks: 11/12");
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
