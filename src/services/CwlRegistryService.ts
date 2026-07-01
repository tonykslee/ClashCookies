import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { formatError } from "../helper/formatError";
import { normalizeClanTag } from "./PlayerLinkService";
import { CoCService } from "./CoCService";
import { cwlEventResolutionService } from "./CwlEventResolutionService";

export type TrackedClanRegistryType = "FWA" | "CWL" | "RAIDS";

export type ParsedCwlTagInput = {
  validTags: string[];
  invalidTags: string[];
  duplicateTagsInRequest: string[];
};

export type AddCwlClanTagsResult = {
  season: string;
  added: string[];
  alreadyExisting: string[];
  invalid: string[];
  duplicateInRequest: string[];
};

export type RemoveTrackedClanResult =
  | {
      outcome: "removed";
      tag: string;
      removedFrom: TrackedClanRegistryType;
      season: string;
      removedCount: number;
    }
  | {
      outcome: "not_found";
      tag: string;
      season: string;
    }
  | {
      outcome: "ambiguous";
      tag: string;
      season: string;
    };

const CWL_TAG_DB_STAGE_TIMEOUT_MS = 5_000;
const CWL_TAG_HYDRATION_LOOKUP_TIMEOUT_MS = 5_000;

type CwlTagStageDetailValue = string | number | boolean | null | undefined;
type CwlTagStageDetails = Record<string, CwlTagStageDetailValue>;

function formatCwlTagStageDetails(details?: CwlTagStageDetails): string {
  if (!details) return "";
  const parts = Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .filter((value) => !value.endsWith("=undefined"));
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function normalizeUniqueCwlClanTags(input: string[]): string[] {
  return [...new Set(input.map((tag) => normalizeClanTag(String(tag ?? ""))).filter(Boolean))];
}

export type CwlRegistryRolloverResult = {
  targetSeason: string;
  sourceSeason: string | null;
  copiedCount: number;
  skippedReason: string | null;
  durationMs: number;
};

function logCwlRegistryRollover(input: {
  targetSeason: string;
  sourceSeason: string | null;
  copiedCount: number;
  skippedReason: string | null;
  durationMs: number;
  error?: unknown;
}): void {
  const parts = [
    `[tracked-clan] event=cwl_registry_rollover`,
    `target_season=${input.targetSeason}`,
    `source_season=${input.sourceSeason ?? "none"}`,
    `copied_count=${input.copiedCount}`,
    `duration_ms=${input.durationMs}`,
  ];
  if (input.skippedReason) {
    parts.push(`skipped_reason=${input.skippedReason}`);
  }
  if (input.error) {
    parts.push(`error=${formatError(input.error)}`);
  }
  console.info(parts.join(" "));
}

/** Purpose: roll the latest populated CWL registry season forward into an empty target season. */
export async function rolloverCwlTrackedClanRegistryForSeason(input?: {
  season?: string;
  nowMs?: number;
}): Promise<CwlRegistryRolloverResult> {
  const startedAtMs = Date.now();
  const targetSeason = input?.season ?? resolveCurrentCwlSeasonKey(input?.nowMs);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingTargetRow = await tx.cwlTrackedClan.findFirst({
        where: { season: targetSeason },
        select: { id: true },
      });
      if (existingTargetRow) {
        return {
          targetSeason,
          sourceSeason: null,
          copiedCount: 0,
          skippedReason: "target_season_already_populated",
        };
      }

      const sourceSeasonRow = await tx.cwlTrackedClan.findFirst({
        where: {
          season: {
            lt: targetSeason,
          },
        },
        orderBy: [
          { season: "desc" },
          { createdAt: "desc" },
          { tag: "asc" },
        ],
        select: { season: true },
      });
      const sourceSeason = sourceSeasonRow?.season ?? null;
      if (!sourceSeason) {
        return {
          targetSeason,
          sourceSeason: null,
          copiedCount: 0,
          skippedReason: "no_prior_non_empty_season",
        };
      }

      const sourceRows = await tx.cwlTrackedClan.findMany({
        where: { season: sourceSeason },
        orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
        select: {
          tag: true,
          name: true,
          leagueLabel: true,
        },
      });
      if (sourceRows.length <= 0) {
        return {
          targetSeason,
          sourceSeason,
          copiedCount: 0,
          skippedReason: "source_season_empty",
        };
      }

      const copied = await tx.cwlTrackedClan.createMany({
        data: sourceRows.map((row) => ({
          season: targetSeason,
          tag: normalizeClanTag(row.tag) || row.tag,
          name: row.name,
          leagueLabel: row.leagueLabel,
        })),
        skipDuplicates: true,
      });

      return {
        targetSeason,
        sourceSeason,
        copiedCount: copied.count,
        skippedReason: copied.count > 0 ? null : "no_new_rows_copied",
      };
    });

    const completed: CwlRegistryRolloverResult = {
      ...result,
      durationMs: Date.now() - startedAtMs,
    };
    logCwlRegistryRollover(completed);
    return completed;
  } catch (error) {
    const failure: CwlRegistryRolloverResult = {
      targetSeason,
      sourceSeason: null,
      copiedCount: 0,
      skippedReason: "failed",
      durationMs: Date.now() - startedAtMs,
    };
    logCwlRegistryRollover({
      ...failure,
      error,
    });
    throw error;
  }
}

type CwlTrackedClanRegistryCreationResult = {
  existingTags: string[];
  missingTags: string[];
  ensuredCount: number;
  deactivatedPlanCount: number;
};

async function resolveCurrentCwlPlanScopesForClanTags(input: {
  season: string;
  clanTags: string[];
}): Promise<Array<{ clanTag: string; eventInstanceId: string }>> {
  const currentEventsByClanTag = await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags({
    clanTags: input.clanTags,
  });
  return input.clanTags
    .map((clanTag) => {
      const currentEvent = currentEventsByClanTag.get(clanTag);
      if (!currentEvent || currentEvent.season !== input.season) return null;
      return { clanTag, eventInstanceId: currentEvent.id };
    })
    .filter((entry): entry is { clanTag: string; eventInstanceId: string } => Boolean(entry));
}

async function createMissingCwlTrackedClansAndDeactivateStalePlans(input: {
  season: string;
  clanTags: string[];
}): Promise<CwlTrackedClanRegistryCreationResult> {
  const clanTags = normalizeUniqueCwlClanTags(input.clanTags);
  if (clanTags.length <= 0) {
    return {
      existingTags: [],
      missingTags: [],
      ensuredCount: 0,
      deactivatedPlanCount: 0,
    };
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existingRows = await tx.cwlTrackedClan.findMany({
      where: {
        season: input.season,
        tag: { in: clanTags },
      },
      select: { tag: true },
    });
    const existingSet = new Set(existingRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean));
    const existingTags = clanTags.filter((tag) => existingSet.has(tag));
    const missingTags = clanTags.filter((tag) => !existingSet.has(tag));
    if (missingTags.length <= 0) {
      return {
        existingTags,
        missingTags,
        ensuredCount: 0,
        deactivatedPlanCount: 0,
      };
    }

    const currentPlanScopes = await resolveCurrentCwlPlanScopesForClanTags({
      season: input.season,
      clanTags: missingTags,
    });
    const deactivatedPlans = currentPlanScopes.length > 0
      ? await tx.cwlRotationPlan.updateMany({
          where: {
            season: input.season,
            isActive: true,
            OR: currentPlanScopes,
          },
          data: {
            isActive: false,
          },
        })
      : { count: 0 };

    const ensured = await tx.cwlTrackedClan.createMany({
      data: missingTags.map((tag) => ({
        season: input.season,
        tag,
        name: null,
        leagueLabel: null,
      })),
      skipDuplicates: true,
    });

    return {
      existingTags,
      missingTags,
      ensuredCount: ensured.count,
      deactivatedPlanCount: deactivatedPlans.count,
    };
  });
}

async function runBoundedCwlTagStage<T>(input: {
  stage: string;
  timeoutMs: number;
  details?: CwlTagStageDetails;
  action: () => Promise<T>;
}): Promise<T> {
  const startedAtMs = Date.now();
  const detailText = formatCwlTagStageDetails(input.details);
  console.info(
    `[tracked-clan] stage=${input.stage} status=started timeout_ms=${input.timeoutMs}${detailText}`,
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`tracked-clan stage timed out: ${input.stage} after ${input.timeoutMs}ms`));
      }, input.timeoutMs);
    });
    const result = (await Promise.race([input.action(), timeoutPromise])) as T;
    console.info(
      `[tracked-clan] stage=${input.stage} status=completed duration_ms=${
        Date.now() - startedAtMs
      }${detailText}`,
    );
    return result;
  } catch (err) {
    const timedOut = String((err as Error)?.message ?? "").includes("timed out");
    console.error(
      `[tracked-clan] stage=${input.stage} status=${timedOut ? "timeout" : "failed"} duration_ms=${
        Date.now() - startedAtMs
      } timeout_ms=${input.timeoutMs}${detailText}${timedOut ? "" : ` error=${formatError(err)}`}`,
    );
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Purpose: resolve current CWL month key in stable UTC `YYYY-MM` format. */
export function resolveCurrentCwlSeasonKey(nowMs?: number): string {
  const now = Number.isFinite(nowMs) ? new Date(Number(nowMs)) : new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Purpose: parse one free-form CWL tags input string into normalized valid/invalid/duplicate buckets. */
export function parseCwlClanTagsInput(rawInput: string): ParsedCwlTagInput {
  const trimmed = String(rawInput ?? "").trim();
  if (!trimmed) {
    return {
      validTags: [],
      invalidTags: [],
      duplicateTagsInRequest: [],
    };
  }

  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  const parts = withoutBrackets
    .split(/[\s,;]+/g)
    .map((part) => part.trim().replace(/^['"`]+|['"`]+$/g, ""))
    .filter(Boolean);

  const seen = new Set<string>();
  const validTags: string[] = [];
  const invalidTags: string[] = [];
  const duplicateTagsInRequest: string[] = [];
  for (const part of parts) {
    const normalized = normalizeClanTag(part);
    if (!normalized) {
      invalidTags.push(part);
      continue;
    }
    if (seen.has(normalized)) {
      duplicateTagsInRequest.push(normalized);
      continue;
    }
    seen.add(normalized);
    validTags.push(normalized);
  }

  return {
    validTags,
    invalidTags,
    duplicateTagsInRequest: [...new Set(duplicateTagsInRequest)],
  };
}

/** Purpose: add one CWL clan-tag batch for a target season with partial-success semantics. */
export async function addCwlClanTagsForSeason(input: {
  rawTags: string;
  season?: string;
}): Promise<AddCwlClanTagsResult> {
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  const parsed = parseCwlClanTagsInput(input.rawTags);
  console.info(
    `[tracked-clan] stage=cwl_tags_parsed season=${season} raw_count=${String(input.rawTags ?? "").split(/[\s,;]+/g).filter(Boolean).length} valid_count=${parsed.validTags.length} invalid_count=${parsed.invalidTags.length} duplicate_count=${parsed.duplicateTagsInRequest.length}`,
  );
  if (parsed.validTags.length <= 0) {
    return {
      season,
      added: [],
      alreadyExisting: [],
      invalid: parsed.invalidTags,
      duplicateInRequest: parsed.duplicateTagsInRequest,
    };
  }

  const batchResult = await runBoundedCwlTagStage({
    stage: "cwl_tags_registry_reconcile",
    timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
    details: { season, valid_count: parsed.validTags.length },
    action: () => createMissingCwlTrackedClansAndDeactivateStalePlans({ season, clanTags: parsed.validTags }),
  });
  console.info(
    `[tracked-clan] stage=cwl_tags_existing_rows_loaded season=${season} existing_count=${batchResult.existingTags.length} to_create_count=${batchResult.missingTags.length} deactivated_plan_count=${batchResult.deactivatedPlanCount}`,
  );

  return {
    season,
    added: batchResult.missingTags,
    alreadyExisting: batchResult.existingTags,
    invalid: parsed.invalidTags,
    duplicateInRequest: parsed.duplicateTagsInRequest,
  };
}

/** Purpose: ensure tracked CWL clan rows exist and hydrate clan metadata from live CoC in one bounded step. */
export async function ensureAndHydrateCwlTrackedClanMetadataForSeason(input: {
  clanTags: string[];
  season?: string;
  cocService: CoCService;
  ensureRows?: boolean;
}): Promise<{
  season: string;
  requestedCount: number;
  ensuredCount: number;
  hydratedCount: number;
  skippedCount: number;
}> {
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  const clanTags = normalizeUniqueCwlClanTags(input.clanTags);
  if (clanTags.length <= 0) {
    return {
      season,
      requestedCount: 0,
      ensuredCount: 0,
      hydratedCount: 0,
      skippedCount: 0,
    };
  }

  const ensured = input.ensureRows === false
    ? { ensuredCount: 0 }
    : await runBoundedCwlTagStage({
        stage: "cwl_tags_ensure_rows",
        timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
        details: { season, requested_count: clanTags.length },
        action: () => createMissingCwlTrackedClansAndDeactivateStalePlans({ season, clanTags }),
      });

  const missingRows = await runBoundedCwlTagStage({
    stage: "cwl_tags_missing_metadata_rows_query",
    timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
    details: { season, requested_count: clanTags.length },
    action: () =>
      prisma.cwlTrackedClan.findMany({
        where: {
          season,
          tag: { in: clanTags },
          OR: [
            { name: null },
            { name: "" },
            { leagueLabel: null },
            { leagueLabel: "" },
          ],
        },
        select: { tag: true },
      }),
  });

  if (missingRows.length <= 0) {
    console.info(
      `[tracked-clan] stage=cwl_tags_metadata_hydration_completed season=${season} requested_count=${clanTags.length} ensured_count=${ensured.ensuredCount} hydrated_count=0 skipped_count=0`,
    );
    return {
      season,
      requestedCount: clanTags.length,
      ensuredCount: ensured.ensuredCount,
      hydratedCount: 0,
      skippedCount: 0,
    };
  }

  let hydratedCount = 0;
  let skippedCount = 0;
  await Promise.allSettled(
    missingRows.map(async (row) => {
      const tag = normalizeClanTag(row.tag) || row.tag;
      try {
        const clan = await runBoundedCwlTagStage({
          stage: "cwl_tags_name_lookup",
          timeoutMs: CWL_TAG_HYDRATION_LOOKUP_TIMEOUT_MS,
          details: { season, tag },
          action: () => input.cocService.getClan(tag),
        });
        const clanName = String(clan?.name ?? "").trim();
        const leagueLabel = String(clan?.warLeague?.name ?? "").trim();
        if (!clanName && !leagueLabel) {
          skippedCount += 1;
          console.info(
            `[tracked-clan] stage=cwl_tags_metadata_hydration_skipped season=${season} tag=${tag} reason=empty_name_and_league`,
          );
          return;
        }
        const updated = await runBoundedCwlTagStage({
          stage: "cwl_tags_name_update",
          timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
          details: { season, tag },
          action: () =>
            prisma.cwlTrackedClan.updateMany({
              where: {
                season,
                tag,
                OR: [
                  { name: null },
                  { name: "" },
                  { leagueLabel: null },
                  { leagueLabel: "" },
                ],
              },
              data: {
                ...(clanName ? { name: clanName } : {}),
                ...(leagueLabel ? { leagueLabel } : {}),
              },
            }),
        });
        if (updated.count > 0) {
          hydratedCount += updated.count;
        } else {
          skippedCount += 1;
        }
      } catch (err) {
        skippedCount += 1;
        console.error(
          `[tracked-clan] stage=cwl_tags_metadata_hydration_failed season=${season} tag=${tag} error=${formatError(err)}`,
        );
      }
    }),
  );

  console.info(
    `[tracked-clan] stage=cwl_tags_metadata_hydration_completed season=${season} requested_count=${clanTags.length} ensured_count=${ensured.ensuredCount} hydrated_count=${hydratedCount} skipped_count=${skippedCount}`,
  );

  return {
    season,
    requestedCount: clanTags.length,
    ensuredCount: ensured.ensuredCount,
    hydratedCount,
    skippedCount,
  };
}

/** Purpose: force-refresh tracked CWL clan metadata from live CoC even when rows already have values. */
export async function refreshCwlTrackedClanMetadataForSeason(input: {
  clanTags: string[];
  season?: string;
  cocService: CoCService;
  ensureRows?: boolean;
}): Promise<{
  season: string;
  requestedCount: number;
  ensuredCount: number;
  hydratedCount: number;
  skippedCount: number;
}> {
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  const clanTags = normalizeUniqueCwlClanTags(input.clanTags);
  if (clanTags.length <= 0) {
    return {
      season,
      requestedCount: 0,
      ensuredCount: 0,
      hydratedCount: 0,
      skippedCount: 0,
    };
  }

  const ensured = input.ensureRows === false
    ? { ensuredCount: 0 }
    : await runBoundedCwlTagStage({
        stage: "cwl_tags_force_metadata_ensure_rows",
        timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
        details: { season, requested_count: clanTags.length },
        action: () => createMissingCwlTrackedClansAndDeactivateStalePlans({ season, clanTags }),
      });

  let hydratedCount = 0;
  let skippedCount = 0;
  await Promise.allSettled(
    clanTags.map(async (tag) => {
      try {
        const clan = await runBoundedCwlTagStage({
          stage: "cwl_tags_force_metadata_lookup",
          timeoutMs: CWL_TAG_HYDRATION_LOOKUP_TIMEOUT_MS,
          details: { season, tag },
          action: () => input.cocService.getClan(tag),
        });
        const clanName = String(clan?.name ?? "").trim();
        const leagueLabel = String(clan?.warLeague?.name ?? "").trim();
        if (!clanName && !leagueLabel) {
          skippedCount += 1;
          console.info(
            `[tracked-clan] stage=cwl_tags_force_metadata_skipped season=${season} tag=${tag} reason=empty_name_and_league`,
          );
          return;
        }
        const updateResult = await runBoundedCwlTagStage({
          stage: "cwl_tags_force_metadata_update",
          timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
          details: { season, tag },
          action: () =>
            prisma.cwlTrackedClan.updateMany({
              where: {
                season,
                tag,
              },
              data: {
                ...(clanName ? { name: clanName } : {}),
                ...(leagueLabel ? { leagueLabel } : {}),
              },
            }),
        });
        if (updateResult.count > 0) {
          hydratedCount += updateResult.count;
        } else {
          skippedCount += 1;
        }
      } catch (err) {
        skippedCount += 1;
        console.error(
          `[tracked-clan] stage=cwl_tags_force_metadata_failed season=${season} tag=${tag} error=${formatError(err)}`,
        );
      }
    }),
  );

  console.info(
    `[tracked-clan] stage=cwl_tags_force_metadata_completed season=${season} requested_count=${clanTags.length} ensured_count=${ensured.ensuredCount} hydrated_count=${hydratedCount} skipped_count=${skippedCount}`,
  );

  return {
    season,
    requestedCount: clanTags.length,
    ensuredCount: ensured.ensuredCount,
    hydratedCount,
    skippedCount,
  };
}

/** Purpose: hydrate missing CWL clan names as best-effort enrichment after rows exist. */
export async function hydrateMissingCwlClanNamesForSeason(input: {
  rawTags: string;
  season?: string;
  cocService: CoCService;
}): Promise<void> {
  const parsed = parseCwlClanTagsInput(input.rawTags);
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  console.info(
    `[tracked-clan] stage=cwl_tags_name_hydration_started season=${season} valid_count=${parsed.validTags.length}`,
  );
  if (parsed.validTags.length <= 0) {
    console.info(
      `[tracked-clan] stage=cwl_tags_name_hydration_completed season=${season} hydrated_count=0 skipped_count=0`,
    );
    return;
  }

  const result = await ensureAndHydrateCwlTrackedClanMetadataForSeason({
    season,
    clanTags: parsed.validTags,
    cocService: input.cocService,
  });
  console.info(
    `[tracked-clan] stage=cwl_tags_name_hydration_completed season=${result.season} hydrated_count=${result.hydratedCount} skipped_count=${result.skippedCount}`,
  );
}

/** Purpose: list one season-scoped CWL tracked-clan registry in deterministic order. */
export async function listCwlTrackedClansForSeason(input?: {
  season?: string;
}): Promise<Array<{ season: string; tag: string; name: string | null; createdAt: Date }>> {
  const season = input?.season ?? resolveCurrentCwlSeasonKey();
  const rows = await prisma.cwlTrackedClan.findMany({
    where: { season },
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    select: {
      season: true,
      tag: true,
      name: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    season: row.season,
    tag: normalizeClanTag(row.tag) || row.tag,
    name: row.name,
    createdAt: row.createdAt,
  }));
}

/** Purpose: remove one tag from FWA/CWL registries with deterministic ambiguity handling. */
export async function removeTrackedClanTagFromRegistries(input: {
  tag: string;
  type?: TrackedClanRegistryType | null;
  season?: string;
}): Promise<RemoveTrackedClanResult> {
  const normalizedTag = normalizeClanTag(input.tag);
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  if (!normalizedTag) {
    return {
      outcome: "not_found",
      tag: "",
      season,
    };
  }

  if (input.type === "FWA") {
    const deleted = await prisma.trackedClan.deleteMany({
      where: { tag: normalizedTag },
    });
    if (deleted.count <= 0) {
      return { outcome: "not_found", tag: normalizedTag, season };
    }
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "FWA",
      season,
      removedCount: deleted.count,
    };
  }

  if (input.type === "CWL") {
    const currentPlanScopes = await resolveCurrentCwlPlanScopesForClanTags({
      season,
      clanTags: [normalizedTag],
    });
    const result = await prisma.$transaction(async (tx) => {
      const existingClan = await tx.cwlTrackedClan.findFirst({
        where: { season, tag: normalizedTag },
        select: { id: true },
      });
      if (!existingClan) {
        return null;
      }
      const deletedClans = await tx.cwlTrackedClan.deleteMany({
        where: { season, tag: normalizedTag },
      });
      const deletedMappings = await tx.cwlPlayerClanSeason.deleteMany({
        where: { season, cwlClanTag: normalizedTag },
      });
      if (currentPlanScopes.length > 0) {
        await tx.cwlRotationPlan.updateMany({
          where: {
            season,
            isActive: true,
            OR: currentPlanScopes,
          },
          data: {
            isActive: false,
          },
        });
      }
      return { deletedClans, deletedMappings };
    });
    if (!result) {
      return { outcome: "not_found", tag: normalizedTag, season };
    }
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "CWL",
      season,
      removedCount: result.deletedClans.count + result.deletedMappings.count,
    };
  }

  if (input.type === "RAIDS") {
    const deleted = await prisma.raidTrackedClan.deleteMany({
      where: { clanTag: stripRaidClanTag(normalizedTag) },
    });
    if (deleted.count <= 0) {
      return { outcome: "not_found", tag: normalizedTag, season };
    }
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "RAIDS",
      season,
      removedCount: deleted.count,
    };
  }

  const [fwaRow, cwlRow, raidRow] = await Promise.all([
    prisma.trackedClan.findUnique({
      where: { tag: normalizedTag },
      select: { tag: true },
    }),
    prisma.cwlTrackedClan.findFirst({
      where: { season, tag: normalizedTag },
      select: { id: true },
    }),
    prisma.raidTrackedClan.findFirst({
      where: { clanTag: stripRaidClanTag(normalizedTag) },
      select: { id: true },
    }),
  ]);

  if ((fwaRow ? 1 : 0) + (cwlRow ? 1 : 0) + (raidRow ? 1 : 0) > 1) {
    return {
      outcome: "ambiguous",
      tag: normalizedTag,
      season,
    };
  }

  if (fwaRow) {
    const deleted = await prisma.trackedClan.deleteMany({
      where: { tag: normalizedTag },
    });
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "FWA",
      season,
      removedCount: deleted.count,
    };
  }

  if (cwlRow) {
    const currentPlanScopes = await resolveCurrentCwlPlanScopesForClanTags({
      season,
      clanTags: [normalizedTag],
    });
    const [deletedClans, deletedMappings] = await prisma.$transaction([
      prisma.cwlTrackedClan.deleteMany({
        where: { season, tag: normalizedTag },
      }),
      prisma.cwlPlayerClanSeason.deleteMany({
        where: { season, cwlClanTag: normalizedTag },
      }),
      ...(currentPlanScopes.length > 0
        ? [
            prisma.cwlRotationPlan.updateMany({
              where: {
                season,
                isActive: true,
                OR: currentPlanScopes,
              },
              data: {
                isActive: false,
              },
            }),
          ]
        : []),
    ]);
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "CWL",
      season,
      removedCount: deletedClans.count + deletedMappings.count,
    };
  }

  if (raidRow) {
    const deleted = await prisma.raidTrackedClan.deleteMany({
      where: { clanTag: stripRaidClanTag(normalizedTag) },
    });
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "RAIDS",
      season,
      removedCount: deleted.count,
    };
  }

  return {
    outcome: "not_found",
    tag: normalizedTag,
    season,
  };
}

/** Purpose: normalize a raid tracked clan tag into stored uppercase no-hash form. */
function stripRaidClanTag(input: string): string {
  return input.startsWith("#") ? input.slice(1) : input;
}
