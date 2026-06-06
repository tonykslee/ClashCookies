import { prisma } from "../../prisma";
import { dozzleLog } from "../../helper/dozzleLogger";
import { normalizeClanTag } from "../PlayerLinkService";
import { isTodoWarStateActive } from "../TodoTrackedWarStateService";
import {
  buildFwaBasesChecklistReminderMessageId,
  resolveTrackedMessageSyncIdentity,
  trackedMessageService,
} from "../TrackedMessageService";
import { buildFwaMatchChecklistRenderStateForGuild } from "../FwaMatchChecklistStateService";

export const BASES_CHECKLIST_REMINDER_OFFSETS_HOURS = [12, 6, 3, 1] as const;

type ReminderDestinationKind = "leader" | "notify" | "log";

export type FwaBasesChecklistReminderCandidate = {
  guildId: string;
  clanTag: string;
  clanName: string | null;
  clanShortName: string | null;
  clanRoleId: string | null;
  matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null;
  destinationChannelId: string | null;
  destinationChannelKind: ReminderDestinationKind | null;
  reminderMessageId: string;
  warId: string | number | null;
  opponentTag: string | null;
  battleDayStart: Date;
  dueBucketHours: number;
  remainingBucketHours: number[];
};

type TrackedClanRow = {
  tag: string;
  name: string | null;
  shortName: string | null;
  leaderChannelId: string | null;
  notifyChannelId: string | null;
  logChannelId: string | null;
  clanRoleId: string | null;
};

type CurrentWarGuildRow = {
  guildId: string;
  clanTag: string;
  state: string | null;
};

function normalizeOffsets(offsets?: readonly number[]): number[] {
  return [...(offsets ?? BASES_CHECKLIST_REMINDER_OFFSETS_HOURS)]
    .map((offset) => normalizeOffsetHours(offset))
    .filter((offset): offset is number => offset > 0)
    .sort((left, right) => right - left);
}

function normalizeOffsetHours(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : 0;
}

function normalizeDateMs(input: Date | null | undefined): number | null {
  if (!(input instanceof Date)) return null;
  const value = input.getTime();
  return Number.isFinite(value) ? value : null;
}

function buildClanTagQueryVariants(tag: string): string[] {
  const normalized = normalizeClanTag(tag);
  if (!normalized) return [];
  const bare = normalized.replace(/^#/, "");
  const variants = new Set<string>();
  if (bare) variants.add(bare);
  if (normalized) variants.add(normalized);
  return [...variants];
}

function resolveReminderDestination(clan: TrackedClanRow): {
  channelId: string | null;
  kind: ReminderDestinationKind | null;
} {
  const leaderChannelId = String(clan.leaderChannelId ?? "").trim();
  if (leaderChannelId) return { channelId: leaderChannelId, kind: "leader" };
  const notifyChannelId = String(clan.notifyChannelId ?? "").trim();
  if (notifyChannelId) return { channelId: notifyChannelId, kind: "notify" };
  const logChannelId = String(clan.logChannelId ?? "").trim();
  if (logChannelId) return { channelId: logChannelId, kind: "log" };
  return { channelId: null, kind: null };
}

function buildBasesChecklistReminderContent(input: {
  clanLabel: string;
  clanTag: string;
  timeLeftLabel: string;
  clanRoleId?: string | null;
}): string {
  const roleMention = String(input.clanRoleId ?? "").trim()
    ? ` <@&${String(input.clanRoleId).trim()}>`
    : "";
  return [
    `⚠️ Bases not checked for ${input.clanLabel}${roleMention}`,
    `${input.timeLeftLabel} left in preparation day.`,
    `If bases are all good, mark complete with /fwa match-checklist type:Bases clan:${input.clanTag} checked:true or react to the public Bases checklist.`,
    `If there are base errors or active war bases, run /fwa base-swap for ${input.clanTag}.`,
  ].join("\n");
}

function isBasesChecklistUncheckedRow(line: string | null | undefined): boolean {
  return String(line ?? "").includes("❌ Bases not checked");
}

/** Purpose: find Bases checklist reminder candidates from persisted checklist state only. */
export async function findPendingFwaBasesChecklistReminderCandidates(input: {
  now?: Date;
}): Promise<FwaBasesChecklistReminderCandidate[]> {
  const now = input.now ?? new Date();

  const trackedClans = (await prisma.trackedClan.findMany({
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    select: {
      tag: true,
      name: true,
      shortName: true,
      leaderChannelId: true,
      notifyChannelId: true,
      logChannelId: true,
      clanRoleId: true,
    },
  })) as TrackedClanRow[];
  if (trackedClans.length === 0) return [];

  const trackedTagVariants = new Set<string>();
  for (const clan of trackedClans) {
    for (const variant of buildClanTagQueryVariants(clan.tag)) {
      trackedTagVariants.add(variant);
    }
  }
  if (trackedTagVariants.size === 0) return [];

  const currentWarRows = (await prisma.currentWar.findMany({
    where: {
      clanTag: {
        in: [...trackedTagVariants],
      },
    },
    select: {
      guildId: true,
      clanTag: true,
      state: true,
    },
  })) as CurrentWarGuildRow[];
  const activeGuildIds = [
    ...new Set(
      currentWarRows
        .filter((row) => isTodoWarStateActive(row.state))
        .map((row) => String(row.guildId ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (activeGuildIds.length === 0) return [];

  const trackedClanByTag = new Map<string, TrackedClanRow>();
  for (const clan of trackedClans) {
    const clanTag = normalizeClanTag(clan.tag);
    if (!clanTag) continue;
    trackedClanByTag.set(clanTag, clan);
  }

  const candidates: FwaBasesChecklistReminderCandidate[] = [];
  for (const guildId of activeGuildIds) {
    const latestActiveSyncPost = await trackedMessageService
      .resolveLatestActiveSyncPost(guildId)
      .catch(() => null);
    const activeSyncIdentity = resolveTrackedMessageSyncIdentity(latestActiveSyncPost);
    const renderState = await buildFwaMatchChecklistRenderStateForGuild({
      cocService: {} as any,
      guildId,
      client: {} as any,
      viewType: "Bases",
    });
    for (const row of renderState.rows) {
      if (!isBasesChecklistUncheckedRow(row.compactCopyLine)) continue;
      if (!row.warStartTimeIso) continue;
      const battleDayStart = new Date(row.warStartTimeIso);
      if (!Number.isFinite(battleDayStart.getTime())) continue;
      if (normalizeDateMs(battleDayStart) === null) continue;
      if (normalizeDateMs(now) !== null && now.getTime() >= battleDayStart.getTime()) continue;

      const clanTag = normalizeClanTag(row.clanTag);
      if (!clanTag) continue;
      const trackedClan = trackedClanByTag.get(clanTag) ?? null;
      if (!trackedClan) continue;

      const dueOffsets = resolveDueFwaBasesChecklistDueOffsets({
        now,
        battleDayStart,
        offsets: BASES_CHECKLIST_REMINDER_OFFSETS_HOURS,
      });
      if (dueOffsets.length === 0) continue;
      const dueBucketHours = dueOffsets[dueOffsets.length - 1] ?? null;
      if (dueBucketHours === null) continue;

      let currentSyncIdentity = activeSyncIdentity;
      let currentSyncIdentitySource:
        | "override"
        | "active_sync_post"
        | "expired_sync_post_fallback"
        | "none" = activeSyncIdentity ? "active_sync_post" : "none";
      if (!currentSyncIdentity) {
        currentSyncIdentity = await trackedMessageService
          .resolveLatestRelevantSyncPostForClanWar({
            guildId,
            clanTag,
            warStartTime: battleDayStart,
            now,
          })
          .catch(() => null);
        currentSyncIdentitySource = currentSyncIdentity ? "expired_sync_post_fallback" : "none";
      }

      dozzleLog.debug(
        `[fwa bases-check reminder] sync_identity_resolved guildId=${guildId} clanTag=${clanTag} warId=${row.warId ?? "missing"} opponentTag=${row.opponentTag ?? "missing"} warStartTimeIso=${row.warStartTimeIso ?? "missing"} source=${currentSyncIdentitySource} syncMessageId=${currentSyncIdentity ?? "missing"}`,
      );

      const activeBaseSwap = await trackedMessageService
        .findLatestActiveFwaBaseSwapTrackedMessageForClan({
          guildId,
          clanTag,
          syncMessageId: currentSyncIdentity,
        })
        .catch(() => null);
      if (activeBaseSwap) {
        dozzleLog.debug(
          `[fwa bases-check reminder] candidate_suppressed guildId=${guildId} clanTag=${clanTag} warId=${row.warId ?? "missing"} opponentTag=${row.opponentTag ?? "missing"} warStartTimeIso=${row.warStartTimeIso ?? "missing"} reason=base_swap_exists syncIdentitySource=${currentSyncIdentitySource} syncMessageId=${currentSyncIdentity ?? "missing"} trackedMessageId=${activeBaseSwap.messageId} messageId=${activeBaseSwap.messageId}`,
        );
        continue;
      }

      const reminderMessageId = buildFwaBasesChecklistReminderMessageId({
        guildId,
        clanTag,
        warId: row.warId ?? null,
        opponentTag: row.opponentTag ?? null,
        warStartTime: battleDayStart,
        bucketHours: dueBucketHours,
      });
      if (!reminderMessageId) continue;

      const existingMarker = await trackedMessageService
        .getActiveByMessageId(reminderMessageId)
        .catch(() => null);
      if (existingMarker) continue;

      const destination = resolveReminderDestination(trackedClan);
      candidates.push({
        guildId,
        clanTag,
        clanName: trackedClan.name ?? null,
        clanShortName: trackedClan.shortName ?? null,
        clanRoleId: trackedClan.clanRoleId ?? null,
        matchType: row.matchType ?? null,
        destinationChannelId: destination.channelId,
        destinationChannelKind: destination.kind,
        reminderMessageId,
        warId: row.warId ?? null,
        opponentTag: row.opponentTag ?? null,
        battleDayStart,
        dueBucketHours,
        remainingBucketHours: resolveRemainingFwaBasesChecklistDueOffsets({
          now,
          battleDayStart,
          offsets: BASES_CHECKLIST_REMINDER_OFFSETS_HOURS,
        }),
      });
    }
  }

  candidates.sort((left, right) => {
    const leftStart = left.battleDayStart.getTime();
    const rightStart = right.battleDayStart.getTime();
    if (leftStart !== rightStart) return leftStart - rightStart;
    if (left.dueBucketHours !== right.dueBucketHours) return left.dueBucketHours - right.dueBucketHours;
    const clanCompare = left.clanTag.localeCompare(right.clanTag);
    if (clanCompare !== 0) return clanCompare;
    return left.guildId.localeCompare(right.guildId);
  });

  return candidates;
}

/** Purpose: render the compact one-message reminder body for an unchecked bases checklist. */
export function buildFwaBasesChecklistReminderContentForTest(input: {
  clanLabel: string;
  clanTag: string;
  timeLeftLabel: string;
  clanRoleId?: string | null;
}): string {
  return buildBasesChecklistReminderContent(input);
}

/** Purpose: create the reminder content builder used by the scheduler. */
export function buildFwaBasesChecklistReminderContent(input: {
  clanLabel: string;
  clanTag: string;
  timeLeftLabel: string;
  clanRoleId?: string | null;
}): string {
  return buildBasesChecklistReminderContent(input);
}

/** Purpose: resolve which reminder buckets are already due. */
export function resolveDueFwaBasesChecklistDueOffsets(input: {
  now: Date;
  battleDayStart: Date | null | undefined;
  offsets?: readonly number[];
}): number[] {
  const offsets = normalizeOffsets(input.offsets);
  const battleDayStartMs = normalizeDateMs(input.battleDayStart);
  const nowMs = normalizeDateMs(input.now);
  if (battleDayStartMs === null || nowMs === null) return [];
  if (nowMs >= battleDayStartMs) return [];
  return offsets.filter((offsetHours) => nowMs >= battleDayStartMs - offsetHours * 60 * 60 * 1000);
}

/** Purpose: resolve which reminder buckets remain after the current latest due bucket. */
export function resolveRemainingFwaBasesChecklistDueOffsets(input: {
  now: Date;
  battleDayStart: Date | null | undefined;
  offsets?: readonly number[];
}): number[] {
  const offsets = normalizeOffsets(input.offsets);
  const battleDayStartMs = normalizeDateMs(input.battleDayStart);
  const nowMs = normalizeDateMs(input.now);
  if (battleDayStartMs === null || nowMs === null) return [];
  if (nowMs >= battleDayStartMs) return [];
  return offsets.filter((offsetHours) => nowMs < battleDayStartMs - offsetHours * 60 * 60 * 1000);
}

/** Purpose: expose the reminder planner for tests and future scheduler wiring. */
export const findPendingFwaBasesChecklistReminderCandidatesForTest =
  findPendingFwaBasesChecklistReminderCandidates;
