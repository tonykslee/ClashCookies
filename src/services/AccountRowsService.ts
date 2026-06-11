import { prisma } from "../prisma";
import { resolveEffectivePlayerWeight } from "../helper/effectiveWeightResolution";
import { playerCurrentService } from "./PlayerCurrentService";
import { listOpenDeferredWeightsByClanAndPlayerTags } from "./WeightInputDefermentService";
import { normalizeClashTagInput } from "../helper/clashTag";

type AccountRow = {
  tag: string;
  name: string;
  townHall: number | null;
  weight: number | null;
  weightSource:
    | "FwaClanMemberCurrent"
    | "FwaPlayerCatalog"
    | "PlayerCurrent"
    | "ExternalPlayerWeightCurrent"
    | "WeightInputDeferment"
    | null;
  clanTag: string | null;
  clanName: string | null;
  clanRole: "leader" | "coleader" | null;
  clanState: "known" | "no_clan" | "unknown";
  isTrackedFwaClan: boolean;
  trackedClanSortOrder: number | null;
};

type PlayerCurrentSnapshot = Awaited<
  ReturnType<typeof playerCurrentService.listPlayerCurrentByTags>
> extends Map<string, infer T>
  ? T
  : never;

type FwaClanMemberCurrentRow = {
  playerTag: string;
  clanTag: string;
  townHall: number | null;
  weight: number | null;
  sourceSyncedAt: Date;
};

type FwaPlayerCatalogRow = {
  playerTag: string;
  latestTownHall: number | null;
  latestKnownWeight: number | null;
};

type ExternalPlayerWeightCurrentRow = {
  playerTag: string;
  weight: number | null;
  measuredAt: Date;
  source: string;
};

type AccountWeightContext = {
  tag: string;
  playerCurrent: PlayerCurrentSnapshot | null;
  fallback: { clanTag: string | null; clanName: string | null; name: string | null } | null;
  linkedName: string | null;
  clanTag: string | null;
  clanName: string | null;
  clanState: "known" | "no_clan" | "unknown";
  preferredMemberRow: FwaClanMemberCurrentRow | null;
  fwaCatalogRow: FwaPlayerCatalogRow | null;
  playerCurrentWeight: number | null;
  externalWeight: number | null;
  deferredWeight: number | null;
  isTrackedFwaClan: boolean;
  trackedClanSortOrder: number | null;
};

function normalizeTag(input: string): string {
  return normalizeClashTagInput(input);
}

function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeClanMemberRole(input: unknown): "leader" | "coleader" | null {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (normalized === "leader") return "leader";
  if (normalized === "coleader") return "coleader";
  return null;
}

function normalizePositiveInteger(input: unknown): number | null {
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function pickPreferredFwaMemberRow(
  rows: FwaClanMemberCurrentRow[],
  clanTag: string | null,
): FwaClanMemberCurrentRow | null {
  if (rows.length === 0) return null;
  const normalizedClanTag = normalizeTag(clanTag ?? "");
  if (normalizedClanTag) {
    const exactMatch = rows.find((row) => normalizeTag(row.clanTag) === normalizedClanTag);
    if (exactMatch) return exactMatch;
  }
  return [...rows].sort((a, b) => b.sourceSyncedAt.getTime() - a.sourceSyncedAt.getTime())[0] ?? null;
}

function isConfirmedClanlessSource(source: string | null | undefined): boolean {
  const normalized = sanitizeDisplayText(source)?.toLowerCase() ?? null;
  return normalized === "accounts-refresh" || normalized === "live_refresh";
}

function resolveAccountClanState(input: {
  playerCurrent: PlayerCurrentSnapshot | null;
  playerActivity: { clanTag: string | null; clanName: string | null } | null;
}): "known" | "no_clan" | "unknown" {
  const currentClanTag = sanitizeDisplayText(input.playerCurrent?.currentClanTag);
  const activityClanTag = sanitizeDisplayText(input.playerActivity?.clanTag);
  if (currentClanTag || activityClanTag) return "known";
  if (isConfirmedClanlessSource(input.playerCurrent?.lastSource)) return "no_clan";
  return "unknown";
}

/** Purpose: build consistent account rows from persisted player/clan state. */
export async function buildAccountsRows(input: {
  guildId: string;
  linkedNameByTag: Map<string, string>;
  tags: string[];
}): Promise<AccountRow[]> {
  const playerCurrentByTag = await playerCurrentService.listPlayerCurrentByTags(input.tags);
  const activity = await prisma.playerActivity.findMany({
    where: { guildId: input.guildId, tag: { in: input.tags } },
    select: { tag: true, name: true, clanTag: true, clanName: true },
  });
  const activityByTag = new Map(activity.map((a) => [normalizeTag(a.tag), a]));
  const fwaMemberRows = await prisma.fwaClanMemberCurrent.findMany({
    where: { playerTag: { in: input.tags } },
    select: {
      playerTag: true,
      clanTag: true,
      townHall: true,
      weight: true,
      sourceSyncedAt: true,
    },
  });
  const fwaMemberRowsByTag = new Map<string, FwaClanMemberCurrentRow[]>();
  for (const row of fwaMemberRows as FwaClanMemberCurrentRow[]) {
    const playerTag = normalizeTag(row.playerTag);
    if (!playerTag) continue;
    const bucket = fwaMemberRowsByTag.get(playerTag) ?? [];
    bucket.push({
      playerTag,
      clanTag: normalizeTag(row.clanTag),
      townHall: normalizePositiveInteger(row.townHall),
      weight: normalizePositiveInteger(row.weight),
      sourceSyncedAt: row.sourceSyncedAt,
    });
    fwaMemberRowsByTag.set(playerTag, bucket);
  }
  const fwaCatalogRows = await prisma.fwaPlayerCatalog.findMany({
    where: { playerTag: { in: input.tags } },
    select: {
      playerTag: true,
      latestTownHall: true,
      latestKnownWeight: true,
    },
  });
  const fwaCatalogByTag = new Map<string, FwaPlayerCatalogRow>();
  for (const row of fwaCatalogRows as FwaPlayerCatalogRow[]) {
    const playerTag = normalizeTag(row.playerTag);
    if (!playerTag) continue;
    fwaCatalogByTag.set(playerTag, {
      playerTag,
      latestTownHall: normalizePositiveInteger(row.latestTownHall),
      latestKnownWeight: normalizePositiveInteger(row.latestKnownWeight),
    });
  }
  const externalWeightRows = await prisma.externalPlayerWeightCurrent.findMany({
    where: { playerTag: { in: input.tags } },
    select: {
      playerTag: true,
      weight: true,
      measuredAt: true,
      source: true,
    },
  });
  const externalWeightByTag = new Map<string, ExternalPlayerWeightCurrentRow>();
  for (const row of externalWeightRows as ExternalPlayerWeightCurrentRow[]) {
    const playerTag = normalizeTag(row.playerTag);
    if (!playerTag) continue;
    externalWeightByTag.set(playerTag, {
      playerTag,
      weight: normalizePositiveInteger(row.weight),
      measuredAt: row.measuredAt,
      source: sanitizeDisplayText(row.source) ?? "",
    });
  }
  const candidateClanTags = [
    ...new Set([
      ...input.tags
        .map((tag) => {
          const current = playerCurrentByTag.get(tag) ?? null;
          return current?.currentClanTag ? normalizeTag(current.currentClanTag) : "";
        })
        .filter(Boolean),
      ...activity
        .map((row) => (row.clanTag ? normalizeTag(row.clanTag) : ""))
        .filter(Boolean),
    ]),
  ];
  const trackedClanRows =
    candidateClanTags.length > 0
      ? await prisma.trackedClan.findMany({
          orderBy: { createdAt: "asc" },
          where: { tag: { in: candidateClanTags } },
          select: { tag: true, name: true },
        })
      : [];
  const trackedClanNameByTag = new Map(
    trackedClanRows.map((row) => [normalizeTag(row.tag), sanitizeDisplayText(row.name)] as const),
  );
  const trackedClanSortOrderByTag = new Map(
    trackedClanRows.map((row, index) => [normalizeTag(row.tag), index] as const),
  );

  const contexts: AccountWeightContext[] = input.tags.map((tag) => {
    const playerCurrent = playerCurrentByTag.get(tag) ?? null;
    const fallback = activityByTag.get(tag) ?? null;
    const linkedName = input.linkedNameByTag.get(tag) ?? null;
    const currentClanTag = playerCurrent?.currentClanTag ? normalizeTag(playerCurrent.currentClanTag) : null;
    const fallbackClanTag = fallback?.clanTag ? normalizeTag(fallback.clanTag) : null;
    const clanTag = currentClanTag ?? fallbackClanTag ?? null;
    const currentClanName = sanitizeDisplayText(playerCurrent?.currentClanName);
    const fallbackClanName = sanitizeDisplayText(fallback?.clanName);
    const clanName =
      currentClanName ?? fallbackClanName ?? (clanTag ? trackedClanNameByTag.get(clanTag) ?? null : null);
    const clanState = resolveAccountClanState({
      playerCurrent,
      playerActivity: fallback
        ? { clanTag: fallback.clanTag ?? null, clanName: fallback.clanName ?? null }
        : null,
    });
    const memberRows = fwaMemberRowsByTag.get(tag) ?? [];
    const preferredMemberRow = pickPreferredFwaMemberRow(memberRows, clanTag);
    const fwaCatalogRow = fwaCatalogByTag.get(tag) ?? null;
    const isTrackedFwaClan = Boolean(clanTag && trackedClanNameByTag.has(clanTag));
    const trackedClanSortOrder = clanTag ? trackedClanSortOrderByTag.get(clanTag) ?? null : null;

    return {
      tag,
      playerCurrent,
      fallback: fallback
        ? {
            clanTag: fallback.clanTag ?? null,
            clanName: fallback.clanName ?? null,
            name: sanitizeDisplayText(fallback.name),
          }
        : null,
      linkedName,
      clanTag: clanState === "known" ? clanTag : null,
      clanName: clanState === "known" ? clanName : null,
      clanState,
      preferredMemberRow,
      fwaCatalogRow,
      playerCurrentWeight: normalizePositiveInteger(playerCurrent?.currentWeight),
      externalWeight: externalWeightByTag.get(tag)?.weight ?? null,
      deferredWeight: null,
      isTrackedFwaClan,
      trackedClanSortOrder,
    };
  });

  const deferredWeightByClanAndPlayerTag = await listOpenDeferredWeightsByClanAndPlayerTags({
    guildId: input.guildId,
    clanPlayerTags: contexts.map((context) => ({
      clanTag: context.clanTag,
      playerTags: [context.tag],
    })),
  });

  return contexts.map((context) => {
    const clanKey = context.clanTag ?? "";
    const deferredWeight = normalizePositiveInteger(
      deferredWeightByClanAndPlayerTag.get(clanKey)?.get(context.tag) ?? null,
    );
    const townHall =
      normalizePositiveInteger(context.playerCurrent?.townHall) ??
      context.preferredMemberRow?.townHall ??
      context.fwaCatalogRow?.latestTownHall ??
      null;
    const weight = resolveEffectivePlayerWeight({
      primaryCandidates: [
        { source: "FwaClanMemberCurrent", weight: context.preferredMemberRow?.weight },
        { source: "FwaPlayerCatalog", weight: context.fwaCatalogRow?.latestKnownWeight },
      ],
      overrideCandidates: [
        { source: "ExternalPlayerWeightCurrent", weight: context.externalWeight },
        { source: "WeightInputDeferment", weight: deferredWeight },
      ],
      fallbackCandidates: [{ source: "PlayerCurrent", weight: context.playerCurrentWeight }],
    });

    return {
      tag: context.tag,
      name:
        sanitizeDisplayText(context.playerCurrent?.playerName) ??
        context.linkedName ??
        context.fallback?.name ??
        context.tag,
      townHall,
      weight: weight.resolvedWeight,
      weightSource: weight.resolvedWeightSource,
      clanTag: context.clanState === "known" ? context.clanTag : null,
      clanName: context.clanState === "known" ? context.clanName : null,
      clanRole: normalizeClanMemberRole(context.playerCurrent?.role),
      clanState: context.clanState,
      isTrackedFwaClan: context.isTrackedFwaClan,
      trackedClanSortOrder: context.trackedClanSortOrder,
    };
  });
}
