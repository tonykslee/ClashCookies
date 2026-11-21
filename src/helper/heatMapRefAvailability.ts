import type { SettingsService } from "../services/SettingsService";

export const HEAT_MAP_REF_REBUILD_STATE_KEY_PREFIX = "heatmapref_rebuild_state";

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
      warning: null,
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
      typeof checkpoint.lastSuccessAtIso === "string"
        ? checkpoint.lastSuccessAtIso
        : null;
    const blocked = checkpoint.status === "blocked";
    if (blocked) {
      return {
        status: "retained_unverified",
        blockReasonCode,
        lastSuccessAtIso,
        warning:
          "HeatMapRef rows are retained historical data; current reference validation is blocked, so target comparisons remain UNKNOWN.",
      };
    }
    if (
      (checkpoint.status === "success" || checkpoint.status === "no_op") &&
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
    warning: null,
  };
}

export async function readHeatMapRefReferenceAvailability(input: {
  guildId?: string | null;
  settings: Pick<SettingsService, "get">;
}): Promise<HeatMapRefReferenceAvailability> {
  if (!input.guildId) {
    return parseHeatMapRefReferenceAvailability(null);
  }
  try {
    const raw = await input.settings.get(heatMapRefRebuildCheckpointKey(input.guildId));
    return parseHeatMapRefReferenceAvailability(raw);
  } catch {
    return parseHeatMapRefReferenceAvailability(null);
  }
}
