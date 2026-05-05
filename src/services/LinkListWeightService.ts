import { prisma } from "../prisma";
import { toPositiveCompoWeight } from "../helper/compoActualWeight";
import { normalizePlayerTag } from "./PlayerLinkService";

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

/** Purpose: resolve the display weight for link-list rows using persisted weight precedence. */
export async function resolveLinkListDisplayWeightsByPlayerTags(input: {
  playerTagsInOrder: string[];
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
  const [memberRows, catalogRows, playerCurrentRows] = await Promise.all([
    prisma.fwaClanMemberCurrent.findMany({
      where: { playerTag: { in: uniqueOrdered } },
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
  ]);

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

  for (const playerTag of normalizedOrdered) {
    result.set(
      playerTag,
      memberWeightByTag.get(playerTag) ??
        catalogWeightByTag.get(playerTag) ??
        currentWeightByTag.get(playerTag) ??
        null,
    );
  }

  return result;
}
