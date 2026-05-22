import { Client } from "discord.js";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { normalizeClanTag } from "./PlayerLinkService";
import { sanitizeClanName, parseCocApiTime } from "../commands/fwa/dataParsers";
import {
  buildFwaMatchChecklistRowContextKey,
  buildFwaMatchChecklistScopeKey,
  findLatestFwaMatchChecklistCheckedClanTags,
  type FwaMatchChecklistTrackedRow,
  trackedMessageService,
  buildFwaMatchCompactCopyLine,
} from "./TrackedMessageService";
import { WarMailLifecycleService } from "./WarMailLifecycleService";
import { formatError } from "../helper/formatError";

type FwaMatchChecklistSingleView = {
  liveRevisionFields?: {
    warId?: string | number | null;
    opponentTag?: string | null;
  } | null;
};

export type FwaMatchChecklistRenderState = {
  rows: FwaMatchChecklistTrackedRow[];
  scopeKey: string;
  checkedClanTags: string[];
  referenceId: string | null;
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
      rows: [],
      scopeKey: buildFwaMatchChecklistScopeKey({
        guildId: params.guildId,
        clanTag: null,
        rows: [],
      }),
      checkedClanTags: [],
      referenceId: latestActiveSyncPost?.messageId ?? null,
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
    rows,
    scopeKey,
    checkedClanTags,
    referenceId: latestActiveSyncPost?.messageId ?? null,
    emptyMessage: null,
  };
}
