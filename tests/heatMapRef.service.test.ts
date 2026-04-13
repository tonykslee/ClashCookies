import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  heatMapRef: {
    upsert: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { HEAT_MAP_REF_SEED_ROWS } from "../src/services/HeatMapRefSeedData";
import { getAllHeatMapRefs, upsertHeatMapRefSeedRows } from "../src/services/HeatMapRefService";

describe("HeatMapRefService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the corrected checked-in HeatMapRef bootstrap rows", () => {
    expect(HEAT_MAP_REF_SEED_ROWS).toHaveLength(11);
    expect(HEAT_MAP_REF_SEED_ROWS[0]).toMatchObject({
      weightMinInclusive: 0,
      weightMaxInclusive: 7_200_000,
      th18Count: 3,
      th17Count: 6,
      th16Count: 7,
      th15Count: 9,
      th14Count: 9,
      th13Count: 8,
      th12Count: 5,
      th11Count: 2,
      th10OrLowerCount: 0,
      contributingClanCount: 0,
      sourceVersion: "bootstrap-2026-03-17",
    });
    expect(HEAT_MAP_REF_SEED_ROWS[9]).toMatchObject({
      weightMinInclusive: 8_000_001,
      weightMaxInclusive: 8_100_000,
      th18Count: 19,
      th17Count: 11,
      th16Count: 7,
      th15Count: 6,
      th14Count: 4,
      th13Count: 2,
      th12Count: 1,
      th11Count: 0,
      th10OrLowerCount: 0,
      contributingClanCount: 0,
    });
    expect(HEAT_MAP_REF_SEED_ROWS[10]).toMatchObject({
      weightMinInclusive: 8_110_000,
      weightMaxInclusive: 9_999_999,
      th18Count: 22,
      th17Count: 11,
      th16Count: 7,
      th15Count: 6,
      th14Count: 3,
      th13Count: 1,
      th12Count: 0,
      th11Count: 0,
      th10OrLowerCount: 0,
      contributingClanCount: 0,
    });
  });

  it("upserts the checked-in HeatMapRef bootstrap dataset by composite key and prunes obsolete rows", async () => {
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      {
        weightMinInclusive: 5_500_000,
        weightMaxInclusive: 5_799_999,
      },
      {
        weightMinInclusive: HEAT_MAP_REF_SEED_ROWS[0].weightMinInclusive,
        weightMaxInclusive: HEAT_MAP_REF_SEED_ROWS[0].weightMaxInclusive,
      },
    ]);
    prismaMock.heatMapRef.upsert.mockResolvedValue(undefined);
    prismaMock.heatMapRef.delete.mockResolvedValue(undefined);

    const count = await upsertHeatMapRefSeedRows(HEAT_MAP_REF_SEED_ROWS);

    expect(count).toBe(HEAT_MAP_REF_SEED_ROWS.length);
    expect(prismaMock.heatMapRef.upsert).toHaveBeenCalledTimes(HEAT_MAP_REF_SEED_ROWS.length);
    expect(prismaMock.heatMapRef.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          weightMinInclusive_weightMaxInclusive: {
            weightMinInclusive: HEAT_MAP_REF_SEED_ROWS[0].weightMinInclusive,
            weightMaxInclusive: HEAT_MAP_REF_SEED_ROWS[0].weightMaxInclusive,
          },
        },
      }),
    );
    expect(prismaMock.heatMapRef.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.heatMapRef.delete).toHaveBeenCalledWith({
      where: {
        weightMinInclusive_weightMaxInclusive: {
          weightMinInclusive: 5_500_000,
          weightMaxInclusive: 5_799_999,
        },
      },
    });
  });

  it("does not create duplicate rows on reseed when the same corrected keys already exist", async () => {
    prismaMock.heatMapRef.findMany.mockResolvedValue(
      HEAT_MAP_REF_SEED_ROWS.map((row) => ({
        weightMinInclusive: row.weightMinInclusive,
        weightMaxInclusive: row.weightMaxInclusive,
      })),
    );
    prismaMock.heatMapRef.upsert.mockResolvedValue(undefined);

    await upsertHeatMapRefSeedRows(HEAT_MAP_REF_SEED_ROWS);

    expect(prismaMock.heatMapRef.upsert).toHaveBeenCalledTimes(HEAT_MAP_REF_SEED_ROWS.length);
    expect(prismaMock.heatMapRef.delete).not.toHaveBeenCalled();
  });

  it("loads persisted HeatMapRef rows in ascending band order", async () => {
    prismaMock.heatMapRef.findMany.mockResolvedValue([]);

    await getAllHeatMapRefs();

    expect(prismaMock.heatMapRef.findMany).toHaveBeenCalledWith({
      orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
    });
  });
});
