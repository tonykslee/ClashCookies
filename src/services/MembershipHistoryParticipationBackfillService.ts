import {
  hasMembershipHistoryIdentityConflict,
  hasMembershipHistoryPartialIdentityConflict,
  hasMembershipHistorySyncNumberDisagreement,
  historicalHistoryMatchesPointByExactTuple,
  membershipCanonicalHistoryKey,
  membershipHistoryConflictingPersistedOwnerKeys,
  normalizeMembershipHistoryClanTag,
  type MembershipCanonicalHistoryIdentity,
  type MembershipHistoryPointIdentity,
} from "./membershipHistoryIdentity";
import {
  buildParticipationRows,
  type ParticipationAttackInput,
  type ParticipationParticipantInput,
  type ParticipationRow,
} from "./war-events/participationRowBuilder";
import { normalizeTag } from "./war-events/core";

const ID_QUERY_BATCH_SIZE = 500;
export const PARTICIPATION_CREATE_BATCH_SIZE = 250;
export const MEMBERSHIP_PARTICIPATION_BACKFILL_PREFIX = "[membership-participation-backfill]";

export type ParticipationBackfillAction = "INSERT_MISSING" | "ALREADY_PRESENT" | "SKIP" | "CONFLICT";
export type ProjectedRosterCoverage = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type ParticipationBackfillDb = {
  clanPointsSync: { findMany: (args?: any) => Promise<any[]> };
  warPlanComplianceEvaluation: { findMany: (args?: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args?: any) => Promise<any[]> };
  syncCycle: { findMany: (args?: any) => Promise<any[]> };
  warLookup: { findMany: (args?: any) => Promise<any[]> };
  clanWarParticipation: {
    findMany: (args?: any) => Promise<any[]>;
    createMany: (args: any) => Promise<{ count?: number }>;
  };
};

export type ParticipationBackfillWarReport = {
  guildId: string;
  syncNumber: number;
  clanTag: string | null;
  canonicalWarId: number | null;
  action: ParticipationBackfillAction;
  archiveParticipantCount: number;
  archivePositivePlayerCount: number;
  reconstructableCount: number;
  existingCount: number;
  existingPositivePlayerCount: number;
  plannedInsertCount: number;
  skippedUnreconstructableCount: number;
  malformedParticipantCount: number;
  unidentifiedParticipantCount: number;
  expectedTeamSize: number | null;
  projectedDistinctParticipationCount: number;
  projectedCoverage: ProjectedRosterCoverage;
  reasons: string[];
  plannedRows: ParticipationRow[];
  candidatePlayerTags?: string[];
};

export type ParticipationBackfillPlan = {
  guildId: string;
  selectedSyncs: number[];
  existingSyncCycles: number;
  candidateCanonicalFwaWars: number;
  reports: ParticipationBackfillWarReport[];
  rowsPlanned: number;
  rowsUnreconstructable: number;
  summary: {
    selectedSyncs: number;
    existingSyncCycles: number;
    candidateCanonicalFwaWars: number;
    validatedPointsConsidered: number;
    dirtyPointsIgnored: number;
    pointsCanonicalized: number;
    staleRawWarIdsCanonicalized: number;
    unmatchedValidatedPoints: number;
    ambiguousTuplePoints: number;
    alreadyCompleteNoOpWars: number;
    warsWithPlannedInserts: number;
    rowsPlanned: number;
    rowsUnreconstructable: number;
    completeProjectedRosters: number;
    partialProjectedRosters: number;
    unknownProjectedRosters: number;
    skippedWars: number;
    conflicts: number;
  };
};

export type ParticipationBackfillApplyResult = {
  batches: number;
  rowsAttempted: number;
  rowsReportedCreated: number;
  verifiedWars: ParticipationBackfillVerification[];
  mismatchedWars: ParticipationBackfillVerification[];
  verificationSuccessful: boolean;
};

export type ParticipationBackfillVerification = {
  warId: string;
  clanTag: string;
  expectedProjectedDistinctCount: number;
  observedDistinctCount: number;
  matches: boolean;
};

type PointIdentity = MembershipHistoryPointIdentity & {
  isFwa: boolean;
  needsValidation: boolean;
  rawWarId: number | null;
  evidenceSource: "points" | "compliance";
  staleRawWarId: boolean;
};
type HistoryIdentity = MembershipCanonicalHistoryIdentity & {
  warEndTime: Date | null;
};
type CycleIdentity = { syncNumber: number; syncTime: Date };
type LookupIdentity = { warId: number; clanTag: string; opponentTag: string | null; startTime: Date; endTime: Date | null; payload: unknown };
type ExistingParticipation = {
  warId: string;
  clanTag: string;
  playerTag: string;
  matchType: string;
  warStartTime: Date;
  [key: string]: unknown;
};

type ParsedParticipant = ParticipationParticipantInput & { declaredAttacksUsed: number | null };
type ParsedArchiveAttack = ParticipationAttackInput & {
  attackOrder: number | null;
  hasAttackOrder: boolean;
  legacyIdentityKey: string;
};
type ParsedArchive = {
  participants: ParsedParticipant[];
  attacks: ParsedArchiveAttack[] | null;
  skippedPlayers: Set<string>;
  archivePositivePlayerTags: Set<string>;
  malformedParticipantCount: number;
  unidentifiedParticipantCount: number;
  skippedUnreconstructableCount: number;
  reasons: string[];
  conflict: boolean;
  warEndTime: Date | null;
};

/** Purpose: split identifiers into bounded query or write batches. */
function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/** Purpose: execute bounded bulk reads without issuing one query per identity. */
async function bulkFindMany<T>(values: readonly T[], fetch: (batch: T[]) => Promise<any[]>): Promise<any[]> {
  if (values.length === 0) return [];
  const rows = await Promise.all(chunks(values, ID_QUERY_BATCH_SIZE).map(fetch));
  return rows.flat();
}

/** Purpose: normalize a positive integer persisted value without inventing defaults. */
function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Purpose: normalize a non-negative integer persisted value without inventing defaults. */
function nonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Purpose: accept only finite persisted date-like values. */
function finiteDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/** Purpose: normalize the required guild scope. */
function guildId(value: unknown): string {
  return String(value ?? "").trim();
}

/** Purpose: compare persisted enum-like values case-insensitively. */
function comparable(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/** Purpose: normalize a player tag through the shared Clash tag rules. */
function normalizePlayerTag(value: unknown): string {
  return normalizeTag(String(value ?? ""));
}

/** Purpose: normalize a persisted war ID to a positive numeric history key. */
function normalizeWarId(value: unknown): number | null {
  return positiveInteger(value);
}

/** Purpose: normalize a points row into the shared historical identity shape. */
function pointFromRow(row: any, evidenceSource: PointIdentity["evidenceSource"] = "points"): PointIdentity | null {
  const normalizedGuildId = guildId(row?.guildId);
  const syncNumber = positiveInteger(row?.syncNum);
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  const warStartTime = finiteDate(row?.warStartTime);
  const opponentTag = normalizeMembershipHistoryClanTag(row?.opponentTag);
  if (!normalizedGuildId || !syncNumber || !clanTag || !warStartTime || !opponentTag) return null;
  return {
    guildId: normalizedGuildId,
    syncNumber,
    warId: normalizeWarId(row?.warId),
    clanTag,
    warStartTime,
    opponentTag,
    isFwa: row?.isFwa === true || comparable(row?.matchType) === "FWA",
    needsValidation: row?.needsValidation === true,
    rawWarId: normalizeWarId(row?.warId),
    evidenceSource,
    staleRawWarId: false,
  };
}

/** Purpose: normalize an FWA history row into the canonical identity shape. */
function historyFromRow(row: any): HistoryIdentity | null {
  const warId = normalizeWarId(row?.warId);
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  const warStartTime = finiteDate(row?.warStartTime);
  if (!warId || !clanTag || !warStartTime || comparable(row?.matchType) !== "FWA") return null;
  return {
    warId,
    syncNumber: positiveInteger(row?.syncNumber),
    clanTag,
    warStartTime,
    opponentTag: row?.opponentTag == null ? null : normalizeMembershipHistoryClanTag(row.opponentTag),
    warEndTime: finiteDate(row?.warEndTime),
  };
}

/** Purpose: de-duplicate persisted point identities deterministically. */
function uniquePoints(rows: PointIdentity[]): PointIdentity[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.guildId}|${row.syncNumber}|${row.warId ?? "null"}|${row.clanTag}|${row.warStartTime.getTime()}|${row.opponentTag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Purpose: convert a raw validated point into the canonical history identity selected by exact tuple and sync. */
function canonicalizePoint(point: PointIdentity, histories: readonly HistoryIdentity[]): { point: PointIdentity | null; matchCount: number; staleRawWarId: boolean } {
  const matches = canonicalHistoryMatchesForPoint(point, histories);
  if (matches.length !== 1) return { point: null, matchCount: matches.length, staleRawWarId: false };
  const history = matches[0];
  const staleRawWarId = point.rawWarId !== null && point.rawWarId !== history.warId;
  return {
    point: {
      ...point,
      warId: history.warId,
      syncNumber: history.syncNumber ?? point.syncNumber,
      clanTag: history.clanTag,
      warStartTime: history.warStartTime!,
      opponentTag: history.opponentTag ?? "",
      isFwa: true,
      needsValidation: false,
      staleRawWarId,
    },
    matchCount: 1,
    staleRawWarId,
  };
}

/** Purpose: find only the canonical FWA history selected by a point's sync and exact semantic tuple. */
function canonicalHistoryMatchesForPoint(point: PointIdentity, histories: readonly HistoryIdentity[]): HistoryIdentity[] {
  return histories.filter((history) =>
    history.syncNumber === point.syncNumber && historicalHistoryMatchesPointByExactTuple(history, point));
}

/** Purpose: construct canonical owner evidence directly from a guild-scoped compliance evaluation's related history. */
function pointFromComplianceEvaluation(row: any): PointIdentity | null {
  const history = historyFromRow(row?.warHistory);
  const guildId = guildIdFromValue(row?.guildId);
  if (!history || history.syncNumber === null || comparable(row?.matchType ?? row?.warHistory?.matchType) !== "FWA" || !guildId) return null;
  return {
    guildId,
    syncNumber: history.syncNumber,
    warId: history.warId,
    clanTag: history.clanTag,
    warStartTime: history.warStartTime!,
    opponentTag: history.opponentTag ?? "",
    isFwa: true,
    needsValidation: false,
    rawWarId: normalizeWarId(row?.warId),
    evidenceSource: "compliance",
    staleRawWarId: false,
  };
}

/** Purpose: normalize a persisted guild identifier for compliance-derived canonical ownership. */
function guildIdFromValue(value: unknown): string {
  return String(value ?? "").trim();
}

/** Purpose: identify canonical tuple evidence that resolves to incompatible histories across sync owners. */
function canonicalTupleConflictOwners(points: readonly PointIdentity[], histories: readonly HistoryIdentity[]): Map<string, Set<string>> {
  const ownersByTuple = new Map<string, Map<string, Set<string>>>();
  for (const point of points.filter((candidate) => candidate.isFwa)) {
    const history = histories.find((candidate) =>
      candidate.warId === point.warId &&
      candidate.syncNumber === point.syncNumber &&
      historicalHistoryMatchesPointByExactTuple(candidate, point));
    if (!history) continue;
    const tupleKey = `${point.clanTag}|${point.warStartTime.getTime()}|${point.opponentTag}`;
    const historyKey = membershipCanonicalHistoryKey(history);
    const historiesForTuple = ownersByTuple.get(tupleKey) ?? new Map<string, Set<string>>();
    const owners = historiesForTuple.get(historyKey) ?? new Set<string>();
    owners.add(ownerKey(point));
    historiesForTuple.set(historyKey, owners);
    ownersByTuple.set(tupleKey, historiesForTuple);
  }
  const conflictsByOwner = new Map<string, Set<string>>();
  for (const historiesForTuple of ownersByTuple.values()) {
    if (historiesForTuple.size <= 1) continue;
    for (const owners of historiesForTuple.values()) {
      for (const owner of owners) {
        const reasons = conflictsByOwner.get(owner) ?? new Set<string>();
        reasons.add("conflicting_partial_war_identity_across_sync_buckets");
        conflictsByOwner.set(owner, reasons);
      }
    }
  }
  return conflictsByOwner;
}

/** Purpose: preserve fail-closed canonical clan ownership when one war ID is associated with multiple clans. */
function canonicalWarClanConflictOwners(points: readonly PointIdentity[], histories: readonly HistoryIdentity[]): Map<string, Set<string>> {
  const clansByWar = new Map<number, Map<string, Set<string>>>();
  for (const point of points.filter((candidate) => candidate.isFwa)) {
    const history = histories.find((candidate) =>
      candidate.warId === point.warId &&
      candidate.syncNumber === point.syncNumber &&
      historicalHistoryMatchesPointByExactTuple(candidate, point));
    if (!history) continue;
    const owners = clansByWar.get(history.warId) ?? new Map<string, Set<string>>();
    const ownerKeys = owners.get(history.clanTag) ?? new Set<string>();
    ownerKeys.add(ownerKey(point));
    owners.set(history.clanTag, ownerKeys);
    clansByWar.set(history.warId, owners);
  }
  const conflictsByOwner = new Map<string, Set<string>>();
  for (const clans of clansByWar.values()) {
    if (clans.size <= 1) continue;
    for (const owners of clans.values()) {
      for (const owner of owners) {
        const reasons = conflictsByOwner.get(owner) ?? new Set<string>();
        reasons.add("contradictory_clan_ownership");
        conflictsByOwner.set(owner, reasons);
      }
    }
  }
  return conflictsByOwner;
}

/** Purpose: de-duplicate canonical history identities deterministically. */
function uniqueHistories(rows: HistoryIdentity[]): HistoryIdentity[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.warId}|${row.syncNumber ?? "null"}|${row.clanTag}|${row.warStartTime?.getTime() ?? "null"}|${row.opponentTag ?? "null"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Purpose: identify the guild and canonical sync owner of a points row. */
function ownerKey(point: PointIdentity): string {
  return `${point.guildId}|${point.syncNumber}`;
}

/** Purpose: safely narrow an archived JSON value to a non-array object. */
function objectRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

/** Purpose: read and normalize a player tag from supported participant or attack shapes. */
function readTag(value: Record<string, any>): string {
  return normalizePlayerTag(value.playerTag ?? value.attackerTag ?? value.tag ?? value.player?.tag);
}

/** Purpose: read an archived display name while preserving unknown values as null. */
function readPlayerName(value: Record<string, any>): string | null {
  const name = value.playerName ?? value.attackerName ?? value.name ?? value.player?.name;
  return name == null ? null : String(name);
}

/** Purpose: read an archived map position without coercing invalid values to a position. */
function readPosition(value: Record<string, any>): number | null {
  const raw = value.playerPosition ?? value.mapPosition ?? value.position ?? value.player?.mapPosition;
  return raw == null ? null : nonNegativeInteger(raw);
}

/** Purpose: compare parsed duplicate participant facts without considering object ordering. */
function sameParticipant(left: ParsedParticipant, right: ParsedParticipant): boolean {
  return left.playerName === right.playerName && left.playerPosition === right.playerPosition && left.declaredAttacksUsed === right.declaredAttacksUsed;
}

/** Purpose: create a deterministic fingerprint for de-duplicating malformed archive entries. */
function archiveFingerprint(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(archiveFingerprint).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${archiveFingerprint(record[key])}`).join(",")}}`;
}

/** Purpose: parse a canonical participant while retaining only reconstructable participant fields. */
function parseParticipant(value: unknown): ParsedParticipant | null {
  if (typeof value === "string") {
    const playerTag = normalizePlayerTag(value);
    return playerTag ? { playerTag, playerName: null, playerPosition: null, declaredAttacksUsed: null } : null;
  }
  const record = objectRecord(value);
  if (!record) return null;
  const playerTag = readTag(record);
  if (!playerTag) return null;
  const hasDeclaredCount = Object.prototype.hasOwnProperty.call(record, "attacksUsed");
  const declaredAttacksUsed = hasDeclaredCount ? nonNegativeInteger(record.attacksUsed) : null;
  if (hasDeclaredCount && declaredAttacksUsed === null) return null;
  return { playerTag, playerName: readPlayerName(record), playerPosition: readPosition(record), declaredAttacksUsed };
}

/** Purpose: identify whether an archived attack declares an attack-order field. */
function readAttackOrder(record: Record<string, any>): { present: boolean; value: number | null } {
  const hasAttackOrder = Object.prototype.hasOwnProperty.call(record, "attackOrder");
  const hasLegacyOrder = Object.prototype.hasOwnProperty.call(record, "order");
  const present = hasAttackOrder || hasLegacyOrder;
  if (!present) return { present: false, value: null };
  return { present: true, value: positiveInteger(hasAttackOrder ? record.attackOrder : record.order) };
}

/** Purpose: derive conservative identity fields for legacy attacks without persisted order. */
function legacyAttackIdentityKey(record: Record<string, any>, attack: ParticipationAttackInput): string {
  const defenderTag = normalizePlayerTag(record.defenderTag ?? record.defender?.tag);
  const defenderPosition = nonNegativeInteger(record.defenderPosition ?? record.defender?.mapPosition);
  return [attack.playerTag, defenderTag, defenderPosition ?? "null", attack.stars, attack.trueStars, attack.attackSeenAt.getTime()].join("|");
}

/** Purpose: parse required archived attack facts while retaining order and legacy identity metadata. */
function parseAttack(value: unknown): ParsedArchiveAttack | null {
  const record = objectRecord(value);
  if (!record) return null;
  const playerTag = readTag(record);
  const stars = nonNegativeInteger(record.stars);
  const trueStars = nonNegativeInteger(record.trueStars);
  const attackSeenAt = finiteDate(record.attackSeenAt ?? record.timestamp ?? record.attackTime);
  if (!playerTag || stars === null || trueStars === null || stars > 3 || trueStars > 3 || !attackSeenAt) return null;
  const order = readAttackOrder(record);
  return {
    playerTag,
    playerName: readPlayerName(record),
    stars,
    trueStars,
    attackSeenAt,
    attackOrder: order.value,
    hasAttackOrder: order.present,
    legacyIdentityKey: legacyAttackIdentityKey(record, { playerTag, playerName: readPlayerName(record), stars, trueStars, attackSeenAt }),
  };
}

/** Purpose: read archived war metadata for identity and team-size checks. */
function lookupMeta(payload: unknown): Record<string, any> | null {
  const record = objectRecord(payload);
  return objectRecord(record?.warMeta);
}

/** Purpose: validate archived lookup identity against the canonical history owner. */
function validateLookup(history: HistoryIdentity, lookup: LookupIdentity): string[] {
  const reasons: string[] = [];
  if (lookup.warId !== history.warId) reasons.push("lookup_war_id_mismatch");
  if (normalizeMembershipHistoryClanTag(lookup.clanTag) !== history.clanTag) reasons.push("lookup_clan_mismatch");
  if (lookup.startTime.getTime() !== history.warStartTime!.getTime()) reasons.push("lookup_start_time_mismatch");
  if (lookup.opponentTag && history.opponentTag && normalizeMembershipHistoryClanTag(lookup.opponentTag) !== normalizeMembershipHistoryClanTag(history.opponentTag)) reasons.push("lookup_opponent_mismatch");
  const meta = lookupMeta(lookup.payload);
  if (meta) {
    const metaWarId = normalizeWarId(meta.warId);
    const metaClanTag = normalizeMembershipHistoryClanTag(meta.clanTag);
    const metaStart = finiteDate(meta.startTime);
    const metaOpponent = meta.opponentTag == null ? null : normalizeMembershipHistoryClanTag(meta.opponentTag);
    if (metaWarId !== null && metaWarId !== history.warId) reasons.push("canonical_war_id_mismatch");
    if (metaClanTag && metaClanTag !== history.clanTag) reasons.push("canonical_clan_mismatch");
    if (metaStart && metaStart.getTime() !== history.warStartTime!.getTime()) reasons.push("canonical_start_time_mismatch");
    if (metaOpponent && history.opponentTag && metaOpponent !== normalizeMembershipHistoryClanTag(history.opponentTag)) reasons.push("canonical_opponent_mismatch");
  }
  return [...new Set(reasons)].sort();
}

/** Purpose: resolve the best persisted end time for a reconstructed participation row. */
function archiveWarEndTime(history: HistoryIdentity, lookup: LookupIdentity, canonical: Record<string, any> | null): Date | null {
  return history.warEndTime ?? lookup.endTime ?? finiteDate(canonical?.warEndTime) ?? finiteDate(lookupMeta(lookup.payload)?.endTime);
}

/** Purpose: construct a failed archive parse while preserving positive identities and accounting. */
function archiveFailure(input: {
  history: HistoryIdentity;
  lookup: LookupIdentity;
  canonical: Record<string, any> | null;
  archivePositivePlayerTags: Set<string>;
  malformedParticipantCount: number;
  unidentifiedParticipantCount: number;
  reasons: string[];
  conflict: boolean;
  skippedUnreconstructableCount: number;
}): ParsedArchive {
  return {
    participants: [],
    attacks: null,
    skippedPlayers: new Set<string>(),
    archivePositivePlayerTags: input.archivePositivePlayerTags,
    malformedParticipantCount: input.malformedParticipantCount,
    unidentifiedParticipantCount: input.unidentifiedParticipantCount,
    skippedUnreconstructableCount: input.skippedUnreconstructableCount,
    reasons: input.reasons,
    conflict: input.conflict,
    warEndTime: archiveWarEndTime(input.history, input.lookup, input.canonical),
  };
}

/** Purpose: parse archived canonical roster facts and retain positive identities even when metrics are incomplete. */
function parseArchive(history: HistoryIdentity, lookup: LookupIdentity): ParsedArchive {
  const payload = objectRecord(lookup.payload);
  const canonical = objectRecord(payload?.canonical);
  const rawParticipants = canonical?.participants;
  const rawAttacks = canonical?.attacks;
  const reasons: string[] = [];
  const skippedPlayers = new Set<string>();
  const archivePositivePlayerTags = new Set<string>();
  let malformedParticipantCount = 0;
  let unidentifiedParticipantCount = 0;
  const malformedFingerprints = new Set<string>();
  const malformedTagFingerprints = new Map<string, string>();
  if (!Array.isArray(rawParticipants)) {
    return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["missing_canonical_participants"], conflict: false, skippedUnreconstructableCount: 0 });
  }

  const byTag = new Map<string, ParsedParticipant>();
  for (const rawParticipant of rawParticipants) {
    const rawRecord = objectRecord(rawParticipant);
    const rawTag = rawRecord ? readTag(rawRecord) : typeof rawParticipant === "string" ? normalizePlayerTag(rawParticipant) : "";
    if (rawTag) archivePositivePlayerTags.add(rawTag);
    if (rawRecord && Object.prototype.hasOwnProperty.call(rawRecord, "attacksUsed") && nonNegativeInteger(rawRecord.attacksUsed) !== null && Number(rawRecord.attacksUsed) > 2) {
      return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["invalid_declared_attack_count"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount });
    }
    const participant = parseParticipant(rawParticipant);
    if (!participant) {
      const fingerprint = archiveFingerprint(rawParticipant);
      if (rawTag) {
        const previousMalformedFingerprint = malformedTagFingerprints.get(rawTag);
        if ((previousMalformedFingerprint && previousMalformedFingerprint !== fingerprint) || byTag.has(rawTag)) {
          return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["contradictory_duplicate_participant"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount });
        }
        malformedTagFingerprints.set(rawTag, fingerprint);
      }
      if (!malformedFingerprints.has(fingerprint)) {
        malformedFingerprints.add(fingerprint);
        malformedParticipantCount += 1;
        if (!rawTag) unidentifiedParticipantCount += 1;
      }
      if (rawTag && byTag.has(rawTag)) {
        return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["contradictory_duplicate_participant"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount });
      }
      reasons.push("malformed_participant");
      continue;
    }
    if (malformedTagFingerprints.has(participant.playerTag)) {
      return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["contradictory_duplicate_participant"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount });
    }
    const previous = byTag.get(participant.playerTag);
    if (previous && !sameParticipant(previous, participant)) {
      return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["contradictory_duplicate_participant"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount });
    }
    byTag.set(participant.playerTag, participant);
  }

  let attacks: ParsedArchiveAttack[] | null = null;
  if (rawAttacks !== undefined && rawAttacks !== null) {
    if (!Array.isArray(rawAttacks)) {
      for (const tag of byTag.keys()) skippedPlayers.add(tag);
      return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["malformed_canonical_attacks"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
    }
    const parsed: ParsedArchiveAttack[] = [];
    const seenOrderedAttacks = new Set<string>();
    const seenLegacyAttackFingerprints = new Set<string>();
    const legacyIdentityKeysByPlayer = new Map<string, Set<string>>();
    const legacyAmbiguousPlayers = new Set<string>();
    let sawOrderedAttack = false;
    let sawLegacyAttack = false;
    for (const rawAttack of rawAttacks) {
      const rawRecord = objectRecord(rawAttack);
      const tag = rawRecord ? readTag(rawRecord) : "";
      if (!tag) return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["attack_player_unreconcilable"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
      if (!byTag.has(tag)) return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["attack_player_not_in_participants"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
      const order = readAttackOrder(rawRecord!);
      if (order.present) {
        sawOrderedAttack = true;
        if (order.value === null) return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["invalid_canonical_attack_order"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
        const orderKey = `${tag}|${order.value}`;
        if (seenOrderedAttacks.has(orderKey)) return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["duplicate_canonical_attack_order"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
        seenOrderedAttacks.add(orderKey);
      } else {
        sawLegacyAttack = true;
      }
      const attack = parseAttack(rawAttack);
      if (!attack) {
        skippedPlayers.add(tag);
        reasons.push("malformed_attack");
        continue;
      }
      if (attack.hasAttackOrder) {
        if (sawLegacyAttack) return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["mixed_canonical_attack_identity"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
      } else {
        if (sawOrderedAttack) return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["mixed_canonical_attack_identity"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
        const rawFingerprint = archiveFingerprint(rawAttack);
        if (seenLegacyAttackFingerprints.has(`${tag}|${rawFingerprint}`)) {
          reasons.push("duplicate_legacy_attack");
          continue;
        }
        seenLegacyAttackFingerprints.add(`${tag}|${rawFingerprint}`);
        const legacyKeys = legacyIdentityKeysByPlayer.get(tag) ?? new Set<string>();
        if (legacyKeys.has(attack.legacyIdentityKey)) legacyAmbiguousPlayers.add(tag);
        legacyKeys.add(attack.legacyIdentityKey);
        legacyIdentityKeysByPlayer.set(tag, legacyKeys);
      }
      parsed.push(attack);
    }
    for (const [tag, identityKeys] of legacyIdentityKeysByPlayer) {
      if (identityKeys.size > 2) return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["canonical_attack_count_exceeds_limit"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
      if (legacyAmbiguousPlayers.has(tag)) skippedPlayers.add(tag);
    }
    const orderedCounts = new Map<string, number>();
    for (const attack of parsed) {
      if (attack.attackOrder === null) continue;
      const count = (orderedCounts.get(attack.playerTag) ?? 0) + 1;
      if (count > 2) return archiveFailure({ history, lookup, canonical, archivePositivePlayerTags, malformedParticipantCount, unidentifiedParticipantCount, reasons: ["canonical_attack_count_exceeds_limit"], conflict: true, skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size });
      orderedCounts.set(attack.playerTag, count);
    }
    attacks = parsed;
  }

  const reconstructable: ParsedParticipant[] = [];
  for (const participant of byTag.values()) {
    const matchingAttacks = attacks?.filter((attack) => attack.playerTag === participant.playerTag) ?? [];
    if (skippedPlayers.has(participant.playerTag)) {
      if (participant.declaredAttacksUsed !== null && participant.declaredAttacksUsed !== matchingAttacks.length) reasons.push("declared_attack_count_mismatch");
      skippedPlayers.add(participant.playerTag);
      continue;
    }
    if (attacks === null) {
      if (participant.declaredAttacksUsed === 0) reconstructable.push(participant);
      else {
        skippedPlayers.add(participant.playerTag);
        reasons.push(participant.declaredAttacksUsed === null ? "missing_attack_count" : "missing_attack_details");
      }
      continue;
    }
    if (participant.declaredAttacksUsed !== null && participant.declaredAttacksUsed !== matchingAttacks.length) {
      skippedPlayers.add(participant.playerTag);
      reasons.push("declared_attack_count_mismatch");
      continue;
    }
    if (participant.declaredAttacksUsed === null && matchingAttacks.length === 0) {
      skippedPlayers.add(participant.playerTag);
      reasons.push("missing_explicit_zero_attack_evidence");
      continue;
    }
    reconstructable.push(participant);
  }

  return {
    participants: reconstructable,
    attacks,
    skippedPlayers,
    archivePositivePlayerTags,
    malformedParticipantCount,
    unidentifiedParticipantCount,
    skippedUnreconstructableCount: malformedParticipantCount + skippedPlayers.size,
    reasons: [...new Set(reasons)].sort(),
    conflict: false,
    warEndTime: archiveWarEndTime(history, lookup, canonical),
  };
}

/** Purpose: normalize a persisted WarLookup row for canonical identity validation. */
function normalizeLookup(row: any): LookupIdentity | null {
  const warId = normalizeWarId(row?.warId);
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  const startTime = finiteDate(row?.startTime);
  if (!warId || !clanTag || !startTime) return null;
  return { warId, clanTag, opponentTag: row?.opponentTag == null ? null : normalizeMembershipHistoryClanTag(row.opponentTag), startTime, endTime: finiteDate(row?.endTime), payload: row?.payload };
}

/** Purpose: normalize an existing participation row for append-only comparison. */
function normalizeExisting(row: any): ExistingParticipation | null {
  const warId = String(row?.warId ?? "").trim();
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  const playerTag = normalizePlayerTag(row?.playerTag);
  const matchType = comparable(row?.matchType);
  const warStartTime = finiteDate(row?.warStartTime);
  if (!warId || !clanTag || !playerTag || !warStartTime) return null;
  return { ...row, warId, clanTag, playerTag, matchType, warStartTime };
}

/** Purpose: detect identity-bearing differences without treating metric differences as conflicts. */
function structuralMismatch(row: ExistingParticipation, expected: ParticipationRow, history: HistoryIdentity): boolean {
  const existingOpponent = row.opponentTag == null ? null : normalizeMembershipHistoryClanTag(row.opponentTag);
  return row.warId !== String(history.warId) || row.clanTag !== history.clanTag || row.matchType !== "FWA" || row.warStartTime.getTime() !== expected.warStartTime.getTime() || Boolean(existingOpponent && expected.opponentTag && existingOpponent !== normalizeMembershipHistoryClanTag(expected.opponentTag));
}

/** Purpose: determine whether an existing row is safe positive evidence for a canonical history. */
function existingStructurallyCompatible(row: ExistingParticipation, history: HistoryIdentity): boolean {
  const existingOpponent = row.opponentTag == null ? null : normalizeMembershipHistoryClanTag(row.opponentTag);
  return row.warId === String(history.warId) &&
    row.clanTag === history.clanTag &&
    row.matchType === "FWA" &&
    row.warStartTime.getTime() === history.warStartTime!.getTime() &&
    !(existingOpponent && history.opponentTag && existingOpponent !== normalizeMembershipHistoryClanTag(history.opponentTag));
}

/** Purpose: de-duplicate existing participation rows by their persisted unique identity. */
function uniqueRows(rows: ExistingParticipation[]): ExistingParticipation[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.warId}|${row.playerTag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Purpose: classify identity and cardinality reasons that require fail-closed apply behavior. */
function reasonConflict(reason: string): boolean {
  return reason.startsWith("identity_") || reason.startsWith("lookup_") ||
    (reason.startsWith("canonical_") && !["canonical_roster_complete", "canonical_roster_unreconstructable"].includes(reason)) || [
    "conflicting_persisted_identity_sources",
    "persisted_sync_number_disagreement",
    "conflicting_war_identities",
    "conflicting_partial_war_identity_across_sync_buckets",
    "history_maps_to_multiple_guild_sync_owners",
    "contradictory_clan_ownership",
    "missing_sync_cycle",
    "contradictory_duplicate_participant",
    "attack_player_not_in_participants",
    "attack_player_unreconcilable",
    "existing_structural_identity_conflict",
    "same_sync_player_multiple_clans",
    "projected_roster_exceeds_canonical_roster",
    "canonical_roster_contains_extra_existing_player",
    "duplicate_canonical_attack_order",
    "invalid_canonical_attack_order",
    "mixed_canonical_attack_identity",
    "canonical_attack_count_exceeds_limit",
    "invalid_declared_attack_count",
    "ambiguous_canonical_tuple",
  ].includes(reason);
}

/** Purpose: produce stable reason-code ordering for bounded operator output. */
function sortedReasons(reasons: Iterable<string>): string[] {
  return [...new Set(reasons)].sort((left, right) => left.localeCompare(right));
}

export class MembershipHistoryParticipationBackfillService {
  constructor(private readonly db: ParticipationBackfillDb) {}

  /** Purpose: build a dry-run-only plan from canonical persisted owners and archived evidence. */
  async plan(guildIdInput: string, syncFilter: ReadonlySet<number>): Promise<ParticipationBackfillPlan> {
    const guild = guildId(guildIdInput);
    if (!guild) throw new Error("guild ID is required");
    if (!syncFilter || syncFilter.size === 0) throw new Error("an explicit sync filter is required");
    const selectedSyncs = [...syncFilter].filter((value) => Number.isInteger(value) && value > 0).sort((a, b) => a - b);
    if (selectedSyncs.length === 0) throw new Error("sync filter must contain positive sync numbers");

    const [rawPoints, rawEvaluations, rawCycles] = await Promise.all([
      bulkFindMany(selectedSyncs, (batch) => this.db.clanPointsSync.findMany({
        where: { guildId: guild, syncNum: { in: batch } },
        select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true, needsValidation: true },
      })),
      this.db.warPlanComplianceEvaluation.findMany({
        where: { guildId: guild, warHistory: { syncNumber: { in: selectedSyncs } } },
        select: { guildId: true, warId: true, matchType: true, warHistory: { select: { warId: true, syncNumber: true, matchType: true, clanTag: true, warStartTime: true, opponentTag: true, warEndTime: true } } },
      }),
      bulkFindMany(selectedSyncs, (batch) => this.db.syncCycle.findMany({ where: { guildId: guild, syncNumber: { in: batch } }, select: { guildId: true, syncNumber: true, syncTime: true } })),
    ]);
    const selectedRawPoints = uniquePoints(rawPoints.map((row) => pointFromRow(row)).filter((row): row is PointIdentity => Boolean(row)));
    const selectedValidatedPoints = selectedRawPoints.filter((point) => !point.needsValidation);
    const evaluationPoints = uniquePoints(rawEvaluations.map(pointFromComplianceEvaluation).filter((row): row is PointIdentity => Boolean(row)));
    const rawWarIds = [...new Set(selectedValidatedPoints.map((point) => point.rawWarId).filter((value): value is number => value !== null))];
    const allPointRows = await Promise.all([
      ...chunks(selectedSyncs, ID_QUERY_BATCH_SIZE).map((batch) => this.db.clanPointsSync.findMany({
        where: { syncNum: { in: batch } },
        select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true, needsValidation: true },
      })),
      ...chunks(rawWarIds, ID_QUERY_BATCH_SIZE).map((batch) => this.db.clanPointsSync.findMany({
        where: { warId: { in: batch.map(String) } },
        select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true, needsValidation: true },
      })),
    ]).then((rows) => rows.flat());
    const allRawPoints = uniquePoints([...allPointRows.map((row) => pointFromRow(row)).filter((row): row is PointIdentity => Boolean(row)), ...selectedRawPoints]);
    const historiesRaw = await Promise.all([
      ...chunks(selectedSyncs, ID_QUERY_BATCH_SIZE).map((batch) => this.db.clanWarHistory.findMany({
        where: { syncNumber: { in: batch } },
        select: { warId: true, syncNumber: true, matchType: true, clanTag: true, warStartTime: true, opponentTag: true, warEndTime: true },
      })),
      ...chunks(rawWarIds, ID_QUERY_BATCH_SIZE).map((batch) => this.db.clanWarHistory.findMany({
        where: { warId: { in: batch } },
        select: { warId: true, syncNumber: true, matchType: true, clanTag: true, warStartTime: true, opponentTag: true, warEndTime: true },
      })),
    ]).then((rows) => rows.flat());
    const histories = uniqueHistories(historiesRaw.map(historyFromRow).filter((row): row is HistoryIdentity => Boolean(row)));
    const diagnosticReasonsByOwner = new Map<string, Set<string>>();
    const addDiagnosticReason = (point: PointIdentity, reason: string) => {
      const reasons = diagnosticReasonsByOwner.get(ownerKey(point)) ?? new Set<string>();
      reasons.add(reason);
      diagnosticReasonsByOwner.set(ownerKey(point), reasons);
    };
    let pointsCanonicalized = 0;
    let staleRawWarIdsCanonicalized = 0;
    let unmatchedValidatedPoints = 0;
    let ambiguousTuplePoints = 0;
    const canonicalizedPointEvidence: PointIdentity[] = [];
    const nonFwaOperationalOwners = new Set<string>();
    for (const point of allRawPoints) {
      if (point.needsValidation) continue;
      const result = canonicalizePoint(point, histories);
      if (!result.point) {
        if (result.matchCount === 0) {
          if (point.isFwa) {
            unmatchedValidatedPoints += 1;
            addDiagnosticReason(point, "unmatched_validated_point");
          } else {
            nonFwaOperationalOwners.add(ownerKey(point));
          }
        } else {
          ambiguousTuplePoints += 1;
          addDiagnosticReason(point, "ambiguous_canonical_tuple");
        }
        continue;
      }
      pointsCanonicalized += 1;
      if (result.staleRawWarId) {
        staleRawWarIdsCanonicalized += 1;
        addDiagnosticReason(result.point, "stale_raw_war_id_canonicalized");
      }
      if (!point.isFwa) addDiagnosticReason(result.point, "raw_non_fwa_canonicalized_to_fwa");
      canonicalizedPointEvidence.push(result.point);
    }
    const targetPoints = uniquePoints([...canonicalizedPointEvidence.filter((point) => selectedSyncs.includes(point.syncNumber)), ...evaluationPoints]);
    const crossOwnerEvaluations = histories.length > 0
      ? await bulkFindMany([...new Set(histories.map((history) => history.warId))], (batch) => this.db.warPlanComplianceEvaluation.findMany({
          where: { warId: { in: batch } },
          select: { guildId: true, warId: true, matchType: true, warHistory: { select: { warId: true, syncNumber: true, matchType: true, clanTag: true, warStartTime: true, opponentTag: true, warEndTime: true } } },
        }))
      : [];
    const allEvaluations = [...rawEvaluations, ...crossOwnerEvaluations];
    const allEvaluationPoints = uniquePoints(allEvaluations.map(pointFromComplianceEvaluation).filter((row): row is PointIdentity => Boolean(row)));
    const identityPoints = uniquePoints([...canonicalizedPointEvidence, ...allEvaluationPoints]);
    const validatedPointsConsidered = allRawPoints.filter((point) => !point.needsValidation).length;
    const dirtyPointsIgnored = allRawPoints.filter((point) => point.needsValidation).length;
    const cycles = rawCycles.map((row): CycleIdentity | null => {
      const syncNumber = positiveInteger(row?.syncNumber);
      const syncTime = finiteDate(row?.syncTime);
      return syncNumber && syncTime ? { syncNumber, syncTime } : null;
    }).filter((row): row is CycleIdentity => Boolean(row));
    const cycleBySync = new Map(cycles.map((cycle) => [cycle.syncNumber, cycle]));
    const canonicalHistoriesByOwner = new Map<string, HistoryIdentity[]>();
    for (const point of targetPoints) {
      if (!point.isFwa) continue;
      const matches = histories.filter((history) => history.warId === point.warId && history.syncNumber === point.syncNumber && historicalHistoryMatchesPointByExactTuple(history, point));
      const rows = canonicalHistoriesByOwner.get(ownerKey(point)) ?? [];
      rows.push(...matches);
      canonicalHistoriesByOwner.set(ownerKey(point), rows);
    }
    for (const [key, rows] of canonicalHistoriesByOwner) canonicalHistoriesByOwner.set(key, uniqueHistories(rows));
    const ownersByHistory = new Map<string, Set<string>>();
    for (const point of identityPoints) {
      if (!point.isFwa) continue;
      for (const history of histories) {
        if (history.warId !== point.warId || history.syncNumber !== point.syncNumber || !historicalHistoryMatchesPointByExactTuple(history, point)) continue;
        const owners = ownersByHistory.get(membershipCanonicalHistoryKey(history)) ?? new Set<string>();
        owners.add(ownerKey(point));
        ownersByHistory.set(membershipCanonicalHistoryKey(history), owners);
      }
    }
    const tupleConflictReasonsByOwner = canonicalTupleConflictOwners(identityPoints.filter((point) => cycleBySync.has(point.syncNumber)), histories);
    const canonicalWarClanConflictReasonsByOwner = canonicalWarClanConflictOwners(identityPoints, histories);
    const conflictingPersistedOwnerKeys = membershipHistoryConflictingPersistedOwnerKeys(identityPoints);
    const historiesForLookup = [...new Map([...canonicalHistoriesByOwner.values()].flat().map((history) => [history.warId, history])).values()];
    const lookups = (await bulkFindMany(historiesForLookup.map((history) => String(history.warId)), (batch) => this.db.warLookup.findMany({ where: { warId: { in: batch } }, select: { warId: true, clanTag: true, opponentTag: true, startTime: true, endTime: true, payload: true } })))
      .map(normalizeLookup).filter((row): row is LookupIdentity => Boolean(row));
    const lookupByWarId = new Map<number, LookupIdentity>();
    for (const lookup of lookups) {
      if (!lookupByWarId.has(lookup.warId)) lookupByWarId.set(lookup.warId, lookup);
    }
    const participationWarIds = [...new Set(historiesForLookup.map((history) => String(history.warId)))];
    const existingRows = (await bulkFindMany(participationWarIds, (batch) => this.db.clanWarParticipation.findMany({
      where: { guildId: guild, warId: { in: batch } },
      select: { guildId: true, warId: true, clanTag: true, opponentTag: true, playerTag: true, playerName: true, playerPosition: true, matchType: true, warStartTime: true },
    }))).map(normalizeExisting).filter((row): row is ExistingParticipation => Boolean(row));
    const existingByWar = new Map<number, ExistingParticipation[]>();
    for (const row of existingRows) {
      const warId = normalizeWarId(row.warId);
      if (!warId) continue;
      const rows = existingByWar.get(warId) ?? [];
      rows.push(row);
      existingByWar.set(warId, rows);
    }

    const reports: ParticipationBackfillWarReport[] = [];
    for (const syncNumber of selectedSyncs) {
      const owner = `${guild}|${syncNumber}`;
      const ownerPoints = targetPoints.filter((point) => ownerKey(point) === owner);
      const ownerHistories = canonicalHistoriesByOwner.get(owner) ?? [];
      if (!cycleBySync.has(syncNumber)) {
        reports.push(this.skipReport(guild, syncNumber, null, null, ["missing_sync_cycle"]));
        continue;
      }
      const reasons = new Set<string>();
      for (const reason of diagnosticReasonsByOwner.get(owner) ?? []) reasons.add(reason);
      for (const reason of tupleConflictReasonsByOwner.get(owner) ?? []) reasons.add(reason);
      for (const reason of canonicalWarClanConflictReasonsByOwner.get(owner) ?? []) reasons.add(reason);
      if (ownerPoints.length === 0) reasons.add("no_guild_owned_historical_identity");
      if (ownerHistories.length === 0 && nonFwaOperationalOwners.has(owner)) reasons.add("non_fwa_cycle");
      for (const point of ownerPoints) {
        if (!point.isFwa) continue;
        if (hasMembershipHistorySyncNumberDisagreement(point, histories)) reasons.add("persisted_sync_number_disagreement");
        if (hasMembershipHistoryIdentityConflict(point, identityPoints)) reasons.add("conflicting_war_identities");
        if (hasMembershipHistoryPartialIdentityConflict(point, identityPoints)) reasons.add("conflicting_partial_war_identity_across_sync_buckets");
        if (point.warId !== null && conflictingPersistedOwnerKeys.has(`${normalizeMembershipHistoryClanTag(point.clanTag)}|${point.warId}`)) reasons.add("conflicting_persisted_identity_sources");
      }
      for (const history of ownerHistories) {
        if ((ownersByHistory.get(membershipCanonicalHistoryKey(history))?.size ?? 0) > 1) reasons.add("history_maps_to_multiple_guild_sync_owners");
      }
      const historiesByClan = new Map<string, HistoryIdentity[]>();
      for (const history of ownerHistories) {
        const rows = historiesByClan.get(history.clanTag) ?? [];
        rows.push(history);
        historiesByClan.set(history.clanTag, rows);
      }
      if ([...historiesByClan.values()].some((rows) => new Set(rows.map((row) => row.warId)).size > 1)) reasons.add("conflicting_war_identities");
      const ownerClanTags = new Set(ownerPoints.filter((point) => point.isFwa).map((point) => point.clanTag));
      for (const clanTag of ownerClanTags) {
        const sameSyncClanHistories = histories.filter((history) => history.syncNumber === syncNumber && history.clanTag === clanTag);
        if (new Set(sameSyncClanHistories.map((history) => history.warId)).size > 1) reasons.add("conflicting_war_identities");
      }
      if (ownerHistories.length === 0 && reasons.size === 0) reasons.add("no_canonical_history");
      if (reasons.size > 0 && [...reasons].some(reasonConflict)) {
        for (const history of ownerHistories) reports.push(this.skipReport(guild, syncNumber, history.clanTag, history.warId, sortedReasons(reasons), "CONFLICT"));
        if (ownerHistories.length === 0) reports.push(this.skipReport(guild, syncNumber, null, null, sortedReasons(reasons), "CONFLICT"));
        continue;
      }
      if (ownerHistories.length === 0) {
        reports.push(this.skipReport(guild, syncNumber, null, null, sortedReasons(reasons.size > 0 ? reasons : ["no_canonical_history"])));
        continue;
      }
      for (const history of ownerHistories) reports.push(this.buildWarReport({ guild, syncNumber, history, lookup: lookupByWarId.get(history.warId) ?? null, existingRows: existingByWar.get(history.warId) ?? [], baseReasons: reasons }));
    }

    const playerClanBySync = new Map<string, Set<string>>();
    for (const report of reports) {
      for (const playerTag of report.candidatePlayerTags ?? report.plannedRows.map((row) => row.playerTag)) {
        const key = `${report.syncNumber}|${playerTag}`;
        const clans = playerClanBySync.get(key) ?? new Set<string>();
        clans.add(report.clanTag ?? "");
        playerClanBySync.set(key, clans);
      }
    }
    for (const report of reports) {
      const affected = (report.candidatePlayerTags ?? report.plannedRows.map((row) => row.playerTag)).some((playerTag) => (playerClanBySync.get(`${report.syncNumber}|${playerTag}`)?.size ?? 0) > 1);
      if (!affected) continue;
      report.action = "CONFLICT";
      report.reasons = sortedReasons([...report.reasons, "same_sync_player_multiple_clans"]);
      report.plannedRows = [];
      report.plannedInsertCount = 0;
    }
    const rowsPlanned = reports.reduce((sum, report) => sum + report.plannedInsertCount, 0);
    const rowsUnreconstructable = reports.reduce((sum, report) => sum + report.skippedUnreconstructableCount, 0);
    const summary = {
      selectedSyncs: selectedSyncs.length,
      existingSyncCycles: cycles.length,
      candidateCanonicalFwaWars: reports.filter((report) => report.canonicalWarId !== null).length,
      validatedPointsConsidered,
      dirtyPointsIgnored,
      pointsCanonicalized,
      staleRawWarIdsCanonicalized,
      unmatchedValidatedPoints,
      ambiguousTuplePoints,
      alreadyCompleteNoOpWars: reports.filter((report) => report.action === "ALREADY_PRESENT").length,
      warsWithPlannedInserts: reports.filter((report) => report.action === "INSERT_MISSING").length,
      rowsPlanned,
      rowsUnreconstructable,
      completeProjectedRosters: reports.filter((report) => report.projectedCoverage === "COMPLETE").length,
      partialProjectedRosters: reports.filter((report) => report.projectedCoverage === "PARTIAL").length,
      unknownProjectedRosters: reports.filter((report) => report.projectedCoverage === "UNKNOWN").length,
      skippedWars: reports.filter((report) => report.action === "SKIP").length,
      conflicts: reports.filter((report) => report.action === "CONFLICT").length,
    };
    return { guildId: guild, selectedSyncs, existingSyncCycles: cycles.length, candidateCanonicalFwaWars: summary.candidateCanonicalFwaWars, reports, rowsPlanned, rowsUnreconstructable, summary };
  }

  /** Purpose: apply only deterministic missing rows in bounded idempotent batches. */
  async apply(plan: ParticipationBackfillPlan): Promise<ParticipationBackfillApplyResult> {
    if (plan.summary.conflicts > 0) throw new Error("Apply aborted before writes because the selected plan contains conflicts.");
    const rows = plan.reports.flatMap((report) => report.plannedRows);
    let batches = 0;
    let rowsReportedCreated = 0;
    for (const batch of chunks(rows, PARTICIPATION_CREATE_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      batches += 1;
      const result = await this.db.clanWarParticipation.createMany({ data: batch, skipDuplicates: true });
      rowsReportedCreated += Number(result?.count ?? 0);
    }
    const expectedByWar = new Map<string, { clanTag: string; expectedProjectedDistinctCount: number }>();
    for (const report of plan.reports) {
      if (report.plannedInsertCount <= 0 || report.canonicalWarId === null) continue;
      expectedByWar.set(String(report.canonicalWarId), {
        clanTag: report.clanTag ?? "",
        expectedProjectedDistinctCount: report.projectedDistinctParticipationCount,
      });
    }
    const warIds = [...expectedByWar.keys()];
    const verifiedRows = await bulkFindMany(warIds, (batch) => this.db.clanWarParticipation.findMany({ where: { guildId: plan.guildId, warId: { in: batch } }, select: { guildId: true, warId: true, clanTag: true, playerTag: true } }));
    const observedByWar = new Map<string, Set<string>>();
    for (const row of verifiedRows) {
      const warId = String(row?.warId ?? "");
      const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
      const playerTag = normalizePlayerTag(row?.playerTag);
      if (!warId || !clanTag || !playerTag) continue;
      const identities = observedByWar.get(warId) ?? new Set<string>();
      identities.add(`${warId}|${clanTag}|${playerTag}`);
      observedByWar.set(warId, identities);
    }
    const verifiedWars = [...expectedByWar.entries()].map(([warId, expected]) => {
      const observedDistinctCount = observedByWar.get(warId)?.size ?? 0;
      return {
        warId,
        clanTag: expected.clanTag,
        expectedProjectedDistinctCount: expected.expectedProjectedDistinctCount,
        observedDistinctCount,
        matches: observedDistinctCount === expected.expectedProjectedDistinctCount,
      };
    });
    const mismatchedWars = verifiedWars.filter((war) => !war.matches);
    return { batches, rowsAttempted: rows.length, rowsReportedCreated, verifiedWars, mismatchedWars, verificationSuccessful: mismatchedWars.length === 0 };
  }

  /** Purpose: build a bounded report for evidence that cannot produce a full archive reconstruction. */
  private skipReport(
    guild: string,
    syncNumber: number,
    clanTag: string | null,
    warId: number | null,
    reasons: string[],
    action: ParticipationBackfillAction = "SKIP",
    overrides: Partial<ParticipationBackfillWarReport> = {},
  ): ParticipationBackfillWarReport {
    return {
      guildId: guild,
      syncNumber,
      clanTag,
      canonicalWarId: warId,
      action,
      archiveParticipantCount: 0,
      archivePositivePlayerCount: 0,
      reconstructableCount: 0,
      existingCount: 0,
      existingPositivePlayerCount: 0,
      plannedInsertCount: 0,
      skippedUnreconstructableCount: 0,
      malformedParticipantCount: 0,
      unidentifiedParticipantCount: 0,
      expectedTeamSize: null,
      projectedDistinctParticipationCount: 0,
      projectedCoverage: "UNKNOWN",
      reasons: sortedReasons(reasons),
      plannedRows: [],
      candidatePlayerTags: [],
      ...overrides,
    };
  }

  /** Purpose: turn one safely matched canonical history into an append-only plan report. */
  private buildWarReport(input: { guild: string; syncNumber: number; history: HistoryIdentity; lookup: LookupIdentity | null; existingRows: ExistingParticipation[]; baseReasons: Set<string> }): ParticipationBackfillWarReport {
    const { guild, syncNumber, history, lookup } = input;
    const reasons = new Set(input.baseReasons);
    const existing = uniqueRows(input.existingRows);
    const compatibleExisting = existing.filter((row) => existingStructurallyCompatible(row, history));
    const existingPositivePlayerTags = new Set(compatibleExisting.map((row) => row.playerTag));
    const existingOverrides = {
      existingCount: compatibleExisting.length,
      existingPositivePlayerCount: existingPositivePlayerTags.size,
      candidatePlayerTags: [...existingPositivePlayerTags].sort(),
    };
    if (existing.some((row) => !existingStructurallyCompatible(row, history))) reasons.add("existing_structural_identity_conflict");
    if (!lookup) {
      return this.skipReport(guild, syncNumber, history.clanTag, history.warId, ["missing_war_lookup", ...reasons], reasons.has("existing_structural_identity_conflict") ? "CONFLICT" : "SKIP", existingOverrides);
    }
    const lookupReasons = validateLookup(history, lookup);
    for (const reason of lookupReasons) reasons.add(reason);
    if (lookupReasons.length > 0) return this.skipReport(guild, syncNumber, history.clanTag, history.warId, [...reasons], "CONFLICT", existingOverrides);
    const archive = parseArchive(history, lookup);
    for (const reason of archive.reasons) reasons.add(reason);
    const canonical = objectRecord(lookup.payload)?.canonical;
    const archiveParticipantCount = canonical && Array.isArray(canonical.participants) ? (canonical.participants as unknown[]).length : 0;
    const archivePositivePlayerTags = archive.archivePositivePlayerTags;
    const knownPositivePlayerTags = new Set([...archivePositivePlayerTags, ...existingPositivePlayerTags]);
    const canonicalParticipantsPresent = Boolean(canonical && Array.isArray(canonical.participants));
    const baseArchiveOverrides = {
      archiveParticipantCount,
      archivePositivePlayerCount: archivePositivePlayerTags.size,
      existingCount: compatibleExisting.length,
      existingPositivePlayerCount: existingPositivePlayerTags.size,
      skippedUnreconstructableCount: archive.skippedUnreconstructableCount,
      malformedParticipantCount: archive.malformedParticipantCount,
      unidentifiedParticipantCount: archive.unidentifiedParticipantCount,
      expectedTeamSize: null,
      candidatePlayerTags: [...knownPositivePlayerTags].sort(),
    };
    if (archive.conflict) return this.skipReport(guild, syncNumber, history.clanTag, history.warId, [...reasons], "CONFLICT", baseArchiveOverrides);
    const canonicalRosterComplete = canonicalParticipantsPresent &&
      archive.malformedParticipantCount === 0 &&
      archive.unidentifiedParticipantCount === 0 &&
      archive.skippedPlayers.size === 0 &&
      archive.participants.length === archivePositivePlayerTags.size;
    if (!canonicalRosterComplete) {
      if (canonicalParticipantsPresent) reasons.add("canonical_roster_unreconstructable");
      const projectedDistinctParticipationCount = existingPositivePlayerTags.size;
      const incompleteArchiveHasConflict = [...reasons].some(reasonConflict);
      const incompleteArchiveAction: ParticipationBackfillAction = incompleteArchiveHasConflict
        ? "CONFLICT"
        : !canonicalParticipantsPresent && compatibleExisting.length > 0
          ? "ALREADY_PRESENT"
          : "SKIP";
      return this.skipReport(
        guild,
        syncNumber,
        history.clanTag,
        history.warId,
        [...reasons],
        incompleteArchiveAction,
        {
          ...baseArchiveOverrides,
          reconstructableCount: archive.participants.length,
          projectedDistinctParticipationCount,
          projectedCoverage: "UNKNOWN",
        },
      );
    }
    const expectedRosterCount = archivePositivePlayerTags.size;
    reasons.add("canonical_roster_complete");
    if ([...existingPositivePlayerTags].some((playerTag) => !archivePositivePlayerTags.has(playerTag))) {
      reasons.add("canonical_roster_contains_extra_existing_player");
    }
    const participantRows: ParticipationParticipantInput[] = archive.participants.map((participant) => ({ playerTag: participant.playerTag, playerName: participant.playerName, playerPosition: participant.playerPosition }));
    const reconstructed = buildParticipationRows({ guildId: guild, warId: String(history.warId), clanTag: history.clanTag, opponentTag: history.opponentTag ?? null, warStartTime: history.warStartTime!, warEndTime: archive.warEndTime, matchType: "FWA", participantRows, attackRows: archive.attacks ?? [] });
    const plannedRows: ParticipationRow[] = [];
    for (const row of reconstructed) {
      const current = existing.find((candidate) => candidate.playerTag === row.playerTag);
      if (!current) plannedRows.push(row);
      else if (structuralMismatch(current, row, history)) reasons.add("existing_structural_identity_conflict");
    }
    const projectedTags = new Set([...existingPositivePlayerTags, ...plannedRows.map((row) => row.playerTag)]);
    const projectedCount = projectedTags.size;
    if (knownPositivePlayerTags.size > expectedRosterCount) reasons.add("projected_roster_exceeds_canonical_roster");
    if (projectedCount > expectedRosterCount) reasons.add("projected_roster_exceeds_canonical_roster");
    const conflict = [...reasons].some(reasonConflict);
    const projectedCoverage: ProjectedRosterCoverage = projectedCount === expectedRosterCount && knownPositivePlayerTags.size <= expectedRosterCount
      ? "COMPLETE"
      : "PARTIAL";
    const action: ParticipationBackfillAction = conflict ? "CONFLICT" : plannedRows.length > 0 ? "INSERT_MISSING" : reconstructed.length === 0 && compatibleExisting.length === 0 ? "SKIP" : "ALREADY_PRESENT";
    return {
      guildId: guild,
      syncNumber,
      clanTag: history.clanTag,
      canonicalWarId: history.warId,
      action,
      archiveParticipantCount,
      archivePositivePlayerCount: archivePositivePlayerTags.size,
      reconstructableCount: reconstructed.length,
      existingCount: compatibleExisting.length,
      existingPositivePlayerCount: existingPositivePlayerTags.size,
      plannedInsertCount: conflict ? 0 : plannedRows.length,
      skippedUnreconstructableCount: archive.skippedUnreconstructableCount,
      malformedParticipantCount: archive.malformedParticipantCount,
      unidentifiedParticipantCount: archive.unidentifiedParticipantCount,
      expectedTeamSize: expectedRosterCount,
      projectedDistinctParticipationCount: projectedCount,
      projectedCoverage,
      reasons: sortedReasons(reasons),
      plannedRows: conflict ? [] : plannedRows,
      candidatePlayerTags: [...knownPositivePlayerTags].sort(),
    };
  }
}
