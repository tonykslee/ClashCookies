import type {
  FwaTrackedClanWarRosterEffectiveWeightStatus,
  FwaWarMemberCurrent,
} from "@prisma/client";
import { prisma } from "../../prisma";
import { normalizeFwaTag } from "./normalize";

type SourceRosterRow = Pick<
  FwaWarMemberCurrent,
  | "playerTag"
  | "playerName"
  | "position"
  | "townHall"
  | "weight"
  | "opponentTag"
  | "opponentName"
  | "sourceSyncedAt"
>;

type NormalizedRosterRow = {
  playerTag: string;
  playerName: string;
  position: number;
  townHall: number;
  rawWeight: number;
  opponentTag: string | null;
  opponentName: string | null;
  sourceSyncedAt: Date;
};

type DerivedRosterMemberRow = NormalizedRosterRow & {
  effectiveWeight: number | null;
  effectiveWeightStatus: FwaTrackedClanWarRosterEffectiveWeightStatus;
};

type DerivedTrackedClanWarRosterSnapshot = {
  clanTag: string;
  clanName: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  rosterSize: number;
  totalRawWeight: number;
  totalEffectiveWeight: number | null;
  hasUnresolvedWeights: boolean;
  observedAt: Date;
  sourceUpdatedAt: Date | null;
  members: DerivedRosterMemberRow[];
};

function toSafeNonNegativeInt(input: number | null | undefined): number {
  if (!Number.isFinite(input)) return 0;
  return Math.max(0, Math.trunc(input as number));
}

/** Purpose: normalize persisted WarMembers rows into deterministic roster-order records. */
function normalizeTrackedClanWarRosterRows(
  rows: readonly SourceRosterRow[],
): NormalizedRosterRow[] {
  const normalized = rows
    .filter((row) => Number.isInteger(row.position) && (row.position ?? 0) > 0)
    .sort((a, b) => {
      const positionDelta = (a.position ?? 0) - (b.position ?? 0);
      if (positionDelta !== 0) return positionDelta;
      return a.playerTag.localeCompare(b.playerTag);
    });
  const seenPositions = new Set<number>();
  const deduped: NormalizedRosterRow[] = [];
  for (const row of normalized) {
    const position = Math.trunc(row.position ?? 0);
    if (seenPositions.has(position)) continue;
    seenPositions.add(position);
    deduped.push({
      playerTag: row.playerTag,
      playerName: row.playerName,
      position,
      townHall: toSafeNonNegativeInt(row.townHall),
      rawWeight: toSafeNonNegativeInt(row.weight),
      opponentTag: row.opponentTag ?? null,
      opponentName: row.opponentName ?? null,
      sourceSyncedAt: row.sourceSyncedAt,
    });
  }
  return deduped;
}

/** Purpose: persist the agreed zero-block fill rules as a reusable roster derivation helper. */
function applyEffectiveWeightRules(
  rows: readonly NormalizedRosterRow[],
): DerivedRosterMemberRow[] {
  const derived: DerivedRosterMemberRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const current = rows[index];
    if (current.rawWeight > 0) {
      derived.push({
        ...current,
        effectiveWeight: current.rawWeight,
        effectiveWeightStatus: "RAW",
      });
      index += 1;
      continue;
    }

    let zeroBlockEndExclusive = index + 1;
    while (zeroBlockEndExclusive < rows.length && rows[zeroBlockEndExclusive].rawWeight <= 0) {
      zeroBlockEndExclusive += 1;
    }
    const fillSource = rows[zeroBlockEndExclusive];
    const lowestResolvedWeightAbove = derived.reduce<number | null>((lowest, row) => {
      if (row.effectiveWeight === null || row.effectiveWeight <= 0) {
        return lowest;
      }
      if (lowest === null || row.effectiveWeight < lowest) {
        return row.effectiveWeight;
      }
      return lowest;
    }, null);
    const fillWeight =
      fillSource?.rawWeight && fillSource.rawWeight > 0
        ? fillSource.rawWeight
        : lowestResolvedWeightAbove;
    for (let zeroIndex = index; zeroIndex < zeroBlockEndExclusive; zeroIndex += 1) {
      const row = rows[zeroIndex];
      derived.push({
        ...row,
        effectiveWeight: fillWeight,
        effectiveWeightStatus: fillWeight === null ? "UNRESOLVED_TRAILING_ZERO" : "FILLED_FROM_LOWER_BLOCK",
      });
    }
    index = zeroBlockEndExclusive;
  }
  return derived;
}

/** Purpose: build one latest-only tracked-clan roster snapshot from persisted WarMembers state. */
function deriveTrackedClanWarRosterSnapshot(input: {
  clanTag: string;
  clanName?: string | null;
  observedAt: Date;
  rows: readonly SourceRosterRow[];
}): DerivedTrackedClanWarRosterSnapshot | null {
  const normalized = normalizeTrackedClanWarRosterRows(input.rows);
  if (normalized.length === 0) return null;
  const members = applyEffectiveWeightRules(normalized);
  const firstOpponent = members.find((row) => row.opponentTag || row.opponentName) ?? null;
  const sourceUpdatedAt = members.reduce<Date | null>((latest, row) => {
    if (!latest || row.sourceSyncedAt.getTime() > latest.getTime()) {
      return row.sourceSyncedAt;
    }
    return latest;
  }, null);
  const totalRawWeight = members.reduce((sum, row) => sum + row.rawWeight, 0);
  const hasUnresolvedWeights = members.some(
    (row) => row.effectiveWeightStatus === "UNRESOLVED_TRAILING_ZERO",
  );
  const totalEffectiveWeight =
    members.length === 50 && !hasUnresolvedWeights
      ? members.reduce((sum, row) => sum + (row.effectiveWeight ?? 0), 0)
      : null;

  return {
    clanTag: input.clanTag,
    clanName: input.clanName ?? null,
    opponentTag: firstOpponent?.opponentTag ?? null,
    opponentName: firstOpponent?.opponentName ?? null,
    rosterSize: members.length,
    totalRawWeight,
    totalEffectiveWeight,
    hasUnresolvedWeights,
    observedAt: input.observedAt,
    sourceUpdatedAt,
    members,
  };
}

/** Purpose: own the latest-only tracked-clan war-roster current-state tables derived from WarMembers feed rows. */
export class FwaTrackedClanWarRosterSyncService {
  /** Purpose: rebuild one tracked clan's current roster snapshot from persisted WarMembers state. */
  async syncClan(clanTag: string, options?: { now?: Date }): Promise<{
    clanTag: string;
    rowCount: number;
    memberRowCount: number;
    hasSnapshot: boolean;
    hasUnresolvedWeights: boolean;
    totalEffectiveWeight: number | null;
  }> {
    const normalizedClanTag = normalizeFwaTag(clanTag);
    if (!normalizedClanTag) {
      return {
        clanTag: clanTag.trim(),
        rowCount: 0,
        memberRowCount: 0,
        hasSnapshot: false,
        hasUnresolvedWeights: false,
        totalEffectiveWeight: null,
      };
    }

    const now = options?.now ?? new Date();
    const [rows, clanCatalogRow] = await Promise.all([
      prisma.fwaWarMemberCurrent.findMany({
        where: { clanTag: normalizedClanTag },
        orderBy: [{ position: "asc" }, { playerTag: "asc" }],
        select: {
          playerTag: true,
          playerName: true,
          position: true,
          townHall: true,
          weight: true,
          opponentTag: true,
          opponentName: true,
          sourceSyncedAt: true,
        },
      }),
      prisma.fwaClanCatalog.findUnique({
        where: { clanTag: normalizedClanTag },
        select: { name: true },
      }),
    ]);

    const snapshot = deriveTrackedClanWarRosterSnapshot({
      clanTag: normalizedClanTag,
      clanName: clanCatalogRow?.name ?? null,
      observedAt: now,
      rows,
    });

    await prisma.$transaction(async (tx) => {
      await tx.fwaTrackedClanWarRosterMemberCurrent.deleteMany({
        where: { clanTag: normalizedClanTag },
      });

      if (!snapshot) {
        await tx.fwaTrackedClanWarRosterCurrent.deleteMany({
          where: { clanTag: normalizedClanTag },
        });
        return;
      }

      await tx.fwaTrackedClanWarRosterCurrent.upsert({
        where: { clanTag: normalizedClanTag },
        update: {
          clanName: snapshot.clanName,
          opponentTag: snapshot.opponentTag,
          opponentName: snapshot.opponentName,
          rosterSize: snapshot.rosterSize,
          totalRawWeight: snapshot.totalRawWeight,
          totalEffectiveWeight: snapshot.totalEffectiveWeight,
          hasUnresolvedWeights: snapshot.hasUnresolvedWeights,
          observedAt: snapshot.observedAt,
          sourceUpdatedAt: snapshot.sourceUpdatedAt,
        },
        create: {
          clanTag: normalizedClanTag,
          clanName: snapshot.clanName,
          opponentTag: snapshot.opponentTag,
          opponentName: snapshot.opponentName,
          rosterSize: snapshot.rosterSize,
          totalRawWeight: snapshot.totalRawWeight,
          totalEffectiveWeight: snapshot.totalEffectiveWeight,
          hasUnresolvedWeights: snapshot.hasUnresolvedWeights,
          observedAt: snapshot.observedAt,
          sourceUpdatedAt: snapshot.sourceUpdatedAt,
        },
      });

      if (snapshot.members.length > 0) {
        await tx.fwaTrackedClanWarRosterMemberCurrent.createMany({
          data: snapshot.members.map((row) => ({
            clanTag: normalizedClanTag,
            position: row.position,
            playerTag: row.playerTag,
            playerName: row.playerName,
            townHall: row.townHall,
            rawWeight: row.rawWeight,
            effectiveWeight: row.effectiveWeight,
            effectiveWeightStatus: row.effectiveWeightStatus,
            opponentTag: row.opponentTag,
            opponentName: row.opponentName,
          })),
        });
      }
    });

    return {
      clanTag: normalizedClanTag,
      rowCount: rows.length,
      memberRowCount: snapshot?.members.length ?? 0,
      hasSnapshot: Boolean(snapshot),
      hasUnresolvedWeights: snapshot?.hasUnresolvedWeights ?? false,
      totalEffectiveWeight: snapshot?.totalEffectiveWeight ?? null,
    };
  }
}

export const normalizeTrackedClanWarRosterRowsForTest = normalizeTrackedClanWarRosterRows;
export const applyEffectiveWeightRulesForTest = applyEffectiveWeightRules;
export const deriveTrackedClanWarRosterSnapshotForTest = deriveTrackedClanWarRosterSnapshot;
