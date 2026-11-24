import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import {
  NATIVE_REFERENCE_BUCKET_REGISTRY,
  NATIVE_REFERENCE_MIN_DIRECT_WEIGHT_ANCHORS,
  NATIVE_REFERENCE_PROFILE_ID,
  NATIVE_REFERENCE_PROFILE_VERSION,
  NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD,
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
  bands: readonly NativeReferenceCandidateArtifact["bandDefinitions"][number][];
  buckets: readonly { bucketId: string; sourceBucketIds: readonly string[] }[];
  targets: readonly PreviewTarget[];
  lineage: readonly {
    ordinal: number;
    observationId: string;
    observationContentFingerprint: string;
    role: string;
    inputDigest: string;
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
      ? "ELIGIBLE_VERIFIED"
      : row.selectionStatus,
    inputDigest: sha256({
      observationId: row.observationId,
      rosterFingerprint: row.rosterFingerprint,
      observedAtIso: row.observedAtIso,
      qualityEvidenceIds: row.qualityEvidenceIds,
    }),
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
    contentFingerprint: sha256(content),
    candidateFingerprint: candidate.contentFingerprint,
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
  lineage: readonly { ordinal: number; observationId: string; observationContentFingerprint: string; role: string; inputDigest: string }[];
}): string {
  const bands = [...generation.bands].sort((left, right) => left.ordinal - right.ordinal).map(({ weightMinInclusive, weightMaxInclusive }) => ({ weightMinInclusive, weightMaxInclusive }));
  const buckets = [...generation.buckets].sort((left, right) => left.ordinal - right.ordinal).map(({ bucketId, sourceBucketIds }) => ({ bucketId, sourceBucketIds }));
  const targets = [...generation.targets].sort((left, right) => left.bandOrdinal - right.bandOrdinal || left.bucketId.localeCompare(right.bucketId)).map(({ bandOrdinal, bucketId, status, targetCount, qualifyingClanCount, sampleCount, reasonCode }) => ({ bandOrdinal, bucketId, status, targetCount, qualifyingClanCount, sampleCount, reasonCode }));
  const lineage = [...generation.lineage].sort((left, right) => left.ordinal - right.ordinal).map(({ ordinal, observationId, observationContentFingerprint, role, inputDigest }) => ({ ordinal, observationId, observationContentFingerprint, role, inputDigest }));
  return sha256({
    profileId: generation.profileId,
    profileVersion: generation.profileVersion,
    policyId: generation.policyId,
    policyVersion: generation.policyVersion,
    sampleThreshold: generation.sampleThreshold,
    minimumDirectWeightAnchors: generation.minimumDirectWeightAnchors,
    authorityStatus: generation.authorityStatus,
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
    bands,
    buckets,
    targets,
    lineage,
  });
}

export class NativeHeatMapReferencePublicationService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async preview(candidate: NativeReferenceCandidateArtifact, requestKey?: string) {
    const preview = buildNativeHeatMapReferencePreview(candidate, { requestKey });
    return { ...preview, requestKey: requestKey ?? null, publicationAllowed: false };
  }

  /** Purpose: publish one immutable generation under a native advisory lock; this never writes legacy references. */
  async publish(input: {
    preview: NativeHeatMapReferenceGenerationPreview;
    requestKey: string;
    actorDiscordUserId?: string | null;
    expectedGenerationId?: string | null;
    expectedFenceToken?: bigint | number | null;
  }): Promise<{ published: boolean; idempotent: boolean; generationId: string | null; fenceToken: bigint | null; reason?: string }> {
    if (!input.requestKey.trim()) throw new Error("native reference publication requires requestKey");
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
          reasonCode: eventType === "PREVIEW" ? "exact_retry" : "request_key_content_conflict",
          contentFingerprint: input.preview.contentFingerprint,
        } });
        return existing.contentFingerprint === input.preview.contentFingerprint
          ? { published: true, idempotent: true, generationId: existing.generationId, fenceToken: head?.fenceToken ?? 0n }
          : { published: false, idempotent: false, generationId: existing.generationId, fenceToken: head?.fenceToken ?? 0n, reason: "request_key_content_conflict" };
      }
      const currentGenerationId = head?.generationId ?? null;
      const currentFence = head?.fenceToken ?? 0n;
      if (!sameExpected(currentGenerationId, input.expectedGenerationId) || (input.expectedFenceToken !== undefined && currentFence !== BigInt(input.expectedFenceToken ?? 0))) {
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
      const generation = await tx.nativeHeatMapReferenceGeneration.create({ data: {
        profileId: input.preview.profileId,
        profileVersion: input.preview.profileVersion,
        policyId: input.preview.policyId,
        policyVersion: input.preview.policyVersion,
        sampleThreshold: input.preview.sampleThreshold,
        minimumDirectWeightAnchors: input.preview.minimumDirectWeightAnchors,
        authorityStatus: input.preview.authorityStatus,
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
      await tx.nativeHeatMapReferenceLineage.createMany({ data: input.preview.lineage.map((row) => ({ generationId: generation.generationId, ...row })) });
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
        create: { profileId: input.preview.profileId, policyVersion: input.preview.policyVersion, generationId: generation.generationId, fenceToken: nextFence, lastPublicationEventId: event.eventId },
        update: { generationId: generation.generationId, fenceToken: nextFence, lastPublicationEventId: event.eventId },
      });
      return { published: true, idempotent: false, generationId: generation.generationId, fenceToken: nextFence };
    });
  }

  async readCurrent(input?: { profileId?: string; policyVersion?: string }): Promise<NativeHeatMapReferenceRead> {
    const profileId = input?.profileId ?? NATIVE_REFERENCE_PROFILE_ID;
    const policyVersion = input?.policyVersion ?? NATIVE_REFERENCE_POLICY_VERSION;
    const head = await this.db.nativeHeatMapReferenceHead.findUnique({ where: { profileId_policyVersion: { profileId, policyVersion } } });
    if (!head?.generationId) return { status: "UNKNOWN", informationalOnly: true, reason: "native_head_unavailable", generationId: null, fenceToken: head?.fenceToken ?? null, profileVersion: NATIVE_REFERENCE_PROFILE_VERSION, policyVersion, sampleThreshold: null, targets: [], bands: [] };
    const generation = await this.db.nativeHeatMapReferenceGeneration.findUnique({ where: { generationId: head.generationId }, include: { targets: true, bands: true, buckets: true, lineage: true } });
    if (!generation || generation.status !== "VERIFIED" || generation.authorityStatus !== NATIVE_REFERENCE_AUTHORITY_STATUS) return { status: "UNKNOWN", informationalOnly: true, reason: "native_generation_unverified", generationId: head.generationId, fenceToken: head.fenceToken, profileVersion: generation?.profileVersion ?? NATIVE_REFERENCE_PROFILE_VERSION, policyVersion, sampleThreshold: generation?.sampleThreshold ?? null, targets: [], bands: [] };
    const expectedTargetCount = generation.bands.length * generation.buckets.length;
    const targetsValid = generation.targets.length === expectedTargetCount && generation.targets.every((target) => target.status === "SUPPORTED" ? Number.isSafeInteger(target.targetCount) && (target.targetCount ?? -1) >= 0 : target.targetCount === null && Boolean(target.reasonCode));
    if (!targetsValid || persistedContentFingerprint(generation) !== generation.contentFingerprint) return { status: "UNKNOWN", informationalOnly: true, reason: "native_generation_integrity_mismatch", generationId: head.generationId, fenceToken: head.fenceToken, profileVersion: generation.profileVersion, policyVersion, sampleThreshold: generation.sampleThreshold, targets: [], bands: [] };
    return { status: "CURRENT", informationalOnly: true, reason: null, generationId: generation.generationId, fenceToken: head.fenceToken, profileVersion: generation.profileVersion, policyVersion: generation.policyVersion, sampleThreshold: generation.sampleThreshold, bands: generation.bands.sort((left, right) => left.ordinal - right.ordinal).map((band) => ({ weightMinInclusive: band.weightMinInclusive, weightMaxInclusive: band.weightMaxInclusive })), targets: generation.targets.map((target) => ({ bandOrdinal: target.bandOrdinal, bucketId: target.bucketId, status: target.status, targetCount: target.targetCount, qualifyingClanCount: target.qualifyingClanCount, sampleCount: target.sampleCount, reasonCode: target.reasonCode })) };
  }

  async rollback(input: { profileId?: string; policyVersion?: string; expectedGenerationId: string; expectedFenceToken: bigint | number; actorDiscordUserId?: string | null }) {
    const profileId = input.profileId ?? NATIVE_REFERENCE_PROFILE_ID;
    const policyVersion = input.policyVersion ?? NATIVE_REFERENCE_POLICY_VERSION;
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(profileId, policyVersion)}, 0))`;
      const head = await tx.nativeHeatMapReferenceHead.findUnique({ where: { profileId_policyVersion: { profileId, policyVersion } } });
      if (!head || head.generationId !== input.expectedGenerationId || head.fenceToken !== BigInt(input.expectedFenceToken)) return { rolledBack: false, reason: "expected_head_or_fence_mismatch" };
      const prior = await tx.nativeHeatMapReferenceGeneration.findFirst({ where: { profileId, policyVersion, status: "VERIFIED", generationId: { not: input.expectedGenerationId } }, orderBy: { createdAt: "desc" } });
      if (!prior) return { rolledBack: false, reason: "no_prior_verified_generation" };
      const nextFence = head.fenceToken + 1n;
      const event = await tx.nativeHeatMapReferencePublicationEvent.create({ data: { profileId, policyVersion, generationId: prior.generationId, eventType: "ROLLBACK", previousGenerationId: head.generationId, newGenerationId: prior.generationId, previousFenceToken: head.fenceToken, newFenceToken: nextFence, actorDiscordUserId: input.actorDiscordUserId ?? null, reasonCode: "operator_rollback", contentFingerprint: prior.contentFingerprint } });
      await tx.nativeHeatMapReferenceHead.update({ where: { profileId_policyVersion: { profileId, policyVersion } }, data: { generationId: prior.generationId, fenceToken: nextFence, lastPublicationEventId: event.eventId } });
      return { rolledBack: true, generationId: prior.generationId, fenceToken: nextFence };
    });
  }
}

export const NATIVE_REFERENCE_BUCKET_REGISTRY_FOR_PUBLICATION = NATIVE_REFERENCE_BUCKET_REGISTRY;
