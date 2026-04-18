import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  currentWar: {
    findUnique: vi.fn(),
  },
  trackedClan: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

const pointsSyncServiceMock = vi.hoisted(() => {
  const instance = {
    markNeedsValidation: vi.fn().mockResolvedValue(true),
    clearNeedsValidation: vi.fn().mockResolvedValue(true),
  };
  return { instance };
});

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PointsSyncService", () => ({
  PointsSyncService: vi.fn().mockImplementation(() => pointsSyncServiceMock.instance),
}));

import { markMatchLiveDataChangedForTest } from "../src/commands/Fwa";

describe("fwa match type confirmation validation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears same-war needs-validation dirtiness when a confirmed match type is applied", async () => {
    const warStartTime = new Date("2026-03-12T08:00:00.000Z");
    prismaMock.currentWar.findUnique.mockResolvedValue({
      matchType: "FWA",
      outcome: "WIN",
      warId: "2001",
      startTime: warStartTime,
    });
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      mailConfig: {
        lastWarId: "2001",
        lastOpponentTag: "2OPP",
        lastMatchType: "BL",
        lastExpectedOutcome: "LOSE",
        lastDataChangedAtUnix: 0,
      },
    });
    prismaMock.trackedClan.update.mockResolvedValue({} as never);

    await markMatchLiveDataChangedForTest({
      guildId: "guild-1",
      tag: "2TRACK",
      channelId: "chan-1",
      needsValidation: false,
    });

    expect(pointsSyncServiceMock.instance.clearNeedsValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "2TRACK",
        warId: "2001",
        warStartTime,
      }),
    );
    expect(pointsSyncServiceMock.instance.markNeedsValidation).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.update).toHaveBeenCalledTimes(1);
  });
});
