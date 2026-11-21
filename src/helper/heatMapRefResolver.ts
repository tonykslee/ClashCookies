import type { HeatMapRef, HeatMapRefBucketTarget, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { validateHeatMapRefContinuity } from "./heatMapRefContinuity";
import {
  readHeatMapRefReferenceAvailability,
  type HeatMapRefReferenceAvailability,
} from "./heatMapRefAvailability";
import { SettingsService } from "../services/SettingsService";

/** The only bucket IDs covered by the version-1 legacy content hash. */
export const LEGACY_HEAT_MAP_REF_BUCKET_IDS = [
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "TH13",
  "TH12",
  "TH11",
  "TH10_OR_LOWER",
] as const;

export type LegacyHeatMapRefBucketId = (typeof LEGACY_HEAT_MAP_REF_BUCKET_IDS)[number];
export type HeatMapRefBucketTargetLike = Pick<
  HeatMapRefBucketTarget,
  "weightMinInclusive" | "weightMaxInclusive" | "bucketId" | "targetCount" | "status"
>;

type HeatMapRefReferenceClient = Pick<
  PrismaClient,
  "heatMapRef" | "heatMapRefBucketTarget"
>;

export type HeatMapRefReferenceResolution = {
  /** Legacy parent rows remain the authoritative v1 projection during P2. */
  heatMapRefs: HeatMapRef[];
  /** Child rows are exposed for diagnostics and future native profiles. */
  bucketTargets: HeatMapRefBucketTargetLike[];
  supportedBucketIds: readonly string[];
  normalizedState: "verified" | "missing" | "invalid" | "legacy_compatibility";
  availability: HeatMapRefReferenceAvailability;
};

function unknownAvailability(warning: string): HeatMapRefReferenceAvailability {
  return {
    status: "unknown",
    blockReasonCode: null,
    lastSuccessAtIso: null,
    warning,
  };
}

function isIntegerCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function buildTargetKey(row: Pick<HeatMapRefBucketTargetLike, "weightMinInclusive" | "weightMaxInclusive" | "bucketId">): string {
  return `${row.weightMinInclusive}:${row.weightMaxInclusive}:${row.bucketId}`;
}

function validateLegacyTargets(
  heatMapRefs: readonly HeatMapRef[],
  bucketTargets: readonly HeatMapRefBucketTargetLike[],
): { ok: true; supportedBucketIds: readonly string[] } | { ok: false; reason: string } {
  const continuity = validateHeatMapRefContinuity(heatMapRefs);
  if (!continuity.hasContinuousCoverage) {
    return { ok: false, reason: "HeatMapRef bands are invalid or not continuously ordered" };
  }

  const parentKeys = new Set(
    heatMapRefs.map((row) => `${row.weightMinInclusive}:${row.weightMaxInclusive}`),
  );
  const expectedKeys = new Set<string>();
  for (const row of heatMapRefs) {
    for (const bucketId of LEGACY_HEAT_MAP_REF_BUCKET_IDS) {
      expectedKeys.add(`${row.weightMinInclusive}:${row.weightMaxInclusive}:${bucketId}`);
    }
  }

  const actualKeys = new Set<string>();
  for (const row of bucketTargets) {
    const parentKey = `${row.weightMinInclusive}:${row.weightMaxInclusive}`;
    if (!parentKeys.has(parentKey)) {
      return { ok: false, reason: `normalized target has no HeatMapRef parent (${parentKey})` };
    }
    if (!row.bucketId.trim()) {
      return { ok: false, reason: "normalized target has an empty bucket identifier" };
    }
    const key = buildTargetKey(row);
    if (actualKeys.has(key)) {
      return { ok: false, reason: `normalized target is duplicated (${key})` };
    }
    actualKeys.add(key);
    if (!expectedKeys.has(key)) {
      return { ok: false, reason: `normalized target is not covered by the v1 legacy profile (${key})` };
    }
    if (row.status !== "SUPPORTED" || !isIntegerCount(row.targetCount)) {
      return { ok: false, reason: `normalized target is not an explicit supported count (${key})` };
    }
  }

  if (actualKeys.size !== expectedKeys.size) {
    return { ok: false, reason: "normalized target coverage is incomplete" };
  }

  const parentByKey = new Map(
    heatMapRefs.map((row) => [`${row.weightMinInclusive}:${row.weightMaxInclusive}`, row]),
  );
  for (const row of bucketTargets) {
    const parent = parentByKey.get(`${row.weightMinInclusive}:${row.weightMaxInclusive}`);
    if (!parent) return { ok: false, reason: "normalized target parent disappeared during validation" };
    const expectedCount =
      row.bucketId === "TH18" ? parent.th18Count :
      row.bucketId === "TH17" ? parent.th17Count :
      row.bucketId === "TH16" ? parent.th16Count :
      row.bucketId === "TH15" ? parent.th15Count :
      row.bucketId === "TH14" ? parent.th14Count :
      row.bucketId === "TH13" ? parent.th13Count :
      row.bucketId === "TH12" ? parent.th12Count :
      row.bucketId === "TH11" ? parent.th11Count :
      parent.th10OrLowerCount;
    if (row.targetCount !== expectedCount) {
      return { ok: false, reason: `normalized target does not match its legacy parent (${buildTargetKey(row)})` };
    }
  }
  return { ok: true, supportedBucketIds: LEGACY_HEAT_MAP_REF_BUCKET_IDS };
}

/**
 * Load one bounded reference snapshot. During P2 the parent remains the
 * v1 authority; normalized children must prove exact parity before targets
 * are returned as usable. No Town Hall maximum is encoded in the schema.
 */
export async function resolveHeatMapRefReference(input: {
  guildId?: string | null;
  settings?: Pick<SettingsService, "get">;
  client?: HeatMapRefReferenceClient;
}): Promise<HeatMapRefReferenceResolution> {
  const client = input.client ?? prisma;
  const heatMapRefs = await client.heatMapRef.findMany({
    orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
  });
  const bucketTargetDelegate = client.heatMapRefBucketTarget;

  // Test doubles and an older generated client do not expose the additive
  // delegate. Real new readers have it and fail closed on absent rows.
  if (!bucketTargetDelegate || typeof bucketTargetDelegate.findMany !== "function") {
    const availability = await readHeatMapRefReferenceAvailability({
      guildId: input.guildId,
      settings: input.settings ?? new SettingsService(),
      heatMapRefs,
    });
    return {
      heatMapRefs,
      bucketTargets: [],
      supportedBucketIds: LEGACY_HEAT_MAP_REF_BUCKET_IDS,
      normalizedState: "legacy_compatibility",
      availability,
    };
  }

  const bucketTargets = await bucketTargetDelegate.findMany({
    orderBy: [
      { weightMinInclusive: "asc" },
      { weightMaxInclusive: "asc" },
      { bucketId: "asc" },
    ],
  });
  const validation = validateLegacyTargets(heatMapRefs, bucketTargets);
  if (!validation.ok) {
    return {
      heatMapRefs,
      bucketTargets,
      supportedBucketIds: [],
      normalizedState: bucketTargets.length === 0 ? "missing" : "invalid",
      availability: unknownAvailability(
        `HeatMapRef normalized target evidence is ${bucketTargets.length === 0 ? "missing" : "invalid"} (${validation.reason}); target comparisons remain UNKNOWN.`,
      ),
    };
  }

  const availability = await readHeatMapRefReferenceAvailability({
    guildId: input.guildId,
    settings: input.settings ?? new SettingsService(),
    heatMapRefs,
  });
  return {
    heatMapRefs,
    bucketTargets,
    supportedBucketIds: validation.supportedBucketIds,
    normalizedState: "verified",
    availability,
  };
}

export function buildLegacyHeatMapRefBucketTargets(
  rows: readonly Pick<HeatMapRef, "weightMinInclusive" | "weightMaxInclusive" | "th18Count" | "th17Count" | "th16Count" | "th15Count" | "th14Count" | "th13Count" | "th12Count" | "th11Count" | "th10OrLowerCount">[],
): Array<{
  weightMinInclusive: number;
  weightMaxInclusive: number;
  bucketId: LegacyHeatMapRefBucketId;
  targetCount: number;
  status: "SUPPORTED";
}> {
  return rows.flatMap((row) => [
    ["TH18", row.th18Count],
    ["TH17", row.th17Count],
    ["TH16", row.th16Count],
    ["TH15", row.th15Count],
    ["TH14", row.th14Count],
    ["TH13", row.th13Count],
    ["TH12", row.th12Count],
    ["TH11", row.th11Count],
    ["TH10_OR_LOWER", row.th10OrLowerCount],
  ].map(([bucketId, targetCount]) => ({
    weightMinInclusive: row.weightMinInclusive,
    weightMaxInclusive: row.weightMaxInclusive,
    bucketId: bucketId as LegacyHeatMapRefBucketId,
    targetCount: targetCount as number,
    status: "SUPPORTED" as const,
  })));
}

export const validateLegacyHeatMapRefTargets = validateLegacyTargets;
export const validateLegacyHeatMapRefTargetsForTest = validateLegacyTargets;
