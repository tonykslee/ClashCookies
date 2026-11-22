import { createHash } from "node:crypto";
import type { FwaWarMemberFeedRow } from "./types";
import {
  normalizeFwaTag,
  normalizeText,
  stableHashValue,
  toFloatOrNull,
  toIntOrNull,
} from "./normalize";

/** Purpose: version the facts that a WarMembers payload is allowed to establish. */
export const FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION = "war-members-source-v2";

export type FwaWarMembersEvidenceStatus = "VERIFIED" | "UNAVAILABLE" | "CONFLICTING";
export type FwaWarMembersParserStatus = "ACCEPTED" | "REJECTED";
export type FwaWarMembersEvidenceEligibilityStatus = "ELIGIBLE" | "INELIGIBLE";

export type FwaWarMembersEvidenceReasonCode =
  | "payload_not_array"
  | "malformed_row"
  | "parser_rejected"
  | "discarded_row"
  | "evidence_ineligible"
  | "missing_player_identity"
  | "invalid_position"
  | "invalid_weight"
  | "duplicate_player_identity"
  | "duplicate_position"
  | "missing_declared_roster_size"
  | "roster_size_mismatch"
  | "position_coverage_incomplete"
  | "missing_declared_total_weight"
  | "total_weight_mismatch"
  | "opponent_identity_conflict"
  | "accepted_rows_mismatch"
  | "row_correspondence_inconsistent"
  | "exact_war_binding_unavailable"
  | "source_generation_unbound"
  | "source_timestamp_invalid"
  | "source_timestamp_inconsistent";

export type FwaWarMembersRowEvaluation = {
  index: number;
  rawRowFingerprint: string;
  parserStatus: FwaWarMembersParserStatus;
  parserReasonCodes: readonly FwaWarMembersEvidenceReasonCode[];
  evidenceStatus: FwaWarMembersEvidenceEligibilityStatus;
  evidenceReasonCodes: readonly FwaWarMembersEvidenceReasonCode[];
  normalizedRowFingerprint: string | null;
  normalizedPlayerTag: string | null;
  normalizedPosition: number | null;
  normalizedWeight: number | null;
};

export type FwaWarMembersSourceEvidence = {
  contractVersion: string;
  sourceUrl: string;
  sourceWarNo: number;
  clanTag: string;
  observedAt: string;
  ingestedAt: string;
  rawPayloadIsArray: boolean;
  rawRowCount: number;
  parserAcceptedRowCount: number;
  parserRejectedRowCount: number;
  acceptedRowCount: number;
  discardedRowCount: number;
  evidenceEligibleRowCount: number;
  evidenceIneligibleRowCount: number;
  parserRejectedRowIndexes: readonly number[];
  discardedRowIndexes: readonly number[];
  evidenceIneligibleRowIndexes: readonly number[];
  rowEvaluations: readonly FwaWarMembersRowEvaluation[];
  rawPayloadFingerprint: string;
  acceptedRowsFingerprint: string;
  declaredRosterSize: number | null;
  declaredTotalWeight: number | null;
  observedOpponentTags: readonly string[];
  structuralStatus: FwaWarMembersEvidenceStatus;
  completenessStatus: FwaWarMembersEvidenceStatus;
  weightStatus: FwaWarMembersEvidenceStatus;
  exactWarBindingStatus: FwaWarMembersEvidenceStatus;
  sourceGenerationStatus: FwaWarMembersEvidenceStatus;
  candidateEligibilityStatus: FwaWarMembersEvidenceStatus;
  reasonCodes: readonly FwaWarMembersEvidenceReasonCode[];
  contentFingerprint: string;
};

export type FwaWarMembersParserResult = {
  row: FwaWarMemberFeedRow | null;
  reasonCodes: readonly FwaWarMembersEvidenceReasonCode[];
};

export type FwaWarMembersSourceEvidenceInput = {
  clanTag: string;
  sourceUrl: string;
  sourceWarNo: number;
  rawPayloadIsArray: boolean;
  rawRows: readonly unknown[];
  /** Compatibility assertion only; evidence is always derived from rawRows. */
  acceptedRows?: readonly FwaWarMemberFeedRow[];
  observedAt: Date;
  ingestedAt: Date;
  declaredRosterSize?: number | null;
  declaredTotalWeight?: number | null;
};

type RawRowCheck = {
  parserReasonCodes: FwaWarMembersEvidenceReasonCode[];
  evidenceReasonCodes: FwaWarMembersEvidenceReasonCode[];
  normalizedPlayerTag: string | null;
  normalizedPosition: number | null;
  normalizedWeight: number | null;
};

const ALL_REASON_CODES = new Set<FwaWarMembersEvidenceReasonCode>([
  "payload_not_array", "malformed_row", "parser_rejected", "discarded_row", "evidence_ineligible",
  "missing_player_identity", "invalid_position", "invalid_weight", "duplicate_player_identity",
  "duplicate_position", "missing_declared_roster_size", "roster_size_mismatch", "position_coverage_incomplete",
  "missing_declared_total_weight", "total_weight_mismatch", "opponent_identity_conflict", "accepted_rows_mismatch",
  "row_correspondence_inconsistent", "exact_war_binding_unavailable", "source_generation_unbound",
  "source_timestamp_invalid", "source_timestamp_inconsistent",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strictIntegerOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.trim().replace(/,/g, ""));
  return Number.isInteger(parsed) ? parsed : null;
}

function isStrictPositiveInteger(value: unknown): boolean {
  const parsed = strictIntegerOrNull(value);
  return parsed !== null && parsed > 0;
}

function strictPositionOrNull(value: unknown): number | null {
  const parsed = strictIntegerOrNull(value);
  return parsed !== null && parsed >= 1 && parsed <= 50 ? parsed : null;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableHashValue(value)))
    .digest("hex");
}

function canonicalFingerprintList(values: readonly string[]): string {
  return fingerprint([...values].sort());
}

function contentFingerprintForEvidence(payload: Omit<FwaWarMembersSourceEvidence, "contentFingerprint">): string {
  const {
    parserRejectedRowIndexes: _parserRejectedRowIndexes,
    discardedRowIndexes: _discardedRowIndexes,
    evidenceIneligibleRowIndexes: _evidenceIneligibleRowIndexes,
    rowEvaluations,
    ...orderIndependentPayload
  } = payload;
  const orderIndependentRows = rowEvaluations
    .map(({ index: _index, ...row }) => row)
    .sort((left, right) => left.rawRowFingerprint.localeCompare(right.rawRowFingerprint));
  return fingerprint({ ...orderIndependentPayload, rowEvaluations: orderIndependentRows });
}

function isoOrNull(value: Date): string | null {
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Purpose: share the ordinary WarMembers parser with the evidence evaluator. */
export function parseFwaWarMembersRow(input: unknown, clanTag: string): FwaWarMembersParserResult {
  if (!isRecord(input)) return { row: null, reasonCodes: ["malformed_row"] };
  const playerTag = normalizeFwaTag(String(input.tag ?? ""));
  const playerName = normalizeText(input.name);
  if (!playerTag || !playerName) return { row: null, reasonCodes: ["missing_player_identity"] };
  return {
    row: {
      clanTag,
      playerTag,
      playerName,
      position: toIntOrNull(input.position),
      townHall: toIntOrNull(input.townHall),
      weight: toIntOrNull(input.weight),
      opponentTag: normalizeText(input.opponentTag) ? normalizeFwaTag(String(input.opponentTag)) : null,
      opponentName: normalizeText(input.opponentName),
      attacks: toIntOrNull(input.attacks),
      defender1Tag: normalizeText(input.defender1Tag) ? normalizeFwaTag(String(input.defender1Tag)) : null,
      defender1Name: normalizeText(input.defender1Name),
      defender1TownHall: toIntOrNull(input.defender1TownHall),
      defender1Position: toIntOrNull(input.defender1Position),
      stars1: toIntOrNull(input.stars1),
      destructionPercentage1: toFloatOrNull(input.destructionPercentage1),
      defender2Tag: normalizeText(input.defender2Tag) ? normalizeFwaTag(String(input.defender2Tag)) : null,
      defender2Name: normalizeText(input.defender2Name),
      defender2TownHall: toIntOrNull(input.defender2TownHall),
      defender2Position: toIntOrNull(input.defender2Position),
      stars2: toIntOrNull(input.stars2),
      destructionPercentage2: toFloatOrNull(input.destructionPercentage2),
    },
    reasonCodes: [],
  };
}

function inspectRawRow(input: unknown): RawRowCheck {
  if (!isRecord(input)) {
    return { parserReasonCodes: ["malformed_row"], evidenceReasonCodes: ["malformed_row"], normalizedPlayerTag: null, normalizedPosition: null, normalizedWeight: null };
  }
  const parserReasonCodes: FwaWarMembersEvidenceReasonCode[] = [];
  const evidenceReasonCodes: FwaWarMembersEvidenceReasonCode[] = [];
  const normalizedPlayerTag = normalizeFwaTag(String(input.tag ?? ""));
  const normalizedPosition = strictPositionOrNull(input.position);
  const normalizedWeight = isStrictPositiveInteger(input.weight) ? strictIntegerOrNull(input.weight) : null;
  if (!normalizedPlayerTag || !normalizeText(input.name)) {
    parserReasonCodes.push("missing_player_identity");
    evidenceReasonCodes.push("missing_player_identity");
  }
  if (normalizedPosition === null) evidenceReasonCodes.push("invalid_position");
  if (normalizedWeight === null) evidenceReasonCodes.push("invalid_weight");
  return { parserReasonCodes, evidenceReasonCodes, normalizedPlayerTag, normalizedPosition, normalizedWeight };
}

function sameRowsAsDerived(supplied: readonly FwaWarMemberFeedRow[] | undefined, derived: readonly FwaWarMemberFeedRow[]): boolean {
  if (supplied === undefined) return true;
  const suppliedFingerprints = supplied.map((row) => fingerprint(row));
  const derivedFingerprints = derived.map((row) => fingerprint(row));
  return suppliedFingerprints.length === derivedFingerprints.length && canonicalFingerprintList(suppliedFingerprints) === canonicalFingerprintList(derivedFingerprints);
}

/**
 * Purpose: evaluate every raw row through the same parser used by factual feed
 * consumers. Accepted-row projections are checked only as compatibility
 * assertions; they never establish evidence independently.
 */
export function evaluateFwaWarMembersSourceEvidence(input: FwaWarMembersSourceEvidenceInput): FwaWarMembersSourceEvidence {
  const reasonSet = new Set<FwaWarMembersEvidenceReasonCode>();
  const parsed = input.rawRows.map((rawRow, index) => {
    const parserResult = parseFwaWarMembersRow(rawRow, normalizeFwaTag(input.clanTag));
    const rawCheck = inspectRawRow(rawRow);
    const evidenceReasons = [...rawCheck.evidenceReasonCodes];
    if (!parserResult.row) evidenceReasons.push("parser_rejected");
    else if (
      parserResult.row.position !== rawCheck.normalizedPosition ||
      parserResult.row.weight !== rawCheck.normalizedWeight ||
      parserResult.row.playerTag !== rawCheck.normalizedPlayerTag
    ) evidenceReasons.push("row_correspondence_inconsistent");
    return { index, rawRow, row: parserResult.row, parserReasonCodes: parserResult.reasonCodes, evidenceReasonCodes: evidenceReasons };
  });
  const derivedAcceptedRows = parsed.flatMap((entry) => entry.row ? [entry.row] : []);
  if (!sameRowsAsDerived(input.acceptedRows, derivedAcceptedRows)) reasonSet.add("accepted_rows_mismatch");
  if (!input.rawPayloadIsArray) reasonSet.add("payload_not_array");

  const playerGroups = new Map<string, number[]>();
  const positionGroups = new Map<number, number[]>();
  for (const entry of parsed) {
    if (!entry.row) continue;
    const players = playerGroups.get(entry.row.playerTag) ?? [];
    players.push(entry.index);
    playerGroups.set(entry.row.playerTag, players);
    if (entry.row.position !== null) {
      const positions = positionGroups.get(entry.row.position) ?? [];
      positions.push(entry.index);
      positionGroups.set(entry.row.position, positions);
    }
  }
  for (const indexes of playerGroups.values()) {
    if (indexes.length < 2) continue;
    reasonSet.add("duplicate_player_identity");
    for (const index of indexes) parsed[index]!.evidenceReasonCodes.push("duplicate_player_identity");
  }
  for (const indexes of positionGroups.values()) {
    if (indexes.length < 2) continue;
    reasonSet.add("duplicate_position");
    for (const index of indexes) parsed[index]!.evidenceReasonCodes.push("duplicate_position");
  }

  const observedOpponentTags = [...new Set(derivedAcceptedRows.map((row) => row.opponentTag).filter((tag): tag is string => Boolean(tag)).sort())];
  if (observedOpponentTags.length > 1) {
    reasonSet.add("opponent_identity_conflict");
    for (const entry of parsed) if (entry.row?.opponentTag) entry.evidenceReasonCodes.push("opponent_identity_conflict");
  }

  const parserRejectedRowIndexes = parsed.filter((entry) => !entry.row).map((entry) => entry.index);
  const parserAcceptedRowCount = derivedAcceptedRows.length;
  const parserRejectedRowCount = parserRejectedRowIndexes.length;
  if (parserRejectedRowCount > 0) {
    reasonSet.add("parser_rejected");
    reasonSet.add("discarded_row");
  }
  const declaredRosterSize = input.declaredRosterSize ?? null;
  if (!Number.isInteger(declaredRosterSize) || (declaredRosterSize as number) <= 0) {
    reasonSet.add("missing_declared_roster_size");
  } else {
    const positions = derivedAcceptedRows.map((row) => row.position);
    if (input.rawRows.length !== declaredRosterSize || parserAcceptedRowCount !== declaredRosterSize || parserRejectedRowCount > 0) reasonSet.add("roster_size_mismatch");
    if (positions.length !== declaredRosterSize || positions.some((position) => position === null || position < 1 || position > declaredRosterSize) || new Set(positions).size !== declaredRosterSize) reasonSet.add("position_coverage_incomplete");
  }

  const declaredTotalWeight = input.declaredTotalWeight ?? null;
  const observedTotalWeight = derivedAcceptedRows.reduce((sum, row) => sum + (row.weight ?? 0), 0);
  if (!Number.isInteger(declaredTotalWeight) || (declaredTotalWeight as number) <= 0) reasonSet.add("missing_declared_total_weight");
  else if (declaredTotalWeight !== observedTotalWeight) reasonSet.add("total_weight_mismatch");

  const observedAt = isoOrNull(input.observedAt);
  const ingestedAt = isoOrNull(input.ingestedAt);
  if (!observedAt || !ingestedAt) reasonSet.add("source_timestamp_invalid");
  else if (input.observedAt.getTime() > input.ingestedAt.getTime()) reasonSet.add("source_timestamp_inconsistent");

  // No current FWAStats contract proves that warNo=1 identifies one exact FWA
  // war or that a source batch can be replay-detected across process restarts.
  reasonSet.add("exact_war_binding_unavailable");
  reasonSet.add("source_generation_unbound");

  for (const entry of parsed) {
    entry.evidenceReasonCodes = [...new Set(entry.evidenceReasonCodes)].sort();
    for (const reason of entry.evidenceReasonCodes) if (reason !== "parser_rejected" && reason !== "discarded_row") reasonSet.add(reason);
    if (entry.evidenceReasonCodes.length > 0) reasonSet.add("evidence_ineligible");
  }
  const evidenceIneligibleRowIndexes = parsed.filter((entry) => entry.evidenceReasonCodes.length > 0).map((entry) => entry.index);
  const rowEvaluations: FwaWarMembersRowEvaluation[] = parsed.map((entry) => ({
    index: entry.index,
    rawRowFingerprint: fingerprint(entry.rawRow),
    parserStatus: entry.row ? "ACCEPTED" : "REJECTED",
    parserReasonCodes: [...new Set(entry.parserReasonCodes)].sort(),
    evidenceStatus: entry.evidenceReasonCodes.length === 0 ? "ELIGIBLE" : "INELIGIBLE",
    evidenceReasonCodes: entry.evidenceReasonCodes,
    normalizedRowFingerprint: entry.row ? fingerprint(entry.row) : null,
    normalizedPlayerTag: entry.row?.playerTag ?? null,
    normalizedPosition: entry.row?.position ?? null,
    normalizedWeight: entry.row?.weight ?? null,
  }));

  const structuralConflict = !input.rawPayloadIsArray || parserRejectedRowCount > 0 || evidenceIneligibleRowIndexes.length > 0 || reasonSet.has("accepted_rows_mismatch");
  const positionConflict = reasonSet.has("roster_size_mismatch") || reasonSet.has("position_coverage_incomplete") || parserRejectedRowCount > 0;
  const weightConflict = reasonSet.has("invalid_weight") || reasonSet.has("duplicate_player_identity") || reasonSet.has("duplicate_position") || reasonSet.has("total_weight_mismatch") || reasonSet.has("row_correspondence_inconsistent");
  const completenessStatus: FwaWarMembersEvidenceStatus = positionConflict ? "CONFLICTING" : reasonSet.has("missing_declared_roster_size") ? "UNAVAILABLE" : "VERIFIED";
  const weightStatus: FwaWarMembersEvidenceStatus = weightConflict ? "CONFLICTING" : reasonSet.has("missing_declared_total_weight") ? "UNAVAILABLE" : "VERIFIED";
  const exactWarBindingStatus: FwaWarMembersEvidenceStatus = "UNAVAILABLE";
  const sourceGenerationStatus: FwaWarMembersEvidenceStatus = "UNAVAILABLE";
  const candidateEligibilityStatus: FwaWarMembersEvidenceStatus = structuralConflict || completenessStatus === "CONFLICTING" || weightStatus === "CONFLICTING" ? "CONFLICTING" : "UNAVAILABLE";
  const canonicalAcceptedFingerprints = rowEvaluations.filter((row) => row.parserStatus === "ACCEPTED").map((row) => row.normalizedRowFingerprint as string);
  const resultWithoutFingerprint = {
    contractVersion: FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION,
    sourceUrl: input.sourceUrl,
    sourceWarNo: input.sourceWarNo,
    clanTag: normalizeFwaTag(input.clanTag),
    observedAt: observedAt ?? "",
    ingestedAt: ingestedAt ?? "",
    rawPayloadIsArray: input.rawPayloadIsArray,
    rawRowCount: input.rawRows.length,
    parserAcceptedRowCount,
    parserRejectedRowCount,
    acceptedRowCount: parserAcceptedRowCount,
    discardedRowCount: parserRejectedRowCount,
    evidenceEligibleRowCount: rowEvaluations.filter((row) => row.evidenceStatus === "ELIGIBLE").length,
    evidenceIneligibleRowCount: evidenceIneligibleRowIndexes.length,
    parserRejectedRowIndexes,
    discardedRowIndexes: parserRejectedRowIndexes,
    evidenceIneligibleRowIndexes,
    rowEvaluations,
    rawPayloadFingerprint: canonicalFingerprintList(rowEvaluations.map((row) => row.rawRowFingerprint)),
    acceptedRowsFingerprint: canonicalFingerprintList(canonicalAcceptedFingerprints),
    declaredRosterSize,
    declaredTotalWeight,
    observedOpponentTags,
    structuralStatus: structuralConflict ? "CONFLICTING" as const : "VERIFIED" as const,
    completenessStatus,
    weightStatus,
    exactWarBindingStatus,
    sourceGenerationStatus,
    candidateEligibilityStatus,
    reasonCodes: [...reasonSet].sort(),
  };
  return { ...resultWithoutFingerprint, contentFingerprint: contentFingerprintForEvidence(resultWithoutFingerprint) };
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is FwaWarMembersEvidenceStatus {
  return value === "VERIFIED" || value === "UNAVAILABLE" || value === "CONFLICTING";
}

/** Purpose: verify the complete typed evidence shape and fail-closed authority invariants. */
export function validateFwaWarMembersSourceEvidence(evidence: unknown): evidence is FwaWarMembersSourceEvidence {
  if (!isRecord(evidence) || evidence.contractVersion !== FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION) return false;
  const candidate = evidence as unknown as FwaWarMembersSourceEvidence;
  if (typeof candidate.sourceUrl !== "string" || !Number.isInteger(candidate.sourceWarNo) || candidate.sourceWarNo <= 0 || typeof candidate.clanTag !== "string" || normalizeFwaTag(candidate.clanTag) !== candidate.clanTag || !isIso(candidate.observedAt) || !isIso(candidate.ingestedAt) || new Date(candidate.observedAt).getTime() > new Date(candidate.ingestedAt).getTime() || typeof candidate.rawPayloadIsArray !== "boolean") return false;
  const countKeys = ["rawRowCount", "parserAcceptedRowCount", "parserRejectedRowCount", "acceptedRowCount", "discardedRowCount", "evidenceEligibleRowCount", "evidenceIneligibleRowCount"] as const;
  if (countKeys.some((key) => !isNonnegativeInteger(candidate[key]))) return false;
  if (candidate.rawRowCount !== candidate.parserAcceptedRowCount + candidate.parserRejectedRowCount || candidate.acceptedRowCount !== candidate.parserAcceptedRowCount || candidate.discardedRowCount !== candidate.parserRejectedRowCount || candidate.evidenceEligibleRowCount + candidate.evidenceIneligibleRowCount !== candidate.rawRowCount || !Array.isArray(candidate.parserRejectedRowIndexes) || !Array.isArray(candidate.discardedRowIndexes) || !Array.isArray(candidate.evidenceIneligibleRowIndexes) || JSON.stringify(candidate.parserRejectedRowIndexes) !== JSON.stringify(candidate.discardedRowIndexes) || candidate.parserRejectedRowIndexes.length !== candidate.parserRejectedRowCount || candidate.evidenceIneligibleRowIndexes.length !== candidate.evidenceIneligibleRowCount) return false;
  const validIndexes = (value: unknown): value is number[] => Array.isArray(value) && value.every((index) => isNonnegativeInteger(index)) && value.every((index, position, indexes) => index < candidate.rawRowCount && (position === 0 || indexes[position - 1]! < index));
  if (!validIndexes(candidate.parserRejectedRowIndexes) || !validIndexes(candidate.evidenceIneligibleRowIndexes)) return false;
  if (!Array.isArray(candidate.rowEvaluations) || candidate.rowEvaluations.length !== candidate.rawRowCount) return false;
  for (const [expectedIndex, value] of candidate.rowEvaluations.entries()) {
    const row = value as unknown as FwaWarMembersRowEvaluation;
    if (!isRecord(value) || row.index !== expectedIndex || typeof row.rawRowFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(row.rawRowFingerprint) || (row.parserStatus !== "ACCEPTED" && row.parserStatus !== "REJECTED") || (row.evidenceStatus !== "ELIGIBLE" && row.evidenceStatus !== "INELIGIBLE") || !Array.isArray(row.parserReasonCodes) || !Array.isArray(row.evidenceReasonCodes)) return false;
    if (row.parserReasonCodes.some((reason) => typeof reason !== "string" || !ALL_REASON_CODES.has(reason as FwaWarMembersEvidenceReasonCode)) || row.evidenceReasonCodes.some((reason) => typeof reason !== "string" || !ALL_REASON_CODES.has(reason as FwaWarMembersEvidenceReasonCode))) return false;
    if (row.normalizedRowFingerprint !== null && (typeof row.normalizedRowFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(row.normalizedRowFingerprint))) return false;
    if (row.normalizedPlayerTag !== null && (typeof row.normalizedPlayerTag !== "string" || normalizeFwaTag(row.normalizedPlayerTag) !== row.normalizedPlayerTag)) return false;
    if (row.normalizedPosition !== null && (!Number.isInteger(row.normalizedPosition) || row.normalizedPosition < 1 || row.normalizedPosition > 50)) return false;
    if (row.normalizedWeight !== null && (!Number.isInteger(row.normalizedWeight) || row.normalizedWeight <= 0)) return false;
    if ((row.parserStatus === "REJECTED") !== (row.normalizedRowFingerprint === null) || (row.evidenceStatus === "ELIGIBLE") !== (row.evidenceReasonCodes.length === 0)) return false;
  }
  const expectedRejectedIndexes = candidate.rowEvaluations.filter((row) => row.parserStatus === "REJECTED").map((row) => row.index);
  const expectedIneligibleIndexes = candidate.rowEvaluations.filter((row) => row.evidenceStatus === "INELIGIBLE").map((row) => row.index);
  if (JSON.stringify(expectedRejectedIndexes) !== JSON.stringify(candidate.parserRejectedRowIndexes) || JSON.stringify(expectedIneligibleIndexes) !== JSON.stringify(candidate.evidenceIneligibleRowIndexes)) return false;
  const acceptedEvaluations = candidate.rowEvaluations.filter((row) => row.parserStatus === "ACCEPTED");
  if (candidate.structuralStatus === "VERIFIED" && (candidate.parserRejectedRowCount > 0 || candidate.evidenceIneligibleRowCount > 0)) return false;
  const declaredRosterSize = candidate.declaredRosterSize;
  const declaredTotalWeight = candidate.declaredTotalWeight;
  if (declaredRosterSize !== null && (!isNonnegativeInteger(declaredRosterSize) || declaredRosterSize <= 0)) return false;
  if (declaredTotalWeight !== null && (!isNonnegativeInteger(declaredTotalWeight) || declaredTotalWeight <= 0)) return false;
  if (candidate.completenessStatus === "VERIFIED" && (
    declaredRosterSize === null ||
    candidate.parserRejectedRowCount > 0 ||
    acceptedEvaluations.length !== declaredRosterSize ||
    acceptedEvaluations.some((row) => row.normalizedPosition === null || row.normalizedPosition < 1 || row.normalizedPosition > declaredRosterSize) ||
    new Set(acceptedEvaluations.map((row) => row.normalizedPosition)).size !== declaredRosterSize
  )) return false;
  if (candidate.weightStatus === "VERIFIED" && (
    declaredTotalWeight === null ||
    acceptedEvaluations.some((row) => row.normalizedWeight === null || row.normalizedWeight <= 0) ||
    acceptedEvaluations.reduce((sum, row) => sum + (row.normalizedWeight ?? 0), 0) !== declaredTotalWeight
  )) return false;
  if (!Array.isArray(candidate.observedOpponentTags) || candidate.observedOpponentTags.some((tag) => typeof tag !== "string" || normalizeFwaTag(tag) !== tag)) return false;
  const statusKeys = ["structuralStatus", "completenessStatus", "weightStatus", "exactWarBindingStatus", "sourceGenerationStatus", "candidateEligibilityStatus"] as const;
  if (!statusKeys.every((key) => isStatus(candidate[key]))) return false;
  if (candidate.exactWarBindingStatus !== "UNAVAILABLE" || candidate.sourceGenerationStatus !== "UNAVAILABLE" || candidate.candidateEligibilityStatus === "VERIFIED") return false;
  if (!Array.isArray(candidate.reasonCodes) || candidate.reasonCodes.some((reason) => typeof reason !== "string" || !ALL_REASON_CODES.has(reason as FwaWarMembersEvidenceReasonCode)) || candidate.reasonCodes.some((reason, index, reasons) => index > 0 && reasons[index - 1]! >= reason)) return false;
  if (typeof candidate.rawPayloadFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(candidate.rawPayloadFingerprint) || typeof candidate.acceptedRowsFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(candidate.acceptedRowsFingerprint) || typeof candidate.contentFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(candidate.contentFingerprint)) return false;
  const expectedRawFingerprint = canonicalFingerprintList(candidate.rowEvaluations.map((row) => row.rawRowFingerprint));
  const expectedAcceptedFingerprint = canonicalFingerprintList(candidate.rowEvaluations.filter((row) => row.parserStatus === "ACCEPTED").map((row) => row.normalizedRowFingerprint as string));
  if (candidate.rawPayloadFingerprint !== expectedRawFingerprint || candidate.acceptedRowsFingerprint !== expectedAcceptedFingerprint) return false;
  const { contentFingerprint, ...payload } = candidate;
  return contentFingerprintForEvidence(payload) === contentFingerprint;
}

/** Purpose: expose deterministic checksum construction for tamper tests and offline diagnostics. */
export function computeFwaWarMembersSourceEvidenceContentFingerprint(
  evidence: Omit<FwaWarMembersSourceEvidence, "contentFingerprint">,
): string {
  return contentFingerprintForEvidence(evidence);
}

/** Purpose: make the raw contract evaluator available to deterministic tests and diagnostics. */
export const inspectWarMembersRowForTest = (value: unknown): RawRowCheck => inspectRawRow(value);
