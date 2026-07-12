import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { parseCocApiTime } from "../utils/cocTime";

export type ActiveWarIdentityState = "preparation" | "inWar" | "notInWar";

export type ActiveWarIdentityPolicy =
  | "poll_reconcile"
  | "interactive_materialize"
  | "preserve_persisted";

export type CanonicalActiveWarIdentity = {
  state: ActiveWarIdentityState;
  warStartTime: Date;
  preparationStartTime: Date;
  warEndTime: Date;
  opponentTag: string;
  opponentName: string;
  clanName: string;
};

export type ActiveWarIdentityCandidate = {
  state?: string | null;
  warStartTime?: string | Date | null;
  preparationStartTime?: string | Date | null;
  warEndTime?: string | Date | null;
  opponentTag?: string | null;
  opponentName?: string | null;
  clanName?: string | null;
};

type ActiveWarIdentityCurrentWarRow = {
  warId: number | null;
  state: string | null;
  prepStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  opponentTag: string | null;
  opponentName: string | null;
  clanName: string | null;
};

type ActiveWarIdentityResolvedSource =
  | "existing_exact_row"
  | "reused_global_exact_identity"
  | "materialized_missing_id"
  | "allocated_new_identity"
  | "preserved_during_outage_recovery";

type ActiveWarIdentityBlockedReason =
  | "not_in_war"
  | "partial_live_identity"
  | "missing_current_row"
  | "persisted_identity_mismatch"
  | "missing_preserved_id"
  | "persistence_failure";

export type ActiveWarIdentityResult =
  | {
      status: "resolved";
      warId: number;
      source:
        | "existing_exact_row"
        | "reused_global_exact_identity"
        | "materialized_missing_id"
        | "allocated_new_identity"
        | "preserved_during_outage_recovery";
      identity: CanonicalActiveWarIdentity;
      identityPersisted: boolean;
      liveValidated: boolean;
    }
  | {
      status: "blocked";
      warId: null;
      reason:
        | "not_in_war"
        | "partial_live_identity"
        | "missing_current_row"
        | "persisted_identity_mismatch"
        | "missing_preserved_id"
        | "persistence_failure";
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

function normalizeState(input: string | null | undefined): ActiveWarIdentityState {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "preparation") return "preparation";
  if (value === "inwar") return "inWar";
  return "notInWar";
}

function sanitizeText(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeWarId(input: number | string | null | undefined): number | null {
  const value = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function buildCanonicalIdentity(input: ActiveWarIdentityCandidate): CanonicalActiveWarIdentity | null {
  const state = normalizeState(input.state ?? null);
  if (state === "notInWar") return null;

  const warStartTime = normalizeDate(input.warStartTime ?? null);
  const preparationStartTime = normalizeDate(input.preparationStartTime ?? null);
  const warEndTime = normalizeDate(input.warEndTime ?? null);
  const opponentTag = normalizeTag(input.opponentTag ?? null);
  const opponentName = sanitizeText(input.opponentName ?? null);
  const clanName = sanitizeText(input.clanName ?? null);

  if (
    !warStartTime ||
    !preparationStartTime ||
    !warEndTime ||
    !opponentTag ||
    !opponentName ||
    !clanName
  ) {
    return null;
  }

  return {
    state,
    warStartTime,
    preparationStartTime,
    warEndTime,
    opponentTag,
    opponentName,
    clanName,
  };
}

function buildPhysicalIdentityKey(input: {
  clanTag: string;
  identity: Pick<CanonicalActiveWarIdentity, "warStartTime" | "opponentTag">;
}): string {
  return [
    normalizeTag(input.clanTag) ?? "unknown",
    input.identity.warStartTime.toISOString(),
    normalizeTag(input.identity.opponentTag) ?? "unknown",
  ].join("|");
}

function samePhysicalIdentity(
  persisted: Pick<ActiveWarIdentityCurrentWarRow, "startTime" | "opponentTag">,
  active: Pick<CanonicalActiveWarIdentity, "warStartTime" | "opponentTag">,
): boolean {
  return (
    persisted.startTime instanceof Date &&
    persisted.startTime.getTime() === active.warStartTime.getTime() &&
    normalizeTag(persisted.opponentTag ?? null) === normalizeTag(active.opponentTag)
  );
}

function buildResolvedIdentity(
  row: ActiveWarIdentityCurrentWarRow | null,
  identity: CanonicalActiveWarIdentity,
): CanonicalActiveWarIdentity {
  return {
    state: normalizeState(row?.state ?? identity.state),
    warStartTime: row?.startTime ?? identity.warStartTime,
    preparationStartTime: row?.prepStartTime ?? identity.preparationStartTime,
    warEndTime: row?.endTime ?? identity.warEndTime,
    opponentTag: normalizeTag(row?.opponentTag ?? identity.opponentTag) ?? identity.opponentTag,
    opponentName: sanitizeText(row?.opponentName ?? identity.opponentName) ?? identity.opponentName,
    clanName: sanitizeText(row?.clanName ?? identity.clanName) ?? identity.clanName,
  };
}

function isValidResolvedWarId(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.trunc(value) > 0;
}

function buildBlocked(
  reason: ActiveWarIdentityBlockedReason,
): ActiveWarIdentityResult {
  return {
    status: "blocked",
    warId: null,
    reason,
  } as ActiveWarIdentityResult;
}

function buildResolved(params: {
  source: ActiveWarIdentityResolvedSource;
  identity: CanonicalActiveWarIdentity;
  warId: number;
  identityPersisted: boolean;
  liveValidated: boolean;
}): ActiveWarIdentityResult {
  return {
    status: "resolved",
    source: params.source,
    identity: params.identity,
    warId: Math.trunc(params.warId),
    identityPersisted: params.identityPersisted,
    liveValidated: params.liveValidated,
  } as ActiveWarIdentityResult;
}

/** Purpose: own the canonical, concurrency-safe active-war identity resolution flow. */
export class ActiveWarIdentityService {
  constructor(private readonly db = prisma) {}

  async resolveCurrentWarId(input: {
    policy: ActiveWarIdentityPolicy;
    guildId: string;
    clanTag: string;
    candidateIdentity?: ActiveWarIdentityCandidate | null;
  }): Promise<ActiveWarIdentityResult> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTagBare = normalizeTag(input.clanTag);

    if (!guildId || !clanTagBare) {
      return buildBlocked("missing_current_row");
    }

    if (input.policy === "preserve_persisted") {
      return this.resolvePreservedCurrentWar({
        guildId,
        clanTag: clanTagBare,
      });
    }

    const candidate = buildCanonicalIdentity(input.candidateIdentity ?? {});
    if (!candidate) {
      return buildBlocked(
        normalizeState(input.candidateIdentity?.state ?? null) === "notInWar"
          ? "not_in_war"
          : "partial_live_identity",
      );
    }

    const lockKey = buildPhysicalIdentityKey({
      clanTag: clanTagBare,
      identity: candidate,
    });

    try {
      let resolution: ActiveWarIdentityResult | null = null;
      await this.db.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
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
          resolution = buildBlocked("missing_current_row");
          return;
        }

        const currentWarId = normalizeWarId(currentWar.warId ?? null);
        const exactPhysicalMatch = samePhysicalIdentity(
          currentWar,
          candidate,
        );

        if (input.policy === "interactive_materialize" && !exactPhysicalMatch) {
          resolution = buildBlocked("persisted_identity_mismatch");
          return;
        }

        if (input.policy === "poll_reconcile") {
          const exactGlobalRow = await tx.currentWar.findMany({
            where: {
              clanTag: `#${clanTagBare}`,
              startTime: candidate.warStartTime,
              opponentTag: `#${candidate.opponentTag}`,
              warId: { not: null },
            },
            orderBy: [{ updatedAt: "desc" }],
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
          const globalWarId = normalizeWarId(exactGlobalRow[0]?.warId ?? null);
          const selectedWarId =
            exactPhysicalMatch && currentWarId !== null
              ? currentWarId
              : globalWarId ?? (await this.allocateNextWarId(tx));
          if (selectedWarId === null) {
            resolution = buildBlocked("persistence_failure");
            return;
          }

          const updated = await tx.currentWar.update({
            where: {
              clanTag_guildId: {
                guildId,
                clanTag: `#${clanTagBare}`,
              },
            },
            data: {
              warId: selectedWarId,
              state: candidate.state,
              prepStartTime: candidate.preparationStartTime,
              startTime: candidate.warStartTime,
              endTime: candidate.warEndTime,
              opponentTag: `#${candidate.opponentTag}`,
              opponentName: candidate.opponentName,
              clanName: candidate.clanName,
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

          resolution = buildResolved({
            source:
              exactPhysicalMatch && currentWarId !== null
                ? "existing_exact_row"
                : globalWarId !== null
                  ? "reused_global_exact_identity"
                  : currentWarId !== null && exactPhysicalMatch
                    ? "existing_exact_row"
                    : currentWarId === null && exactPhysicalMatch
                      ? "materialized_missing_id"
                      : "allocated_new_identity",
            identity: buildResolvedIdentity(updated, candidate),
            warId: normalizeWarId(updated.warId ?? null) ?? selectedWarId,
            identityPersisted: true,
            liveValidated: true,
          });
          return;
        }

        const exactGlobalRow = await tx.currentWar.findMany({
          where: {
            clanTag: `#${clanTagBare}`,
            startTime: candidate.warStartTime,
            opponentTag: `#${candidate.opponentTag}`,
            warId: { not: null },
          },
          orderBy: [{ updatedAt: "desc" }],
          select: {
            warId: true,
          },
        });
        const globalWarId = normalizeWarId(exactGlobalRow[0]?.warId ?? null);
        const resolvedWarId =
          currentWarId ?? globalWarId ?? (await this.allocateNextWarId(tx));
        if (resolvedWarId === null) {
          resolution = buildBlocked("persistence_failure");
          return;
        }

        if (currentWarId !== null) {
          resolution = buildResolved({
            source: "existing_exact_row",
            identity: buildResolvedIdentity(currentWar, candidate),
            warId: currentWarId,
            identityPersisted: true,
            liveValidated: true,
          });
          return;
        }

        if (globalWarId !== null) {
          await tx.currentWar.update({
            where: {
              clanTag_guildId: {
                guildId,
                clanTag: `#${clanTagBare}`,
              },
            },
            data: {
              warId: globalWarId,
            },
          });
          resolution = buildResolved({
            source: "reused_global_exact_identity",
            identity: buildResolvedIdentity(
              {
                ...currentWar,
                warId: globalWarId,
              },
              candidate,
            ),
            warId: globalWarId,
            identityPersisted: true,
            liveValidated: true,
          });
          return;
        }

        const updated = await tx.currentWar.update({
          where: {
            clanTag_guildId: {
              guildId,
              clanTag: `#${clanTagBare}`,
            },
          },
          data: {
            warId: resolvedWarId,
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

        resolution = buildResolved({
          source: exactPhysicalMatch
            ? "materialized_missing_id"
            : "allocated_new_identity",
          identity: buildResolvedIdentity(updated, candidate),
          warId: normalizeWarId(updated.warId ?? null) ?? resolvedWarId,
          identityPersisted: true,
          liveValidated: true,
        });
      });

      if (!resolution) {
        return buildBlocked("persistence_failure");
      }
      return resolution;
    } catch (error) {
      void error;
      return buildBlocked("persistence_failure");
    }
  }

  private async resolvePreservedCurrentWar(input: {
    guildId: string;
    clanTag: string;
  }): Promise<ActiveWarIdentityResult> {
    try {
      let resolution: ActiveWarIdentityResult | null = null;
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${input.guildId}:${input.clanTag}`}, 0))
        `);

        const currentWar = await tx.currentWar.findUnique({
          where: {
            clanTag_guildId: {
              guildId: input.guildId,
              clanTag: `#${input.clanTag}`,
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

        const currentWarId = normalizeWarId(currentWar?.warId ?? null);
        if (currentWarId === null) {
          resolution = buildBlocked("missing_preserved_id");
          return;
        }

        const identity: CanonicalActiveWarIdentity = {
          state: normalizeState(currentWar?.state ?? null),
          warStartTime:
            currentWar?.startTime ?? currentWar?.prepStartTime ?? new Date(),
          preparationStartTime:
            currentWar?.prepStartTime ?? currentWar?.startTime ?? new Date(),
          warEndTime: currentWar?.endTime ?? currentWar?.startTime ?? new Date(),
          opponentTag: normalizeTag(currentWar?.opponentTag ?? null) ?? "unknown",
          opponentName: sanitizeText(currentWar?.opponentName ?? null) ?? "unknown",
          clanName: sanitizeText(currentWar?.clanName ?? null) ?? input.clanTag,
        };
        resolution = buildResolved({
          source: "preserved_during_outage_recovery",
          identity,
          warId: currentWarId,
          identityPersisted: true,
          liveValidated: false,
        });
      });

      return resolution ?? buildBlocked("persistence_failure");
    } catch (error) {
      void error;
      return buildBlocked("persistence_failure");
    }
  }

  private async allocateNextWarId(tx: any): Promise<number | null> {
    const rows = (await tx.$queryRaw(
      Prisma.sql`
        SELECT nextval('"CurrentWar_warId_seq"'::regclass) AS "warId"
      `,
    )) as Array<{ warId: bigint | number }>;
    const raw = rows[0]?.warId ?? null;
    if (raw === null || raw === undefined) return null;
    const warId = typeof raw === "bigint" ? Number(raw) : Number(raw);
    return isValidResolvedWarId(warId) ? Math.trunc(warId) : null;
  }
}

export const resolveCurrentWarIdForTest =
  ActiveWarIdentityService.prototype.resolveCurrentWarId;
