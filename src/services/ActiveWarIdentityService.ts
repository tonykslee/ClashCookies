import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { parseCocApiTime } from "../utils/cocTime";

export type ActiveWarIdentityState = "preparation" | "inWar" | "notInWar";

export type ActiveWarIdentityPolicy =
  | "poll_reconcile"
  | "interactive_materialize"
  | "preserve_persisted";

export type PhysicalActiveWarIdentity = {
  state: "preparation" | "inWar";
  warStartTime: Date;
  opponentTag: string;
};

export type ActiveWarIdentityMetadata = {
  preparationStartTime: Date | null;
  warEndTime: Date | null;
  opponentName: string | null;
  clanName: string | null;
};

export type CanonicalActiveWarIdentity = PhysicalActiveWarIdentity &
  ActiveWarIdentityMetadata;

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
  | "conflicting_global_identity_ids"
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
        | "conflicting_global_identity_ids"
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

function normalizeState(
  input: string | null | undefined,
): ActiveWarIdentityState {
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

function buildCanonicalIdentity(
  input: ActiveWarIdentityCandidate,
): { physical: PhysicalActiveWarIdentity; metadata: ActiveWarIdentityMetadata } | null {
  const state = normalizeState(input.state ?? null);
  if (state === "notInWar") return null;

  const warStartTime = normalizeDate(input.warStartTime ?? null);
  const opponentTag = normalizeTag(input.opponentTag ?? null);
  if (!warStartTime || !opponentTag) {
    return null;
  }

  const metadata: ActiveWarIdentityMetadata = {
    preparationStartTime: normalizeDate(input.preparationStartTime ?? null),
    warEndTime: normalizeDate(input.warEndTime ?? null),
    opponentName: sanitizeText(input.opponentName ?? null),
    clanName: sanitizeText(input.clanName ?? null),
  };

  return {
    physical: {
      state,
      warStartTime,
      opponentTag,
    },
    metadata,
  };
}

function buildPhysicalIdentityKey(input: {
  clanTag: string;
  identity: Pick<PhysicalActiveWarIdentity, "warStartTime" | "opponentTag">;
}): string {
  return [
    normalizeTag(input.clanTag) ?? "unknown",
    input.identity.warStartTime.toISOString(),
    normalizeTag(input.identity.opponentTag) ?? "unknown",
  ].join("|");
}

function samePhysicalIdentity(
  persisted: Pick<ActiveWarIdentityCurrentWarRow, "startTime" | "opponentTag">,
  active: Pick<PhysicalActiveWarIdentity, "warStartTime" | "opponentTag">,
): boolean {
  return (
    persisted.startTime instanceof Date &&
    persisted.startTime.getTime() === active.warStartTime.getTime() &&
    normalizeTag(persisted.opponentTag ?? null) === normalizeTag(active.opponentTag)
  );
}

function buildResolvedIdentity(
  row: ActiveWarIdentityCurrentWarRow | null,
  identity: PhysicalActiveWarIdentity,
  metadata?: Partial<ActiveWarIdentityMetadata> | null,
): CanonicalActiveWarIdentity {
  const rowState = normalizeState(row?.state ?? null);
  const state =
    rowState === "preparation" || rowState === "inWar" ? rowState : identity.state;
  return {
    state,
    warStartTime: row?.startTime ?? identity.warStartTime,
    opponentTag:
      normalizeTag(row?.opponentTag ?? identity.opponentTag) ??
      identity.opponentTag,
    preparationStartTime:
      row?.prepStartTime ?? metadata?.preparationStartTime ?? null,
    warEndTime: row?.endTime ?? metadata?.warEndTime ?? null,
    opponentName:
      sanitizeText(row?.opponentName ?? metadata?.opponentName ?? null) ??
      null,
    clanName:
      sanitizeText(row?.clanName ?? metadata?.clanName ?? null) ?? null,
  };
}

function buildPersistedIdentity(
  row: ActiveWarIdentityCurrentWarRow | null,
): CanonicalActiveWarIdentity | null {
  const state = normalizeState(row?.state ?? null);
  const warStartTime = row?.startTime ?? null;
  const opponentTag = normalizeTag(row?.opponentTag ?? null);
  if (state !== "preparation" && state !== "inWar") return null;
  if (!warStartTime || !opponentTag) return null;
  return {
    state,
    warStartTime,
    opponentTag,
    preparationStartTime: row?.prepStartTime ?? null,
    warEndTime: row?.endTime ?? null,
    opponentName: sanitizeText(row?.opponentName ?? null),
    clanName: sanitizeText(row?.clanName ?? null),
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

    try {
      let resolution: ActiveWarIdentityResult | null = null;
      await this.db.$transaction(async (tx: Prisma.TransactionClient) => {
        const currentWar = await this.lockTargetCurrentWarRow(tx, guildId, clanTagBare);

        if (!currentWar) {
          resolution = buildBlocked("missing_current_row");
          return;
        }

        if (input.policy === "preserve_persisted") {
          const currentWarId = normalizeWarId(currentWar.warId ?? null);
          if (currentWarId === null) {
            resolution = buildBlocked("missing_preserved_id");
            return;
          }
          const persistedIdentity = buildPersistedIdentity(currentWar);
          if (!persistedIdentity) {
            resolution = buildBlocked("missing_preserved_id");
            return;
          }
          resolution = buildResolved({
            source: "preserved_during_outage_recovery",
            identity: persistedIdentity,
            warId: currentWarId,
            identityPersisted: true,
            liveValidated: false,
          });
          return;
        }

        const candidate = buildCanonicalIdentity(input.candidateIdentity ?? {});
        if (!candidate) {
          resolution = buildBlocked(
            normalizeState(input.candidateIdentity?.state ?? null) === "notInWar"
              ? "not_in_war"
              : "partial_live_identity",
          );
          return;
        }

        const lockKey = buildPhysicalIdentityKey({
          clanTag: clanTagBare,
          identity: candidate.physical,
        });
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
        `);

        const exactGlobalRows = await this.findExactGlobalIdentityRows(tx, {
          clanTag: clanTagBare,
          physical: candidate.physical,
        });
        const globalWarId = this.summarizeGlobalWarId(exactGlobalRows);
        if (globalWarId.conflict) {
          resolution = buildBlocked("conflicting_global_identity_ids");
          return;
        }

        const currentWarId = normalizeWarId(currentWar.warId ?? null);
        const currentExactPhysicalMatch = samePhysicalIdentity(currentWar, candidate.physical);
        const matchingGlobalWarId = globalWarId.warId;

        const identityPersisted = true;
        const identitySource: ActiveWarIdentityResolvedSource =
          currentExactPhysicalMatch && currentWarId !== null
            ? "existing_exact_row"
            : matchingGlobalWarId !== null
              ? "reused_global_exact_identity"
              : currentExactPhysicalMatch
                ? "materialized_missing_id"
                : "allocated_new_identity";

        if (input.policy === "interactive_materialize") {
          if (!currentExactPhysicalMatch) {
            resolution = buildBlocked("persisted_identity_mismatch");
            return;
          }

          const selectedWarId =
            currentWarId ?? matchingGlobalWarId ?? (await this.allocateNextWarId(tx));
          if (selectedWarId === null) {
            resolution = buildBlocked("persistence_failure");
            return;
          }

          if (currentWarId === null) {
            await tx.currentWar.update({
              where: {
                clanTag_guildId: {
                  guildId,
                  clanTag: `#${clanTagBare}`,
                },
              },
              data: {
                warId: selectedWarId,
              },
            });
          }

          resolution = buildResolved({
            source:
              currentWarId === null
                ? matchingGlobalWarId !== null
                  ? "reused_global_exact_identity"
                  : "materialized_missing_id"
                : "existing_exact_row",
            identity: buildResolvedIdentity(currentWar, candidate.physical, candidate.metadata),
            warId: currentWarId ?? selectedWarId,
            identityPersisted,
            liveValidated: true,
          });
          return;
        }

        const selectedWarId =
          (currentExactPhysicalMatch && currentWarId !== null
            ? currentWarId
            : matchingGlobalWarId) ?? (await this.allocateNextWarId(tx));
        if (selectedWarId === null) {
          resolution = buildBlocked("persistence_failure");
          return;
        }

        const updateData: Prisma.CurrentWarUncheckedUpdateInput = {
          warId: selectedWarId,
          state: candidate.physical.state,
          startTime: candidate.physical.warStartTime,
          opponentTag: `#${candidate.physical.opponentTag}`,
        };
        if (currentExactPhysicalMatch) {
          if (candidate.metadata.preparationStartTime) {
            updateData.prepStartTime = candidate.metadata.preparationStartTime;
          }
          if (candidate.metadata.warEndTime) {
            updateData.endTime = candidate.metadata.warEndTime;
          }
          if (candidate.metadata.opponentName !== null) {
            updateData.opponentName = candidate.metadata.opponentName;
          }
          if (candidate.metadata.clanName !== null) {
            updateData.clanName = candidate.metadata.clanName;
          }
        } else {
          updateData.prepStartTime = candidate.metadata.preparationStartTime ?? null;
          updateData.endTime = candidate.metadata.warEndTime ?? null;
          updateData.opponentName = candidate.metadata.opponentName;
          updateData.clanName = candidate.metadata.clanName;
        }

        const updated = await tx.currentWar.update({
          where: {
            clanTag_guildId: {
              guildId,
              clanTag: `#${clanTagBare}`,
            },
          },
          data: updateData,
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
          source: currentExactPhysicalMatch && currentWarId !== null ? "existing_exact_row" : identitySource,
          identity: buildResolvedIdentity(updated, candidate.physical, candidate.metadata),
          warId: normalizeWarId(updated.warId ?? null) ?? selectedWarId,
          identityPersisted,
          liveValidated: true,
        });
      });

      return resolution ?? buildBlocked("persistence_failure");
    } catch (error) {
      void error;
      return buildBlocked("persistence_failure");
    }
  }

  private async lockTargetCurrentWarRow(
    tx: Prisma.TransactionClient,
    guildId: string,
    clanTagBare: string,
  ): Promise<ActiveWarIdentityCurrentWarRow | null> {
    const rows = await tx.$queryRaw<Array<ActiveWarIdentityCurrentWarRow>>(
      Prisma.sql`
        SELECT
          cw."warId",
          cw."state",
          cw."prepStartTime",
          cw."startTime",
          cw."endTime",
          cw."opponentTag",
          cw."opponentName",
          cw."clanName"
        FROM "CurrentWar" cw
        WHERE cw."guildId" = ${guildId}
          AND cw."clanTag" = ${`#${clanTagBare}`}
        FOR UPDATE
      `,
    );
    return rows[0] ?? null;
  }

  private async findExactGlobalIdentityRows(
    tx: Prisma.TransactionClient,
    input: {
      clanTag: string;
      physical: PhysicalActiveWarIdentity;
    },
  ): Promise<Array<{ warId: number | null }>> {
    return tx.$queryRaw<Array<{ warId: number | null }>>(
      Prisma.sql`
        SELECT cw."warId"
        FROM "CurrentWar" cw
        WHERE cw."clanTag" = ${`#${input.clanTag}`}
          AND cw."startTime" = ${input.physical.warStartTime}
          AND cw."opponentTag" = ${`#${input.physical.opponentTag}`}
          AND cw."warId" IS NOT NULL
      `,
    );
  }

  private summarizeGlobalWarId(
    rows: Array<{ warId: number | null }>,
  ): { warId: number | null; conflict: boolean } {
    const ids = new Set<number>();
    for (const row of rows) {
      const warId = normalizeWarId(row.warId ?? null);
      if (warId !== null) {
        ids.add(warId);
      }
    }
    if (ids.size > 1) {
      return { warId: null, conflict: true };
    }
    return {
      warId: ids.values().next().value ?? null,
      conflict: false,
    };
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
