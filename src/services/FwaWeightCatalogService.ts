import { prisma } from "../prisma";
import { normalizeTag } from "./war-events/core";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FwaCatalogWeightAge = {
  clanTag: string;
  weightSubmitDate: Date | null;
  ageDays: number | null;
  ageText: string | null;
};

/** Purpose: build the existing FWA Stats weight page URL for link-only consumers. */
export function buildFwaWeightPageUrl(clanTag: string): string {
  const normalized = normalizeTag(clanTag).replace(/^#/, "");
  return `https://fwastats.com/Clan/${normalized}/Weight`;
}

function normalizeWeightTag(input: string): string {
  return normalizeTag(input).replace(/^#/, "");
}

/** Purpose: derive a safe persisted-catalog weight age at command render time. */
export function deriveFwaCatalogWeightAge(
  clanTag: string,
  weightSubmitDate: Date | null | undefined,
  now: Date = new Date(),
): FwaCatalogWeightAge {
  const normalizedTag = normalizeWeightTag(clanTag);
  if (
    !(weightSubmitDate instanceof Date) ||
    !Number.isFinite(weightSubmitDate.getTime()) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    return {
      clanTag: normalizedTag,
      weightSubmitDate: null,
      ageDays: null,
      ageText: null,
    };
  }

  const ageMs = Math.max(0, now.getTime() - weightSubmitDate.getTime());
  const totalHours = Math.floor(ageMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return {
    clanTag: normalizedTag,
    weightSubmitDate,
    ageDays: ageMs / DAY_MS,
    ageText: `${days}d ${hours}h ago`,
  };
}

/** Purpose: bulk-read persisted FwaClanCatalog dates for weight-age/health commands. */
export class FwaWeightCatalogService {
  async getWeightAges(clanTags: string[], now: Date = new Date()): Promise<Map<string, FwaCatalogWeightAge>> {
    const normalizedTags = [
      ...new Set((clanTags ?? []).map((tag) => normalizeWeightTag(tag)).filter(Boolean)),
    ];
    const results = new Map<string, FwaCatalogWeightAge>();
    for (const clanTag of normalizedTags) {
      results.set(clanTag, deriveFwaCatalogWeightAge(clanTag, null, now));
    }
    if (normalizedTags.length <= 0) return results;

    const rows = await prisma.fwaClanCatalog.findMany({
      where: { clanTag: { in: normalizedTags.map((tag) => `#${tag}`) } },
      select: {
        clanTag: true,
        weightSubmitDate: true,
      },
    });
    for (const row of rows) {
      const clanTag = normalizeWeightTag(row.clanTag);
      if (!clanTag || !results.has(clanTag)) continue;
      results.set(
        clanTag,
        deriveFwaCatalogWeightAge(clanTag, row.weightSubmitDate, now),
      );
    }
    return results;
  }
}

export const fwaWeightCatalogService = new FwaWeightCatalogService();
