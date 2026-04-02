import { prisma } from "../prisma";
import { formatError } from "../helper/formatError";
import { normalizeClanTag } from "./PlayerLinkService";
import { CoCService } from "./CoCService";

export type TrackedClanRegistryType = "FWA" | "CWL";

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

  const existing = await runBoundedCwlTagStage({
    stage: "cwl_tags_existing_rows_query",
    timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
    details: { season, valid_count: parsed.validTags.length },
    action: () =>
      prisma.cwlTrackedClan.findMany({
        where: {
          season,
          tag: { in: parsed.validTags },
        },
        select: { tag: true },
      }),
  });
  const existingSet = new Set(existing.map((row) => normalizeClanTag(row.tag)).filter(Boolean));
  const toCreate = parsed.validTags.filter((tag) => !existingSet.has(tag));
  console.info(
    `[tracked-clan] stage=cwl_tags_existing_rows_loaded season=${season} existing_count=${existing.length} to_create_count=${toCreate.length}`,
  );

  if (toCreate.length > 0) {
    await runBoundedCwlTagStage({
      stage: "cwl_tags_create_many",
      timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
      details: { season, to_create_count: toCreate.length },
      action: () =>
        prisma.cwlTrackedClan.createMany({
          data: toCreate.map((tag) => ({
            season,
            tag,
            name: null,
          })),
          skipDuplicates: true,
        }),
    });
  }

  const finalRows = await runBoundedCwlTagStage({
    stage: "cwl_tags_final_rows_query",
    timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
    details: { season, valid_count: parsed.validTags.length },
    action: () =>
      prisma.cwlTrackedClan.findMany({
        where: {
          season,
          tag: { in: parsed.validTags },
        },
        select: { tag: true },
      }),
  });
  const finalSet = new Set(finalRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean));

  const added: string[] = [];
  const alreadyExisting: string[] = [];
  for (const tag of parsed.validTags) {
    if (!finalSet.has(tag)) continue;
    if (existingSet.has(tag)) {
      alreadyExisting.push(tag);
      continue;
    }
    added.push(tag);
  }

  return {
    season,
    added,
    alreadyExisting,
    invalid: parsed.invalidTags,
    duplicateInRequest: parsed.duplicateTagsInRequest,
  };
}

/** Purpose: hydrate missing CWL clan names as best-effort enrichment after rows exist. */
export async function hydrateMissingCwlClanNamesForSeason(input: {
  rawTags: string;
  season?: string;
  cocService: CoCService;
}): Promise<void> {
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  const parsed = parseCwlClanTagsInput(input.rawTags);
  console.info(
    `[tracked-clan] stage=cwl_tags_name_hydration_started season=${season} valid_count=${parsed.validTags.length}`,
  );
  if (parsed.validTags.length <= 0) {
    console.info(
      `[tracked-clan] stage=cwl_tags_name_hydration_completed season=${season} hydrated_count=0 skipped_count=0`,
    );
    return;
  }

  const missingRows = await runBoundedCwlTagStage({
    stage: "cwl_tags_missing_name_rows_query",
    timeoutMs: CWL_TAG_DB_STAGE_TIMEOUT_MS,
    details: { season, valid_count: parsed.validTags.length },
    action: () =>
      prisma.cwlTrackedClan.findMany({
        where: {
          season,
          tag: { in: parsed.validTags },
          OR: [{ name: null }, { name: "" }],
        },
        select: { tag: true },
      }),
  });

  if (missingRows.length <= 0) {
    console.info(
      `[tracked-clan] stage=cwl_tags_name_hydration_completed season=${season} hydrated_count=0 skipped_count=0`,
    );
    return;
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
        if (!clanName) {
          skippedCount += 1;
          console.info(
            `[tracked-clan] stage=cwl_tags_name_hydration_skipped season=${season} tag=${tag} reason=empty_name`,
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
                OR: [{ name: null }, { name: "" }],
              },
              data: {
                name: clanName,
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
          `[tracked-clan] stage=cwl_tags_name_hydration_failed season=${season} tag=${tag} error=${formatError(err)}`,
        );
      }
    }),
  );

  console.info(
    `[tracked-clan] stage=cwl_tags_name_hydration_completed season=${season} hydrated_count=${hydratedCount} skipped_count=${skippedCount}`,
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
    const [deletedClans, deletedMappings] = await prisma.$transaction([
      prisma.cwlTrackedClan.deleteMany({
        where: { season, tag: normalizedTag },
      }),
      prisma.cwlPlayerClanSeason.deleteMany({
        where: { season, cwlClanTag: normalizedTag },
      }),
    ]);
    if (deletedClans.count <= 0) {
      return { outcome: "not_found", tag: normalizedTag, season };
    }
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "CWL",
      season,
      removedCount: deletedClans.count + deletedMappings.count,
    };
  }

  const [fwaRow, cwlRow] = await Promise.all([
    prisma.trackedClan.findUnique({
      where: { tag: normalizedTag },
      select: { tag: true },
    }),
    prisma.cwlTrackedClan.findFirst({
      where: { season, tag: normalizedTag },
      select: { id: true },
    }),
  ]);

  if (fwaRow && cwlRow) {
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
    const [deletedClans, deletedMappings] = await prisma.$transaction([
      prisma.cwlTrackedClan.deleteMany({
        where: { season, tag: normalizedTag },
      }),
      prisma.cwlPlayerClanSeason.deleteMany({
        where: { season, cwlClanTag: normalizedTag },
      }),
    ]);
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "CWL",
      season,
      removedCount: deletedClans.count + deletedMappings.count,
    };
  }

  return {
    outcome: "not_found",
    tag: normalizedTag,
    season,
  };
}
