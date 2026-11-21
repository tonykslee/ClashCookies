import { computeFeedContentHash } from "./hash";
import type { FwaClanMemberFeedRow } from "./types";

/** Purpose: represent the persisted fields that identify one CLAN_MEMBERS snapshot. */
export type ClanMembersSnapshotRow = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  role: string | null;
  level: number | null;
  donated: number | null;
  received: number | null;
  rank: number | null;
  trophies: number | null;
  league: string | null;
  townHall: number | null;
  weight: number | null;
  inWar: boolean | null;
};

/** Purpose: normalize a source row into the persisted snapshot identity. */
export function toClanMembersSnapshotRow(row: FwaClanMemberFeedRow): ClanMembersSnapshotRow {
  return {
    clanTag: row.clanTag,
    playerTag: row.playerTag,
    playerName: row.playerName,
    role: row.role,
    level: row.level,
    donated: row.donated,
    received: row.received,
    rank: row.rank,
    trophies: row.trophies,
    league: row.league,
    townHall: row.townHall,
    weight: row.weight,
    inWar: row.inWar,
  };
}

/** Purpose: normalize a database current-roster row into the same snapshot identity as source rows. */
export function toPersistedClanMembersSnapshotRow(
  row: Partial<ClanMembersSnapshotRow> & { clanTag: string; playerTag: string },
): ClanMembersSnapshotRow {
  return {
    clanTag: row.clanTag,
    playerTag: row.playerTag,
    playerName: row.playerName ?? "",
    role: row.role ?? null,
    level: row.level ?? null,
    donated: row.donated ?? null,
    received: row.received ?? null,
    rank: row.rank ?? null,
    trophies: row.trophies ?? null,
    league: row.league ?? null,
    townHall: row.townHall ?? null,
    weight: row.weight ?? null,
    inWar: row.inWar ?? null,
  };
}

/** Purpose: calculate a stable identity for one complete persisted roster snapshot. */
export function computeClanMembersSnapshotHash(rows: readonly ClanMembersSnapshotRow[]): string {
  return computeFeedContentHash(
    [...rows].sort((left, right) =>
      left.clanTag.localeCompare(right.clanTag) || left.playerTag.localeCompare(right.playerTag),
    ),
  );
}
