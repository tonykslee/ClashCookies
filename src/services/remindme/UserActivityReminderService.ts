import {
  UserActivityReminderMethod,
  UserActivityReminderType,
} from "@prisma/client";
import { prisma } from "../../prisma";
import {
  listPlayerLinksForDiscordUser,
  normalizePlayerTag,
  type DiscordUserPlayerLink,
} from "../PlayerLinkService";

const MAX_OFFSET_MINUTES_BY_TYPE: Record<UserActivityReminderType, number> = {
  WAR: 24 * 60,
  CWL: 24 * 60,
  RAIDS: 72 * 60,
  GAMES: 6 * 24 * 60,
};

export type ParsedReminderOffsetMinutesInput = {
  normalizedMinutes: number[];
  invalidTokens: string[];
  outOfWindowTokens: string[];
};

export type UserActivityReminderRuleGroup = {
  key: string;
  type: UserActivityReminderType;
  playerTag: string;
  playerName: string | null;
  method: UserActivityReminderMethod;
  offsetMinutes: number[];
  ruleIds: string[];
  surfaceGuildId: string | null;
  surfaceChannelId: string | null;
};

export type CreateUserActivityReminderRulesResult = {
  linkedTags: string[];
  rejectedNonLinkedTags: string[];
  createdRuleCount: number;
  existingRuleCount: number;
  groups: UserActivityReminderRuleGroup[];
};

/** Purpose: parse one `HhMm` token into positive minutes or null. */
export function parseReminderOffsetTokenToMinutes(input: string): number | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!normalized) return null;
  const match = normalized.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match) return null;
  const hasHours = match[1] !== undefined;
  const hasMinutes = match[2] !== undefined;
  if (!hasHours && !hasMinutes) return null;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const totalMinutes = Math.trunc(hours * 60 + minutes);
  if (totalMinutes <= 0) return null;
  return totalMinutes;
}

/** Purpose: parse comma/space-separated offsets and enforce per-type window bounds. */
export function parseReminderOffsetMinutesInput(input: {
  rawOffsets: string;
  type: UserActivityReminderType;
}): ParsedReminderOffsetMinutesInput {
  const tokens = String(input.rawOffsets ?? "")
    .split(/[;,\n]+/g)
    .flatMap((part) => part.split(/\s+/g))
    .map((part) => part.trim())
    .filter(Boolean);

  const invalidTokens: string[] = [];
  const outOfWindowTokens: string[] = [];
  const normalized = new Set<number>();
  const maxMinutes = MAX_OFFSET_MINUTES_BY_TYPE[input.type];

  for (const token of tokens) {
    const parsed = parseReminderOffsetTokenToMinutes(token);
    if (!parsed) {
      invalidTokens.push(token);
      continue;
    }
    if (parsed <= 0 || parsed > maxMinutes) {
      outOfWindowTokens.push(token);
      continue;
    }
    normalized.add(parsed);
  }

  return {
    normalizedMinutes: [...normalized].sort((a, b) => a - b),
    invalidTokens: [...new Set(invalidTokens)],
    outOfWindowTokens: [...new Set(outOfWindowTokens)],
  };
}

/** Purpose: parse free-form player tag input into normalized deterministic unique tags. */
export function parsePlayerTagsInput(rawTags: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  const tokens = String(rawTags ?? "")
    .split(/[\s,;\n]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const tag = normalizePlayerTag(token);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

/** Purpose: render offset minutes in compact `HhMm` form for command responses. */
export function formatOffsetMinutes(offsetMinutes: number): string {
  const safe = Math.max(0, Math.trunc(Number(offsetMinutes) || 0));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}

/** Purpose: expose per-type maximum offset minutes for validation messaging. */
export function getReminderMaxOffsetMinutes(type: UserActivityReminderType): number {
  return MAX_OFFSET_MINUTES_BY_TYPE[type];
}

/** Purpose: create one persisted reminder rule per `(tag, offset)` for linked tags only. */
export async function createUserActivityReminderRules(input: {
  discordUserId: string;
  type: UserActivityReminderType;
  rawPlayerTags: string;
  rawOffsets: string;
  method: UserActivityReminderMethod;
  surfaceGuildId: string | null;
  surfaceChannelId: string | null;
}): Promise<
  | { outcome: "invalid_offsets"; parsed: ParsedReminderOffsetMinutesInput }
  | {
      outcome: "no_linked_tags";
      parsed: ParsedReminderOffsetMinutesInput;
      requestedTags: string[];
    }
  | {
      outcome: "non_linked_tags";
      parsed: ParsedReminderOffsetMinutesInput;
      linkedTags: string[];
      rejectedNonLinkedTags: string[];
    }
  | {
      outcome: "ok";
      parsed: ParsedReminderOffsetMinutesInput;
      result: CreateUserActivityReminderRulesResult;
    }
> {
  const parsedOffsets = parseReminderOffsetMinutesInput({
    rawOffsets: input.rawOffsets,
    type: input.type,
  });
  if (parsedOffsets.normalizedMinutes.length <= 0) {
    return { outcome: "invalid_offsets", parsed: parsedOffsets };
  }

  const requestedTags = parsePlayerTagsInput(input.rawPlayerTags);
  if (requestedTags.length <= 0) {
    return {
      outcome: "non_linked_tags",
      parsed: parsedOffsets,
      linkedTags: [],
      rejectedNonLinkedTags: [],
    };
  }

  const linkedRows = await listPlayerLinksForDiscordUser({
    discordUserId: input.discordUserId,
  });
  const linkedTagSet = new Set(linkedRows.map((row) => row.playerTag));
  if (linkedTagSet.size <= 0) {
    return {
      outcome: "no_linked_tags",
      parsed: parsedOffsets,
      requestedTags,
    };
  }

  const linkedTags = requestedTags.filter((tag) => linkedTagSet.has(tag));
  const rejectedNonLinkedTags = requestedTags.filter((tag) => !linkedTagSet.has(tag));
  if (linkedTags.length <= 0 || rejectedNonLinkedTags.length > 0) {
    return {
      outcome: "non_linked_tags",
      parsed: parsedOffsets,
      linkedTags,
      rejectedNonLinkedTags,
    };
  }

  const existingRows = await prisma.userActivityReminderRule.findMany({
    where: {
      discordUserId: input.discordUserId,
      type: input.type,
      method: input.method,
      playerTag: { in: linkedTags },
      offsetMinutes: { in: parsedOffsets.normalizedMinutes },
    },
    select: {
      playerTag: true,
      offsetMinutes: true,
    },
  });
  const existingKeySet = new Set(
    existingRows.map((row) => `${row.playerTag}|${row.offsetMinutes}`),
  );

  const toCreate = linkedTags.flatMap((playerTag) =>
    parsedOffsets.normalizedMinutes
      .filter((offsetMinutes) => !existingKeySet.has(`${playerTag}|${offsetMinutes}`))
      .map((offsetMinutes) => ({
        discordUserId: input.discordUserId,
        type: input.type,
        playerTag,
        method: input.method,
        offsetMinutes,
        isActive: true,
        surfaceGuildId: input.method === UserActivityReminderMethod.PING_HERE ? input.surfaceGuildId : null,
        surfaceChannelId:
          input.method === UserActivityReminderMethod.PING_HERE ? input.surfaceChannelId : null,
      })),
  );

  if (toCreate.length > 0) {
    await prisma.userActivityReminderRule.createMany({
      data: toCreate,
      skipDuplicates: true,
    });
  }

  const groups = await listUserActivityReminderRuleGroups({
    discordUserId: input.discordUserId,
  });
  const touchedGroupKeys = new Set(
    linkedTags.map((tag) => `${input.type}|${tag}|${input.method}`),
  );
  const touchedGroups = groups.filter((group) => touchedGroupKeys.has(group.key));

  return {
    outcome: "ok",
    parsed: parsedOffsets,
    result: {
      linkedTags,
      rejectedNonLinkedTags,
      createdRuleCount: toCreate.length,
      existingRuleCount: existingRows.length,
      groups: touchedGroups,
    },
  };
}

/** Purpose: list active reminder rules grouped for deterministic embed rendering/removal UX. */
export async function listUserActivityReminderRuleGroups(input: {
  discordUserId: string;
}): Promise<UserActivityReminderRuleGroup[]> {
  const [rules, linkedRows] = await Promise.all([
    prisma.userActivityReminderRule.findMany({
      where: {
        discordUserId: input.discordUserId,
        isActive: true,
      },
      orderBy: [
        { type: "asc" },
        { playerTag: "asc" },
        { method: "asc" },
        { offsetMinutes: "asc" },
      ],
    }),
    listPlayerLinksForDiscordUser({ discordUserId: input.discordUserId }),
  ]);

  const linkedNameByTag = new Map<string, string | null>(
    linkedRows.map((row) => [row.playerTag, sanitizeDisplayText(row.linkedName)]),
  );

  const grouped = new Map<string, UserActivityReminderRuleGroup>();
  for (const rule of rules) {
    const key = `${rule.type}|${rule.playerTag}|${rule.method}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        key,
        type: rule.type,
        playerTag: rule.playerTag,
        playerName: linkedNameByTag.get(rule.playerTag) ?? null,
        method: rule.method,
        offsetMinutes: [rule.offsetMinutes],
        ruleIds: [rule.id],
        surfaceGuildId: rule.surfaceGuildId ?? null,
        surfaceChannelId: rule.surfaceChannelId ?? null,
      });
      continue;
    }
    existing.offsetMinutes.push(rule.offsetMinutes);
    existing.ruleIds.push(rule.id);
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      offsetMinutes: [...new Set(group.offsetMinutes)].sort((a, b) => a - b),
      ruleIds: [...new Set(group.ruleIds)],
    }))
    .sort((a, b) => {
      const typeSort = a.type.localeCompare(b.type);
      if (typeSort !== 0) return typeSort;
      const aName = (a.playerName ?? "").toLowerCase();
      const bName = (b.playerName ?? "").toLowerCase();
      if (aName !== bName) return aName.localeCompare(bName);
      const tagSort = a.playerTag.localeCompare(b.playerTag);
      if (tagSort !== 0) return tagSort;
      return a.method.localeCompare(b.method);
    });
}

/** Purpose: remove selected reminder rules owned by one invoking Discord user. */
export async function removeUserActivityReminderRulesByIds(input: {
  discordUserId: string;
  ruleIds: string[];
}): Promise<number> {
  const uniqueRuleIds = [...new Set(input.ruleIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (uniqueRuleIds.length <= 0) return 0;
  const deleted = await prisma.userActivityReminderRule.deleteMany({
    where: {
      id: { in: uniqueRuleIds },
      discordUserId: input.discordUserId,
    },
  });
  return deleted.count;
}

/** Purpose: resolve linked player-tag options for `/remindme set` autocomplete in stable order. */
export async function listLinkedPlayerTagOptionsForRemindme(input: {
  discordUserId: string;
  query: string;
  limit?: number;
}): Promise<Array<{ name: string; value: string }>> {
  const rows = await listPlayerLinksForDiscordUser({ discordUserId: input.discordUserId });
  const query = String(input.query ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(25, Math.trunc(Number(input.limit) || 25)));

  const prefixMatch = rows.filter((row) => {
    const label = `${row.linkedName ?? ""} ${row.playerTag}`.toLowerCase();
    return label.includes(query);
  });

  return prefixMatch.slice(0, limit).map((row) => ({
    name: buildLinkedTagChoiceLabel(row),
    value: row.playerTag,
  }));
}

/** Purpose: build one stable linked-tag autocomplete label bounded for Discord choices. */
function buildLinkedTagChoiceLabel(row: DiscordUserPlayerLink): string {
  const linkedName = sanitizeDisplayText(row.linkedName);
  if (!linkedName || linkedName === row.playerTag) {
    return row.playerTag.slice(0, 100);
  }
  return `${linkedName} (${row.playerTag})`.slice(0, 100);
}

/** Purpose: normalize optional display text into compact deterministic strings. */
function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}
