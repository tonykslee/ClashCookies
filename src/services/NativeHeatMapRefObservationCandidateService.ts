import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  computeNativeReferenceCandidateContentFingerprint,
  generateNativeHeatMapRefCandidate,
  NATIVE_REFERENCE_ERA_POLICY_VERSION,
  NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST,
  NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY,
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

export const NATIVE_OBSERVATION_AGGREGATION_CONTRACT_VERSION = "native-observation-aggregation-v1";
export const NATIVE_OBSERVATION_SELECTION_POLICY_VERSION = "latest-semantic-observation-as-of-v1";
export const NATIVE_OBSERVATION_QUALITY_POLICY_VERSION = "quality-evidence-as-of-v1";
export const NATIVE_OBSERVATION_READ_LIMIT = 1_000;

type ObservationDb = Pick<PrismaClient, "fwaWarMembersObservation">;

type RetainedMember = {
  clanTag: string;
  playerTag: string;
  position: number | null;
  townHall: number | null;
  rawWeight: number | null;
};

type RetainedEvidence = {
  id: string;
  evidenceSchemaVersion: string;
  sourceContractVersion: string;
  sourceWarNo: number;
  firstObservedAt: Date;
  observedAt: Date;
  ingestedAt: Date;
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
  firstObservedAt: Date;
  observedAt: Date;
  rosterFingerprint: string;
  members: RetainedMember[];
  qualityEvidence: RetainedEvidence[];
};

type RetainedReadResult = {
  rows: RetainedObservation[];
  coverageStatus: "VERIFIED" | "TRUNCATED";
};

type CandidateInput = {
  evaluationAt: Date | string;
  eraPolicy: NativeReferenceEraPolicy;
  sampleThreshold?: number;
  bandDefinitions?: readonly NativeReferenceBandDefinition[];
  defermentScope?: { guildId: string; clanTag: string };
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
  if (!clanTag || observation.members.length !== 50) return { members: [], reasonCode: "member_roster_mismatch" };
  const members = [...observation.members].sort((left, right) =>
    (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
    left.playerTag.localeCompare(right.playerTag),
  );
  const positions = new Set<number>();
  const players = new Set<string>();
  for (const member of members) {
    const playerTag = normalizeFwaTag(member.playerTag);
    const position = member.position;
    if (normalizeFwaTag(member.clanTag) !== clanTag) return { members: [], reasonCode: "member_roster_mismatch" };
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
        observedAt: { gte: input.eraStart, lte: input.evaluationAt },
      },
      orderBy: [{ observedAt: "asc" }, { id: "asc" }],
      take: NATIVE_OBSERVATION_READ_LIMIT + 1,
      include: {
        members: true,
        qualityEvidence: true,
      },
    });
    return {
      rows: rows as unknown as RetainedObservation[],
      coverageStatus: rows.length > NATIVE_OBSERVATION_READ_LIMIT ? "TRUNCATED" : "VERIFIED",
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
    const evaluationAt = parseDate(input.evaluationAt);
    const eraStart = parseDate(input.eraPolicy.eraStartIso);
    const eraEnd = parseDate(input.eraPolicy.eraEndIso);
    if (!evaluationAt || !eraStart || !eraEnd || input.eraPolicy.policyVersion !== NATIVE_REFERENCE_ERA_POLICY_VERSION) {
      throw new Error("invalid retained-observation evaluation policy");
    }

    const read = await this.readRetainedObservations({ evaluationAt, eraStart, eraEnd });
    const byClan = new Map<string, RetainedObservation[]>();
    for (const row of read.rows) {
      const clanTag = normalizeFwaTag(row.clanTag);
      const observedAt = parseDate(row.observedAt);
      if (!clanTag || !observedAt || observedAt < eraStart || observedAt > evaluationAt) continue;
      const entries = byClan.get(clanTag) ?? [];
      entries.push(row);
      byClan.set(clanTag, entries);
    }

    const selections: Selection[] = [];
    const lineage: Array<NativeReferenceObservationAggregationMetadata["lineage"][number]> = [];
    let ambiguous = false;
    for (const [clanTag, rows] of [...byClan.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const ordered = [...rows].sort((left, right) => compareDesc(left.observedAt, right.observedAt) || left.id.localeCompare(right.id));
      const newest = ordered[0];
      if (!newest) continue;
      const newestTime = newest.observedAt.getTime();
      const sameTime = ordered.filter((row) => row.observedAt.getTime() === newestTime);
      if (sameTime.length > 1) ambiguous = true;
      for (const row of ordered) {
        lineage.push({
          clanTag,
          observationId: row.id,
          rosterFingerprint: row.rosterFingerprint,
          observedAtIso: iso(row.observedAt),
          selectionStatus: row === newest && sameTime.length === 1 ? "SELECTED" : "SUPERSEDED",
          qualityEvidenceIds: [...row.qualityEvidence].sort((left, right) => left.id.localeCompare(right.id)).map((evidence) => evidence.id),
        });
      }
      const evidenceCandidates = newest.qualityEvidence
        .filter((evidence) => {
          const observedAt = parseDate(evidence.observedAt);
          return Boolean(observedAt && observedAt >= eraStart && observedAt <= evaluationAt);
        })
        .sort((left, right) => compareDesc(left.observedAt, right.observedAt) || left.id.localeCompare(right.id));
      const newestEvidence = evidenceCandidates[0] ?? null;
      const sameEvidenceTime = newestEvidence
        ? evidenceCandidates.filter((evidence) => evidence.observedAt.getTime() === newestEvidence.observedAt.getTime())
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
              observedAt: newest.observedAt,
              sourceUpdatedAt: newest.observedAt,
              sourceWarId: null,
              sourceWarStartTime: null,
              sourceWarEndTime: null,
              sourceWarState: null,
              sourceCurrentWarUpdatedAt: null,
              sourceIdentityStatus: "UNAVAILABLE",
              sourceMatchType: null,
              sourceMemberCompletenessStatus: "VERIFIED",
              members: memberValidation.members.map((member) => ({
                ...member,
                effectiveWeight: null,
                effectiveWeightStatus: "UNRESOLVED" as const,
              })),
            },
      });
    }

    const deferred = await this.resolveDeferredWeights(selections, input, evaluationAt, eraStart, eraEnd);
    const sourceRosters: NativeReferenceSourceRoster[] = [];
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
      sourceRosters.push({ ...selection.roster, totalEffectiveWeight, members: resolved });
    }

    const metadata: NativeReferenceObservationAggregationMetadata = stableMetadata({
      contractVersion: NATIVE_OBSERVATION_AGGREGATION_CONTRACT_VERSION,
      selectionPolicyVersion: NATIVE_OBSERVATION_SELECTION_POLICY_VERSION,
      qualityPolicyVersion: NATIVE_OBSERVATION_QUALITY_POLICY_VERSION,
      coverageStatus: ambiguous ? "AMBIGUOUS" : read.coverageStatus,
      readLimit: NATIVE_OBSERVATION_READ_LIMIT,
      selectedObservationCount: selections.length,
      excludedObservationCount: selections.filter((selection) => selection.status === "EXCLUDED").length,
      supersededObservationCount: lineage.filter((entry) => entry.selectionStatus === "SUPERSEDED").length,
      qualityEvidenceRevisionCount: read.rows.reduce((sum, row) => sum + row.qualityEvidence.length, 0),
      selectedObservations: selections.map((selection) => ({
        clanTag: selection.clanTag,
        observationId: selection.observation.id,
        rosterFingerprint: selection.observation.rosterFingerprint,
        observedAtIso: iso(selection.observation.observedAt),
        qualityEvidenceId: selection.evidence?.id ?? null,
        qualityFingerprint: selection.evidence?.sourceQualityFingerprint ?? null,
        status: selection.status,
        reasonCode: selection.reasonCode,
      })),
      lineage,
      defermentScope: input.defermentScope ?? null,
      authorityLimitations: [
        "exact_war_binding_unavailable",
        "source_generation_unbound",
        "quality_evidence_is_diagnostic_only",
        "authority_remains_unknown_unverified",
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
    return {
      ...withMetadata,
      contentFingerprint: computeNativeReferenceCandidateContentFingerprint(withMetadata),
    };
  }
}
