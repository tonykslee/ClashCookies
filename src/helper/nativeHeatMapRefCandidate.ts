import { createHash } from "node:crypto";
import {
  type CompoWarWeightBucket,
  COMPO_WAR_WEIGHT_BANDS,
  getCompoWarWeightBucket,
} from "./compoWarWeightBuckets";

export const NATIVE_REFERENCE_PROFILE_ID = "fwa-native-composition-reference";
export const NATIVE_REFERENCE_PROFILE_VERSION = "native-reference-v1";
export const NATIVE_REFERENCE_BUCKET_DEFINITION_VERSION = "compo-war-buckets-v1";
export const NATIVE_REFERENCE_ERA_POLICY_VERSION = "explicit-window-v1";
export const NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD = 10;
export const NATIVE_REFERENCE_TARGET_TOTAL = 50;
export const NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY = "persisted_fwa_snapshot";
export const NATIVE_REFERENCE_SYNTHETIC_SOURCE_CATEGORY = "synthetic_fixture";
export const NATIVE_REFERENCE_PERSISTED_EVIDENCE_TRUST = "persisted_unverified_source_binding";
export const NATIVE_REFERENCE_SYNTHETIC_EVIDENCE_TRUST = "synthetic_untrusted";

export type NativeReferenceBucketDefinition = {
  id: string;
  sourceBuckets: readonly CompoWarWeightBucket[];
};

/** Purpose: define the native candidate's ordered, normalized bucket contract. */
export const NATIVE_REFERENCE_BUCKET_REGISTRY: readonly NativeReferenceBucketDefinition[] = [
  { id: "TH19", sourceBuckets: ["TH19"] },
  { id: "TH18", sourceBuckets: ["TH18"] },
  { id: "TH17", sourceBuckets: ["TH17"] },
  { id: "TH16", sourceBuckets: ["TH16"] },
  { id: "TH15", sourceBuckets: ["TH15"] },
  { id: "TH14", sourceBuckets: ["TH14"] },
  { id: "TH13", sourceBuckets: ["TH13"] },
  { id: "TH12", sourceBuckets: ["TH12"] },
  { id: "TH11", sourceBuckets: ["TH11"] },
  { id: "TH10_OR_LOWER", sourceBuckets: ["TH10", "TH9", "TH8_OR_LOWER"] },
] as const;

export type NativeReferenceBandDefinition = {
  weightMinInclusive: number;
  weightMaxInclusive: number;
};

export type NativeReferenceSourceMember = {
  clanTag: string;
  playerTag: string;
  position: number | null;
  townHall: number | null;
  rawWeight: number | null;
  effectiveWeight: number | null;
  effectiveWeightStatus: string;
  sourceSyncedAt?: Date | string | null;
};

export type NativeReferenceSourceBindingStatus = "VERIFIED" | "UNAVAILABLE" | "CONFLICTING";
export type NativeReferenceSourceCompletenessStatus = "VERIFIED" | "UNAVAILABLE" | "CONFLICTING";

export type NativeReferenceSourceRoster = {
  clanTag: string;
  rosterSize: number;
  totalRawWeight: number | null;
  totalEffectiveWeight: number | null;
  observedAt: Date | string | null;
  sourceUpdatedAt: Date | string | null;
  sourceWarId: number | null;
  sourceWarStartTime: Date | string | null;
  sourceWarEndTime: Date | string | null;
  sourceWarState: string | null;
  sourceCurrentWarUpdatedAt: Date | string | null;
  sourceIdentityStatus?: NativeReferenceSourceBindingStatus;
  sourceMatchType?: string | null;
  sourceMemberCompletenessStatus?: NativeReferenceSourceCompletenessStatus;
  members: readonly NativeReferenceSourceMember[];
};

export type NativeReferenceEraPolicy = {
  policyId: string;
  policyVersion: string;
  eraStartIso: string;
  eraEndIso: string;
};

export type NativeReferenceExclusionReasonCode =
  | "invalid_clan_identity"
  | "duplicate_clan_observation"
  | "roster_size"
  | "duplicate_player_identity"
  | "missing_or_invalid_position"
  | "duplicate_position"
  | "invalid_weight"
  | "unsupported_weight"
  | "imputed_weight"
  | "source_metadata"
  | "era_policy"
  | "observation_timestamp"
  | "member_roster_mismatch"
  | "total_weight_mismatch"
  | "no_reference_band";

export type NativeReferenceExclusion = {
  clanTag: string | null;
  bandKey: string | null;
  bandAttribution: "INDEPENDENT" | "UNATTRIBUTABLE";
  reasonCode: NativeReferenceExclusionReasonCode;
  reason: string;
};

export type NativeReferenceBucketTarget = {
  bucketId: string;
  status: "SUPPORTED" | "UNKNOWN";
  countStatus: "POSITIVE" | "EXPLICIT_ZERO" | "ROUNDED_ZERO" | "MISSING_OR_UNSUPPORTED" | "INVALID_EVIDENCE";
  observedTotal: number | null;
  observedAverage: number | null;
  targetCount: number | null;
  reasonCode: string | null;
};

export type NativeReferenceBandDiagnostic = {
  band: NativeReferenceBandDefinition;
  status: "SUPPORTED" | "UNKNOWN";
  reasonCode: "supported" | "no_source" | "insufficient_source" | "invalid_evidence";
  candidateSourceRosterCount: number;
  sourceObservationCount: number;
  distinctQualifyingClanCount: number;
  excludedRosterCount: number;
  exclusionCounts: Readonly<Record<string, number>>;
  th19ContainingRosterCount: number;
  observedBucketTotals: Readonly<Record<string, number>>;
  averageBucketCounts: Readonly<Record<string, number>>;
  normalizedTargets: readonly NativeReferenceBucketTarget[];
};

export type NativeReferenceCandidateArtifact = {
  profileId: string;
  profileVersion: string;
  overallStatus: "SUPPORTED" | "PARTIAL" | "UNKNOWN";
  sourceCategory: string;
  evidenceTrust: string;
  sampleThreshold: number;
  eraPolicy: NativeReferenceEraPolicy;
  evaluationAtIso: string;
  sourceObservationBounds: { minIso: string | null; maxIso: string | null };
  bucketDefinitionVersion: string;
  bucketDefinitionFingerprint: string;
  bucketRegistry: readonly NativeReferenceBucketDefinition[];
  bandDefinitions: readonly NativeReferenceBandDefinition[];
  exclusions: readonly NativeReferenceExclusion[];
  exclusionCounts: Readonly<Record<string, number>>;
  diagnostics: readonly NativeReferenceBandDiagnostic[];
  sourceEvidenceFingerprint: string;
  contentFingerprint: string;
  unknownReason: string | null;
  unattributedExclusionCount: number;
};

type NativeCandidateConfig = {
  sourceRosters: readonly NativeReferenceSourceRoster[];
  bandDefinitions: readonly NativeReferenceBandDefinition[];
  eraPolicy: NativeReferenceEraPolicy;
  evaluationAt: Date | string;
  sampleThreshold?: number;
  sourceCategory?: string;
  evidenceTrust?: string;
  bucketRegistry?: readonly NativeReferenceBucketDefinition[];
};

type QualifiedRoster = {
  clanTag: string;
  band: NativeReferenceBandDefinition;
  bucketCounts: Record<string, number>;
  totalEffectiveWeight: number;
  th19Count: number;
  sourceObservationTimes: Date[];
};

type ParsedDate = Date | null;

function parseDate(value: Date | string | null | undefined): ParsedDate {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return normalized ? (normalized.startsWith("#") ? normalized : `#${normalized}`) : null;
}

function bandKey(band: NativeReferenceBandDefinition): string {
  return `${band.weightMinInclusive}:${band.weightMaxInclusive}`;
}

function sortedBands(bands: readonly NativeReferenceBandDefinition[]): NativeReferenceBandDefinition[] {
  return [...bands].sort((left, right) => {
    const minDelta = left.weightMinInclusive - right.weightMinInclusive;
    return minDelta !== 0 ? minDelta : left.weightMaxInclusive - right.weightMaxInclusive;
  });
}

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value ?? null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function emptyCounts(registry: readonly NativeReferenceBucketDefinition[]): Record<string, number> {
  return Object.fromEntries(registry.map((bucket) => [bucket.id, 0]));
}

function validateRegistry(
  registry: readonly NativeReferenceBucketDefinition[],
): string | null {
  if (registry.length === 0) return "bucket registry is empty";
  const ids = new Set<string>();
  const mapped = new Map<CompoWarWeightBucket, number>();
  for (const bucket of registry) {
    if (!bucket.id.trim() || ids.has(bucket.id)) return "bucket registry contains duplicate or empty identifiers";
    ids.add(bucket.id);
    if (bucket.sourceBuckets.length === 0) return `bucket ${bucket.id} has no source buckets`;
    for (const sourceBucket of bucket.sourceBuckets) {
      const count = (mapped.get(sourceBucket) ?? 0) + 1;
      if (count > 1) return `source bucket ${sourceBucket} is mapped more than once`;
      mapped.set(sourceBucket, count);
    }
  }
  for (const sourceBucket of COMPO_WAR_WEIGHT_BANDS.map((band) => band.bucket)) {
    if (!mapped.has(sourceBucket)) return `source bucket ${sourceBucket} is not represented`;
  }
  return null;
}

function validateBandDefinitions(
  bands: readonly NativeReferenceBandDefinition[],
): string | null {
  if (bands.length === 0) return "reference band registry is empty";
  const sorted = sortedBands(bands);
  for (const band of sorted) {
    if (
      !Number.isInteger(band.weightMinInclusive) ||
      !Number.isInteger(band.weightMaxInclusive) ||
      band.weightMinInclusive < 0 ||
      band.weightMaxInclusive < band.weightMinInclusive
    ) {
      return "reference band contains an invalid boundary";
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.weightMinInclusive <= sorted[index - 1]!.weightMaxInclusive) {
      return "reference bands overlap";
    }
  }
  return null;
}

function validatePolicy(input: NativeCandidateConfig): { policy: NativeReferenceEraPolicy; evaluationAt: Date } | null {
  const evaluationAt = parseDate(input.evaluationAt);
  const eraStart = parseDate(input.eraPolicy.eraStartIso);
  const eraEnd = parseDate(input.eraPolicy.eraEndIso);
  if (
    !evaluationAt ||
    !eraStart ||
    !eraEnd ||
    !input.eraPolicy.policyId.trim() ||
    input.eraPolicy.policyVersion !== NATIVE_REFERENCE_ERA_POLICY_VERSION ||
    eraStart.getTime() > eraEnd.getTime() ||
    evaluationAt.getTime() < eraStart.getTime()
  ) {
    return null;
  }
  return {
    policy: {
      ...input.eraPolicy,
      eraStartIso: eraStart.toISOString(),
      eraEndIso: eraEnd.toISOString(),
    },
    evaluationAt,
  };
}

function sourceCategoryFor(input: NativeCandidateConfig): { category: string; trust: string } {
  if (input.sourceCategory === NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY) {
    return {
      category: NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY,
      trust: input.evidenceTrust ?? NATIVE_REFERENCE_PERSISTED_EVIDENCE_TRUST,
    };
  }
  return {
    category: input.sourceCategory ?? NATIVE_REFERENCE_SYNTHETIC_SOURCE_CATEGORY,
    trust: input.evidenceTrust ?? NATIVE_REFERENCE_SYNTHETIC_EVIDENCE_TRUST,
  };
}

function sourceIdentityIsIndependentlyVerified(roster: NativeReferenceSourceRoster): boolean {
  return (
    roster.sourceIdentityStatus === "VERIFIED" &&
    roster.sourceMatchType === "FWA" &&
    roster.sourceMemberCompletenessStatus === "VERIFIED"
  );
}

function inferIndependentlySupportableBand(
  roster: NativeReferenceSourceRoster,
  bands: readonly NativeReferenceBandDefinition[],
): NativeReferenceBandDefinition | null {
  if (roster.members.length !== NATIVE_REFERENCE_TARGET_TOTAL) return null;
  const weights = roster.members.map((member) => member.effectiveWeight);
  if (weights.some((weight) => !Number.isInteger(weight) || (weight as number) <= 0)) return null;
  const total = weights.reduce<number>((sum, weight) => sum + (weight as number), 0);
  return findBand(total, bands);
}

function findBand(
  totalWeight: number,
  bands: readonly NativeReferenceBandDefinition[],
): NativeReferenceBandDefinition | null {
  return (
    bands.find(
      (band) =>
        totalWeight >= band.weightMinInclusive && totalWeight <= band.weightMaxInclusive,
    ) ?? null
  );
}

function bucketForSource(
  sourceBucket: CompoWarWeightBucket,
  registry: readonly NativeReferenceBucketDefinition[],
): NativeReferenceBucketDefinition | null {
  return (
    registry.find((bucket) => bucket.sourceBuckets.includes(sourceBucket)) ?? null
  );
}

function normalizeAverageCounts(input: {
  averages: Readonly<Record<string, number>>;
  registry: readonly NativeReferenceBucketDefinition[];
  targetTotal: number;
}): { counts: Record<string, number>; invalidReason: string | null } {
  const values = input.registry.map((bucket) => input.averages[bucket.id]);
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - input.targetTotal) > 1e-8
  ) {
    return { counts: {}, invalidReason: "source bucket counts are incomplete or malformed" };
  }
  const floors = values.map((value) => Math.floor(value));
  let remainder = input.targetTotal - floors.reduce((sum, value) => sum + value, 0);
  const order = input.registry
    .map((bucket, index) => ({ bucket, index, fraction: values[index]! - floors[index]! }))
    .sort((left, right) => {
      const fractionDelta = right.fraction - left.fraction;
      return fractionDelta !== 0 ? fractionDelta : left.index - right.index;
    });
  const counts = Object.fromEntries(input.registry.map((bucket, index) => [bucket.id, floors[index]!])) as Record<string, number>;
  for (const entry of order) {
    if (remainder <= 0) break;
    counts[entry.bucket.id] += 1;
    remainder -= 1;
  }
  if (remainder !== 0 || Object.values(counts).some((count) => count < 0 || !Number.isInteger(count))) {
    return { counts: {}, invalidReason: "source bucket counts could not be normalized" };
  }
  return { counts, invalidReason: null };
}

function countReasons(rows: readonly NativeReferenceExclusion[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.reasonCode] = (counts[row.reasonCode] ?? 0) + 1;
    return counts;
  }, {});
}

function qualifyRoster(input: {
  roster: NativeReferenceSourceRoster;
  normalizedClanTag: string;
  duplicateClan: boolean;
  policy: NativeReferenceEraPolicy;
  evaluationAt: Date;
  bands: readonly NativeReferenceBandDefinition[];
  registry: readonly NativeReferenceBucketDefinition[];
}): { qualified: QualifiedRoster | null; exclusion: NativeReferenceExclusion | null } {
  const { roster } = input;
  const exclusion = (reasonCode: NativeReferenceExclusionReasonCode, reason: string) => ({
    qualified: null,
    exclusion: {
      clanTag: input.normalizedClanTag,
      bandKey: null,
      bandAttribution: "UNATTRIBUTABLE" as const,
      reasonCode,
      reason,
    },
  });
  if (input.duplicateClan) return exclusion("duplicate_clan_observation", "repeated clan observation was rejected");
  if (roster.rosterSize !== NATIVE_REFERENCE_TARGET_TOTAL || roster.members.length !== NATIVE_REFERENCE_TARGET_TOTAL) {
    return exclusion("roster_size", `roster size ${roster.members.length}/${NATIVE_REFERENCE_TARGET_TOTAL}`);
  }
  if (roster.members.some((member) => normalizeIdentity(member.clanTag) !== input.normalizedClanTag)) {
    return exclusion("member_roster_mismatch", "member clan identity does not match containing roster");
  }
  const players = roster.members.map((member) => normalizeIdentity(member.playerTag));
  if (players.some((player) => !player) || new Set(players).size !== NATIVE_REFERENCE_TARGET_TOTAL) {
    return exclusion("duplicate_player_identity", "player identities are missing or not unique");
  }
  const positions = roster.members.map((member) => member.position);
  if (positions.some((position) => !Number.isInteger(position) || (position as number) < 1 || (position as number) > 50)) {
    return exclusion("missing_or_invalid_position", "roster positions are not a complete 1..50 integer set");
  }
  if (new Set(positions).size !== NATIVE_REFERENCE_TARGET_TOTAL) {
    return exclusion("duplicate_position", "roster positions are duplicated");
  }

  const observedAt = parseDate(roster.observedAt);
  const sourceUpdatedAt = parseDate(roster.sourceUpdatedAt);
  const sourceWarStartTime = parseDate(roster.sourceWarStartTime);
  const sourceWarEndTime = parseDate(roster.sourceWarEndTime);
  const sourceCurrentWarUpdatedAt = parseDate(roster.sourceCurrentWarUpdatedAt);
  const eraStart = new Date(input.policy.eraStartIso).getTime();
  const eraEnd = new Date(input.policy.eraEndIso).getTime();
  if (
    !sourceIdentityIsIndependentlyVerified(roster) ||
    !observedAt ||
    !sourceUpdatedAt ||
    !sourceWarStartTime ||
    !Number.isInteger(roster.sourceWarId) ||
    (roster.sourceWarId as number) <= 0 ||
    !roster.sourceWarState?.trim() ||
    sourceUpdatedAt.getTime() > input.evaluationAt.getTime() ||
    observedAt.getTime() > input.evaluationAt.getTime() ||
    sourceWarStartTime.getTime() > input.evaluationAt.getTime() ||
    sourceWarStartTime.getTime() > observedAt.getTime() ||
    sourceWarStartTime.getTime() > sourceUpdatedAt.getTime() ||
    (sourceCurrentWarUpdatedAt && sourceCurrentWarUpdatedAt.getTime() < sourceWarStartTime.getTime()) ||
    observedAt.getTime() < sourceUpdatedAt.getTime() ||
    (sourceCurrentWarUpdatedAt && sourceCurrentWarUpdatedAt.getTime() > input.evaluationAt.getTime()) ||
    (sourceWarEndTime && sourceWarEndTime.getTime() < sourceWarStartTime.getTime())
  ) {
    return exclusion("source_metadata", "source war identity, FWA match type, completeness, or observation metadata is unavailable or contradictory");
  }
  const allowedStates = new Set(["preparation", "inwar", "warended", "notinwar"]);
  const normalizedState = roster.sourceWarState.trim().toLowerCase().replace(/[_-]/g, "");
  if (!allowedStates.has(normalizedState)) {
    return exclusion("source_metadata", "source war state is unsupported");
  }
  if (normalizedState === "warended" && !sourceWarEndTime) {
    return exclusion("source_metadata", "ended source war is missing its end timestamp");
  }
  if (
    sourceWarStartTime.getTime() < eraStart ||
    sourceWarStartTime.getTime() > eraEnd ||
    sourceUpdatedAt.getTime() < eraStart
  ) {
    return exclusion("era_policy", "source observation is outside the explicit era window");
  }
  const sourceObservationTimes = [observedAt, sourceUpdatedAt, sourceWarStartTime, sourceWarEndTime, sourceCurrentWarUpdatedAt].filter(
    (date): date is Date => Boolean(date),
  );
  const memberSourceTimes = roster.members
    .map((member) => member.sourceSyncedAt)
    .filter((value): value is Date | string => value !== undefined && value !== null)
    .map((value) => parseDate(value));
  if (
    memberSourceTimes.some((date) => !date || date.getTime() < eraStart || date.getTime() > input.evaluationAt.getTime()) ||
    (memberSourceTimes.length > 1 && new Set(memberSourceTimes.map((date) => date?.getTime())).size !== 1)
  ) {
    return exclusion("source_metadata", "member source observations are invalid, stale, or inconsistent");
  }
  sourceObservationTimes.push(...memberSourceTimes.filter((date): date is Date => Boolean(date)));

  const rawWeights: number[] = [];
  const effectiveWeights: number[] = [];
  const bucketCounts = emptyCounts(input.registry);
  let factualTh19Count = 0;
  for (const member of roster.members) {
    if (member.effectiveWeightStatus !== "RAW") {
      return exclusion("imputed_weight", "imputed or unresolved effective weights are not candidate-eligible");
    }
    if (
      !Number.isInteger(member.rawWeight) ||
      !Number.isInteger(member.effectiveWeight) ||
      (member.rawWeight as number) <= 0 ||
      (member.effectiveWeight as number) <= 0 ||
      member.rawWeight !== member.effectiveWeight
    ) {
      return exclusion("invalid_weight", "weights are missing, fractional, non-positive, or not directly observed");
    }
    const sourceBucket = getCompoWarWeightBucket(member.effectiveWeight);
    if (!sourceBucket) return exclusion("unsupported_weight", "weight is outside the shared classification bands");
    if (sourceBucket === "TH19") factualTh19Count += 1;
    const nativeBucket = bucketForSource(sourceBucket, input.registry);
    if (!nativeBucket) return exclusion("unsupported_weight", `shared bucket ${sourceBucket} is not in the native registry`);
    rawWeights.push(member.rawWeight as number);
    effectiveWeights.push(member.effectiveWeight as number);
    bucketCounts[nativeBucket.id] += 1;
  }
  const totalEffectiveWeight = effectiveWeights.reduce((sum, value) => sum + value, 0);
  const totalRawWeight = rawWeights.reduce((sum, value) => sum + value, 0);
  if (
    !Number.isInteger(roster.totalRawWeight) ||
    !Number.isInteger(roster.totalEffectiveWeight) ||
    roster.totalRawWeight !== totalRawWeight ||
    roster.totalEffectiveWeight !== totalEffectiveWeight
  ) {
    return exclusion("total_weight_mismatch", "roster totals do not equal the directly observed member weights");
  }
  const band = findBand(totalEffectiveWeight, input.bands);
  if (!band) return exclusion("no_reference_band", `no reference band for total weight ${totalEffectiveWeight}`);
  return {
    qualified: {
      clanTag: input.normalizedClanTag,
      band,
      bucketCounts,
      totalEffectiveWeight,
      th19Count: factualTh19Count,
      sourceObservationTimes,
    },
    exclusion: null,
  };
}

function buildUnknownTargets(
  registry: readonly NativeReferenceBucketDefinition[],
  reasonCode: string,
): NativeReferenceBucketTarget[] {
  return registry.map((bucket) => ({
    bucketId: bucket.id,
    status: "UNKNOWN",
    countStatus: reasonCode === "invalid_evidence" ? "INVALID_EVIDENCE" : "MISSING_OR_UNSUPPORTED",
    observedTotal: null,
    observedAverage: null,
    targetCount: null,
    reasonCode,
  }));
}

function canonicalizeSourceEvidence(rosters: readonly NativeReferenceSourceRoster[]): unknown[] {
  return [...rosters]
    .map((roster) => ({
      clanTag: normalizeIdentity(roster.clanTag),
      rosterSize: roster.rosterSize,
      totalRawWeight: roster.totalRawWeight,
      totalEffectiveWeight: roster.totalEffectiveWeight,
      observedAt: parseDate(roster.observedAt)?.toISOString() ?? null,
      sourceUpdatedAt: parseDate(roster.sourceUpdatedAt)?.toISOString() ?? null,
      sourceWarId: roster.sourceWarId,
      sourceWarStartTime: parseDate(roster.sourceWarStartTime)?.toISOString() ?? null,
      sourceWarEndTime: parseDate(roster.sourceWarEndTime)?.toISOString() ?? null,
      sourceWarState: roster.sourceWarState,
      sourceCurrentWarUpdatedAt: parseDate(roster.sourceCurrentWarUpdatedAt)?.toISOString() ?? null,
      sourceIdentityStatus: roster.sourceIdentityStatus ?? "UNAVAILABLE",
      sourceMatchType: roster.sourceMatchType ?? null,
      sourceMemberCompletenessStatus: roster.sourceMemberCompletenessStatus ?? "UNAVAILABLE",
      members: [...roster.members]
        .map((member) => ({
          clanTag: normalizeIdentity(member.clanTag),
          playerTag: normalizeIdentity(member.playerTag),
          position: member.position,
          townHall: member.townHall,
          rawWeight: member.rawWeight,
          effectiveWeight: member.effectiveWeight,
          effectiveWeightStatus: member.effectiveWeightStatus,
          sourceSyncedAt: parseDate(member.sourceSyncedAt)?.toISOString() ?? null,
        }))
        .sort((left, right) =>
          (left.position ?? 0) - (right.position ?? 0) ||
          (left.playerTag ?? "").localeCompare(right.playerTag ?? "") ||
          (left.clanTag ?? "").localeCompare(right.clanTag ?? ""),
        ),
    }))
    .sort((left, right) =>
      (left.clanTag ?? "").localeCompare(right.clanTag ?? "") ||
      String(left.sourceWarId ?? "").localeCompare(String(right.sourceWarId ?? "")) ||
      String(left.sourceUpdatedAt ?? "").localeCompare(String(right.sourceUpdatedAt ?? "")),
    );
}

function buildInvalidArtifact(input: NativeCandidateConfig, reason: string): NativeReferenceCandidateArtifact {
  const registry = input.bucketRegistry ?? NATIVE_REFERENCE_BUCKET_REGISTRY;
  const source = sourceCategoryFor(input);
  const bands = sortedBands(input.bandDefinitions);
  const policy = input.eraPolicy;
  const evaluationAtIso = typeof input.evaluationAt === "string" ? input.evaluationAt : input.evaluationAt.toISOString();
  const diagnostics = bands.map((band) => ({
    band,
    status: "UNKNOWN" as const,
    reasonCode: "invalid_evidence" as const,
    candidateSourceRosterCount: 0,
    sourceObservationCount: 0,
    distinctQualifyingClanCount: 0,
    excludedRosterCount: 0,
    exclusionCounts: {},
    th19ContainingRosterCount: 0,
    observedBucketTotals: {},
    averageBucketCounts: {},
    normalizedTargets: buildUnknownTargets(registry, "invalid_evidence"),
  }));
  const base = {
    profileId: NATIVE_REFERENCE_PROFILE_ID,
    profileVersion: NATIVE_REFERENCE_PROFILE_VERSION,
    overallStatus: "UNKNOWN" as const,
    sourceCategory: source.category,
    evidenceTrust: source.trust,
    sampleThreshold: Number.isInteger(input.sampleThreshold) && (input.sampleThreshold ?? 0) > 0
      ? input.sampleThreshold!
      : 0,
    eraPolicy: policy,
    evaluationAtIso,
    sourceObservationBounds: { minIso: null, maxIso: null },
    bucketDefinitionVersion: NATIVE_REFERENCE_BUCKET_DEFINITION_VERSION,
    bucketDefinitionFingerprint: computeNativeReferenceBucketDefinitionFingerprint(registry),
    bucketRegistry: registry,
    bandDefinitions: bands,
    exclusions: [],
    exclusionCounts: {},
    unattributedExclusionCount: 0,
    diagnostics,
    sourceEvidenceFingerprint: sha256({ sourceCategory: source.category, evidenceTrust: source.trust, sourceEvidence: canonicalizeSourceEvidence(input.sourceRosters) }),
    unknownReason: reason,
  };
  return { ...base, contentFingerprint: sha256(base) };
}

/** Purpose: generate a read-only, versioned native candidate from explicitly qualified persisted evidence. */
export function generateNativeHeatMapRefCandidate(input: NativeCandidateConfig): NativeReferenceCandidateArtifact {
  const registry = input.bucketRegistry ?? NATIVE_REFERENCE_BUCKET_REGISTRY;
  const registryError = validateRegistry(registry);
  const bandError = validateBandDefinitions(input.bandDefinitions);
  const policyResult = validatePolicy(input);
  const threshold = input.sampleThreshold === undefined
    ? NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD
    : Number.isInteger(input.sampleThreshold) && input.sampleThreshold > 0
      ? input.sampleThreshold
      : 0;
  if (registryError || bandError || !policyResult || threshold === 0) {
    return buildInvalidArtifact(
      input,
      threshold === 0
        ? "invalid_sample_threshold"
        : registryError ?? bandError ?? "evaluation timestamp or era policy is invalid",
    );
  }

  const normalizedRosters = input.sourceRosters.map((roster) => ({
    roster,
    normalizedClanTag: normalizeIdentity(roster.clanTag),
  }));
  const clanCounts = normalizedRosters.reduce<Map<string, number>>((counts, row) => {
    if (row.normalizedClanTag) counts.set(row.normalizedClanTag, (counts.get(row.normalizedClanTag) ?? 0) + 1);
    return counts;
  }, new Map());
  const exclusions: NativeReferenceExclusion[] = [];
  const qualified: QualifiedRoster[] = [];
  for (const row of normalizedRosters) {
    if (!row.normalizedClanTag) {
      exclusions.push({
        clanTag: null,
        bandKey: null,
        bandAttribution: "UNATTRIBUTABLE",
        reasonCode: "invalid_clan_identity",
        reason: "clan identity is missing or invalid",
      });
      continue;
    }
    const result = qualifyRoster({
      roster: row.roster,
      normalizedClanTag: row.normalizedClanTag,
      duplicateClan: (clanCounts.get(row.normalizedClanTag) ?? 0) > 1,
      policy: policyResult.policy,
      evaluationAt: policyResult.evaluationAt,
      bands: input.bandDefinitions,
      registry,
    });
    if (result.qualified) qualified.push(result.qualified);
    if (result.exclusion) {
      const attributableBand = inferIndependentlySupportableBand(row.roster, input.bandDefinitions);
      exclusions.push({
        ...result.exclusion,
        bandKey: attributableBand ? bandKey(attributableBand) : null,
        bandAttribution: attributableBand ? "INDEPENDENT" : "UNATTRIBUTABLE",
      });
    }
  }

  const bandDiagnostics = sortedBands(input.bandDefinitions).map((band) => {
    const rows = qualified.filter((roster) => bandKey(roster.band) === bandKey(band));
    const sourceObservationCount = input.sourceRosters.filter(
      (roster) => bandKey(inferIndependentlySupportableBand(roster, input.bandDefinitions) ?? { weightMinInclusive: -1, weightMaxInclusive: -1 }) === bandKey(band),
    ).length;
    const observedBucketTotals = emptyCounts(registry);
    for (const row of rows) {
      for (const bucket of registry) observedBucketTotals[bucket.id] += row.bucketCounts[bucket.id] ?? 0;
    }
    const averages = Object.fromEntries(
      registry.map((bucket) => [bucket.id, rows.length > 0 ? observedBucketTotals[bucket.id]! / rows.length : 0]),
    );
    const normalized = rows.length > 0
      ? normalizeAverageCounts({ averages, registry, targetTotal: NATIVE_REFERENCE_TARGET_TOTAL })
      : { counts: {}, invalidReason: null };
    const bandExclusions = exclusions.filter(
      (exclusion) => exclusion.bandKey === bandKey(band) && exclusion.bandAttribution === "INDEPENDENT",
    );
    const supported = rows.length >= threshold && !normalized.invalidReason;
    const reasonCode: NativeReferenceBandDiagnostic["reasonCode"] = rows.length === 0
      ? sourceObservationCount === 0 ? "no_source" : "invalid_evidence"
      : normalized.invalidReason
        ? "invalid_evidence"
        : rows.length < threshold
          ? "insufficient_source"
          : "supported";
    const targets = supported
      ? registry.map((bucket) => ({
          bucketId: bucket.id,
          status: "SUPPORTED" as const,
          countStatus: (observedBucketTotals[bucket.id] ?? 0) === 0
            ? "EXPLICIT_ZERO" as const
            : normalized.counts[bucket.id] === 0
              ? "ROUNDED_ZERO" as const
              : "POSITIVE" as const,
          observedTotal: observedBucketTotals[bucket.id] ?? 0,
          observedAverage: averages[bucket.id] ?? 0,
          targetCount: normalized.counts[bucket.id]!,
          reasonCode: null,
        }))
      : buildUnknownTargets(registry, reasonCode);
    return {
      band,
      status: supported ? "SUPPORTED" as const : "UNKNOWN" as const,
      reasonCode,
      candidateSourceRosterCount: rows.length,
      sourceObservationCount,
      distinctQualifyingClanCount: new Set(rows.map((row) => row.clanTag)).size,
      excludedRosterCount: bandExclusions.length,
      exclusionCounts: countReasons(bandExclusions),
      th19ContainingRosterCount: rows.filter((row) => row.th19Count > 0).length,
      observedBucketTotals,
      averageBucketCounts: averages,
      normalizedTargets: targets,
    };
  });

  const sourceEvidence = canonicalizeSourceEvidence(input.sourceRosters);
  const sourceTimes = input.sourceRosters.flatMap((roster) => [roster.observedAt, roster.sourceUpdatedAt, roster.sourceWarStartTime, roster.sourceWarEndTime, roster.sourceCurrentWarUpdatedAt]
    .map((value) => parseDate(value))
    .filter((value): value is Date => Boolean(value)));
  const sourceObservationBounds = {
    minIso: sourceTimes.length > 0 ? new Date(Math.min(...sourceTimes.map((date) => date.getTime()))).toISOString() : null,
    maxIso: sourceTimes.length > 0 ? new Date(Math.max(...sourceTimes.map((date) => date.getTime()))).toISOString() : null,
  };
  const source = sourceCategoryFor(input);
  const sourceEvidenceFingerprint = sha256({ sourceCategory: source.category, evidenceTrust: source.trust, sourceEvidence });
  const canonicalExclusions = [...exclusions].sort((left, right) =>
    (left.clanTag ?? "").localeCompare(right.clanTag ?? "") ||
    (left.bandKey ?? "").localeCompare(right.bandKey ?? "") ||
    left.reasonCode.localeCompare(right.reasonCode) ||
    left.reason.localeCompare(right.reason),
  );
  const supportedBandCount = bandDiagnostics.filter((band) => band.status === "SUPPORTED").length;
  const artifactBase = {
    profileId: NATIVE_REFERENCE_PROFILE_ID,
    profileVersion: NATIVE_REFERENCE_PROFILE_VERSION,
    overallStatus: supportedBandCount === 0 ? "UNKNOWN" as const : supportedBandCount === bandDiagnostics.length ? "SUPPORTED" as const : "PARTIAL" as const,
    sourceCategory: source.category,
    evidenceTrust: source.trust,
    sampleThreshold: threshold,
    eraPolicy: policyResult.policy,
    evaluationAtIso: policyResult.evaluationAt.toISOString(),
    sourceObservationBounds,
    bucketDefinitionVersion: NATIVE_REFERENCE_BUCKET_DEFINITION_VERSION,
    bucketDefinitionFingerprint: computeNativeReferenceBucketDefinitionFingerprint(registry),
    bucketRegistry: registry,
    bandDefinitions: sortedBands(input.bandDefinitions),
    exclusions: canonicalExclusions,
    exclusionCounts: countReasons(canonicalExclusions),
    unattributedExclusionCount: canonicalExclusions.filter((exclusion) => exclusion.bandAttribution === "UNATTRIBUTABLE").length,
    diagnostics: bandDiagnostics,
    sourceEvidenceFingerprint,
    unknownReason: supportedBandCount === 0
      ? input.sourceRosters.length === 0 ? "no_source_evidence" : qualified.length === 0 ? "rejected_source_evidence" : "insufficient_source_support"
      : null,
  };
  return { ...artifactBase, contentFingerprint: sha256(artifactBase) };
}

export function computeNativeReferenceBucketDefinitionFingerprint(
  registry: readonly NativeReferenceBucketDefinition[] = NATIVE_REFERENCE_BUCKET_REGISTRY,
  weightBands: readonly { bucket: CompoWarWeightBucket; minInclusive: number; maxInclusive: number }[] = COMPO_WAR_WEIGHT_BANDS,
): string {
  return sha256({
    version: NATIVE_REFERENCE_BUCKET_DEFINITION_VERSION,
    orderedRegistry: registry.map((bucket, index) => ({
      order: index,
      id: bucket.id,
      sourceBuckets: [...bucket.sourceBuckets],
    })),
    orderedWeightBands: weightBands.map((band) => ({
      bucket: band.bucket,
      minInclusive: band.minInclusive,
      maxInclusive: band.maxInclusive,
    })),
  });
}

/** Purpose: expose the artifact checksum calculation for contract tests and offline tooling. */
export function computeNativeReferenceCandidateContentFingerprint(
  artifact: Omit<NativeReferenceCandidateArtifact, "contentFingerprint">,
): string {
  return sha256(artifact);
}

export function validateNativeReferenceCandidateArtifact(
  artifact: unknown,
): artifact is NativeReferenceCandidateArtifact {
  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const isIso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value;
  const candidate = artifact;
  if (!isRecord(candidate)) return false;
  if (
    candidate.profileId !== NATIVE_REFERENCE_PROFILE_ID ||
    candidate.profileVersion !== NATIVE_REFERENCE_PROFILE_VERSION ||
    !["SUPPORTED", "PARTIAL", "UNKNOWN"].includes(String(candidate.overallStatus)) ||
    ![NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY, NATIVE_REFERENCE_SYNTHETIC_SOURCE_CATEGORY].includes(String(candidate.sourceCategory)) ||
    (candidate.sourceCategory === NATIVE_REFERENCE_PERSISTED_SOURCE_CATEGORY && candidate.evidenceTrust !== NATIVE_REFERENCE_PERSISTED_EVIDENCE_TRUST) ||
    (candidate.sourceCategory === NATIVE_REFERENCE_SYNTHETIC_SOURCE_CATEGORY && candidate.evidenceTrust !== NATIVE_REFERENCE_SYNTHETIC_EVIDENCE_TRUST) ||
    !Number.isInteger(candidate.sampleThreshold) ||
    (candidate.sampleThreshold as number) <= 0 ||
    !isIso(candidate.evaluationAtIso) ||
    !isRecord(candidate.eraPolicy) ||
    candidate.eraPolicy.policyVersion !== NATIVE_REFERENCE_ERA_POLICY_VERSION ||
    typeof candidate.eraPolicy.policyId !== "string" ||
    !isIso(candidate.eraPolicy.eraStartIso) ||
    !isIso(candidate.eraPolicy.eraEndIso) ||
    new Date(candidate.eraPolicy.eraStartIso).getTime() > new Date(candidate.eraPolicy.eraEndIso).getTime() ||
    new Date(candidate.evaluationAtIso).getTime() < new Date(candidate.eraPolicy.eraStartIso).getTime() ||
    !isRecord(candidate.sourceObservationBounds) ||
    (candidate.sourceObservationBounds.minIso !== null && !isIso(candidate.sourceObservationBounds.minIso)) ||
    (candidate.sourceObservationBounds.maxIso !== null && !isIso(candidate.sourceObservationBounds.maxIso))
  ) return false;
  if (
    candidate.sourceObservationBounds.minIso !== null &&
    candidate.sourceObservationBounds.maxIso !== null &&
    new Date(candidate.sourceObservationBounds.minIso).getTime() > new Date(candidate.sourceObservationBounds.maxIso).getTime()
  ) return false;
  if (!Array.isArray(candidate.bucketRegistry) || validateRegistry(candidate.bucketRegistry as NativeReferenceBucketDefinition[]) !== null) return false;
  if (!Array.isArray(candidate.bandDefinitions) || validateBandDefinitions(candidate.bandDefinitions as NativeReferenceBandDefinition[]) !== null) return false;
  const registry = candidate.bucketRegistry as NativeReferenceBucketDefinition[];
  const bands = candidate.bandDefinitions as NativeReferenceBandDefinition[];
  if (
    candidate.bucketDefinitionVersion !== NATIVE_REFERENCE_BUCKET_DEFINITION_VERSION ||
    typeof candidate.bucketDefinitionFingerprint !== "string" ||
    candidate.bucketDefinitionFingerprint !== computeNativeReferenceBucketDefinitionFingerprint(registry) ||
    !/^[a-f0-9]{64}$/i.test(String(candidate.sourceEvidenceFingerprint)) ||
    !/^[a-f0-9]{64}$/i.test(String(candidate.contentFingerprint)) ||
    !Array.isArray(candidate.exclusions) ||
    !Array.isArray(candidate.diagnostics) ||
    candidate.diagnostics.length !== bands.length ||
    typeof candidate.unattributedExclusionCount !== "number" ||
    !Number.isInteger(candidate.unattributedExclusionCount) ||
    candidate.unattributedExclusionCount < 0
  ) return false;
  const expectedBandKeys = new Set(bands.map(bandKey));
  const diagnosticKeys = new Set<string>();
  const registryIds = new Set(registry.map((bucket) => bucket.id));
  for (const diagnosticValue of candidate.diagnostics) {
    if (!isRecord(diagnosticValue) || !isRecord(diagnosticValue.band)) return false;
    const diagnostic = diagnosticValue as unknown as NativeReferenceBandDiagnostic;
    const key = bandKey(diagnostic.band);
    if (!expectedBandKeys.has(key) || diagnosticKeys.has(key)) return false;
    diagnosticKeys.add(key);
    if (
      !["SUPPORTED", "UNKNOWN"].includes(diagnostic.status) ||
      !["supported", "no_source", "insufficient_source", "invalid_evidence"].includes(diagnostic.reasonCode) ||
      ![diagnostic.candidateSourceRosterCount, diagnostic.sourceObservationCount, diagnostic.distinctQualifyingClanCount, diagnostic.excludedRosterCount, diagnostic.th19ContainingRosterCount].every((value) => Number.isInteger(value) && value >= 0) ||
      diagnostic.distinctQualifyingClanCount > diagnostic.candidateSourceRosterCount ||
      diagnostic.candidateSourceRosterCount > diagnostic.sourceObservationCount ||
      diagnostic.th19ContainingRosterCount > diagnostic.candidateSourceRosterCount ||
      !isRecord(diagnostic.observedBucketTotals) ||
      !isRecord(diagnostic.averageBucketCounts) ||
      !isRecord(diagnostic.exclusionCounts) ||
      !Array.isArray(diagnostic.normalizedTargets)
    ) return false;
    const observedTotal = registry.reduce((sum, bucket) => {
      const value = diagnostic.observedBucketTotals[bucket.id];
      return Number.isFinite(value) && (value as number) >= 0 ? sum + (value as number) : Number.NaN;
    }, 0);
    if (!Number.isFinite(observedTotal) || observedTotal !== diagnostic.candidateSourceRosterCount * NATIVE_REFERENCE_TARGET_TOTAL) return false;
    for (const bucket of registry) {
      const total = diagnostic.observedBucketTotals[bucket.id];
      const average = diagnostic.averageBucketCounts[bucket.id];
      if (!Number.isFinite(total) || !Number.isFinite(average) || (average as number) !== ((total as number) / Math.max(1, diagnostic.candidateSourceRosterCount))) return false;
    }
    const targets = diagnostic.normalizedTargets;
    if (targets.length !== registry.length || new Set(targets.map((target) => target.bucketId)).size !== registry.length || targets.some((target) => !registryIds.has(target.bucketId))) return false;
    const supported = diagnostic.status === "SUPPORTED";
    const targetTotal = targets.reduce((sum, target) => sum + (target.targetCount ?? 0), 0);
    for (const targetValue of targets) {
      if (!isRecord(targetValue)) return false;
      const target = targetValue as unknown as NativeReferenceBucketTarget;
      const observed = diagnostic.observedBucketTotals[target.bucketId];
      const average = diagnostic.averageBucketCounts[target.bucketId];
      if (typeof target.bucketId !== "string" || !["SUPPORTED", "UNKNOWN"].includes(target.status) || !["POSITIVE", "EXPLICIT_ZERO", "ROUNDED_ZERO", "MISSING_OR_UNSUPPORTED", "INVALID_EVIDENCE"].includes(target.countStatus)) return false;
      if (supported) {
        if (target.status !== "SUPPORTED" || !Number.isInteger(target.targetCount) || (target.targetCount as number) < 0 || target.observedTotal !== observed || target.observedAverage !== average) return false;
        if (target.countStatus === "EXPLICIT_ZERO" && ((observed as number) !== 0 || target.targetCount !== 0)) return false;
        if (target.countStatus === "ROUNDED_ZERO" && ((observed as number) <= 0 || target.targetCount !== 0)) return false;
        if (target.countStatus === "POSITIVE" && ((observed as number) <= 0 || (target.targetCount as number) <= 0)) return false;
      } else if (target.status !== "UNKNOWN" || target.targetCount !== null || target.observedTotal !== null || target.observedAverage !== null) return false;
    }
    if (supported) {
      if (diagnostic.reasonCode !== "supported" || diagnostic.candidateSourceRosterCount < (candidate.sampleThreshold as number) || targetTotal !== NATIVE_REFERENCE_TARGET_TOTAL) return false;
    } else {
      if (diagnostic.reasonCode === "supported" || targets.some((target) => target.targetCount !== null)) return false;
      if (diagnostic.reasonCode === "no_source" && diagnostic.sourceObservationCount !== 0) return false;
      if (diagnostic.reasonCode === "insufficient_source" && diagnostic.candidateSourceRosterCount >= (candidate.sampleThreshold as number)) return false;
    }
  }
  if (diagnosticKeys.size !== expectedBandKeys.size) return false;
  const exclusions = candidate.exclusions as unknown[];
  for (const exclusion of exclusions) {
    if (!isRecord(exclusion) || (exclusion.bandKey !== null && !expectedBandKeys.has(String(exclusion.bandKey))) || !["INDEPENDENT", "UNATTRIBUTABLE"].includes(String(exclusion.bandAttribution)) || typeof exclusion.reasonCode !== "string" || typeof exclusion.reason !== "string") return false;
  }
  if (candidate.unattributedExclusionCount !== exclusions.filter((exclusion) => isRecord(exclusion) && exclusion.bandAttribution === "UNATTRIBUTABLE").length) return false;
  const { contentFingerprint, ...payload } = candidate;
  return sha256(payload) === contentFingerprint;
}

export const normalizeNativeReferenceAverageCountsForTest = normalizeAverageCounts;
export const validateNativeReferenceRegistryForTest = validateRegistry;
