import type { HeatMapRef } from "@prisma/client";
import { prisma } from "../prisma";

export type HeatMapRefSeedRow = {
  weightMinInclusive: number;
  weightMaxInclusive: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11Count: number;
  th10OrLowerCount: number;
  contributingClanCount: number;
  sourceVersion: string | null;
  refreshedAt: Date;
};

/** Purpose: fetch all persisted HeatMapRef rows in band order for future read-path consumers. */
export async function getAllHeatMapRefs(): Promise<HeatMapRef[]> {
  return prisma.heatMapRef.findMany({
    orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
  });
}

/** Purpose: seed or refresh HeatMapRef rows via stable composite-key upserts. */
export async function upsertHeatMapRefSeedRows(
  rows: readonly HeatMapRefSeedRow[],
): Promise<number> {
  const desiredKeys = new Set(
    rows.map((row) => `${row.weightMinInclusive}:${row.weightMaxInclusive}`),
  );
  const existingRows = await prisma.heatMapRef.findMany({
    select: {
      weightMinInclusive: true,
      weightMaxInclusive: true,
    },
  });

  for (const row of rows) {
    await prisma.heatMapRef.upsert({
      where: {
        weightMinInclusive_weightMaxInclusive: {
          weightMinInclusive: row.weightMinInclusive,
          weightMaxInclusive: row.weightMaxInclusive,
        },
      },
      create: {
        weightMinInclusive: row.weightMinInclusive,
        weightMaxInclusive: row.weightMaxInclusive,
        th18Count: row.th18Count,
        th17Count: row.th17Count,
        th16Count: row.th16Count,
        th15Count: row.th15Count,
        th14Count: row.th14Count,
        th13Count: row.th13Count,
        th12Count: row.th12Count,
        th11Count: row.th11Count,
        th10OrLowerCount: row.th10OrLowerCount,
        contributingClanCount: row.contributingClanCount,
        sourceVersion: row.sourceVersion,
        refreshedAt: row.refreshedAt,
      },
      update: {
        th18Count: row.th18Count,
        th17Count: row.th17Count,
        th16Count: row.th16Count,
        th15Count: row.th15Count,
        th14Count: row.th14Count,
        th13Count: row.th13Count,
        th12Count: row.th12Count,
        th11Count: row.th11Count,
        th10OrLowerCount: row.th10OrLowerCount,
        contributingClanCount: row.contributingClanCount,
        sourceVersion: row.sourceVersion,
        refreshedAt: row.refreshedAt,
      },
    });
  }

  for (const row of existingRows) {
    const key = `${row.weightMinInclusive}:${row.weightMaxInclusive}`;
    if (desiredKeys.has(key)) {
      continue;
    }

    await prisma.heatMapRef.delete({
      where: {
        weightMinInclusive_weightMaxInclusive: {
          weightMinInclusive: row.weightMinInclusive,
          weightMaxInclusive: row.weightMaxInclusive,
        },
      },
    });
  }

  return rows.length;
}
