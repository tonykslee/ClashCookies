import { createHash } from "node:crypto";
import type { FwaWarMemberFeedRow } from "./types";
import { normalizeFwaTag, stableHashValue } from "./normalize";

/** Purpose: version the facts that a WarMembers payload is allowed to establish. */
export const FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION = "war-members-source-v1";

export type FwaWarMembersEvidenceStatus = "VERIFIED" | "UNAVAILABLE" | "CONFLICTING";

export type FwaWarMembersEvidenceReasonCode =
  | "payload_not_array"
  | "malformed_row"
  | "discarded_row"
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
  | "exact_war_binding_unavailable"
  | "source_generation_unbound"
  | "source_timestamp_invalid"
  | "source_timestamp_inconsistent";

export type FwaWarMembersSourceEvidence = {
  contractVersion: string;
  sourceUrl: string;
  sourceWarNo: number;
  clanTag: string;
  observedAt: string;
  ingestedAt: string;
  rawPayloadIsArray: boolean;
  rawRowCount: number;
  acceptedRowCount: number;
  discardedRowCount: number;
  discardedRowIndexes: readonly number[];
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

export type FwaWarMembersSourceEvidenceInput = {
  clanTag: string;
  sourceUrl: string;
  sourceWarNo: number;
  rawPayloadIsArray: boolean;
  rawRows: readonly unknown[];
  acceptedRows: readonly FwaWarMemberFeedRow[];
  observedAt: Date;
  ingestedAt: Date;
  declaredRosterSize?: number | null;
  declaredTotalWeight?: number | null;
};

type RawRowCheck = {
  valid: boolean;
  reasons: FwaWarMembersEvidenceReasonCode[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStrictPositiveInteger(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && value > 0;
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = Number(value.trim().replace(/,/g, ""));
  return Number.isInteger(parsed) && parsed > 0;
}

function isStrictPosition(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1 && value <= 50;
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = Number(value.trim().replace(/,/g, ""));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50;
}

function checkRawRow(value: unknown): RawRowCheck {
  if (!isRecord(value)) return { valid: false, reasons: ["malformed_row"] };
  const reasons: FwaWarMembersEvidenceReasonCode[] = [];
  const playerTag = normalizeFwaTag(typeof value.tag === "string" ? value.tag : null);
  if (!playerTag || typeof value.name !== "string" || !value.name.trim()) {
    reasons.push("missing_player_identity");
  }
  if (!isStrictPosition(value.position)) reasons.push("invalid_position");
  if (!isStrictPositiveInteger(value.weight)) reasons.push("invalid_weight");
  return { valid: reasons.length === 0, reasons };
}

function isoOrNull(value: Date): string | null {
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableHashValue(value)))
    .digest("hex");
}

/**
 * Purpose: evaluate raw WarMembers facts without treating accepted-row count as
 * proof of a complete or exact-war observation.
 *
 * The live FWAStats WarMembers endpoint does not declare a roster size, total
 * weight, exact upstream war identifier, or durable source generation. Those
 * facts therefore remain UNAVAILABLE even when all returned rows look valid.
 */
export function evaluateFwaWarMembersSourceEvidence(
  input: FwaWarMembersSourceEvidenceInput,
): FwaWarMembersSourceEvidence {
  const reasonSet = new Set<FwaWarMembersEvidenceReasonCode>();
  const discardedRowIndexes: number[] = [];
  for (const [index, rawRow] of input.rawRows.entries()) {
    const check = checkRawRow(rawRow);
    if (!check.valid) {
      discardedRowIndexes.push(index);
      reasonSet.add("discarded_row");
      for (const reason of check.reasons) reasonSet.add(reason);
    }
  }
  if (!input.rawPayloadIsArray) reasonSet.add("payload_not_array");

  const playerTags = input.acceptedRows.map((row) => normalizeFwaTag(row.playerTag));
  const positions = input.acceptedRows.map((row) => row.position);
  if (new Set(playerTags).size !== playerTags.length) reasonSet.add("duplicate_player_identity");
  if (new Set(positions.filter((position): position is number => position !== null)).size !== positions.filter((position): position is number => position !== null).length) {
    reasonSet.add("duplicate_position");
  }

  const declaredRosterSize = input.declaredRosterSize ?? null;
  if (!Number.isInteger(declaredRosterSize) || (declaredRosterSize as number) <= 0) {
    reasonSet.add("missing_declared_roster_size");
  } else if (
    input.acceptedRows.length !== declaredRosterSize ||
    positions.length !== declaredRosterSize ||
    positions.some((position) => position === null || position < 1 || position > declaredRosterSize) ||
    new Set(positions).size !== declaredRosterSize
  ) {
    reasonSet.add("roster_size_mismatch");
    reasonSet.add("position_coverage_incomplete");
  }

  const declaredTotalWeight = input.declaredTotalWeight ?? null;
  const observedTotalWeight = input.acceptedRows.reduce((sum, row) => sum + (row.weight ?? 0), 0);
  if (!Number.isInteger(declaredTotalWeight) || (declaredTotalWeight as number) <= 0) {
    reasonSet.add("missing_declared_total_weight");
  } else if (declaredTotalWeight !== observedTotalWeight) {
    reasonSet.add("total_weight_mismatch");
  }

  const observedOpponentTags = [...new Set(input.acceptedRows.map((row) => row.opponentTag).filter((tag): tag is string => Boolean(tag)).sort())];
  if (observedOpponentTags.length > 1) reasonSet.add("opponent_identity_conflict");

  const observedAt = isoOrNull(input.observedAt);
  const ingestedAt = isoOrNull(input.ingestedAt);
  if (!observedAt || !ingestedAt) {
    reasonSet.add("source_timestamp_invalid");
  } else if (input.observedAt.getTime() > input.ingestedAt.getTime()) {
    reasonSet.add("source_timestamp_inconsistent");
  }

  // No current FWAStats contract proves that warNo=1 identifies one exact FWA
  // war or that a source batch can be replay-detected across process restarts.
  reasonSet.add("exact_war_binding_unavailable");
  reasonSet.add("source_generation_unbound");

  const reasons = [...reasonSet].sort();
  const canonicalRawRows = [...input.rawRows].sort((left, right) =>
    JSON.stringify(stableHashValue(left)).localeCompare(JSON.stringify(stableHashValue(right))),
  );
  const canonicalAcceptedRows = [...input.acceptedRows].sort((left, right) => {
    const positionDelta = (left.position ?? 0) - (right.position ?? 0);
    return positionDelta !== 0 ? positionDelta : left.playerTag.localeCompare(right.playerTag);
  });
  const structuralValid = input.rawPayloadIsArray && discardedRowIndexes.length === 0;
  const completenessVerified = structuralValid &&
    !reasons.includes("missing_declared_roster_size") &&
    !reasons.includes("roster_size_mismatch") &&
    !reasons.includes("position_coverage_incomplete") &&
    input.acceptedRows.length === declaredRosterSize;
  const weightsVerified = structuralValid &&
    !reasons.includes("invalid_weight") &&
    !reasons.includes("duplicate_player_identity") &&
    !reasons.includes("duplicate_position") &&
    !reasons.includes("missing_declared_total_weight") &&
    !reasons.includes("total_weight_mismatch");
  const exactWarBindingStatus: FwaWarMembersEvidenceStatus = "UNAVAILABLE";
  const sourceGenerationStatus: FwaWarMembersEvidenceStatus = "UNAVAILABLE";
  const candidateEligibilityStatus: FwaWarMembersEvidenceStatus =
    completenessVerified && weightsVerified && reasons.length === 2 ? "UNAVAILABLE" : "CONFLICTING";
  const resultWithoutFingerprint = {
    contractVersion: FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION,
    sourceUrl: input.sourceUrl,
    sourceWarNo: input.sourceWarNo,
    clanTag: normalizeFwaTag(input.clanTag),
    observedAt: observedAt ?? "",
    ingestedAt: ingestedAt ?? "",
    rawPayloadIsArray: input.rawPayloadIsArray,
    rawRowCount: input.rawRows.length,
    acceptedRowCount: input.acceptedRows.length,
    discardedRowCount: discardedRowIndexes.length,
    discardedRowIndexes,
    rawPayloadFingerprint: fingerprint(canonicalRawRows),
    acceptedRowsFingerprint: fingerprint(canonicalAcceptedRows),
    declaredRosterSize,
    declaredTotalWeight,
    observedOpponentTags,
    structuralStatus: structuralValid ? "VERIFIED" as const : "CONFLICTING" as const,
    completenessStatus: completenessVerified ? "VERIFIED" as const : "UNAVAILABLE" as const,
    weightStatus: weightsVerified ? "VERIFIED" as const : "CONFLICTING" as const,
    exactWarBindingStatus,
    sourceGenerationStatus,
    candidateEligibilityStatus,
    reasonCodes: reasons,
  };
  return {
    ...resultWithoutFingerprint,
    contentFingerprint: fingerprint(resultWithoutFingerprint),
  };
}

/** Purpose: verify that the evidence fingerprint covers the complete typed payload. */
export function validateFwaWarMembersSourceEvidence(
  evidence: unknown,
): evidence is FwaWarMembersSourceEvidence {
  if (!isRecord(evidence)) return false;
  if (evidence.contractVersion !== FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION) return false;
  if (typeof evidence.contentFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(evidence.contentFingerprint)) return false;
  const { contentFingerprint, ...payload } = evidence;
  return fingerprint(payload) === contentFingerprint;
}

/** Purpose: make the raw contract evaluator available to deterministic tests and diagnostics. */
export const inspectWarMembersRowForTest = checkRawRow;
