import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaClansCatalogSyncService } from "../src/services/fwa-feeds/FwaClansCatalogSyncService";
import { computeFeedContentHash } from "../src/services/fwa-feeds/hash";

const txMock = vi.hoisted(() => ({
  fwaClanCatalog: {
    upsert: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("FwaClansCatalogSyncService weightSubmitDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    prismaMock.fwaFeedSyncState.findFirst.mockResolvedValue(null);
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue({});
    txMock.fwaClanCatalog.upsert.mockResolvedValue({});
  });

  it("persists source-provided dates on create and normalizes absent or invalid dates to null", async () => {
    const client = {
      fetchClans: vi.fn().mockResolvedValue([
        {
          clanTag: "#AAA111",
          name: "Alpha",
          level: null,
          points: null,
          type: null,
          location: null,
          requiredTrophies: null,
          warFrequency: null,
          winStreak: null,
          wins: null,
          ties: null,
          losses: null,
          isWarLogPublic: null,
          imageUrl: null,
          description: null,
          th18Count: null,
          th17Count: null,
          th16Count: null,
          th15Count: null,
          th14Count: null,
          th13Count: null,
          th12Count: null,
          th11Count: null,
          th10Count: null,
          th9Count: null,
          th8Count: null,
          thLowCount: null,
          estimatedWeight: 145000,
          weightSubmitDate: new Date("2026-08-09T05:37:17.000Z"),
        },
        {
          clanTag: "#BBB222",
          name: "Bravo",
          level: null,
          points: null,
          type: null,
          location: null,
          requiredTrophies: null,
          warFrequency: null,
          winStreak: null,
          wins: null,
          ties: null,
          losses: null,
          isWarLogPublic: null,
          imageUrl: null,
          description: null,
          th18Count: null,
          th17Count: null,
          th16Count: null,
          th15Count: null,
          th14Count: null,
          th13Count: null,
          th12Count: null,
          th11Count: null,
          th10Count: null,
          th9Count: null,
          th8Count: null,
          thLowCount: null,
          estimatedWeight: null,
          weightSubmitDate: null,
        },
      ]),
    };

    const service = new FwaClansCatalogSyncService(client as any);
    await service.syncGlobalCatalog({ force: true, now: new Date("2026-08-09T06:00:00.000Z") });

    expect(txMock.fwaClanCatalog.upsert).toHaveBeenCalledTimes(2);
    expect(txMock.fwaClanCatalog.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        update: expect.objectContaining({
          weightSubmitDate: new Date("2026-08-09T05:37:17.000Z"),
        }),
        create: expect.objectContaining({
          weightSubmitDate: new Date("2026-08-09T05:37:17.000Z"),
        }),
      }),
    );
    expect(txMock.fwaClanCatalog.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        update: expect.objectContaining({ weightSubmitDate: null }),
        create: expect.objectContaining({ weightSubmitDate: null }),
      }),
    );
  });

  it("updates the stored date when a later submission changes the feed row", async () => {
    const firstDate = new Date("2026-08-09T05:37:17.000Z");
    const secondDate = new Date("2026-08-09T06:37:17.000Z");
    const row = (weightSubmitDate: Date) => ({
      clanTag: "#AAA111",
      name: "Alpha",
      level: null,
      points: null,
      type: null,
      location: null,
      requiredTrophies: null,
      warFrequency: null,
      winStreak: null,
      wins: null,
      ties: null,
      losses: null,
      isWarLogPublic: null,
      imageUrl: null,
      description: null,
      th18Count: null,
      th17Count: null,
      th16Count: null,
      th15Count: null,
      th14Count: null,
      th13Count: null,
      th12Count: null,
      th11Count: null,
      th10Count: null,
      th9Count: null,
      th8Count: null,
      thLowCount: null,
      estimatedWeight: 145000,
      weightSubmitDate,
    });
    const client = {
      fetchClans: vi.fn().mockResolvedValueOnce([row(firstDate)]).mockResolvedValueOnce([row(secondDate)]),
    };
    prismaMock.fwaFeedSyncState.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ lastContentHash: computeFeedContentHash([row(firstDate)]) });
    const service = new FwaClansCatalogSyncService(client as any);

    await service.syncGlobalCatalog({ force: true });
    await service.syncGlobalCatalog({ force: true });

    expect(txMock.fwaClanCatalog.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ weightSubmitDate: secondDate }),
        create: expect.objectContaining({ weightSubmitDate: secondDate }),
      }),
    );
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });
});
