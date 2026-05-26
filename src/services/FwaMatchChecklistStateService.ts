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
} from "./TrackedMessageService";
import { resolveFwaMatchStateEmoji } from "./FwaMatchStateEmojiService";
import { WarMailLifecycleService } from "./WarMailLifecycleService";
import { formatError } from "../helper/formatError";

type FwaMatchChecklistViewType = "Mail" | "Bases";

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

function buildFallbackChecklistExpiresAt(nowMs: number = Date.now()): Date {
  return new Date(nowMs + 30 * 60 * 1000);
}

function resolveChecklistExpiresAt(params: {
  warStartTimes: Array<Date | null | undefined>;
  nowMs?: number;
}): Date {
  const latestWarStartMs = params.warStartTimes
    .map((time) => (time instanceof Date && Number.isFinite(time.getTime()) ? time.getTime() : null))
    .filter((time): time is number => time !== null)
    .reduce<number | null>((latest, current) => {
      if (latest === null) return current;
      return current > latest ? current : latest;
    }, null);
  if (latestWarStartMs !== null) {
    return new Date(latestWarStartMs);
  }
  return buildFallbackChecklistExpiresAt(params.nowMs);
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
}): Promise<FwaMatchChecklistRenderState> {
  const latestActiveSyncPost = await trackedMessageService
    .resolveLatestActiveSyncPost(params.guildId)
    .catch(() => null);
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
      referenceId: latestActiveSyncPost?.messageId ?? null,
      expiresAt: buildFallbackChecklistExpiresAt(),
      emptyMessage: "No tracked clans configured. Use `/clan configure` first.",
    };
  }

  const currentWars = await prisma.currentWar.findMany({
    where: { guildId: params.guildId },
    select: {
      clanTag: true,
      warId: true,
      startTime: true,
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
  const checklistExpiresAtCandidates: Array<Date | null> = [];

  for (const clan of trackedClans) {
    const clanTag = normalizeChecklistClanTag(clan.tag);
    const currentWar = currentWarByTag.get(clanTag) ?? null;
    const activeCurrentWar =
      currentWar && String(currentWar.state ?? "").trim().toLowerCase() !== "notinwar"
        ? currentWar
        : null;
    checklistExpiresAtCandidates.push(activeCurrentWar?.startTime ?? null);
    const activeBaseSwap = await trackedMessageService
      .findLatestActiveFwaBaseSwapTrackedMessageForClan({
        guildId: params.guildId,
        clanTag,
      })
      .catch(() => null);
    const issueSummary = activeBaseSwap
      ? buildFwaBaseSwapIssueSummary(activeBaseSwap.metadata)
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
    const allGoodCompletion = issueSummary.hasIssues
      ? null
      : await trackedMessageService
          .findLatestFwaMatchChecklistBasesCompletionForClan({
            guildId: params.guildId,
            clanTag,
            warId: activeCurrentWar?.warId ?? null,
            warStartTime: activeCurrentWar?.startTime ?? null,
            opponentTag: activeCurrentWar?.opponentTag ?? null,
          })
          .catch(() => null);
    const statusText = issueSummary.hasIssues
      ? issueSummary.statusText
      : allGoodCompletion
        ? "✅ Bases checked and all good"
        : "❌ Bases not checked";
    rows.push({
      clanTag,
      compactCopyLine: `${clanLabel} | ${matchStateEmoji} | ${statusText}`,
      badgeEmojiId: clanBadge.badgeEmojiId,
      badgeEmojiName: clanBadge.badgeEmojiName,
      badgeEmojiInline: clanBadge.badgeEmojiInline,
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
      detailLines: issueSummary.detailLines.length > 0 ? issueSummary.detailLines : null,
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
    referenceId: latestActiveSyncPost?.messageId ?? null,
    expiresAt: resolveChecklistExpiresAt({
      warStartTimes: checklistExpiresAtCandidates,
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
}): Promise<FwaMatchChecklistRenderState> {
  if ((params.viewType ?? "Mail") === "Bases") {
    return buildFwaMatchBasesRenderStateForGuild({
      guildId: params.guildId,
      client: params.client,
    });
  }
  const latestActiveSyncPost = await trackedMessageService
    .resolveLatestActiveSyncPost(params.guildId)
    .catch(() => null);
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
      referenceId: latestActiveSyncPost?.messageId ?? null,
      expiresAt: buildFallbackChecklistExpiresAt(),
      emptyMessage: "No tracked clans configured. Use `/clan configure` first.",
    };
  }

  const currentWars = await prisma.currentWar.findMany({
    where: { guildId: params.guildId },
    select: {
      clanTag: true,
      warId: true,
      startTime: true,
      opponentTag: true,
      matchType: true,
      inferredMatchType: true,
      outcome: true,
    },
  });
  const currentWarByTag = new Map(
    currentWars.map((row) => [normalizeChecklistClanTag(row.clanTag), row]),
  );
  const warMailLifecycleService = new WarMailLifecycleService();
  const singleViews: Record<string, FwaMatchChecklistSingleView> = {};
  const copyLines: string[] = [];
  const checklistExpiresAtCandidates: Array<Date | null> = [];

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
    checklistExpiresAtCandidates.push(warStartTime);
    const mailStatus = await warMailLifecycleService.resolveStatusForCurrentWar({
      client: params.client,
      guildId: params.guildId,
      clanTag,
      warId,
      warStartTime,
      opponentTag: liveOpponentTag || currentWar?.opponentTag || null,
      sentEmoji: MAILBOX_SENT_EMOJI,
      unsentEmoji: MAILBOX_NOT_SENT_EMOJI,
    });
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
  });
  return {
    viewType: "Mail",
    rows,
    scopeKey,
    checkedClanTags,
    referenceId: latestActiveSyncPost?.messageId ?? null,
    expiresAt: resolveChecklistExpiresAt({
      warStartTimes: checklistExpiresAtCandidates,
    }),
    emptyMessage: null,
  };
}
