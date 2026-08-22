import { normalizeClashTagWithHash } from "../helper/clashTag";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import {
  cwlAllianceActivityService,
  type PersistedCwlWindow,
} from "./CwlAllianceActivityService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import {
  membershipStreakService,
  type MembershipBoundaryEvidence,
  type MembershipBoundaryEvidenceByPlayer,
} from "./MembershipStreakService";

const AUTO_ESTABLISHMENT_SYNC_COUNT = 3;

export type ActiveHomeMembership = {
  id: string;
  guildId: string;
  playerTag: string;
  clanTag: string;
  startedAtSyncTime: Date;
  qualifiedAtSyncTime: Date;
  endedAtSyncTime: Date | null;
  establishmentSource: string;
  endReason: string | null;
};

export type ActiveHomeMembershipInput = {
  guildId: string;
  playerTags: string[];
};

export type PendingHomeTransferCandidate = {
  id: string;
  guildId: string;
  playerTag: string;
  homeMembershipPeriodId: string;
  fromClanTag: string;
  toClanTag: string;
  startedAtSyncTime: Date;
  qualifiedAtSyncTime: Date;
  status: "PENDING";
};

export type HomeTransferDecisionInput = {
  candidateId: string;
  actorDiscordUserId: string;
  decidedAt?: Date;
};

export type HomeTransferDecisionResult =
  | { status: "KEPT_HOME"; candidate: PendingHomeTransferCandidate }
  | { status: "CONFIRMED"; candidate: PendingHomeTransferCandidate }
  | { status: "ALREADY_RESOLVED"; candidateId: string; resolvedStatus: string }
  | { status: "STALE"; candidateId: string; reason: string };

export type ClanHomeMembershipReconciliationSummary = {
  guilds: number;
  boundaries: number;
  evaluated: number;
  established: number;
  skippedExisting: number;
  skippedFillerOrUnknown: number;
  retryable: number;
  transferEvaluated: number;
  transferCandidatesCreated: number;
  transferPendingExisting: number;
  transferCwlSuppressed: number;
};

type ClanHomeMembershipDb = {
  syncClanMemberSnapshot: {
    groupBy: (args?: any) => Promise<any[]>;
    findMany: (args?: any) => Promise<any[]>;
  };
  syncClanReadinessSnapshot: { findMany: (args?: any) => Promise<any[]> };
  trackedClan: { findMany: (args?: any) => Promise<any[]> };
  clanHomeMembershipPeriod: {
    findMany: (args?: any) => Promise<any[]>;
    findFirst: (args?: any) => Promise<any | null>;
    create: (args?: any) => Promise<any>;
    updateMany: (args?: any) => Promise<{ count: number }>;
  };
  clanHomeTransferCandidate: {
    findMany: (args?: any) => Promise<any[]>;
    findFirst: (args?: any) => Promise<any | null>;
    create: (args?: any) => Promise<any>;
    updateMany: (args?: any) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: ClanHomeMembershipDb) => Promise<T>) => Promise<T>;
};

const defaultDb = prisma as unknown as ClanHomeMembershipDb;

type LatestBoundary = {
  guildId: string;
  syncTime: Date;
};

type CandidateSnapshot = {
  guildId: string;
  syncTime: Date;
  clanTag: string;
  playerTag: string;
};

type ReadinessFact = {
  guildId: string;
  syncTime: Date;
  clanTag: string;
  fillerCaptureComplete: boolean;
  fillerPlayerTags: string[];
};

type GuildEvaluationResult = {
  status: "evaluated" | "retryable";
  boundaryTime: Date;
  evaluated: number;
  established: number;
  skippedExisting: number;
  skippedFillerOrUnknown: number;
  transferEvaluated: number;
  transferCandidatesCreated: number;
  transferPendingExisting: number;
  transferCwlSuppressed: number;
};

type CwlWindowReader = Pick<typeof cwlAllianceActivityService, "getCwlWindow">;

type TransferCandidateRecord = Omit<PendingHomeTransferCandidate, "status"> & {
  status: "PENDING" | "KEPT_HOME" | "CONFIRMED";
  decidedAt: Date | null;
  decidedByDiscordUserId: string | null;
};

class StaleHomeTransferError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Purpose: normalize a persisted player or clan tag for Home ownership comparisons. */
function normalizeTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

/** Purpose: normalize and deterministically order a requested player batch. */
function normalizePlayerTags(values: unknown): string[] {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizeTag)
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

/** Purpose: accept only finite sync timestamps from database results. */
function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Purpose: create a stable key for one guild and one sync boundary. */
function boundaryKey(guildId: string, syncTime: Date): string {
  return `${guildId}|${syncTime.getTime()}`;
}

/** Purpose: create a stable key for one readiness fact. */
function readinessKey(syncTime: Date, clanTag: string): string {
  return `${syncTime.getTime()}|${clanTag}`;
}

/** Purpose: identify PostgreSQL unique-constraint races that are safe idempotent no-ops. */
function isUniqueConstraintError(error: unknown): boolean {
  return String((error as { code?: unknown })?.code ?? "") === "P2002";
}

/** Purpose: normalize grouped latest-boundary rows into one boundary per guild. */
function normalizeLatestBoundaries(rows: any[]): LatestBoundary[] {
  return rows
    .map((row) => ({
      guildId: String(row?.guildId ?? "").trim(),
      syncTime: row?._max?.syncTime,
    }))
    .filter((row): row is LatestBoundary => Boolean(row.guildId) && isValidDate(row.syncTime))
    .sort((left, right) => left.guildId.localeCompare(right.guildId));
}

/** Purpose: normalize exact member rows and preserve same-boundary clan ambiguity. */
function normalizeCandidateSnapshots(rows: any[]): CandidateSnapshot[] {
  const byIdentity = new Map<string, CandidateSnapshot>();
  for (const row of rows) {
    const guildId = String(row?.guildId ?? "").trim();
    const playerTag = normalizeTag(row?.playerTag);
    const clanTag = normalizeTag(row?.clanTag);
    if (!guildId || !playerTag || !clanTag || !isValidDate(row?.syncTime)) continue;
    const normalized = { guildId, syncTime: row.syncTime, clanTag, playerTag };
    byIdentity.set(`${boundaryKey(guildId, row.syncTime)}|${clanTag}|${playerTag}`, normalized);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.guildId.localeCompare(right.guildId) ||
    right.syncTime.getTime() - left.syncTime.getTime() ||
    left.playerTag.localeCompare(right.playerTag) ||
    left.clanTag.localeCompare(right.clanTag),
  );
}

/** Purpose: normalize immutable filler-capture facts without consulting mutable filler configuration. */
function normalizeReadinessFacts(rows: any[]): ReadinessFact[] {
  return rows
    .map((row) => ({
      guildId: String(row?.guildId ?? "").trim(),
      syncTime: row?.syncTime,
      clanTag: normalizeTag(row?.clanTag),
      fillerCaptureComplete: row?.fillerCaptureComplete === true,
      fillerPlayerTags: [...new Set(
        (Array.isArray(row?.fillerPlayerTags) ? row.fillerPlayerTags : [])
          .map(normalizeTag)
          .filter(Boolean),
      )],
    }))
    .filter((row): row is ReadinessFact =>
      Boolean(row.guildId && row.clanTag && isValidDate(row.syncTime)),
  );
}

/** Purpose: normalize a persisted transfer candidate for public reads and decision results. */
function normalizeTransferCandidate(row: any): TransferCandidateRecord | null {
  const id = String(row?.id ?? "").trim();
  const guildId = String(row?.guildId ?? "").trim();
  const playerTag = normalizeTag(row?.playerTag);
  const homeMembershipPeriodId = String(row?.homeMembershipPeriodId ?? "").trim();
  const fromClanTag = normalizeTag(row?.fromClanTag);
  const toClanTag = normalizeTag(row?.toClanTag);
  if (!id || !guildId || !playerTag || !homeMembershipPeriodId || !fromClanTag || !toClanTag) return null;
  if (!isValidDate(row?.startedAtSyncTime) || !isValidDate(row?.qualifiedAtSyncTime)) return null;
  const status = String(row?.status ?? "");
  if (status !== "PENDING" && status !== "KEPT_HOME" && status !== "CONFIRMED") return null;
  return {
    id,
    guildId,
    playerTag,
    homeMembershipPeriodId,
    fromClanTag,
    toClanTag,
    startedAtSyncTime: row.startedAtSyncTime,
    qualifiedAtSyncTime: row.qualifiedAtSyncTime,
    status,
    decidedAt: isValidDate(row?.decidedAt) ? row.decidedAt : null,
    decidedByDiscordUserId: row?.decidedByDiscordUserId == null
      ? null
      : String(row.decidedByDiscordUserId).trim() || null,
  };
}

/** Purpose: classify one persisted sync boundary against the shared CWL timing authority. */
function classifyCwlBoundary(boundaryTime: Date, window: PersistedCwlWindow): "ORDINARY" | "CWL" | "UNKNOWN" {
  if (!window.hasTrackedCwlClans) return "ORDINARY";
  if (
    window.resolvedEventCount <= 0 ||
    window.unresolvedCwlClans.length > 0 ||
    !window.startTimingResolved ||
    !window.startsAt
  ) {
    return "UNKNOWN";
  }
  if (boundaryTime.getTime() < window.startsAt.getTime()) return "ORDINARY";
  if (window.endsAt && boundaryTime.getTime() > window.endsAt.getTime()) return "ORDINARY";
  return "CWL";
}

/** Purpose: identify a PostgreSQL unique-constraint race that is safe for candidate creation. */
function isCandidateUniqueConstraintError(error: unknown): boolean {
  return String((error as { code?: unknown })?.code ?? "") === "P2002";
}

/** Purpose: return the one active Home period for each requested account/player tag. */
function activeHomeMap(rows: ActiveHomeMembership[]): Map<string, ActiveHomeMembership> {
  return new Map(rows.map((row) => [`${row.guildId}|${row.playerTag}`, row]));
}

/** Purpose: determine whether one three-boundary evidence sequence can establish Home. */
function qualifyingEvidence(
  playerTag: string,
  evidenceByPlayer: MembershipBoundaryEvidenceByPlayer,
  trackedClanTags: Set<string>,
): { clanTag: string; evidence: MembershipBoundaryEvidence[] } | null {
  const evidence = evidenceByPlayer[playerTag] ?? [];
  if (evidence.length < AUTO_ESTABLISHMENT_SYNC_COUNT) return null;
  const run = evidence.slice(0, AUTO_ESTABLISHMENT_SYNC_COUNT);
  const clanTag = run[0]?.fwa.clanTag ?? null;
  if (!clanTag || !trackedClanTags.has(clanTag)) return null;
  if (!run.every((boundary) =>
    boundary.fwa.status === "RESOLVED" &&
    boundary.fwa.source === "SYNC_SNAPSHOT" &&
    boundary.fwa.clanTag === clanTag,
  )) return null;
  return { clanTag, evidence: run };
}

/** Purpose: create an empty reconciliation summary for a bounded no-op cycle. */
function zeroSummary(): ClanHomeMembershipReconciliationSummary {
  return {
    guilds: 0,
    boundaries: 0,
    evaluated: 0,
    established: 0,
    skippedExisting: 0,
    skippedFillerOrUnknown: 0,
    retryable: 0,
    transferEvaluated: 0,
    transferCandidatesCreated: 0,
    transferPendingExisting: 0,
    transferCwlSuppressed: 0,
  };
}

/** Purpose: own durable Home-period reads and exact three-sync automatic establishment. */
export class ClanHomeMembershipService {
  private readonly successfullyEvaluatedBoundaryByGuild = new Map<string, string>();

  constructor(
    private readonly db: ClanHomeMembershipDb = defaultDb,
    private readonly evidenceService = membershipStreakService,
    private readonly cwlWindowReader: CwlWindowReader = cwlAllianceActivityService,
  ) {}

  /** Purpose: read active Home periods in one guild-scoped bulk query without external calls. */
  async getActiveHomeMembershipsForPlayers(
    input: ActiveHomeMembershipInput,
  ): Promise<ActiveHomeMembership[]> {
    const guildId = String(input.guildId ?? "").trim();
    const playerTags = normalizePlayerTags(input.playerTags);
    if (!guildId || playerTags.length === 0) return [];
    return (await this.db.clanHomeMembershipPeriod.findMany({
      where: { guildId, playerTag: { in: playerTags }, endedAtSyncTime: null },
      orderBy: [{ playerTag: "asc" }, { startedAtSyncTime: "asc" }],
      select: {
        id: true,
        guildId: true,
        playerTag: true,
        clanTag: true,
        startedAtSyncTime: true,
        qualifiedAtSyncTime: true,
        endedAtSyncTime: true,
        establishmentSource: true,
        endReason: true,
      },
    })) as ActiveHomeMembership[];
  }

  /** Purpose: read pending transfer candidates in one bounded DB-first query for future leader surfaces. */
  async getPendingTransferCandidates(input: {
    guildId: string;
    playerTags?: string[];
    fromClanTag?: string;
  }): Promise<PendingHomeTransferCandidate[]> {
    const guildId = String(input.guildId ?? "").trim();
    if (!guildId) return [];
    const playerTags = normalizePlayerTags(input.playerTags ?? []);
    const fromClanTag = input.fromClanTag ? normalizeTag(input.fromClanTag) : "";
    const rows = await this.db.clanHomeTransferCandidate.findMany({
      where: {
        guildId,
        status: "PENDING",
        ...(playerTags.length > 0 ? { playerTag: { in: playerTags } } : {}),
        ...(fromClanTag ? { fromClanTag } : {}),
      },
      orderBy: [{ playerTag: "asc" }, { qualifiedAtSyncTime: "asc" }, { id: "asc" }],
      select: {
        id: true,
        guildId: true,
        playerTag: true,
        homeMembershipPeriodId: true,
        fromClanTag: true,
        toClanTag: true,
        startedAtSyncTime: true,
        qualifiedAtSyncTime: true,
        status: true,
      },
    });
    return rows
      .map(normalizeTransferCandidate)
      .filter((row): row is TransferCandidateRecord => row?.status === "PENDING")
      .map(({ decidedAt: _decidedAt, decidedByDiscordUserId: _decidedByDiscordUserId, ...candidate }) => ({
        ...candidate,
        status: "PENDING" as const,
      }));
  }

  /** Purpose: atomically record Keep Home while leaving the authoritative Home period unchanged. */
  async keepHomeTransferCandidate(input: HomeTransferDecisionInput): Promise<HomeTransferDecisionResult> {
    const candidateId = String(input.candidateId ?? "").trim();
    const actorDiscordUserId = String(input.actorDiscordUserId ?? "").trim();
    const decidedAt = input.decidedAt ?? new Date();
    const result = await this.db.$transaction(async (tx) => {
      const candidate = normalizeTransferCandidate(await tx.clanHomeTransferCandidate.findFirst({
        where: { id: candidateId },
      }));
      if (!candidate) return { status: "STALE" as const, candidateId, reason: "CANDIDATE_NOT_FOUND" };
      if (candidate.status !== "PENDING") {
        return { status: "ALREADY_RESOLVED" as const, candidateId, resolvedStatus: candidate.status };
      }
      const claimed = await tx.clanHomeTransferCandidate.updateMany({
        where: { id: candidateId, status: "PENDING" },
        data: {
          status: "KEPT_HOME",
          decidedAt,
          decidedByDiscordUserId: actorDiscordUserId,
        },
      });
      if (claimed.count !== 1) {
        const latest = normalizeTransferCandidate(await tx.clanHomeTransferCandidate.findFirst({ where: { id: candidateId } }));
        return latest && latest.status !== "PENDING"
          ? { status: "ALREADY_RESOLVED" as const, candidateId, resolvedStatus: latest.status }
          : { status: "STALE" as const, candidateId, reason: "CANDIDATE_NOT_FOUND" };
      }
      return {
        status: "KEPT_HOME" as const,
        candidate: {
          ...candidate,
          status: "PENDING" as const,
        },
      };
    });
    if (result.status === "KEPT_HOME") {
      dozzleLog.info(
        `[home-membership] event=transfer_decision candidate_id=${candidateId} player_tag=${result.candidate.playerTag} from_clan=${result.candidate.fromClanTag} to_clan=${result.candidate.toClanTag} decision=KEPT_HOME actor_id=${actorDiscordUserId}`,
      );
    }
    return result;
  }

  /** Purpose: atomically confirm a pending transfer and create the successor Home period. */
  async confirmHomeTransferCandidate(input: HomeTransferDecisionInput): Promise<HomeTransferDecisionResult> {
    const candidateId = String(input.candidateId ?? "").trim();
    const actorDiscordUserId = String(input.actorDiscordUserId ?? "").trim();
    const decidedAt = input.decidedAt ?? new Date();
    let result: HomeTransferDecisionResult;
    try {
      result = await this.db.$transaction(async (tx) => {
        const candidate = normalizeTransferCandidate(await tx.clanHomeTransferCandidate.findFirst({
          where: { id: candidateId },
        }));
        if (!candidate) return { status: "STALE" as const, candidateId, reason: "CANDIDATE_NOT_FOUND" };
        if (candidate.status !== "PENDING") {
          return { status: "ALREADY_RESOLVED" as const, candidateId, resolvedStatus: candidate.status };
        }
        const home = await tx.clanHomeMembershipPeriod.findFirst({
          where: {
            id: candidate.homeMembershipPeriodId,
            guildId: candidate.guildId,
            playerTag: candidate.playerTag,
            endedAtSyncTime: null,
          },
        });
        if (!home || normalizeTag(home.clanTag) !== candidate.fromClanTag) {
          return { status: "STALE" as const, candidateId, reason: "HOME_PERIOD_NO_LONGER_MATCHES" };
        }
        const trackedDestination = await tx.trackedClan.findMany({
          where: { tag: candidate.toClanTag },
          select: { tag: true },
        });
        if (!trackedDestination.some((row) => normalizeTag(row?.tag) === candidate.toClanTag)) {
          return { status: "STALE" as const, candidateId, reason: "DESTINATION_NOT_TRACKED" };
        }
        const claimed = await tx.clanHomeTransferCandidate.updateMany({
          where: { id: candidateId, status: "PENDING" },
          data: {
            status: "CONFIRMED",
            decidedAt,
            decidedByDiscordUserId: actorDiscordUserId,
          },
        });
        if (claimed.count !== 1) {
          const latest = normalizeTransferCandidate(await tx.clanHomeTransferCandidate.findFirst({ where: { id: candidateId } }));
          return latest && latest.status !== "PENDING"
            ? { status: "ALREADY_RESOLVED" as const, candidateId, resolvedStatus: latest.status }
            : { status: "STALE" as const, candidateId, reason: "CANDIDATE_NOT_FOUND" };
        }
        const ended = await tx.clanHomeMembershipPeriod.updateMany({
          where: {
            id: candidate.homeMembershipPeriodId,
            guildId: candidate.guildId,
            playerTag: candidate.playerTag,
            clanTag: candidate.fromClanTag,
            endedAtSyncTime: null,
          },
          data: {
            endedAtSyncTime: candidate.startedAtSyncTime,
            endReason: "TRANSFERRED",
          },
        });
        if (ended.count !== 1) throw new StaleHomeTransferError("HOME_PERIOD_NO_LONGER_MATCHES");
        await tx.clanHomeMembershipPeriod.create({
          data: {
            guildId: candidate.guildId,
            playerTag: candidate.playerTag,
            clanTag: candidate.toClanTag,
            startedAtSyncTime: candidate.startedAtSyncTime,
            qualifiedAtSyncTime: candidate.qualifiedAtSyncTime,
            establishmentSource: "TRANSFER",
            endedAtSyncTime: null,
            endReason: null,
          },
        });
        return {
          status: "CONFIRMED" as const,
          candidate: {
            ...candidate,
            status: "PENDING" as const,
          },
        };
      });
    } catch (error) {
      if (error instanceof StaleHomeTransferError) {
        result = { status: "STALE", candidateId, reason: error.reason };
      } else {
        throw error;
      }
    }
    if (result.status === "CONFIRMED") {
      dozzleLog.info(
        `[home-membership] event=transfer_decision candidate_id=${candidateId} player_tag=${result.candidate.playerTag} from_clan=${result.candidate.fromClanTag} to_clan=${result.candidate.toClanTag} decision=CONFIRMED actor_id=${actorDiscordUserId}`,
      );
    }
    return result;
  }

  /** Purpose: reconcile the newest exact member boundary for every guild in one bounded active cycle. */
  async reconcileLatestExactBoundaries(): Promise<ClanHomeMembershipReconciliationSummary> {
    const summary = zeroSummary();
    const groupedBoundaries = await this.db.syncClanMemberSnapshot.groupBy({
      by: ["guildId"],
      _max: { syncTime: true },
    });
    const latestBoundaries = normalizeLatestBoundaries(groupedBoundaries);
    const pendingBoundaries = latestBoundaries.filter((boundary) =>
      this.successfullyEvaluatedBoundaryByGuild.get(boundary.guildId) !== boundaryKey(boundary.guildId, boundary.syncTime),
    );
    if (pendingBoundaries.length === 0) return summary;

    const latestRows = normalizeCandidateSnapshots(await this.db.syncClanMemberSnapshot.findMany({
      where: {
        OR: pendingBoundaries.map((boundary) => ({
          guildId: boundary.guildId,
          syncTime: boundary.syncTime,
        })),
      },
      orderBy: [{ guildId: "asc" }, { playerTag: "asc" }, { clanTag: "asc" }],
      select: { guildId: true, syncTime: true, clanTag: true, playerTag: true },
    }));
    const rowsByGuild = new Map<string, CandidateSnapshot[]>();
    for (const row of latestRows) {
      const rows = rowsByGuild.get(row.guildId) ?? [];
      rows.push(row);
      rowsByGuild.set(row.guildId, rows);
    }

    summary.guilds = pendingBoundaries.length;
    summary.boundaries = pendingBoundaries.length;
    let firstFailure: unknown = null;
    const cwlWindowCache = new Map<string, Promise<PersistedCwlWindow>>();
    const establishmentContexts: Array<{ boundary: LatestBoundary; result: GuildEvaluationResult }> = [];
    for (const boundary of pendingBoundaries) {
      try {
        const result = await this.reconcileGuildBoundary(
          boundary,
          rowsByGuild.get(boundary.guildId) ?? [],
          cwlWindowCache,
        );
        summary.evaluated += result.evaluated;
        summary.established += result.established;
        summary.skippedExisting += result.skippedExisting;
        summary.skippedFillerOrUnknown += result.skippedFillerOrUnknown;
        summary.transferEvaluated += result.transferEvaluated;
        summary.transferCandidatesCreated += result.transferCandidatesCreated;
        summary.transferPendingExisting += result.transferPendingExisting;
        summary.transferCwlSuppressed += result.transferCwlSuppressed;
        if (result.status === "retryable") summary.retryable += 1;
        else {
          this.successfullyEvaluatedBoundaryByGuild.set(
            boundary.guildId,
            boundaryKey(boundary.guildId, boundary.syncTime),
          );
          if (result.established > 0 || result.transferCandidatesCreated > 0) {
            establishmentContexts.push({ boundary, result });
          }
        }
      } catch (error) {
        firstFailure ??= error;
        dozzleLog.error(
          `[home-membership] event=reconciliation_failure guild_id=${boundary.guildId} sync_time=${boundary.syncTime.toISOString()} error=${formatError(error)}`,
        );
      }
    }

    for (const context of establishmentContexts) {
      dozzleLog.info(
        `[home-membership] event=auto_establish_summary guild_id=${context.boundary.guildId} sync_time=${context.boundary.syncTime.toISOString()} evaluated=${context.result.evaluated} established=${context.result.established} skipped_existing=${context.result.skippedExisting} skipped_filler_or_unknown=${context.result.skippedFillerOrUnknown} transfer_evaluated=${context.result.transferEvaluated} transfer_candidates_created=${context.result.transferCandidatesCreated} transfer_pending_existing=${context.result.transferPendingExisting} transfer_cwl_suppressed=${context.result.transferCwlSuppressed}`,
      );
    }
    if (establishmentContexts.length === 0) {
      dozzleLog.debug(
        `[home-membership] event=auto_establish_summary guild_id=bulk sync_time=latest evaluated=${summary.evaluated} established=${summary.established} skipped_existing=${summary.skippedExisting} skipped_filler_or_unknown=${summary.skippedFillerOrUnknown} retryable=${summary.retryable} transfer_evaluated=${summary.transferEvaluated} transfer_candidates_created=${summary.transferCandidatesCreated} transfer_pending_existing=${summary.transferPendingExisting} transfer_cwl_suppressed=${summary.transferCwlSuppressed}`,
      );
    }
    if (firstFailure) throw firstFailure;
    return summary;
  }

  /** Purpose: evaluate one guild's newest exact boundary and preserve retryability when readiness is incomplete. */
  private async reconcileGuildBoundary(
    boundary: LatestBoundary,
    latestRows: CandidateSnapshot[],
    cwlWindowCache: Map<string, Promise<PersistedCwlWindow>>,
  ): Promise<GuildEvaluationResult> {
    const baseResult = {
      boundaryTime: boundary.syncTime,
      evaluated: 0,
      established: 0,
      skippedExisting: 0,
      skippedFillerOrUnknown: 0,
      transferEvaluated: 0,
      transferCandidatesCreated: 0,
      transferPendingExisting: 0,
      transferCwlSuppressed: 0,
    };
    if (latestRows.length === 0) return { status: "evaluated", ...baseResult };

    const playerTags = [...new Set(latestRows.map((row) => row.playerTag))].sort((a, b) => a.localeCompare(b));
    const existing = activeHomeMap(await this.getActiveHomeMembershipsForPlayers({
      guildId: boundary.guildId,
      playerTags,
    }));
    const activePlayers = playerTags.filter((playerTag) => existing.has(`${boundary.guildId}|${playerTag}`));
    const noHomeCandidates = playerTags.filter((playerTag) => !existing.has(`${boundary.guildId}|${playerTag}`));
    baseResult.skippedExisting = activePlayers.length;

    const activeHomeIds = activePlayers
      .map((playerTag) => existing.get(`${boundary.guildId}|${playerTag}`)?.id)
      .filter((id): id is string => Boolean(id));
    const decisionRows = activeHomeIds.length === 0
      ? []
      : await this.db.clanHomeTransferCandidate.findMany({
          where: { homeMembershipPeriodId: { in: activeHomeIds }, status: { in: ["PENDING", "KEPT_HOME"] } },
          select: { homeMembershipPeriodId: true, status: true, decidedAt: true },
        });
    const pendingHomeIds = new Set(
      decisionRows
        .filter((row) => String(row?.status ?? "") === "PENDING")
        .map((row) => String(row?.homeMembershipPeriodId ?? "").trim())
        .filter(Boolean),
    );
    const latestKeptDecisionByHome = new Map<string, Date>();
    for (const row of decisionRows) {
      if (String(row?.status ?? "") !== "KEPT_HOME" || !isValidDate(row?.decidedAt)) continue;
      const homeId = String(row?.homeMembershipPeriodId ?? "").trim();
      const previous = latestKeptDecisionByHome.get(homeId);
      if (!previous || row.decidedAt.getTime() > previous.getTime()) latestKeptDecisionByHome.set(homeId, row.decidedAt);
    }
    const transferCandidates = activePlayers.filter((playerTag) => {
      const home = existing.get(`${boundary.guildId}|${playerTag}`);
      return Boolean(home?.id && !pendingHomeIds.has(home.id));
    });
    baseResult.transferPendingExisting = activePlayers.length - transferCandidates.length;
    baseResult.transferEvaluated = transferCandidates.length;
    const evidencePlayers = [...new Set([...noHomeCandidates, ...transferCandidates])];
    if (evidencePlayers.length === 0) return { status: "evaluated", ...baseResult };

    const trackedRows = await this.db.trackedClan.findMany({
      select: { tag: true },
    });
    const trackedClanTags = new Set(
      trackedRows.map((row) => normalizeTag(row?.tag)).filter(Boolean),
    );
    if (trackedClanTags.size === 0) return { status: "evaluated", ...baseResult };
    const evidenceByPlayer = await this.evidenceService.getMembershipBoundaryEvidenceForPlayers({
      guildId: boundary.guildId,
      playerTags: evidencePlayers,
      maxBoundaries: AUTO_ESTABLISHMENT_SYNC_COUNT,
    });
    const homePossible = new Map<string, { playerTag: string; clanTag: string; evidence: MembershipBoundaryEvidence[] }>();
    const transferPossible = new Map<string, { playerTag: string; home: ActiveHomeMembership; clanTag: string; evidence: MembershipBoundaryEvidence[] }>();
    let evidenceBoundaryMismatch = false;
    for (const playerTag of evidencePlayers) {
      const evidence = evidenceByPlayer[playerTag] ?? [];
      if (evidence[0]?.boundaryTime.getTime() !== boundary.syncTime.getTime()) {
        evidenceBoundaryMismatch = true;
        continue;
      }
      if (evidence.length < AUTO_ESTABLISHMENT_SYNC_COUNT) continue;
      const qualification = qualifyingEvidence(playerTag, evidenceByPlayer, trackedClanTags);
      if (!qualification) {
        if (noHomeCandidates.includes(playerTag)) baseResult.skippedFillerOrUnknown += 1;
        continue;
      }
      const home = existing.get(`${boundary.guildId}|${playerTag}`);
      if (home) {
        if (qualification.clanTag !== normalizeTag(home.clanTag)) {
          transferPossible.set(playerTag, { playerTag, home, ...qualification });
        }
      } else {
        homePossible.set(playerTag, { playerTag, ...qualification });
      }
    }
    let readinessMissing = false;
    if (homePossible.size > 0) {
      const boundaryTimes = [...new Map(
        [...homePossible.values()]
          .flatMap((candidate) => candidate.evidence)
          .map((evidence) => [evidence.boundaryTime.getTime(), evidence.boundaryTime] as const),
      ).values()];
      const readinessRows = normalizeReadinessFacts(await this.db.syncClanReadinessSnapshot.findMany({
        where: {
          guildId: boundary.guildId,
          syncTime: { in: boundaryTimes },
          clanTag: { in: [...new Set([...homePossible.values()].map((row) => row.clanTag))] },
        },
        select: {
          guildId: true,
          syncTime: true,
          clanTag: true,
          fillerCaptureComplete: true,
          fillerPlayerTags: true,
        },
      }));
      const readinessByKey = new Map(
        readinessRows.map((row) => [readinessKey(row.syncTime, row.clanTag), row]),
      );
      const readyCandidates: Array<{ playerTag: string; clanTag: string; evidence: MembershipBoundaryEvidence[] }> = [];
      for (const candidate of homePossible.values()) {
        let missing = false;
        let fillerOrUnknown = false;
        for (const evidence of candidate.evidence) {
          const readiness = readinessByKey.get(readinessKey(evidence.boundaryTime, candidate.clanTag));
          if (!readiness) {
            missing = true;
            continue;
          }
          if (!readiness.fillerCaptureComplete || readiness.fillerPlayerTags.includes(candidate.playerTag)) {
            fillerOrUnknown = true;
          }
        }
        if (missing) {
          if (fillerOrUnknown) {
            baseResult.skippedFillerOrUnknown += 1;
          } else {
            readinessMissing = true;
          }
        } else if (fillerOrUnknown) {
          baseResult.skippedFillerOrUnknown += 1;
        } else {
          readyCandidates.push(candidate);
        }
      }
      for (const candidate of readyCandidates) {
        baseResult.evaluated += 1;
        const created = await this.createHomePeriodIfAbsent({
          guildId: boundary.guildId,
          playerTag: candidate.playerTag,
          clanTag: candidate.clanTag,
          startedAtSyncTime: candidate.evidence[2].boundaryTime,
          qualifiedAtSyncTime: candidate.evidence[0].boundaryTime,
        });
        if (created) baseResult.established += 1;
        else baseResult.skippedExisting += 1;
      }
    }

    for (const candidate of transferPossible.values()) {
      const keptAt = latestKeptDecisionByHome.get(candidate.home.id);
      if (keptAt && candidate.evidence[2].boundaryTime.getTime() <= keptAt.getTime()) continue;
      let ordinary = true;
      const seasons = [...new Set(candidate.evidence.map((evidence) =>
        resolveCurrentCwlSeasonKey(evidence.boundaryTime.getTime()),
      ))];
      for (const season of seasons) {
        const window = cwlWindowCache.get(season) ?? this.cwlWindowReader.getCwlWindow({ season });
        cwlWindowCache.set(season, window);
      }
      for (const evidence of candidate.evidence) {
        const season = resolveCurrentCwlSeasonKey(evidence.boundaryTime.getTime());
        const window = await cwlWindowCache.get(season)!;
        if (classifyCwlBoundary(evidence.boundaryTime, window) !== "ORDINARY") {
          ordinary = false;
          break;
        }
      }
      if (!ordinary) {
        baseResult.transferCwlSuppressed += 1;
        continue;
      }
      const created = await this.createTransferCandidateIfAbsent({
        guildId: boundary.guildId,
        playerTag: candidate.playerTag,
        homeMembershipPeriodId: candidate.home.id,
        fromClanTag: normalizeTag(candidate.home.clanTag),
        toClanTag: candidate.clanTag,
        startedAtSyncTime: candidate.evidence[2].boundaryTime,
        qualifiedAtSyncTime: candidate.evidence[0].boundaryTime,
      });
      if (created === "CREATED") baseResult.transferCandidatesCreated += 1;
      else if (created === "PENDING") baseResult.transferPendingExisting += 1;
    }
    return {
      status: evidenceBoundaryMismatch || readinessMissing ? "retryable" : "evaluated",
      ...baseResult,
    };
  }

  /** Purpose: create one AUTO_3_SYNC period transactionally without overwriting an active Home. */
  private async createHomePeriodIfAbsent(input: {
    guildId: string;
    playerTag: string;
    clanTag: string;
    startedAtSyncTime: Date;
    qualifiedAtSyncTime: Date;
  }): Promise<boolean> {
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.clanHomeMembershipPeriod.findFirst({
          where: {
            guildId: input.guildId,
            playerTag: input.playerTag,
            endedAtSyncTime: null,
          },
          select: { id: true },
        });
        if (existing) return false;
        await tx.clanHomeMembershipPeriod.create({
          data: {
            guildId: input.guildId,
            playerTag: input.playerTag,
            clanTag: input.clanTag,
            startedAtSyncTime: input.startedAtSyncTime,
            qualifiedAtSyncTime: input.qualifiedAtSyncTime,
            establishmentSource: "AUTO_3_SYNC",
            endedAtSyncTime: null,
            endReason: null,
          },
        });
        return true;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /** Purpose: create one pending transfer candidate only while its referenced Home period is still active. */
  private async createTransferCandidateIfAbsent(input: {
    guildId: string;
    playerTag: string;
    homeMembershipPeriodId: string;
    fromClanTag: string;
    toClanTag: string;
    startedAtSyncTime: Date;
    qualifiedAtSyncTime: Date;
  }): Promise<"CREATED" | "PENDING" | "STALE"> {
    try {
      return await this.db.$transaction(async (tx) => {
        const home = await tx.clanHomeMembershipPeriod.findFirst({
          where: {
            id: input.homeMembershipPeriodId,
            guildId: input.guildId,
            playerTag: input.playerTag,
            clanTag: input.fromClanTag,
            endedAtSyncTime: null,
          },
          select: { id: true },
        });
        if (!home) return "STALE";
        const existing = await tx.clanHomeTransferCandidate.findFirst({
          where: { homeMembershipPeriodId: input.homeMembershipPeriodId, status: "PENDING" },
          select: { id: true },
        });
        if (existing) return "PENDING";
        await tx.clanHomeTransferCandidate.create({
          data: {
            guildId: input.guildId,
            playerTag: input.playerTag,
            homeMembershipPeriodId: input.homeMembershipPeriodId,
            fromClanTag: input.fromClanTag,
            toClanTag: input.toClanTag,
            startedAtSyncTime: input.startedAtSyncTime,
            qualifiedAtSyncTime: input.qualifiedAtSyncTime,
            status: "PENDING",
            decidedAt: null,
            decidedByDiscordUserId: null,
          },
        });
        return "CREATED";
      });
    } catch (error) {
      if (isCandidateUniqueConstraintError(error)) return "PENDING";
      throw error;
    }
  }
}

export const clanHomeMembershipService = new ClanHomeMembershipService();
