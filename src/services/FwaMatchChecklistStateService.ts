import { Client } from "discord.js";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { normalizeClanTag } from "./PlayerLinkService";
import { sanitizeClanName, parseCocApiTime } from "./fwaChecklistParsers";
import {
  buildFwaMatchChecklistRowContextKey,
  buildFwaMatchChecklistScopeKey,
  findLatestFwaMatchChecklistCheckedClanTags,
  buildFwaBaseSwapIssueSummary,
  type FwaMatchChecklistTrackedRow,
  trackedMessageService,
  buildFwaMatchCompactCopyLine,
  resolveTrackedMessageSyncIdentity,
  normalizeTrackedMessageId,
} from "./TrackedMessageService";
import { resolveFwaMatchStateEmoji } from "./FwaMatchStateEmojiService";
import { WarMailLifecycleService } from "./WarMailLifecycleService";
import { formatError } from "../helper/formatError";

type FwaMatchChecklistViewType = "Mail" | "Bases";
type FwaChecklistSyncIdentitySource =
  | "override"
  | "active_sync_post"
  | "expired_sync_post_fallback"
  | "none";

type FwaMatchChecklistSingleView = {
  liveRevisionFields?: {
    warId?: string | number | null;
    opponentTag?: string | null;
  } | null;
};

export type FwaMatchChecklistRenderState = {
  viewType: FwaMatchChecklistViewType;
  rows: FwaMatchChecklistTrackedRow[];
  scopeKey: string;
  checkedClanTags: string[];
  referenceId: string | null;
  expiresAt: Date | null;
  emptyMessage: string | null;
};

const MAILBOX_SENT_EMOJI = "📬";
const MAILBOX_NOT_SENT_EMOJI = "📭";

function normalizeTagBare(tag: string): string {
  return String(tag ?? "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
}

function normalizeChecklistClanTag(tag: string): string {
  const normalized = normalizeClanTag(tag);
  return normalized || normalizeTagBare(tag);
}

function buildDiscordMessageLink(input: {
  guildId: string | null | undefined;
  channelId: string | null | undefined;
  messageId: string | null | undefined;
}): string | null {
  const guildId = String(input.guildId ?? "").trim();
  const channelId = String(input.channelId ?? "").trim();
  const messageId = String(input.messageId ?? "").trim();
  if (!guildId || !channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function parseTrackedClanBadge(
  badge: string | null | undefined,
): {
  badgeEmojiId: string | null;
  badgeEmojiName: string | null;
  badgeEmojiInline: string;
} {
  const trimmed = String(badge ?? "").trim();
  if (!trimmed) {
    return {
      badgeEmojiId: null,
      badgeEmojiName: null,
      badgeEmojiInline: "",
    };
  }
  const custom = /^<a?:([A-Za-z0-9_]{2,32}):(\d{1,22})>$/.exec(trimmed);
  if (custom) {
    return {
      badgeEmojiId: custom[2],
      badgeEmojiName: custom[1],
      badgeEmojiInline: `<${custom[0].startsWith("<a:") ? "a" : ""}:${custom[1]}:${custom[2]}>`,
    };
  }
  return {
    badgeEmojiId: null,
    badgeEmojiName: trimmed,
    badgeEmojiInline: trimmed,
  };
}

function buildFallbackChecklistExpiresAt(params?: {
  nowMs?: number;
  fallbackExpiresAt?: Date | null;
}): Date {
  if (
    params?.fallbackExpiresAt instanceof Date &&
    Number.isFinite(params.fallbackExpiresAt.getTime())
  ) {
    return params.fallbackExpiresAt;
  }
  return new Date((params?.nowMs ?? Date.now()) + 30 * 60 * 1000);
}

type ChecklistExpiryCandidate = {
  label: string;
  value: Date | null | undefined;
};

function buildChecklistWarTimingCandidates(input: {
  prepStartTime?: Date | null;
  startTime?: Date | null;
  endTime?: Date | null;
} | null | undefined): ChecklistExpiryCandidate[] {
  if (!input) {
    return [];
  }
  return [
    { label: "currentWar.endTime", value: input.endTime ?? null },
    {
      label: "currentWar.startTime+24h",
      value:
        input.startTime instanceof Date && Number.isFinite(input.startTime.getTime())
          ? new Date(input.startTime.getTime() + 24 * 60 * 60 * 1000)
          : null,
    },
    {
      label: "currentWar.prepStartTime+47h",
      value:
        input.prepStartTime instanceof Date && Number.isFinite(input.prepStartTime.getTime())
          ? new Date(input.prepStartTime.getTime() + 47 * 60 * 60 * 1000)
          : null,
    },
  ];
}

function resolveChecklistExpiresAt(params: {
  warTimingCandidates: ChecklistExpiryCandidate[];
  nowMs?: number;
  fallbackExpiresAt?: Date | null;
  logPrefix: string;
}): Date {
  const nowMs = params.nowMs ?? Date.now();
  const validFutureWarEndTimes: Date[] = [];
  for (const candidate of params.warTimingCandidates ?? []) {
    if (!(candidate.value instanceof Date) || !Number.isFinite(candidate.value.getTime())) {
      continue;
    }
    const candidateMs = candidate.value.getTime();
    if (candidateMs <= nowMs) {
      console.debug(
        `${params.logPrefix} expiry_candidate_ignored reason=past label=${candidate.label} candidateIso=${candidate.value.toISOString()} nowIso=${new Date(nowMs).toISOString()}`,
      );
      continue;
    }
    validFutureWarEndTimes.push(candidate.value);
  }
  if (validFutureWarEndTimes.length > 0) {
    const latestWarEndMs = validFutureWarEndTimes.reduce<number>((latest, current) => {
      return current.getTime() > latest ? current.getTime() : latest;
    }, validFutureWarEndTimes[0]!.getTime());
    return new Date(latestWarEndMs);
  }
  return buildFallbackChecklistExpiresAt({
    nowMs,
    fallbackExpiresAt: params.fallbackExpiresAt ?? null,
  });
}

function buildBasesScopeKey(params: {
  guildId: string;
  clanTag: string | null;
  rows: Iterable<FwaMatchChecklistTrackedRow>;
}): string {
  const guildId = String(params.guildId ?? "").trim() || "unknown";
  const clanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
  const rowTokens = [...params.rows]
    .map((row) =>
      String(row.contextKey ?? row.compactCopyLine ?? row.clanTag ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter((token) => Boolean(token))
    .sort();
  return [
    "fwa_match_bases",
    `guild=${guildId}`,
    `clan=${clanTag || "all"}`,
    `rows=${rowTokens.join("|") || "none"}`,
  ].join("|");
}

function normalizeMatchType(
  value: string | null | undefined,
): "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (
    normalized === "FWA" ||
    normalized === "BL" ||
    normalized === "MM" ||
    normalized === "SKIP"
  ) {
    return normalized;
  }
  return "UNKNOWN";
}

function normalizeOutcome(
  value: string | null | undefined,
): "WIN" | "LOSE" | "UNKNOWN" | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (normalized === "WIN" || normalized === "LOSE" || normalized === "UNKNOWN") {
    return normalized;
  }
  return null;
}

function normalizeWarState(
  value: string | null | undefined,
): "preparation" | "inWar" | "notInWar" | "unknown" {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "preparation" || normalized === "prep") {
    return "preparation";
  }
  if (normalized === "inwar" || normalized === "in_war") {
    return "inWar";
  }
  if (normalized === "notinwar" || normalized === "not_in_war") {
    return "notInWar";
  }
  return "unknown";
}

function isFreshMailChecklistWarIdentity(input: {
  currentWar: {
    state?: string | null;
    startTime?: Date | null;
    opponentTag?: string | null;
  } | null;
  liveWar: {
    state?: string | null;
    startTime?: string | null;
    opponent?: {
      tag?: string | null;
    } | null;
  } | null;
}): boolean {
  const currentWar = input.currentWar;
  const liveWar = input.liveWar;
  if (!currentWar || !liveWar) return false;

  const liveWarState = normalizeWarState(liveWar.state ?? null);
  if (liveWarState !== "preparation" && liveWarState !== "inWar") return false;

  if (!(currentWar.startTime instanceof Date) || !Number.isFinite(currentWar.startTime.getTime())) {
    return false;
  }
  const liveWarStartMs = parseCocApiTime(liveWar.startTime ?? null);
  if (liveWarStartMs === null || currentWar.startTime.getTime() !== liveWarStartMs) {
    return false;
  }

  const currentOpponentTag = normalizeChecklistClanTag(currentWar.opponentTag ?? "");
  const liveOpponentTag = normalizeChecklistClanTag(liveWar.opponent?.tag ?? "");
  if (!currentOpponentTag || !liveOpponentTag || currentOpponentTag !== liveOpponentTag) {
    return false;
  }

  return true;
}

function getCurrentWarCached(
  cocService: CoCService,
  clanTag: string,
  cache?: Map<string, Promise<any> | any>,
): Promise<any | null> {
  const normalizedTag = normalizeChecklistClanTag(clanTag);
  const cached = cache?.get(normalizedTag);
  if (cached) {
    return Promise.resolve(cached).catch(() => null);
  }
  const pending = cocService
    .getCurrentWar(normalizedTag)
    .catch((err) => {
      console.error(
        `[fwa match checklist state] getCurrentWar failed clan=${normalizedTag} error=${formatError(err)}`,
      );
      return null;
    });
  cache?.set(normalizedTag, pending);
  return pending;
}

function buildChecklistContextKeyByTag(
  views: Record<string, FwaMatchChecklistSingleView>,
): Map<string, string | null> {
  const contextKeyByTag = new Map<string, string | null>();
  for (const [tag, view] of Object.entries(views)) {
    contextKeyByTag.set(
      normalizeChecklistClanTag(tag),
      buildFwaMatchChecklistRowContextKey({
        clanTag: tag,
        warId: view.liveRevisionFields?.warId ?? null,
        opponentTag: view.liveRevisionFields?.opponentTag ?? null,
      }),
    );
  }
  return contextKeyByTag;
}

async function buildFwaMatchBasesRenderStateForGuild(params: {
  guildId: string;
  client: Client;
  syncMessageId?: string | null;
  fallbackExpiresAt?: Date | null;
}): Promise<FwaMatchChecklistRenderState> {
  const now = new Date();
  const overrideSyncIdentity = normalizeTrackedMessageId(params.syncMessageId ?? null);
  const latestActiveSyncPost = overrideSyncIdentity
    ? null
    : await trackedMessageService
        .resolveLatestActiveSyncPost(params.guildId)
        .catch(() => null);
  let currentSyncIdentity =
    overrideSyncIdentity ?? resolveTrackedMessageSyncIdentity(latestActiveSyncPost);
  let currentSyncIdentitySource: FwaChecklistSyncIdentitySource =
    overrideSyncIdentity
      ? "override"
      : currentSyncIdentity
        ? "active_sync_post"
        : "none";
  const trackedClans = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, clanBadge: true, name: true, shortName: true },
  });
  if (trackedClans.length === 0) {
    return {
      viewType: "Bases",
      rows: [],
      scopeKey: buildBasesScopeKey({
        guildId: params.guildId,
        clanTag: null,
        rows: [],
      }),
      checkedClanTags: [],
      referenceId: currentSyncIdentity,
      expiresAt: buildFallbackChecklistExpiresAt({
        nowMs: Date.now(),
        fallbackExpiresAt: params.fallbackExpiresAt ?? null,
      }),
      emptyMessage: "No tracked clans configured. Use `/clan configure` first.",
    };
  }

  const currentWars = await prisma.currentWar.findMany({
    where: { guildId: params.guildId },
    select: {
      clanTag: true,
      warId: true,
      prepStartTime: true,
      startTime: true,
      endTime: true,
      opponentTag: true,
      matchType: true,
      inferredMatchType: true,
      outcome: true,
      state: true,
    },
  });
  const currentWarByTag = new Map(
    currentWars.map((row) => [normalizeChecklistClanTag(row.clanTag), row]),
  );
  const rows: FwaMatchChecklistTrackedRow[] = [];
  const checklistExpiresAtCandidates: ChecklistExpiryCandidate[] = [];

  for (const clan of trackedClans) {
    const clanTag = normalizeChecklistClanTag(clan.tag);
    const currentWar = currentWarByTag.get(clanTag) ?? null;
    const activeCurrentWar =
      currentWar && String(currentWar.state ?? "").trim().toLowerCase() !== "notinwar"
        ? currentWar
        : null;
    if (activeCurrentWar) {
      checklistExpiresAtCandidates.push(
        ...buildChecklistWarTimingCandidates({
          prepStartTime: activeCurrentWar.prepStartTime ?? null,
          startTime: activeCurrentWar.startTime ?? null,
          endTime: activeCurrentWar.endTime ?? null,
        }),
      );
    }
    let rowSyncIdentity = currentSyncIdentity;
    let rowSyncIdentitySource: FwaChecklistSyncIdentitySource = currentSyncIdentitySource;
    if (!rowSyncIdentity && activeCurrentWar?.startTime instanceof Date) {
      rowSyncIdentity = await trackedMessageService
        .resolveLatestRelevantSyncPostForClanWar({
          guildId: params.guildId,
          clanTag,
          battleDayStart: activeCurrentWar.startTime,
          prepStartTime: activeCurrentWar.prepStartTime ?? null,
          now,
        })
        .catch(() => null);
      rowSyncIdentitySource = rowSyncIdentity ? "expired_sync_post_fallback" : "none";
      if (!currentSyncIdentity && rowSyncIdentity) {
        currentSyncIdentity = rowSyncIdentity;
        currentSyncIdentitySource = rowSyncIdentitySource;
      }
    }
    const activeBaseSwap = rowSyncIdentity
      ? await trackedMessageService
          .findLatestActiveFwaBaseSwapTrackedMessageForClan({
            guildId: params.guildId,
            clanTag,
            syncMessageId: rowSyncIdentity,
          })
          .catch(() => null)
      : null;
    const issueSummary = activeBaseSwap
      ? buildFwaBaseSwapIssueSummary(
          activeBaseSwap.metadata,
          String(activeCurrentWar?.matchType ?? activeCurrentWar?.inferredMatchType ?? "").trim() || null,
        )
      : {
          hasIssues: false,
          statusText: "❌ Bases not checked",
          detailLines: [],
        };
    const matchType = normalizeMatchType(
      String(activeCurrentWar?.matchType ?? activeCurrentWar?.inferredMatchType ?? "").trim() || null,
    );
    const outcome = normalizeOutcome(activeCurrentWar?.outcome ?? null);
    const matchStateEmoji = resolveFwaMatchStateEmoji({
      matchType,
      outcome,
    });
    const clanLabel =
      sanitizeClanName(clan.shortName) ??
      sanitizeClanName(clan.name) ??
      `#${clanTag}`;
    const clanBadge = parseTrackedClanBadge(clan.clanBadge);
    const issueLink = activeBaseSwap
      ? buildDiscordMessageLink({
          guildId: activeBaseSwap.guildId,
          channelId: activeBaseSwap.channelId,
          messageId: activeBaseSwap.messageId,
        })
      : null;
    const activeBaseSwapSyncIdentity = normalizeTrackedMessageId(
      activeBaseSwap?.metadata.syncMessageId ?? null,
    );
    const baseSwapSource = activeBaseSwap
      ? activeBaseSwapSyncIdentity === rowSyncIdentity
        ? "matched_sync"
        : "matched_unscoped"
      : rowSyncIdentity
        ? "no_match"
        : "no_sync";
    const exactCompletion =
      issueSummary.hasIssues || !rowSyncIdentity
        ? null
        : await trackedMessageService
            .findLatestFwaMatchChecklistBasesCompletionForClan({
              guildId: params.guildId,
              clanTag,
              warId: activeCurrentWar?.warId ?? null,
              warStartTime: activeCurrentWar?.startTime ?? null,
              opponentTag: activeCurrentWar?.opponentTag ?? null,
              syncMessageId: rowSyncIdentity,
            })
            .catch(() => null);
    const fallbackCompletion =
      exactCompletion || issueSummary.hasIssues || !rowSyncIdentity
        ? null
        : await trackedMessageService
            .findLatestActiveFwaMatchChecklistBasesCompletionForClan({
              guildId: params.guildId,
              clanTag,
              warId: activeCurrentWar?.warId ?? null,
              warStartTime: activeCurrentWar?.startTime ?? null,
              opponentTag: activeCurrentWar?.opponentTag ?? null,
              syncMessageId: rowSyncIdentity,
            })
            .catch(() => null);
    const allGoodCompletion = exactCompletion ?? fallbackCompletion;
    const completionSource = exactCompletion
      ? "exact"
      : fallbackCompletion
        ? "sync_fallback"
        : "none";
    const visibleReaction = issueSummary.hasIssues || Boolean(allGoodCompletion);
    const statusText = issueSummary.hasIssues
      ? `${issueSummary.statusText}${issueLink ? `: [base-swap post](${issueLink})` : ""}`
      : allGoodCompletion
        ? "\u2705 Bases checked and all good"
        : "\u274c Bases not checked";
    console.debug(
      `[fwa_checklist_bases_row] guildId=${params.guildId} clanTag=${clanTag} visibleReaction=${visibleReaction} syncIdentitySource=${rowSyncIdentitySource} syncMessageId=${rowSyncIdentity ?? "missing"} baseSwap=${baseSwapSource} completion=${completionSource} finalStatus=${issueSummary.hasIssues ? "issues" : allGoodCompletion ? "all_good" : "not_checked"}`,
    );
    rows.push({
      clanTag,
      compactCopyLine: `${clanLabel} | ${matchStateEmoji} | ${statusText}`,
      badgeEmojiId: clanBadge.badgeEmojiId,
      badgeEmojiName: clanBadge.badgeEmojiName,
      badgeEmojiInline: clanBadge.badgeEmojiInline,
      matchType,
      warId: activeCurrentWar?.warId ?? null,
      opponentTag: activeCurrentWar?.opponentTag ?? null,
      warStartTimeIso: activeCurrentWar?.startTime ? activeCurrentWar.startTime.toISOString() : null,
      contextKey: activeCurrentWar
        ? buildFwaMatchChecklistRowContextKey({
            clanTag: clan.tag,
            warId: activeCurrentWar.warId ?? null,
            opponentTag: activeCurrentWar.opponentTag ?? null,
          })
        : null,
      detailLines: null,
    });
  }

  const scopeKey = buildBasesScopeKey({
    guildId: params.guildId,
    clanTag: null,
    rows,
  });
  return {
    viewType: "Bases",
    rows,
    scopeKey,
    checkedClanTags: [],
    referenceId: currentSyncIdentity,
    expiresAt: resolveChecklistExpiresAt({
      warTimingCandidates: checklistExpiresAtCandidates,
      fallbackExpiresAt: params.fallbackExpiresAt ?? null,
      nowMs: Date.now(),
      logPrefix: `[fwa checklist state] view=Bases guild=${params.guildId}`,
    }),
    emptyMessage: null,
  };
}

function normalizeBadgeByTag(
  badgeByTag: Map<string, string | null>,
): Map<string, string | null> {
  const normalized = new Map<string, string | null>();
  for (const [tag, badge] of badgeByTag.entries()) {
    normalized.set(normalizeChecklistClanTag(tag), badge ?? null);
  }
  return normalized;
}

function buildRowsFromCopyView(params: {
  orderedTags: string[];
  copyText: string;
  badgeByTag: Map<string, string | null>;
  contextKeyByTag?: Map<string, string | null>;
}): FwaMatchChecklistTrackedRow[] {
  const lines = String(params.copyText ?? "")
    .split(/\r?\n/)
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  const normalizedBadgeByTag = normalizeBadgeByTag(params.badgeByTag);
  return params.orderedTags.flatMap((tag, index) => {
    const compactCopyLine = stripChecklistColumn(lines[index] ?? "");
    const normalizedTag = normalizeChecklistClanTag(tag);
    if (!compactCopyLine) return [];
    const badgeEmojiInline = normalizedBadgeByTag.get(normalizedTag)?.trim() ?? "";
    return [
      {
        clanTag: normalizedTag,
        compactCopyLine,
        badgeEmojiId: badgeEmojiInline
          ? extractEmojiId(badgeEmojiInline)
          : null,
        badgeEmojiName: badgeEmojiInline
          ? extractEmojiName(badgeEmojiInline)
          : null,
        badgeEmojiInline: badgeEmojiInline ?? "",
        contextKey: params.contextKeyByTag?.get(normalizedTag) ?? null,
      },
    ];
  });
}

function extractEmojiId(emoji: string): string | null {
  const match = /^<a?:[A-Za-z0-9_]{2,32}:(\d{1,22})>$/.exec(emoji);
  return match ? match[1] ?? null : null;
}

function extractEmojiName(emoji: string): string | null {
  const match = /^<a?:([A-Za-z0-9_]{2,32}):\d{1,22}>$/.exec(emoji);
  return match ? match[1] ?? null : null;
}

function stripChecklistColumn(line: string): string {
  const normalized = String(line ?? "").trim();
  if (!normalized) return normalized;
  const firstSeparator = normalized.indexOf(" | ");
  if (firstSeparator < 0) return normalized;
  const secondSeparator = normalized.indexOf(" | ", firstSeparator + 3);
  if (secondSeparator < 0) return normalized;
  const thirdSeparator = normalized.indexOf(" | ", secondSeparator + 3);
  if (thirdSeparator < 0) return normalized;
  const checklistValue = normalized
    .slice(secondSeparator + 3, thirdSeparator)
    .trim();
  if (checklistValue !== "✅" && checklistValue !== "☐") {
    return normalized;
  }
  return `${normalized.slice(0, secondSeparator + 3)}${normalized.slice(thirdSeparator + 3)}`;
}

/** Purpose: build the checklist render state from the current live/current-war snapshot. */
export async function buildFwaMatchChecklistRenderStateForGuild(params: {
  cocService: CoCService;
  guildId: string;
  client: Client;
  warLookupCache?: Map<string, Promise<any> | any>;
  viewType?: FwaMatchChecklistViewType;
  syncMessageId?: string | null;
  fallbackExpiresAt?: Date | null;
}): Promise<FwaMatchChecklistRenderState> {
  if ((params.viewType ?? "Mail") === "Bases") {
    return buildFwaMatchBasesRenderStateForGuild({
      guildId: params.guildId,
      client: params.client,
      syncMessageId: params.syncMessageId ?? null,
      fallbackExpiresAt: params.fallbackExpiresAt ?? null,
    });
  }
  const latestActiveSyncPost = await trackedMessageService
    .resolveLatestActiveSyncPost(params.guildId)
    .catch(() => null);
  const currentSyncIdentity = resolveTrackedMessageSyncIdentity(latestActiveSyncPost);
  const trackedClans = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, clanBadge: true, name: true, shortName: true },
  });
  if (trackedClans.length === 0) {
    return {
      viewType: "Mail",
      rows: [],
      scopeKey: buildFwaMatchChecklistScopeKey({
        guildId: params.guildId,
        clanTag: null,
        rows: [],
      }),
      checkedClanTags: [],
      referenceId: currentSyncIdentity,
      expiresAt: buildFallbackChecklistExpiresAt({
        nowMs: Date.now(),
        fallbackExpiresAt: params.fallbackExpiresAt ?? null,
      }),
      emptyMessage: "No tracked clans configured. Use `/clan configure` first.",
    };
  }

  const currentWars = await prisma.currentWar.findMany({
    where: { guildId: params.guildId },
    select: {
      clanTag: true,
      warId: true,
      prepStartTime: true,
      startTime: true,
      endTime: true,
      opponentTag: true,
      matchType: true,
      inferredMatchType: true,
      outcome: true,
      state: true,
    },
  });
  const currentWarByTag = new Map(
    currentWars.map((row) => [normalizeChecklistClanTag(row.clanTag), row]),
  );
  const warMailLifecycleService = new WarMailLifecycleService();
  const singleViews: Record<string, FwaMatchChecklistSingleView> = {};
  const copyLines: string[] = [];
  const checklistExpiresAtCandidates: ChecklistExpiryCandidate[] = [];

  for (const clan of trackedClans) {
    const clanTag = normalizeChecklistClanTag(clan.tag);
    const currentWar = currentWarByTag.get(clanTag) ?? null;
    const liveWar = await getCurrentWarCached(
      params.cocService,
      clanTag,
      params.warLookupCache,
    ).catch(() => null);
    const liveOpponentTag = normalizeChecklistClanTag(
      String(liveWar?.opponent?.tag ?? currentWar?.opponentTag ?? ""),
    );
    const liveOpponentName =
      sanitizeClanName(String(liveWar?.opponent?.name ?? "")) ?? "Unknown Opponent";
    const clanName = sanitizeClanName(clan.name) ?? `#${clanTag}`;
    const warId = currentWar?.warId ?? null;
    const liveWarStartMs = parseCocApiTime(liveWar?.startTime ?? null);
    const warStartTime =
      currentWar?.startTime ??
      (liveWarStartMs !== null ? new Date(liveWarStartMs) : null);
    const shouldResolveMailStatus = isFreshMailChecklistWarIdentity({
      currentWar: currentWar
        ? {
            state: currentWar.state ?? null,
            startTime: currentWar.startTime ?? null,
            opponentTag: currentWar.opponentTag ?? null,
          }
        : null,
      liveWar: liveWar
        ? {
            state: liveWar.state ?? null,
            startTime: liveWar.startTime ?? null,
            opponent: liveWar.opponent ?? null,
          }
        : null,
    });
    checklistExpiresAtCandidates.push(
      ...buildChecklistWarTimingCandidates({
        prepStartTime: currentWar?.prepStartTime ?? null,
        startTime: warStartTime,
        endTime: currentWar?.endTime ?? null,
      }),
    );
    const mailStatus = shouldResolveMailStatus
      ? await warMailLifecycleService.resolveStatusForCurrentWar({
          client: params.client,
          guildId: params.guildId,
          clanTag,
          warId,
          warStartTime,
          opponentTag: liveOpponentTag || currentWar?.opponentTag || null,
          sentEmoji: MAILBOX_SENT_EMOJI,
          unsentEmoji: MAILBOX_NOT_SENT_EMOJI,
        })
      : {
          status: "not_posted" as const,
          mailStatusEmoji: MAILBOX_NOT_SENT_EMOJI,
          debug: null,
        };
    const matchType = normalizeMatchType(currentWar?.matchType ?? null);
    const outcome = normalizeOutcome(currentWar?.outcome ?? null);
    const effectiveOutcome = matchType === "FWA" ? outcome ?? "UNKNOWN" : outcome;
    const compactCopyLine = buildFwaMatchCompactCopyLine({
      mailStatusEmoji: mailStatus.mailStatusEmoji,
      checklist: true,
      clanShortName: clan.shortName,
      clanName,
      opponentName: liveOpponentName,
      opponentTag: liveOpponentTag || currentWar?.opponentTag || null,
      matchType,
      outcome: effectiveOutcome,
    });
    singleViews[clanTag] = {
      liveRevisionFields: {
        warId,
        opponentTag: liveOpponentTag || currentWar?.opponentTag || null,
      },
    };
    copyLines.push(compactCopyLine);
  }

  const rows = buildRowsFromCopyView({
    orderedTags: Object.keys(singleViews),
    copyText: copyLines.join("\n"),
    badgeByTag: new Map(
      trackedClans.map((row) => [normalizeChecklistClanTag(row.tag), row.clanBadge ?? null]),
    ),
    contextKeyByTag: buildChecklistContextKeyByTag(singleViews),
  });
  const scopeKey = buildFwaMatchChecklistScopeKey({
    guildId: params.guildId,
    clanTag: null,
    rows,
  });
  const checkedClanTags = await findLatestFwaMatchChecklistCheckedClanTags({
    guildId: params.guildId,
    clanTag: null,
    scopeKey,
    syncMessageId: currentSyncIdentity,
  });
  return {
    viewType: "Mail",
    rows,
    scopeKey,
    checkedClanTags,
    referenceId: currentSyncIdentity,
    expiresAt: resolveChecklistExpiresAt({
      warTimingCandidates: checklistExpiresAtCandidates,
      fallbackExpiresAt: params.fallbackExpiresAt ?? null,
      nowMs: Date.now(),
      logPrefix: `[fwa checklist state] view=Mail guild=${params.guildId}`,
    }),
    emptyMessage: null,
  };
}
