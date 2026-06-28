import { prisma } from "../../prisma";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  parseFwaBaseSwapMetadata,
  type FwaBaseSwapTrackedMetadata,
} from "../TrackedMessageService";
import { normalizeClanTag } from "../PlayerLinkService";
import { isTodoWarStateActive } from "../TodoTrackedWarStateService";

export const BASE_SWAP_DM_REMINDER_OFFSETS_HOURS = [12, 6, 3, 1] as const;
const BASE_SWAP_DM_REMINDER_SECTION_ORDER = [
  "war_bases",
  "fwa_bases",
  "base_errors",
] as const;
type FwaBaseSwapDmReminderSection =
  (typeof BASE_SWAP_DM_REMINDER_SECTION_ORDER)[number];

const BASE_SWAP_DM_REMINDER_HOUR_MS = 60 * 60 * 1000;

export type FwaBaseSwapDmReminderEntry = {
  position: number;
  playerTag: string;
  playerName: string;
  section: FwaBaseSwapDmReminderSection;
};

/** Purpose: decide whether a tracked base-swap post should produce affected-player DM reminders. */
export function isBaseSwapAffectedPlayerDmReminderEnabled(
  metadata: Pick<FwaBaseSwapTrackedMetadata, "clanKind" | "swapReminder"> | null | undefined,
): boolean {
  if (!metadata) return false;
  const clanKind = String(metadata.clanKind ?? "").trim().toUpperCase();
  if (clanKind === "CWL") {
    return metadata.swapReminder === true;
  }
  return true;
}

export type FwaBaseSwapDmReminderCandidate = {
  guildId: string;
  clanTag: string;
  clanName: string | null;
  matchType: string | null;
  trackedMessageId: string;
  referenceId: string | null;
  channelId: string;
  messageId: string;
  postUrl: string;
  discordUserId: string;
  battleDayStart: Date;
  dueOffsetHours: number;
  remainingOffsetHours: number[];
  entries: FwaBaseSwapDmReminderEntry[];
};

type TrackedMessageRow = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  referenceId: string | null;
  clanTag: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  metadata: unknown;
};

type ParsedTrackedMessageRow = TrackedMessageRow & {
  clanTag: string;
  metadata: FwaBaseSwapTrackedMetadata;
  entries: ReminderEntry[];
};

type CurrentWarRow = {
  clanTag: string;
  startTime: Date | null;
  state: string | null;
  matchType: string | null;
};

type ReminderEntry = {
  position: number;
  playerTag: string;
  playerName: string;
  section: FwaBaseSwapDmReminderSection;
  discordUserId: string;
};

/** Purpose: keep base-swap DM reminder planning pure and DB-first without sending anything. */
export function buildFwaBaseSwapDmReminderClaimKey(input: {
  trackedMessageId: string;
  referenceId?: string | null;
  discordUserId: string;
  offsetHours: number;
}): string {
  const scopeId = String(input.referenceId ?? input.trackedMessageId ?? "").trim();
  const discordUserId = String(input.discordUserId ?? "").trim();
  const offsetHours = normalizeOffsetHours(input.offsetHours);
  return [
    "fwa-base-swap-dm-reminder",
    scopeId,
    discordUserId,
    `offset=${offsetHours}`,
  ].join(":");
}

/** Purpose: build the Discord post URL for a tracked base-swap message without fetching Discord state. */
export function buildFwaBaseSwapReminderPostUrl(input: {
  guildId: string;
  channelId: string;
  messageId: string;
}): string {
  const guildId = String(input.guildId ?? "").trim();
  const channelId = String(input.channelId ?? "").trim();
  const messageId = String(input.messageId ?? "").trim();
  if (!guildId || !channelId || !messageId) return "";
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Purpose: resolve which reminder slots are already due without crossing the battle-day boundary. */
export function resolveDueFwaBaseSwapDmReminderSlots(input: {
  now: Date;
  battleDayStart: Date | null | undefined;
  offsets?: readonly number[];
}): number[] {
  const offsets = normalizeOffsets(input.offsets);
  const battleDayStartMs = normalizeDateMs(input.battleDayStart);
  const nowMs = normalizeDateMs(input.now);
  if (battleDayStartMs === null || nowMs === null) return [];
  if (nowMs >= battleDayStartMs) return [];

  return offsets.filter((offsetHours) => {
    const dueAtMs = battleDayStartMs - offsetHours * BASE_SWAP_DM_REMINDER_HOUR_MS;
    return nowMs >= dueAtMs;
  });
}

/** Purpose: resolve which reminder slots remain after the current due slot for message copy. */
export function resolveRemainingFwaBaseSwapDmReminderSlots(input: {
  now: Date;
  battleDayStart: Date | null | undefined;
  offsets?: readonly number[];
}): number[] {
  const offsets = normalizeOffsets(input.offsets);
  const battleDayStartMs = normalizeDateMs(input.battleDayStart);
  const nowMs = normalizeDateMs(input.now);
  if (battleDayStartMs === null || nowMs === null) return [];
  if (nowMs >= battleDayStartMs) return [];

  return offsets.filter((offsetHours) => {
    const dueAtMs = battleDayStartMs - offsetHours * BASE_SWAP_DM_REMINDER_HOUR_MS;
    return nowMs < dueAtMs;
  });
}

/** Purpose: render one deterministic base-swap DM reminder message for a due slot. */
export function buildFwaBaseSwapDmReminderContent(input: {
  postUrl: string;
  battleDayStart: Date;
  now?: Date;
  remainingOffsetHours: readonly number[];
  matchType?: string | null;
  entries: readonly FwaBaseSwapDmReminderEntry[];
}): string {
  const now = input.now ?? new Date();
  const battleDayStartMs = normalizeDateMs(input.battleDayStart);
  const nowMs = normalizeDateMs(now);
  const timeLeftLabel =
    battleDayStartMs !== null && nowMs !== null
      ? formatCompactDurationLabel(battleDayStartMs - nowMs)
      : "unknown time";
  const remainingSlotsLabel = formatReminderSlotList(input.remainingOffsetHours);
  const groupedEntries = groupReminderEntriesBySection(input.entries);
  const lines: string[] = [
    "# Base swap reminder",
    `Since you have not yet reacted to the base-swap post ${input.postUrl}, you are getting pinged for:`,
  ];

  for (const section of BASE_SWAP_DM_REMINDER_SECTION_ORDER) {
    const sectionEntries = groupedEntries.get(section) ?? [];
    if (sectionEntries.length === 0) continue;
    const sectionCopy = resolveFwaBaseSwapReminderSectionCopy({
      section,
      matchType: input.matchType ?? null,
    });
    lines.push("");
    lines.push(`## ${sectionCopy.heading}`);
    lines.push(sectionCopy.description);
    lines.push(
      ...sectionEntries.map((entry) => `- #${entry.position} ${entry.playerName}`),
    );
  }

  lines.push("");
  lines.push(`## You have ${timeLeftLabel} until battle day starts`);
  lines.push(
    input.remainingOffsetHours.length > 0
      ? `You will get pinged at the ${remainingSlotsLabel} mark until you react to the base-swap post ${input.postUrl}`
      : `You will not get pinged again before battle day unless you react to the base-swap post ${input.postUrl}`,
  );

  return lines.join("\n");
}

export const buildFwaBaseSwapDmReminderContentForTest =
  buildFwaBaseSwapDmReminderContent;

/** Purpose: load pending base-swap reminder candidates from persisted tracked-message state only. */
export async function findPendingFwaBaseSwapDmReminderCandidates(input: {
  guildId: string;
  now?: Date;
}): Promise<FwaBaseSwapDmReminderCandidate[]> {
  const guildId = String(input.guildId ?? "").trim();
  const now = input.now ?? new Date();
  if (!guildId) return [];

  const trackedRows = await prisma.trackedMessage.findMany({
    where: {
      guildId,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      expiresAt: { gt: now },
    },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      guildId: true,
      channelId: true,
      messageId: true,
      referenceId: true,
      clanTag: true,
      createdAt: true,
      expiresAt: true,
      metadata: true,
    },
  });

  const parsedRows = trackedRows
    .map((row) => {
      const metadata = parseFwaBaseSwapMetadata(row.metadata);
      if (!metadata) return null;
      if (!isBaseSwapAffectedPlayerDmReminderEnabled(metadata)) return null;
      const clanTag = normalizeClanTag(String(row.clanTag ?? ""));
      if (!clanTag) return null;
      const qualifiedEntries = dedupeReminderEntries(
        metadata.entries
          .filter(
            (entry) =>
              isBaseSwapReminderSection(entry.section) &&
              Boolean(String(entry.discordUserId ?? "").trim()) &&
              entry.acknowledged !== true,
          )
          .map((entry) => ({
            position: entry.position,
            playerTag: entry.playerTag,
            playerName: entry.playerName,
            section: entry.section,
            discordUserId: String(entry.discordUserId ?? "").trim(),
          })),
      );
      if (qualifiedEntries.length === 0) return null;
      return {
        id: row.id,
        guildId: row.guildId,
        channelId: row.channelId,
        messageId: row.messageId,
        referenceId: row.referenceId ? String(row.referenceId).trim() || null : null,
        clanTag,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt ?? null,
        metadata,
        entries: qualifiedEntries.map((entry) => ({
          position: entry.position,
          playerTag: entry.playerTag,
          playerName: entry.playerName,
          section: entry.section,
          discordUserId: String(entry.discordUserId ?? "").trim(),
        })),
      };
    })
    .filter((row): row is ParsedTrackedMessageRow => Boolean(row));

  if (parsedRows.length === 0) return [];

  const activeClanTags = [...new Set(parsedRows.map((row) => row.clanTag))];
  const currentWarRows = activeClanTags.length > 0
    ? await prisma.currentWar.findMany({
        where: {
          guildId,
          clanTag: { in: activeClanTags },
        },
        select: {
          clanTag: true,
          startTime: true,
          state: true,
          matchType: true,
        },
      })
    : [];
  const activeCurrentWarByClanTag = new Map<string, CurrentWarRow>();
  for (const row of currentWarRows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;
    if (!isTodoWarStateActive(row.state)) continue;
    if (!(row.startTime instanceof Date)) continue;
    activeCurrentWarByClanTag.set(clanTag, {
      clanTag,
      startTime: row.startTime,
      state: row.state ?? null,
      matchType: row.matchType ?? null,
    });
  }
  const groupedByScope = new Map<
    string,
    {
      trackedRows: typeof parsedRows;
      canonicalRow: (typeof parsedRows)[number];
      activeCurrentWar: CurrentWarRow | null;
    }
  >();
  for (const row of parsedRows) {
    const scopeKey = row.referenceId ?? row.id;
    const existing = groupedByScope.get(scopeKey);
    if (!existing) {
      groupedByScope.set(scopeKey, {
        trackedRows: [row],
        canonicalRow: row,
        activeCurrentWar: activeCurrentWarByClanTag.get(row.clanTag) ?? null,
      });
      continue;
    }
    existing.trackedRows.push(row);
    if (row.createdAt > existing.canonicalRow.createdAt) {
      existing.canonicalRow = row;
      existing.activeCurrentWar = activeCurrentWarByClanTag.get(row.clanTag) ?? null;
    }
  }

  const candidates: FwaBaseSwapDmReminderCandidate[] = [];
  for (const group of groupedByScope.values()) {
    const battleDayStart = group.activeCurrentWar?.startTime ?? null;
    const dueOffsets = resolveDueFwaBaseSwapDmReminderSlots({
      now,
      battleDayStart,
      offsets: BASE_SWAP_DM_REMINDER_OFFSETS_HOURS,
    });
    if (dueOffsets.length === 0) continue;
    const dueOffsetHours = dueOffsets[dueOffsets.length - 1] ?? null;
    if (dueOffsetHours === null) continue;
    const remainingOffsets = resolveRemainingFwaBaseSwapDmReminderSlots({
      now,
      battleDayStart,
      offsets: BASE_SWAP_DM_REMINDER_OFFSETS_HOURS,
    });
    const postUrl = buildFwaBaseSwapReminderPostUrl({
      guildId: group.canonicalRow.guildId,
      channelId: group.canonicalRow.channelId,
      messageId: group.canonicalRow.messageId,
    });
    if (!postUrl) continue;

    const entriesByUser = group.trackedRows.reduce(
      (acc, row) => {
        for (const entry of row.entries) {
          const discordUserId = String(entry.discordUserId ?? "").trim();
          if (!discordUserId) continue;
          const userEntries = acc.get(discordUserId) ?? [];
          userEntries.push({
            position: normalizeReminderPosition(entry.position),
            playerTag: String(entry.playerTag ?? "").trim(),
            playerName: String(entry.playerName ?? "").trim(),
            section: normalizeReminderSection(entry.section) ?? "war_bases",
            discordUserId,
          });
          acc.set(discordUserId, userEntries);
        }
        return acc;
      },
      new Map<string, ReminderEntry[]>(),
    );

    for (const [discordUserId, entries] of entriesByUser.entries()) {
      const dedupedEntries = dedupeReminderEntries(entries);
      if (dedupedEntries.length === 0) continue;
      const sortedEntries = [...dedupedEntries].sort(compareReminderEntries);
      candidates.push({
        guildId,
        clanTag: group.canonicalRow.clanTag,
        clanName: group.canonicalRow.metadata.clanName ?? null,
        matchType: group.activeCurrentWar?.matchType ?? null,
        trackedMessageId: group.canonicalRow.id,
        referenceId: group.canonicalRow.referenceId,
        channelId: group.canonicalRow.channelId,
        messageId: group.canonicalRow.messageId,
        postUrl,
        discordUserId,
        battleDayStart: battleDayStart ?? new Date(now.getTime()),
        dueOffsetHours,
        remainingOffsetHours: remainingOffsets,
        entries: sortedEntries.map(({ position, playerTag, playerName, section }) => ({
          position,
          playerTag,
          playerName,
          section,
        })),
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.battleDayStart.getTime() !== b.battleDayStart.getTime()) {
      return a.battleDayStart.getTime() - b.battleDayStart.getTime();
    }
    if (a.dueOffsetHours !== b.dueOffsetHours) {
      return b.dueOffsetHours - a.dueOffsetHours;
    }
    const clanCompare = a.clanTag.localeCompare(b.clanTag);
    if (clanCompare !== 0) return clanCompare;
    const userCompare = a.discordUserId.localeCompare(b.discordUserId);
    if (userCompare !== 0) return userCompare;
    const scopeA = a.referenceId ?? a.trackedMessageId;
    const scopeB = b.referenceId ?? b.trackedMessageId;
    return scopeA.localeCompare(scopeB);
  });

  return candidates;
}

/** Purpose: claim one reminder slot so repeated schedulers cannot duplicate a base-swap DM. */
export async function claimFwaBaseSwapDmReminderCandidate(input: {
  candidate: Pick<
    FwaBaseSwapDmReminderCandidate,
    | "guildId"
    | "clanTag"
    | "trackedMessageId"
    | "referenceId"
    | "messageId"
    | "discordUserId"
    | "dueOffsetHours"
  >;
}): Promise<boolean> {
  const guildId = String(input.candidate.guildId ?? "").trim();
  const clanTag = normalizeClanTag(input.candidate.clanTag);
  const trackedMessageId = String(input.candidate.trackedMessageId ?? "").trim();
  const referenceId = String(input.candidate.referenceId ?? "").trim() || null;
  const discordUserId = String(input.candidate.discordUserId ?? "").trim();
  const dueOffsetHours = normalizeOffsetHours(input.candidate.dueOffsetHours);
  if (!guildId || !clanTag || !trackedMessageId || !discordUserId || dueOffsetHours <= 0) return false;

  const claimKey = buildFwaBaseSwapDmReminderClaimKey({
    trackedMessageId,
    referenceId,
    discordUserId,
    offsetHours: dueOffsetHours,
  });

  const rows = await prisma.trackedMessage.findMany({
    where: {
      guildId,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      expiresAt: { gt: new Date() },
      OR: [
        { id: trackedMessageId },
        ...(referenceId ? [{ referenceId }] : []),
        { messageId: String(input.candidate.messageId ?? "").trim() },
      ],
    },
    orderBy: [{ createdAt: "desc" }],
    select: { id: true },
  });
  if (rows.length === 0) return false;

  const existingClaim = await prisma.trackedMessageClaim.findFirst({
    where: {
      trackedMessageId: { in: rows.map((row) => row.id) },
      userId: claimKey,
      clanTag: claimKey,
    },
    select: { id: true },
  });
  if (existingClaim) return false;

  const claimed = await prisma.trackedMessageClaim.createMany({
    data: [
      {
        trackedMessageId: rows[0].id,
        userId: claimKey,
        clanTag: claimKey,
      },
    ],
    skipDuplicates: true,
  });
  return claimed.count > 0;
}

/** Purpose: expose the candidate planner for tests and future schedulers without wiring delivery yet. */
export const findPendingFwaBaseSwapDmReminderCandidatesForTest =
  findPendingFwaBaseSwapDmReminderCandidates;

/** Purpose: expose the claim helper for tests and future schedulers without wiring delivery yet. */
export const claimFwaBaseSwapDmReminderCandidateForTest =
  claimFwaBaseSwapDmReminderCandidate;

function dedupeReminderEntries(entries: readonly ReminderEntry[]): ReminderEntry[] {
  const deduped = new Map<string, ReminderEntry>();
  for (const entry of entries) {
    const position = normalizeReminderPosition(entry.position);
    const playerTag = String(entry.playerTag ?? "").trim();
    const playerName = String(entry.playerName ?? "").trim();
    const section = normalizeReminderSection(entry.section);
    const discordUserId = String(entry.discordUserId ?? "").trim();
    if (position <= 0 || !playerTag || !playerName || !discordUserId || !section) continue;
    const key = `${section}:${position}:${playerTag}:${discordUserId}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        position,
        playerTag,
        playerName,
        section,
        discordUserId,
      });
    }
  }
  return [...deduped.values()];
}

function compareReminderEntries(a: ReminderEntry, b: ReminderEntry): number {
  const sectionCompare =
    BASE_SWAP_DM_REMINDER_SECTION_ORDER.indexOf(a.section) -
    BASE_SWAP_DM_REMINDER_SECTION_ORDER.indexOf(b.section);
  if (sectionCompare !== 0) return sectionCompare;
  if (a.position !== b.position) return a.position - b.position;
  const nameCompare = a.playerName.localeCompare(b.playerName);
  if (nameCompare !== 0) return nameCompare;
  return a.playerTag.localeCompare(b.playerTag);
}

function normalizeOffsets(offsets?: readonly number[]): number[] {
  return [...(offsets ?? BASE_SWAP_DM_REMINDER_OFFSETS_HOURS)]
    .map((offset) => normalizeOffsetHours(offset))
    .filter((offset): offset is number => offset > 0)
    .sort((a, b) => b - a);
}

function normalizeOffsetHours(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : 0;
}

function normalizeReminderPosition(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : 0;
}

function normalizeReminderSection(input: unknown): FwaBaseSwapDmReminderSection | null {
  const section = String(input ?? "").trim();
  if (section === "war_bases" || section === "base_errors" || section === "fwa_bases") {
    return section;
  }
  return null;
}

function normalizeDateMs(input: Date | null | undefined): number | null {
  if (!(input instanceof Date)) return null;
  const value = input.getTime();
  return Number.isFinite(value) ? value : null;
}

function formatReminderSlotList(offsetHours: readonly number[]): string {
  const labels = [...offsetHours]
    .map((offset) => `${normalizeOffsetHours(offset)}h`)
    .filter((label) => label !== "0h");
  if (labels.length === 0) return "no remaining reminder slots";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function groupReminderEntriesBySection(entries: readonly FwaBaseSwapDmReminderEntry[]): Map<
  FwaBaseSwapDmReminderSection,
  FwaBaseSwapDmReminderEntry[]
> {
  const grouped = new Map<FwaBaseSwapDmReminderSection, FwaBaseSwapDmReminderEntry[]>();
  for (const entry of entries) {
    const section = normalizeReminderSection(entry.section);
    if (!section) continue;
    const list = grouped.get(section) ?? [];
    list.push({
      position: normalizeReminderPosition(entry.position),
      playerTag: String(entry.playerTag ?? "").trim(),
      playerName: String(entry.playerName ?? "").trim(),
      section,
    });
    grouped.set(section, list);
  }
  for (const [section, sectionEntries] of grouped.entries()) {
    sectionEntries.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      const nameCompare = a.playerName.localeCompare(b.playerName);
      if (nameCompare !== 0) return nameCompare;
      return a.playerTag.localeCompare(b.playerTag);
    });
    grouped.set(section, sectionEntries);
  }
  return grouped;
}

function isBaseSwapReminderSection(
  section: string,
): section is FwaBaseSwapDmReminderSection {
  return normalizeReminderSection(section) !== null;
}

function resolveFwaBaseSwapReminderSectionCopy(input: {
  section: FwaBaseSwapDmReminderSection;
  matchType: string | null;
}): { heading: string; description: string } {
  const matchType = String(input.matchType ?? "").trim().toUpperCase();
  switch (input.section) {
    case "war_bases":
      return {
        heading: "Swap back to FWA base!",
        description:
          "You have not yet reacted and need to swap the listed account(s) from war base back to FWA base.",
      };
    case "fwa_bases":
      return {
        heading: "Swap to WAR base!",
        description:
          "You have not yet reacted and need to swap the listed account(s) from FWA base to war base.",
      };
    case "base_errors":
      return {
        heading: matchType === "FWA" ? "Fix your FWA base!" : "Fix your war base!",
        description:
          "You have not yet reacted and need to fix the listed account(s)' base errors.",
      };
  }
}

function formatCompactDurationLabel(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
