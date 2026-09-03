import type { MatchType } from "./core";

export type ParticipationParticipantInput = {
  playerTag: string;
  playerName: string | null;
  playerPosition: number | null;
};

export type ParticipationAttackInput = {
  playerTag: string;
  playerName: string | null;
  stars: number;
  trueStars: number;
  attackSeenAt: Date;
};

export type ParticipationRow = {
  guildId: string;
  warId: string;
  clanTag: string;
  opponentTag: string | null;
  playerTag: string;
  playerName: string | null;
  playerPosition: number | null;
  townHall: number | null;
  attacksUsed: number;
  attacksMissed: number;
  starsEarned: number;
  trueStars: number;
  missedBoth: boolean;
  firstAttackAt: Date | null;
  attackDelayMinutes: number | null;
  attackWindowMissed: boolean | null;
  matchType: Exclude<MatchType, null>;
  warStartTime: Date;
  warEndTime: Date | null;
};

/** Purpose: construct ended-war participation rows with the production war-end formulas. */
export function buildParticipationRows(input: {
  guildId: string;
  warId: string;
  clanTag: string;
  opponentTag: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
  matchType: MatchType | null;
  participantRows: readonly ParticipationParticipantInput[];
  attackRows: readonly ParticipationAttackInput[];
}): ParticipationRow[] {
  const battleDayStartMs = input.warStartTime.getTime();
  const firstAttackWindowCloseMs = battleDayStartMs + 12 * 60 * 60 * 1000;
  const attacksByPlayer = new Map<string, ParticipationAttackInput[]>();
  for (const row of input.attackRows) {
    const rows = attacksByPlayer.get(row.playerTag) ?? [];
    rows.push(row);
    attacksByPlayer.set(row.playerTag, rows);
  }

  return input.participantRows.map((player) => {
    const attackRows = attacksByPlayer.get(player.playerTag) ?? [];
    const attacksUsed = attackRows.length;
    const firstAttackAt =
      attackRows.length > 0
        ? new Date(
            Math.min(...attackRows.map((row) => row.attackSeenAt.getTime())),
          )
        : null;
    const attackDelayMinutes =
      firstAttackAt !== null
        ? Math.max(
            0,
            Math.floor((firstAttackAt.getTime() - battleDayStartMs) / 60000),
          )
        : null;
    return {
      guildId: input.guildId,
      warId: input.warId,
      clanTag: input.clanTag,
      opponentTag: input.opponentTag,
      playerTag: player.playerTag,
      playerName:
        player.playerName?.trim() ||
        attackRows[0]?.playerName?.trim() ||
        player.playerTag,
      playerPosition: player.playerPosition,
      townHall: null,
      attacksUsed,
      attacksMissed: Math.max(0, 2 - attacksUsed),
      starsEarned: attackRows.reduce(
        (sum, row) => sum + Number(row.stars || 0),
        0,
      ),
      trueStars: attackRows.reduce(
        (sum, row) => sum + Number(row.trueStars || 0),
        0,
      ),
      missedBoth: attacksUsed === 0,
      firstAttackAt,
      attackDelayMinutes,
      attackWindowMissed:
        firstAttackAt !== null
          ? firstAttackAt.getTime() > firstAttackWindowCloseMs
          : null,
      matchType: input.matchType ?? "FWA",
      warStartTime: input.warStartTime,
      warEndTime: input.warEndTime,
    };
  });
}
