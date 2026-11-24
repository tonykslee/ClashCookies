import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { NativeHeatMapRefObservationCandidateService } from "./NativeHeatMapRefObservationCandidateService";
import {
  NATIVE_REFERENCE_BUCKET_REGISTRY,
  NATIVE_REFERENCE_MIN_DIRECT_WEIGHT_ANCHORS,
  NATIVE_REFERENCE_PROFILE_ID,
  NATIVE_REFERENCE_PROFILE_VERSION,
  NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD,
  NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY,
  NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST,
  validateNativeReferenceCandidateArtifact,
  type NativeReferenceCandidateArtifact,
  type NativeReferenceBandDiagnostic,
} from "../helper/nativeHeatMapRefCandidate";

export const NATIVE_REFERENCE_POLICY_ID = "native-provisional-five-clan";
export const NATIVE_REFERENCE_POLICY_VERSION = "native-provisional-v1";
export const NATIVE_REFERENCE_AUTHORITY_STATUS = "UNKNOWN_UNVERIFIED" as const;

type PreviewTarget = {
  bandOrdinal: number;
  bucketId: string;
  status: "SUPPORTED" | "UNKNOWN";
  targetCount: number | null;
  qualifyingClanCount: number;
  sampleCount: number;
  reasonCode: string | null;
};

export type NativeHeatMapReferenceGenerationPreview = {
  profileId: string;
  profileVersion: string;
  policyId: string;
  policyVersion: string;
  sampleThreshold: number;
  minimumDirectWeightAnchors: number;
  authorityStatus: typeof NATIVE_REFERENCE_AUTHORITY_STATUS;
  evaluationAt: Date;
  eraPolicyId: string;
  eraPolicyVersion: string;
  eraStart: Date;
  eraEnd: Date;
  bucketDefinitionFingerprint: string;
  sourceLineageFingerprint: string;
  contentFingerprint: string;
  candidateFingerprint: string;
  sourceCategory: string;
  evidenceTrust: string;
  coverageStatus: "VERIFIED" | "TRUNCATED" | "AMBIGUOUS";
  bands: readonly NativeReferenceCandidateArtifact["bandDefinitions"][number][];
  buckets: readonly { bucketId: string; sourceBucketIds: readonly string[] }[];
  targets: readonly PreviewTarget[];
  lineage: readonly {
    ordinal: number;
    observationId: string;
    observationContentFingerprint: string;
    role: string;
    inputDigest: string;
    qualityEvidenceIds: readonly string[];
    weightProvenance: Readonly<{ RAW: number; DEFERRED: number; ESTIMATED: number; UNRESOLVED: number }>;
  }[];
};

export type NativeHeatMapReferenceRead = {
  status: "CURRENT" | "UNKNOWN";
  informationalOnly: true;
  reason: string | null;
  generationId: string | null;
  fenceToken: bigint | null;
  profileVersion: string;
  policyVersion: string;
  sampleThreshold: number | null;
  evaluationAt: Date | null;
  createdAt: Date | null;
  targets: readonly {
    bandOrdinal: number;
    bucketId: string;
    status: "SUPPORTED" | "UNKNOWN";
    targetCount: number | null;
    qualifyingClanCount: number;
    sampleCount: number;
    reasonCode: string | null;
  }[];
  bands: readonly { weightMinInclusive: number; weightMaxInclusive: number }[];
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalNativeReferenceContent(value: {
  profileId: string;
  profileVersion: string;
  policyId: string;
  policyVersion: string;
  sampleThreshold: number;
  minimumDirectWeightAnchors: number;
  authorityStatus: string;
  sourceCategory: string;
  evidenceTrust: string;
  coverageStatus: string;
  evaluationAtIso: string;
  eraPolicy: { policyId: string; policyVersion: string; eraStartIso: string; eraEndIso: string };
  bucketDefinitionFingerprint: string;
  sourceLineageFingerprint: string;
  candidateFingerprint: string | null;
  bands: readonly { ordinal?: number; weightMinInclusive: number; weightMaxInclusive: number }[];
  buckets: readonly { ordinal?: number; bucketId: string; sourceBucketIds: unknown }[];
  targets: readonly { bandOrdinal: number; bucketId: string; status: string; targetCount: number | null; qualifyingClanCount: number; sampleCount: number; reasonCode: string | null }[];
  lineage: readonly { ordinal: number; observationId: string; observationContentFingerprint: string; role: string; inputDigest: string; qualityEvidenceIds: unknown; weightProvenance: unknown }[];
}): unknown {
  return {
    profileId: value.profileId,
    profileVersion: value.profileVersion,
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    sampleThreshold: value.sampleThreshold,
    minimumDirectWeightAnchors: value.minimumDirectWeightAnchors,
    authorityStatus: value.authorityStatus,
    sourceCategory: value.sourceCategory,
    evidenceTrust: value.evidenceTrust,
    coverageStatus: value.coverageStatus,
    evaluationAtIso: value.evaluationAtIso,
    eraPolicy: value.eraPolicy,
    bucketDefinitionFingerprint: value.bucketDefinitionFingerprint,
    sourceLineageFingerprint: value.sourceLineageFingerprint,
    candidateFingerprint: value.candidateFingerprint,
    bands: [...value.bands].sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0)).map(({ weightMinInclusive, weightMaxInclusive }) => ({ weightMinInclusive, weightMaxInclusive })),
    buckets: [...value.buckets].sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0)).map(({ bucketId, sourceBucketIds }) => ({ bucketId, sourceBucketIds })),
    targets: [...value.targets].sort((left, right) => left.bandOrdinal - right.bandOrdinal || left.bucketId.localeCompare(right.bucketId)).map(({ bandOrdinal, bucketId, status, targetCount, qualifyingClanCount, sampleCount, reasonCode }) => ({ bandOrdinal, bucketId, status, targetCount, qualifyingClanCount, sampleCount, reasonCode })),
    lineage: [...value.lineage].sort((left, right) => left.ordinal - right.ordinal).map(({ ordinal, observationId, observationContentFingerprint, role, inputDigest, qualityEvidenceIds, weightProvenance }) => ({ ordinal, observationId, observationContentFingerprint, role, inputDigest, qualityEvidenceIds, weightProvenance })),
  };
}

function canonicalNativeReferenceContentFingerprint(value: Parameters<typeof canonicalNativeReferenceContent>[0]): string {
  return sha256(canonicalNativeReferenceContent(value));
}

function parseIso(value: string | null | undefined): Date {
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) throw new Error("native reference preview has invalid date metadata");
  return date;
}

function diagnosticForBand(
  candidate: NativeReferenceCandidateArtifact,
  bandOrdinal: number,
): NativeReferenceBandDiagnostic {
  const diagnostic = candidate.diagnostics[bandOrdinal];
  if (!diagnostic) throw new Error(`native reference preview is missing band diagnostic ${bandOrdinal}`);
  return diagnostic;
}

/** Purpose: convert the validated candidate artifact into immutable, publication-ready native rows. */
export function buildNativeHeatMapReferencePreview(
  candidate: NativeReferenceCandidateArtifact,
  input?: { requestKey?: string; policyVersion?: string },
): NativeHeatMapReferenceGenerationPreview {
  if (!validateNativeReferenceCandidateArtifact(candidate)) {
    throw new Error("native reference preview requires a validated candidate artifact");
  }
  if (candidate.sampleThreshold !== NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD || candidate.sampleQualityPolicy.minimumDirectWeightAnchors !== NATIVE_REFERENCE_MIN_DIRECT_WEIGHT_ANCHORS) {
    throw new Error("native reference preview does not match the approved provisional 2-anchor/5-clan policy");
  }
  const policyVersion = input?.policyVersion ?? NATIVE_REFERENCE_POLICY_VERSION;
  const aggregation = candidate.observationAggregation;
  const selected = aggregation?.lineage ?? [];
  const selectionStatusByObservationId = new Map(
    (aggregation?.selectedObservations ?? []).map((row) => [row.observationId, row.status]),
  );
  const lineage = selected.map((row, ordinal) => ({
    ordinal,
    observationId: row.observationId,
    observationContentFingerprint: row.rosterFingerprint,
    role: row.selectionStatus === "SELECTED" && selectionStatusByObservationId.get(row.observationId) === "QUALIFYING"
      ? "SELECTED_QUALIFYING"
      : row.selectionStatus,
    inputDigest: sha256({
      observationId: row.observationId,
      rosterFingerprint: row.rosterFingerprint,
      observedAtIso: row.observedAtIso,
      qualityEvidenceIds: row.qualityEvidenceIds,
    }),
    qualityEvidenceIds: [...row.qualityEvidenceIds],
    weightProvenance: {
      RAW: row.weightProvenance?.RAW ?? 0,
      DEFERRED: row.weightProvenance?.DEFERRED ?? 0,
      ESTIMATED: row.weightProvenance?.ESTIMATED ?? 0,
      UNRESOLVED: row.weightProvenance?.UNRESOLVED ?? 0,
    },
  }));
  const bands = candidate.bandDefinitions.map((band) => ({ ...band }));
  const buckets = candidate.bucketRegistry.map((bucket) => ({
    bucketId: bucket.id,
    sourceBucketIds: [...bucket.sourceBuckets],
  }));
  const targets: PreviewTarget[] = [];
  for (let bandOrdinal = 0; bandOrdinal < bands.length; bandOrdinal += 1) {
    const diagnostic = diagnosticForBand(candidate, bandOrdinal);
    for (const target of diagnostic.normalizedTargets) {
      const supported = diagnostic.status === "SUPPORTED" && target.status === "SUPPORTED";
      targets.push({
        bandOrdinal,
        bucketId: target.bucketId,
        status: supported ? "SUPPORTED" : "UNKNOWN",
        targetCount: supported ? target.targetCount : null,
        qualifyingClanCount: diagnostic.distinctQualifyingClanCount,
        sampleCount: diagnostic.qualifyingRosterCount,
        reasonCode: supported ? null : target.reasonCode ?? diagnostic.reasonCode,
      });
    }
  }
  const sourceLineageFingerprint = sha256(lineage);
  const content = {
    profileId: candidate.profileId || NATIVE_REFERENCE_PROFILE_ID,
    profileVersion: candidate.profileVersion || NATIVE_REFERENCE_PROFILE_VERSION,
    policyId: NATIVE_REFERENCE_POLICY_ID,
    policyVersion,
    sampleThreshold: candidate.sampleThreshold || NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD,
    minimumDirectWeightAnchors: NATIVE_REFERENCE_MIN_DIRECT_WEIGHT_ANCHORS,
    authorityStatus: NATIVE_REFERENCE_AUTHORITY_STATUS,
    evaluationAtIso: candidate.evaluationAtIso,
    eraPolicy: candidate.eraPolicy,
    bucketDefinitionFingerprint: candidate.bucketDefinitionFingerprint,
    sourceLineageFingerprint,
    candidateFingerprint: candidate.contentFingerprint,
    sourceCategory: candidate.sourceCategory,
    evidenceTrust: candidate.evidenceTrust,
    coverageStatus: aggregation?.coverageStatus ?? "VERIFIED",
    bands,
    buckets,
    targets,
    lineage,
  };
  return {
    profileId: content.profileId,
    profileVersion: content.profileVersion,
    policyId: content.policyId,
    policyVersion: content.policyVersion,
    sampleThreshold: content.sampleThreshold,
    minimumDirectWeightAnchors: content.minimumDirectWeightAnchors,
    authorityStatus: content.authorityStatus,
    evaluationAt: parseIso(candidate.evaluationAtIso),
    eraPolicyId: candidate.eraPolicy.policyId,
    eraPolicyVersion: candidate.eraPolicy.policyVersion,
    eraStart: parseIso(candidate.eraPolicy.eraStartIso),
    eraEnd: parseIso(candidate.eraPolicy.eraEndIso),
    bucketDefinitionFingerprint: content.bucketDefinitionFingerprint,
    sourceLineageFingerprint,
    contentFingerprint: canonicalNativeReferenceContentFingerprint(content),
    candidateFingerprint: candidate.contentFingerprint,
    sourceCategory: content.sourceCategory,
    evidenceTrust: content.evidenceTrust,
    coverageStatus: content.coverageStatus,
    bands,
    buckets,
    targets,
    lineage,
  };
}

function lockKey(profileId: string, policyVersion: string): string {
  return `native-heatmap-reference:${profileId}:${policyVersion}`;
}

function sameExpected(actual: string | null, expected: string | null | undefined): boolean {
  return expected === undefined || actual === expected;
}

function persistedContentFingerprint(generation: {
  profileId: string;
  profileVersion: string;
  policyId: string;
  policyVersion: string;
  sampleThreshold: number;
  minimumDirectWeightAnchors: number;
  authorityStatus: string;
  sourceCategory: string;
  evidenceTrust: string;
  coverageStatus: string;
  evaluationAt: Date;
  eraPolicyId: string;
  eraPolicyVersion: string;
  eraStart: Date;
  eraEnd: Date;
  bucketDefinitionFingerprint: string;
  sourceLineageFingerprint: string;
  candidateFingerprint: string | null;
  bands: readonly { ordinal: number; weightMinInclusive: number; weightMaxInclusive: number }[];
  buckets: readonly { ordinal: number; bucketId: string; sourceBucketIds: unknown }[];
  targets: readonly { bandOrdinal: number; bucketId: string; status: string; targetCount: number | null; qualifyingClanCount: number; sampleCount: number; reasonCode: string | null }[];
  lineage: readonly { ordinal: number; observationId: string; observationContentFingerprint: string; role: string; inputDigest: string; qualityEvidenceIds: unknown; weightProvenance: unknown }[];
}): string {
  return canonicalNativeReferenceContentFingerprint({
    profileId: generation.profileId,
    profileVersion: generation.profileVersion,
    policyId: generation.policyId,
    policyVersion: generation.policyVersion,
    sampleThreshold: generation.sampleThreshold,
    minimumDirectWeightAnchors: generation.minimumDirectWeightAnchors,
    authorityStatus: generation.authorityStatus,
    sourceCategory: generation.sourceCategory,
    evidenceTrust: generation.evidenceTrust,
    coverageStatus: generation.coverageStatus,
    evaluationAtIso: generation.evaluationAt.toISOString(),
    eraPolicy: {
      policyId: generation.eraPolicyId,
      policyVersion: generation.eraPolicyVersion,
      eraStartIso: generation.eraStart.toISOString(),
      eraEndIso: generation.eraEnd.toISOString(),
    },
    bucketDefinitionFingerprint: generation.bucketDefinitionFingerprint,
    sourceLineageFingerprint: generation.sourceLineageFingerprint,
    candidateFingerprint: generation.candidateFingerprint,
    bands: generation.bands,
    buckets: generation.buckets,
    targets: generation.targets,
    lineage: generation.lineage,
  });
}

export function validatePublishableCandidate(candidate: NativeReferenceCandidateArtifact): string | null {
  if (candidate.sourceCategory !== NATIVE_REFERENCE_RETAINED_OBSERVATION_SOURCE_CATEGORY) return "publication_requires_retained_observation_source";
  if (candidate.evidenceTrust !== NATIVE_REFERENCE_RETAINED_OBSERVATION_EVIDENCE_TRUST) return "publication_requires_retained_observation_trust";
  const aggregation = candidate.observationAggregation;
  if (!aggregation || aggregation.coverageStatus !== "VERIFIED") return "publication_requires_verified_local_coverage";
  if (aggregation.lineage.length === 0 || aggregation.selectedObservations.length === 0) return "publication_requires_nonempty_lineage";
  if (aggregation.lineage.some((row) => !row.observationId.trim() || !row.rosterFingerprint.trim() || row.qualityEvidenceIds.length === 0)) return "publication_requires_quality_evidence_lineage";
  if (candidate.overallStatus === "UNKNOWN" || !candidate.diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED" && diagnostic.distinctQualifyingClanCount >= candidate.sampleThreshold)) return "publication_requires_supported_band";
  if (candidate.sourceAuthority.referencePublicationStatus === "VERIFIED") return "publication_authority_must_remain_unknown_unverified";
  return null;
}

export class NativeHeatMapReferencePublicationService {
  constructor(
    private readonly db: PrismaClient = prisma,
    private readonly revalidateCandidate: (candidate: NativeReferenceCandidateArtifact) => Promise<NativeReferenceCandidateArtifact> = async (candidate) => new NativeHeatMapRefObservationCandidateService(db).generate({
      evaluationAt: candidate.evaluationAtIso,
      eraPolicy: candidate.eraPolicy,
      sampleThreshold: candidate.sampleThreshold,
      bandDefinitions: candidate.bandDefinitions,
    }),
  ) {}

  private async recordRejectedPublication(
    input: { preview: NativeHeatMapReferenceGenerationPreview; requestKey: string },
    reason: string,
  ): Promise<{ published: boolean; idempotent: boolean; generationId: string | null; fenceToken: bigint | null; reason: string }> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(input.preview.profileId, input.preview.policyVersion)}, 0))`;
      const head = await tx.nativeHeatMapReferenceHead.findUnique({
        where: { profileId_policyVersion: { profileId: input.preview.profileId, policyVersion: input.preview.policyVersion } },
      });
      await tx.nativeHeatMapReferencePublicationEvent.create({
        data: {
          profileId: input.preview.profileId,
          policyVersion: input.preview.policyVersion,
          eventType: "REJECTED_INVALID",
          requestKey: input.requestKey,
          reasonCode: reason,
          contentFingerprint: input.preview.contentFingerprint,
          previousGenerationId: head?.generationId ?? null,
          previousFenceToken: head?.fenceToken ?? 0n,
        },
      });
      return { published: false, idempotent: false, generationId: null, fenceToken: head?.fenceToken ?? 0n, reason };
    });
  }

  async preview(candidate: NativeReferenceCandidateArtifact, requestKey?: string) {
    const preview = buildNativeHeatMapReferencePreview(candidate, { requestKey });
    return { ...preview, requestKey: requestKey ?? null, publicationAllowed: false };
  }

  /** Purpose: publish one immutable generation under a native advisory lock; this never writes legacy references. */
  async publish(input: {
    candidate: NativeReferenceCandidateArtifact;
    preview: NativeHeatMapReferenceGenerationPreview;
    requestKey: string;
    actorDiscordUserId?: string | null;
    expectedGenerationId: string | null;
    expectedFenceToken: bigint | number;
  }): Promise<{ published: boolean; idempotent: boolean; generationId: string | null; fenceToken: bigint | null; reason?: string }> {
    if (!input.requestKey.trim()) throw new Error("native reference publication requires requestKey");
    if (input.expectedGenerationId === undefined || input.expectedFenceToken === undefined) throw new Error("native reference publication requires expectedGenerationId and expectedFenceToken");
    const candidateReason = validatePublishableCandidate(input.candidate);
    if (candidateReason) return this.recordRejectedPublication(input, candidateReason);
    let liveCandidate: NativeReferenceCandidateArtifact;
    try {
      liveCandidate = await this.revalidateCandidate(input.candidate);
    } catch {
      return this.recordRejectedPublication(input, "retained_observation_revalidation_failed");
    }
    if (liveCandidate.contentFingerprint !== input.candidate.contentFingerprint || buildNativeHeatMapReferencePreview(liveCandidate, { requestKey: input.requestKey }).contentFingerprint !== input.preview.contentFingerprint) {
      return this.recordRejectedPublication(input, "retained_observation_revalidation_mismatch");
    }
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(input.preview.profileId, input.preview.policyVersion)}, 0))`;
      const head = await tx.nativeHeatMapReferenceHead.findUnique({
        where: { profileId_policyVersion: { profileId: input.preview.profileId, policyVersion: input.preview.policyVersion } },
      });
      const existing = await tx.nativeHeatMapReferenceGeneration.findUnique({
        where: { profileId_policyVersion_requestKey: { profileId: input.preview.profileId, policyVersion: input.preview.policyVersion, requestKey: input.requestKey } },
      });
      if (existing) {
        const eventType = existing.contentFingerprint === input.preview.contentFingerprint ? "PUBLISHED" : "REJECTED_CONFLICT";
        await tx.nativeHeatMapReferencePublicationEvent.create({ data: {
          profileId: input.preview.profileId,
          policyVersion: input.preview.policyVersion,
          generationId: existing.generationId,
          eventType,
          requestKey: input.requestKey,
          reasonCode: eventType === "PUBLISHED" && head?.generationId === existing.generationId && input.expectedGenerationId === existing.generationId && head.fenceToken === input.expectedFenceToken ? "exact_retry" : "request_key_content_conflict",
          contentFingerprint: input.preview.contentFingerprint,
        } });
        return existing.contentFingerprint === input.preview.contentFingerprint && head?.generationId === existing.generationId && input.expectedGenerationId === existing.generationId && head.fenceToken === input.expectedFenceToken
          ? { published: true, idempotent: true, generationId: existing.generationId, fenceToken: head?.fenceToken ?? 0n }
          : { published: false, idempotent: false, generationId: existing.generationId, fenceToken: head?.fenceToken ?? 0n, reason: existing.contentFingerprint === input.preview.contentFingerprint ? "request_generation_not_current" : "request_key_content_conflict" };
      }
      const currentGenerationId = head?.generationId ?? null;
      const currentFence = head?.fenceToken ?? 0n;
      if (!sameExpected(currentGenerationId, input.expectedGenerationId) || currentFence !== BigInt(input.expectedFenceToken)) {
        await tx.nativeHeatMapReferencePublicationEvent.create({ data: {
          profileId: input.preview.profileId,
          policyVersion: input.preview.policyVersion,
          eventType: "REJECTED_STALE",
          requestKey: input.requestKey,
          reasonCode: "expected_head_or_fence_mismatch",
          contentFingerprint: input.preview.contentFingerprint,
          previousGenerationId: currentGenerationId,
          previousFenceToken: currentFence,
        } });
        return { published: false, idempotent: false, generationId: null, fenceToken: currentFence, reason: "expected_head_or_fence_mismatch" };
      }
      const currentGeneration = currentGenerationId
        ? await tx.nativeHeatMapReferenceGeneration.findUnique({ where: { generationId: currentGenerationId }, select: { evaluationAt: true } })
        : null;
      if (currentGeneration && input.preview.evaluationAt.getTime() < currentGeneration.evaluationAt.getTime()) {
        await tx.nativeHeatMapReferencePublicationEvent.create({ data: {
          profileId: input.preview.profileId,
          policyVersion: input.preview.policyVersion,
          eventType: "REJECTED_STALE",
          requestKey: input.requestKey,
          reasonCode: "evaluation_cutoff_older_than_head",
          contentFingerprint: input.preview.contentFingerprint,
          previousGenerationId: currentGenerationId,
          previousFenceToken: currentFence,
        } });
        return { published: false, idempotent: false, generationId: null, fenceToken: currentFence, reason: "evaluation_cutoff_older_than_head" };
      }
      const generation = await tx.nativeHeatMapReferenceGeneration.create({ data: {
        profileId: input.preview.profileId,
        profileVersion: input.preview.profileVersion,
        policyId: input.preview.policyId,
        policyVersion: input.preview.policyVersion,
        sampleThreshold: input.preview.sampleThreshold,
        minimumDirectWeightAnchors: input.preview.minimumDirectWeightAnchors,
        authorityStatus: input.preview.authorityStatus,
        sourceCategory: input.preview.sourceCategory,
        evidenceTrust: input.preview.evidenceTrust,
        coverageStatus: input.preview.coverageStatus,
        evaluationAt: input.preview.evaluationAt,
        eraPolicyId: input.preview.eraPolicyId,
        eraPolicyVersion: input.preview.eraPolicyVersion,
        eraStart: input.preview.eraStart,
        eraEnd: input.preview.eraEnd,
        status: "VERIFIED",
        bucketDefinitionFingerprint: input.preview.bucketDefinitionFingerprint,
        sourceLineageFingerprint: input.preview.sourceLineageFingerprint,
        contentFingerprint: input.preview.contentFingerprint,
        requestKey: input.requestKey,
        candidateFingerprint: input.preview.candidateFingerprint,
        verifiedAt: new Date(),
      } });
      await tx.nativeHeatMapReferenceGenerationBand.createMany({ data: input.preview.bands.map((band, ordinal) => ({ generationId: generation.generationId, ordinal, ...band })) });
      await tx.nativeHeatMapReferenceGenerationBucket.createMany({ data: input.preview.buckets.map((bucket, ordinal) => ({ generationId: generation.generationId, ordinal, bucketId: bucket.bucketId, sourceBucketIds: bucket.sourceBucketIds })) });
      await tx.nativeHeatMapReferenceTarget.createMany({ data: input.preview.targets.map((target) => ({ generationId: generation.generationId, ...target })) });
      await tx.nativeHeatMapReferenceLineage.createMany({ data: input.preview.lineage.map((row) => ({ generationId: generation.generationId, ...row, qualityEvidenceIds: row.qualityEvidenceIds, weightProvenance: row.weightProvenance })) });
      const persisted = await tx.nativeHeatMapReferenceGeneration.findUnique({
        where: { generationId: generation.generationId },
        include: { bands: true, buckets: true, targets: true, lineage: true },
      });
      if (!persisted || persisted.bands.length !== input.preview.bands.length || persisted.buckets.length !== input.preview.buckets.length || persisted.targets.length !== input.preview.targets.length || persisted.lineage.length !== input.preview.lineage.length || persistedContentFingerprint(persisted) !== input.preview.contentFingerprint) {
        throw new Error("native reference persisted generation integrity verification failed");
      }
      if (persisted.targets.some((target) => target.status === "UNKNOWN" ? target.targetCount !== null || !target.reasonCode : target.targetCount === null || !Number.isSafeInteger(target.targetCount) || target.targetCount < 0 || target.qualifyingClanCount < input.preview.sampleThreshold || target.sampleCount < input.preview.sampleThreshold)) {
        throw new Error("native reference persisted target integrity verification failed");
      }
      if (persisted.bands.some((band) => persisted.targets.filter((target) => target.bandOrdinal === band.ordinal && target.status === "SUPPORTED").reduce((sum, target) => sum + (target.targetCount ?? 0), 0) !== 50 && persisted.targets.some((target) => target.bandOrdinal === band.ordinal && target.status === "SUPPORTED"))) {
        throw new Error("native reference supported band does not sum to 50");
      }
      const nextFence = currentFence + 1n;
      const event = await tx.nativeHeatMapReferencePublicationEvent.create({ data: {
        profileId: input.preview.profileId,
        policyVersion: input.preview.policyVersion,
        generationId: generation.generationId,
        eventType: "PUBLISHED",
        previousGenerationId: currentGenerationId,
        newGenerationId: generation.generationId,
        previousFenceToken: currentFence,
        newFenceToken: nextFence,
        actorDiscordUserId: input.actorDiscordUserId ?? null,
        requestKey: input.requestKey,
        contentFingerprint: input.preview.contentFingerprint,
      } });
      await tx.nativeHeatMapReferenceHead.upsert({
        where: { profileId_policyVersion: { profileId: input.preview.profileId, policyVersion: input.preview.policyVersion } },
        create: { profileId: input.preview.profileId, policyVersion: input.preview.policyVersion, generationId: generation.generationId, generationProfileId: generation.profileId, generationPolicyVersion: generation.policyVersion, fenceToken: nextFence, lastPublicationEventId: event.eventId },
        update: { generationId: generation.generationId, generationProfileId: generation.profileId, generationPolicyVersion: generation.policyVersion, fenceToken: nextFence, lastPublicationEventId: event.eventId },
      });
      return { published: true, idempotent: false, generationId: generation.generationId, fenceToken: nextFence };
    });
  }

  async readCurrent(input?: { profileId?: string; policyVersion?: string }): Promise<NativeHeatMapReferenceRead> {
    const profileId = input?.profileId ?? NATIVE_REFERENCE_PROFILE_ID;
    const policyVersion = input?.policyVersion ?? NATIVE_REFERENCE_POLICY_VERSION;
    return this.db.$transaction(async (tx) => {
      const head = await tx.nativeHeatMapReferenceHead.findUnique({ where: { profileId_policyVersion: { profileId, policyVersion } } });
      if (!head?.generationId) return { status: "UNKNOWN", informationalOnly: true, reason: "native_head_unavailable", generationId: null, fenceToken: head?.fenceToken ?? null, profileVersion: NATIVE_REFERENCE_PROFILE_VERSION, policyVersion, sampleThreshold: null, evaluationAt: null, createdAt: null, targets: [], bands: [] };
      if (head.generationProfileId !== profileId || head.generationPolicyVersion !== policyVersion) return { status: "UNKNOWN", informationalOnly: true, reason: "native_head_profile_policy_mismatch", generationId: head.generationId, fenceToken: head.fenceToken, profileVersion: NATIVE_REFERENCE_PROFILE_VERSION, policyVersion, sampleThreshold: null, evaluationAt: null, createdAt: null, targets: [], bands: [] };
      const generation = await tx.nativeHeatMapReferenceGeneration.findUnique({ where: { generationId: head.generationId }, include: { targets: true, bands: true, buckets: true, lineage: true } });
      if (!generation || generation.profileId !== profileId || generation.policyVersion !== policyVersion || generation.status !== "VERIFIED" || generation.authorityStatus !== NATIVE_REFERENCE_AUTHORITY_STATUS) return { status: "UNKNOWN", informationalOnly: true, reason: "native_generation_unverified", generationId: head.generationId, fenceToken: head.fenceToken, profileVersion: generation?.profileVersion ?? NATIVE_REFERENCE_PROFILE_VERSION, policyVersion, sampleThreshold: generation?.sampleThreshold ?? null, evaluationAt: generation?.evaluationAt ?? null, createdAt: generation?.createdAt ?? null, targets: [], bands: [] };
      const expectedTargetCount = generation.bands.length * generation.buckets.length;
      const targetsValid = generation.targets.length === expectedTargetCount && generation.targets.every((target) => target.status === "SUPPORTED" ? Number.isSafeInteger(target.targetCount) && (target.targetCount ?? -1) >= 0 && target.reasonCode === null : target.targetCount === null && Boolean(target.reasonCode));
      const supportedBandSumsValid = generation.bands.every((band) => {
        const bandTargets = generation.targets.filter((target) => target.bandOrdinal === band.ordinal);
        return bandTargets.some((target) => target.status === "SUPPORTED")
          ? bandTargets.filter((target) => target.status === "SUPPORTED").reduce((sum, target) => sum + (target.targetCount ?? 0), 0) === 50
          : true;
      });
      if (!targetsValid || !supportedBandSumsValid || persistedContentFingerprint(generation) !== generation.contentFingerprint) return { status: "UNKNOWN", informationalOnly: true, reason: "native_generation_integrity_mismatch", generationId: head.generationId, fenceToken: head.fenceToken, profileVersion: generation.profileVersion, policyVersion, sampleThreshold: generation.sampleThreshold, evaluationAt: generation.evaluationAt, createdAt: generation.createdAt, targets: [], bands: [] };
      return { status: "CURRENT", informationalOnly: true, reason: null, generationId: generation.generationId, fenceToken: head.fenceToken, profileVersion: generation.profileVersion, policyVersion: generation.policyVersion, sampleThreshold: generation.sampleThreshold, evaluationAt: generation.evaluationAt, createdAt: generation.createdAt, bands: [...generation.bands].sort((left, right) => left.ordinal - right.ordinal).map((band) => ({ weightMinInclusive: band.weightMinInclusive, weightMaxInclusive: band.weightMaxInclusive })), targets: [...generation.targets].sort((left, right) => left.bandOrdinal - right.bandOrdinal || left.bucketId.localeCompare(right.bucketId)).map((target) => ({ bandOrdinal: target.bandOrdinal, bucketId: target.bucketId, status: target.status, targetCount: target.targetCount, qualifyingClanCount: target.qualifyingClanCount, sampleCount: target.sampleCount, reasonCode: target.reasonCode })) };
    }, { isolationLevel: "RepeatableRead" });
  }

  async rollback(input: { profileId?: string; policyVersion?: string; expectedGenerationId: string; expectedFenceToken: bigint | number; actorDiscordUserId?: string | null }) {
    const profileId = input.profileId ?? NATIVE_REFERENCE_PROFILE_ID;
    const policyVersion = input.policyVersion ?? NATIVE_REFERENCE_POLICY_VERSION;
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(profileId, policyVersion)}, 0))`;
      const head = await tx.nativeHeatMapReferenceHead.findUnique({ where: { profileId_policyVersion: { profileId, policyVersion } } });
      if (!head || head.generationId !== input.expectedGenerationId || head.fenceToken !== BigInt(input.expectedFenceToken)) return { rolledBack: false, reason: "expected_head_or_fence_mismatch" };
      const nextFence = head.fenceToken + 1n;
      const publication = await tx.nativeHeatMapReferencePublicationEvent.findFirst({
        where: { profileId, policyVersion, eventType: "PUBLISHED", newGenerationId: head.generationId },
        orderBy: [{ createdAt: "asc" }, { eventId: "asc" }],
      });
      let prior = null;
      if (publication?.previousGenerationId) {
        const candidate = await tx.nativeHeatMapReferenceGeneration.findUnique({ where: { generationId: publication.previousGenerationId }, include: { bands: true, buckets: true, targets: true, lineage: true } });
        if (candidate && candidate.profileId === profileId && candidate.policyVersion === policyVersion && candidate.status === "VERIFIED" && candidate.authorityStatus === NATIVE_REFERENCE_AUTHORITY_STATUS && candidate.targets.length === candidate.bands.length * candidate.buckets.length && persistedContentFingerprint(candidate) === candidate.contentFingerprint) {
          prior = candidate;
        }
      }
      if (!prior) {
        const event = await tx.nativeHeatMapReferencePublicationEvent.create({ data: { profileId, policyVersion, generationId: null, eventType: "ROLLBACK", previousGenerationId: head.generationId, newGenerationId: null, previousFenceToken: head.fenceToken, newFenceToken: nextFence, actorDiscordUserId: input.actorDiscordUserId ?? null, reasonCode: "deactivated_first_publication" } });
        await tx.nativeHeatMapReferenceHead.update({ where: { profileId_policyVersion: { profileId, policyVersion } }, data: { generationId: null, generationProfileId: null, generationPolicyVersion: null, fenceToken: nextFence, lastPublicationEventId: event.eventId } });
        return { rolledBack: true, generationId: null, fenceToken: nextFence, reason: "deactivated_first_publication" };
      }
      const event = await tx.nativeHeatMapReferencePublicationEvent.create({ data: { profileId, policyVersion, generationId: prior.generationId, eventType: "ROLLBACK", previousGenerationId: head.generationId, newGenerationId: prior.generationId, previousFenceToken: head.fenceToken, newFenceToken: nextFence, actorDiscordUserId: input.actorDiscordUserId ?? null, reasonCode: "operator_rollback", contentFingerprint: prior.contentFingerprint } });
      await tx.nativeHeatMapReferenceHead.update({ where: { profileId_policyVersion: { profileId, policyVersion } }, data: { generationId: prior.generationId, generationProfileId: prior.profileId, generationPolicyVersion: prior.policyVersion, fenceToken: nextFence, lastPublicationEventId: event.eventId } });
      return { rolledBack: true, generationId: prior.generationId, fenceToken: nextFence };
    });
  }
}

export const NATIVE_REFERENCE_BUCKET_REGISTRY_FOR_PUBLICATION = NATIVE_REFERENCE_BUCKET_REGISTRY;
