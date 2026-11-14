import { resolveEffectivePlayerWeight } from "../helper/effectiveWeightResolution";
import { prisma } from "../prisma";
import { toPositiveCompoWeight } from "../helper/compoActualWeight";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
import { listOpenDeferredWeightsByClanAndPlayerTags } from "./WeightInputDefermentService";

type FwaClanMemberCurrentRow = {
  playerTag: string;
  weight: number | null;
  sourceSyncedAt: Date;
};

type FwaPlayerCatalogRow = {
  playerTag: string;
  latestKnownWeight: number | null;
};

type PlayerCurrentRow = {
  playerTag: string;
  currentWeight: number | null;
};

type WarFallbackRow = {
  clanTag: string;
  playerTag: string;
  effectiveWeight: number | null;
  updatedAt: Date;
};

/** Purpose: resolve the display weight for link-list rows using persisted weight precedence. */
export async function resolveLinkListDisplayWeightsByPlayerTags(input: {
  playerTagsInOrder: string[];
  guildId?: string | null;
  clanTag?: string | null;
}): Promise<Map<string, number | null>> {
  const normalizedOrdered = input.playerTagsInOrder
    .map((tag) => normalizePlayerTag(tag))
    .filter(Boolean);
  const result = new Map<string, number | null>();
  for (const playerTag of normalizedOrdered) {
    result.set(playerTag, null);
  }
  if (normalizedOrdered.length === 0) {
    return result;
  }

  const uniqueOrdered = [...new Set(normalizedOrdered)];
  const normalizedClanTag = input.clanTag ? normalizeClanTag(input.clanTag) : null;
  const warRosterCurrent = prisma.fwaTrackedClanWarRosterMemberCurrent;
  const warFallbackRowsPromise = warRosterCurrent?.findMany
    ? warRosterCurrent.findMany({
        where: {
          playerTag: { in: uniqueOrdered },
          effectiveWeight: { not: null },
        },
        select: {
          clanTag: true,
          playerTag: true,
          effectiveWeight: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "desc" }, { clanTag: "asc" }, { playerTag: "asc" }],
      })
    : Promise.resolve([]);
  const [memberRows, catalogRows, playerCurrentRows, warFallbackRows] = await Promise.all([
    prisma.fwaClanMemberCurrent.findMany({
      where: {
        playerTag: { in: uniqueOrdered },
        ...(normalizedClanTag ? { clanTag: normalizedClanTag } : {}),
      },
      orderBy: [{ playerTag: "asc" }, { sourceSyncedAt: "desc" }, { clanTag: "asc" }],
      select: {
        playerTag: true,
        weight: true,
        sourceSyncedAt: true,
      },
    }),
    prisma.fwaPlayerCatalog.findMany({
      where: { playerTag: { in: uniqueOrdered } },
      select: {
        playerTag: true,
        latestKnownWeight: true,
      },
    }),
    prisma.playerCurrent.findMany({
      where: { playerTag: { in: uniqueOrdered } },
      select: {
        playerTag: true,
        currentWeight: true,
      },
    }),
    warFallbackRowsPromise,
  ]);
  let deferredByPlayerTag = new Map<string, number>();
  if (input.guildId && input.clanTag) {
    const normalizedClanTag = normalizeClanTag(input.clanTag);
    const rowsByClan = await listOpenDeferredWeightsByClanAndPlayerTags({
      guildId: input.guildId,
      clanPlayerTags: [
        {
          clanTag: normalizedClanTag,
          playerTags: uniqueOrdered,
        },
      ],
    });
    deferredByPlayerTag = rowsByClan.get(normalizedClanTag) ?? new Map<string, number>();
  }

  const memberWeightByTag = new Map<string, number | null>();
  for (const row of memberRows as FwaClanMemberCurrentRow[]) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag || memberWeightByTag.has(playerTag)) continue;
    memberWeightByTag.set(playerTag, toPositiveCompoWeight(row.weight));
  }

  const catalogWeightByTag = new Map<string, number | null>();
  for (const row of catalogRows as FwaPlayerCatalogRow[]) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag || catalogWeightByTag.has(playerTag)) continue;
    catalogWeightByTag.set(playerTag, toPositiveCompoWeight(row.latestKnownWeight));
  }

  const currentWeightByTag = new Map<string, number | null>();
  for (const row of playerCurrentRows as PlayerCurrentRow[]) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag || currentWeightByTag.has(playerTag)) continue;
    currentWeightByTag.set(playerTag, toPositiveCompoWeight(row.currentWeight));
  }

  const warWeightByClanAndTag = new Map<string, number>();
  const warWeightByTag = new Map<string, number>();
  for (const row of warFallbackRows as WarFallbackRow[]) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    const effectiveWeight = toPositiveCompoWeight(row.effectiveWeight);
    if (!clanTag || !playerTag || effectiveWeight === null) continue;
    const clanAndPlayerTagKey = `${clanTag}|${playerTag}`;
    if (!warWeightByClanAndTag.has(clanAndPlayerTagKey)) {
      warWeightByClanAndTag.set(clanAndPlayerTagKey, effectiveWeight);
    }
    if (!warWeightByTag.has(playerTag)) {
      warWeightByTag.set(playerTag, effectiveWeight);
    }
  }

  for (const playerTag of normalizedOrdered) {
    const resolved = resolveEffectivePlayerWeight({
      primaryCandidates: [
        { source: "member", weight: memberWeightByTag.get(playerTag) ?? null },
        { source: "catalog", weight: catalogWeightByTag.get(playerTag) ?? null },
      ],
      overrideCandidates: [
        { source: "defer", weight: deferredByPlayerTag.get(playerTag) ?? null },
      ],
      fallbackCandidates: [
        { source: "current", weight: currentWeightByTag.get(playerTag) ?? null },
        {
          source: "war",
          weight:
            normalizedClanTag
              ? warWeightByClanAndTag.get(`${normalizedClanTag}|${playerTag}`) ?? null
              : null,
        },
        { source: "war", weight: warWeightByTag.get(playerTag) ?? null },
      ],
    });
    result.set(playerTag, resolved.resolvedWeight);
  }

  return result;
}
