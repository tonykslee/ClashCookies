import { prisma } from "../prisma";
import { dozzleLog } from "../helper/dozzleLogger";
import { normalizeClashTagWithHash } from "../helper/clashTag";

const normalizeClanTag = normalizeClashTagWithHash;
const normalizePlayerTag = normalizeClashTagWithHash;

export type AllianceClanMembershipIntervalEndReason =
  | "TRANSFERRED"
  | "DEPARTED"
  | "TRACKING_STOPPED";

export type AllianceClanRosterObservation = {
  clanTag: string;
  playerTags: string[];
};

export type AllianceClanMembershipReconcileInput = {
  guildId: string;
  observedAt: Date;
  monitoredClanTags: string[];
  successfullyObservedClanRosters: AllianceClanRosterObservation[];
  collectionSummary?: {
    fwaRostersReused: number;
    cwlOnlyFetches: number;
    failedClans: number;
  };
};

export type AllianceClanMembershipReconcileResult = {
  monitoredClans: number;
  observedPlayers: number;
  opened: number;
  refreshed: number;
  transferred: number;
  departed: number;
  trackingStopped: number;
  ambiguous: number;
  failed: boolean;
  durationMs: number;
};

type IntervalRow = {
  id: string;
  guildId: string;
  playerTag: string;
  clanTag: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
  endedAt: Date | null;
  endReason: AllianceClanMembershipIntervalEndReason | null;
};

type MembershipIntervalDb = {
  allianceClanMembershipInterval: {
    findMany: (args?: any) => Promise<IntervalRow[]>;
    findFirst: (args?: any) => Promise<IntervalRow | null>;
    create: (args: any) => Promise<IntervalRow>;
    update: (args: any) => Promise<IntervalRow>;
  };
  $transaction: <T>(
    callback: (tx: MembershipIntervalDb) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
};

const intervalStore = prisma as unknown as MembershipIntervalDb;

/** Purpose: reconcile one activity cycle's positive roster facts into durable observed intervals. */
export class AllianceClanMembershipIntervalService {
  constructor(private readonly db: MembershipIntervalDb = intervalStore) {}

  async reconcileCycle(
    input: AllianceClanMembershipReconcileInput,
  ): Promise<AllianceClanMembershipReconcileResult> {
    const startedAtMs = Date.now();
    const normalizedGuildId = String(input.guildId ?? "").trim();
    const observedAt = new Date(input.observedAt);
    const monitoredClanTags = new Set(
      input.monitoredClanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean),
    );
    const successfulRosters = normalizeSuccessfulRosters(
      input.successfullyObservedClanRosters,
    );
    const playerToObservedClans = buildPlayerToObservedClans(successfulRosters);
    const ambiguousPlayers = new Set(
      [...playerToObservedClans.entries()]
        .filter(([, clans]) => clans.size > 1)
        .map(([playerTag]) => playerTag),
    );

    const result: AllianceClanMembershipReconcileResult = {
      monitoredClans: monitoredClanTags.size,
      observedPlayers: playerToObservedClans.size,
      opened: 0,
      refreshed: 0,
      transferred: 0,
      departed: 0,
      trackingStopped: 0,
      ambiguous: ambiguousPlayers.size,
      failed: false,
      durationMs: 0,
    };

    try {
      await this.db.$transaction(async (tx) => {
        const openIntervals = await tx.allianceClanMembershipInterval.findMany({
          where: { guildId: normalizedGuildId, endedAt: null },
        });
        const openByPlayer = new Map<string, IntervalRow>();
        for (const interval of openIntervals) {
          const playerTag = normalizePlayerTag(interval.playerTag);
          if (playerTag) openByPlayer.set(playerTag, interval);
        }

        // Registry removal is deterministic even when the old clan could not be fetched.
        for (const interval of [...openByPlayer.values()]) {
          const clanTag = normalizeClanTag(interval.clanTag);
          if (!monitoredClanTags.has(clanTag)) {
            await closeInterval(tx, interval, observedAt, "TRACKING_STOPPED");
            openByPlayer.delete(normalizePlayerTag(interval.playerTag));
            result.trackingStopped += 1;
          }
        }

        for (const [playerTag, observedClans] of playerToObservedClans) {
          if (ambiguousPlayers.has(playerTag)) continue;
          const observedClanTag = [...observedClans][0];
          const openInterval = openByPlayer.get(playerTag);

          if (!openInterval) {
            const alreadyReplayed = await tx.allianceClanMembershipInterval.findFirst({
              where: {
                guildId: normalizedGuildId,
                playerTag,
                clanTag: observedClanTag,
                endedAt: observedAt,
              },
            });
            if (alreadyReplayed) continue;
            await openIntervalForPlayer(
              tx,
              normalizedGuildId,
              playerTag,
              observedClanTag,
              observedAt,
            );
            result.opened += 1;
            continue;
          }

          if (normalizeClanTag(openInterval.clanTag) === observedClanTag) {
            if (observedAt.getTime() > openInterval.lastObservedAt.getTime()) {
              await tx.allianceClanMembershipInterval.update({
                where: { id: openInterval.id },
                data: { lastObservedAt: observedAt },
              });
              result.refreshed += 1;
            }
            continue;
          }

          await closeInterval(tx, openInterval, observedAt, "TRANSFERRED");
          await openIntervalForPlayer(
            tx,
            normalizedGuildId,
            playerTag,
            observedClanTag,
            observedAt,
          );
          openByPlayer.delete(playerTag);
          result.transferred += 1;
          result.opened += 1;
        }

        const successfulClanTags = new Set(successfulRosters.map((roster) => roster.clanTag));
        for (const interval of [...openByPlayer.values()]) {
          const playerTag = normalizePlayerTag(interval.playerTag);
          if (!playerTag || ambiguousPlayers.has(playerTag)) continue;
          if (playerToObservedClans.has(playerTag)) continue;
          if (successfulClanTags.has(normalizeClanTag(interval.clanTag))) {
            await closeInterval(tx, interval, observedAt, "DEPARTED");
            result.departed += 1;
          }
        }
      }, { maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      result.failed = true;
      dozzleLog.error(
        `[alliance-membership-history] event=reconcile_cycle_failed guild_id=${normalizedGuildId} error=${formatError(error)}`,
      );
    }

    result.durationMs = Date.now() - startedAtMs;
    const collectionSummary = input.collectionSummary ?? {
      fwaRostersReused: 0,
      cwlOnlyFetches: 0,
      failedClans: 0,
    };
    dozzleLog.info(
      `[alliance-membership-history] event=reconcile_cycle guild_id=${normalizedGuildId} monitored_clans=${result.monitoredClans} fwa_rosters_reused=${collectionSummary.fwaRostersReused} cwl_only_fetches=${collectionSummary.cwlOnlyFetches} failed_clans=${collectionSummary.failedClans} observed_players=${result.observedPlayers} opened=${result.opened} refreshed=${result.refreshed} transferred=${result.transferred} departed=${result.departed} tracking_stopped=${result.trackingStopped} ambiguous=${result.ambiguous} failed=${result.failed ? 1 : 0} duration_ms=${result.durationMs}`,
    );
    return result;
  }
}

/** Purpose: normalize and merge successful clan roster facts without duplicating a clan observation. */
function normalizeSuccessfulRosters(
  rosters: AllianceClanRosterObservation[],
): AllianceClanRosterObservation[] {
  const playersByClan = new Map<string, Set<string>>();
  for (const roster of rosters) {
    const clanTag = normalizeClanTag(roster.clanTag);
    if (!clanTag) continue;
    const players = playersByClan.get(clanTag) ?? new Set<string>();
    for (const playerTag of roster.playerTags) {
      const normalizedPlayerTag = normalizePlayerTag(playerTag);
      if (normalizedPlayerTag) players.add(normalizedPlayerTag);
    }
    playersByClan.set(clanTag, players);
  }
  return [...playersByClan.entries()].map(([clanTag, players]) => ({
    clanTag,
    playerTags: [...players],
  }));
}

/** Purpose: index positive roster facts by player so transfers and ambiguities are deterministic. */
function buildPlayerToObservedClans(
  rosters: AllianceClanRosterObservation[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const roster of rosters) {
    for (const playerTag of roster.playerTags) {
      const clans = result.get(playerTag) ?? new Set<string>();
      clans.add(roster.clanTag);
      result.set(playerTag, clans);
    }
  }
  return result;
}

/** Purpose: create one open history interval from a positive roster observation. */
async function openIntervalForPlayer(
  tx: MembershipIntervalDb,
  guildId: string,
  playerTag: string,
  clanTag: string,
  observedAt: Date,
): Promise<void> {
  await tx.allianceClanMembershipInterval.create({
    data: {
      guildId,
      playerTag,
      clanTag,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      endedAt: null,
      endReason: null,
    },
  });
}

/** Purpose: close one open interval with the deterministic observation-based end reason. */
async function closeInterval(
  tx: MembershipIntervalDb,
  interval: IntervalRow,
  endedAt: Date,
  endReason: AllianceClanMembershipIntervalEndReason,
): Promise<void> {
  await tx.allianceClanMembershipInterval.update({
    where: { id: interval.id },
    data: { endedAt, endReason },
  });
}

/** Purpose: render persistence failures compactly for cycle-level logs. */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
