import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { normalizeFwaTag } from "./normalize";
import {
  FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION,
  type FwaWarMembersSourceEvidence,
} from "./FwaWarMembersSourceEvidence";
import type { FwaWarMemberFeedRow } from "./types";

/** Purpose: version the additive persisted observation envelope independently from the source contract. */
export const FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION = "war-members-observation-v1";
export const FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY = "UNKNOWN_UNVERIFIED";

type ObservationDbClient = Pick<
  Prisma.TransactionClient,
  "fwaWarMembersObservation" | "fwaWarMembersObservationMember"
>;

type SemanticMember = {
  clanTag: string;
  playerTag: string | null;
  position: number | null;
  townHall: number | null;
  rawWeight: number | null;
};

export type FwaWarMembersObservationCaptureResult = {
  clanTag: string;
  rosterFingerprint: string;
  canonicalSourceFingerprint: string;
  memberRowCount: number;
  rosterCompletenessStatus: "COMPLETE" | "INCOMPLETE" | "CONFLICTING";
  weightQualityStatus: "DIRECT_PRESENT" | "MISSING_DIRECT" | "CONFLICTING";
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalMember(row: FwaWarMemberFeedRow, clanTag: string): SemanticMember {
  return {
    clanTag,
    playerTag: normalizeFwaTag(row.playerTag) || null,
    position: Number.isInteger(row.position) ? row.position : null,
    townHall: Number.isInteger(row.townHall) ? row.townHall : null,
    rawWeight: Number.isInteger(row.weight) ? row.weight : null,
  };
}

function canonicalSortKey(value: SemanticMember): string {
  return JSON.stringify([
    value.clanTag,
    value.playerTag,
    value.position,
    value.townHall,
    value.rawWeight,
  ]);
}

function compareCanonicalKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Purpose: compute the order-independent semantic fingerprint used for observation deduplication. */
export function computeFwaWarMembersRosterFingerprint(
  clanTag: string,
  rows: readonly FwaWarMemberFeedRow[],
): string {
  const normalizedClanTag = normalizeFwaTag(clanTag);
  const members = rows
    .map((row) => canonicalMember(row, normalizedClanTag))
    .sort((left, right) => compareCanonicalKeys(canonicalSortKey(left), canonicalSortKey(right)));
  return sha256({ clanTag: normalizedClanTag, members });
}

function rosterCompletenessStatus(
  evidence: FwaWarMembersSourceEvidence,
  rows: readonly FwaWarMemberFeedRow[],
): FwaWarMembersObservationCaptureResult["rosterCompletenessStatus"] {
  if (
    evidence.structuralStatus === "CONFLICTING" ||
    evidence.parserRejectedRowCount > 0 ||
    evidence.reasonCodes.some((reason) =>
      [
        "duplicate_player_identity",
        "duplicate_position",
        "invalid_position",
        "opponent_identity_conflict",
        "accepted_rows_mismatch",
        "row_correspondence_inconsistent",
      ].includes(reason),
    )
  ) {
    return "CONFLICTING";
  }
  const positions = rows.map((row) => row.position);
  const players = rows.map((row) => normalizeFwaTag(row.playerTag));
  return rows.length === 50 &&
    positions.every((position) => position !== null && Number.isInteger(position) && position >= 1 && position <= 50) &&
    new Set(positions).size === 50 &&
    players.every(Boolean) &&
    new Set(players).size === 50
    ? "COMPLETE"
    : "INCOMPLETE";
}

/** Purpose: persist one immutable, deduplicated WarMembers observation inside the feed transaction. */
export async function captureFwaWarMembersObservation(
  db: ObservationDbClient,
  input: {
    clanTag: string;
    rows: readonly FwaWarMemberFeedRow[];
    evidence: FwaWarMembersSourceEvidence;
  },
): Promise<FwaWarMembersObservationCaptureResult> {
  const clanTag = normalizeFwaTag(input.clanTag);
  const rosterFingerprint = computeFwaWarMembersRosterFingerprint(clanTag, input.rows);
  const rowFingerprints = input.rows.map((row) => {
    const member = canonicalMember(row, clanTag);
    return { member, memberFingerprint: sha256(member) };
  });
  const sortedMemberRows = [...rowFingerprints].sort((left, right) =>
    compareCanonicalKeys(left.memberFingerprint, right.memberFingerprint),
  );
  const reasonCodes = [
    ...new Set([
      ...input.evidence.reasonCodes,
      "source_authority_unknown_unverified",
    ]),
  ].sort();
  const rawWeightPresentCount = input.rows.filter(
    (row) => Number.isInteger(row.weight) && (row.weight ?? 0) > 0,
  ).length;
  const rawWeightMissingCount = input.rows.filter(
    (row) => row.weight === null || row.weight === 0,
  ).length;
  const rawWeightInvalidCount = input.evidence.rowEvaluations.filter((row) =>
    row.evidenceReasonCodes.includes("invalid_weight"),
  ).length;
  const completeness = rosterCompletenessStatus(input.evidence, input.rows);
  const weightQualityStatus: FwaWarMembersObservationCaptureResult["weightQualityStatus"] =
    input.evidence.weightStatus === "CONFLICTING" || rawWeightInvalidCount > 0
      ? "CONFLICTING"
      : rawWeightMissingCount > 0
        ? "MISSING_DIRECT"
        : "DIRECT_PRESENT";

  const observation = await db.fwaWarMembersObservation.upsert({
    where: {
      clanTag_rosterFingerprint: { clanTag, rosterFingerprint },
    },
    update: {},
    create: {
      clanTag,
      sourceContractVersion: FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION,
      observationSchemaVersion: FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION,
      sourceUrl: input.evidence.sourceUrl,
      sourceWarNo: input.evidence.sourceWarNo,
      firstObservedAt: new Date(input.evidence.observedAt),
      observedAt: new Date(input.evidence.observedAt),
      ingestedAt: new Date(input.evidence.ingestedAt),
      rawRowCount: input.evidence.rawRowCount,
      acceptedRowCount: input.evidence.acceptedRowCount,
      discardedRowCount: input.evidence.discardedRowCount,
      parserAcceptedRowCount: input.evidence.parserAcceptedRowCount,
      parserRejectedRowCount: input.evidence.parserRejectedRowCount,
      evidenceEligibleRowCount: input.evidence.evidenceEligibleRowCount,
      evidenceIneligibleRowCount: input.evidence.evidenceIneligibleRowCount,
      rawWeightPresentCount,
      rawWeightMissingCount,
      rawWeightInvalidCount,
      canonicalSourceFingerprint: input.evidence.rawPayloadFingerprint,
      rosterFingerprint,
      structuralStatus: input.evidence.structuralStatus,
      rosterCompletenessStatus: completeness,
      weightStatus: weightQualityStatus,
      sourceAuthorityStatus: FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY,
      sourceQualityReasonCodes: reasonCodes,
    },
  });

  if (sortedMemberRows.length > 0) {
    await db.fwaWarMembersObservationMember.createMany({
      data: sortedMemberRows.map(({ member, memberFingerprint }) => ({
        observationId: observation.id,
        memberFingerprint,
        playerTag: member.playerTag ?? "",
        playerName: input.rows.find((row) => computeMemberFingerprint(row, clanTag) === memberFingerprint)?.playerName ?? "",
        position: member.position,
        townHall: member.townHall,
        rawWeight: member.rawWeight,
      })),
      skipDuplicates: true,
    });
  }

  return {
    clanTag,
    rosterFingerprint,
    canonicalSourceFingerprint: input.evidence.rawPayloadFingerprint,
    memberRowCount: sortedMemberRows.length,
    rosterCompletenessStatus: completeness,
    weightQualityStatus,
  };
}

function computeMemberFingerprint(row: FwaWarMemberFeedRow, clanTag: string): string {
  return sha256(canonicalMember(row, clanTag));
}

