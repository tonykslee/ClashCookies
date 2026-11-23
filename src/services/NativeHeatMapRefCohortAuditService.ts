import { createHash } from "node:crypto";
import {
  evaluateNativeReferenceCohort,
  generateNativeHeatMapRefCandidate,
  NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD,
  NATIVE_REFERENCE_MIN_DIRECT_WEIGHT_ANCHORS,
  NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST,
  NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY,
  type NativeReferenceBandDefinition,
  type NativeReferenceCandidateArtifact,
  type NativeReferenceCohortEvaluation,
  type NativeReferenceEraPolicy,
} from "../helper/nativeHeatMapRefCandidate";
import { HEAT_MAP_REF_SEED_ROWS } from "./HeatMapRefSeedData";
import {
  NativeHeatMapRefObservationCandidateService,
  NATIVE_OBSERVATION_READ_LIMIT,
  type NativeHeatMapRefObservationCandidateContext,
} from "./NativeHeatMapRefObservationCandidateService";

export const NATIVE_COHORT_AUDIT_SCHEMA_VERSION = "native-cohort-qualification-audit-v1";
export const NATIVE_COHORT_AUDIT_POLICY_VERSION = "proposed-cohort-policy-v1";
export const NATIVE_COHORT_AUDIT_OWNER_POLICY_STATUS = "PROPOSED_NOT_OWNER_APPROVED" as const;

type CandidateInput = {
  evaluationAt: Date | string;
  eraPolicy: NativeReferenceEraPolicy;
  sampleThreshold?: number;
  bandDefinitions?: readonly NativeReferenceBandDefinition[];
  defermentScope?: { guildId: string; clanTag: string };
};

export type NativeCohortAuditBand = {
  band: NativeReferenceBandDefinition;
  status: "SUPPORTED" | "UNKNOWN";
  reasonCode: "supported" | "no_source" | "insufficient_source" | "invalid_evidence";
  qualifyingDistinctClanCount: number;
  excludedCount: number;
  excludedReasonCounts: Readonly<Record<string, number>>;
  resolvedWeightCounts: Readonly<{
    RAW: number;
    DEFERRED: number;
    ESTIMATED: number;
    UNRESOLVED: number;
  }>;
  evidenceQualityDistribution: Readonly<Record<string, number>>;
  uncertaintyAndCoverageGaps: readonly string[];
};

export type NativeCohortAuditSensitivityScenario = {
  minimumDirectWeightAnchors: number;
  minimumDistinctClansPerBand: number;
  overallStatus: NativeReferenceCandidateArtifact["overallStatus"];
  supportedBandCount: number;
  bands: readonly {
    band: NativeReferenceBandDefinition;
    status: "SUPPORTED" | "UNKNOWN";
    reasonCode: "supported" | "no_source" | "insufficient_source" | "invalid_evidence";
    qualifyingDistinctClanCount: number;
  }[];
};

export type NativeCohortQualificationAudit = {
  schemaVersion: string;
  policyVersion: string;
  ownerPolicyStatus: typeof NATIVE_COHORT_AUDIT_OWNER_POLICY_STATUS;
  sourceCategory: typeof NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY;
  evidenceTrust: typeof NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST;
  eraPolicy: NativeReferenceEraPolicy;
  evaluationAtIso: string;
  readLimit: number;
  coverageStatus: "VERIFIED" | "TRUNCATED" | "AMBIGUOUS";
  globalAmbiguityStatus: "NONE" | "AMBIGUOUS";
  aggregate: {
    observedSemanticSampleCount: number;
    selectedIndependentClanCount: number;
    supersededSemanticSampleCount: number;
    qualityRevisionCount: number;
    structurallyOrQualityExcludedSelectionCount: number;
    fullyResolvedRosterCount: number;
    inferenceDependentRosterCount: number;
    unresolvedRosterCount: number;
    calculationExcludedRosterCount: number;
    unattributedSelectionExclusionCount: number;
    unattributedCalculationExclusionCount: number;
  };
  selectionStageExclusions: {
    total: number;
    reasonCounts: Readonly<Record<string, number>>;
  };
  bands: readonly NativeCohortAuditBand[];
  sensitivity: readonly NativeCohortAuditSensitivityScenario[];
  policyProposals: {
    minimumDirectWeightAnchors: number;
    minimumDistinctClansPerBand: number;
    alternativesAreDiagnosticOnly: true;
  };
  authorityLimitations: readonly string[];
  sourceEvidenceFingerprint: string;
  contentFingerprint: string;
};

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value ?? null;
}

function sha256(value: unknown): string {
  const serialized = JSON.stringify(stableValue(value));
  return createHash("sha256").update(serialized).digest("hex");
}

function bandKey(band: NativeReferenceBandDefinition): string {
  return `${band.weightMinInclusive}:${band.weightMaxInclusive}`;
}

function sortedBands(bands: readonly NativeReferenceBandDefinition[]): NativeReferenceBandDefinition[] {
  return [...bands].sort((left, right) => left.weightMinInclusive - right.weightMinInclusive || left.weightMaxInclusive - right.weightMaxInclusive);
}

function countReasons(values: readonly { reasonCode: string | null }[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    if (!value.reasonCode) return counts;
    counts[value.reasonCode] = (counts[value.reasonCode] ?? 0) + 1;
    return counts;
  }, {});
}

function isInferenceDependent(roster: NativeHeatMapRefObservationCandidateContext["sourceRosters"][number]): boolean {
  return roster.members.some((member) => member.effectiveWeightStatus === "ESTIMATED");
}

function isUnresolved(roster: NativeHeatMapRefObservationCandidateContext["sourceRosters"][number]): boolean {
  return roster.members.some((member) => member.effectiveWeightStatus === "UNRESOLVED" || member.effectiveWeight === null);
}

function evaluateScenario(input: {
  context: NativeHeatMapRefObservationCandidateContext;
  bandDefinitions: readonly NativeReferenceBandDefinition[];
  eraPolicy: NativeReferenceEraPolicy;
  evaluationAt: Date | string;
  minimumDirectWeightAnchors: number;
  minimumDistinctClansPerBand: number;
}): NativeCohortAuditSensitivityScenario {
  if (input.context.artifact.observationAggregation?.coverageStatus !== "VERIFIED") {
    return {
      minimumDirectWeightAnchors: input.minimumDirectWeightAnchors,
      minimumDistinctClansPerBand: input.minimumDistinctClansPerBand,
      overallStatus: "UNKNOWN",
      supportedBandCount: 0,
      bands: sortedBands(input.bandDefinitions).map((band) => ({
        band,
        status: "UNKNOWN",
        reasonCode: "invalid_evidence",
        qualifyingDistinctClanCount: 0,
      })),
    };
  }
  const artifact = generateNativeHeatMapRefCandidate({
    sourceRosters: input.context.sourceRosters,
    bandDefinitions: input.bandDefinitions,
    eraPolicy: input.eraPolicy,
    evaluationAt: input.evaluationAt,
    sampleThreshold: input.minimumDistinctClansPerBand,
    minimumDirectWeightAnchors: input.minimumDirectWeightAnchors,
    sourceCategory: NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY,
    evidenceTrust: NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST,
  });
  return {
    minimumDirectWeightAnchors: input.minimumDirectWeightAnchors,
    minimumDistinctClansPerBand: input.minimumDistinctClansPerBand,
    overallStatus: artifact.overallStatus,
    supportedBandCount: artifact.diagnostics.filter((band) => band.status === "SUPPORTED").length,
    bands: artifact.diagnostics.map((diagnostic) => ({
      band: diagnostic.band,
      status: diagnostic.status,
      reasonCode: diagnostic.reasonCode,
      qualifyingDistinctClanCount: diagnostic.distinctQualifyingClanCount,
    })),
  };
}

function buildBandAudit(input: {
  artifact: NativeReferenceCandidateArtifact;
  cohort: NativeReferenceCohortEvaluation;
  bandDefinitions: readonly NativeReferenceBandDefinition[];
  authorityLimitations: readonly string[];
  selectionExclusionCount: number;
}): NativeCohortAuditBand[] {
  return sortedBands(input.bandDefinitions).map((band) => {
    const key = bandKey(band);
    const diagnostic = input.artifact.diagnostics.find((value) => bandKey(value.band) === key)!;
    const qualified = input.cohort.qualified.filter((value) => bandKey(value.band) === key);
    const exclusions = input.cohort.exclusions.filter((value) => value.bandAttribution === "INDEPENDENT" && value.bandKey === key);
    const evidenceQualityDistribution: Record<string, number> = { QUALIFYING: qualified.length };
    for (const exclusion of exclusions) {
      const label = `CALCULATION_EXCLUDED:${exclusion.reasonCode}`;
      evidenceQualityDistribution[label] = (evidenceQualityDistribution[label] ?? 0) + 1;
    }
    const gaps = [...input.authorityLimitations];
    if (input.selectionExclusionCount > 0) gaps.push("selection_stage_exclusions_not_band_attributable");
    if (input.artifact.observationAggregation?.coverageStatus !== "VERIFIED") gaps.push(`global_coverage_${input.artifact.observationAggregation?.coverageStatus.toLowerCase()}`);
    return {
      band,
      status: diagnostic.status,
      reasonCode: diagnostic.reasonCode,
      qualifyingDistinctClanCount: diagnostic.distinctQualifyingClanCount,
      excludedCount: diagnostic.excludedRosterCount,
      excludedReasonCounts: diagnostic.exclusionCounts,
      resolvedWeightCounts: diagnostic.resolvedWeightCounts,
      evidenceQualityDistribution,
      uncertaintyAndCoverageGaps: [...new Set(gaps)].sort(),
    };
  });
}

/** Purpose: produce a bounded, aggregate-only cohort readiness audit over retained observations. */
export class NativeHeatMapRefCohortAuditService {
  private readonly observationService: NativeHeatMapRefObservationCandidateService;

  constructor(observationService = new NativeHeatMapRefObservationCandidateService()) {
    this.observationService = observationService;
  }

  async generate(input: CandidateInput): Promise<NativeCohortQualificationAudit> {
    const bandDefinitions = input.bandDefinitions ?? HEAT_MAP_REF_SEED_ROWS.map((row) => ({
      weightMinInclusive: row.weightMinInclusive,
      weightMaxInclusive: row.weightMaxInclusive,
    }));
    const context = await this.observationService.generateWithContext({
      ...input,
      sampleThreshold: input.sampleThreshold ?? NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD,
      bandDefinitions,
    });
    const aggregation = context.artifact.observationAggregation!;
    const selectedRows = aggregation.selectedObservations;
    const selectionExclusions = selectedRows.filter((row) => row.status === "EXCLUDED");
    const fullyResolvedRosterCount = context.sourceRosters.filter((roster) => !isInferenceDependent(roster) && !isUnresolved(roster)).length;
    const inferenceDependentRosterCount = context.sourceRosters.filter((roster) => isInferenceDependent(roster) && !isUnresolved(roster)).length;
    const unresolvedRosterCount = context.sourceRosters.filter((roster) => isUnresolved(roster)).length;
    const cohort = evaluateNativeReferenceCohort({
      sourceRosters: context.sourceRosters,
      bandDefinitions,
      eraPolicy: input.eraPolicy,
      evaluationAt: input.evaluationAt,
      minimumDirectWeightAnchors: NATIVE_REFERENCE_MIN_DIRECT_WEIGHT_ANCHORS,
    });
    const authorityLimitations = [
      ...context.artifact.sourceAuthority.reasonCodes,
      ...aggregation.authorityLimitations,
    ];
    const bands = buildBandAudit({
      artifact: context.artifact,
      cohort,
      bandDefinitions,
      authorityLimitations,
      selectionExclusionCount: selectionExclusions.length,
    });
    const anchorThresholds = [1, NATIVE_REFERENCE_MIN_DIRECT_WEIGHT_ANCHORS, 3];
    const clanThresholds = [1, 5, NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD, 15];
    const sensitivity = anchorThresholds.flatMap((minimumDirectWeightAnchors) => clanThresholds.map((minimumDistinctClansPerBand) => evaluateScenario({
      context,
      bandDefinitions,
      eraPolicy: input.eraPolicy,
      evaluationAt: input.evaluationAt,
      minimumDirectWeightAnchors,
      minimumDistinctClansPerBand,
    })));
    const withoutFingerprint: Omit<NativeCohortQualificationAudit, "contentFingerprint"> = {
      schemaVersion: NATIVE_COHORT_AUDIT_SCHEMA_VERSION,
      policyVersion: NATIVE_COHORT_AUDIT_POLICY_VERSION,
      ownerPolicyStatus: NATIVE_COHORT_AUDIT_OWNER_POLICY_STATUS,
      sourceCategory: NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY,
      evidenceTrust: NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST,
      eraPolicy: input.eraPolicy,
      evaluationAtIso: new Date(input.evaluationAt).toISOString(),
      readLimit: NATIVE_OBSERVATION_READ_LIMIT,
      coverageStatus: aggregation.coverageStatus,
      globalAmbiguityStatus: aggregation.coverageStatus === "AMBIGUOUS" ? "AMBIGUOUS" as const : "NONE" as const,
      aggregate: {
        observedSemanticSampleCount: aggregation.lineage.length,
        selectedIndependentClanCount: selectedRows.length,
        supersededSemanticSampleCount: aggregation.supersededObservationCount,
        qualityRevisionCount: aggregation.qualityEvidenceRevisionCount,
        structurallyOrQualityExcludedSelectionCount: selectionExclusions.length,
        fullyResolvedRosterCount,
        inferenceDependentRosterCount,
        unresolvedRosterCount,
        calculationExcludedRosterCount: cohort.exclusions.length,
        unattributedSelectionExclusionCount: selectionExclusions.length,
        unattributedCalculationExclusionCount: cohort.exclusions.filter((value) => value.bandAttribution === "UNATTRIBUTABLE").length,
      },
      selectionStageExclusions: {
        total: selectionExclusions.length,
        reasonCounts: countReasons(selectionExclusions),
      },
      bands,
      sensitivity,
      policyProposals: {
        minimumDirectWeightAnchors: NATIVE_REFERENCE_MIN_DIRECT_WEIGHT_ANCHORS,
        minimumDistinctClansPerBand: NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD,
        alternativesAreDiagnosticOnly: true as const,
      },
      authorityLimitations: [...new Set(authorityLimitations)].sort(),
      sourceEvidenceFingerprint: context.artifact.sourceEvidenceFingerprint,
    };
    return {
      ...withoutFingerprint,
      contentFingerprint: computeNativeHeatMapRefCohortQualificationAuditFingerprint(withoutFingerprint),
    };
  }
}

export function computeNativeHeatMapRefCohortQualificationAuditFingerprint(
  audit: Omit<NativeCohortQualificationAudit, "contentFingerprint">,
): string {
  return sha256(audit);
}
