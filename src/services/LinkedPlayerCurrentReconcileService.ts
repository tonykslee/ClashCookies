import { prisma } from "../prisma";
import { dozzleLog } from "../helper/dozzleLogger";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
import {
  isAuthoritativeLivePlayerCurrentSource,
  playerCurrentService,
  type PlayerCurrentLike,
} from "./PlayerCurrentService";

/** Routine outside/clanless maintenance runs at roughly twice the default 30-minute observe cadence. */
export const DEFAULT_LINKED_PLAYER_RECONCILE_FRESHNESS_MS = 60 * 60 * 1000;
export const DEFAULT_LINKED_PLAYER_RECONCILE_BATCH_SIZE = 100;

export type LinkedPlayerObservedTrackedClan = {
  clanTag: string;
  memberTags: string[];
};

export type LinkedPlayerCurrentReconcileInput = {
  configuredTrackedClanTags: string[];
  successfullyObservedTrackedClanTags: string[];
  observedTrackedClans: LinkedPlayerObservedTrackedClan[];
  failedTrackedClanTags: string[];
  cocService: Pick<{ getPlayerRaw: (tag: string) => Promise<unknown> }, "getPlayerRaw"> | null;
  now?: Date;
  freshnessMs?: number;
  batchSize?: number;
};

export type LinkedPlayerCurrentReconcileResult = {
  linkedPlayersConsidered: number;
  alreadyObservedTrackedPlayersSkipped: number;
  departureCandidates: number;
  staleOutsideOrClanlessCandidates: number;
  refreshAttempted: number;
  refreshSucceeded: number;
  refreshFailed: number;
  deferredByBatchBound: number;
  unknownMembershipCandidates: number;
  failedTrackedClanTags: string[];
};

type Candidate = {
  playerTag: string;
  priority: 0 | 1 | 2;
  lastFetchedAtMs: number;
};

function normalizePositiveDuration(input: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isStale(record: PlayerCurrentLike | null, now: Date, freshnessMs: number): boolean {
  if (!record?.lastFetchedAt) return true;
  return now.getTime() - record.lastFetchedAt.getTime() >= freshnessMs;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.priority === 2 && left.lastFetchedAtMs !== right.lastFetchedAtMs) {
    return left.lastFetchedAtMs - right.lastFetchedAtMs;
  }
  return left.playerTag.localeCompare(right.playerTag, undefined, { sensitivity: "base" });
}

function emptyResult(failedTrackedClanTags: string[] = []): LinkedPlayerCurrentReconcileResult {
  return {
    linkedPlayersConsidered: 0,
    alreadyObservedTrackedPlayersSkipped: 0,
    departureCandidates: 0,
    staleOutsideOrClanlessCandidates: 0,
    refreshAttempted: 0,
    refreshSucceeded: 0,
    refreshFailed: 0,
    deferredByBatchBound: 0,
    unknownMembershipCandidates: 0,
    failedTrackedClanTags,
  };
}

function logResult(result: LinkedPlayerCurrentReconcileResult): void {
  dozzleLog.info(
    `[activity-observe] event=linked_player_current_reconcile linked_players_considered=${result.linkedPlayersConsidered} already_observed_tracked_players_skipped=${result.alreadyObservedTrackedPlayersSkipped} departure_candidates=${result.departureCandidates} unknown_membership_candidates=${result.unknownMembershipCandidates} stale_outside_or_clanless_candidates=${result.staleOutsideOrClanlessCandidates} refresh_attempted=${result.refreshAttempted} refresh_succeeded=${result.refreshSucceeded} refresh_failed=${result.refreshFailed} deferred_by_batch_bound=${result.deferredByBatchBound} failed_tracked_clan_tags=${result.failedTrackedClanTags.join(",") || "none"}`,
  );
}

/** Purpose: reconcile linked PlayerCurrent rows after the activity cycle has observed tracked rosters. */
export class LinkedPlayerCurrentReconcileService {
  async reconcile(
    input: LinkedPlayerCurrentReconcileInput,
  ): Promise<LinkedPlayerCurrentReconcileResult> {
    const configuredTrackedClanTags = new Set(
      input.configuredTrackedClanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean),
    );
    const successfullyObservedTrackedClanTags = new Set(
      input.successfullyObservedTrackedClanTags
        .map((tag) => normalizeClanTag(tag))
        .filter((tag) => configuredTrackedClanTags.has(tag)),
    );
    const failedTrackedClanTags = [
      ...new Set(input.failedTrackedClanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean)),
    ].sort();

    const linkedRows = await prisma.playerLink.findMany({
      where: { discordUserId: { not: null } },
      select: { playerTag: true, discordUserId: true },
    });
    const linkedTags = [
      ...new Set(
        linkedRows
          .filter((row) => String(row.discordUserId ?? "").trim().length > 0)
          .map((row) => normalizePlayerTag(row.playerTag))
          .filter(Boolean),
      ),
    ];
    if (linkedTags.length === 0) {
      const result = emptyResult(failedTrackedClanTags);
      logResult(result);
      return result;
    }

    const playerCurrentByTag = await playerCurrentService.listPlayerCurrentByTags(linkedTags);
    const observedMemberTags = new Set<string>();
    const observedMemberTagsByClanTag = new Map<string, Set<string>>();
    for (const observed of input.observedTrackedClans) {
      const clanTag = normalizeClanTag(observed.clanTag);
      if (!clanTag || !successfullyObservedTrackedClanTags.has(clanTag)) continue;
      const memberTags = observedMemberTagsByClanTag.get(clanTag) ?? new Set<string>();
      for (const tag of observed.memberTags) {
        const playerTag = normalizePlayerTag(tag);
        if (!playerTag) continue;
        memberTags.add(playerTag);
        observedMemberTags.add(playerTag);
      }
      observedMemberTagsByClanTag.set(clanTag, memberTags);
    }

    const now = input.now ?? new Date();
    const freshnessMs = normalizePositiveDuration(
      input.freshnessMs,
      DEFAULT_LINKED_PLAYER_RECONCILE_FRESHNESS_MS,
    );
    const batchSize = normalizePositiveDuration(
      input.batchSize,
      DEFAULT_LINKED_PLAYER_RECONCILE_BATCH_SIZE,
    );
    const candidates: Candidate[] = [];
    let alreadyObservedTrackedPlayersSkipped = 0;
    let departureCandidates = 0;
    let staleOutsideOrClanlessCandidates = 0;
    let unknownMembershipCandidates = 0;

    for (const playerTag of linkedTags) {
      if (observedMemberTags.has(playerTag)) {
        alreadyObservedTrackedPlayersSkipped += 1;
        continue;
      }

      const current = playerCurrentByTag.get(playerTag) ?? null;
      const currentClanTag = normalizeClanTag(current?.currentClanTag ?? "");
      if (current && currentClanTag && successfullyObservedTrackedClanTags.has(currentClanTag)) {
        const observedMembers = observedMemberTagsByClanTag.get(currentClanTag) ?? new Set<string>();
        if (!observedMembers.has(playerTag)) {
          candidates.push({
            playerTag,
            priority: 0,
            lastFetchedAtMs: current.lastFetchedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
          });
          departureCandidates += 1;
          continue;
        }
      }

      const isMissingPlayerCurrent = !current;
      const isUnknownMembership = Boolean(
        current &&
        !currentClanTag &&
        !isAuthoritativeLivePlayerCurrentSource(current.lastSource),
      );
      const isOutsideTrackedClans = Boolean(
        current && currentClanTag && !configuredTrackedClanTags.has(currentClanTag),
      );
      const isConfirmedClanlessCandidate = Boolean(
        current &&
        !currentClanTag &&
        isAuthoritativeLivePlayerCurrentSource(current.lastSource),
      );
      if (
        (isMissingPlayerCurrent || isUnknownMembership || isOutsideTrackedClans || isConfirmedClanlessCandidate) &&
        isStale(current, now, freshnessMs)
      ) {
        candidates.push({
          playerTag,
          priority: isMissingPlayerCurrent || isUnknownMembership ? 1 : 2,
          lastFetchedAtMs: current?.lastFetchedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
        });
        if (isUnknownMembership) {
          unknownMembershipCandidates += 1;
        } else if (current) {
          staleOutsideOrClanlessCandidates += 1;
        }
      }
    }

    candidates.sort(compareCandidates);
    const selectedCandidates = candidates.slice(0, batchSize);
    const deferredByBatchBound = Math.max(0, candidates.length - selectedCandidates.length);
    let refreshSucceeded = 0;
    let refreshFailed = 0;
    if (selectedCandidates.length > 0) {
      const refresh = await playerCurrentService.refreshCurrentPlayersFromLiveTags({
        playerTags: selectedCandidates.map((candidate) => candidate.playerTag),
        cocService: input.cocService,
        concurrency: 4,
        source: "live_refresh",
        now,
      });
      refreshSucceeded = refresh.successCount;
      refreshFailed = refresh.failedPlayerTags.length;
    }

    const result: LinkedPlayerCurrentReconcileResult = {
      linkedPlayersConsidered: linkedTags.length,
      alreadyObservedTrackedPlayersSkipped,
      departureCandidates,
      staleOutsideOrClanlessCandidates,
      refreshAttempted: selectedCandidates.length,
      refreshSucceeded,
      refreshFailed,
      deferredByBatchBound,
      unknownMembershipCandidates,
      failedTrackedClanTags,
    };
    logResult(result);
    return result;
  }
}

export const linkedPlayerCurrentReconcileService = new LinkedPlayerCurrentReconcileService();
