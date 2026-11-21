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
  reasonCode: NativeReferenceExclusionReasonCode;
  reason: string;
};

export type NativeReferenceBucketTarget = {
  bucketId: string;
  status: "SUPPORTED" | "UNKNOWN";
  countStatus: "POSITIVE" | "EXPLICIT_ZERO" | "MISSING_OR_UNSUPPORTED" | "INVALID_EVIDENCE";
  targetCount: number | null;
  reasonCode: string | null;
};

export type NativeReferenceBandDiagnostic = {
  band: NativeReferenceBandDefinition;
  status: "SUPPORTED" | "UNKNOWN";
  reasonCode: "supported" | "no_source" | "insufficient_source" | "invalid_evidence";
  candidateSourceRosterCount: number;
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
};

type NativeCandidateConfig = {
  sourceRosters: readonly NativeReferenceSourceRoster[];
  bandDefinitions: readonly NativeReferenceBandDefinition[];
  eraPolicy: NativeReferenceEraPolicy;
  evaluationAt: Date | string;
  sampleThreshold?: number;
  sourceCategory?: string;
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
    !input.eraPolicy.policyVersion.trim() ||
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
    exclusion: { clanTag: input.normalizedClanTag, reasonCode, reason },
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
    !observedAt ||
    !sourceUpdatedAt ||
    !sourceWarStartTime ||
    !Number.isInteger(roster.sourceWarId) ||
    (roster.sourceWarId as number) <= 0 ||
    !roster.sourceWarState?.trim() ||
    sourceUpdatedAt.getTime() > input.evaluationAt.getTime() ||
    observedAt.getTime() > input.evaluationAt.getTime() ||
    (sourceCurrentWarUpdatedAt && sourceCurrentWarUpdatedAt.getTime() > input.evaluationAt.getTime()) ||
    (sourceWarEndTime && sourceWarEndTime.getTime() < sourceWarStartTime.getTime())
  ) {
    return exclusion("source_metadata", "source war identity or observation metadata is incomplete or contradictory");
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
      th19Count: bucketCounts.TH19 ?? 0,
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
    targetCount: null,
    reasonCode,
  }));
}

function buildInvalidArtifact(input: NativeCandidateConfig, reason: string): NativeReferenceCandidateArtifact {
  const registry = input.bucketRegistry ?? NATIVE_REFERENCE_BUCKET_REGISTRY;
  const bands = sortedBands(input.bandDefinitions);
  const policy = input.eraPolicy;
  const evaluationAtIso = typeof input.evaluationAt === "string" ? input.evaluationAt : input.evaluationAt.toISOString();
  const diagnostics = bands.map((band) => ({
    band,
    status: "UNKNOWN" as const,
    reasonCode: "invalid_evidence" as const,
    candidateSourceRosterCount: 0,
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
    sourceCategory: input.sourceCategory ?? "fwa-tracked-war-roster-current",
    sampleThreshold: input.sampleThreshold ?? NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD,
    eraPolicy: policy,
    evaluationAtIso,
    sourceObservationBounds: { minIso: null, maxIso: null },
    bucketDefinitionVersion: NATIVE_REFERENCE_BUCKET_DEFINITION_VERSION,
    bucketDefinitionFingerprint: computeNativeReferenceBucketDefinitionFingerprint(registry),
    bucketRegistry: registry,
    bandDefinitions: bands,
    exclusions: [],
    exclusionCounts: {},
    diagnostics,
    sourceEvidenceFingerprint: sha256({ sourceRosters: input.sourceRosters }),
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
  const threshold = Number.isInteger(input.sampleThreshold) && (input.sampleThreshold ?? 0) > 0
    ? input.sampleThreshold!
    : NATIVE_REFERENCE_DEFAULT_SAMPLE_THRESHOLD;
  if (registryError || bandError || !policyResult) {
    return buildInvalidArtifact(input, registryError ?? bandError ?? "evaluation timestamp or era policy is invalid");
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
      exclusions.push({ clanTag: null, reasonCode: "invalid_clan_identity", reason: "clan identity is missing or invalid" });
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
    if (result.exclusion) exclusions.push(result.exclusion);
  }

  const bandDiagnostics = sortedBands(input.bandDefinitions).map((band) => {
    const rows = qualified.filter((roster) => bandKey(roster.band) === bandKey(band));
    const observedBucketTotals = emptyCounts(registry);
    for (const row of rows) {
      for (const bucket of registry) observedBucketTotals[bucket.id] += row.bucketCounts[bucket.id] ?? 0;
    }
    const averages = Object.fromEntries(
      registry.map((bucket) => [bucket.id, rows.length > 0 ? observedBucketTotals[bucket.id]! / rows.length : 0]),
    );
    const normalized = normalizeAverageCounts({ averages, registry, targetTotal: NATIVE_REFERENCE_TARGET_TOTAL });
    const bandExclusions = exclusions.filter((exclusion) => {
      const roster = input.sourceRosters.find((candidate) => normalizeIdentity(candidate.clanTag) === exclusion.clanTag);
      if (!roster) return false;
      const total = roster.members.reduce((sum, member) => sum + (member.effectiveWeight ?? 0), 0);
      return findBand(total, input.bandDefinitions)?.weightMinInclusive === band.weightMinInclusive &&
        findBand(total, input.bandDefinitions)?.weightMaxInclusive === band.weightMaxInclusive;
    });
    const supported = rows.length >= threshold && !normalized.invalidReason;
    const reasonCode: NativeReferenceBandDiagnostic["reasonCode"] = normalized.invalidReason
      ? "invalid_evidence"
      : rows.length === 0
        ? "no_source"
        : rows.length < threshold
          ? "insufficient_source"
          : "supported";
    const targets = supported
      ? registry.map((bucket) => ({
          bucketId: bucket.id,
          status: "SUPPORTED" as const,
          countStatus: normalized.counts[bucket.id] > 0 ? "POSITIVE" as const : "EXPLICIT_ZERO" as const,
          targetCount: normalized.counts[bucket.id]!,
          reasonCode: null,
        }))
      : buildUnknownTargets(registry, reasonCode);
    return {
      band,
      status: supported ? "SUPPORTED" as const : "UNKNOWN" as const,
      reasonCode,
      candidateSourceRosterCount: rows.length,
      distinctQualifyingClanCount: new Set(rows.map((row) => row.clanTag)).size,
      excludedRosterCount: bandExclusions.length,
      exclusionCounts: countReasons(bandExclusions),
      th19ContainingRosterCount: rows.filter((row) => row.th19Count > 0).length,
      observedBucketTotals,
      averageBucketCounts: averages,
      normalizedTargets: targets,
    };
  });

  const sourceEvidence = [...input.sourceRosters]
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
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || (left.playerTag ?? "").localeCompare(right.playerTag ?? "")),
    }))
    .sort((left, right) => (left.clanTag ?? "").localeCompare(right.clanTag ?? ""));
  const sourceTimes = sourceEvidence.flatMap((roster) => [roster.observedAt, roster.sourceUpdatedAt, roster.sourceWarStartTime, roster.sourceWarEndTime, roster.sourceCurrentWarUpdatedAt]
    .filter((value): value is string => typeof value === "string")
    .map((value) => new Date(value)));
  const sourceObservationBounds = {
    minIso: sourceTimes.length > 0 ? new Date(Math.min(...sourceTimes.map((date) => date.getTime()))).toISOString() : null,
    maxIso: sourceTimes.length > 0 ? new Date(Math.max(...sourceTimes.map((date) => date.getTime()))).toISOString() : null,
  };
  const sourceEvidenceFingerprint = sha256({ sourceCategory: input.sourceCategory ?? "fwa-tracked-war-roster-current", sourceEvidence });
  const supportedBandCount = bandDiagnostics.filter((band) => band.status === "SUPPORTED").length;
  const artifactBase = {
    profileId: NATIVE_REFERENCE_PROFILE_ID,
    profileVersion: NATIVE_REFERENCE_PROFILE_VERSION,
    overallStatus: supportedBandCount === 0 ? "UNKNOWN" as const : supportedBandCount === bandDiagnostics.length ? "SUPPORTED" as const : "PARTIAL" as const,
    sourceCategory: input.sourceCategory ?? "fwa-tracked-war-roster-current",
    sampleThreshold: threshold,
    eraPolicy: policyResult.policy,
    evaluationAtIso: policyResult.evaluationAt.toISOString(),
    sourceObservationBounds,
    bucketDefinitionVersion: NATIVE_REFERENCE_BUCKET_DEFINITION_VERSION,
    bucketDefinitionFingerprint: computeNativeReferenceBucketDefinitionFingerprint(registry),
    bucketRegistry: registry,
    bandDefinitions: sortedBands(input.bandDefinitions),
    exclusions,
    exclusionCounts: countReasons(exclusions),
    diagnostics: bandDiagnostics,
    sourceEvidenceFingerprint,
    unknownReason: supportedBandCount === 0
      ? input.sourceRosters.length === 0 ? "no_source_evidence" : qualified.length === 0 ? "no_qualifying_evidence" : "insufficient_source_support"
      : null,
  };
  return { ...artifactBase, contentFingerprint: sha256(artifactBase) };
}

export function computeNativeReferenceBucketDefinitionFingerprint(
  registry: readonly NativeReferenceBucketDefinition[] = NATIVE_REFERENCE_BUCKET_REGISTRY,
): string {
  return sha256(registry.map((bucket) => ({ id: bucket.id, sourceBuckets: [...bucket.sourceBuckets].sort() })).sort((left, right) => left.id.localeCompare(right.id)));
}

export function validateNativeReferenceCandidateArtifact(
  artifact: Partial<NativeReferenceCandidateArtifact> | null | undefined,
): artifact is NativeReferenceCandidateArtifact {
  return Boolean(
    artifact &&
      artifact.profileId === NATIVE_REFERENCE_PROFILE_ID &&
      artifact.profileVersion === NATIVE_REFERENCE_PROFILE_VERSION &&
      typeof artifact.bucketDefinitionFingerprint === "string" &&
      /^[a-f0-9]{64}$/i.test(artifact.bucketDefinitionFingerprint) &&
      typeof artifact.contentFingerprint === "string" &&
      /^[a-f0-9]{64}$/i.test(artifact.contentFingerprint) &&
      typeof artifact.sourceEvidenceFingerprint === "string" &&
      /^[a-f0-9]{64}$/i.test(artifact.sourceEvidenceFingerprint) &&
      (() => {
        const { contentFingerprint, ...payload } = artifact as NativeReferenceCandidateArtifact;
        return sha256(payload) === contentFingerprint;
      })(),
  );
}

export const normalizeNativeReferenceAverageCountsForTest = normalizeAverageCounts;
export const validateNativeReferenceRegistryForTest = validateRegistry;
