import type { HeatMapRef } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { SettingsService } from "../services/SettingsService";
import {
  computeHeatMapRefContentHash,
  type HeatMapRefContentHashRow,
} from "./heatMapRefRebuild";
import {
  HEAT_MAP_REF_SEED_ROWS,
  HEAT_MAP_REF_SEED_SOURCE_VERSION,
} from "../services/HeatMapRefSeedData";

export const HEAT_MAP_REF_REBUILD_STATE_KEY_PREFIX = "heatmapref_rebuild_state";
export const HEAT_MAP_REF_REFERENCE_INTEGRITY_KEY = "heatmapref_reference_integrity";
export const HEAT_MAP_REF_REFERENCE_INTEGRITY_VERSION = 1;

export async function acquireHeatMapRefReferenceWriteLock(
  client: Pick<Prisma.TransactionClient, "$executeRaw">,
): Promise<void> {
  await client.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${HEAT_MAP_REF_REFERENCE_INTEGRITY_KEY}, 0))`,
  );
}

export type HeatMapRefRebuildBlockReasonCode =
  | "th19_integrity"
  | "no_source_evidence"
  | "no_qualifying_evidence";

export type HeatMapRefReferenceAvailability = {
  status: "validated" | "retained_unverified" | "unknown";
  blockReasonCode: HeatMapRefRebuildBlockReasonCode | null;
  lastSuccessAtIso: string | null;
  warning: string | null;
};

export type HeatMapRefHistoricalReferenceAvailability = {
  status: "verified" | "unknown";
  sourceVersion: string | null;
  warning: string | null;
};

export function readHeatMapRefHistoricalReferenceAvailability(input: {
  heatMapRefs?: readonly (HeatMapRefContentHashRow | HeatMapRef)[];
}): HeatMapRefHistoricalReferenceAvailability {
  if (!input.heatMapRefs || input.heatMapRefs.length !== HEAT_MAP_REF_SEED_ROWS.length) {
    return {
      status: "unknown",
      sourceVersion: null,
      warning:
        "Persisted HeatMapRef rows do not match the checked-in historical legacy-v1 baseline; historical comparisons remain unavailable.",
    };
  }

  const persistedHash = computeHeatMapRefContentHash(input.heatMapRefs);
  const baselineHash = computeHeatMapRefContentHash(HEAT_MAP_REF_SEED_ROWS);
  if (persistedHash !== baselineHash) {
    return {
      status: "unknown",
      sourceVersion: null,
      warning:
        "Persisted HeatMapRef rows do not match the checked-in historical legacy-v1 baseline; historical comparisons remain unavailable.",
    };
  }

  return {
    status: "verified",
    sourceVersion: HEAT_MAP_REF_SEED_SOURCE_VERSION,
    warning: null,
  };
}

type CheckpointLike = {
  version?: unknown;
  status?: unknown;
  blockReasonCode?: unknown;
  reason?: unknown;
  updatedAtIso?: unknown;
  validatedAtIso?: unknown;
  contentHash?: unknown;
  evaluationGeneration?: unknown;
};

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isValidSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isValidEvaluationGeneration(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseIntegrityRecord(raw: string | null): HeatMapRefReferenceIntegrityRecord | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as CheckpointLike;
    if (
      record.version !== HEAT_MAP_REF_REFERENCE_INTEGRITY_VERSION ||
      !isValidIsoTimestamp(record.updatedAtIso) ||
      (record.validatedAtIso !== null && !isValidIsoTimestamp(record.validatedAtIso))
    ) {
      return null;
    }
    const hasEvaluationGeneration = Object.prototype.hasOwnProperty.call(record, "evaluationGeneration");
    const evaluationGeneration =
      record.evaluationGeneration === null || record.evaluationGeneration === undefined
        ? null
        : isValidEvaluationGeneration(record.evaluationGeneration)
          ? record.evaluationGeneration
          : null;
    if (hasEvaluationGeneration && record.evaluationGeneration !== null && evaluationGeneration === null) {
      return null;
    }
    if (record.status === "blocked") {
      if (
        (record.blockReasonCode !== "th19_integrity" &&
          record.blockReasonCode !== "no_source_evidence" &&
          record.blockReasonCode !== "no_qualifying_evidence") ||
        typeof record.reason !== "string" ||
        !record.reason.trim() ||
        record.contentHash !== null
      ) {
        return null;
      }
      return {
        version: HEAT_MAP_REF_REFERENCE_INTEGRITY_VERSION,
        status: "blocked",
        blockReasonCode: record.blockReasonCode,
        reason: record.reason.trim(),
        validatedAtIso: record.validatedAtIso,
        updatedAtIso: record.updatedAtIso,
        contentHash: null,
        evaluationGeneration,
      };
    }
    if (record.status === "pending") {
      if (typeof record.reason !== "string" || !record.reason.trim() || record.contentHash !== null) {
        return null;
      }
      return {
        version: HEAT_MAP_REF_REFERENCE_INTEGRITY_VERSION,
        status: "pending",
        blockReasonCode: null,
        reason: record.reason.trim(),
        validatedAtIso: record.validatedAtIso,
        updatedAtIso: record.updatedAtIso,
        contentHash: null,
        evaluationGeneration,
      };
    }
    if (
      record.status === "validated" &&
      record.blockReasonCode === null &&
      record.reason === null &&
      isValidIsoTimestamp(record.validatedAtIso) &&
      isValidSha256(record.contentHash)
    ) {
      return {
        version: HEAT_MAP_REF_REFERENCE_INTEGRITY_VERSION,
        status: "validated",
        blockReasonCode: null,
        reason: null,
        validatedAtIso: record.validatedAtIso,
        updatedAtIso: record.updatedAtIso,
        contentHash: record.contentHash.toLowerCase(),
        evaluationGeneration,
      };
    }
  } catch {
    // Treat malformed or legacy state as unknown rather than validated.
  }
  return null;
}

export function parseHeatMapRefReferenceIntegrityRecord(
  raw: string | null,
): HeatMapRefReferenceIntegrityRecord | null {
  return parseIntegrityRecord(raw);
}

export function heatMapRefRebuildCheckpointKey(guildId: string): string {
  return `${HEAT_MAP_REF_REBUILD_STATE_KEY_PREFIX}:${guildId}`;
}

export function parseHeatMapRefReferenceAvailability(
  raw: string | null,
): HeatMapRefReferenceAvailability {
  const record = parseIntegrityRecord(raw);
  if (!record) {
    return {
      status: "unknown",
      blockReasonCode: null,
      lastSuccessAtIso: null,
      warning:
        "HeatMapRef validation provenance is unavailable; historical rows remain displayable but target comparisons remain UNKNOWN.",
    };
  }
  if (record.status === "blocked") {
    return {
      status: "retained_unverified",
      blockReasonCode: record.blockReasonCode,
      lastSuccessAtIso: record.validatedAtIso,
      warning:
        `HeatMapRef rows are retained historical data; current reference validation is blocked (${record.reason}), so target comparisons remain UNKNOWN.`,
    };
  }
  if (record.status === "validated") {
    return {
      status: "validated",
      blockReasonCode: null,
      lastSuccessAtIso: record.validatedAtIso,
      warning: null,
    };
  }
  if (record.status === "pending") {
    return {
      status: "unknown",
      blockReasonCode: null,
      lastSuccessAtIso: record.validatedAtIso,
      warning:
        "HeatMapRef validation is in progress; historical rows remain displayable but target comparisons remain UNKNOWN.",
    };
  }
  return {
    status: "unknown",
    blockReasonCode: null,
    lastSuccessAtIso: null,
    warning:
      "HeatMapRef validation provenance is malformed or unavailable; historical rows remain displayable but target comparisons remain UNKNOWN.",
  };
}

export async function readHeatMapRefReferenceAvailability(input: {
  guildId?: string | null;
  settings: Pick<SettingsService, "get">;
  heatMapRefs?: readonly (HeatMapRefContentHashRow | HeatMapRef)[];
}): Promise<HeatMapRefReferenceAvailability> {
  try {
    const raw = await input.settings.get(HEAT_MAP_REF_REFERENCE_INTEGRITY_KEY);
    const record = parseIntegrityRecord(raw);
    const availability = parseHeatMapRefReferenceAvailability(raw);
    if (record?.status !== "validated") return availability;
    if (!input.heatMapRefs) {
      return {
        status: "unknown",
        blockReasonCode: null,
        lastSuccessAtIso: null,
        warning:
          "HeatMapRef validation provenance could not be matched to reference rows; target comparisons remain UNKNOWN.",
      };
    }
    const actualHash = computeHeatMapRefContentHash(input.heatMapRefs);
    if (actualHash !== record.contentHash) {
      return {
        status: "unknown",
        blockReasonCode: null,
        lastSuccessAtIso: null,
        warning:
          "HeatMapRef validation provenance does not match the current reference rows; target comparisons remain UNKNOWN.",
      };
    }
    return availability;
  } catch {
    return {
      status: "unknown",
      blockReasonCode: null,
      lastSuccessAtIso: null,
      warning:
        "HeatMapRef validation provenance could not be read; historical rows remain displayable but target comparisons remain UNKNOWN.",
    };
  }
}

export type HeatMapRefReferenceIntegrityRecord = {
  version: typeof HEAT_MAP_REF_REFERENCE_INTEGRITY_VERSION;
  status: "validated" | "blocked" | "pending";
  blockReasonCode: HeatMapRefRebuildBlockReasonCode | null;
  reason: string | null;
  validatedAtIso: string | null;
  updatedAtIso: string;
  contentHash: string | null;
  evaluationGeneration: string | null;
};

export function buildHeatMapRefReferenceIntegrityRecord(input: {
  status: "validated" | "blocked" | "pending";
  blockReasonCode?: HeatMapRefRebuildBlockReasonCode | null;
  reason?: string | null;
  validatedAtIso?: string | null;
  updatedAtIso: string;
  contentHash?: string | null;
  evaluationGeneration?: string | null;
}): HeatMapRefReferenceIntegrityRecord {
  return {
    version: HEAT_MAP_REF_REFERENCE_INTEGRITY_VERSION,
    status: input.status,
    blockReasonCode: input.status === "blocked" ? input.blockReasonCode ?? null : null,
    reason: input.status === "blocked" || input.status === "pending" ? input.reason ?? null : null,
    validatedAtIso: input.validatedAtIso ?? null,
    updatedAtIso: input.updatedAtIso,
    contentHash: input.status === "validated" ? input.contentHash ?? null : null,
    evaluationGeneration: input.evaluationGeneration ?? null,
  };
}

export function stringifyHeatMapRefReferenceIntegrity(
  value: HeatMapRefReferenceIntegrityRecord,
): string {
  return JSON.stringify(value);
}
