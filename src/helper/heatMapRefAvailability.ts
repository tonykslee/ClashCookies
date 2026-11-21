import type { SettingsService } from "../services/SettingsService";

export const HEAT_MAP_REF_REBUILD_STATE_KEY_PREFIX = "heatmapref_rebuild_state";
export const HEAT_MAP_REF_REFERENCE_INTEGRITY_KEY = "heatmapref_reference_integrity";

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

type CheckpointLike = {
  status?: unknown;
  lastSuccessAtIso?: unknown;
  blockReasonCode?: unknown;
  reason?: unknown;
  updatedAtIso?: unknown;
  validatedAtIso?: unknown;
  contentHash?: unknown;
};

export function heatMapRefRebuildCheckpointKey(guildId: string): string {
  return `${HEAT_MAP_REF_REBUILD_STATE_KEY_PREFIX}:${guildId}`;
}

export function parseHeatMapRefReferenceAvailability(
  raw: string | null,
): HeatMapRefReferenceAvailability {
  if (!raw) {
    return {
      status: "unknown",
      blockReasonCode: null,
      lastSuccessAtIso: null,
      warning:
        "HeatMapRef validation provenance is unavailable; historical rows remain displayable but target comparisons remain UNKNOWN.",
    };
  }

  try {
    const checkpoint = JSON.parse(raw) as CheckpointLike;
    const blockReasonCode =
      checkpoint.blockReasonCode === "th19_integrity" ||
      checkpoint.blockReasonCode === "no_source_evidence" ||
      checkpoint.blockReasonCode === "no_qualifying_evidence"
        ? checkpoint.blockReasonCode
        : null;
    const lastSuccessAtIso =
      typeof checkpoint.validatedAtIso === "string"
        ? checkpoint.validatedAtIso
        : typeof checkpoint.lastSuccessAtIso === "string"
          ? checkpoint.lastSuccessAtIso
        : null;
    const blocked = checkpoint.status === "blocked";
    if (blocked) {
      return {
        status: "retained_unverified",
        blockReasonCode,
        lastSuccessAtIso,
        warning:
          `HeatMapRef rows are retained historical data; current reference validation is blocked${typeof checkpoint.reason === "string" && checkpoint.reason.trim() ? ` (${checkpoint.reason.trim()})` : ""}, so target comparisons remain UNKNOWN.`,
      };
    }
    if (
      checkpoint.status === "validated" &&
      lastSuccessAtIso
    ) {
      return {
        status: "validated",
        blockReasonCode: null,
        lastSuccessAtIso,
        warning: null,
      };
    }
  } catch {
    // Treat malformed or legacy checkpoint state as unknown rather than validated.
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
}): Promise<HeatMapRefReferenceAvailability> {
  try {
    const raw = await input.settings.get(HEAT_MAP_REF_REFERENCE_INTEGRITY_KEY);
    return parseHeatMapRefReferenceAvailability(raw);
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
  status: "validated" | "blocked";
  blockReasonCode: HeatMapRefRebuildBlockReasonCode | null;
  reason: string | null;
  validatedAtIso: string | null;
  updatedAtIso: string;
  contentHash: string | null;
};

export function buildHeatMapRefReferenceIntegrityRecord(input: {
  status: "validated" | "blocked";
  blockReasonCode?: HeatMapRefRebuildBlockReasonCode | null;
  reason?: string | null;
  validatedAtIso?: string | null;
  updatedAtIso: string;
  contentHash?: string | null;
}): HeatMapRefReferenceIntegrityRecord {
  return {
    status: input.status,
    blockReasonCode: input.status === "blocked" ? input.blockReasonCode ?? null : null,
    reason: input.status === "blocked" ? input.reason ?? null : null,
    validatedAtIso: input.validatedAtIso ?? null,
    updatedAtIso: input.updatedAtIso,
    contentHash: input.status === "validated" ? input.contentHash ?? null : null,
  };
}

export function stringifyHeatMapRefReferenceIntegrity(
  value: HeatMapRefReferenceIntegrityRecord,
): string {
  return JSON.stringify(value);
}
