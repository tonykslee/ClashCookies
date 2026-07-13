import { Prisma } from "@prisma/client";
import { dozzleLog } from "../helper/dozzleLogger";
import {
  resolveSteadyStateLogLevel,
  SteadyStateLogGate,
} from "../helper/steadyStateLogGate";
import { prisma } from "../prisma";
import { getTelemetryContext } from "./telemetry/context";
import { TelemetryIngestService } from "./telemetry/ingest";
import { parseCocApiTime } from "../utils/cocTime";

export type ActiveWarIdentityState = "preparation" | "inWar" | "notInWar";

export type ActiveWarIdentityPolicy =
  | "poll_reconcile"
  | "interactive_materialize"
  | "preserve_persisted";

export type ActiveWarIdentityBlockedReason =
  | "not_in_war"
  | "partial_live_identity"
  | "missing_current_row"
  | "persisted_identity_mismatch"
  | "missing_preserved_id"
  | "conflicting_global_identity_ids"
  | "persistence_failure";

export type ActiveWarIdentityResolvedSource =
  | "existing_exact_row"
  | "reused_global_exact_identity"
  | "materialized_missing_id"
  | "allocated_new_identity"
  | "preserved_during_outage_recovery";

export type ActiveWarIdentityObservabilityContext = {
  caller:
    | "fwa_mail_render"
    | "war_event_poll"
    | "notify_refresh"
    | "battle_day_refresh";
  runId?: string | null;
  interactionId?: string | null;
  pollCycleId?: string | null;
};

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

export type ActiveWarIdentityResult =
  | {
      status: "resolved";
      warId: number;
      source: ActiveWarIdentityResolvedSource;
      identity: CanonicalActiveWarIdentity;
      identityPersisted: boolean;
      liveValidated: boolean;
    }
  | {
      status: "blocked";
      warId: null;
      reason: ActiveWarIdentityBlockedReason;
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

function toIsoString(input: Date | null | undefined): string | null {
  return input instanceof Date && Number.isFinite(input.getTime())
    ? input.toISOString()
    : null;
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

type ActiveWarIdentityCandidateSummary = {
  state: string | null;
  warStartTime: string | null;
  opponentTag: string | null;
};

type ActiveWarIdentityPersistedSummary = {
  warId: number | null;
  state: string | null;
  warStartTime: string | null;
  opponentTag: string | null;
};

type ActiveWarIdentityResolutionOutcome = {
  result: ActiveWarIdentityResult;
  candidate: ActiveWarIdentityCandidateSummary;
  persisted: ActiveWarIdentityPersistedSummary;
  postPersisted: ActiveWarIdentityPersistedSummary | null;
  allocationOccurred: boolean;
  identityPersisted: boolean;
  identityPreserved: boolean;
  liveValidated: boolean;
};

function summarizeCandidateIdentity(
  input: ActiveWarIdentityCandidate | null | undefined,
): ActiveWarIdentityCandidateSummary {
  return {
    state: String(input?.state ?? "").trim() || null,
    warStartTime: toIsoString(normalizeDate(input?.warStartTime ?? null)),
    opponentTag: normalizeTag(input?.opponentTag ?? null),
  };
}

function summarizePersistedIdentity(
  row: ActiveWarIdentityCurrentWarRow | null | undefined,
): ActiveWarIdentityPersistedSummary {
  return {
    warId: normalizeWarId(row?.warId ?? null),
    state: String(row?.state ?? "").trim() || null,
    warStartTime: toIsoString(row?.startTime ?? null),
    opponentTag: normalizeTag(row?.opponentTag ?? null),
  };
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

function buildTelemetryLabels(input: {
  caller: ActiveWarIdentityObservabilityContext["caller"];
  telemetryContext: ReturnType<typeof getTelemetryContext>;
}): { commandName: string; subcommand: string } {
  if (input.telemetryContext?.commandName && input.telemetryContext?.subcommand) {
    return {
      commandName: input.telemetryContext.commandName,
      subcommand: input.telemetryContext.subcommand,
    };
  }
  switch (input.caller) {
    case "war_event_poll":
      return { commandName: "war-events", subcommand: "poll" };
    case "notify_refresh":
      return { commandName: "notify", subcommand: "refresh" };
    case "battle_day_refresh":
      return { commandName: "war-events", subcommand: "battle-day-refresh" };
    case "fwa_mail_render":
    default:
      return { commandName: "fwa", subcommand: "match" };
  }
}

function buildActiveWarIdentityResolutionLogLevel(input: {
  source: ActiveWarIdentityResolvedSource | null;
  identity: string;
  outcomeSignature: string;
  exactRowGate: SteadyStateLogGate;
}): "info" | "debug" | "warn" | "error" {
  if (input.source === "existing_exact_row") {
    return resolveSteadyStateLogLevel({
      gate: input.exactRowGate,
      identity: input.identity,
      signature: input.outcomeSignature,
    });
  }
  return input.source === "allocated_new_identity" ||
    input.source === "materialized_missing_id" ||
    input.source === "reused_global_exact_identity" ||
    input.source === "preserved_during_outage_recovery"
    ? "info"
    : "warn";
}

/** Purpose: own the canonical, concurrency-safe active-war identity resolution flow. */
export class ActiveWarIdentityService {
  private readonly telemetryIngest = TelemetryIngestService.getInstance();
  private readonly exactRowLogGate = new SteadyStateLogGate();

  constructor(private readonly db = prisma) {}

  private recordObservability(
    input: {
      policy: ActiveWarIdentityPolicy;
      guildId: string;
      clanTag: string;
      observabilityContext?: ActiveWarIdentityObservabilityContext | null;
    },
    outcome: ActiveWarIdentityResolutionOutcome,
    durationMs: number,
  ): void {
    const telemetryContext = getTelemetryContext();
    const caller = input.observabilityContext?.caller ?? "war_event_poll";
    const runId =
      input.observabilityContext?.runId ?? telemetryContext?.runId ?? null;
    const interactionId =
      input.observabilityContext?.interactionId ??
      telemetryContext?.interactionId ??
      null;
    const pollCycleId = input.observabilityContext?.pollCycleId ?? null;
    const labels = buildTelemetryLabels({
      caller,
      telemetryContext,
    });
    try {
      this.telemetryIngest.recordStageTiming({
        stage: "active_war_identity_resolution",
        status: outcome.result.status === "resolved" ? "success" : "failure",
        guildId: input.guildId,
        commandName: labels.commandName,
        subcommand: labels.subcommand,
        runId: runId ?? undefined,
        durationMs,
      });
    } catch (error) {
      void error;
    }

    const source =
      outcome.result.status === "resolved" ? outcome.result.source : null;
    const reasonCode =
      outcome.result.status === "blocked" ? outcome.result.reason : null;
    const signature = [
      outcome.result.status,
      source ?? "blocked",
      reasonCode ?? "resolved",
      outcome.persisted.warId ?? "none",
      outcome.persisted.state ?? "none",
      outcome.persisted.warStartTime ?? "none",
      outcome.persisted.opponentTag ?? "none",
      outcome.result.status === "resolved" ? outcome.result.warId : "none",
      outcome.candidate.state ?? "none",
      outcome.candidate.warStartTime ?? "none",
      outcome.candidate.opponentTag ?? "none",
      outcome.allocationOccurred ? "alloc" : "reuse",
      outcome.identityPersisted ? "persisted" : "transient",
      outcome.identityPreserved ? "preserved" : "fresh",
      outcome.liveValidated ? "live" : "persisted",
      outcome.postPersisted?.warId ?? "none",
      outcome.postPersisted?.state ?? "none",
      outcome.postPersisted?.warStartTime ?? "none",
      outcome.postPersisted?.opponentTag ?? "none",
    ].join("|");
    const logLevel =
      outcome.result.status === "resolved"
        ? buildActiveWarIdentityResolutionLogLevel({
            source,
            identity: [
              caller,
              input.guildId,
              input.clanTag,
              source,
            ].join("|"),
            outcomeSignature: signature,
            exactRowGate: this.exactRowLogGate,
          })
        : reasonCode === "conflicting_global_identity_ids" ||
            reasonCode === "persistence_failure"
          ? "error"
          : "warn";
    const payload = {
      kind: "active_war_identity_resolution",
      status: outcome.result.status,
      policy: input.policy,
      caller,
      guildId: input.guildId,
      clanTag: input.clanTag,
      candidateState: outcome.candidate.state,
      candidateWarStartTime: outcome.candidate.warStartTime,
      candidateOpponentTag: outcome.candidate.opponentTag,
      persistedWarId: outcome.persisted.warId,
      persistedState: outcome.persisted.state,
      persistedWarStartTime: outcome.persisted.warStartTime,
      persistedOpponentTag: outcome.persisted.opponentTag,
      postPersistedWarId: outcome.postPersisted?.warId ?? null,
      postPersistedState: outcome.postPersisted?.state ?? null,
      postPersistedWarStartTime: outcome.postPersisted?.warStartTime ?? null,
      postPersistedOpponentTag: outcome.postPersisted?.opponentTag ?? null,
      resolvedWarId: outcome.result.status === "resolved" ? outcome.result.warId : null,
      source,
      reasonCode,
      allocationOccurred: outcome.allocationOccurred,
      identityPersisted: outcome.identityPersisted,
      identityPreserved: outcome.identityPreserved,
      liveValidated: outcome.liveValidated,
      durationMs,
      runId,
      interactionId,
      pollCycleId,
    };
    try {
      dozzleLog[logLevel](`[active-war-identity] ${JSON.stringify(payload)}`);
    } catch (error) {
      void error;
    }
  }

  async resolveCurrentWarId(input: {
    policy: ActiveWarIdentityPolicy;
    guildId: string;
    clanTag: string;
    candidateIdentity?: ActiveWarIdentityCandidate | null;
    observabilityContext?: ActiveWarIdentityObservabilityContext | null;
  }): Promise<ActiveWarIdentityResult> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTagBare = normalizeTag(input.clanTag);
    const startedAtMs = Date.now();
    const candidateSummary = summarizeCandidateIdentity(input.candidateIdentity ?? null);
    let outcome: ActiveWarIdentityResolutionOutcome = {
      result: buildBlocked("persistence_failure"),
      candidate: candidateSummary,
      persisted: {
        warId: null,
        state: null,
        warStartTime: null,
        opponentTag: null,
      },
      postPersisted: null,
      allocationOccurred: false,
      identityPersisted: false,
      identityPreserved: false,
      liveValidated: false,
    };

    if (!guildId || !clanTagBare) {
      outcome = {
        ...outcome,
        result: buildBlocked("missing_current_row"),
      };
      this.recordObservability(input, outcome, Date.now() - startedAtMs);
      return outcome.result;
    }

    try {
      await this.db.$transaction(async (tx: Prisma.TransactionClient) => {
        const currentWar = await this.lockTargetCurrentWarRow(tx, guildId, clanTagBare);
        const persistedBeforeResolution = summarizePersistedIdentity(currentWar);
        outcome = {
          ...outcome,
          persisted: persistedBeforeResolution,
          postPersisted: null,
        };

        if (!currentWar) {
          outcome = {
            ...outcome,
            result: buildBlocked("missing_current_row"),
          };
          return;
        }

        if (input.policy === "preserve_persisted") {
          const currentWarId = normalizeWarId(currentWar.warId ?? null);
          if (currentWarId === null) {
            outcome = {
              ...outcome,
              result: buildBlocked("missing_preserved_id"),
            };
            return;
          }
          const persistedIdentity = buildPersistedIdentity(currentWar);
          if (!persistedIdentity) {
            outcome = {
              ...outcome,
              result: buildBlocked("missing_preserved_id"),
            };
            return;
          }
          outcome = {
            ...outcome,
            result: buildResolved({
              source: "preserved_during_outage_recovery",
              identity: persistedIdentity,
              warId: currentWarId,
              identityPersisted: true,
              liveValidated: false,
            }),
            persisted: persistedBeforeResolution,
            postPersisted: persistedBeforeResolution,
            allocationOccurred: false,
            identityPersisted: true,
            identityPreserved: true,
            liveValidated: false,
          };
          return;
        }

        const candidate = buildCanonicalIdentity(input.candidateIdentity ?? {});
        if (!candidate) {
          outcome = {
            ...outcome,
            result: buildBlocked(
              normalizeState(input.candidateIdentity?.state ?? null) === "notInWar"
                ? "not_in_war"
                : "partial_live_identity",
            ),
          };
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
          outcome = {
            ...outcome,
            result: buildBlocked("conflicting_global_identity_ids"),
          };
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
        const sequenceAllocationOccurred =
          matchingGlobalWarId === null &&
          (!(currentExactPhysicalMatch && currentWarId !== null) ||
            currentWarId === null);

        if (input.policy === "interactive_materialize") {
          if (!currentExactPhysicalMatch) {
            outcome = {
              ...outcome,
              result: buildBlocked("persisted_identity_mismatch"),
            };
            return;
          }

          const selectedWarId =
            currentWarId ?? matchingGlobalWarId ?? (await this.allocateNextWarId(tx));
          if (selectedWarId === null) {
            outcome = {
              ...outcome,
              result: buildBlocked("persistence_failure"),
            };
            return;
          }

          if (currentWarId === null) {
            const updatedMaterializedWar = await tx.currentWar.update({
              where: {
                clanTag_guildId: {
                  guildId,
                  clanTag: `#${clanTagBare}`,
                },
              },
              data: {
                warId: selectedWarId,
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
            outcome = {
              ...outcome,
              result: buildResolved({
                source: matchingGlobalWarId !== null
                  ? "reused_global_exact_identity"
                  : "materialized_missing_id",
                identity: buildResolvedIdentity(
                  updatedMaterializedWar,
                  candidate.physical,
                  candidate.metadata,
                ),
                warId: selectedWarId,
                identityPersisted,
                liveValidated: true,
              }),
              postPersisted: summarizePersistedIdentity(updatedMaterializedWar),
              allocationOccurred: matchingGlobalWarId === null,
              identityPersisted,
              identityPreserved: false,
              liveValidated: true,
            };
            return;
          }

          outcome = {
            ...outcome,
            result: buildResolved({
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
            }),
            postPersisted: summarizePersistedIdentity(currentWar),
            allocationOccurred:
              currentWarId === null && matchingGlobalWarId === null,
            identityPersisted,
            identityPreserved: false,
            liveValidated: true,
          };
          return;
        }

        const selectedWarId =
          (currentExactPhysicalMatch && currentWarId !== null
            ? currentWarId
            : matchingGlobalWarId) ?? (await this.allocateNextWarId(tx));
        if (selectedWarId === null) {
          outcome = {
            ...outcome,
            result: buildBlocked("persistence_failure"),
          };
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

        outcome = {
          ...outcome,
          result: buildResolved({
            source:
              currentExactPhysicalMatch && currentWarId !== null
                ? "existing_exact_row"
                : identitySource,
            identity: buildResolvedIdentity(updated, candidate.physical, candidate.metadata),
            warId: normalizeWarId(updated.warId ?? null) ?? selectedWarId,
            identityPersisted,
            liveValidated: true,
          }),
          persisted: persistedBeforeResolution,
          postPersisted: summarizePersistedIdentity(updated),
          allocationOccurred: sequenceAllocationOccurred,
          identityPersisted,
          identityPreserved: false,
          liveValidated: true,
        };
      });

      outcome = outcome ?? {
        result: buildBlocked("persistence_failure"),
        candidate: candidateSummary,
        persisted: {
          warId: null,
          state: null,
          warStartTime: null,
          opponentTag: null,
        },
        postPersisted: null,
        allocationOccurred: false,
        identityPersisted: false,
        identityPreserved: false,
        liveValidated: false,
      };
      this.recordObservability(input, outcome, Date.now() - startedAtMs);
      return outcome.result;
    } catch (error) {
      void error;
      outcome = {
        result: buildBlocked("persistence_failure"),
        candidate: candidateSummary,
        persisted: outcome.persisted,
        postPersisted: outcome.postPersisted,
        allocationOccurred: false,
        identityPersisted: false,
        identityPreserved: false,
        liveValidated: false,
      };
      this.recordObservability(input, outcome, Date.now() - startedAtMs);
      return outcome.result;
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
