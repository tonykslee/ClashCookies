import { normalizeClashTagWithHash } from "../helper/clashTag";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
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

export type ClanHomeMembershipReconciliationSummary = {
  guilds: number;
  boundaries: number;
  evaluated: number;
  established: number;
  skippedExisting: number;
  skippedFillerOrUnknown: number;
  retryable: number;
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
};

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
  };
}

/** Purpose: own durable Home-period reads and exact three-sync automatic establishment. */
export class ClanHomeMembershipService {
  private readonly successfullyEvaluatedBoundaryByGuild = new Map<string, string>();

  constructor(
    private readonly db: ClanHomeMembershipDb = defaultDb,
    private readonly evidenceService = membershipStreakService,
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
    const establishmentContexts: Array<{ boundary: LatestBoundary; result: GuildEvaluationResult }> = [];
    for (const boundary of pendingBoundaries) {
      try {
        const result = await this.reconcileGuildBoundary(
          boundary,
          rowsByGuild.get(boundary.guildId) ?? [],
        );
        summary.evaluated += result.evaluated;
        summary.established += result.established;
        summary.skippedExisting += result.skippedExisting;
        summary.skippedFillerOrUnknown += result.skippedFillerOrUnknown;
        if (result.status === "retryable") summary.retryable += 1;
        else {
          this.successfullyEvaluatedBoundaryByGuild.set(
            boundary.guildId,
            boundaryKey(boundary.guildId, boundary.syncTime),
          );
          if (result.established > 0) establishmentContexts.push({ boundary, result });
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
        `[home-membership] event=auto_establish_summary guild_id=${context.boundary.guildId} sync_time=${context.boundary.syncTime.toISOString()} evaluated=${context.result.evaluated} established=${context.result.established} skipped_existing=${context.result.skippedExisting} skipped_filler_or_unknown=${context.result.skippedFillerOrUnknown}`,
      );
    }
    if (establishmentContexts.length === 0) {
      dozzleLog.debug(
        `[home-membership] event=auto_establish_summary guild_id=bulk sync_time=latest evaluated=${summary.evaluated} established=${summary.established} skipped_existing=${summary.skippedExisting} skipped_filler_or_unknown=${summary.skippedFillerOrUnknown} retryable=${summary.retryable}`,
      );
    }
    if (firstFailure) throw firstFailure;
    return summary;
  }

  /** Purpose: evaluate one guild's newest exact boundary and preserve retryability when readiness is incomplete. */
  private async reconcileGuildBoundary(
    boundary: LatestBoundary,
    latestRows: CandidateSnapshot[],
  ): Promise<GuildEvaluationResult> {
    const baseResult = {
      boundaryTime: boundary.syncTime,
      evaluated: 0,
      established: 0,
      skippedExisting: 0,
      skippedFillerOrUnknown: 0,
    };
    if (latestRows.length === 0) return { status: "evaluated", ...baseResult };

    const playerTags = [...new Set(latestRows.map((row) => row.playerTag))].sort((a, b) => a.localeCompare(b));
    const existing = activeHomeMap(await this.getActiveHomeMembershipsForPlayers({
      guildId: boundary.guildId,
      playerTags,
    }));
    const candidates = playerTags.filter((playerTag) => !existing.has(`${boundary.guildId}|${playerTag}`));
    baseResult.skippedExisting = playerTags.length - candidates.length;
    if (candidates.length === 0) return { status: "evaluated", ...baseResult };

    const latestClanTags = [...new Set(latestRows.map((row) => row.clanTag))];
    const trackedRows = await this.db.trackedClan.findMany({
      where: { tag: { in: latestClanTags } },
      select: { tag: true },
    });
    const trackedClanTags = new Set(
      trackedRows.map((row) => normalizeTag(row?.tag)).filter(Boolean),
    );
    if (trackedClanTags.size === 0) return { status: "evaluated", ...baseResult };

    const evidenceByPlayer = await this.evidenceService.getMembershipBoundaryEvidenceForPlayers({
      guildId: boundary.guildId,
      playerTags: candidates,
      maxBoundaries: AUTO_ESTABLISHMENT_SYNC_COUNT,
    });
    const firstEvidence = evidenceByPlayer[candidates[0]] ?? [];
    if (firstEvidence[0]?.boundaryTime.getTime() !== boundary.syncTime.getTime()) {
      return { status: "retryable", ...baseResult };
    }
    if (firstEvidence.length < AUTO_ESTABLISHMENT_SYNC_COUNT) {
      return { status: "evaluated", ...baseResult };
    }
    const boundaryTimes = firstEvidence
      .slice(0, AUTO_ESTABLISHMENT_SYNC_COUNT)
      .map((row) => row.boundaryTime);
    const possible = new Map<string, { playerTag: string; clanTag: string; evidence: MembershipBoundaryEvidence[] }>();
    for (const playerTag of candidates) {
      const qualification = qualifyingEvidence(playerTag, evidenceByPlayer, trackedClanTags);
      if (!qualification) {
        baseResult.skippedFillerOrUnknown += 1;
        continue;
      }
      possible.set(playerTag, { playerTag, ...qualification });
    }
    if (possible.size === 0) return { status: "evaluated", ...baseResult };

    const readinessRows = normalizeReadinessFacts(await this.db.syncClanReadinessSnapshot.findMany({
      where: {
        guildId: boundary.guildId,
        syncTime: { in: boundaryTimes },
        clanTag: { in: [...new Set([...possible.values()].map((row) => row.clanTag))] },
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
    let readinessMissing = false;
    for (const candidate of possible.values()) {
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
    return {
      status: readinessMissing ? "retryable" : "evaluated",
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
}

export const clanHomeMembershipService = new ClanHomeMembershipService();
