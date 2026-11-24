import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  computeNativeReferenceCandidateContentFingerprint,
  generateNativeHeatMapRefCandidate,
  NATIVE_REFERENCE_ERA_POLICY_VERSION,
  NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST,
  NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY,
  NATIVE_REFERENCE_OBSERVATION_AGGREGATION_CONTRACT_VERSION,
  NATIVE_REFERENCE_OBSERVATION_SELECTION_POLICY_VERSION,
  NATIVE_REFERENCE_OBSERVATION_QUALITY_POLICY_VERSION,
  type NativeReferenceBandDefinition,
  type NativeReferenceCandidateArtifact,
  type NativeReferenceEraPolicy,
  type NativeReferenceObservationAggregationMetadata,
  type NativeReferenceSourceRoster,
} from "../helper/nativeHeatMapRefCandidate";
import { resolveFwaWeightRows } from "../helper/fwaWeightResolution";
import { HEAT_MAP_REF_SEED_ROWS } from "./HeatMapRefSeedData";
import {
  listOpenDeferredWeightRowsByClanAndPlayerTags,
  type OpenWeightInputDefermentMatchRow,
} from "./WeightInputDefermentService";
import {
  FWA_WAR_MEMBERS_EVIDENCE_SCHEMA_VERSION,
  FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION,
  FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY,
} from "./fwa-feeds/FwaWarMembersObservationService";
import { FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION } from "./fwa-feeds/FwaWarMembersSourceEvidence";
import { normalizeFwaTag } from "./fwa-feeds/normalize";

export const NATIVE_OBSERVATION_AGGREGATION_CONTRACT_VERSION = NATIVE_REFERENCE_OBSERVATION_AGGREGATION_CONTRACT_VERSION;
export const NATIVE_OBSERVATION_SELECTION_POLICY_VERSION = NATIVE_REFERENCE_OBSERVATION_SELECTION_POLICY_VERSION;
export const NATIVE_OBSERVATION_QUALITY_POLICY_VERSION = NATIVE_REFERENCE_OBSERVATION_QUALITY_POLICY_VERSION;
export const NATIVE_OBSERVATION_READ_LIMIT = 1_000;

type ObservationDb = Pick<PrismaClient, "fwaWarMembersObservation">;

type RetainedObservationQuery = Prisma.FwaWarMembersObservationGetPayload<{
  include: { members: true; qualityEvidence: true };
}>;

type RetainedMember = Pick<
  RetainedObservationQuery["members"][number],
  "observationId" | "playerTag" | "position" | "townHall" | "rawWeight"
>;

type RetainedEvidence = {
  id: string;
  evidenceSchemaVersion: string;
  sourceContractVersion: string;
  sourceWarNo: number;
  firstObservedAt: Date | string;
  observedAt: Date | string;
  ingestedAt: Date | string;
  sourceQualityFingerprint: string;
  structuralStatus: string;
  rosterCompletenessStatus: string;
  weightStatus: string;
  sourceAuthorityStatus: string;
  sourceQualityReasonCodes: unknown;
};

type RetainedObservation = {
  id: string;
  clanTag: string;
  sourceContractVersion: string;
  observationSchemaVersion: string;
  sourceWarNo: number;
  firstObservedAt: Date | string;
  observedAt: Date | string;
  ingestedAt: Date | string;
  rosterFingerprint: string;
  members: RetainedMember[];
  qualityEvidence: RetainedEvidence[];
};

function mapRetainedObservation(row: RetainedObservationQuery): RetainedObservation {
  return {
    id: row.id,
    clanTag: row.clanTag,
    sourceContractVersion: row.sourceContractVersion,
    observationSchemaVersion: row.observationSchemaVersion,
    sourceWarNo: row.sourceWarNo,
    firstObservedAt: row.firstObservedAt,
    observedAt: row.observedAt,
    ingestedAt: row.ingestedAt,
    rosterFingerprint: row.rosterFingerprint,
    members: row.members.map((member) => ({
      observationId: member.observationId,
      playerTag: member.playerTag,
      position: member.position,
      townHall: member.townHall,
      rawWeight: member.rawWeight,
    })),
    qualityEvidence: row.qualityEvidence,
  };
}

type RetainedReadResult = {
  rows: RetainedObservation[];
  coverageStatus: "VERIFIED" | "TRUNCATED";
  readRowCount: number;
  readLimited: boolean;
};

type CandidateInput = {
  evaluationAt: Date | string;
  eraPolicy: NativeReferenceEraPolicy;
  sampleThreshold?: number;
  bandDefinitions?: readonly NativeReferenceBandDefinition[];
  defermentScope?: { guildId: string; clanTag: string };
};

export type NativeHeatMapRefObservationCandidateContext = {
  artifact: NativeReferenceCandidateArtifact;
  sourceRosters: readonly NativeReferenceSourceRoster[];
  readRowCount: number;
  readLimited: boolean;
  eligibleSemanticLineageCount: number;
  malformedAvailableObservationCount: number;
};

type Selection = {
  clanTag: string;
  observation: RetainedObservation;
  evidence: RetainedEvidence | null;
  status: "QUALIFYING" | "EXCLUDED";
  reasonCode: string | null;
  roster: NativeReferenceSourceRoster | null;
};

function parseDate(value: Date | string): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function iso(value: Date): string {
  return value.toISOString();
}

function compareDesc(left: Date, right: Date): number {
  return right.getTime() - left.getTime();
}

function evidenceAvailableAsOf(evidence: RetainedEvidence, eraStart: Date, evaluationAt: Date): boolean {
  const firstObservedAt = parseDate(evidence.firstObservedAt);
  const observedAt = parseDate(evidence.observedAt);
  const ingestedAt = parseDate(evidence.ingestedAt);
  return Boolean(
    firstObservedAt &&
    observedAt &&
    ingestedAt &&
    firstObservedAt <= observedAt &&
    observedAt <= ingestedAt &&
    firstObservedAt >= eraStart &&
    observedAt <= evaluationAt &&
    ingestedAt <= evaluationAt,
  );
}

function reasonCodes(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))].sort()
    : [];
}

function sourceQualityIsEligible(evidence: RetainedEvidence): string | null {
  if (evidence.evidenceSchemaVersion !== FWA_WAR_MEMBERS_EVIDENCE_SCHEMA_VERSION) return "quality_evidence_version";
  if (evidence.sourceContractVersion !== FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION) return "source_contract_version";
  if (evidence.sourceWarNo !== 1) return "source_war_number";
  if (evidence.sourceAuthorityStatus !== FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY) return "source_authority_conflict";
  if (evidence.structuralStatus === "CONFLICTING" || evidence.rosterCompletenessStatus === "CONFLICTING" || evidence.weightStatus === "CONFLICTING") return "quality_conflict";
  const reasons = new Set(reasonCodes(evidence.sourceQualityReasonCodes));
  const disqualifyingReasons = [
    "parser_rejected",
    "discarded_row",
    "evidence_ineligible",
    "accepted_rows_mismatch",
    "row_correspondence_inconsistent",
    "source_timestamp_invalid",
    "source_timestamp_inconsistent",
    "duplicate_player_identity",
    "duplicate_position",
    "invalid_position",
    "opponent_identity_conflict",
    "roster_size_mismatch",
    "position_coverage_incomplete",
    "invalid_weight",
    "total_weight_mismatch",
  ];
  return disqualifyingReasons.find((reason) => reasons.has(reason)) ?? null;
}

function validateMembers(observation: RetainedObservation): { members: RetainedMember[]; reasonCode: string | null } {
  const clanTag = normalizeFwaTag(observation.clanTag);
  if (!clanTag) return { members: [], reasonCode: "member_roster_mismatch" };
  if (observation.members.length !== 50) return { members: [], reasonCode: "member_count_mismatch" };
  const members = [...observation.members].sort((left, right) =>
    (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
    left.playerTag.localeCompare(right.playerTag),
  );
  const positions = new Set<number>();
  const players = new Set<string>();
  for (const member of members) {
    const playerTag = normalizeFwaTag(member.playerTag);
    const position = member.position;
    if (member.observationId !== observation.id) return { members: [], reasonCode: "member_ownership_mismatch" };
    if (!playerTag || typeof position !== "number" || !Number.isInteger(position) || position < 1 || position > 50 || positions.has(position)) {
      return { members: [], reasonCode: "member_structure" };
    }
    if (players.has(playerTag)) return { members: [], reasonCode: "duplicate_player_identity" };
    if (member.rawWeight !== null && (!Number.isInteger(member.rawWeight) || member.rawWeight < 0)) return { members: [], reasonCode: "invalid_weight" };
    positions.add(position);
    players.add(playerTag);
  }
  if (positions.size !== 50) return { members: [], reasonCode: "member_structure" };
  return {
    members: members.map((member) => ({ ...member, clanTag, playerTag: normalizeFwaTag(member.playerTag) })),
    reasonCode: null,
  };
}

function stableMetadata(metadata: NativeReferenceObservationAggregationMetadata): NativeReferenceObservationAggregationMetadata {
  return {
    ...metadata,
    selectedObservations: [...metadata.selectedObservations].sort((left, right) => left.clanTag.localeCompare(right.clanTag)),
    lineage: [...metadata.lineage].sort((left, right) => left.clanTag.localeCompare(right.clanTag) || left.observedAtIso.localeCompare(right.observedAtIso) || left.observationId.localeCompare(right.observationId)),
  };
}

function emptyWeightProvenance(): { RAW: number; DEFERRED: number; ESTIMATED: number; UNRESOLVED: number } {
  return { RAW: 0, DEFERRED: 0, ESTIMATED: 0, UNRESOLVED: 0 };
}

/** Purpose: read immutable WarMembers observations and quality revisions as-of an explicit policy cutoff. */
export class NativeHeatMapRefObservationCandidateService {
  private readonly db: ObservationDb;
  private readonly readDeferredWeights: typeof listOpenDeferredWeightRowsByClanAndPlayerTags;

  constructor(
    db: ObservationDb = prisma,
    readDeferredWeights: typeof listOpenDeferredWeightRowsByClanAndPlayerTags = listOpenDeferredWeightRowsByClanAndPlayerTags,
  ) {
    this.db = db;
    this.readDeferredWeights = readDeferredWeights;
  }

  private async readRetainedObservations(input: { evaluationAt: Date; eraStart: Date; eraEnd: Date }): Promise<RetainedReadResult> {
    const rows = await this.db.fwaWarMembersObservation.findMany({
      where: {
        sourceWarNo: 1,
        ingestedAt: { lte: input.evaluationAt },
        OR: [
          { observedAt: { gte: input.eraStart } },
          { firstObservedAt: { gte: input.eraStart } },
        ],
      },
      orderBy: [{ firstObservedAt: "asc" }, { id: "asc" }],
      take: NATIVE_OBSERVATION_READ_LIMIT + 1,
      include: {
        members: true,
        qualityEvidence: true,
      },
    });
    return {
      rows: rows.map(mapRetainedObservation),
      coverageStatus: rows.length > NATIVE_OBSERVATION_READ_LIMIT ? "TRUNCATED" : "VERIFIED",
      readRowCount: rows.length,
      readLimited: rows.length > NATIVE_OBSERVATION_READ_LIMIT,
    };
  }

  private async resolveDeferredWeights(
    selection: Selection[],
    input: CandidateInput,
    evaluationAt: Date,
    eraStart: Date,
    eraEnd: Date,
  ): Promise<Map<string, Map<string, OpenWeightInputDefermentMatchRow>>> {
    const scope = input.defermentScope;
    if (!scope?.guildId.trim() || !scope.clanTag.trim()) return new Map();
    const matching = selection.find((entry) => normalizeFwaTag(entry.clanTag) === normalizeFwaTag(scope.clanTag));
    if (!matching || !matching.roster) return new Map();
    return this.readDeferredWeights({
      guildId: scope.guildId,
      clanPlayerTags: [{ clanTag: matching.roster.clanTag, playerTags: matching.roster.members.map((member) => member.playerTag) }],
      createdAtWindow: { from: eraStart, through: evaluationAt },
    }).then((result) => {
      const clanRows = result.get(matching.roster!.clanTag) ?? result.get(normalizeFwaTag(matching.roster!.clanTag)) ?? new Map();
      const eligible = new Map<string, OpenWeightInputDefermentMatchRow>();
      for (const [playerTag, row] of clanRows) {
        const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
        if (Number.isFinite(createdAt.getTime()) && createdAt >= eraStart && createdAt <= eraEnd && createdAt <= evaluationAt) {
          eligible.set(normalizeFwaTag(playerTag), row);
        }
      }
      return new Map([[matching.roster!.clanTag, eligible]]);
    });
  }

  async generate(input: CandidateInput): Promise<NativeReferenceCandidateArtifact> {
    return (await this.generateWithContext(input)).artifact;
  }

  /** Purpose: expose the already-selected, internally resolved rosters to a read-only cohort audit without changing the artifact contract. */
  async generateWithContext(input: CandidateInput): Promise<NativeHeatMapRefObservationCandidateContext> {
    const evaluationAt = parseDate(input.evaluationAt);
    const eraStart = parseDate(input.eraPolicy.eraStartIso);
    const eraEnd = parseDate(input.eraPolicy.eraEndIso);
    if (!evaluationAt || !eraStart || !eraEnd || input.eraPolicy.policyVersion !== NATIVE_REFERENCE_ERA_POLICY_VERSION) {
      throw new Error("invalid retained-observation evaluation policy");
    }

    const read = await this.readRetainedObservations({ evaluationAt, eraStart, eraEnd });
    const byClan = new Map<string, RetainedObservation[]>();
    const malformedAvailableClans = new Set<string>();
    let malformedAvailableObservationCount = 0;
    for (const row of read.rows) {
      const clanTag = normalizeFwaTag(row.clanTag);
      const firstObservedAt = parseDate(row.firstObservedAt);
      const observedAt = parseDate(row.observedAt);
      const ingestedAt = parseDate(row.ingestedAt);
      if (!clanTag) continue;
      const availableAsOf = !ingestedAt || ingestedAt <= evaluationAt;
      const malformed = (
        !firstObservedAt ||
        !observedAt ||
        !ingestedAt ||
        firstObservedAt > observedAt ||
        observedAt > ingestedAt ||
        firstObservedAt < eraStart ||
        observedAt > evaluationAt
      );
      if (availableAsOf && malformed) {
        malformedAvailableObservationCount += 1;
        malformedAvailableClans.add(clanTag);
        continue;
      }
      if (ingestedAt > evaluationAt) continue;
      if (
        !firstObservedAt || !observedAt
      ) continue;
      const entries = byClan.get(clanTag) ?? [];
      entries.push(row);
      byClan.set(clanTag, entries);
    }
    for (const clanTag of malformedAvailableClans) byClan.delete(clanTag);

    const selections: Selection[] = [];
    const lineage: Array<NativeReferenceObservationAggregationMetadata["lineage"][number]> = [];
    let ambiguous = malformedAvailableClans.size > 0;
    for (const [clanTag, rows] of [...byClan.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const ordered = [...rows].sort((left, right) => compareDesc(parseDate(left.firstObservedAt)!, parseDate(right.firstObservedAt)!) || left.id.localeCompare(right.id));
      const newest = ordered[0];
      if (!newest) continue;
      const newestTime = parseDate(newest.firstObservedAt)!.getTime();
      const sameTime = ordered.filter((row) => parseDate(row.firstObservedAt)!.getTime() === newestTime);
      if (sameTime.length > 1) ambiguous = true;
      for (const row of ordered) {
        lineage.push({
          clanTag,
          observationId: row.id,
          rosterFingerprint: row.rosterFingerprint,
          firstObservedAtIso: iso(parseDate(row.firstObservedAt)!),
          observedAtIso: iso(parseDate(row.observedAt)!),
          ingestedAtIso: iso(parseDate(row.ingestedAt)!),
          selectionStatus: row === newest && sameTime.length === 1 ? "SELECTED" : sameTime.includes(row) ? "AMBIGUOUS" : "SUPERSEDED",
          qualityEvidenceIds: row.qualityEvidence
            .filter((evidence) => evidenceAvailableAsOf(evidence, eraStart, evaluationAt))
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((evidence) => evidence.id),
          weightProvenance: row.members.reduce((counts, member) => {
            if (member.rawWeight !== null && member.rawWeight > 0) counts.RAW += 1;
            else counts.UNRESOLVED += 1;
            return counts;
          }, emptyWeightProvenance()),
        });
      }
      const evidenceCandidates = newest.qualityEvidence
        .filter((evidence) => {
          return evidenceAvailableAsOf(evidence, eraStart, evaluationAt);
        })
        .sort((left, right) => compareDesc(parseDate(left.observedAt)!, parseDate(right.observedAt)!) || left.id.localeCompare(right.id));
      const newestEvidence = evidenceCandidates[0] ?? null;
      const sameEvidenceTime = newestEvidence
        ? evidenceCandidates.filter((evidence) => parseDate(evidence.observedAt)!.getTime() === parseDate(newestEvidence.observedAt)!.getTime())
        : [];
      if (sameEvidenceTime.length > 1) ambiguous = true;
      const evidence = sameEvidenceTime.length === 1 ? newestEvidence : null;
      const memberValidation = validateMembers(newest);
      const qualityReason = evidence ? sourceQualityIsEligible(evidence) : "quality_evidence_unavailable";
      const observationVersionReason = newest.observationSchemaVersion !== FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION
        ? "observation_schema_version"
        : newest.sourceContractVersion !== FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION
          ? "source_contract_version"
          : newest.sourceWarNo !== 1
            ? "source_war_number"
          : null;
      const reasonCode = sameEvidenceTime.length > 1
        ? "quality_evidence_ambiguous"
        : observationVersionReason ?? memberValidation.reasonCode ?? qualityReason;
      selections.push({
        clanTag,
        observation: newest,
        evidence,
        status: reasonCode ? "EXCLUDED" : "QUALIFYING",
        reasonCode,
        roster: reasonCode
          ? null
          : {
              clanTag,
              rosterSize: memberValidation.members.length,
              totalRawWeight: memberValidation.members.reduce((sum, member) => sum + (member.rawWeight && member.rawWeight > 0 ? member.rawWeight : 0), 0),
              totalEffectiveWeight: null,
              observedAt: parseDate(newest.observedAt)!,
              sourceUpdatedAt: parseDate(newest.observedAt)!,
              sourceWarId: null,
              sourceWarStartTime: null,
              sourceWarEndTime: null,
              sourceWarState: null,
              sourceCurrentWarUpdatedAt: null,
              sourceIdentityStatus: "UNAVAILABLE",
              sourceMatchType: null,
              sourceMemberCompletenessStatus: "VERIFIED",
              members: memberValidation.members.map((member) => ({
                clanTag,
                playerTag: member.playerTag,
                position: member.position,
                townHall: member.townHall,
                rawWeight: member.rawWeight,
                effectiveWeight: null,
                effectiveWeightStatus: "UNRESOLVED" as const,
              })),
            },
      });
    }

    const deferred = await this.resolveDeferredWeights(selections, input, evaluationAt, eraStart, eraEnd);
    const sourceRosters: NativeReferenceSourceRoster[] = [];
    const weightProvenanceByObservation = new Map<string, { RAW: number; DEFERRED: number; ESTIMATED: number; UNRESOLVED: number }>();
    for (const selection of selections) {
      if (selection.status !== "QUALIFYING" || !selection.roster) continue;
      const deferredByPlayer = deferred.get(selection.roster.clanTag) ?? new Map<string, OpenWeightInputDefermentMatchRow>();
      const members = selection.roster.members.map((member) => {
        const row = deferredByPlayer.get(normalizeFwaTag(member.playerTag));
        return {
          ...member,
          deferredWeight: row?.deferredWeight ?? null,
          deferredCreatedAt: row?.createdAt ?? null,
        };
      });
      const resolved = resolveFwaWeightRows(members);
      const totalEffectiveWeight = resolved.every((member) => member.effectiveWeight !== null)
        ? resolved.reduce((sum, member) => sum + (member.effectiveWeight ?? 0), 0)
        : null;
      weightProvenanceByObservation.set(selection.observation.id, resolved.reduce((counts, member) => {
        counts[member.effectiveWeightStatus] += 1;
        return counts;
      }, emptyWeightProvenance()));
      sourceRosters.push({ ...selection.roster, totalEffectiveWeight, members: resolved });
    }

    const lineageWithProvenance = lineage.map((entry) => ({
      ...entry,
      weightProvenance: weightProvenanceByObservation.get(entry.observationId) ?? entry.weightProvenance,
    }));

    const metadata: NativeReferenceObservationAggregationMetadata = stableMetadata({
      contractVersion: NATIVE_OBSERVATION_AGGREGATION_CONTRACT_VERSION,
      selectionPolicyVersion: NATIVE_OBSERVATION_SELECTION_POLICY_VERSION,
      qualityPolicyVersion: NATIVE_OBSERVATION_QUALITY_POLICY_VERSION,
      coverageStatus: ambiguous ? "AMBIGUOUS" : read.coverageStatus,
      readLimit: NATIVE_OBSERVATION_READ_LIMIT,
      selectedObservationCount: selections.length,
      excludedObservationCount: selections.filter((selection) => selection.status === "EXCLUDED").length,
      supersededObservationCount: lineage.filter((entry) => entry.selectionStatus === "SUPERSEDED").length,
      qualityEvidenceRevisionCount: lineage.reduce((sum, entry) => sum + entry.qualityEvidenceIds.length, 0),
      selectedObservations: selections.map((selection) => ({
        clanTag: selection.clanTag,
        observationId: selection.observation.id,
        rosterFingerprint: selection.observation.rosterFingerprint,
        firstObservedAtIso: iso(parseDate(selection.observation.firstObservedAt)!),
        observedAtIso: iso(parseDate(selection.observation.observedAt)!),
        ingestedAtIso: iso(parseDate(selection.observation.ingestedAt)!),
        qualityEvidenceId: selection.evidence?.id ?? null,
        qualityFingerprint: selection.evidence?.sourceQualityFingerprint ?? null,
        qualityFirstObservedAtIso: selection.evidence ? iso(parseDate(selection.evidence.firstObservedAt)!) : null,
        qualityObservedAtIso: selection.evidence ? iso(parseDate(selection.evidence.observedAt)!) : null,
        qualityIngestedAtIso: selection.evidence ? iso(parseDate(selection.evidence.ingestedAt)!) : null,
        status: selection.status,
        reasonCode: selection.reasonCode,
      })),
      lineage: lineageWithProvenance,
      defermentScope: input.defermentScope ?? null,
      authorityLimitations: [
        "exact_war_binding_unavailable",
        "source_generation_unbound",
        "quality_evidence_is_diagnostic_only",
        "authority_remains_unknown_unverified",
        ...(malformedAvailableClans.size > 0 ? ["malformed_observation_available_as_of_cutoff"] : []),
      ],
    });

    const base = generateNativeHeatMapRefCandidate({
      sourceRosters: read.coverageStatus === "VERIFIED" && !ambiguous ? sourceRosters : [],
      bandDefinitions: input.bandDefinitions ?? HEAT_MAP_REF_SEED_ROWS.map((row) => ({
        weightMinInclusive: row.weightMinInclusive,
        weightMaxInclusive: row.weightMaxInclusive,
      })),
      eraPolicy: input.eraPolicy,
      evaluationAt,
      sampleThreshold: input.sampleThreshold,
      sourceCategory: NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY,
      evidenceTrust: NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST,
    });
    const { contentFingerprint: _contentFingerprint, ...withoutFingerprint } = base;
    const withMetadata = { ...withoutFingerprint, observationAggregation: metadata };
    const artifact = {
      ...withMetadata,
      contentFingerprint: computeNativeReferenceCandidateContentFingerprint(withMetadata),
    };
    return {
      artifact,
      sourceRosters,
      readRowCount: read.readRowCount,
      readLimited: read.readLimited,
      eligibleSemanticLineageCount: lineage.length,
      malformedAvailableObservationCount,
    };
  }
}
