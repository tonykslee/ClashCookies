import { prisma } from "../prisma";
import { normalizeTag } from "../services/war-events/core";
import {
  computeMembershipStreaksFromEvidence,
  MembershipStreakService,
  type MembershipBoundaryEvidence,
  type MembershipStreakResult,
} from "../services/MembershipStreakService";

export const SCHEDULE_CORRELATION_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const MAX_PREP_CLUSTER_SPREAD_MS = 2 * 60 * 60 * 1000;
export const AUDIT_WAR_ID_BATCH_SIZE = 500;

export type AuditClassification =
  | "EXISTING_EXACT"
  | "EXISTING_CYCLE_FALLBACK"
  | "SCHEDULED_SYNC_CANDIDATE"
  | "PREP_CLUSTER_CANDIDATE"
  | "LEGACY_WARLOOKUP_CANDIDATE"
  | "AMBIGUOUS"
  | "UNRECOVERABLE";

export type AuditPointEvidence = {
  guildId: string;
  syncNumber: number;
  clanTag: string;
  warId: number | null;
  warStartTime: Date;
  opponentTag: string;
  isFwa: boolean;
  identitySource?: "ClanPointsSync" | "WarPlanComplianceEvaluation";
};

export type AuditHistoryEvidence = {
  warId: number;
  syncNumber: number | null;
  matchType: string | null;
  clanTag: string;
  opponentTag: string | null;
  warStartTime: Date;
  prepStartTime: Date | null;
  warEndTime: Date | null;
};

export type AuditParticipationEvidence = {
  guildId: string;
  warId: number;
  clanTag: string;
  playerTag: string;
};

export type AuditScheduleEvidence = {
  id: string;
  guildId: string;
  syncTime: Date;
  status: string;
};

export type AuditSnapshotEvidence = {
  guildId: string;
  syncTime: Date;
  clanTag: string;
  playerTag: string;
};

export type AuditLookupEvidence = {
  warId: number;
  clanTag: string;
  startTime: Date;
  payload: unknown;
};

export type AuditCycleInput = {
  guildId: string;
  syncNumber: number;
  syncCycleTime: Date | null;
  points: AuditPointEvidence[];
  histories: AuditHistoryEvidence[];
  participation: AuditParticipationEvidence[];
  schedules: AuditScheduleEvidence[];
  exactSnapshots: AuditSnapshotEvidence[];
  lookups: AuditLookupEvidence[];
  missingParticipantWarMappings?: string[];
  explicitConflicts?: string[];
};

export type AuditPrepCluster = {
  min: Date | null;
  max: Date | null;
  center: Date | null;
  spreadSeconds: number | null;
  spreadMinutes: number | null;
  excessiveSpread: boolean;
};

export type AuditCycleReport = {
  guildId: string;
  syncNumber: number;
  classification: AuditClassification;
  candidateSyncTime: Date | null;
  candidateSource: string | null;
  syncCycleTime: Date | null;
  syncCycleExists: boolean;
  exactSnapshotCoverage: boolean;
  scheduledCandidateCount: number;
  scheduledCandidateStatuses: string[];
  scheduledCandidateDeltasSeconds: number[];
  historicalParticipatingClanCount: number;
  canonicalHistoryCount: number;
  historiesWithPrepStartTime: number;
  prepCluster: AuditPrepCluster;
  participationDistinctClanCount: number;
  participationDistinctPlayerCount: number;
  perClanRosterCounts: Record<string, number>;
  missingParticipantWarMappings: string[];
  conflicts: string[];
  earliestSupportingEvidence: Date | null;
  latestSupportingEvidence: Date | null;
  rosterCompleteness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  expectedTeamSize: number | null;
  expectedTeamSizesByClan: Record<string, number | null>;
  perClanRosterCompleteness: Record<string, "COMPLETE" | "PARTIAL" | "UNKNOWN">;
  playerClanFacts: Array<{ playerTag: string; clanTag: string; source: string }>;
};

export type ReadOnlyAuditDb = {
  syncCycle: { findMany: (args?: any) => Promise<any[]>; groupBy: (args?: any) => Promise<any[]> };
  syncClanMemberSnapshot: { findMany: (args?: any) => Promise<any[]>; groupBy: (args?: any) => Promise<any[]> };
  scheduledSyncPost: { findMany: (args?: any) => Promise<any[]> };
  clanPointsSync: { findMany: (args?: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args?: any) => Promise<any[]> };
  clanWarParticipation: { findMany: (args?: any) => Promise<any[]> };
  warLookup: { findMany: (args?: any) => Promise<any[]> };
  clanHomeMembershipPeriod: { findMany: (args?: any) => Promise<any[]> };
  syncClanReadinessSnapshot: { groupBy: (args?: any) => Promise<any[]> };
  allianceClanMembershipInterval: { findMany: (args?: any) => Promise<any[]> };
  warPlanComplianceEvaluation: { findMany: (args?: any) => Promise<any[]> };
};

/** Purpose: normalize a positive integer persisted by one of the historical owners. */
function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Purpose: accept only finite persisted Date values for boundary calculations. */
function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Purpose: normalize a guild identifier before guild-scoped evidence joins. */
function normalizeGuildId(value: unknown): string {
  return String(value ?? "").trim();
}

/** Purpose: normalize a player identifier before deterministic fact grouping. */
function normalizePlayerTag(value: unknown): string {
  return normalizeTag(String(value ?? ""));
}

/** Purpose: normalize a clan identifier before historical owner comparisons. */
function normalizeClanTag(value: unknown): string {
  return normalizeTag(String(value ?? ""));
}

/** Purpose: normalize case-insensitive persisted FWA/match status values. */
function comparable(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/** Purpose: identify canonical FWA history rows without trusting current-state registries. */
function isFwa(value: unknown): boolean {
  return comparable(value) === "FWA";
}

/** Purpose: scope a historical war identity to its clan so alliance rosters do not conflict. */
function warIdentityKey(point: AuditPointEvidence): string {
  const clanTag = normalizeClanTag(point.clanTag);
  return point.warId !== null
    ? `${clanTag}|war:${point.warId}`
    : `${clanTag}|start:${point.warStartTime.getTime()}|opponent:${normalizeClanTag(point.opponentTag)}`;
}

/** Purpose: compare the persisted tuple that makes a null-warId identity safely mergeable. */
function sameCanonicalWarTuple(left: AuditPointEvidence, right: AuditPointEvidence): boolean {
  return normalizeClanTag(left.clanTag) === normalizeClanTag(right.clanTag) &&
    left.syncNumber === right.syncNumber &&
    left.warStartTime.getTime() === right.warStartTime.getTime() &&
    normalizeClanTag(left.opponentTag) === normalizeClanTag(right.opponentTag);
}

/** Purpose: reconcile a partial null-warId point with an equivalent canonical non-null identity. */
function reconciledWarIdentityKey(point: AuditPointEvidence, points: readonly AuditPointEvidence[]): string {
  if (point.warId !== null) return warIdentityKey(point);
  const matchingNonNull = points.find((candidate) =>
    candidate.warId !== null && sameCanonicalWarTuple(point, candidate));
  return matchingNonNull ? warIdentityKey(matchingNonNull) : warIdentityKey(point);
}

/** Purpose: parse canonical participant tags from the supported archived WarLookup payload shape. */
export function parseCanonicalParticipantTags(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const canonical = root.canonical && typeof root.canonical === "object"
    ? root.canonical as Record<string, unknown>
    : null;
  const participants = canonical?.participants;
  if (!Array.isArray(participants)) return [];
  return [...new Set(
    participants
      .map((participant) => {
        if (typeof participant === "string") return normalizePlayerTag(participant);
        if (!participant || typeof participant !== "object") return "";
        const row = participant as Record<string, unknown>;
        return normalizePlayerTag(row.playerTag ?? row.tag ?? row.player_tag);
      })
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

/** Purpose: extract only the authoritative team size persisted by the WarLookup writer. */
function parseCanonicalTeamSize(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const warMeta = root.warMeta && typeof root.warMeta === "object"
    ? root.warMeta as Record<string, unknown>
    : null;
  if (String(warMeta?.teamSizeSource ?? "").trim().toLowerCase() !== "war_event_snapshot") return null;
  return normalizePositiveInteger(warMeta?.teamSize);
}

/** Purpose: derive a deterministic median-centered prep-time cluster and its spread. */
export function buildPrepCluster(prepTimes: readonly Date[]): AuditPrepCluster {
  const sorted = prepTimes
    .filter(isValidDate)
    .map((value) => value.getTime())
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      min: null,
      max: null,
      center: null,
      spreadSeconds: null,
      spreadMinutes: null,
      excessiveSpread: false,
    };
  }
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const middle = Math.floor(sorted.length / 2);
  const center = sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
  const spreadMs = max - min;
  return {
    min: new Date(min),
    max: new Date(max),
    center: new Date(center),
    spreadSeconds: Math.round(spreadMs / 1000),
    spreadMinutes: Math.round(spreadMs / 60_000),
    excessiveSpread: spreadMs > MAX_PREP_CLUSTER_SPREAD_MS,
  };
}

/** Purpose: select only persisted schedule rows in the conservative prep-time neighborhood. */
function findScheduleCandidates(
  guildId: string,
  prepCluster: AuditPrepCluster,
  schedules: readonly AuditScheduleEvidence[],
): AuditScheduleEvidence[] {
  if (!prepCluster.center) return [];
  return schedules
    .filter((schedule) =>
      schedule.guildId === guildId &&
      !["CANCELLED", "REPLACED"].includes(comparable(schedule.status)) &&
      isValidDate(schedule.syncTime) &&
      Math.abs(schedule.syncTime.getTime() - prepCluster.center!.getTime()) <= SCHEDULE_CORRELATION_THRESHOLD_MS,
    )
    .sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.id.localeCompare(right.id));
}

/** Purpose: map canonical histories to a points identity without nearest-time guessing. */
function historyMatchesPoint(history: AuditHistoryEvidence, point: AuditPointEvidence): boolean {
  if (!isFwa(history.matchType)) return false;
  if (history.warId === point.warId && point.warId !== null && normalizeClanTag(history.clanTag) === normalizeClanTag(point.clanTag)) {
    return history.syncNumber === null || history.syncNumber === point.syncNumber;
  }
  return (
    history.syncNumber === point.syncNumber &&
    normalizeClanTag(history.clanTag) === normalizeClanTag(point.clanTag) &&
    normalizeClanTag(history.opponentTag) === normalizeClanTag(point.opponentTag) &&
    history.warStartTime.getTime() === point.warStartTime.getTime()
  );
}

/** Purpose: identify persisted sync-number disagreement without allowing war identity to override it. */
function hasPersistedSyncNumberDisagreement(
  point: AuditPointEvidence,
  histories: readonly AuditHistoryEvidence[],
): boolean {
  return point.warId !== null && histories.some((history) =>
    isFwa(history.matchType) &&
    history.warId === point.warId &&
    normalizeClanTag(history.clanTag) === normalizeClanTag(point.clanTag) &&
    history.syncNumber !== null &&
    history.syncNumber !== point.syncNumber,
  );
}

/** Purpose: detect conflicting persisted owners for one historical war and clan. */
function hasConflictingPersistedOwners(points: readonly AuditPointEvidence[]): boolean {
  const ownersByWarClan = new Map<string, Set<string>>();
  for (const point of points) {
    if (point.warId === null) continue;
    const key = `${normalizeClanTag(point.clanTag)}|${point.warId}`;
    const owners = ownersByWarClan.get(key) ?? new Set<string>();
    owners.add(`${point.guildId}|${point.syncNumber}`);
    ownersByWarClan.set(key, owners);
  }
  return [...ownersByWarClan.values()].some((owners) => owners.size > 1);
}

/** Purpose: apply persisted-owner conflict detection only to the current cycle identity. */
function pointHasConflictingPersistedOwner(point: AuditPointEvidence, points: readonly AuditPointEvidence[]): boolean {
  if (point.warId === null) return false;
  const owners = new Set(points
    .filter((candidate) => candidate.warId === point.warId && normalizeClanTag(candidate.clanTag) === normalizeClanTag(point.clanTag))
    .map((candidate) => `${candidate.guildId}|${candidate.syncNumber}`));
  return owners.size > 1;
}

/** Purpose: build one diagnostic report from already-normalized historical evidence. */
export function classifyAuditCycle(input: AuditCycleInput): AuditCycleReport {
  const guildId = normalizeGuildId(input.guildId);
  const points = input.points.filter((point) => point.isFwa && point.guildId === guildId);
  const histories = input.histories.filter((history) => isFwa(history.matchType));
  const mappedHistories = histories.filter((history) => points.some((point) => historyMatchesPoint(history, point)));
  const participation = input.participation.filter((row) =>
    row.guildId === guildId && mappedHistories.some((history) =>
      history.warId === row.warId && normalizeClanTag(history.clanTag) === normalizeClanTag(row.clanTag)),
  );
  const prepCluster = buildPrepCluster(mappedHistories.map((history) => history.prepStartTime).filter(isValidDate));
  const scheduledCandidates = findScheduleCandidates(guildId, prepCluster, input.schedules);
  const exactSnapshots = input.exactSnapshots.filter((row) =>
    row.guildId === guildId && input.syncCycleTime && row.syncTime.getTime() === input.syncCycleTime.getTime(),
  );
  const historicalClanTags = new Set(points.map((point) => normalizeClanTag(point.clanTag)).filter(Boolean));
  for (const history of mappedHistories) historicalClanTags.add(normalizeClanTag(history.clanTag));
  const perClanRosterPlayers = new Map<string, Set<string>>();
  const perClanRosterCounts: Record<string, number> = {};
  const playerClanFacts: Array<{ playerTag: string; clanTag: string; source: string }> = [];
  const playerClanSets = new Map<string, Set<string>>();
  const factKeys = new Set<string>();
  for (const row of participation) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const clanTag = normalizeClanTag(row.clanTag);
    if (!playerTag || !clanTag) continue;
    const rosterPlayers = perClanRosterPlayers.get(clanTag) ?? new Set<string>();
    rosterPlayers.add(playerTag);
    perClanRosterPlayers.set(clanTag, rosterPlayers);
    perClanRosterCounts[clanTag] = rosterPlayers.size;
    const clans = playerClanSets.get(playerTag) ?? new Set<string>();
    clans.add(clanTag);
    playerClanSets.set(playerTag, clans);
    const factKey = `${playerTag}|${clanTag}`;
    if (!factKeys.has(factKey)) {
      factKeys.add(factKey);
      playerClanFacts.push({ playerTag, clanTag, source: "ClanWarParticipation" });
    }
  }
  const conflicts = [...(input.explicitConflicts ?? [])];
  const identityKeysByClan = new Map<string, Set<string>>();
  for (const point of points) {
    const identities = identityKeysByClan.get(normalizeClanTag(point.clanTag)) ?? new Set<string>();
    identities.add(reconciledWarIdentityKey(point, points));
    identityKeysByClan.set(normalizeClanTag(point.clanTag), identities);
    if (hasPersistedSyncNumberDisagreement(point, histories)) conflicts.push("persisted_sync_number_disagreement");
    if (pointHasConflictingPersistedOwner(point, points)) conflicts.push("conflicting_persisted_identity_sources");
  }
  if ([...identityKeysByClan.values()].some((identities) => identities.size > 1)) {
    conflicts.push("conflicting_war_identities");
  }
  for (const [playerTag, clans] of playerClanSets) {
    if (clans.size > 1) conflicts.push(`player_in_multiple_clans:${playerTag}`);
  }
  const legacyRosterFacts: Array<{ playerTag: string; clanTag: string }> = [];
  const participationIdentityKeys = new Set(
    participation.map((row) => `${row.warId}|${normalizeClanTag(row.clanTag)}`),
  );
  for (const history of mappedHistories) {
    const identityKey = `${history.warId}|${normalizeClanTag(history.clanTag)}`;
    if (participationIdentityKeys.has(identityKey)) continue;
    for (const lookup of input.lookups.filter((candidate) =>
      candidate.warId === history.warId && normalizeClanTag(candidate.clanTag) === normalizeClanTag(history.clanTag))) {
      for (const playerTag of parseCanonicalParticipantTags(lookup.payload)) {
        const clanTag = normalizeClanTag(lookup.clanTag);
        const factKey = `${playerTag}|${clanTag}`;
        if (!clanTag || factKeys.has(factKey)) continue;
        factKeys.add(factKey);
        const rosterPlayers = perClanRosterPlayers.get(clanTag) ?? new Set<string>();
        rosterPlayers.add(playerTag);
        perClanRosterPlayers.set(clanTag, rosterPlayers);
        perClanRosterCounts[clanTag] = rosterPlayers.size;
        playerClanFacts.push({ playerTag, clanTag, source: "WarLookup.canonical.participants" });
        legacyRosterFacts.push({ playerTag, clanTag });
      }
    }
  }
  const expectedTeamSizesByClan = new Map<string, Set<number>>();
  for (const lookup of input.lookups) {
    const expectedSize = parseCanonicalTeamSize(lookup.payload);
    if (expectedSize === null) continue;
    const clanTag = normalizeClanTag(lookup.clanTag);
    const sizes = expectedTeamSizesByClan.get(clanTag) ?? new Set<number>();
    sizes.add(expectedSize);
    expectedTeamSizesByClan.set(clanTag, sizes);
  }
  const expectedTeamSizesByClanRecord = Object.fromEntries([...historicalClanTags].sort((a, b) => a.localeCompare(b)).map((clanTag) => {
    const sizes = expectedTeamSizesByClan.get(clanTag) ?? new Set<number>();
    return [clanTag, sizes.size === 1 ? [...sizes][0] : null];
  }));
  for (const [clanTag, sizes] of expectedTeamSizesByClan) {
    if (sizes.size > 1) conflicts.push(`conflicting_expected_team_sizes:${clanTag}`);
  }
  const perClanRosterCompleteness = Object.fromEntries([...historicalClanTags].sort((a, b) => a.localeCompare(b)).map((clanTag) => {
    const expectedSize = expectedTeamSizesByClanRecord[clanTag];
    const observedSize = perClanRosterCounts[clanTag] ?? 0;
    const completeness = expectedSize === null
      ? "UNKNOWN"
      : observedSize === expectedSize ? "COMPLETE" : "PARTIAL";
    return [clanTag, completeness];
  })) as Record<string, "COMPLETE" | "PARTIAL" | "UNKNOWN">;
  const expectedTeamSizes = Object.values(expectedTeamSizesByClanRecord).filter((value): value is number => value !== null);
  const expectedTeamSize = expectedTeamSizes.length > 0 && new Set(expectedTeamSizes).size === 1
    ? expectedTeamSizes[0]
    : null;
  const rosterCompleteness = Object.values(perClanRosterCompleteness).length === 0 || Object.values(perClanRosterCompleteness).every((value) => value === "UNKNOWN")
    ? "UNKNOWN"
    : Object.values(perClanRosterCompleteness).every((value) => value === "COMPLETE")
      ? "COMPLETE"
      : "PARTIAL";
  const missingMappings = [...(input.missingParticipantWarMappings ?? [])];
  const normalizedRosterAvailable = participation.length > 0 && mappedHistories.length > 0;
  const legacyRosterAvailable = legacyRosterFacts.length > 0;
  const rosterEvidenceAvailable = normalizedRosterAvailable || legacyRosterAvailable;
  const exactCoverage = exactSnapshots.length > 0;
  if (prepCluster.excessiveSpread) conflicts.push("excessive_prep_start_spread");
  let classification: AuditClassification;
  let candidateSyncTime: Date | null = null;
  let candidateSource: string | null = null;
  if (conflicts.length > 0) {
    classification = "AMBIGUOUS";
  } else if (input.syncCycleTime && exactCoverage) {
    classification = "EXISTING_EXACT";
  } else if (input.syncCycleTime && rosterEvidenceAvailable) {
    classification = "EXISTING_CYCLE_FALLBACK";
  } else if (input.syncCycleTime) {
    classification = "UNRECOVERABLE";
  } else if (scheduledCandidates.length > 1) {
    classification = "AMBIGUOUS";
    conflicts.push("multiple_plausible_scheduled_sync_times");
  } else if (scheduledCandidates.length === 1 && rosterEvidenceAvailable && mappedHistories.length > 0) {
    classification = "SCHEDULED_SYNC_CANDIDATE";
    candidateSyncTime = scheduledCandidates[0].syncTime;
    candidateSource = legacyRosterAvailable && !normalizedRosterAvailable
      ? "ScheduledSyncPost.syncTime+WarLookup.canonical.participants"
      : "ScheduledSyncPost.syncTime";
  } else if (legacyRosterAvailable && mappedHistories.length > 0 && prepCluster.center && !prepCluster.excessiveSpread) {
    classification = "PREP_CLUSTER_CANDIDATE";
    candidateSyncTime = prepCluster.center;
    candidateSource = "ClanWarHistory.prepStartTime.median+WarLookup.canonical.participants";
  } else if (legacyRosterAvailable) {
    classification = "LEGACY_WARLOOKUP_CANDIDATE";
    candidateSource = "WarLookup.canonical.participants";
  } else if (mappedHistories.length > 0 && prepCluster.center) {
    classification = "PREP_CLUSTER_CANDIDATE";
    candidateSyncTime = prepCluster.center;
    candidateSource = "ClanWarHistory.prepStartTime.median";
  } else {
    classification = "UNRECOVERABLE";
  }
  if (classification === "AMBIGUOUS" && scheduledCandidates.length > 1) {
    candidateSyncTime = null;
    candidateSource = null;
  }
  const evidenceTimes = [
    ...points.flatMap((point) => [point.warStartTime]),
    ...mappedHistories.flatMap((history) => [history.prepStartTime, history.warStartTime, history.warEndTime]),
    ...participation.map((row) => mappedHistories.find((history) => history.warId === row.warId && history.clanTag === row.clanTag)?.warStartTime ?? null),
    ...scheduledCandidates.map((schedule) => schedule.syncTime),
  ].filter(isValidDate).map((value) => value.getTime());
  const earliestSupportingEvidence = evidenceTimes.length > 0 ? new Date(Math.min(...evidenceTimes)) : null;
  const latestSupportingEvidence = evidenceTimes.length > 0 ? new Date(Math.max(...evidenceTimes)) : null;
  return {
    guildId,
    syncNumber: input.syncNumber,
    classification,
    candidateSyncTime,
    candidateSource,
    syncCycleTime: input.syncCycleTime,
    syncCycleExists: Boolean(input.syncCycleTime),
    exactSnapshotCoverage: exactCoverage,
    scheduledCandidateCount: scheduledCandidates.length,
    scheduledCandidateStatuses: scheduledCandidates.map((schedule) => comparable(schedule.status)),
    scheduledCandidateDeltasSeconds: scheduledCandidates.map((schedule) => prepCluster.center
      ? Math.round((schedule.syncTime.getTime() - prepCluster.center.getTime()) / 1000)
      : 0),
    historicalParticipatingClanCount: historicalClanTags.size,
    canonicalHistoryCount: mappedHistories.length,
    historiesWithPrepStartTime: mappedHistories.filter((history) => isValidDate(history.prepStartTime)).length,
    prepCluster,
    participationDistinctClanCount: new Set(participation.map((row) => row.clanTag)).size,
    participationDistinctPlayerCount: new Set(participation.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean)).size,
    perClanRosterCounts: Object.fromEntries(Object.entries(perClanRosterCounts).sort(([a], [b]) => a.localeCompare(b))),
    missingParticipantWarMappings: [...new Set(missingMappings)].sort((a, b) => a.localeCompare(b)),
    conflicts: [...new Set(conflicts)].sort((a, b) => a.localeCompare(b)),
    earliestSupportingEvidence,
    latestSupportingEvidence,
    rosterCompleteness,
    expectedTeamSize,
    expectedTeamSizesByClan: Object.fromEntries(Object.entries(expectedTeamSizesByClanRecord).sort(([a], [b]) => a.localeCompare(b))),
    perClanRosterCompleteness: Object.fromEntries(Object.entries(perClanRosterCompleteness).sort(([a], [b]) => a.localeCompare(b))),
    playerClanFacts: playerClanFacts.sort((left, right) =>
      left.playerTag.localeCompare(right.playerTag) || left.clanTag.localeCompare(right.clanTag)),
  };
}

/** Purpose: classify all guild/sync identities in deterministic guild and sync-number order. */
export function classifyAuditCycles(inputs: readonly AuditCycleInput[]): AuditCycleReport[] {
  return [...inputs]
    .map(classifyAuditCycle)
    .sort((left, right) => left.guildId.localeCompare(right.guildId) || left.syncNumber - right.syncNumber);
}

/** Purpose: format the required compact audit summary before detailed cycle diagnostics. */
export function formatAuditSummary(reports: readonly AuditCycleReport[]): string {
  /** Purpose: count deterministic report classifications for the summary block. */
  const count = (classification: AuditClassification) => reports.filter((report) => report.classification === classification).length;
  const candidateReports = reports.filter((report) => [
    "SCHEDULED_SYNC_CANDIDATE",
    "PREP_CLUSTER_CANDIDATE",
    "LEGACY_WARLOOKUP_CANDIDATE",
  ].includes(report.classification));
  const candidateBoundaryReports = candidateReports.filter((report) => isValidDate(report.candidateSyncTime));
  const candidateFacts = candidateReports.reduce((sum, report) => sum + report.playerClanFacts.length, 0);
  const conflictCounts = new Map<string, number>();
  for (const reason of reports.flatMap((report) => report.conflicts)) {
    conflictCounts.set(reason, (conflictCounts.get(reason) ?? 0) + 1);
  }
  const conflictLines = [...conflictCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}: ${count}`);
  const syncNumbers = reports.map((report) => report.syncNumber).sort((a, b) => a - b);
  const safeDates = candidateBoundaryReports.map((report) => report.candidateSyncTime).filter(isValidDate).sort((a, b) => a.getTime() - b.getTime());
  const sortedCandidateReports = [...candidateBoundaryReports].sort((a, b) => a.syncNumber - b.syncNumber || a.guildId.localeCompare(b.guildId));
  const guilds = [...new Set(reports.map((report) => report.guildId))].sort((a, b) => a.localeCompare(b));
  const syncRange = syncNumbers.length > 0 ? `#${syncNumbers[0]} -> #${syncNumbers[syncNumbers.length - 1]}` : "none";
  return [
    "Historical Membership Backfill Audit",
    "",
    `Guild: ${guilds.length === 1 ? guilds[0] : guilds.length > 1 ? `${guilds.length} guilds` : "none"}`,
    `Sync range: ${syncRange}`,
    `Historical cycles found: ${reports.length}`,
    "",
    `Existing exact: ${count("EXISTING_EXACT")}`,
    `Existing fallback cycles: ${count("EXISTING_CYCLE_FALLBACK")}`,
    `Scheduled-sync candidates: ${count("SCHEDULED_SYNC_CANDIDATE")}`,
    `Prep-cluster candidates: ${count("PREP_CLUSTER_CANDIDATE")}`,
    `Legacy WarLookup candidates: ${count("LEGACY_WARLOOKUP_CANDIDATE")}`,
    `Ambiguous: ${count("AMBIGUOUS")}`,
    `Unrecoverable: ${count("UNRECOVERABLE")}`,
    "",
    "Conflict reasons:",
    ...(conflictLines.length > 0 ? conflictLines : ["none"]),
    "",
    `Potential additional canonical boundaries: ${candidateBoundaryReports.length}`,
    `Potential player-boundary membership facts: ${candidateFacts}`,
    `Earliest safely recoverable date: ${safeDates[0]?.toISOString() ?? "none"}`,
    `Earliest safely recoverable sync: ${sortedCandidateReports[0]?.syncNumber ? `#${sortedCandidateReports[0].syncNumber}` : "none"}`,
  ].join("\n");
}

/** Purpose: normalize raw points rows into the canonical audit point identity. */
function normalizePoints(rows: any[]): AuditPointEvidence[] {
  return rows.flatMap((row) => {
    const guildId = normalizeGuildId(row?.guildId);
    const syncNumber = normalizePositiveInteger(row?.syncNum);
    const clanTag = normalizeClanTag(row?.clanTag);
    const warStartTime = row?.warStartTime;
    const opponentTag = normalizeClanTag(row?.opponentTag);
    if (!guildId || !syncNumber || !clanTag || !opponentTag || !isValidDate(warStartTime)) return [];
    return [{
      guildId,
      syncNumber,
      clanTag,
      warId: normalizePositiveInteger(row?.warId),
      warStartTime,
      opponentTag,
      isFwa: Boolean(row?.isFwa),
      identitySource: "ClanPointsSync",
    }];
  });
}

/** Purpose: normalize canonical ended-war history rows for guild-independent identity matching. */
function normalizeHistories(rows: any[]): AuditHistoryEvidence[] {
  return rows.flatMap((row) => {
    const warId = normalizePositiveInteger(row?.warId);
    const clanTag = normalizeClanTag(row?.clanTag);
    const warStartTime = row?.warStartTime;
    if (!warId || !clanTag || !isValidDate(warStartTime)) return [];
    return [{
      warId,
      syncNumber: normalizePositiveInteger(row?.syncNumber),
      matchType: row?.matchType ?? null,
      clanTag,
      opponentTag: row?.opponentTag ? normalizeClanTag(row.opponentTag) : null,
      warStartTime,
      prepStartTime: isValidDate(row?.prepStartTime) ? row.prepStartTime : null,
      warEndTime: isValidDate(row?.warEndTime) ? row.warEndTime : null,
    }];
  });
}

/** Purpose: normalize participation rows into guild-scoped player/clan evidence. */
function normalizeParticipation(rows: any[]): AuditParticipationEvidence[] {
  return rows.flatMap((row) => {
    const guildId = normalizeGuildId(row?.guildId);
    const warId = normalizePositiveInteger(row?.warId);
    const clanTag = normalizeClanTag(row?.clanTag);
    const playerTag = normalizePlayerTag(row?.playerTag);
    if (!guildId || !warId || !clanTag || !playerTag || !isFwa(row?.matchType)) return [];
    return [{ guildId, warId, clanTag, playerTag }];
  });
}

/** Purpose: normalize persisted scheduled-sync rows while retaining status for ambiguity diagnostics. */
function normalizeSchedules(rows: any[]): AuditScheduleEvidence[] {
  return rows.flatMap((row) => {
    const id = String(row?.id ?? "").trim();
    const guildId = normalizeGuildId(row?.guildId);
    if (!id || !guildId || !isValidDate(row?.syncTime)) return [];
    return [{ id, guildId, syncTime: row.syncTime, status: comparable(row.status) }];
  });
}

/** Purpose: normalize immutable member snapshots for exact-coverage checks only. */
function normalizeSnapshots(rows: any[]): AuditSnapshotEvidence[] {
  return rows.flatMap((row) => {
    const guildId = normalizeGuildId(row?.guildId);
    const clanTag = normalizeClanTag(row?.clanTag);
    const playerTag = normalizePlayerTag(row?.playerTag);
    if (!guildId || !clanTag || !playerTag || !isValidDate(row?.syncTime)) return [];
    return [{ guildId, syncTime: row.syncTime, clanTag, playerTag }];
  });
}

/** Purpose: normalize archived WarLookup rows without using names to infer guild ownership. */
function normalizeLookups(rows: any[]): AuditLookupEvidence[] {
  return rows.flatMap((row) => {
    const warId = normalizePositiveInteger(row?.warId);
    const clanTag = normalizeClanTag(row?.clanTag);
    if (!warId || !clanTag || !isValidDate(row?.startTime)) return [];
    return [{
      warId,
      clanTag,
      startTime: row.startTime,
      payload: row.payload,
    }];
  });
}

/** Purpose: map compliance evaluations to canonical FWA histories as a secondary identity source. */
function normalizeComplianceIdentities(rows: any[], histories: AuditHistoryEvidence[]): AuditPointEvidence[] {
  return rows.flatMap((row) => {
    const guildId = normalizeGuildId(row?.guildId);
    const warId = normalizePositiveInteger(row?.warId);
    if (!guildId || warId === null) return [];
    const matchingHistories = histories.filter((history) =>
      history.warId === warId &&
      isFwa(history.matchType) &&
      history.syncNumber !== null &&
      isValidDate(history.warStartTime),
    );
    if (matchingHistories.length !== 1) return [];
    const history = matchingHistories[0];
    return [{
      guildId,
      syncNumber: history.syncNumber!,
      clanTag: history.clanTag,
      warId,
      warStartTime: history.warStartTime,
      opponentTag: history.opponentTag ?? "",
      isFwa: true,
      identitySource: "WarPlanComplianceEvaluation" as const,
    }].filter((point) => Boolean(point.opponentTag));
  });
}

/** Purpose: build candidate cycle inputs from all persisted read-only historical owners. */
export function buildCycleInputs(
  points: AuditPointEvidence[],
  histories: AuditHistoryEvidence[],
  participation: AuditParticipationEvidence[],
  schedules: AuditScheduleEvidence[],
  snapshots: AuditSnapshotEvidence[],
  lookups: AuditLookupEvidence[],
  cycles: any[],
): AuditCycleInput[] {
  const identities = new Map<string, { guildId: string; syncNumber: number; points: AuditPointEvidence[]; syncCycleTime: Date | null }>();
  const conflictingWarClanKeys = new Set<string>();
  const ownersByWarClan = new Map<string, Set<string>>();
  for (const point of points) {
    if (point.warId === null) continue;
    const key = `${normalizeClanTag(point.clanTag)}|${point.warId}`;
    const owners = ownersByWarClan.get(key) ?? new Set<string>();
    owners.add(`${point.guildId}|${point.syncNumber}`);
    ownersByWarClan.set(key, owners);
  }
  for (const [key, owners] of ownersByWarClan) {
    if (owners.size > 1) conflictingWarClanKeys.add(key);
  }
  // Keep this helper in the normalization path so future callers cannot accidentally drop owner conflicts.
  if (hasConflictingPersistedOwners(points)) {
    for (const [key, owners] of ownersByWarClan) {
      if (owners.size > 1) conflictingWarClanKeys.add(key);
    }
  }
  const partialTupleOwners = new Map<string, Set<string>>();
  const partialTupleHasNullOwner = new Set<string>();
  for (const point of points) {
    const tupleKey = `${normalizeClanTag(point.clanTag)}|start:${point.warStartTime.getTime()}|opponent:${normalizeClanTag(point.opponentTag)}`;
    const owners = partialTupleOwners.get(tupleKey) ?? new Set<string>();
    owners.add(`${point.guildId}|${point.syncNumber}`);
    partialTupleOwners.set(tupleKey, owners);
    if (point.warId === null) partialTupleHasNullOwner.add(tupleKey);
  }
  const partialIdentityConflictOwners = new Set<string>();
  for (const tupleKey of partialTupleHasNullOwner) {
    const owners = partialTupleOwners.get(tupleKey) ?? new Set<string>();
    if (owners.size <= 1) continue;
    for (const owner of owners) partialIdentityConflictOwners.add(owner);
  }
  for (const row of cycles) {
    const guildId = normalizeGuildId(row?.guildId);
    const syncNumber = normalizePositiveInteger(row?.syncNumber);
    if (!guildId || !syncNumber) continue;
    identities.set(`${guildId}|${syncNumber}`, {
      guildId,
      syncNumber,
      points: [],
      syncCycleTime: isValidDate(row?.syncTime) ? row.syncTime : null,
    });
  }
  for (const point of points) {
    const key = `${point.guildId}|${point.syncNumber}`;
    const current = identities.get(key) ?? {
      guildId: point.guildId,
      syncNumber: point.syncNumber,
      points: [],
      syncCycleTime: null,
    };
    current.points.push(point);
    identities.set(key, current);
  }
  return [...identities.values()].sort((left, right) =>
    left.guildId.localeCompare(right.guildId) || left.syncNumber - right.syncNumber,
  ).map((identity) => {
    const matchingHistories = histories.filter((history) => identity.points.some((point) => historyMatchesPoint(history, point)));
    const cycleParticipation = participation.filter((row) => row.guildId === identity.guildId && matchingHistories.some((history) =>
      history.warId === row.warId && normalizeClanTag(history.clanTag) === normalizeClanTag(row.clanTag)));
    const missingMappings = identity.points
      .filter((point) => !matchingHistories.some((history) => historyMatchesPoint(history, point)))
      .map((point) => `missing_history:${point.clanTag}`);
    for (const history of matchingHistories) {
      if (!cycleParticipation.some((row) => row.warId === history.warId && normalizeClanTag(row.clanTag) === normalizeClanTag(history.clanTag))) {
        missingMappings.push(`missing_participation:${history.clanTag}:${history.warId}`);
      }
    }
    const canonicalWarIds = new Set(matchingHistories.map((history) => history.warId));
    const relevantLookups = lookups.filter((lookup) => canonicalWarIds.has(lookup.warId));
    const matchingLookups = relevantLookups.filter((lookup) => matchingHistories.some((history) =>
      history.warId === lookup.warId && normalizeClanTag(history.clanTag) === normalizeClanTag(lookup.clanTag)));
    const lookupOwnerKeys = new Set(relevantLookups.flatMap((lookup) =>
      points.filter((point) => histories.some((history) =>
        history.warId === lookup.warId && historyMatchesPoint(history, point)))
        .map((point) => `${point.guildId}|${point.syncNumber}`),
    ));
    const historyOwnerKeys = new Set(matchingHistories.flatMap((history) =>
      points.filter((point) => historyMatchesPoint(history, point)).map((point) => `${point.guildId}|${point.syncNumber}`)));
    const explicitConflicts = [
      ...(identity.points.some((point) => point.warId !== null && conflictingWarClanKeys.has(`${normalizeClanTag(point.clanTag)}|${point.warId}`))
        ? ["conflicting_persisted_identity_sources"]
        : []),
      ...(lookupOwnerKeys.size > 1 ? ["warlookup_maps_to_multiple_guild_sync_owners"] : []),
      ...(relevantLookups.length !== matchingLookups.length ? ["warlookup_clan_identity_mismatch"] : []),
      ...(historyOwnerKeys.size > 1 ? ["history_maps_to_multiple_guild_sync_owners"] : []),
      ...(partialIdentityConflictOwners.has(`${identity.guildId}|${identity.syncNumber}`)
        ? ["conflicting_partial_war_identity_across_sync_buckets"]
        : []),
    ];
    const cycleLookups = lookupOwnerKeys.size === 1 && lookupOwnerKeys.has(`${identity.guildId}|${identity.syncNumber}`)
      ? matchingLookups
      : [];
    return {
      guildId: identity.guildId,
      syncNumber: identity.syncNumber,
      syncCycleTime: identity.syncCycleTime,
      points: identity.points,
      histories: matchingHistories,
      participation: cycleParticipation,
      schedules,
      exactSnapshots: snapshots,
      lookups: cycleLookups,
      missingParticipantWarMappings: [...new Set(missingMappings)].sort((a, b) => a.localeCompare(b)),
      explicitConflicts,
    };
  });
}

/** Purpose: split canonical war IDs into deterministic bounded Prisma IN batches. */
function chunkWarIds(warIds: readonly number[]): number[][] {
  const sorted = [...new Set(warIds)].sort((left, right) => left - right);
  const chunks: number[][] = [];
  for (let index = 0; index < sorted.length; index += AUDIT_WAR_ID_BATCH_SIZE) {
    chunks.push(sorted.slice(index, index + AUDIT_WAR_ID_BATCH_SIZE));
  }
  return chunks;
}

/** Purpose: load only canonical-war-scoped evidence in bounded bulk batches. */
async function readCanonicalWarRows(
  warIds: readonly number[],
  readChunk: (warIds: string[]) => Promise<any[]>,
): Promise<any[]> {
  const rows: any[] = [];
  for (const chunk of chunkWarIds(warIds)) rows.push(...await readChunk(chunk.map(String)));
  return rows;
}

/** Purpose: read every historical owner through an interface that exposes no mutation delegate. */
async function readAuditInputs(db: ReadOnlyAuditDb): Promise<AuditCycleInput[]> {
  const [cycles, rawSnapshots, rawSchedules, rawPoints, rawHistories, rawEvaluations] = await Promise.all([
    db.syncCycle.findMany({
      orderBy: [{ guildId: "asc" }, { syncNumber: "asc" }],
      select: { guildId: true, syncNumber: true, syncTime: true },
    }),
    db.syncClanMemberSnapshot.findMany({
      orderBy: [{ guildId: "asc" }, { syncTime: "asc" }, { clanTag: "asc" }, { playerTag: "asc" }],
      select: { guildId: true, syncTime: true, clanTag: true, playerTag: true },
    }),
    db.scheduledSyncPost.findMany({
      orderBy: [{ guildId: "asc" }, { syncTime: "asc" }],
      select: { id: true, guildId: true, syncTime: true, status: true },
    }),
    db.clanPointsSync.findMany({
      orderBy: [{ guildId: "asc" }, { syncNum: "asc" }, { clanTag: "asc" }],
      select: { guildId: true, syncNum: true, clanTag: true, warId: true, warStartTime: true, opponentTag: true, isFwa: true },
    }),
    db.clanWarHistory.findMany({
      orderBy: [{ syncNumber: "asc" }, { warId: "asc" }, { clanTag: "asc" }],
      select: { warId: true, syncNumber: true, matchType: true, clanTag: true, opponentTag: true, warStartTime: true, prepStartTime: true, warEndTime: true },
    }),
    db.warPlanComplianceEvaluation.findMany({
      orderBy: [{ guildId: "asc" }, { warId: "asc" }],
      select: { guildId: true, warId: true, warHistory: { select: { warId: true, syncNumber: true, matchType: true, clanTag: true, warStartTime: true, opponentTag: true, prepStartTime: true, warEndTime: true } } },
    }),
  ]);
  const normalizedHistories = normalizeHistories(rawHistories);
  const normalizedPoints = [
    ...normalizePoints(rawPoints),
    ...normalizeComplianceIdentities(rawEvaluations, normalizedHistories),
  ];
  const normalizedSchedules = normalizeSchedules(rawSchedules);
  const normalizedSnapshots = normalizeSnapshots(rawSnapshots);
  const stageOneInputs = buildCycleInputs(
    normalizedPoints,
    normalizedHistories,
    [],
    normalizedSchedules,
    normalizedSnapshots,
    [],
    cycles,
  );
  const canonicalWarIds = [...new Set(stageOneInputs.flatMap((input) => input.histories.map((history) => history.warId)))];
  const [rawParticipation, rawLookups] = await Promise.all([
    readCanonicalWarRows(canonicalWarIds, (warIds) => db.clanWarParticipation.findMany({
      where: { matchType: "FWA", warId: { in: warIds } },
      orderBy: [{ guildId: "asc" }, { warId: "asc" }, { playerTag: "asc" }],
      select: { guildId: true, warId: true, clanTag: true, playerTag: true, matchType: true },
    })),
    readCanonicalWarRows(canonicalWarIds, (warIds) => db.warLookup.findMany({
      where: { warId: { in: warIds } },
      orderBy: [{ startTime: "asc" }, { warId: "asc" }],
      select: { warId: true, clanTag: true, startTime: true, payload: true },
    })),
  ]);
  return buildCycleInputs(
    normalizedPoints,
    normalizedHistories,
    normalizeParticipation(rawParticipation),
    normalizedSchedules,
    normalizedSnapshots,
    normalizeLookups(rawLookups),
    cycles,
  );
}

/** Purpose: format deterministic per-clan observed/expected roster coverage. */
export function formatPerClanRosterCoverage(report: AuditCycleReport): string {
  const clans = new Set([
    ...Object.keys(report.perClanRosterCounts),
    ...Object.keys(report.expectedTeamSizesByClan),
    ...Object.keys(report.perClanRosterCompleteness),
  ]);
  return [...clans].sort((left, right) => left.localeCompare(right)).map((clanTag) => {
    const observed = report.perClanRosterCounts[clanTag] ?? 0;
    const expected = report.expectedTeamSizesByClan[clanTag] ?? null;
    const state = report.perClanRosterCompleteness[clanTag] ?? "UNKNOWN";
    return `${clanTag}=${observed}/${expected ?? "?"}:${state}`;
  }).join(",") || "-";
}

/** Purpose: format one deterministic per-cycle audit table row with per-clan roster coverage. */
export function formatCycleRow(report: AuditCycleReport): string {
  return [
    report.guildId,
    `#${report.syncNumber}`,
    report.classification,
    report.candidateSyncTime?.toISOString() ?? "-",
    report.candidateSource ?? "-",
    report.syncCycleExists ? "yes" : "no",
    report.exactSnapshotCoverage ? "yes" : "no",
    `${report.scheduledCandidateCount}(${report.scheduledCandidateStatuses.join(",") || "-"}/${report.scheduledCandidateDeltasSeconds.join(",") || "-"})`,
    `${report.prepCluster.min?.toISOString() ?? "-"}..${report.prepCluster.max?.toISOString() ?? "-"}/${report.prepCluster.spreadSeconds ?? "-"}`,
    String(report.historicalParticipatingClanCount),
    String(report.canonicalHistoryCount),
    String(report.participationDistinctClanCount),
    String(report.participationDistinctPlayerCount),
    formatPerClanRosterCoverage(report),
    report.missingParticipantWarMappings.join(",") || "-",
    report.conflicts.join(",") || "-",
    `${report.earliestSupportingEvidence?.toISOString() ?? "-"}..${report.latestSupportingEvidence?.toISOString() ?? "-"}`,
  ].join(" | ");
}

type ProjectedPlayerEvidence = {
  boundaries: Date[];
  evidenceRows: MembershipBoundaryEvidence[];
  coverageLimited: boolean;
};

/** Purpose: identify report classes that can contribute safe, timestamped candidate evidence. */
function isTimestampedCandidate(report: AuditCycleReport): boolean {
  return ["SCHEDULED_SYNC_CANDIDATE", "PREP_CLUSTER_CANDIDATE", "LEGACY_WARLOOKUP_CANDIDATE"].includes(report.classification) &&
    isValidDate(report.candidateSyncTime);
}

/** Purpose: construct one fallback membership evidence row from candidate roster facts. */
function buildCandidateEvidenceRow(
  playerTag: string,
  boundaryTime: Date,
  facts: Array<{ playerTag: string; clanTag: string; source: string }>,
): MembershipBoundaryEvidence {
  const clanTags = [...new Set(facts.map((fact) => normalizeClanTag(fact.clanTag)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const fwa = clanTags.length === 0
    ? { status: "UNKNOWN" as const, clanTag: null, clanTags: [], source: null }
    : {
        status: clanTags.length === 1 ? "RESOLVED" as const : "AMBIGUOUS" as const,
        clanTag: clanTags.length === 1 ? clanTags[0] : null,
        clanTags,
        source: "FWA_WAR_PARTICIPATION_FALLBACK" as const,
      };
  return {
    playerTag,
    boundaryTime,
    fwa,
    alliance: {
      positive: clanTags.length > 0,
      clanTags,
      ambiguous: clanTags.length > 1,
      sources: clanTags.length > 0 ? ["FWA_EVIDENCE"] : [],
    },
  };
}

/** Purpose: merge candidate boundaries with service evidence while preserving exact snapshot precedence. */
function buildProjectedPlayerEvidence(
  playerTag: string,
  currentBoundaries: readonly Date[],
  currentRows: readonly MembershipBoundaryEvidence[],
  currentIdentities: readonly { boundaryTime: Date; syncNumber: number }[],
  reports: readonly AuditCycleReport[],
): ProjectedPlayerEvidence {
  const currentByTime = new Map(currentRows.map((row) => [row.boundaryTime.getTime(), row]));
  const currentTimeBySync = new Map(currentIdentities.map((identity) => [identity.syncNumber, identity.boundaryTime]));
  const candidateFactsByTime = new Map<number, Array<{ playerTag: string; clanTag: string; source: string }>>();
  const candidateReports = reports.filter(isTimestampedCandidate);
  const reportsBySync = new Map<number, AuditCycleReport>();
  for (const report of reports) {
    if (!reportsBySync.has(report.syncNumber)) reportsBySync.set(report.syncNumber, report);
  }
  const latestCurrentSync = currentIdentities.length > 0
    ? Math.max(...currentIdentities.map((identity) => identity.syncNumber))
    : null;
  const candidateIsContiguous = (report: AuditCycleReport): boolean => {
    if (latestCurrentSync === null) return true;
    for (let syncNumber = latestCurrentSync - 1; syncNumber >= report.syncNumber; syncNumber -= 1) {
      const intervening = reportsBySync.get(syncNumber);
      if (intervening && (intervening.conflicts.length > 0 || ["AMBIGUOUS", "UNRECOVERABLE"].includes(intervening.classification))) return false;
      if (currentTimeBySync.has(syncNumber)) continue;
      if (!intervening || !isTimestampedCandidate(intervening) || intervening.conflicts.length > 0) return false;
    }
    return report.syncNumber < latestCurrentSync;
  };
  const usableCandidateReports = candidateReports.filter(candidateIsContiguous);
  for (const report of usableCandidateReports) {
    const boundaryTime = report.candidateSyncTime!.getTime();
    const facts = report.playerClanFacts.filter((fact) => fact.playerTag === playerTag);
    const rows = candidateFactsByTime.get(boundaryTime) ?? [];
    rows.push(...facts);
    candidateFactsByTime.set(boundaryTime, rows);
  }
  const boundaryTimes = [...new Map([
    ...currentBoundaries.map((boundaryTime) => [boundaryTime.getTime(), boundaryTime] as const),
    ...usableCandidateReports.map((report) => [report.candidateSyncTime!.getTime(), report.candidateSyncTime!] as const),
  ]).values()].sort((left, right) => right.getTime() - left.getTime());
  const evidenceRows = boundaryTimes.map((boundaryTime) => {
    const current = currentByTime.get(boundaryTime.getTime());
    if (current?.fwa.source === "SYNC_SNAPSHOT") return current;
    const candidateFacts = candidateFactsByTime.get(boundaryTime.getTime()) ?? [];
    if (candidateFacts.length > 0) return buildCandidateEvidenceRow(playerTag, boundaryTime, candidateFacts);
    return current ?? buildCandidateEvidenceRow(playerTag, boundaryTime, []);
  });
  const coverageLimited = reports.some((report) => {
    const relevant = report.playerClanFacts.some((fact) => fact.playerTag === playerTag);
    if (!relevant && !["AMBIGUOUS", "UNRECOVERABLE"].includes(report.classification)) return false;
    if (["AMBIGUOUS", "UNRECOVERABLE"].includes(report.classification)) return true;
    return isTimestampedCandidate(report) && !usableCandidateReports.includes(report);
  });
  return { boundaries: boundaryTimes, evidenceRows, coverageLimited };
}

/** Purpose: format a streak value without presenting lower-bound evidence as exact. */
function formatProjectedStreak(value: number, lowerBound: boolean): string {
  return `${value}${lowerBound ? "+" : ""}`;
}

/** Purpose: replay one player's current and candidate evidence through the shared streak algorithm. */
export function projectMembershipStreak(
  playerTag: string,
  current: {
    boundaryTimes: readonly Date[];
    boundaryIdentities?: readonly { boundaryTime: Date; syncNumber: number }[];
    evidenceRows: readonly MembershipBoundaryEvidence[];
    boundaryHistoryTruncated: boolean;
  },
  reports: readonly AuditCycleReport[],
): MembershipStreakResult {
  const projectedEvidence = buildProjectedPlayerEvidence(
    playerTag,
    current.boundaryTimes,
    current.evidenceRows,
    current.boundaryIdentities ?? [],
    reports,
  );
  return computeMembershipStreaksFromEvidence(
    playerTag,
    projectedEvidence.boundaries,
    projectedEvidence.evidenceRows,
    current.boundaryHistoryTruncated || projectedEvidence.coverageLimited,
  );
}

/** Purpose: compute read-only player streak and tenure diagnostics from shared boundary semantics. */
async function buildPlayerDiagnostics(
  db: ReadOnlyAuditDb,
  reports: readonly AuditCycleReport[],
  activeHomes: any[],
): Promise<string[]> {
  const lines = [
    "",
    "PLAYER IMPACT (projection is diagnostic only; no MembershipStreakService state was changed)",
  ];
  const homesByGuild = new Map<string, any[]>();
  for (const home of activeHomes) {
    const guildId = normalizeGuildId(home?.guildId);
    if (!guildId) continue;
    const rows = homesByGuild.get(guildId) ?? [];
    rows.push(home);
    homesByGuild.set(guildId, rows);
  }
  const streakService = new MembershipStreakService(db as any);
  for (const guildId of [...homesByGuild.keys()].sort((a, b) => a.localeCompare(b))) {
    const homes = homesByGuild.get(guildId) ?? [];
    const playerTags = homes.map((home) => normalizePlayerTag(home.playerTag)).filter(Boolean).sort((a, b) => a.localeCompare(b));
    if (playerTags.length === 0) continue;
    const current = await streakService.getMembershipStreakBatchForPlayers({ guildId, playerTags });
    const candidateReports = reports.filter((report) => report.guildId === guildId);
    for (const result of current.streaks) {
      const home = homes.find((row) => normalizePlayerTag(row.playerTag) === result.playerTag);
      const projected = projectMembershipStreak(
        result.playerTag,
        {
          boundaryTimes: current.boundaryTimes,
          boundaryIdentities: current.boundaryIdentities,
          evidenceRows: current.evidenceByPlayer[result.playerTag] ?? [],
          boundaryHistoryTruncated: current.boundaryHistoryTruncated,
        },
        candidateReports,
      );
      const earliest = candidateReports
        .filter((report) => isTimestampedCandidate(report) && report.playerClanFacts.some((fact) => fact.playerTag === result.playerTag))
        .map((report) => report.candidateSyncTime)
        .filter(isValidDate)
        .sort((left, right) => left.getTime() - right.getTime())[0];
      lines.push([
        `guild=${guildId}`,
        `player=${result.playerTag}`,
        `current_clan_streak=${formatProjectedStreak(result.clanStreakSyncs, result.clanStreakIsLowerBound)}`,
        `projected_clan_streak=${formatProjectedStreak(projected.clanStreakSyncs, projected.clanStreakIsLowerBound)}`,
        `current_alliance_streak=${formatProjectedStreak(result.allianceStreakSyncs, result.allianceStreakIsLowerBound)}`,
        `projected_alliance_streak_lower_bound=${formatProjectedStreak(projected.allianceStreakSyncs, true)}`,
        `alliance_projection_coverage=LIMITED`,
        `delta_clan=${projected.clanStreakSyncs - result.clanStreakSyncs}`,
        `delta_alliance_lower_bound=${projected.allianceStreakSyncs - result.allianceStreakSyncs}`,
        `prestart_home_contiguous_boundaries=${home ? buildHomeContinuity(candidateReports, home).reports.length : 0}`,
        `earliest_candidate_support=${earliest?.toISOString() ?? "none"}`,
      ].join(" "));
    }
  }
  return lines;
}

type HomeContinuity = {
  reports: AuditCycleReport[];
  startSyncNumber: number | null;
  stopReason: "NONE" | "GAP" | "ABSENT" | "UNKNOWN" | "CONFLICT" | "START_ANCHOR_UNKNOWN";
};

/** Purpose: walk safe pre-start evidence backward from the canonical Home start sync without skipping boundaries. */
function buildHomeContinuity(reports: readonly AuditCycleReport[], home: any): HomeContinuity {
  const guildId = normalizeGuildId(home.guildId);
  const playerTag = normalizePlayerTag(home.playerTag);
  const clanTag = normalizeClanTag(home.clanTag);
  const startedAt = new Date(home.startedAtSyncTime);
  const anchor = reports.find((report) =>
    report.guildId === guildId &&
    report.syncCycleTime instanceof Date &&
    report.syncCycleTime.getTime() === startedAt.getTime());
  if (!anchor) return { reports: [], startSyncNumber: null, stopReason: "START_ANCHOR_UNKNOWN" };
  const reportsBySync = new Map<number, AuditCycleReport[]>();
  for (const report of reports.filter((candidate) => candidate.guildId === guildId)) {
    const rows = reportsBySync.get(report.syncNumber) ?? [];
    rows.push(report);
    reportsBySync.set(report.syncNumber, rows);
  }
  const continuousRows: AuditCycleReport[] = [];
  let stopReason: HomeContinuity["stopReason"] = "NONE";
  for (let expectedSync = anchor.syncNumber - 1; expectedSync > 0; expectedSync -= 1) {
    const rows = reportsBySync.get(expectedSync) ?? [];
    if (rows.length === 0) {
      stopReason = "GAP";
      break;
    }
    const report = rows[0];
    if (rows.length > 1 || report.conflicts.length > 0 || report.classification === "AMBIGUOUS") {
      stopReason = "CONFLICT";
      break;
    }
    if (report.classification === "UNRECOVERABLE") {
      stopReason = "UNKNOWN";
      break;
    }
    if (!isTimestampedCandidate(report) || report.candidateSyncTime!.getTime() >= startedAt.getTime()) {
      stopReason = "GAP";
      break;
    }
    const hasSameHomeFact = report.playerClanFacts.some((fact) => fact.playerTag === playerTag && fact.clanTag === clanTag);
    if (hasSameHomeFact) {
      continuousRows.unshift(report);
      continue;
    }
    stopReason = report.perClanRosterCompleteness[clanTag] === "COMPLETE" ? "ABSENT" : "UNKNOWN";
    break;
  }
  return { reports: continuousRows, startSyncNumber: anchor.syncNumber, stopReason };
}

/** Purpose: report theoretical Home tenure extension without mutating Home periods or asserting historical filler truth. */
export function buildTenureDiagnostics(reports: readonly AuditCycleReport[], activeHomes: any[]): string[] {
  const lines = [
    "",
    "POTENTIAL HOME BACKDATE — NOT SAFE TO APPLY AUTOMATICALLY",
    `active Home player count: ${activeHomes.length}`,
  ];
  let sameHomeCount = 0;
  let theoreticalBoundaryCount = 0;
  for (const home of [...activeHomes].sort((left, right) =>
    String(left.guildId).localeCompare(String(right.guildId)) || String(left.playerTag).localeCompare(String(right.playerTag)),
  )) {
    const guildId = normalizeGuildId(home.guildId);
    const playerTag = normalizePlayerTag(home.playerTag);
    const clanTag = normalizeClanTag(home.clanTag);
    const continuity = buildHomeContinuity(reports, home);
    if (continuity.reports.length > 0) sameHomeCount += 1;
    theoreticalBoundaryCount += continuity.reports.length;
    lines.push(`guild=${guildId} player=${playerTag} home=${clanTag} home_start_sync=${continuity.startSyncNumber ?? "unknown"} earliest_continuous_same_clan=${continuity.reports[0]?.candidateSyncTime?.toISOString() ?? "none"} theoretical_extension_boundaries=${continuity.reports.length} stop_reason=${continuity.stopReason}`);
  }
  lines.splice(3, 0, `historical evidence shows same current Home before startedAtSyncTime: ${sameHomeCount}`);
  lines.push(`boundaries by which Clan Tenure could theoretically extend: ${theoreticalBoundaryCount}`);
  lines.push("Historical filler truth is incomplete before immutable SyncClanReadinessSnapshot capture; current filler registries were not consulted.");
  return lines;
}

/** Purpose: print the complete audit in summary-first deterministic sections. */
async function printAudit(
  reports: readonly AuditCycleReport[],
  activeHomes: any[],
  db: ReadOnlyAuditDb,
): Promise<void> {
  console.log(formatAuditSummary(reports));
  console.log("\nPer-cycle coverage");
  console.log("guild | sync | classification | candidate_sync_time | candidate_source | cycle | exact_snapshot | schedules(statuses/delta_s) | prep(min..max/spread_s) | clans | histories | participation_clans | participation_players | per_clan_roster | missing_mappings | conflicts | evidence(min..max)");
  for (const report of reports) console.log(formatCycleRow(report));
  console.log("\nAggregate per-clan coverage");
  for (const line of formatAggregatePerClanCoverage(reports)) console.log(line);

  console.log("\nCWL coverage limitation: this audit does not infer historical FWA absence or presence from current state; persisted CWL evidence was not used unless an unambiguous boundary owner is available.");
  console.log((await buildPlayerDiagnostics(db, reports, activeHomes)).join("\n"));
  console.log(buildTenureDiagnostics(reports, activeHomes).join("\n"));
}

/** Purpose: format deterministic per-clan candidate coverage without dropping unknown clans. */
export function formatAggregatePerClanCoverage(reports: readonly AuditCycleReport[]): string[] {
  const lines: string[] = [];
  const clans = new Map<string, AuditCycleReport[]>();
  for (const report of reports) {
    for (const clanTag of new Set([
      ...Object.keys(report.perClanRosterCounts),
      ...Object.keys(report.expectedTeamSizesByClan),
      ...Object.keys(report.perClanRosterCompleteness),
    ])) {
      const rows = clans.get(clanTag) ?? [];
      rows.push(report);
      clans.set(clanTag, rows);
    }
  }
  for (const clanTag of [...clans.keys()].sort((a, b) => a.localeCompare(b))) {
    const rows = clans.get(clanTag)!;
    const safe = rows
      .filter((row) => ["SCHEDULED_SYNC_CANDIDATE", "PREP_CLUSTER_CANDIDATE", "LEGACY_WARLOOKUP_CANDIDATE"].includes(row.classification))
      .sort((left, right) => left.syncNumber - right.syncNumber);
    const statusForClan = (row: AuditCycleReport) => row.perClanRosterCompleteness[clanTag] ?? "UNKNOWN";
    lines.push(`clan=${clanTag} first_recoverable_sync=${safe[0]?.syncNumber ?? "none"} last_recoverable_sync=${safe.at(-1)?.syncNumber ?? "none"} candidate_cycles=${safe.length} complete_roster_cycles=${safe.filter((row) => statusForClan(row) === "COMPLETE").length} partial_roster_cycles=${safe.filter((row) => statusForClan(row) === "PARTIAL").length} unknown_roster_cycles=${safe.filter((row) => statusForClan(row) === "UNKNOWN").length}`);
  }
  return lines;
}

/** Purpose: execute the one-off read-only historical membership backfill audit. */
export async function runMembershipHistoryBackfillAudit(db: ReadOnlyAuditDb = prisma as unknown as ReadOnlyAuditDb): Promise<AuditCycleReport[]> {
  console.log("READ ONLY — no database mutations will be performed.");
  const [inputs, activeHomes] = await Promise.all([
    readAuditInputs(db),
    db.clanHomeMembershipPeriod.findMany({
      where: { endedAtSyncTime: null },
      orderBy: [{ guildId: "asc" }, { playerTag: "asc" }],
      select: { guildId: true, playerTag: true, clanTag: true, startedAtSyncTime: true },
    }),
  ]);
  const reports = classifyAuditCycles(inputs);
  await printAudit(reports, activeHomes, db);
  return reports;
}

/** Purpose: run the CLI entrypoint and convert any read failure into a nonzero process exit. */
export async function main(): Promise<void> {
  await runMembershipHistoryBackfillAudit();
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
