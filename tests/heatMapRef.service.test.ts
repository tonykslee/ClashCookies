import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  heatMapRef: {
    upsert: vi.fn(),
    findMany: vi.fn(),
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

  it("upserts the checked-in HeatMapRef bootstrap dataset by composite key", async () => {
    prismaMock.heatMapRef.upsert.mockResolvedValue(undefined);

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
  });

  it("loads persisted HeatMapRef rows in ascending band order", async () => {
    prismaMock.heatMapRef.findMany.mockResolvedValue([]);

    await getAllHeatMapRefs();

    expect(prismaMock.heatMapRef.findMany).toHaveBeenCalledWith({
      orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
    });
  });
});
