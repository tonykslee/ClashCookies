import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  currentCwlRound: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { remainingCwlService } from "../src/services/RemainingCwlService";

describe("remaining CWL service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads one tracked clan view from persisted current round state only", async () => {
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha CWL",
    });
    prismaMock.currentCwlRound.findUnique.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha CWL",
      roundDay: 2,
      roundState: "inWar",
      startTime: new Date("2026-03-08T10:00:00.000Z"),
      endTime: new Date("2026-03-08T11:00:00.000Z"),
    });

    const view = await remainingCwlService.getClanView({
      season: "2026-03",
      clanTag: "2QG2C08UP",
    });

    expect(view).toEqual({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha CWL",
      roundDay: 2,
      roundState: "inWar",
      battleDayStartsAt: null,
      battleDayEndsAt: new Date("2026-03-08T11:00:00.000Z"),
      nextWarAt: new Date("2026-03-09T11:00:00.000Z"),
    });
  });

  it("lists tracked clans and preserves unknown timing when no round exists", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Alpha CWL" },
      { tag: "#9GLGQCCU", name: "Bravo CWL" },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        clanName: "Alpha CWL",
        roundDay: 3,
        roundState: "preparation",
        startTime: new Date("2026-03-08T10:00:00.000Z"),
        endTime: new Date("2026-03-09T10:00:00.000Z"),
      },
    ]);

    const views = await remainingCwlService.listClanViews({ season: "2026-03" });

    expect(views).toEqual([
      {
        clanTag: "#2QG2C08UP",
        clanName: "Alpha CWL",
        roundDay: 3,
        roundState: "preparation",
        battleDayStartsAt: new Date("2026-03-08T10:00:00.000Z"),
        battleDayEndsAt: null,
        nextWarAt: new Date("2026-03-08T10:00:00.000Z"),
      },
      {
        clanTag: "#9GLGQCCU",
        clanName: "Bravo CWL",
        roundDay: null,
        roundState: null,
        battleDayStartsAt: null,
        battleDayEndsAt: null,
        nextWarAt: null,
      },
    ]);
  });
});
