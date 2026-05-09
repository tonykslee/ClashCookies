import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  raidIntelDistrictLayoutMark: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildRaidIntelDistrictKey,
  buildRaidIntelLayoutGradeLabel,
} from "../src/services/RaidDashboardService";
import {
  loadRaidIntelLayoutGradeLookupForSeason,
  normalizeRaidIntelLayoutGrade,
  upsertRaidIntelDistrictLayoutMark,
} from "../src/services/RaidIntelLayoutMarkService";

describe("RaidIntelLayoutMarkService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads saved marks for the selected guild, source clan, and raid season", async () => {
    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValueOnce([
      {
        id: 1,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UQ",
        districtName: "Capital Hall",
        districtHallLevel: 5,
        layoutGrade: "CUSTOM_HARD",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
    ]);

    const lookup = await loadRaidIntelLayoutGradeLookupForSeason({
      guildId: "guild-1",
      sourceClanTag: "2QG2C08UP",
      raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
    });

    const key = buildRaidIntelDistrictKey({
      defenderTag: "2QG2C08UQ",
      districtName: "Capital Hall",
    });
    expect(lookup.get(key)).toBe("Custom - Hard");
    expect(prismaMock.raidIntelDistrictLayoutMark.findMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
      },
      orderBy: [{ defenderTag: "asc" }, { districtName: "asc" }],
      select: {
        id: true,
        guildId: true,
        sourceClanTag: true,
        raidSeasonStartTime: true,
        defenderTag: true,
        districtName: true,
        districtHallLevel: true,
        layoutGrade: true,
        markedByDiscordUserId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it("keeps marks scoped by guild, source clan, and raid season", async () => {
    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValueOnce([
      {
        id: 1,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UQ",
        districtName: "Capital Hall",
        districtHallLevel: 5,
        layoutGrade: "CUSTOM_HARD",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
    ]);
    const currentLookup = await loadRaidIntelLayoutGradeLookupForSeason({
      guildId: "guild-1",
      sourceClanTag: "2QG2C08UP",
      raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
    });
    expect(currentLookup.size).toBe(1);

    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValueOnce([]);
    const otherSeasonLookup = await loadRaidIntelLayoutGradeLookupForSeason({
      guildId: "guild-1",
      sourceClanTag: "2QG2C08UP",
      raidSeasonStartTime: new Date("2026-05-15T00:00:00.000Z"),
    });
    expect(otherSeasonLookup.size).toBe(0);
  });

  it("maps persisted enum values to display labels", () => {
    expect(buildRaidIntelLayoutGradeLabel("DEFAULT")).toBe("Default");
    expect(buildRaidIntelLayoutGradeLabel("CUSTOM_HARD")).toBe("Custom - Hard");
    expect(buildRaidIntelLayoutGradeLabel("CUSTOM_MEDIUM")).toBe("Custom - Medium");
    expect(buildRaidIntelLayoutGradeLabel("CUSTOM_EASY")).toBe("Custom - Easy");
    expect(buildRaidIntelLayoutGradeLabel(null)).toBe("Unmarked");
    expect(normalizeRaidIntelLayoutGrade("CUSTOM_HARD")).toBe("CUSTOM_HARD");
    expect(normalizeRaidIntelLayoutGrade("unknown")).toBeNull();
  });

  it("upserts a mark using the scoped season identity", async () => {
    prismaMock.raidIntelDistrictLayoutMark.upsert.mockResolvedValueOnce({
      id: 1,
      guildId: "guild-1",
      sourceClanTag: "2QG2C08UP",
      raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
      defenderTag: "2QG2C08UQ",
      districtName: "Capital Hall",
      districtHallLevel: 5,
      layoutGrade: "CUSTOM_MEDIUM",
      markedByDiscordUserId: "user-1",
      createdAt: new Date("2026-05-08T01:00:00.000Z"),
      updatedAt: new Date("2026-05-08T01:00:00.000Z"),
    });

    await upsertRaidIntelDistrictLayoutMark({
      guildId: "guild-1",
      sourceClanTag: "2QG2C08UP",
      raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
      defenderTag: "2QG2C08UQ",
      districtName: "Capital Hall",
      districtHallLevel: 5,
      layoutGrade: "CUSTOM_MEDIUM",
      markedByDiscordUserId: "user-1",
    });

    expect(prismaMock.raidIntelDistrictLayoutMark.upsert).toHaveBeenCalledWith({
      where: {
        guildId_sourceClanTag_raidSeasonStartTime_defenderTag_districtName: {
          guildId: "guild-1",
          sourceClanTag: "2QG2C08UP",
          raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
          defenderTag: "2QG2C08UQ",
          districtName: "Capital Hall",
        },
      },
      create: {
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UQ",
        districtName: "Capital Hall",
        districtHallLevel: 5,
        layoutGrade: "CUSTOM_MEDIUM",
        markedByDiscordUserId: "user-1",
      },
      update: {
        districtHallLevel: 5,
        layoutGrade: "CUSTOM_MEDIUM",
        markedByDiscordUserId: "user-1",
      },
      select: {
        id: true,
        guildId: true,
        sourceClanTag: true,
        raidSeasonStartTime: true,
        defenderTag: true,
        districtName: true,
        districtHallLevel: true,
        layoutGrade: true,
        markedByDiscordUserId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });
});
