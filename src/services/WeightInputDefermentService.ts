import { Client } from "discord.js";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CommandPermissionService } from "./CommandPermissionService";
import { playerCurrentService } from "./PlayerCurrentService";
import { buildFwaWeightPageUrl } from "./FwaStatsWeightService";
import { normalizeTag, normalizeTagBare } from "./war-events/core";
import type { CoCService } from "./CoCService";

export type DefermentStatus = "open" | "resolved" | "cleared";
export type DefermentStage = "48h" | "5d" | "7d";

export type DefermentScopeContext = {
  guildId: string;
  clanTag: string | null;
  scopeKey: string;
};

export type AddDefermentResult = {
  outcome: "created" | "updated";
  record: {
    id: string;
    guildId: string;
    clanTag: string | null;
    scopeKey: string;
    playerTag: string;
    deferredWeight: number;
    createdAt: Date;
    status: string;
  };
};

export type AddWeightInputDefermentWithPlayerProfileResult =
  | AddDefermentResult
  | {
      outcome: "player_profile_not_found";
      playerTag: string;
    }
  | {
      outcome: "player_profile_lookup_failed";
      playerTag: string;
    }
  | {
      outcome: "player_current_upsert_failed";
      playerTag: string;
    }
  | {
      outcome: "deferment_write_failed";
      playerTag: string;
    };

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESS_LOCK_TTL_MS = 10 * 60 * 1000;
const commandPermissionService = new CommandPermissionService();

export type OpenWeightInputDefermentRow = {
  id: string;
  guildId: string;
  clanTag: string | null;
  scopeKey: string;
  playerTag: string;
  deferredWeight: number;
  createdAt: Date;
  status: string;
};

export type OpenWeightInputDefermentListResult = {
  scope: DefermentScopeContext;
  rows: OpenWeightInputDefermentRow[];
  filterClanTag: string | null;
};

/** Purpose: normalize player tags to an uppercase #TAG shape. */
export function normalizePlayerTag(input: string): string {
  const raw = String(input ?? "").trim().toUpperCase().replace(/^#/, "");
  if (!raw) return "";
  if (!/^[PYLQGRJCUV0289]+$/.test(raw)) return "";
  return `#${raw}`;
}

/** Purpose: parse defer weight input using the same 145000/145,000/145k style accepted elsewhere. */
export function parseDeferWeightInput(input: string): number | null {
  const trimmed = String(input ?? "").trim().toLowerCase();
  if (!trimmed) return null;
  const compact = trimmed.replace(/,/g, "");
  const kMatch = compact.match(/^(\d+(?:\.\d+)?)k$/);
  if (kMatch) {
    const base = Number(kMatch[1]);
    if (!Number.isFinite(base)) return null;
    const value = Math.round(base * 1000);
    return value > 0 ? value : null;
  }
  const numeric = Number(compact);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return rounded > 0 ? rounded : null;
}

/** Purpose: build a stable scope key for deferment rows. */
export function buildDeferScopeKey(guildId: string, clanTag: string | null): string {
  const bareClan = normalizeTagBare(clanTag);
  if (!bareClan) return `guild:${guildId}`;
  return `guild:${guildId}|clan:${bareClan}`;
}

/** Purpose: render deterministic pending-age text for reminders and list output. */
export function formatPendingAge(createdAt: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - createdAt.getTime());
  const totalHours = Math.floor(diffMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}

function logDeferStage(input: {
  stage: string;
  status: "started" | "ok" | "not_found" | "failed";
  guildId: string;
  channelId: string | null;
  playerTag: string;
  deferredWeight: number;
  scope?: DefermentScopeContext | null;
  errorCategory?: string | null;
  error?: unknown;
}): void {
  const scope = input.scope ?? null;
  const channelText = input.channelId ?? "none";
  const scopeText = scope ? ` scopeKey=${scope.scopeKey} clanTag=${scope.clanTag ?? "none"}` : "";
  const base = `[defer] source=slash:defer:add stage=${input.stage} status=${input.status} guild=${input.guildId} channel=${channelText} player=${input.playerTag} deferredWeight=${input.deferredWeight}${scopeText}`;
  if (input.error) {
    console.error(
      `${base} error_category=${input.errorCategory ?? "unknown"} error=${formatError(input.error)}`,
    );
    return;
  }
  console.info(base);
}

function parseStatus(input: string): DefermentStatus | null {
  if (input === "open" || input === "resolved" || input === "cleared") {
    return input;
  }
  return null;
}

async function findWeightInputDeferment(input: {
  scopeKey: string;
  playerTag: string;
}) {
  const existing = await prisma.weightInputDeferment.findUnique({
    where: {
      scopeKey_playerTag: {
        scopeKey: input.scopeKey,
        playerTag: input.playerTag,
      },
    },
  });
  return existing && parseStatus(existing.status) ? existing : null;
}

async function resolveClanScopeFromChannel(
  guildId: string,
  channelId: string | null
): Promise<string | null> {
  if (!channelId) return null;
  const found = new Set<string>();
  const [notifyRows, trackedRows, currentWarRows] = await Promise.all([
    prisma.clanNotifyConfig.findMany({
      where: { guildId, channelId },
      select: { clanTag: true },
      take: 5,
    }),
    prisma.trackedClan.findMany({
      where: {
        OR: [{ notifyChannelId: channelId }, { logChannelId: channelId }, { mailChannelId: channelId }],
      },
      select: { tag: true },
      take: 5,
    }),
    prisma.currentWar.findMany({
      where: { guildId, channelId },
      select: { clanTag: true },
      take: 5,
    }),
  ]);
  for (const row of notifyRows) {
    const tag = normalizeTag(row.clanTag);
    if (tag) found.add(tag);
  }
  for (const row of trackedRows) {
    const tag = normalizeTag(row.tag);
    if (tag) found.add(tag);
  }
  for (const row of currentWarRows) {
    const tag = normalizeTag(row.clanTag);
    if (tag) found.add(tag);
  }
  if (found.size === 1) return [...found][0];
  return null;
}

/** Purpose: resolve deferment scope from guild + channel context with deterministic fallback. */
export async function resolveDefermentScopeContext(input: {
  guildId: string;
  channelId: string | null;
}): Promise<DefermentScopeContext> {
  const channelClanTag = await resolveClanScopeFromChannel(input.guildId, input.channelId);
  if (channelClanTag) {
    return {
      guildId: input.guildId,
      clanTag: channelClanTag,
      scopeKey: buildDeferScopeKey(input.guildId, channelClanTag),
    };
  }

  const tracked = await prisma.trackedClan.findMany({
    select: { tag: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  if (tracked.length === 1) {
    const clanTag = normalizeTag(tracked[0]?.tag ?? "");
    return {
      guildId: input.guildId,
      clanTag: clanTag || null,
      scopeKey: buildDeferScopeKey(input.guildId, clanTag || null),
    };
  }

  return {
    guildId: input.guildId,
    clanTag: null,
    scopeKey: buildDeferScopeKey(input.guildId, null),
  };
}

/** Purpose: add one deferment row if no matching open row exists in the resolved scope. */
export async function addWeightInputDeferment(input: {
  guildId: string;
  channelId: string | null;
  playerTag: string;
  deferredWeight: number;
  resolvedScope?: DefermentScopeContext | null;
}): Promise<AddDefermentResult> {
  const scope =
    input.resolvedScope ??
    (await resolveDefermentScopeContext({
      guildId: input.guildId,
      channelId: input.channelId,
    }));
  const existing = await findWeightInputDeferment({
    scopeKey: scope.scopeKey,
    playerTag: input.playerTag,
  });

  const next = await prisma.weightInputDeferment.upsert({
    where: {
      scopeKey_playerTag: {
        scopeKey: scope.scopeKey,
        playerTag: input.playerTag,
      },
    },
    update: {
      clanTag: scope.clanTag,
      deferredWeight: input.deferredWeight,
      status: "open",
      resolvedAt: null,
      clearedAt: null,
      reminded48At: null,
      escalated5dAt: null,
      summarized7dAt: null,
      processingLockToken: null,
      processingLockExpiresAt: null,
    },
    create: {
      guildId: scope.guildId,
      scopeKey: scope.scopeKey,
      clanTag: scope.clanTag,
      playerTag: input.playerTag,
      deferredWeight: input.deferredWeight,
      status: "open",
    },
  });
  return { outcome: existing ? "updated" : "created", record: next };
}

/** Purpose: add one deferment row after resolving the live player profile and upserting deferred fallback weight. */
export async function addWeightInputDefermentWithPlayerProfile(input: {
  guildId: string;
  channelId: string | null;
  playerTag: string;
  deferredWeight: number;
  cocService: Pick<CoCService, "getPlayerRaw">;
}): Promise<AddWeightInputDefermentWithPlayerProfileResult> {
  const playerTag = normalizePlayerTag(input.playerTag);
  if (!playerTag) {
    return {
      outcome: "player_profile_not_found",
      playerTag: "",
    };
  }

  let scope: DefermentScopeContext;
  try {
    logDeferStage({
      stage: "scope_resolve",
      status: "started",
      guildId: input.guildId,
      channelId: input.channelId,
      playerTag,
      deferredWeight: input.deferredWeight,
    });
    scope = await resolveDefermentScopeContext({
      guildId: input.guildId,
      channelId: input.channelId,
    });
    logDeferStage({
      stage: "scope_resolve",
      status: "ok",
      guildId: input.guildId,
      channelId: input.channelId,
      playerTag,
      deferredWeight: input.deferredWeight,
      scope,
    });
  } catch (error) {
    logDeferStage({
      stage: "scope_resolve",
      status: "failed",
      guildId: input.guildId,
      channelId: input.channelId,
      playerTag,
      deferredWeight: input.deferredWeight,
      errorCategory: "scope_resolution_failed",
      error,
    });
    throw error;
  }

  logDeferStage({
    stage: "profile_lookup",
    status: "started",
    guildId: input.guildId,
    channelId: input.channelId,
    playerTag,
    deferredWeight: input.deferredWeight,
    scope,
  });

  let livePlayer: unknown;
  try {
    livePlayer = await input.cocService.getPlayerRaw(playerTag);
  } catch (error) {
    logDeferStage({
      stage: "profile_lookup",
      status: "failed",
      guildId: input.guildId,
      channelId: input.channelId,
      playerTag,
      deferredWeight: input.deferredWeight,
      scope,
      errorCategory: "player_profile_lookup_failed",
      error,
    });
    return {
      outcome: "player_profile_lookup_failed",
      playerTag,
    };
  }
  if (!livePlayer) {
    logDeferStage({
      stage: "profile_lookup",
      status: "not_found",
      guildId: input.guildId,
      channelId: input.channelId,
      playerTag,
      deferredWeight: input.deferredWeight,
      scope,
    });
    return {
      outcome: "player_profile_not_found",
      playerTag,
    };
  }

  logDeferStage({
    stage: "player_current_upsert",
    status: "started",
    guildId: input.guildId,
    channelId: input.channelId,
    playerTag,
    deferredWeight: input.deferredWeight,
    scope,
  });

  try {
    await playerCurrentService.upsertPlayerCurrentFromLivePlayer({
      playerTag,
      livePlayer,
      currentWeight: input.deferredWeight,
    });
  } catch (error) {
    logDeferStage({
      stage: "player_current_upsert",
      status: "failed",
      guildId: input.guildId,
      channelId: input.channelId,
      playerTag,
      deferredWeight: input.deferredWeight,
      scope,
      errorCategory: "player_current_upsert_failed",
      error,
    });
    return {
      outcome: "player_current_upsert_failed",
      playerTag,
    };
  }

  logDeferStage({
    stage: "deferment_write",
    status: "started",
    guildId: input.guildId,
    channelId: input.channelId,
    playerTag,
    deferredWeight: input.deferredWeight,
    scope,
  });

  let result: AddDefermentResult;
  try {
    result = await addWeightInputDeferment({
      guildId: input.guildId,
      channelId: input.channelId,
      playerTag,
      deferredWeight: input.deferredWeight,
      resolvedScope: scope,
    });
  } catch (error) {
    logDeferStage({
      stage: "deferment_write",
      status: "failed",
      guildId: input.guildId,
      channelId: input.channelId,
      playerTag,
      deferredWeight: input.deferredWeight,
      scope,
      errorCategory: "deferment_write_failed",
      error,
    });
    return {
      outcome: "deferment_write_failed",
      playerTag,
    };
  }

  logDeferStage({
    stage: "deferment_write",
    status: "ok",
    guildId: input.guildId,
    channelId: input.channelId,
    playerTag,
    deferredWeight: input.deferredWeight,
    scope,
  });

  return result;
}

async function listOpenWeightInputDefermentsForClan(input: {
  guildId: string;
  clanTag: string;
}): Promise<OpenWeightInputDefermentListResult> {
  const normalizedClanTag = normalizeTag(input.clanTag);
  if (!normalizedClanTag) {
    return {
      scope: {
        guildId: input.guildId,
        clanTag: null,
        scopeKey: buildDeferScopeKey(input.guildId, null),
      },
      rows: [],
      filterClanTag: null,
    };
  }

  const guildScopeKey = buildDeferScopeKey(input.guildId, null);
  const clanScopeKey = buildDeferScopeKey(input.guildId, normalizedClanTag);
  const currentMembers = await prisma.fwaClanMemberCurrent.findMany({
    where: {
      OR: [
        { clanTag: { equals: normalizedClanTag, mode: "insensitive" } },
        { clanTag: { equals: normalizeTagBare(normalizedClanTag), mode: "insensitive" } },
      ],
    },
    select: {
      playerTag: true,
    },
    orderBy: [{ playerTag: "asc" }],
  });
  const currentMemberTags = new Set(
    currentMembers.map((row) => normalizePlayerTag(row.playerTag)).filter((tag): tag is string => Boolean(tag)),
  );
  if (currentMemberTags.size === 0) {
    return {
      scope: {
        guildId: input.guildId,
        clanTag: normalizedClanTag,
        scopeKey: clanScopeKey,
      },
      rows: [],
      filterClanTag: normalizedClanTag,
    };
  }

  const rows = await prisma.weightInputDeferment.findMany({
    where: {
      guildId: input.guildId,
      status: "open",
      scopeKey: { in: [clanScopeKey, guildScopeKey] },
      playerTag: { in: [...currentMemberTags] },
    },
    orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
  });

  const filteredRows = (rows as OpenWeightInputDefermentRow[]).filter((row) => {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) return false;
    if (!currentMemberTags.has(playerTag)) return false;
    return row.scopeKey === clanScopeKey || row.scopeKey === guildScopeKey;
  });

  return {
    scope: {
      guildId: input.guildId,
      clanTag: normalizedClanTag,
      scopeKey: clanScopeKey,
    },
    rows: filteredRows,
    filterClanTag: normalizedClanTag,
  };
}

/** Purpose: list active deferments for the resolved command scope in deterministic oldest-first order. */
export async function listOpenWeightInputDeferments(input: {
  guildId: string;
  channelId: string | null;
  clanTag?: string | null;
}): Promise<OpenWeightInputDefermentListResult> {
  if (input.clanTag) {
    return listOpenWeightInputDefermentsForClan({
      guildId: input.guildId,
      clanTag: input.clanTag,
    });
  }
  const scope = await resolveDefermentScopeContext({
    guildId: input.guildId,
    channelId: input.channelId,
  });
  const rows = await prisma.weightInputDeferment.findMany({
    where: {
      scopeKey: scope.scopeKey,
      status: "open",
    },
    orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
  });
  return { scope, rows: rows as OpenWeightInputDefermentRow[], filterClanTag: null };
}

/** Purpose: resolve open deferred weights for many clan/player sets in one bulk query with the same clan-over-guild precedence rules. */
export async function listOpenDeferredWeightsByClanAndPlayerTags(input: {
  guildId: string | null | undefined;
  clanPlayerTags: Array<{
    clanTag: string | null;
    playerTags: string[];
  }>;
}): Promise<Map<string, Map<string, number>>> {
  const guildId = String(input.guildId ?? "").trim();
  if (!guildId) return new Map<string, Map<string, number>>();

  const requested = input.clanPlayerTags
    .map((entry) => {
      const normalizedClanTag = normalizeTag(entry.clanTag);
      const normalizedPlayerTags = [
        ...new Set(
          (entry.playerTags ?? [])
            .map((tag) => normalizePlayerTag(tag))
            .filter((tag): tag is string => Boolean(tag)),
        ),
      ];
      return {
        clanTag: normalizedClanTag || null,
        playerTags: normalizedPlayerTags,
      };
    })
    .filter((entry) => entry.playerTags.length > 0);

  if (requested.length === 0) return new Map<string, Map<string, number>>();

  const guildScopeKey = buildDeferScopeKey(guildId, null);
  const allPlayerTags = [
    ...new Set(requested.flatMap((entry) => entry.playerTags)),
  ];
  const scopeKeys = [
    ...new Set(
      requested.flatMap((entry) => [
        buildDeferScopeKey(guildId, entry.clanTag),
        guildScopeKey,
      ]),
    ),
  ];

  const rows = await prisma.weightInputDeferment.findMany({
    where: {
      guildId,
      status: "open",
      scopeKey: { in: scopeKeys },
      playerTag: { in: allPlayerTags },
    },
    select: {
      scopeKey: true,
      playerTag: true,
      deferredWeight: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  const rowsByPlayerTag = new Map<string, typeof rows>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    const existing = rowsByPlayerTag.get(playerTag) ?? [];
    existing.push(row);
    rowsByPlayerTag.set(playerTag, existing);
  }

  const result = new Map<string, Map<string, number>>();
  for (const entry of requested) {
    const clanTagKey = entry.clanTag ?? "";
    const clanScopeKey = buildDeferScopeKey(guildId, entry.clanTag);
    const deferredByPlayerTag = new Map<string, number>();

    for (const playerTag of entry.playerTags) {
      const candidates = rowsByPlayerTag.get(playerTag) ?? [];
      let best:
        | {
            deferredWeight: number;
            scopePriority: number;
            createdAtMs: number;
          }
        | null = null;

      for (const row of candidates) {
        if (row.scopeKey !== clanScopeKey && row.scopeKey !== guildScopeKey) {
          continue;
        }
        const deferredWeight =
          row.deferredWeight !== null &&
          row.deferredWeight !== undefined &&
          Number.isFinite(row.deferredWeight)
            ? Math.max(0, Math.trunc(row.deferredWeight))
            : null;
        if (deferredWeight === null) continue;

        const scopePriority = row.scopeKey === clanScopeKey ? 0 : 1;
        const createdAtMs = row.createdAt.getTime();
        if (
          !best ||
          scopePriority < best.scopePriority ||
          (scopePriority === best.scopePriority &&
            createdAtMs > best.createdAtMs)
        ) {
          best = { deferredWeight, scopePriority, createdAtMs };
        }
      }

      if (best) {
        deferredByPlayerTag.set(playerTag, best.deferredWeight);
      }
    }

    result.set(clanTagKey, deferredByPlayerTag);
  }

  return result;
}

/** Purpose: resolve one open deferment by tag for command-driven state transitions. */
export async function removeOpenWeightInputDeferment(input: {
  guildId: string;
  channelId: string | null;
  playerTag: string;
}): Promise<{ removed: boolean; scope: DefermentScopeContext }> {
  const scope = await resolveDefermentScopeContext({
    guildId: input.guildId,
    channelId: input.channelId,
  });
  const updated = await prisma.weightInputDeferment.updateMany({
    where: {
      scopeKey: scope.scopeKey,
      playerTag: input.playerTag,
      status: "open",
    },
    data: {
      status: "resolved",
      resolvedAt: new Date(),
      processingLockToken: null,
      processingLockExpiresAt: null,
    },
  });
  return { removed: updated.count > 0, scope };
}

/** Purpose: clear all open deferments for the resolved command scope and return deterministic count. */
export async function clearOpenWeightInputDeferments(input: {
  guildId: string;
  channelId: string | null;
}): Promise<{ clearedCount: number; scope: DefermentScopeContext }> {
  const scope = await resolveDefermentScopeContext({
    guildId: input.guildId,
    channelId: input.channelId,
  });
  const updated = await prisma.weightInputDeferment.updateMany({
    where: { scopeKey: scope.scopeKey, status: "open" },
    data: {
      status: "cleared",
      clearedAt: new Date(),
      processingLockToken: null,
      processingLockExpiresAt: null,
    },
  });
  return { clearedCount: updated.count, scope };
}

/** Purpose: compute due lifecycle stages in deterministic catch-up order. */
export function getDueDefermentStagesForTest(
  row: {
    createdAt: Date;
    reminded48At: Date | null;
    escalated5dAt: Date | null;
    summarized7dAt: Date | null;
  },
  now: Date = new Date()
): DefermentStage[] {
  const ageMs = Math.max(0, now.getTime() - row.createdAt.getTime());
  const due: DefermentStage[] = [];
  if (ageMs >= FORTY_EIGHT_HOURS_MS && !row.reminded48At) {
    due.push("48h");
  }
  if (ageMs >= FIVE_DAYS_MS && !row.escalated5dAt) {
    due.push("5d");
  }
  if (ageMs >= SEVEN_DAYS_MS && !row.summarized7dAt) {
    due.push("7d");
  }
  return due;
}

function stageTimestampField(stage: DefermentStage): "reminded48At" | "escalated5dAt" | "summarized7dAt" {
  if (stage === "48h") return "reminded48At";
  if (stage === "5d") return "escalated5dAt";
  return "summarized7dAt";
}

async function acquireProcessingLock(
  rowId: string,
  now: Date
): Promise<{ token: string; expiresAt: Date } | null> {
  const token = `${rowId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = new Date(now.getTime() + PROCESS_LOCK_TTL_MS);
  const claimed = await prisma.weightInputDeferment.updateMany({
    where: {
      id: rowId,
      status: "open",
      OR: [{ processingLockExpiresAt: null }, { processingLockExpiresAt: { lt: now } }],
    },
    data: {
      processingLockToken: token,
      processingLockExpiresAt: expiresAt,
    },
  });
  if (claimed.count === 0) return null;
  return { token, expiresAt };
}

async function releaseProcessingLock(rowId: string, token: string): Promise<void> {
  await prisma.weightInputDeferment.updateMany({
    where: { id: rowId, processingLockToken: token },
    data: {
      processingLockToken: null,
      processingLockExpiresAt: null,
    },
  });
}

type ReminderDestination = {
  channelId: string | null;
  clanTag: string;
  clanName: string | null;
  currentWeight: number | null;
};

/** Purpose: resolve reminder routing from the player's current tracked-clan membership. */
async function resolveCurrentReminderDestination(input: {
  playerTag: string;
}): Promise<ReminderDestination | null> {
  const playerTag = normalizeTag(input.playerTag);
  if (!playerTag) return null;
  const memberships = await prisma.fwaClanMemberCurrent.findMany({
    where: { playerTag },
    select: {
      clanTag: true,
      weight: true,
      sourceSyncedAt: true,
    },
    orderBy: { sourceSyncedAt: "desc" },
    take: 10,
  });
  if (memberships.length === 0) return null;

  const candidateTags = Array.from(
    new Set(
      memberships.flatMap((row) => {
        const normalized = normalizeTag(row.clanTag);
        const bare = normalizeTagBare(row.clanTag);
        return [normalized, bare].filter(Boolean);
      }),
    ),
  );
  if (candidateTags.length === 0) return null;

  const trackedRows = await prisma.trackedClan.findMany({
    where: {
      OR: candidateTags.map((value) => ({ tag: value })),
    },
    select: {
      tag: true,
      name: true,
      logChannelId: true,
    },
    take: candidateTags.length,
  });
  const trackedByBare = new Map<
    string,
    {
      tag: string;
      name: string | null;
      logChannelId: string | null;
    }
  >();
  for (const tracked of trackedRows) {
    const bare = normalizeTagBare(tracked.tag);
    if (!bare || trackedByBare.has(bare)) continue;
    trackedByBare.set(bare, tracked);
  }

  for (const membership of memberships) {
    const bare = normalizeTagBare(membership.clanTag);
    if (!bare) continue;
    const tracked = trackedByBare.get(bare);
    if (!tracked) continue;
    return {
      channelId: tracked.logChannelId ?? null,
      clanTag: normalizeTag(tracked.tag),
      clanName: tracked.name?.trim() || null,
      currentWeight: membership.weight ?? null,
    };
  }
  return null;
}

function buildStageMessage(input: {
  stage: DefermentStage;
  playerTag: string;
  deferredWeight: number;
  pendingAge: string;
  clanTag: string | null;
  clanName: string | null;
  currentWeight: number | null;
  leaderRoleId: string | null;
}): string {
  const header =
    input.stage === "48h"
      ? "Weight Deferment Reminder (48h)"
      : input.stage === "5d"
        ? "Weight Deferment Escalation (5d)"
        : "Weight Deferment Leadership Summary (7d)";
  const mention = input.leaderRoleId ? `<@&${input.leaderRoleId}> ` : "";
  const clanLabel = input.clanTag
    ? input.clanName
      ? `${input.clanName} (${input.clanTag})`
      : input.clanTag
    : "unscoped";
  const weightPageUrl = input.clanTag ? buildFwaWeightPageUrl(input.clanTag) : null;
  return [
    `${mention}**${header}**`,
    `Player: ${input.playerTag}`,
    `Deferred weight: ${input.deferredWeight}`,
    `Current weight: ${input.currentWeight ?? "unknown"}`,
    `Pending age: ${input.pendingAge}`,
    `Current clan: ${clanLabel}`,
    `FWA Stats weights: ${weightPageUrl ? `<${weightPageUrl}>` : "unknown"}`,
    "Resolve after FWAStats entry with `/defer remove <player-tag>`.",
  ].join("\n");
}

async function deliverStageMessage(input: {
  client: Client;
  guildId: string;
  stage: DefermentStage;
  playerTag: string;
  deferredWeight: number;
  createdAt: Date;
  destination: ReminderDestination;
  leaderRoleId: string | null;
}): Promise<boolean> {
  if (!input.destination.channelId) {
    console.warn(
      `[defer] stage=${input.stage} guild=${input.guildId} player=${input.playerTag} route=missing_log_channel`
    );
    return false;
  }
  const channel = await input.client.channels
    .fetch(input.destination.channelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.warn(
      `[defer] stage=${input.stage} guild=${input.guildId} player=${input.playerTag} route=invalid_channel channel=${input.destination.channelId}`
    );
    return false;
  }
  const content = buildStageMessage({
    stage: input.stage,
    playerTag: input.playerTag,
    deferredWeight: input.deferredWeight,
    pendingAge: formatPendingAge(input.createdAt),
    clanTag: input.destination.clanTag,
    clanName: input.destination.clanName,
    currentWeight: input.destination.currentWeight,
    leaderRoleId: input.leaderRoleId,
  });
  await channel.send({ content });
  return true;
}

async function markStageComplete(input: {
  rowId: string;
  token: string;
  stage: DefermentStage;
  now: Date;
}): Promise<boolean> {
  const field = stageTimestampField(input.stage);
  const updated = await prisma.weightInputDeferment.updateMany({
    where: {
      id: input.rowId,
      status: "open",
      processingLockToken: input.token,
      [field]: null,
    },
    data: {
      [field]: input.now,
    },
  });
  return updated.count > 0;
}

async function markDefermentResolvedByCurrentWeight(input: {
  rowId: string;
  token: string;
  now: Date;
}): Promise<boolean> {
  const updated = await prisma.weightInputDeferment.updateMany({
    where: {
      id: input.rowId,
      status: "open",
      processingLockToken: input.token,
    },
    data: {
      status: "resolved",
      resolvedAt: input.now,
      processingLockToken: null,
      processingLockExpiresAt: null,
    },
  });
  return updated.count > 0;
}

/** Purpose: process deferred-weight reminder stages with catch-up ordering and lock-safe idempotency. */
export async function processWeightInputDefermentStages(
  client: Client,
  guildId?: string | null
): Promise<void> {
  const now = new Date();
  const oldestDueAt = new Date(now.getTime() - FORTY_EIGHT_HOURS_MS);
  const rows = await prisma.weightInputDeferment.findMany({
    where: {
      status: "open",
      createdAt: { lte: oldestDueAt },
      ...(guildId ? { guildId } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const row of rows) {
    const lock = await acquireProcessingLock(row.id, now);
    if (!lock) continue;
    try {
      const locked = await prisma.weightInputDeferment.findFirst({
        where: { id: row.id, status: "open", processingLockToken: lock.token },
      });
      if (!locked) continue;
      const dueStages = getDueDefermentStagesForTest(locked, now);
      const destination = await resolveCurrentReminderDestination({
        playerTag: locked.playerTag,
      });
      if (!destination) {
        console.log(
          `[defer] guild=${locked.guildId} player=${locked.playerTag} status=skipped_not_in_current_membership`
        );
        continue;
      }
      if (
        destination.currentWeight !== null &&
        destination.currentWeight === locked.deferredWeight
      ) {
        const resolved = await markDefermentResolvedByCurrentWeight({
          rowId: locked.id,
          token: lock.token,
          now: new Date(),
        });
        if (resolved) {
          console.log(
            `[defer] guild=${locked.guildId} player=${locked.playerTag} status=auto_resolved_current_weight_match`
          );
        }
        continue;
      }
      const leaderRoleId = await commandPermissionService.getFwaLeaderRoleId(
        locked.guildId,
      );
      for (const stage of dueStages) {
        try {
          const sent = await deliverStageMessage({
            client,
            guildId: locked.guildId,
            stage,
            playerTag: locked.playerTag,
            deferredWeight: locked.deferredWeight,
            createdAt: locked.createdAt,
            destination,
            leaderRoleId,
          });
          if (!sent) {
            console.warn(
              `[defer] stage=${stage} guild=${locked.guildId} player=${locked.playerTag} status=send_skipped`
            );
            break;
          }
          const marked = await markStageComplete({
            rowId: locked.id,
            token: lock.token,
            stage,
            now: new Date(),
          });
          if (!marked) break;
          console.log(
            `[defer] stage=${stage} guild=${locked.guildId} player=${locked.playerTag} status=completed`
          );
        } catch (err) {
          console.error(
            `[defer] stage=${stage} guild=${locked.guildId} player=${locked.playerTag} status=failed error=${formatError(err)}`
          );
          break;
        }
      }
    } finally {
      await releaseProcessingLock(row.id, lock.token).catch((err) => {
        console.error(
          `[defer] lock_release_failed guild=${row.guildId} player=${row.playerTag} error=${formatError(err)}`
        );
      });
    }
  }
}
