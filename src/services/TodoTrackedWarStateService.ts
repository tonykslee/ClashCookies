import type { FwaTrackedClanWarRosterMemberCurrent } from "@prisma/client";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";

export type TodoTrackedCurrentWarRow = {
  clanTag: string;
  warId: number | null;
  startTime: Date | null;
  state: string | null;
};

export type TodoTrackedWarAttackRow = {
  warId: number;
  clanTag: string;
  warStartTime: Date;
  playerTag: string;
  playerPosition: number | null;
  attacksUsed: number;
  attackOrder: number;
  attackNumber: number;
  defenderPosition: number | null;
  stars: number;
  attackSeenAt: Date;
};

export type TodoTrackedWarRosterRow = Pick<
  FwaTrackedClanWarRosterMemberCurrent,
  "clanTag" | "playerTag" | "position" | "playerName" | "townHall"
>;

export type TodoTrackedWarAttackDetail = {
  defenderPosition: number | null;
  stars: number | null;
  seenAtMs: number;
};

export type TodoTrackedWarMemberState = {
  playerTag: string;
  clanTag: string;
  position: number | null;
  playerName: string | null;
  townHall: number | null;
  attacksUsed: number;
  attackDetails: TodoTrackedWarAttackDetail[];
};

type MutableTrackedWarMemberState = {
  playerTag: string;
  clanTag: string;
  position: number | null;
  playerName: string | null;
  townHall: number | null;
  attacksUsed: number;
  attackDetails: Array<{
    order: number;
    attackNumber: number;
    seenAtMs: number;
    defenderPosition: number | null;
    stars: number | null;
  }>;
};

/** Purpose: classify war-state strings into active/non-active buckets for todo status. */
export function isTodoWarStateActive(state: unknown): boolean {
  const normalized = String(state ?? "").toLowerCase();
  return normalized.includes("preparation") || normalized.includes("inwar");
}

/** Purpose: build tracked-war member state from CurrentWar identity + roster rows + WarAttacks rows. */
export function buildTrackedWarMemberStateByClanAndPlayer(input: {
  currentWarByClanTag: Map<string, TodoTrackedCurrentWarRow>;
  rosterRows: TodoTrackedWarRosterRow[];
  warAttackRows: TodoTrackedWarAttackRow[];
}): Map<string, TodoTrackedWarMemberState> {
  const mapped = new Map<string, MutableTrackedWarMemberState>();

  for (const row of input.rosterRows) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;

    const currentWar = input.currentWarByClanTag.get(clanTag);
    if (!currentWar || !isTodoWarStateActive(currentWar.state)) continue;

    const key = `${clanTag}:${playerTag}`;
    const existing =
      mapped.get(key) ??
      ({
        playerTag,
        clanTag,
        position: null,
        playerName: normalizeDisplayName(row.playerName) || null,
        townHall: toFiniteIntOrNull(row.townHall),
        attacksUsed: 0,
        attackDetails: [],
      } satisfies MutableTrackedWarMemberState);
    if (!mapped.has(key)) {
      mapped.set(key, existing);
    }

    const candidatePosition = toFiniteIntOrNull(row.position);
    if (
      existing.position === null &&
      candidatePosition !== null &&
      candidatePosition > 0
    ) {
      existing.position = candidatePosition;
    }
    if (!existing.playerName) {
      existing.playerName = normalizeDisplayName(row.playerName) || null;
    }
    if (existing.townHall === null) {
      existing.townHall = toFiniteIntOrNull(row.townHall);
    }
  }

  for (const row of input.warAttackRows) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;

    const currentWar = input.currentWarByClanTag.get(clanTag);
    if (!currentWar || !isTodoWarStateActive(currentWar.state)) continue;
    if (!matchesCurrentWarIdentity(currentWar, row)) continue;

    const key = `${clanTag}:${playerTag}`;
    const existing = mapped.get(key);
    if (!existing) continue;

    const candidatePosition = toFiniteIntOrNull(row.playerPosition);
    if (
      existing.position === null &&
      candidatePosition !== null &&
      candidatePosition > 0
    ) {
      existing.position = candidatePosition;
    }
    existing.attacksUsed = Math.max(
      existing.attacksUsed,
      clampInt(row.attacksUsed, 0, 2),
    );

    const attackOrder = clampInt(row.attackOrder, 0, 2);
    const attackNumber = clampInt(row.attackNumber, 0, 2);
    if (attackOrder <= 0 && attackNumber <= 0) {
      continue;
    }
    existing.attackDetails.push({
      order: attackOrder > 0 ? attackOrder : attackNumber,
      attackNumber,
      seenAtMs: row.attackSeenAt.getTime(),
      defenderPosition: toFiniteIntOrNull(row.defenderPosition),
      stars: toFiniteIntOrNull(row.stars),
    });
  }

  const finalized = new Map<string, TodoTrackedWarMemberState>();
  for (const [key, value] of mapped.entries()) {
    const orderedAttackDetails = [...value.attackDetails]
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        if (a.attackNumber !== b.attackNumber) return a.attackNumber - b.attackNumber;
        return a.seenAtMs - b.seenAtMs;
      })
      .slice(0, 2)
        .map((detail) => ({
          defenderPosition: detail.defenderPosition,
          stars: detail.stars,
          seenAtMs: detail.seenAtMs,
        }));
    const attacksUsed = Math.max(
      value.attacksUsed,
      Math.min(2, orderedAttackDetails.length),
    );
    finalized.set(key, {
      playerTag: value.playerTag,
      clanTag: value.clanTag,
      position: value.position,
      playerName: value.playerName,
      townHall: value.townHall,
      attacksUsed,
      attackDetails: orderedAttackDetails,
    });
  }

  return finalized;
}

/** Purpose: build one per-player fallback map from tracked war member state rows. */
export function buildTrackedWarMemberStateByPlayerTag(
  rows: Map<string, TodoTrackedWarMemberState>,
): Map<string, TodoTrackedWarMemberState> {
  const byPlayerTag = new Map<string, TodoTrackedWarMemberState>();
  for (const row of rows.values()) {
    const existing = byPlayerTag.get(row.playerTag);
    if (!existing) {
      byPlayerTag.set(row.playerTag, row);
      continue;
    }

    const existingPos = existing.position ?? Number.MAX_SAFE_INTEGER;
    const nextPos = row.position ?? Number.MAX_SAFE_INTEGER;
    if (nextPos < existingPos) {
      byPlayerTag.set(row.playerTag, row);
      continue;
    }
    if (nextPos > existingPos) continue;

    const existingAttacks = existing.attacksUsed;
    const nextAttacks = row.attacksUsed;
    if (nextAttacks > existingAttacks) {
      byPlayerTag.set(row.playerTag, row);
      continue;
    }
    if (nextAttacks < existingAttacks) continue;

    const existingKey = `${existing.clanTag}:${existing.playerTag}`;
    const nextKey = `${row.clanTag}:${row.playerTag}`;
    if (nextKey.localeCompare(existingKey) < 0) {
      byPlayerTag.set(row.playerTag, row);
    }
  }
  return byPlayerTag;
}

/** Purpose: prevent previous-war leakage by requiring WarAttacks rows to match CurrentWar identity. */
function matchesCurrentWarIdentity(
  currentWar: TodoTrackedCurrentWarRow,
  attack: Pick<TodoTrackedWarAttackRow, "warId" | "warStartTime">,
): boolean {
  const currentWarId = toFiniteIntOrNull(currentWar.warId);
  if (currentWarId !== null) {
    const attackWarId = toFiniteIntOrNull(attack.warId);
    return attackWarId !== null && attackWarId === currentWarId;
  }

  const currentStartMs =
    currentWar.startTime instanceof Date ? currentWar.startTime.getTime() : null;
  const attackStartMs =
    attack.warStartTime instanceof Date ? attack.warStartTime.getTime() : null;
  if (currentStartMs === null || attackStartMs === null) {
    return false;
  }
  return currentStartMs === attackStartMs;
}

/** Purpose: normalize unknown numeric values into one bounded integer range. */
function clampInt(input: unknown, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return min;
  const truncated = Math.trunc(parsed);
  return Math.max(min, Math.min(max, truncated));
}

/** Purpose: map unknown numeric input to finite integer or null for nullable fields. */
function toFiniteIntOrNull(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string" && input.trim().length <= 0) return null;
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/** Purpose: normalize player names before storing roster-backed fallback values. */
function normalizeDisplayName(input: unknown): string {
  return String(input ?? "").trim();
}
