import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { compareActiveWarIdentities } from "./MatchTypeResolutionService";
import { formatError } from "../helper/formatError";
import { parseCocApiTime } from "../utils/cocTime";

export type ActiveWarIdentityState = "preparation" | "inWar" | "notInWar";

export type ActiveWarIdentityLiveWar = {
  state?: string | null;
  startTime?: string | Date | null;
  preparationStartTime?: string | Date | null;
  endTime?: string | Date | null;
  opponent?: {
    tag?: string | null;
    name?: string | null;
  } | null;
  clan?: {
    name?: string | null;
  } | null;
};

type ActiveWarIdentityCurrentWarRow = {
  warId: number | null;
  startTime: Date | null;
  opponentTag: string | null;
  state: string | null;
  prepStartTime: Date | null;
  endTime: Date | null;
  opponentName: string | null;
  clanName: string | null;
};

export type ActiveWarIdentityResolutionReason =
  | "reused_current_war_id"
  | "materialized_missing_current_war_id"
  | "rotated_stale_current_war_id"
  | "blocked_not_in_war"
  | "blocked_partial_live_identity"
  | "blocked_missing_current_row"
  | "blocked_persistence_error";

export type ActiveWarIdentityResolution = {
  warId: number | null;
  reason: ActiveWarIdentityResolutionReason;
  liveState: ActiveWarIdentityState;
  liveWarStartTime: Date | null;
  liveOpponentTag: string | null;
  currentWarId: number | null;
  currentWarStartTime: Date | null;
  currentWarOpponentTag: string | null;
  sameWar: boolean;
  liveIdentityComplete: boolean;
  positivelyResolved: boolean;
  materialized: boolean;
};

function normalizeTag(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
  return normalized ? normalized : null;
}

function normalizeDate(input: string | Date | null | undefined): Date | null {
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? input : null;
  }
  const parsed = parseCocApiTime(typeof input === "string" ? input : null);
  return parsed === null ? null : new Date(parsed);
}

function normalizeWarState(input: string | null | undefined): ActiveWarIdentityState {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (normalized === "preparation") return "preparation";
  if (normalized === "inwar") return "inWar";
  return "notInWar";
}

function normalizeWarId(input: number | string | null | undefined): number | null {
  const value = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function sanitizeClanName(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed ? trimmed : null;
}

function buildScopeKey(guildId: string, clanTag: string): string {
  return `${String(guildId ?? "").trim()}:${normalizeTag(clanTag) ?? "unknown"}`;
}

function buildResolutionLogLine(input: {
  stage: string;
  guildId: string;
  clanTag: string;
  resolution: ActiveWarIdentityResolution;
}): string {
  return (
    `[active-war-identity] stage=${input.stage}` +
    ` guild=${String(input.guildId ?? "none")}` +
    ` clan=#${normalizeTag(input.clanTag) ?? "unknown"}` +
    ` live_state=${input.resolution.liveState}` +
    ` live_war_start=${input.resolution.liveWarStartTime?.toISOString() ?? "none"}` +
    ` live_opponent=${input.resolution.liveOpponentTag ? `#${input.resolution.liveOpponentTag}` : "none"}` +
    ` current_war_id=${input.resolution.currentWarId ?? "none"}` +
    ` current_war_start=${input.resolution.currentWarStartTime?.toISOString() ?? "none"}` +
    ` current_war_opponent=${input.resolution.currentWarOpponentTag ? `#${input.resolution.currentWarOpponentTag}` : "none"}` +
    ` same_war=${input.resolution.sameWar ? "1" : "0"}` +
    ` live_identity_complete=${input.resolution.liveIdentityComplete ? "1" : "0"}` +
    ` positively_resolved=${input.resolution.positivelyResolved ? "1" : "0"}` +
    ` materialized=${input.resolution.materialized ? "1" : "0"}` +
    ` reason=${input.resolution.reason}` +
    ` resolved_war_id=${input.resolution.warId ?? "none"}`
  );
}

/** Purpose: own the canonical, concurrency-safe active-war identity resolution and materialization flow. */
export class ActiveWarIdentityService {
  constructor(private readonly db = prisma) {}

  async resolveCurrentWarId(input: {
    stage: string;
    guildId: string;
    clanTag: string;
    liveWar: ActiveWarIdentityLiveWar | null | undefined;
  }): Promise<ActiveWarIdentityResolution> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTagBare = normalizeTag(input.clanTag);
    const liveState = normalizeWarState(input.liveWar?.state ?? null);
    const liveWarStartTime = normalizeDate(input.liveWar?.startTime ?? null);
    const liveOpponentTag = normalizeTag(input.liveWar?.opponent?.tag ?? null);
    const liveOpponentName = sanitizeClanName(input.liveWar?.opponent?.name ?? null);
    const liveClanName = sanitizeClanName(input.liveWar?.clan?.name ?? null);
    const livePrepStartTime =
      normalizeDate(input.liveWar?.preparationStartTime ?? null) ??
      (liveState === "preparation" && liveWarStartTime
        ? new Date(liveWarStartTime.getTime() - 24 * 60 * 60 * 1000)
        : null);
    const liveEndTime = normalizeDate(input.liveWar?.endTime ?? null);
    const liveIdentityComplete =
      (liveState === "preparation" || liveState === "inWar") &&
      liveWarStartTime !== null &&
      liveOpponentTag !== null;

    const buildBlocked = (
      reason: ActiveWarIdentityResolutionReason,
      currentWar: ActiveWarIdentityCurrentWarRow | null,
    ): ActiveWarIdentityResolution => ({
      warId: null,
      reason,
      liveState,
      liveWarStartTime,
      liveOpponentTag,
      currentWarId: normalizeWarId(currentWar?.warId ?? null),
      currentWarStartTime: currentWar?.startTime ?? null,
      currentWarOpponentTag: normalizeTag(currentWar?.opponentTag ?? null),
      sameWar:
        currentWar !== null
          ? compareActiveWarIdentities({
              persisted: {
                warId: currentWar.warId,
                warStartTime: currentWar.startTime,
                opponentTag: currentWar.opponentTag,
              },
              active: {
                warStartTime: liveWarStartTime,
                opponentTag: liveOpponentTag,
              },
            }).sameWar
          : false,
      liveIdentityComplete,
      positivelyResolved:
        liveIdentityComplete &&
        (liveState === "preparation" || liveState === "inWar"),
      materialized: false,
    });

    if (!guildId || !clanTagBare) {
      const resolution = buildBlocked("blocked_missing_current_row", null);
      console.info(buildResolutionLogLine({ stage: input.stage, guildId, clanTag: input.clanTag, resolution }));
      return resolution;
    }

    if (!liveIdentityComplete) {
      const resolution = buildBlocked(
        liveState === "notInWar"
          ? "blocked_not_in_war"
          : "blocked_partial_live_identity",
        null,
      );
      console.info(
        buildResolutionLogLine({
          stage: input.stage,
          guildId,
          clanTag: input.clanTag,
          resolution,
        }),
      );
      return resolution;
    }

    let resolution: ActiveWarIdentityResolution | null = null;
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtext(${buildScopeKey(guildId, clanTagBare)})::bigint)
        `);

        const currentWar = await tx.currentWar.findUnique({
          where: {
            clanTag_guildId: {
              guildId,
              clanTag: `#${clanTagBare}`,
            },
          },
          select: {
            warId: true,
            state: true,
            prepStartTime: true,
            startTime: true,
            endTime: true,
            opponentTag: true,
            opponentName: true,
            clanName: true,
          },
        });

        if (!currentWar) {
          return (resolution = buildBlocked("blocked_missing_current_row", null));
        }

        const currentWarId = normalizeWarId(currentWar.warId ?? null);
        const comparison = compareActiveWarIdentities({
          persisted: {
            warId: currentWarId,
            warStartTime: currentWar.startTime ?? null,
            opponentTag: currentWar.opponentTag ?? null,
          },
          active: {
            warStartTime: liveWarStartTime,
            opponentTag: liveOpponentTag,
          },
        });

        if (comparison.sameWar && currentWarId !== null) {
          return (resolution = {
            warId: currentWarId,
            reason: "reused_current_war_id" as const,
            liveState,
            liveWarStartTime,
            liveOpponentTag,
            currentWarId,
            currentWarStartTime: currentWar.startTime ?? null,
            currentWarOpponentTag: normalizeTag(currentWar.opponentTag ?? null),
            sameWar: true,
            liveIdentityComplete: true,
            positivelyResolved: true,
            materialized: false,
          });
        }

        const allocatedRows = await tx.$queryRaw<Array<{ warId: bigint | number }>>(
          Prisma.sql`
            SELECT nextval('"CurrentWar_warId_seq"'::regclass) AS "warId"
          `,
        );
        const rawWarId = allocatedRows[0]?.warId ?? null;
        const allocatedWarId =
          rawWarId === null || rawWarId === undefined
            ? null
            : typeof rawWarId === "bigint"
              ? Number(rawWarId)
              : Number(rawWarId);
        if (!Number.isFinite(allocatedWarId ?? NaN)) {
          return (resolution = buildBlocked("blocked_persistence_error", currentWar));
        }

        const persisted = await tx.currentWar.update({
          where: {
            clanTag_guildId: {
              guildId,
              clanTag: `#${clanTagBare}`,
            },
          },
          data: {
            warId: Math.trunc(Number(allocatedWarId)),
            state: liveState,
            prepStartTime: livePrepStartTime ?? currentWar.prepStartTime,
            startTime: liveWarStartTime,
            endTime: liveEndTime ?? currentWar.endTime,
            opponentTag: liveOpponentTag ? `#${liveOpponentTag}` : currentWar.opponentTag,
            opponentName: liveOpponentName ?? currentWar.opponentName,
            clanName: liveClanName ?? currentWar.clanName,
          },
          select: {
            warId: true,
            state: true,
            prepStartTime: true,
            startTime: true,
            endTime: true,
            opponentTag: true,
            opponentName: true,
            clanName: true,
          },
        });

        const resolvedWarId = normalizeWarId(persisted.warId ?? null);
        return (resolution = {
          warId: resolvedWarId,
          reason: comparison.sameWar
            ? ("materialized_missing_current_war_id" as const)
            : ("rotated_stale_current_war_id" as const),
          liveState,
          liveWarStartTime,
          liveOpponentTag,
          currentWarId,
          currentWarStartTime: persisted.startTime ?? null,
          currentWarOpponentTag: normalizeTag(persisted.opponentTag ?? null),
          sameWar: comparison.sameWar,
          liveIdentityComplete: true,
          positivelyResolved: true,
          materialized: true,
        });
      });

      const finalResolution =
        resolution ?? buildBlocked("blocked_persistence_error", null);
      const logLine = buildResolutionLogLine({
        stage: input.stage,
        guildId,
        clanTag: input.clanTag,
        resolution: finalResolution,
      });
      if (finalResolution.reason === "reused_current_war_id") {
        console.debug(logLine);
      } else {
        console.info(logLine);
      }
      return finalResolution;
    } catch (error) {
      const resolution = buildBlocked("blocked_persistence_error", null);
      console.error(
        `${buildResolutionLogLine({ stage: input.stage, guildId, clanTag: input.clanTag, resolution })} error=${formatError(error)}`,
      );
      return resolution;
    }
  }
}

export const resolveCurrentWarIdForTest =
  ActiveWarIdentityService.prototype.resolveCurrentWarId;
