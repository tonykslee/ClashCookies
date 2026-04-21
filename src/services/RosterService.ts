import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { randomUUID } from "crypto";
import { CoCService } from "./CoCService";
import { prisma } from "../prisma";
import { truncateDiscordContent } from "../helper/discordContent";
import {
  listPlayerLinksForClanMembers,
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { cwlStateService } from "./CwlStateService";
import { todoSnapshotService } from "./TodoSnapshotService";
import { normalizeSyncTimeZone } from "./syncTimeZone";

export const ROSTER_LIFECYCLE_STATE = {
  ACTIVE: "ACTIVE",
  OPEN: "OPEN",
  CLOSED: "CLOSED",
  ARCHIVED: "ARCHIVED",
} as const;

export type RosterLifecycleState =
  (typeof ROSTER_LIFECYCLE_STATE)[keyof typeof ROSTER_LIFECYCLE_STATE];

export const ROSTER_DEFAULT_GROUPS = [
  {
    key: "confirmed",
    name: "Confirmed",
    description: "Primary roster members",
    sortOrder: 0,
  },
  {
    key: "substitute",
    name: "Substitute",
    description: "Reserve roster members",
    sortOrder: 1,
  },
] as const;

export const ROSTER_SIGNUP_BUTTON_PREFIX = "roster-signup";
export const ROSTER_REMOVE_BUTTON_PREFIX = "roster-remove";
export const ROSTER_SELECTION_PREFIX = "roster-selection";
export const ROSTER_POST_ACTION_PREFIX = "roster-post-action";
export const ROSTER_POST_SETTINGS_PREFIX = "roster-post-settings";
const ROSTER_SELECTION_SESSION_TTL_MS = 15 * 60 * 1000;
const ROSTER_CONFLICT_LIFECYCLE_STATES: readonly RosterLifecycleState[] = [
  ROSTER_LIFECYCLE_STATE.ACTIVE,
  ROSTER_LIFECYCLE_STATE.OPEN,
  ROSTER_LIFECYCLE_STATE.CLOSED,
];

export type RosterGroupSeed = {
  key: string;
  name: string;
  description?: string | null;
  sortOrder?: number | null;
};

export type RosterGroupRecord = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  sortOrder: number;
};

export type RosterRecord = {
  id: string;
  guildId: string;
  rosterType: string;
  rosterCategory: string | null;
  title: string;
  clanTag: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
  displayTimezone: string | null;
  maxMembers: number | null;
  maxAccountsPerUser: number | null;
  minTownhall: number | null;
  maxTownhall: number | null;
  rosterRoleId: string | null;
  allowMultiSignup: boolean;
  sortBy: string | null;
  importMembers: boolean;
  postButtonMode: string;
  lifecycleState: RosterLifecycleState;
  postedChannelId: string | null;
  postedMessageId: string | null;
  postedMessageUrl: string | null;
  postedAt: Date | null;
  createdByDiscordUserId: string | null;
  updatedByDiscordUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RosterSignupRecord = {
  id: string;
  rosterId: string;
  groupId: string | null;
  playerTag: string;
  playerName: string | null;
  discordUserId: string;
  signedUpAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type RosterSignupViewRecord = RosterSignupRecord & {
  group: RosterGroupRecord | null;
  townHall: number | null;
  discordUsername: string | null;
  clanTag: string | null;
  clanName: string | null;
};

export type RosterSignupPayload = {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
};

export type RosterSelectionMode = "signup" | "remove";

type RosterPostButtonMode = "standard" | "hidden" | "archived";

export type RosterSelectionOption = {
  value: string;
  label: string;
  description: string | null;
};

export type RosterAccountIdentity = {
  playerTag: string;
  playerName: string | null;
};

export type RosterSelectionPanel = {
  sessionId: string;
  mode: RosterSelectionMode;
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
  selectedTags: string[];
};

export type RosterSelectionOpenResult =
  | { outcome: "ready"; panel: RosterSelectionPanel }
  | { outcome: "roster_not_found"; rosterId: string }
  | { outcome: "roster_closed"; rosterId: string }
  | { outcome: "group_not_found"; rosterId: string; groupKey: string }
  | { outcome: "no_linked_accounts"; rosterId: string }
  | { outcome: "no_owned_entries"; rosterId: string };

type RosterSelectionLoadErrorResult =
  | { outcome: "roster_not_found"; rosterId: string }
  | { outcome: "roster_closed"; rosterId: string }
  | { outcome: "group_not_found"; rosterId: string; groupKey: string }
  | { outcome: "no_linked_accounts"; rosterId: string }
  | { outcome: "no_owned_entries"; rosterId: string };

type RosterSelectionSignupLoadReadyResult = {
  outcome: "ready";
  roster: RosterRecord;
  group: RosterGroupRecord | null;
  groups: RosterGroupRecord[];
  selectedGroupKey: string | null;
  options: RosterSelectionOption[];
};

type RosterSelectionRemoveLoadReadyResult = {
  outcome: "ready";
  roster: RosterRecord;
  group: null;
  options: RosterSelectionOption[];
};

type RosterSelectionSignupLoadResult =
  | RosterSelectionSignupLoadReadyResult
  | RosterSelectionLoadErrorResult;

type RosterSelectionRemoveLoadResult =
  | RosterSelectionRemoveLoadReadyResult
  | RosterSelectionLoadErrorResult;

export type RosterSelectionUpdateResult =
  | { outcome: "updated"; panel: RosterSelectionPanel }
  | { outcome: "session_not_found" }
  | { outcome: "forbidden" };

export type RosterSelectionCommitResult =
  | { outcome: "signup"; result: SignupLinkedAccountsResult }
  | { outcome: "remove"; result: RemoveRosterSignupsResult }
  | { outcome: "session_not_found" }
  | { outcome: "forbidden" };

export type RosterSignupView = {
  roster: RosterRecord;
  clanDisplayName: string | null;
  clanLeagueLabel: string | null;
  groups: Array<
    RosterGroupRecord & {
      signupCount: number;
    }
  >;
  signups: RosterSignupViewRecord[];
  totalSignupCount: number;
};

export type RosterSummaryRecord = RosterRecord & {
  groupCount: number;
  signupCount: number;
};

const ROSTER_RECORD_SELECT = {
  id: true,
  guildId: true,
  rosterType: true,
  rosterCategory: true,
  title: true,
  clanTag: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  displayTimezone: true,
  maxMembers: true,
  maxAccountsPerUser: true,
  minTownhall: true,
  maxTownhall: true,
  rosterRoleId: true,
  allowMultiSignup: true,
  sortBy: true,
  importMembers: true,
  postButtonMode: true,
  lifecycleState: true,
  postedChannelId: true,
  postedMessageId: true,
  postedMessageUrl: true,
  postedAt: true,
  createdByDiscordUserId: true,
  updatedByDiscordUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type CreateRosterInput = {
  guildId: string;
  rosterType: string;
  title?: string | null;
  name?: string | null;
  clanTag?: string | null;
  rosterCategory?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  displayTimezone?: string | null;
  maxMembers?: number | null;
  maxAccountsPerUser?: number | null;
  minTownhall?: number | null;
  maxTownhall?: number | null;
  rosterRoleId?: string | null;
  allowMultiSignup?: boolean | null;
  sortBy?: string | null;
  importMembers?: boolean | null;
  lifecycleState?: RosterLifecycleState;
  createdByDiscordUserId?: string | null;
  updatedByDiscordUserId?: string | null;
  groups?: RosterGroupSeed[];
};

export type SignupLinkedAccountsResult =
  | {
      outcome: "created";
      rosterId: string;
      groupKey: string;
      groupName: string;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
    }
  | {
      outcome: "roster_full";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
      blockedTags: string[];
    }
  | {
      outcome: "account_limit_exceeded";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
      blockedTags: string[];
    }
  | {
      outcome: "townhall_unavailable";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
      blockedTags: string[];
      blockedAccounts: RosterAccountIdentity[];
    }
  | {
      outcome: "townhall_out_of_range";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
      blockedTags: string[];
      blockedAccounts: RosterAccountIdentity[];
    }
  | {
      outcome: "roster_conflict";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
      blockedTags: string[];
      conflictingRosterIds: string[];
    }
  | {
      outcome: "no_linked_accounts";
      rosterId: string;
      groupKey: string;
      groupName: string;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
    }
  | {
      outcome: "already_signed_up";
      rosterId: string;
      groupKey: string;
      groupName: string;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
    }
  | {
      outcome: "roster_not_found";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
    }
  | {
      outcome: "roster_closed";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
    }
  | {
      outcome: "roster_archived";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
    }
  | {
      outcome: "group_not_found";
      rosterId: string;
      groupKey: string;
      groupName: string | null;
      requestedTags: string[];
      linkedTags: string[];
      createdTags: string[];
      duplicateTags: string[];
      missingLinkedTags: string[];
    };

export type RemoveRosterSignupsResult =
  | {
      outcome: "removed";
      rosterId: string;
      removedTags: string[];
      ignoredTags: string[];
      notOwnedTags: string[];
    }
  | {
      outcome: "nothing_removed";
      rosterId: string;
      removedTags: string[];
      ignoredTags: string[];
      notOwnedTags: string[];
    }
  | {
      outcome: "roster_not_found";
      rosterId: string;
      removedTags: string[];
      ignoredTags: string[];
      notOwnedTags: string[];
    }
  | {
      outcome: "roster_archived";
      rosterId: string;
      removedTags: string[];
      ignoredTags: string[];
      notOwnedTags: string[];
    };

export type RosterLifecycleUpdateResult =
  | {
      outcome: "updated";
      rosterId: string;
      lifecycleState: RosterLifecycleState;
    }
  | {
      outcome: "roster_not_found";
      rosterId: string;
    };

export type RosterManagerMoveSignupsResult =
  | {
      outcome: "moved";
      rosterId: string;
      groupKey: string;
      requestedTags: string[];
      movedTags: string[];
      duplicateTags: string[];
      missingTags: string[];
    }
  | {
      outcome: "nothing_moved";
      rosterId: string;
      groupKey: string;
      requestedTags: string[];
      movedTags: string[];
      duplicateTags: string[];
      missingTags: string[];
    }
  | {
      outcome: "roster_not_found";
      rosterId: string;
      groupKey: string;
      requestedTags: string[];
      movedTags: string[];
      duplicateTags: string[];
      missingTags: string[];
    }
  | {
      outcome: "roster_archived";
      rosterId: string;
      groupKey: string;
      requestedTags: string[];
      movedTags: string[];
      duplicateTags: string[];
      missingTags: string[];
    }
  | {
      outcome: "group_not_found";
      rosterId: string;
      groupKey: string;
      requestedTags: string[];
      movedTags: string[];
      duplicateTags: string[];
      missingTags: string[];
    };

export type RosterManagerReadinessView = {
  roster: RosterRecord;
  trackedClanRoster: RosterManagerTrackedClanMemberRecord[];
  signupView: RosterSignupView;
  signedUpButUntracked: RosterSignupViewRecord[];
  unsignedTrackedMembers: RosterManagerTrackedClanMemberRecord[];
};

type RosterManagerTrackedClanMemberRecord = {
  playerTag: string;
  playerName: string;
  townHall: number | null;
  linkedDiscordUserId: string | null;
  linkedDiscordUsername: string | null;
};

function normalizeRosterType(input: string): string {
  return String(input ?? "")
    .trim()
    .toUpperCase();
}

function isSupportedRosterType(input: string): boolean {
  return input === "CWL" || input === "FWA";
}

function normalizeRosterCategory(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRosterTitle(input: string): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRosterText(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRosterInt(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isRosterTownHallGated(roster: { minTownhall: number | null; maxTownhall: number | null }): boolean {
  return normalizeRosterInt(roster.minTownhall) !== null || normalizeRosterInt(roster.maxTownhall) !== null;
}

export const ROSTER_SORT_BY = {
  SIGNED_UP_AT: "signed_up_at",
  PLAYER_NAME: "player_name",
  PLAYER_TAG: "player_tag",
  DISCORD_USER: "discord_user",
  TOWNHALL: "townhall",
} as const;

export type RosterSortBy = (typeof ROSTER_SORT_BY)[keyof typeof ROSTER_SORT_BY];

function normalizeRosterSortBy(input: string | null | undefined): RosterSortBy | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (
    normalized === ROSTER_SORT_BY.SIGNED_UP_AT ||
    normalized === ROSTER_SORT_BY.PLAYER_NAME ||
    normalized === ROSTER_SORT_BY.PLAYER_TAG ||
    normalized === ROSTER_SORT_BY.DISCORD_USER ||
    normalized === ROSTER_SORT_BY.TOWNHALL
  ) {
    return normalized;
  }
  return null;
}

function normalizeRosterRoleId(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const raw = trimmed
    .replace(/^<@&/, "")
    .replace(/>$/, "")
    .trim();
  return /^\d{15,22}$/.test(raw) ? raw : null;
}

const ROSTER_CREATE_EDIT_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/;

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(map.get("year"));
  const month = Number(map.get("month"));
  const day = Number(map.get("day"));
  const hour = Number(map.get("hour"));
  const minute = Number(map.get("minute"));
  const second = Number(map.get("second"));
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - date.getTime();
}

function toEpochSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  let result = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(result), timeZone);
  result = utcGuess - secondOffset;
  return Math.floor(result / 1000);
}

export function parseRosterDateTimeInTimeZone(input: string, timeZone: string): Date | null {
  const normalizedTimeZone = normalizeRosterDisplayTimezone(timeZone);
  if (!normalizedTimeZone) return null;
  const normalizedInput = String(input ?? "").trim();
  if (!ROSTER_CREATE_EDIT_DATE_TIME_PATTERN.test(normalizedInput)) return null;

  const [datePart, timePart] = normalizedInput.split(/\s+/g);
  const [year, month, day] = datePart.split("-").map((value) => Number(value));
  const [hour, minute] = timePart.split(":").map((value) => Number(value));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  const epochSeconds = toEpochSeconds(year, month, day, hour, minute, normalizedTimeZone);
  const parsed = new Date(epochSeconds * 1000);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function normalizeRosterGroupKey(input: string): string {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeRosterDisplayTimezone(input: string | null | undefined): string | null {
  const normalized = normalizeSyncTimeZone(input ?? null);
  return normalized;
}

function buildRosterStateLabel(state: RosterLifecycleState): string {
  if (state === ROSTER_LIFECYCLE_STATE.ACTIVE) return "Active";
  if (state === ROSTER_LIFECYCLE_STATE.CLOSED) return "Closed";
  if (state === ROSTER_LIFECYCLE_STATE.ARCHIVED) return "Archived";
  return "Open";
}

function isRosterAcceptingSignups(state: RosterLifecycleState): boolean {
  return state === ROSTER_LIFECYCLE_STATE.OPEN || state === ROSTER_LIFECYCLE_STATE.ACTIVE;
}

function isRosterArchived(state: RosterLifecycleState): boolean {
  return state === ROSTER_LIFECYCLE_STATE.ARCHIVED;
}

function isRosterConflictEligible(state: RosterLifecycleState): boolean {
  return ROSTER_CONFLICT_LIFECYCLE_STATES.includes(state);
}

function canManagerMutateRoster(state: RosterLifecycleState): boolean {
  return !isRosterArchived(state);
}

function sortRosterSignupsForRoster(
  signups: RosterSignupViewRecord[],
  sortBy: string | null | undefined,
): RosterSignupViewRecord[] {
  const normalizedSortBy = normalizeRosterSortBy(sortBy) ?? ROSTER_SORT_BY.SIGNED_UP_AT;
  const signupsCopy = [...signups];
  signupsCopy.sort((left, right) => {
    if (normalizedSortBy === ROSTER_SORT_BY.PLAYER_NAME) {
      return (
        String(left.playerName ?? left.playerTag).localeCompare(String(right.playerName ?? right.playerTag)) ||
        left.playerTag.localeCompare(right.playerTag)
      );
    }
    if (normalizedSortBy === ROSTER_SORT_BY.PLAYER_TAG) {
      return left.playerTag.localeCompare(right.playerTag);
    }
    if (normalizedSortBy === ROSTER_SORT_BY.DISCORD_USER) {
      return (
        String(left.discordUserId ?? "").localeCompare(String(right.discordUserId ?? "")) ||
        left.playerTag.localeCompare(right.playerTag)
      );
    }
    if (normalizedSortBy === ROSTER_SORT_BY.TOWNHALL) {
      const leftTownHall = Number(left.townHall ?? 0);
      const rightTownHall = Number(right.townHall ?? 0);
      return rightTownHall - leftTownHall || left.playerTag.localeCompare(right.playerTag);
    }
    return (
      left.signedUpAt.getTime() - right.signedUpAt.getTime() ||
      left.playerTag.localeCompare(right.playerTag)
    );
  });
  return signupsCopy;
}

type RosterRecordLike = {
  id: string;
  guildId: string;
  rosterType: string;
  rosterCategory: string | null;
  title: string;
  clanTag: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
  displayTimezone: string | null;
  maxMembers: number | null;
  maxAccountsPerUser: number | null;
  minTownhall: number | null;
  maxTownhall: number | null;
  rosterRoleId: string | null;
  allowMultiSignup: boolean;
  sortBy: string | null;
  importMembers: boolean;
  postButtonMode: string;
  lifecycleState: string;
  postedChannelId: string | null;
  postedMessageId: string | null;
  postedMessageUrl: string | null;
  postedAt: Date | null;
  createdByDiscordUserId: string | null;
  updatedByDiscordUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapRosterRecord(row: RosterRecordLike): RosterRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    rosterType: row.rosterType,
    rosterCategory: row.rosterCategory,
    title: row.title,
    clanTag: row.clanTag,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone: row.timezone,
    displayTimezone: row.displayTimezone,
    maxMembers: row.maxMembers,
    maxAccountsPerUser: row.maxAccountsPerUser,
    minTownhall: row.minTownhall,
    maxTownhall: row.maxTownhall,
    rosterRoleId: row.rosterRoleId,
    allowMultiSignup: row.allowMultiSignup,
    sortBy: row.sortBy,
    importMembers: row.importMembers,
    postButtonMode: row.postButtonMode,
    lifecycleState: row.lifecycleState as RosterLifecycleState,
    postedChannelId: row.postedChannelId,
    postedMessageId: row.postedMessageId,
    postedMessageUrl: row.postedMessageUrl,
    postedAt: row.postedAt,
    createdByDiscordUserId: row.createdByDiscordUserId,
    updatedByDiscordUserId: row.updatedByDiscordUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRosterSummaryRecord(
  row: RosterRecordLike & { _count: { groups: number; signups: number } },
): RosterSummaryRecord {
  const roster = mapRosterRecord(row);
  return {
    ...roster,
    groupCount: row._count.groups,
    signupCount: row._count.signups,
  };
}

function buildRosterSignupEntryLine(signup: {
  playerName: string | null;
  playerTag: string;
  discordUserId: string | null;
  townHall?: number | null;
}): string {
  const playerLabel = signup.playerName ? `${signup.playerName} \`${signup.playerTag}\`` : `\`${signup.playerTag}\``;
  const userLabel = signup.discordUserId ? ` <@${signup.discordUserId}>` : "";
  const townHallLabel = signup.townHall !== undefined && signup.townHall !== null ? ` TH${signup.townHall}` : "";
  return `- ${playerLabel}${townHallLabel}${userLabel}`;
}

function buildRosterSelectionMenuCustomId(sessionId: string): string {
  return `${ROSTER_SELECTION_PREFIX}:account:${String(sessionId ?? "").trim()}`;
}

function buildRosterSelectionGroupMenuCustomId(sessionId: string): string {
  return `${ROSTER_SELECTION_PREFIX}:group:${String(sessionId ?? "").trim()}`;
}

function buildRosterSelectionActionButtonCustomId(action: "confirm" | "cancel", sessionId: string): string {
  return `${ROSTER_SELECTION_PREFIX}:action:${action}:${String(sessionId ?? "").trim()}`;
}

export function buildRosterPostActionButtonCustomId(action: "refresh" | "signup" | "optout" | "settings", rosterId: string): string {
  return `${ROSTER_POST_ACTION_PREFIX}:${action}:${String(rosterId ?? "").trim()}`;
}

export function buildRosterPostSettingsMenuCustomId(rosterId: string): string {
  return `${ROSTER_POST_SETTINGS_PREFIX}:${String(rosterId ?? "").trim()}`;
}

type RosterSelectionSession = {
  sessionId: string;
  mode: RosterSelectionMode;
  rosterId: string;
  rosterTitle: string;
  groupKey: string | null;
  groupName: string | null;
  selectedGroupKey: string | null;
  groupOptions: RosterSelectionOption[];
  ownerDiscordUserId: string;
  createdAtMs: number;
  options: RosterSelectionOption[];
  selectedTags: string[];
};

const rosterSelectionSessions = new Map<string, RosterSelectionSession>();

function pruneExpiredRosterSelectionSessions(nowMs = Date.now()): void {
  for (const [sessionId, session] of rosterSelectionSessions.entries()) {
    if (session.createdAtMs + ROSTER_SELECTION_SESSION_TTL_MS <= nowMs) {
      rosterSelectionSessions.delete(sessionId);
    }
  }
}

function createRosterSelectionSession(input: Omit<RosterSelectionSession, "sessionId" | "createdAtMs">): RosterSelectionSession {
  const session: RosterSelectionSession = {
    ...input,
    sessionId: randomUUID().replace(/-/g, "").slice(0, 18),
    createdAtMs: Date.now(),
  };
  rosterSelectionSessions.set(session.sessionId, session);
  pruneExpiredRosterSelectionSessions();
  return session;
}

function getRosterSelectionSession(sessionId: string): RosterSelectionSession | null {
  pruneExpiredRosterSelectionSessions();
  return rosterSelectionSessions.get(sessionId) ?? null;
}

function deleteRosterSelectionSession(sessionId: string): void {
  rosterSelectionSessions.delete(sessionId);
}

function buildRosterSelectionDescription(input: {
  mode: RosterSelectionMode;
  rosterTitle: string;
  groupName: string | null;
  selectedTags: string[];
  options: RosterSelectionOption[];
}): string[] {
  const lines: string[] = [];
  if (input.mode === "signup") {
    lines.push(`Choose a group and linked accounts for ${input.groupName ?? input.rosterTitle}.`);
  } else {
    lines.push(`Select your signup entries to remove from ${input.rosterTitle}.`);
  }
  lines.push(`Selected: ${input.selectedTags.length} / ${input.options.length}`);
  if (input.options.length > 25) {
    lines.push("Showing the first 25 options Discord can display in one select menu.");
  }
  const selectedLines = input.options.filter((option) => input.selectedTags.includes(option.value));
  if (selectedLines.length > 0) {
    lines.push("");
    lines.push("Currently selected:");
    lines.push(
      ...selectedLines.map((option) => `- ${option.label}${option.description ? ` - ${option.description}` : ""}`),
    );
  }
  return lines;
}

function buildRosterSelectionPayload(session: RosterSelectionSession): RosterSelectionPanel {
  const selectedTags = [...new Set(session.selectedTags)];
  const visibleOptions = session.options.slice(0, 25);
  const accountSelect = new StringSelectMenuBuilder()
    .setCustomId(buildRosterSelectionMenuCustomId(session.sessionId))
    .setPlaceholder(
      session.mode === "signup" ? "Select linked accounts" : "Select signups to remove",
    )
    .setMinValues(0)
    .setMaxValues(Math.max(1, visibleOptions.length))
    .setDisabled(visibleOptions.length <= 0)
    .addOptions(
      visibleOptions.length > 0
        ? visibleOptions.map((option) => ({
            label: option.label.slice(0, 100),
            value: option.value,
            description: option.description ? option.description.slice(0, 100) : undefined,
            default: selectedTags.includes(option.value),
          }))
        : [
            {
              label: "No options available",
              value: "none",
              description: "Nothing to select",
            },
          ],
    );

  const groupSelect =
    session.mode === "signup"
      ? new StringSelectMenuBuilder()
          .setCustomId(buildRosterSelectionGroupMenuCustomId(session.sessionId))
          .setPlaceholder("Select roster group")
          .setMinValues(1)
          .setMaxValues(1)
          .setDisabled(session.groupOptions.length <= 0)
          .addOptions(
            session.groupOptions.length > 0
              ? session.groupOptions.map((option) => ({
                  label: option.label.slice(0, 100),
                  value: option.value,
                  description: option.description ? option.description.slice(0, 100) : undefined,
                  default: session.selectedGroupKey === option.value,
                }))
              : [
                  {
                    label: "No groups available",
                    value: "none",
                    description: "Nothing to select",
                  },
                ],
          )
      : null;

  const confirmStyle = session.mode === "signup" ? ButtonStyle.Success : ButtonStyle.Danger;
  const embed = new EmbedBuilder()
    .setColor(session.mode === "signup" ? 0xfee75c : 0xed4245)
    .setTitle(
      session.mode === "signup"
        ? `Choose accounts for ${session.groupName ?? session.rosterTitle}`
        : `Remove signup entries from ${session.rosterTitle}`,
    )
    .setDescription(
      buildRosterSelectionDescription({
        mode: session.mode,
        rosterTitle: session.rosterTitle,
        groupName: session.groupName,
        selectedTags,
        options: visibleOptions,
      }).join("\n"),
    );

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    ...(groupSelect ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(groupSelect)] : []),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(accountSelect),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildRosterSelectionActionButtonCustomId("confirm", session.sessionId))
        .setLabel(session.mode === "signup" ? "Confirm Signup" : "Confirm Remove")
        .setStyle(confirmStyle)
        .setDisabled(selectedTags.length <= 0 || visibleOptions.length <= 0),
      new ButtonBuilder()
        .setCustomId(buildRosterSelectionActionButtonCustomId("cancel", session.sessionId))
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  return {
    sessionId: session.sessionId,
    mode: session.mode,
    embed,
    components,
    selectedTags,
  };
}

async function loadRosterSelectionOptions(input: {
  rosterId: string;
  discordUserId: string;
  mode: "signup";
  groupKey?: string | null;
}): Promise<RosterSelectionSignupLoadResult>;
async function loadRosterSelectionOptions(input: {
  rosterId: string;
  discordUserId: string;
  mode: "remove";
  groupKey?: string | null;
}): Promise<RosterSelectionRemoveLoadResult>;
async function loadRosterSelectionOptions(input: {
  rosterId: string;
  discordUserId: string;
  mode: RosterSelectionMode;
  groupKey?: string | null;
}): Promise<RosterSelectionSignupLoadResult | RosterSelectionRemoveLoadResult> {
  const roster = await prisma.roster.findUnique({
    where: { id: input.rosterId },
    select: {
      ...ROSTER_RECORD_SELECT,
    },
  });
  if (!roster) return { outcome: "roster_not_found", rosterId: input.rosterId };
  if (
    input.mode === "signup" &&
    !isRosterAcceptingSignups(roster.lifecycleState)
  ) {
    return { outcome: "roster_closed", rosterId: roster.id };
  }

  if (input.mode === "signup") {
    const groups = await prisma.rosterGroup.findMany({
      where: { rosterId: roster.id },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        sortOrder: true,
      },
    });
    const requestedGroupKey = normalizeRosterGroupKey(input.groupKey ?? "");
    const selectedGroup = requestedGroupKey
      ? groups.find((group) => group.key === requestedGroupKey) ?? null
      : groups.find((group) => group.key === normalizeRosterGroupKey("confirmed")) ?? groups[0] ?? null;
    if (requestedGroupKey && !selectedGroup) {
      return { outcome: "group_not_found", rosterId: roster.id, groupKey: requestedGroupKey };
    }
    const linkedAccounts = await listPlayerLinksForDiscordUser({ discordUserId: input.discordUserId });
    if (linkedAccounts.length <= 0) {
      return { outcome: "no_linked_accounts", rosterId: roster.id };
    }
    const linkedTags = linkedAccounts.map((account) => account.playerTag);
    const existing = await prisma.rosterSignup.findMany({
      where: {
        rosterId: roster.id,
        playerTag: { in: linkedTags },
      },
      select: { playerTag: true },
    });
    const existingTags = new Set(existing.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean));
    return {
      outcome: "ready",
      roster,
      group: selectedGroup,
      groups,
      selectedGroupKey: selectedGroup?.key ?? null,
      options: linkedAccounts.map((account) => ({
        value: account.playerTag,
        label: account.linkedName ?? account.playerTag,
        description: `${account.playerTag}${existingTags.has(account.playerTag) ? " | already signed up" : " | available"}`,
      })),
    };
  }

  const ownedEntries = await prisma.rosterSignup.findMany({
    where: {
      rosterId: roster.id,
      discordUserId: normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId,
    },
    orderBy: [{ signedUpAt: "asc" }, { playerTag: "asc" }],
    select: {
      id: true,
      rosterId: true,
      groupId: true,
      playerTag: true,
      playerName: true,
      discordUserId: true,
      signedUpAt: true,
      createdAt: true,
      updatedAt: true,
      group: {
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          sortOrder: true,
        },
      },
    },
  });
  if (ownedEntries.length <= 0) {
    return { outcome: "no_owned_entries", rosterId: roster.id };
  }

  return {
    outcome: "ready",
    roster,
    group: null,
    options: ownedEntries.map((entry) => ({
      value: entry.playerTag,
      label: entry.playerName ?? entry.playerTag,
      description: `${entry.group?.name ?? "Unassigned"} | ${entry.playerTag}`,
    })),
  };
}

function normalizeRosterSelectionTags(selectedTags: string[], allowedTags: string[]): string[] {
  const allowed = new Set(allowedTags);
  return [...new Set(selectedTags.map((tag) => normalizePlayerTag(tag)).filter((tag) => tag && allowed.has(tag)))];
}

function normalizeRosterPlayerTags(input: string[]): string[] {
  return [...new Set(input.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
}

async function loadRosterPlayerTownHallMap(input: {
  rosterType: string;
  clanTag: string | null;
  playerTags: string[];
  allowLiveFetch?: boolean;
  cocService?: CoCService | null;
}): Promise<Map<string, number>> {
  const normalizedTags = [...new Set(input.playerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  if (normalizedTags.length <= 0) {
    return new Map();
  }

  const normalizedRosterType = normalizeRosterType(input.rosterType);
  const result = new Map<string, number>();
  const missingAfterPrimary = new Set(normalizedTags);

  if (normalizedRosterType === "CWL" && input.clanTag) {
    const rosterEntries = await cwlStateService.listSeasonRosterForClan({ clanTag: input.clanTag });
    for (const entry of rosterEntries) {
      const playerTag = normalizePlayerTag(entry.playerTag);
      const townHall = normalizeRosterInt(entry.townHall);
      if (!playerTag || townHall === null || !missingAfterPrimary.has(playerTag)) continue;
      result.set(playerTag, townHall);
      missingAfterPrimary.delete(playerTag);
    }
  } else if (normalizedRosterType === "FWA") {
    const rows = await prisma.fwaPlayerCatalog.findMany({
      where: { playerTag: { in: normalizedTags } },
      select: {
        playerTag: true,
        latestTownHall: true,
      },
    });
    for (const row of rows) {
      const playerTag = normalizePlayerTag(row.playerTag);
      const townHall = normalizeRosterInt(row.latestTownHall);
      if (!playerTag || townHall === null || !missingAfterPrimary.has(playerTag)) continue;
      result.set(playerTag, townHall);
      missingAfterPrimary.delete(playerTag);
    }
  }

  if (missingAfterPrimary.size <= 0) {
    return result;
  }

  const missingTagsAfterPrimary = [...missingAfterPrimary];
  const snapshotRows = await todoSnapshotService.listSnapshotsByPlayerTags({
    playerTags: missingTagsAfterPrimary,
  });
  for (const row of snapshotRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const townHall = normalizeRosterInt((row as { townHall?: unknown }).townHall ?? null);
    if (!playerTag || townHall === null || !missingAfterPrimary.has(playerTag)) continue;
    result.set(playerTag, townHall);
    missingAfterPrimary.delete(playerTag);
  }

  if (!input.allowLiveFetch || missingAfterPrimary.size <= 0) {
    return result;
  }

  const cocService = input.cocService ?? null;
  if (!cocService) {
    return result;
  }

  await todoSnapshotService.refreshSnapshotsForPlayerTags({
    playerTags: [...missingAfterPrimary],
    cocService,
  });
  const refreshedRows = await todoSnapshotService.listSnapshotsByPlayerTags({
    playerTags: [...missingAfterPrimary],
  });
  for (const row of refreshedRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const townHall = normalizeRosterInt((row as { townHall?: unknown }).townHall ?? null);
    if (!playerTag || townHall === null || !missingAfterPrimary.has(playerTag)) continue;
    result.set(playerTag, townHall);
    missingAfterPrimary.delete(playerTag);
  }

  return result;
}

type RosterTownHallResolution = {
  townHallByTag: Map<string, number>;
  missingTags: string[];
};

async function resolveRosterPlayerTownHallMap(input: {
  rosterType: string;
  clanTag: string | null;
  playerTags: string[];
  allowLiveFetch?: boolean;
  cocService?: CoCService | null;
}): Promise<RosterTownHallResolution> {
  const normalizedTags = [...new Set(input.playerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  if (normalizedTags.length <= 0) {
    return { townHallByTag: new Map(), missingTags: [] };
  }

  const townHallByTag = await loadRosterPlayerTownHallMap({
    rosterType: input.rosterType,
    clanTag: input.clanTag,
    playerTags: normalizedTags,
    allowLiveFetch: Boolean(input.cocService),
    cocService: input.cocService ?? null,
  });
  const missingTags = normalizedTags.filter((tag) => !townHallByTag.has(tag));
  return { townHallByTag, missingTags };
}

function buildRosterManagerGroupSummaryLine(group: RosterGroupRecord & { signupCount: number }): string {
  return `${group.name} (${group.signupCount})`;
}

function buildRosterManagerMemberLine(entry: RosterManagerTrackedClanMemberRecord): string {
  const discordLabel = entry.linkedDiscordUserId ? ` <@${entry.linkedDiscordUserId}>` : "";
  return `- ${entry.playerName} \`${entry.playerTag}\`${discordLabel}`;
}

async function loadCurrentCwlRosterManagerMembers(clanTag: string): Promise<Array<{
  playerTag: string;
  playerName: string;
  townHall: number | null;
}>> {
  const currentClanRows = await todoSnapshotService.listSnapshotsByClanTag({
    clanTag,
    source: "cwlClanTag",
  });
  if (currentClanRows.length <= 0) {
    return [];
  }

  return currentClanRows.map((member) => ({
    playerTag: member.playerTag,
    playerName: member.playerName,
    townHall: member.townHall,
  }));
}

async function loadRosterManagerTrackedClanMembers(roster: RosterRecord): Promise<RosterManagerTrackedClanMemberRecord[]> {
  const trackedClanTag = normalizeClanTag(roster.clanTag ?? "");
  if (!trackedClanTag) return [];

  const rawMembers =
    roster.rosterType === "FWA"
      ? await prisma.fwaClanMemberCurrent.findMany({
          where: { clanTag: trackedClanTag },
          orderBy: [{ playerName: "asc" }, { playerTag: "asc" }],
          select: {
            playerTag: true,
            playerName: true,
            townHall: true,
          },
        })
      : roster.rosterType === "CWL"
        ? await loadCurrentCwlRosterManagerMembers(trackedClanTag)
        : [];

  if (rawMembers.length <= 0) {
    return [];
  }

  const links = await listPlayerLinksForClanMembers({
    memberTagsInOrder: rawMembers.map((member) => member.playerTag),
  });
  const linkByTag = new Map(links.map((link) => [link.playerTag, link] as const));
  return rawMembers.map((member) => {
    const link = linkByTag.get(member.playerTag) ?? null;
    return {
      playerTag: member.playerTag,
      playerName: normalizeRosterText(member.playerName) ?? member.playerTag,
      townHall: Number.isFinite(Number(member.townHall)) ? Math.trunc(Number(member.townHall)) : null,
      linkedDiscordUserId: link?.discordUserId ?? null,
      linkedDiscordUsername: link?.discordUsername ?? null,
    };
  });
}

function buildRosterManagerReadinessLines(view: RosterManagerReadinessView): string[] {
  const lines: string[] = [
    `${view.roster.title}`,
    `State: ${buildRosterStateLabel(view.roster.lifecycleState)}`,
    `Clan: ${view.roster.clanTag ?? "unscoped"}`,
    `Posted message: ${view.roster.postedMessageUrl ?? "not posted"}`,
    `Signed up: ${view.signupView.totalSignupCount}`,
    `Current clan members: ${view.trackedClanRoster.length}`,
    `Unregistered members: ${view.unsignedTrackedMembers.length}`,
    `Out-of-clan signups: ${view.signedUpButUntracked.length}`,
  ];

  lines.push("");
  lines.push("Groups:");
  const groupedSignups = buildRosterGroupsWithSignups(view.signupView);
  if (groupedSignups.length <= 0) {
    lines.push("- None");
  } else {
    for (const group of groupedSignups) {
      lines.push(`- ${buildRosterManagerGroupSummaryLine(group)}`);
      if (group.signups.length <= 0) {
        lines.push("  - None yet");
        continue;
      }
      for (const signup of group.signups) {
        lines.push(`  ${buildRosterSignupEntryLine(signup)}`);
      }
    }
  }

  lines.push("");
  lines.push("Unregistered members:");
  if (view.unsignedTrackedMembers.length <= 0) {
    lines.push("- None");
  } else {
    lines.push(...view.unsignedTrackedMembers.map((entry) => buildRosterManagerMemberLine(entry)));
  }

  lines.push("");
  lines.push("Out-of-clan signups:");
  if (view.signedUpButUntracked.length <= 0) {
    lines.push("- None");
  } else {
    lines.push(...view.signedUpButUntracked.map((signup) => buildRosterSignupEntryLine(signup)));
  }

  return lines;
}

function buildRosterGroupsWithSignups(view: RosterSignupView): Array<
  RosterGroupRecord & {
    signupCount: number;
    signups: RosterSignupViewRecord[];
  }
> {
  const signupsByGroupId = new Map<string, RosterSignupViewRecord[]>();
  for (const signup of view.signups) {
    const groupId = signup.group?.id ?? signup.groupId ?? null;
    const key = groupId ?? "__ungrouped__";
    const list = signupsByGroupId.get(key) ?? [];
    list.push(signup);
    signupsByGroupId.set(key, list);
  }

  return view.groups.map((group) => ({
    ...group,
    signupCount: signupsByGroupId.get(group.id)?.length ?? 0,
    signups: signupsByGroupId.get(group.id) ?? [],
  }));
}

function normalizeRosterPostButtonMode(input: unknown): RosterPostButtonMode {
  const value = normalizeRosterText(typeof input === "string" ? input : null);
  if (value === "hidden") return "hidden";
  if (value === "archived") return "archived";
  return "standard";
}

const ROSTER_BOARD_COLUMN_LIMITS = {
  th: 2,
  player: 12,
  discord: 12,
  clan: 12,
} as const;

function sanitizeRosterBoardText(input: string | null | undefined): string {
  return (normalizeRosterText(input ?? null) ?? "").replace(/`/g, "'");
}

function formatRosterBoardCell(input: string | null | undefined, width: number): string {
  const value = sanitizeRosterBoardText(input) || "-";
  const trimmed = value.length > width ? value.slice(0, width) : value;
  return trimmed.padEnd(width, " ");
}

function buildClanProfileMarkdownLink(clanName: string | null, clanTag: string | null): string {
  const normalizedClanTag = normalizeClanTag(clanTag ?? "");
  const label = sanitizeRosterBoardText(clanName) || normalizedClanTag || "Unknown Clan";
  if (!normalizedClanTag) return label;
  const encodedTag = normalizedClanTag.replace(/^#/, "");
  return `[${label}](https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodedTag})`;
}

function measureRosterBoardColumnWidths(signups: RosterSignupViewRecord[]): {
  th: number;
  player: number;
  discord: number;
  clan: number;
} {
  const playerWidth = signups.reduce(
    (max, signup) => Math.max(max, sanitizeRosterBoardText(signup.playerName || signup.playerTag).length),
    "Player".length,
  );
  const discordWidth = signups.reduce(
    (max, signup) => Math.max(max, sanitizeRosterBoardText(signup.discordUsername).length),
    "Discord".length,
  );
  const clanWidth = signups.reduce(
    (max, signup) =>
      Math.max(max, sanitizeRosterBoardText(signup.clanName || signup.clanTag || "-").length),
    "Clan".length,
  );
  return {
    th: ROSTER_BOARD_COLUMN_LIMITS.th,
    player: Math.min(playerWidth, ROSTER_BOARD_COLUMN_LIMITS.player),
    discord: Math.min(discordWidth, ROSTER_BOARD_COLUMN_LIMITS.discord),
    clan: Math.min(clanWidth, ROSTER_BOARD_COLUMN_LIMITS.clan),
  };
}

function buildRosterBoardLine(
  columns: {
    th: string;
    player: string;
    discord: string | null;
    clan: string;
  },
  widths: {
    th: number;
    player: number;
    discord: number;
    clan: number;
  },
): string {
  const th = formatRosterBoardCell(columns.th, widths.th);
  const player = formatRosterBoardCell(columns.player, widths.player);
  const discord = formatRosterBoardCell(columns.discord, widths.discord);
  const clan = formatRosterBoardCell(columns.clan, widths.clan);
  return `${th} ${player} ${discord} ${clan}`.trimEnd();
}

function buildRosterBoardHeaderLine(widths: {
  th: number;
  player: number;
  discord: number;
  clan: number;
}): string {
  return buildRosterBoardLine(
    {
      th: "TH",
      player: "Player",
      discord: "Discord",
      clan: "Clan",
    },
    widths,
  );
}

function buildRosterBoardRowLine(
  signup: RosterSignupViewRecord,
  widths: {
    th: number;
    player: number;
    discord: number;
    clan: number;
  },
): string {
  return buildRosterBoardLine(
    {
      th: signup.townHall === null ? "-" : String(signup.townHall),
      player: signup.playerName || signup.playerTag,
      discord: signup.discordUsername,
      clan: signup.clanName || signup.clanTag || "-",
    },
    widths,
  );
}

function buildRosterBoardRowLines(
  signups: RosterSignupViewRecord[],
  widths: {
    th: number;
    player: number;
    discord: number;
    clan: number;
  },
): string[] {
  if (signups.length <= 0) {
    return ["`- None`"];
  }
  return signups.map((signup) => `\`${buildRosterBoardRowLine(signup, widths)}\``);
}

function buildRosterSignupPayloadFromView(view: RosterSignupView): RosterSignupPayload {
  const title = normalizeRosterText(view.clanDisplayName ?? null) ?? normalizeClanTag(view.roster.clanTag ?? "") ?? "Roster";
  const groups = buildRosterGroupsWithSignups(view);
  const widths = measureRosterBoardColumnWidths(groups.flatMap((group) => group.signups));
  const rosterLabel = `## ${buildClanProfileMarkdownLink(view.roster.title || "Roster Signup", view.roster.clanTag)} ${
    view.clanLeagueLabel ?? view.roster.rosterType
  }`.trim();
  const maxMembersLabel = view.roster.maxMembers === null || view.roster.maxMembers === undefined ? "-" : String(view.roster.maxMembers);
  const minTownHallLabel = view.roster.minTownhall === null || view.roster.minTownhall === undefined ? "##" : String(view.roster.minTownhall);
  const lines: string[] = [
    rosterLabel,
    "",
    `\`${buildRosterBoardHeaderLine(widths)}\``,
  ];

  for (const group of groups) {
    lines.push(`**${group.name} - ${group.signupCount}**`);
    lines.push(...buildRosterBoardRowLines(group.signups, widths));
    lines.push("");
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }
  lines.push("");
  lines.push(`Total ${view.totalSignupCount}/${maxMembersLabel} | Min. TH ${minTownHallLabel}`);

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(title)
    .setDescription(truncateDiscordContent(lines.join("\n"), 4096));

  const buttonMode = normalizeRosterPostButtonMode(view.roster.postButtonMode);
  const buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (buttonMode !== "archived") {
    const rowButtons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId(buildRosterPostActionButtonCustomId("refresh", view.roster.id))
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary),
    ];
    if (buttonMode === "standard") {
      rowButtons.push(
        new ButtonBuilder()
          .setCustomId(buildRosterPostActionButtonCustomId("signup", view.roster.id))
          .setLabel("Signup")
          .setStyle(ButtonStyle.Success)
          .setDisabled(
            view.roster.lifecycleState === ROSTER_LIFECYCLE_STATE.CLOSED ||
              view.roster.lifecycleState === ROSTER_LIFECYCLE_STATE.ARCHIVED,
          ),
        new ButtonBuilder()
          .setCustomId(buildRosterPostActionButtonCustomId("optout", view.roster.id))
          .setLabel("Opt-out")
          .setStyle(ButtonStyle.Danger),
      );
    }
    rowButtons.push(
      new ButtonBuilder()
        .setCustomId(buildRosterPostActionButtonCustomId("settings", view.roster.id))
        .setEmoji("⚙️")
        .setStyle(ButtonStyle.Secondary),
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons);
    buttonRows.push(row);
  }

  return { embed, components: buttonRows };
}

async function loadRosterView(rosterId: string): Promise<RosterSignupView | null> {
  const roster = await prisma.roster.findUnique({
    where: { id: rosterId },
    select: {
      id: true,
      guildId: true,
      rosterType: true,
      rosterCategory: true,
      title: true,
      clanTag: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      displayTimezone: true,
      maxMembers: true,
      maxAccountsPerUser: true,
      minTownhall: true,
      maxTownhall: true,
      rosterRoleId: true,
      allowMultiSignup: true,
      sortBy: true,
      importMembers: true,
      postButtonMode: true,
      lifecycleState: true,
      postedChannelId: true,
      postedMessageId: true,
      postedMessageUrl: true,
      postedAt: true,
      createdByDiscordUserId: true,
      updatedByDiscordUserId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!roster) return null;

  const groups = await prisma.rosterGroup.findMany({
    where: { rosterId: roster.id },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      sortOrder: true,
    },
  });
  const signups = await prisma.rosterSignup.findMany({
    where: { rosterId: roster.id },
    select: {
      id: true,
      rosterId: true,
      groupId: true,
      playerTag: true,
      playerName: true,
      discordUserId: true,
      signedUpAt: true,
      createdAt: true,
      updatedAt: true,
      group: {
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          sortOrder: true,
        },
      },
    },
  });
  const townHallByTag = await loadRosterPlayerTownHallMap({
    rosterType: roster.rosterType,
    clanTag: roster.clanTag,
    playerTags: signups.map((signup) => signup.playerTag),
    allowLiveFetch: false,
  });
  const snapshotRows = await todoSnapshotService.listSnapshotsByPlayerTags({
    playerTags: signups.map((signup) => signup.playerTag),
  });
  const currentClanRows =
    roster.clanTag && roster.rosterType === "CWL"
      ? await todoSnapshotService.listSnapshotsByClanTag({
          clanTag: roster.clanTag,
          source: "cwlClanTag",
        })
      : roster.clanTag
        ? await todoSnapshotService.listSnapshotsByClanTag({
            clanTag: roster.clanTag,
            source: "clanTag",
          })
        : [];
  const linkedPlayerRows = await prisma.playerLink.findMany({
    where: {
      playerTag: { in: signups.map((signup) => normalizePlayerTag(signup.playerTag)).filter(Boolean) },
    },
    select: {
      playerTag: true,
      discordUsername: true,
    },
  });
  const discordUsernameByTag = new Map(
    linkedPlayerRows
      .map((row) => [normalizePlayerTag(row.playerTag), normalizeRosterText(row.discordUsername ?? null)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0])),
  );
  const snapshotByTag = new Map(snapshotRows.map((row) => [normalizePlayerTag(row.playerTag), row] as const));
  const currentClanName =
    currentClanRows.find((row) => normalizeRosterText(row.cwlClanName ?? row.clanName ?? null))
      ?.cwlClanName ??
    currentClanRows.find((row) => normalizeRosterText(row.clanName ?? null))?.clanName ??
    snapshotRows.find((row) => normalizeRosterText(row.clanName ?? null))?.clanName ??
    null;
  const trackedClan =
    roster.rosterType === "CWL" && roster.clanTag
      ? await prisma.cwlTrackedClan.findFirst({
          where: {
            season: resolveCurrentCwlSeasonKey(),
            tag: normalizeClanTag(roster.clanTag),
          },
          select: {
            name: true,
          },
        })
      : null;
  const signupsWithTownHall = signups.map((signup) => ({
    ...signup,
    townHall: townHallByTag.get(normalizePlayerTag(signup.playerTag)) ?? null,
    discordUsername: discordUsernameByTag.get(normalizePlayerTag(signup.playerTag)) ?? null,
    clanTag: snapshotByTag.get(normalizePlayerTag(signup.playerTag))?.clanTag ?? null,
    clanName: snapshotByTag.get(normalizePlayerTag(signup.playerTag))?.clanName ?? null,
  }));
  const clanDisplayName =
    normalizeRosterText(currentClanName ?? null) ??
    normalizeRosterText(trackedClan?.name ?? null) ??
    null;
  const sortedSignups = sortRosterSignupsForRoster(signupsWithTownHall, roster.sortBy);
  const signupCountByGroupId = new Map<string, number>();
  for (const signup of sortedSignups) {
    if (!signup.groupId) continue;
    signupCountByGroupId.set(signup.groupId, (signupCountByGroupId.get(signup.groupId) ?? 0) + 1);
  }

  return {
    roster,
    clanDisplayName,
    clanLeagueLabel: null,
    groups: groups.map((group) => ({
      ...group,
      signupCount: signupCountByGroupId.get(group.id) ?? 0,
    })),
    signups: sortedSignups.map((signup) => ({
      id: signup.id,
      rosterId: signup.rosterId,
      groupId: signup.groupId,
      playerTag: signup.playerTag,
      playerName: signup.playerName,
      discordUserId: signup.discordUserId,
      signedUpAt: signup.signedUpAt,
      createdAt: signup.createdAt,
      updatedAt: signup.updatedAt,
      townHall: signup.townHall,
      discordUsername: signup.discordUsername,
      clanTag: signup.clanTag,
      clanName: signup.clanName,
      group: signup.group
        ? {
            id: signup.group.id,
            key: signup.group.key,
            name: signup.group.name,
            description: signup.group.description,
            sortOrder: signup.group.sortOrder,
          }
        : null,
    })),
    totalSignupCount: sortedSignups.length,
  };
}

async function getRosterGroupByKey(input: {
  rosterId: string;
  groupKey: string;
}): Promise<RosterGroupRecord | null> {
  const groupKey = normalizeRosterGroupKey(input.groupKey);
  if (!groupKey) return null;

  const group = await prisma.rosterGroup.findFirst({
    where: {
      rosterId: input.rosterId,
      key: groupKey,
    },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      sortOrder: true,
    },
  });
  return group;
}

export function buildRosterSignupButtonCustomId(rosterId: string): string {
  return buildRosterPostActionButtonCustomId("signup", rosterId);
}

export function buildRosterRemoveButtonCustomId(rosterId: string): string {
  return buildRosterPostActionButtonCustomId("optout", rosterId);
}

export function isRosterSignupButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_ACTION_PREFIX}:signup:`);
}

export function isRosterRemoveButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_ACTION_PREFIX}:optout:`);
}

export function isRosterPostRefreshButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_ACTION_PREFIX}:refresh:`);
}

export function isRosterPostSettingsButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_ACTION_PREFIX}:settings:`);
}

export function parseRosterSignupButtonCustomId(customId: string): { rosterId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_POST_ACTION_PREFIX || parts[1] !== "signup") {
    return null;
  }
  const rosterId = parts[2]?.trim() ?? "";
  return rosterId ? { rosterId } : null;
}

export function parseRosterRemoveButtonCustomId(customId: string): { rosterId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_POST_ACTION_PREFIX || parts[1] !== "optout") {
    return null;
  }
  const rosterId = parts[2]?.trim() ?? "";
  return rosterId ? { rosterId } : null;
}

export function parseRosterPostRefreshButtonCustomId(customId: string): { rosterId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_POST_ACTION_PREFIX || parts[1] !== "refresh") {
    return null;
  }
  const rosterId = parts[2]?.trim() ?? "";
  return rosterId ? { rosterId } : null;
}

export function parseRosterPostSettingsButtonCustomId(customId: string): { rosterId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_POST_ACTION_PREFIX || parts[1] !== "settings") {
    return null;
  }
  const rosterId = parts[2]?.trim() ?? "";
  return rosterId ? { rosterId } : null;
}

export function isRosterPostSettingsMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_SETTINGS_PREFIX}:`);
}

export function parseRosterPostSettingsMenuCustomId(customId: string): { rosterId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 2 || parts[0] !== ROSTER_POST_SETTINGS_PREFIX) {
    return null;
  }
  const rosterId = parts[1]?.trim() ?? "";
  return rosterId ? { rosterId } : null;
}

export function isRosterSelectionMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_SELECTION_PREFIX}:account:`);
}

export function isRosterSelectionGroupMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_SELECTION_PREFIX}:group:`);
}

export function isRosterSelectionActionButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_SELECTION_PREFIX}:action:`);
}

export function parseRosterSelectionMenuCustomId(customId: string): { sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_SELECTION_PREFIX || parts[1] !== "account") {
    return null;
  }
  const sessionId = parts[2]?.trim() ?? "";
  return sessionId ? { sessionId } : null;
}

export function parseRosterSelectionGroupMenuCustomId(customId: string): { sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_SELECTION_PREFIX || parts[1] !== "group") {
    return null;
  }
  const sessionId = parts[2]?.trim() ?? "";
  return sessionId ? { sessionId } : null;
}

export function parseRosterSelectionActionButtonCustomId(
  customId: string,
): { action: "confirm" | "cancel"; sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== ROSTER_SELECTION_PREFIX || parts[1] !== "action") {
    return null;
  }
  const action = parts[2];
  if (action !== "confirm" && action !== "cancel") {
    return null;
  }
  const sessionId = parts[3]?.trim() ?? "";
  return sessionId ? { action, sessionId } : null;
}

export class RosterService {
  async createRoster(input: CreateRosterInput): Promise<RosterRecord> {
    const guildId = String(input.guildId ?? "").trim();
    const rosterType = normalizeRosterType(input.rosterType);
    if (!isSupportedRosterType(rosterType)) {
      throw new Error(`Unsupported roster category: ${rosterType || "unknown"}`);
    }
    const title = normalizeRosterTitle(input.name ?? input.title ?? "");
    if (!title) {
      throw new Error("Roster name is required.");
    }
    const timezone = normalizeRosterDisplayTimezone(input.timezone) ?? "UTC";
    const displayTimezone =
      normalizeRosterDisplayTimezone(input.displayTimezone) ?? timezone;
    const clanTag = input.clanTag ? normalizeClanTag(input.clanTag) : null;
    const rosterCategory = normalizeRosterCategory(input.rosterCategory);
    const maxMembers = normalizeRosterInt(input.maxMembers);
    const maxAccountsPerUser = normalizeRosterInt(input.maxAccountsPerUser);
    const minTownhall = normalizeRosterInt(input.minTownhall);
    const maxTownhall = normalizeRosterInt(input.maxTownhall);
    const rosterRoleId = normalizeRosterRoleId(input.rosterRoleId);
    const allowMultiSignup = input.allowMultiSignup !== false;
    const sortBy = normalizeRosterSortBy(input.sortBy);
    const importMembers = Boolean(input.importMembers);
    const lifecycleState = input.lifecycleState ?? ROSTER_LIFECYCLE_STATE.OPEN;
    const startsAt = input.startsAt ?? new Date();
    const endsAt = input.endsAt ?? null;
    const createdByDiscordUserId = normalizeDiscordUserId(input.createdByDiscordUserId);
    const updatedByDiscordUserId = normalizeDiscordUserId(input.updatedByDiscordUserId);
    const seedGroups = (Array.isArray(input.groups) && input.groups.length > 0
      ? input.groups
      : [...ROSTER_DEFAULT_GROUPS]
    ).map((group, index) => ({
      key: normalizeRosterGroupKey(group.key),
      name: normalizeRosterTitle(group.name),
      description: normalizeRosterText(group.description),
      sortOrder: Math.trunc(Number(group.sortOrder ?? index) || index),
    }));
    const groups = [...new Map(seedGroups.filter((group) => group.key).map((group) => [group.key, group])).values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    const created = await prisma.$transaction(async (tx) => {
      const roster = await tx.roster.create({
        data: {
          guildId,
          rosterType,
          rosterCategory,
          title,
          clanTag,
          startsAt,
          endsAt,
          timezone,
          displayTimezone,
          maxMembers,
          maxAccountsPerUser,
          minTownhall,
          maxTownhall,
          rosterRoleId,
          allowMultiSignup,
          sortBy,
          importMembers,
          lifecycleState,
          createdByDiscordUserId,
          updatedByDiscordUserId,
        },
      });

      if (groups.length > 0) {
        await tx.rosterGroup.createMany({
          data: groups.map((group) => ({
            rosterId: roster.id,
            key: group.key,
            name: group.name,
            description: group.description,
            sortOrder: group.sortOrder,
          })),
        });
      }

      return tx.roster.findUnique({
        where: { id: roster.id },
      });
    });

    if (!created) {
      throw new Error("Failed to create roster.");
    }

    const roster = mapRosterRecord(created);
    if (importMembers) {
      await this.importRosterMembers({ rosterId: roster.id });
    }
    return roster;
  }

  async recordRosterPostedMessage(input: {
    rosterId: string;
    channelId: string;
    messageId: string;
    messageUrl: string;
    postedByDiscordUserId?: string | null;
    postedAt?: Date | null;
  }): Promise<void> {
    await prisma.roster.update({
      where: { id: input.rosterId },
      data: {
        postedChannelId: String(input.channelId ?? "").trim(),
        postedMessageId: String(input.messageId ?? "").trim(),
        postedMessageUrl: String(input.messageUrl ?? "").trim(),
        postedAt: input.postedAt ?? new Date(),
        updatedByDiscordUserId: normalizeDiscordUserId(input.postedByDiscordUserId),
      },
    });
  }

  async buildRosterSignupPayload(rosterId: string, _cocService?: CoCService | null): Promise<RosterSignupPayload | null> {
    const view = await loadRosterView(rosterId);
    if (!view) return null;
    return buildRosterSignupPayloadFromView(view);
  }

  async refreshRosterSignupPayload(rosterId: string, cocService?: CoCService | null): Promise<RosterSignupPayload | null> {
    const roster = await prisma.roster.findUnique({
      where: { id: rosterId },
      select: {
        id: true,
      },
    });
    if (!roster) return null;

    if (cocService) {
      const rosteredTags = await prisma.rosterSignup.findMany({
        where: { rosterId: roster.id },
        select: { playerTag: true },
      });
      const playerTags = [...new Set(rosteredTags.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean))];
      if (playerTags.length > 0) {
        await todoSnapshotService.refreshSnapshotsForPlayerTags({
          playerTags,
          cocService,
        });
      }
    }

    return this.buildRosterSignupPayload(rosterId, cocService ?? null);
  }

  async getRosterView(rosterId: string, _cocService?: CoCService | null): Promise<RosterSignupView | null> {
    return loadRosterView(rosterId);
  }

  async getRosterRoleSyncTargets(input: {
    rosterId: string;
  }): Promise<{
    roster: RosterRecord;
    rosterRoleId: string;
    discordUserIds: string[];
  } | null> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        ...ROSTER_RECORD_SELECT,
      },
    });
    if (!roster) {
      return null;
    }

    const mappedRoster = mapRosterRecord(roster);
    if (!mappedRoster.rosterRoleId) {
      return null;
    }

    const signups = await prisma.rosterSignup.findMany({
      where: { rosterId: mappedRoster.id },
      select: {
        discordUserId: true,
      },
    });
    const discordUserIds = [
      ...new Set(
        signups
          .map((signup) => normalizeDiscordUserId(signup.discordUserId))
          .filter((discordUserId): discordUserId is string => Boolean(discordUserId)),
      ),
    ];

    return {
      roster: mappedRoster,
      rosterRoleId: mappedRoster.rosterRoleId,
      discordUserIds,
    };
  }

  async findGuildRosterById(input: {
    guildId: string;
    rosterId: string;
  }): Promise<RosterRecord | null> {
    const guildId = String(input.guildId ?? "").trim();
    const rosterId = String(input.rosterId ?? "").trim();
    if (!guildId || !rosterId) {
      return null;
    }

    const roster = await prisma.roster.findFirst({
      where: {
        id: rosterId,
        guildId,
      },
      select: ROSTER_RECORD_SELECT,
    });
    return roster ? mapRosterRecord(roster) : null;
  }

  async listGuildRosters(input: {
    guildId: string;
    name?: string | null;
    user?: string | null;
    player?: string | null;
    clan?: string | null;
    limit?: number | null;
  }): Promise<RosterSummaryRecord[]> {
    const guildId = String(input.guildId ?? "").trim();
    if (!guildId) {
      return [];
    }

    const name = normalizeRosterText(input.name);
    const player = normalizeRosterText(input.player);
    const clan = normalizeClanTag(input.clan ?? "");
    const user = normalizeDiscordUserId(input.user ?? "");
    const where: any = { guildId };
    const andConditions: any[] = [];
    if (name) {
      andConditions.push({
        title: {
          contains: name,
          mode: "insensitive",
        },
      });
    }
    if (clan) {
      andConditions.push({
        clanTag: {
          contains: clan,
          mode: "insensitive",
        },
      });
    }
    if (user) {
      andConditions.push({
        signups: {
          some: {
            discordUserId: user,
          },
        },
      });
    }
    if (player) {
      andConditions.push({
        signups: {
          some: {
            OR: [
              {
                playerTag: {
                  contains: player,
                  mode: "insensitive",
                },
              },
              {
                playerName: {
                  contains: player,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
      });
    }
    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const rosterRows = await prisma.roster.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: Math.max(1, Math.min(25, Math.trunc(Number(input.limit ?? 25) || 25))),
      select: {
        ...ROSTER_RECORD_SELECT,
        _count: {
          select: {
            groups: true,
            signups: true,
          },
        },
      },
    });

    return rosterRows.map((row) => mapRosterSummaryRecord(row as RosterRecordLike & { _count: { groups: number; signups: number } }));
  }

  async updateRoster(input: {
    rosterId: string;
    title?: string | null;
    name?: string | null;
    rosterType?: string | null;
    rosterCategory?: string | null;
    clanTag?: string | null;
    timezone?: string | null;
    displayTimezone?: string | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
    maxMembers?: number | null;
    maxAccountsPerUser?: number | null;
    minTownhall?: number | null;
    maxTownhall?: number | null;
    rosterRoleId?: string | null;
    allowMultiSignup?: boolean | null;
    sortBy?: string | null;
    importMembers?: boolean | null;
    lifecycleState?: RosterLifecycleState | null;
    updatedByDiscordUserId?: string | null;
  }): Promise<RosterRecord | null> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
      },
    });
    if (!roster) {
      return null;
    }

    const data: any = {};
    if ((input.name !== undefined && input.name !== null) || (input.title !== undefined && input.title !== null)) {
      data.title = normalizeRosterTitle(input.name ?? input.title ?? "");
    }
    if (input.clanTag !== undefined) {
      data.clanTag = input.clanTag ? normalizeClanTag(input.clanTag) : null;
    }
    if (input.rosterType !== undefined && input.rosterType !== null) {
      const normalizedType = normalizeRosterType(input.rosterType);
      if (!isSupportedRosterType(normalizedType)) {
        throw new Error(`Unsupported roster category: ${normalizedType || "unknown"}`);
      }
      data.rosterType = normalizedType;
    }
    if (input.rosterCategory !== undefined) {
      data.rosterCategory = normalizeRosterCategory(input.rosterCategory);
    }
    if (input.timezone !== undefined) {
      const normalizedTimezone = normalizeRosterDisplayTimezone(input.timezone) ?? "UTC";
      data.timezone = normalizedTimezone;
      if (input.displayTimezone === undefined) {
        data.displayTimezone = normalizedTimezone;
      }
    }
    if (input.displayTimezone !== undefined) {
      data.displayTimezone = normalizeRosterDisplayTimezone(input.displayTimezone);
    }
    if (input.startsAt !== undefined) {
      data.startsAt = input.startsAt;
    }
    if (input.endsAt !== undefined) {
      data.endsAt = input.endsAt;
    }
    if (input.maxMembers !== undefined) {
      data.maxMembers = normalizeRosterInt(input.maxMembers);
    }
    if (input.maxAccountsPerUser !== undefined) {
      data.maxAccountsPerUser = normalizeRosterInt(input.maxAccountsPerUser);
    }
    if (input.minTownhall !== undefined) {
      data.minTownhall = normalizeRosterInt(input.minTownhall);
    }
    if (input.maxTownhall !== undefined) {
      data.maxTownhall = normalizeRosterInt(input.maxTownhall);
    }
    if (input.rosterRoleId !== undefined) {
      data.rosterRoleId = normalizeRosterRoleId(input.rosterRoleId);
    }
    if (input.allowMultiSignup !== undefined && input.allowMultiSignup !== null) {
      data.allowMultiSignup = Boolean(input.allowMultiSignup);
    }
    if (input.sortBy !== undefined) {
      data.sortBy = normalizeRosterSortBy(input.sortBy);
    }
    if (input.importMembers !== undefined && input.importMembers !== null) {
      data.importMembers = Boolean(input.importMembers);
    }
    if (input.lifecycleState !== undefined && input.lifecycleState !== null) {
      data.lifecycleState = input.lifecycleState;
    }
    if (input.updatedByDiscordUserId !== undefined) {
      data.updatedByDiscordUserId = normalizeDiscordUserId(input.updatedByDiscordUserId);
    }

    const updated = await prisma.roster.update({
      where: { id: roster.id },
      data,
      select: ROSTER_RECORD_SELECT,
    });
    const mapped = mapRosterRecord(updated);
    if (input.importMembers) {
      await this.importRosterMembers({ rosterId: mapped.id });
    }
    return mapped;
  }

  async deleteRoster(input: {
    rosterId: string;
  }): Promise<
    | {
        outcome: "deleted";
        roster: RosterRecord;
      }
    | {
        outcome: "roster_not_found";
        rosterId: string;
      }
  > {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: ROSTER_RECORD_SELECT,
    });
    if (!roster) {
      return {
        outcome: "roster_not_found",
        rosterId: input.rosterId,
      };
    }

    await prisma.roster.delete({
      where: { id: roster.id },
    });

    return {
      outcome: "deleted",
      roster: mapRosterRecord(roster),
    };
  }

  async importRosterMembers(input: { rosterId: string }): Promise<{
    importedCount: number;
    skippedCount: number;
  }> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
        rosterType: true,
        rosterCategory: true,
        clanTag: true,
        importMembers: true,
      },
    });
    if (!roster || !roster.importMembers || !roster.clanTag) {
      return { importedCount: 0, skippedCount: 0 };
    }

    const defaultGroup = await prisma.rosterGroup.findFirst({
      where: { rosterId: roster.id },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        sortOrder: true,
      },
    });
    if (!defaultGroup) {
      return { importedCount: 0, skippedCount: 0 };
    }

    const candidateGroups = new Map<string, string[]>();
    if (roster.rosterType === "CWL") {
      const entries = await cwlStateService.listSeasonRosterForClan({ clanTag: roster.clanTag });
      for (const entry of entries) {
        if (!entry.linkedDiscordUserId) continue;
        const playerTag = normalizePlayerTag(entry.playerTag);
        if (!playerTag) continue;
        const existing = candidateGroups.get(entry.linkedDiscordUserId) ?? [];
        existing.push(playerTag);
        candidateGroups.set(entry.linkedDiscordUserId, existing);
      }
    } else if (roster.rosterType === "FWA") {
      const rows = await prisma.fwaClanMemberCurrent.findMany({
        where: { clanTag: roster.clanTag },
        select: {
          playerTag: true,
          playerName: true,
        },
      });
      const linkedRows = rows.length > 0
        ? await prisma.playerLink.findMany({
            where: {
              playerTag: { in: rows.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean) },
              discordUserId: { not: null },
            },
            select: {
              playerTag: true,
              discordUserId: true,
            },
          })
        : [];
      const discordUserIdByTag = new Map(
        linkedRows
          .map((row) => [normalizePlayerTag(row.playerTag), normalizeDiscordUserId(row.discordUserId)] as const)
          .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
      );
      for (const row of rows) {
        const playerTag = normalizePlayerTag(row.playerTag);
        if (!playerTag) continue;
        const discordUserId = discordUserIdByTag.get(playerTag) ?? null;
        if (!discordUserId) continue;
        const existing = candidateGroups.get(discordUserId) ?? [];
        existing.push(playerTag);
        candidateGroups.set(discordUserId, existing);
      }
    }

    let importedCount = 0;
    let skippedCount = 0;
    for (const [discordUserId, playerTags] of candidateGroups.entries()) {
      const result = await this.signupLinkedAccounts({
        rosterId: roster.id,
        groupKey: defaultGroup.key,
        discordUserId,
        playerTags,
      });
      if (result.outcome === "created") {
        importedCount += result.createdTags.length;
      } else if (result.outcome === "already_signed_up") {
        skippedCount += result.duplicateTags.length;
      } else {
        skippedCount += playerTags.length;
      }
    }

    return { importedCount, skippedCount };
  }

  async findCwlRosterForClan(input: {
    guildId: string;
    clanTag: string;
    season?: string;
    includeArchived?: boolean;
  }): Promise<RosterRecord | null> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!guildId || !clanTag) {
      return null;
    }

    const season = String(input.season ?? resolveCurrentCwlSeasonKey()).trim();
    const lifecycleFilter = input.includeArchived
      ? undefined
      : { in: [ROSTER_LIFECYCLE_STATE.OPEN, ROSTER_LIFECYCLE_STATE.CLOSED, ROSTER_LIFECYCLE_STATE.ACTIVE] };

    const select = {
      ...ROSTER_RECORD_SELECT,
    } as const;

    const currentSeasonRoster = await prisma.roster.findFirst({
      where: {
        guildId,
        rosterType: "CWL",
        rosterCategory: "signup",
        clanTag,
        title: { contains: season },
        ...(lifecycleFilter ? { lifecycleState: lifecycleFilter } : {}),
      },
      orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
      select,
    });
    if (currentSeasonRoster) {
      return mapRosterRecord(currentSeasonRoster);
    }

    const fallbackRoster = await prisma.roster.findFirst({
      where: {
        guildId,
        rosterType: "CWL",
        rosterCategory: "signup",
        clanTag,
        ...(lifecycleFilter ? { lifecycleState: lifecycleFilter } : {}),
      },
      orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
      select,
    });
    return fallbackRoster ? mapRosterRecord(fallbackRoster) : null;
  }

  async updateRosterLifecycleState(input: {
    rosterId: string;
    lifecycleState: RosterLifecycleState;
    updatedByDiscordUserId?: string | null;
  }): Promise<RosterLifecycleUpdateResult> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
        rosterType: true,
        clanTag: true,
        minTownhall: true,
        maxTownhall: true,
        lifecycleState: true,
      },
    });
    if (!roster) {
      return { outcome: "roster_not_found", rosterId: input.rosterId };
    }

    await prisma.roster.update({
      where: { id: roster.id },
      data: {
        lifecycleState: input.lifecycleState,
        updatedByDiscordUserId: normalizeDiscordUserId(input.updatedByDiscordUserId),
      },
    });
    return {
      outcome: "updated",
      rosterId: roster.id,
      lifecycleState: input.lifecycleState,
    };
  }

  async updateRosterPostButtonMode(input: {
    rosterId: string;
    postButtonMode: RosterPostButtonMode;
    updatedByDiscordUserId?: string | null;
  }): Promise<{ outcome: "updated" | "roster_not_found"; rosterId: string; postButtonMode?: RosterPostButtonMode }> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
      },
    });
    if (!roster) {
      return { outcome: "roster_not_found", rosterId: input.rosterId };
    }

    await prisma.roster.update({
      where: { id: roster.id },
      data: {
        postButtonMode: normalizeRosterPostButtonMode(input.postButtonMode),
        updatedByDiscordUserId: normalizeDiscordUserId(input.updatedByDiscordUserId),
      },
    });
    return {
      outcome: "updated",
      rosterId: roster.id,
      postButtonMode: normalizeRosterPostButtonMode(input.postButtonMode),
    };
  }

  async clearRosterSignups(input: {
    rosterId: string;
    updatedByDiscordUserId?: string | null;
  }): Promise<
    | {
        outcome: "cleared";
        rosterId: string;
        removedCount: number;
      }
    | {
        outcome: "nothing_cleared";
        rosterId: string;
        removedCount: number;
      }
    | {
        outcome: "roster_not_found";
        rosterId: string;
      }
    | {
        outcome: "roster_archived";
        rosterId: string;
      }
  > {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
        lifecycleState: true,
      },
    });
    if (!roster) {
      return { outcome: "roster_not_found", rosterId: input.rosterId };
    }
    if (!canManagerMutateRoster(roster.lifecycleState)) {
      return { outcome: "roster_archived", rosterId: roster.id };
    }

    const deleteResult = await prisma.rosterSignup.deleteMany({
      where: { rosterId: roster.id },
    });
    if (deleteResult.count > 0) {
      await prisma.roster.update({
        where: { id: roster.id },
        data: {
          updatedByDiscordUserId: normalizeDiscordUserId(input.updatedByDiscordUserId),
        },
      });
    }

    return {
      outcome: deleteResult.count > 0 ? "cleared" : "nothing_cleared",
      rosterId: roster.id,
      removedCount: deleteResult.count,
    };
  }

  async addRosterSignupsForManager(input: {
    rosterId: string;
    groupKey: string;
    playerTags?: string[] | null;
    updatedByDiscordUserId?: string | null;
    cocService?: CoCService | null;
  }): Promise<SignupLinkedAccountsResult> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
        rosterType: true,
        clanTag: true,
        minTownhall: true,
        maxTownhall: true,
        lifecycleState: true,
      },
    });
    const requestedTags = normalizeRosterPlayerTags(
      Array.isArray(input.playerTags) ? input.playerTags : [],
    );
    if (!roster) {
      return {
        outcome: "roster_not_found",
        rosterId: input.rosterId,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        groupName: null,
        requestedTags,
        linkedTags: [],
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags: requestedTags,
      };
    }
    if (!canManagerMutateRoster(roster.lifecycleState)) {
      return {
        outcome: "roster_archived",
        rosterId: roster.id,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        groupName: null,
        requestedTags,
        linkedTags: [],
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags: requestedTags,
      };
    }
    const linkedAccounts = await prisma.playerLink.findMany({
      where: {
        playerTag: { in: requestedTags },
        discordUserId: { not: null },
      },
      select: {
        playerTag: true,
        discordUserId: true,
        playerName: true,
      },
    });
    const linkedByTag = new Map<string, (typeof linkedAccounts)[number]>();
    for (const row of linkedAccounts) {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      linkedByTag.set(playerTag, row);
    }
    const linkedTags = requestedTags.filter((tag) => linkedByTag.has(tag));
    const missingLinkedTags = requestedTags.filter((tag) => !linkedByTag.has(tag));
    const group = await getRosterGroupByKey({ rosterId: roster.id, groupKey: input.groupKey });

    if (!group) {
      return {
        outcome: "group_not_found",
        rosterId: roster.id,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        groupName: null,
        requestedTags,
        linkedTags,
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags,
      };
    }

    if (linkedTags.length <= 0) {
      return {
        outcome: "no_linked_accounts",
        rosterId: roster.id,
        groupKey: group.key,
        groupName: group.name,
        requestedTags,
        linkedTags: [],
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags,
      };
    }

    const townHallGated = isRosterTownHallGated(roster);
    const existing = await prisma.rosterSignup.findMany({
      where: {
        rosterId: roster.id,
        playerTag: { in: linkedTags },
      },
      select: { playerTag: true },
    });
    const existingTags = new Set(existing.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean));
    const createdTags = linkedTags.filter((tag) => !existingTags.has(tag));
    const duplicateTags = linkedTags.filter((tag) => existingTags.has(tag));

    if (townHallGated && createdTags.length > 0) {
      const playerTownHallResolution = await resolveRosterPlayerTownHallMap({
        rosterType: roster.rosterType,
        clanTag: roster.clanTag,
        playerTags: createdTags,
        allowLiveFetch: true,
        cocService: input.cocService ?? null,
      });
      const minTownhall = normalizeRosterInt(roster.minTownhall);
      const maxTownhall = normalizeRosterInt(roster.maxTownhall);
      const blockedUnavailableTags: string[] = [];
      const blockedUnavailableAccounts: RosterAccountIdentity[] = [];
      const blockedOutOfRangeTags: string[] = [];
      const blockedOutOfRangeAccounts: RosterAccountIdentity[] = [];
      for (const tag of createdTags) {
        const linked = linkedByTag.get(tag) ?? null;
        const blockedAccount = {
          playerTag: tag,
          playerName: normalizeRosterText(linked?.playerName ?? null),
        };
        const townHall = playerTownHallResolution.townHallByTag.get(tag) ?? null;
        if (townHall === null) {
          blockedUnavailableTags.push(tag);
          blockedUnavailableAccounts.push(blockedAccount);
          continue;
        }
        if ((minTownhall !== null && townHall < minTownhall) || (maxTownhall !== null && townHall > maxTownhall)) {
          blockedOutOfRangeTags.push(tag);
          blockedOutOfRangeAccounts.push(blockedAccount);
        }
      }
      if (blockedUnavailableTags.length > 0) {
        return {
          outcome: "townhall_unavailable",
          rosterId: roster.id,
          groupKey: group.key,
          groupName: group.name,
          requestedTags,
          linkedTags,
          createdTags: [],
          duplicateTags,
          missingLinkedTags,
          blockedTags: blockedUnavailableTags,
          blockedAccounts: blockedUnavailableAccounts,
        };
      }
      if (blockedOutOfRangeTags.length > 0) {
        return {
          outcome: "townhall_out_of_range",
          rosterId: roster.id,
          groupKey: group.key,
          groupName: group.name,
          requestedTags,
          linkedTags,
          createdTags: [],
          duplicateTags,
          missingLinkedTags,
          blockedTags: blockedOutOfRangeTags,
          blockedAccounts: blockedOutOfRangeAccounts,
        };
      }
    }

    if (createdTags.length > 0) {
      await prisma.rosterSignup.createMany({
        data: createdTags.map((playerTag) => {
          const linked = linkedByTag.get(playerTag) ?? null;
          return {
            rosterId: roster.id,
            groupId: group.id,
            playerTag,
            playerName: linked?.playerName ?? null,
            discordUserId: normalizeDiscordUserId(linked?.discordUserId) ?? input.updatedByDiscordUserId ?? "",
          };
        }),
        skipDuplicates: true,
      });
    }

    return {
      outcome: createdTags.length > 0 ? "created" : "already_signed_up",
      rosterId: roster.id,
      groupKey: group.key,
      groupName: group.name,
      requestedTags,
      linkedTags,
      createdTags,
      duplicateTags,
      missingLinkedTags,
    };
  }

  async moveRosterSignups(input: {
    rosterId: string;
    groupKey: string;
    playerTags?: string[] | null;
    updatedByDiscordUserId?: string | null;
  }): Promise<RosterManagerMoveSignupsResult> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
        lifecycleState: true,
      },
    });
    const requestedTags = normalizeRosterPlayerTags(
      Array.isArray(input.playerTags) ? input.playerTags : [],
    );
    if (!roster) {
      return {
        outcome: "roster_not_found",
        rosterId: input.rosterId,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        requestedTags,
        movedTags: [],
        duplicateTags: [],
        missingTags: requestedTags,
      };
    }
    if (!canManagerMutateRoster(roster.lifecycleState)) {
      return {
        outcome: "roster_archived",
        rosterId: roster.id,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        requestedTags,
        movedTags: [],
        duplicateTags: [],
        missingTags: requestedTags,
      };
    }

    const group = await getRosterGroupByKey({ rosterId: roster.id, groupKey: input.groupKey });
    if (!group) {
      return {
        outcome: "group_not_found",
        rosterId: roster.id,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        requestedTags,
        movedTags: [],
        duplicateTags: [],
        missingTags: requestedTags,
      };
    }

    const existing = await prisma.rosterSignup.findMany({
      where: {
        rosterId: roster.id,
        playerTag: { in: requestedTags },
      },
      select: {
        playerTag: true,
        groupId: true,
      },
    });
    const existingByTag = new Map(
      existing.map((row) => [normalizePlayerTag(row.playerTag), row] as const).filter((entry) => Boolean(entry[0])),
    );
    const missingTags = requestedTags.filter((tag) => !existingByTag.has(tag));
    const duplicateTags = requestedTags.filter((tag) => existingByTag.get(tag)?.groupId === group.id);
    const movedTags = requestedTags.filter(
      (tag) => existingByTag.has(tag) && existingByTag.get(tag)?.groupId !== group.id,
    );

    if (movedTags.length > 0) {
      await prisma.rosterSignup.updateMany({
        where: {
          rosterId: roster.id,
          playerTag: { in: movedTags },
        },
        data: {
          groupId: group.id,
        },
      });
    }

    return {
      outcome: movedTags.length > 0 ? "moved" : "nothing_moved",
      rosterId: roster.id,
      groupKey: group.key,
      requestedTags,
      movedTags,
      duplicateTags,
      missingTags,
    };
  }

  async removeRosterSignupsAsManager(input: {
    rosterId: string;
    playerTags?: string[] | null;
    updatedByDiscordUserId?: string | null;
  }): Promise<RemoveRosterSignupsResult> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
        lifecycleState: true,
      },
    });
    const selectedTags = normalizeRosterPlayerTags(Array.isArray(input.playerTags) ? input.playerTags : []);

    if (selectedTags.length <= 0) {
      return {
        outcome: "nothing_removed",
        rosterId: input.rosterId,
        removedTags: [],
        ignoredTags: [],
        notOwnedTags: [],
      };
    }

    if (!roster) {
      return {
        outcome: "roster_not_found",
        rosterId: input.rosterId,
        removedTags: [],
        ignoredTags: selectedTags,
        notOwnedTags: [],
      };
    }
    if (!canManagerMutateRoster(roster.lifecycleState)) {
      return {
        outcome: "roster_archived",
        rosterId: roster.id,
        removedTags: [],
        ignoredTags: selectedTags,
        notOwnedTags: [],
      };
    }

    const existing = await prisma.rosterSignup.findMany({
      where: {
        rosterId: roster.id,
        playerTag: { in: selectedTags },
      },
      select: { playerTag: true },
    });
    const existingTags = normalizeRosterPlayerTags(existing.map((entry) => entry.playerTag));
    const notOwnedTags = selectedTags.filter((tag) => !existingTags.includes(tag));

    if (existingTags.length <= 0) {
      return {
        outcome: "nothing_removed",
        rosterId: roster.id,
        removedTags: [],
        ignoredTags: selectedTags,
        notOwnedTags,
      };
    }

    const deleteResult = await prisma.rosterSignup.deleteMany({
      where: {
        rosterId: roster.id,
        playerTag: { in: existingTags },
      },
    });

    return {
      outcome: deleteResult.count > 0 ? "removed" : "nothing_removed",
      rosterId: roster.id,
      removedTags: existingTags,
      ignoredTags: selectedTags.filter((tag) => !existingTags.includes(tag)),
      notOwnedTags,
    };
  }

  async buildRosterManagerReadinessView(input: {
    rosterId: string;
  }): Promise<RosterManagerReadinessView | null> {
    const view = await loadRosterView(input.rosterId);
    if (!view) return null;

    const trackedClanRoster = await loadRosterManagerTrackedClanMembers(view.roster);
    const trackedTagSet = new Set(trackedClanRoster.map((entry) => normalizePlayerTag(entry.playerTag)).filter(Boolean));
    const signupsByTag = new Map(view.signups.map((signup) => [normalizePlayerTag(signup.playerTag), signup] as const));
    const signedUpButUntracked = view.signups.filter((signup) => {
      const normalizedTag = normalizePlayerTag(signup.playerTag);
      return normalizedTag ? !trackedTagSet.has(normalizedTag) : true;
    });
    const unsignedTrackedMembers = trackedClanRoster.filter((entry) => {
      const normalizedTag = normalizePlayerTag(entry.playerTag);
      return normalizedTag ? !signupsByTag.has(normalizedTag) : true;
    });

    return {
      roster: view.roster,
      trackedClanRoster,
      signupView: view,
      signedUpButUntracked,
      unsignedTrackedMembers,
    };
  }

  async buildRosterManagerReadinessText(input: {
    rosterId: string;
  }): Promise<string | null> {
    const view = await this.buildRosterManagerReadinessView(input);
    if (!view) return null;
    return truncateDiscordContent(buildRosterManagerReadinessLines(view).join("\n"), 4096);
  }

  async createRosterSignupSelectionPanel(input: {
    rosterId: string;
    discordUserId: string;
    groupKey?: string | null;
  }): Promise<RosterSelectionOpenResult> {
    const loaded = await loadRosterSelectionOptions({
      rosterId: input.rosterId,
      discordUserId: input.discordUserId,
      mode: "signup",
      groupKey: input.groupKey,
    });
    if (loaded.outcome !== "ready") {
      return loaded;
    }
    if (!loaded.group && loaded.groups.length <= 0) {
      return {
        outcome: "group_not_found",
        rosterId: loaded.roster.id,
        groupKey: normalizeRosterGroupKey(input.groupKey ?? ""),
      };
    }

    const defaultGroup = loaded.group ?? loaded.groups[0] ?? null;
    const groupOptions = loaded.groups.map((group) => ({
      value: group.key,
      label: group.name,
      description: group.description,
    }));

    const session = createRosterSelectionSession({
      mode: "signup",
      rosterId: loaded.roster.id,
      rosterTitle: loaded.roster.title,
      groupKey: defaultGroup?.key ?? null,
      groupName: defaultGroup?.name ?? null,
      selectedGroupKey: loaded.selectedGroupKey ?? defaultGroup?.key ?? null,
      groupOptions,
      ownerDiscordUserId: normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId,
      options: loaded.options,
      selectedTags: [],
    });
    return {
      outcome: "ready",
      panel: buildRosterSelectionPayload(session),
    };
  }

  async createRosterRemoveSelectionPanel(input: {
    rosterId: string;
    discordUserId: string;
  }): Promise<RosterSelectionOpenResult> {
    const loaded = await loadRosterSelectionOptions({
      rosterId: input.rosterId,
      discordUserId: input.discordUserId,
      mode: "remove",
    });
    if (loaded.outcome !== "ready") {
      return loaded;
    }

    const session = createRosterSelectionSession({
      mode: "remove",
      rosterId: loaded.roster.id,
      rosterTitle: loaded.roster.title,
      groupKey: null,
      groupName: null,
      selectedGroupKey: null,
      groupOptions: [],
      ownerDiscordUserId: normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId,
      options: loaded.options,
      selectedTags: [],
    });
    return {
      outcome: "ready",
      panel: buildRosterSelectionPayload(session),
    };
  }

  async updateRosterSelectionPanel(input: {
    sessionId: string;
    discordUserId: string;
    selectedTags?: string[];
    selectedGroupKey?: string | null;
  }): Promise<RosterSelectionUpdateResult> {
    const session = getRosterSelectionSession(input.sessionId);
    if (!session) {
      return { outcome: "session_not_found" };
    }
    const normalizedDiscordUserId = normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId;
    if (session.ownerDiscordUserId !== normalizedDiscordUserId) {
      return { outcome: "forbidden" };
    }

    if (Array.isArray(input.selectedTags)) {
      session.selectedTags = normalizeRosterSelectionTags(
        input.selectedTags,
        session.options.map((option) => option.value),
      );
    }
    if (input.selectedGroupKey !== undefined) {
      const normalizedGroupKey = input.selectedGroupKey ? normalizeRosterGroupKey(input.selectedGroupKey) : "";
      const selectedGroup = normalizedGroupKey
        ? session.groupOptions.find((option) => option.value === normalizedGroupKey) ?? null
        : null;
      if (selectedGroup) {
        session.selectedGroupKey = selectedGroup.value;
        session.groupKey = selectedGroup.value;
        session.groupName = selectedGroup.label;
      }
    }
    rosterSelectionSessions.set(session.sessionId, session);
    return {
      outcome: "updated",
      panel: buildRosterSelectionPayload(session),
    };
  }

  async confirmRosterSelectionPanel(input: {
    sessionId: string;
    discordUserId: string;
    cocService?: CoCService | null;
  }): Promise<RosterSelectionCommitResult> {
    const session = getRosterSelectionSession(input.sessionId);
    if (!session) {
      return { outcome: "session_not_found" };
    }
    const normalizedDiscordUserId = normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId;
    if (session.ownerDiscordUserId !== normalizedDiscordUserId) {
      return { outcome: "forbidden" };
    }

    try {
      if (session.mode === "signup") {
        const result = await this.signupLinkedAccounts({
          rosterId: session.rosterId,
          groupKey: session.groupKey ?? "",
          discordUserId: session.ownerDiscordUserId,
          playerTags: session.selectedTags,
          cocService: input.cocService ?? null,
        });
        deleteRosterSelectionSession(session.sessionId);
        return { outcome: "signup", result };
      }

      const result = await this.removeRosterSignups({
        rosterId: session.rosterId,
        discordUserId: session.ownerDiscordUserId,
        playerTags: session.selectedTags,
      });
      deleteRosterSelectionSession(session.sessionId);
      return { outcome: "remove", result };
    } catch (error) {
      deleteRosterSelectionSession(session.sessionId);
      throw error;
    }
  }

  async cancelRosterSelectionPanel(input: {
    sessionId: string;
    discordUserId: string;
  }): Promise<RosterSelectionUpdateResult> {
    const session = getRosterSelectionSession(input.sessionId);
    if (!session) {
      return { outcome: "session_not_found" };
    }
    const normalizedDiscordUserId = normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId;
    if (session.ownerDiscordUserId !== normalizedDiscordUserId) {
      return { outcome: "forbidden" };
    }
    deleteRosterSelectionSession(session.sessionId);
    return {
      outcome: "updated",
      panel: buildRosterSelectionPayload({
        ...session,
        selectedTags: [],
      }),
    };
  }

  async signupLinkedAccounts(input: {
    rosterId: string;
    groupKey: string;
    discordUserId: string;
    playerTags?: string[] | null;
    cocService?: CoCService | null;
  }): Promise<SignupLinkedAccountsResult> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
        lifecycleState: true,
        rosterType: true,
        rosterCategory: true,
        clanTag: true,
        maxMembers: true,
        maxAccountsPerUser: true,
        minTownhall: true,
        maxTownhall: true,
        allowMultiSignup: true,
      },
    });
    const requestedTags = [
      ...new Set(
        (Array.isArray(input.playerTags) && input.playerTags.length > 0 ? input.playerTags : [])
          .map((tag) => normalizePlayerTag(tag))
          .filter(Boolean),
      ),
    ];

    const linkedAccounts = await listPlayerLinksForDiscordUser({
      discordUserId: input.discordUserId,
    });
    const linkedByTag = new Map(linkedAccounts.map((entry) => [entry.playerTag, entry]));
    const selectedTags =
      requestedTags.length > 0
        ? requestedTags.filter((tag) => linkedByTag.has(tag))
        : linkedAccounts.map((entry) => entry.playerTag);
    const missingLinkedTags =
      requestedTags.length > 0
        ? requestedTags.filter((tag) => !linkedByTag.has(tag))
        : [];
    const group = roster ? await getRosterGroupByKey({ rosterId: roster.id, groupKey: input.groupKey }) : null;

    if (!roster) {
      return {
        outcome: "roster_not_found",
        rosterId: input.rosterId,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        groupName: null,
        requestedTags,
        linkedTags: selectedTags,
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags,
      };
    }

    if (!isRosterAcceptingSignups(roster.lifecycleState)) {
      return {
        outcome: "roster_closed",
        rosterId: roster.id,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        groupName: null,
        requestedTags,
        linkedTags: selectedTags,
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags,
      };
    }

    if (!group) {
      return {
        outcome: "group_not_found",
        rosterId: roster.id,
        groupKey: normalizeRosterGroupKey(input.groupKey),
        groupName: null,
        requestedTags,
        linkedTags: selectedTags,
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags,
      };
    }

    if (selectedTags.length === 0) {
      return {
        outcome: "no_linked_accounts",
        rosterId: roster.id,
        groupKey: group.key,
        groupName: group.name,
        requestedTags,
        linkedTags: [],
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags,
      } as const;
    }

    const existing = await prisma.rosterSignup.findMany({
      where: {
        rosterId: roster.id,
        playerTag: { in: selectedTags },
      },
      select: { playerTag: true },
    });
    const existingTags = new Set(existing.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean));
    const createdCandidates = selectedTags.filter((tag) => !existingTags.has(tag));
    const duplicateTags = selectedTags.filter((tag) => existingTags.has(tag));

    const activeRosterSignups = await prisma.rosterSignup.count({
      where: {
        rosterId: roster.id,
      },
    });

    if (createdCandidates.length > 0) {
      const maxMembers = normalizeRosterInt(roster.maxMembers);
      if (maxMembers !== null && activeRosterSignups + createdCandidates.length > maxMembers) {
        return {
          outcome: "roster_full",
          rosterId: roster.id,
          groupKey: group.key,
          groupName: group.name,
          requestedTags,
          linkedTags: selectedTags,
          createdTags: [],
          duplicateTags,
          missingLinkedTags,
          blockedTags: createdCandidates,
        };
      }

      const effectiveMaxAccountsPerUser =
        roster.allowMultiSignup === false
          ? 1
          : normalizeRosterInt(roster.maxAccountsPerUser);
      if (effectiveMaxAccountsPerUser !== null) {
        const ownedCount = await prisma.rosterSignup.count({
          where: {
            rosterId: roster.id,
            discordUserId: normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId,
          },
        });
        if (ownedCount + createdCandidates.length > effectiveMaxAccountsPerUser) {
          return {
            outcome: "account_limit_exceeded",
            rosterId: roster.id,
            groupKey: group.key,
            groupName: group.name,
            requestedTags,
            linkedTags: selectedTags,
            createdTags: [],
            duplicateTags,
            missingLinkedTags,
            blockedTags: createdCandidates,
          };
        }
      }

      if (isRosterTownHallGated(roster)) {
        const playerTownHallResolution = await resolveRosterPlayerTownHallMap({
          rosterType: roster.rosterType,
          clanTag: roster.clanTag,
          playerTags: createdCandidates,
          allowLiveFetch: true,
          cocService: input.cocService ?? null,
        });
        const minTownhall = normalizeRosterInt(roster.minTownhall);
        const maxTownhall = normalizeRosterInt(roster.maxTownhall);
        const blockedUnavailableTags: string[] = [];
        const blockedUnavailableAccounts: RosterAccountIdentity[] = [];
        const blockedOutOfRangeTags: string[] = [];
        const blockedOutOfRangeAccounts: RosterAccountIdentity[] = [];
        for (const tag of createdCandidates) {
          const linked = linkedByTag.get(tag) ?? null;
          const blockedAccount = {
            playerTag: tag,
            playerName: normalizeRosterText(linked?.linkedName ?? null),
          };
          const townHall = playerTownHallResolution.townHallByTag.get(tag) ?? null;
          if (townHall === null) {
            blockedUnavailableTags.push(tag);
            blockedUnavailableAccounts.push(blockedAccount);
            continue;
          }
          if ((minTownhall !== null && townHall < minTownhall) || (maxTownhall !== null && townHall > maxTownhall)) {
            blockedOutOfRangeTags.push(tag);
            blockedOutOfRangeAccounts.push(blockedAccount);
          }
        }
        if (blockedUnavailableTags.length > 0) {
          return {
            outcome: "townhall_unavailable",
            rosterId: roster.id,
            groupKey: group.key,
            groupName: group.name,
            requestedTags,
            linkedTags: selectedTags,
            createdTags: [],
            duplicateTags,
            missingLinkedTags,
            blockedTags: blockedUnavailableTags,
            blockedAccounts: blockedUnavailableAccounts,
          };
        }
        if (blockedOutOfRangeTags.length > 0) {
          return {
            outcome: "townhall_out_of_range",
            rosterId: roster.id,
            groupKey: group.key,
            groupName: group.name,
            requestedTags,
            linkedTags: selectedTags,
            createdTags: [],
            duplicateTags,
            missingLinkedTags,
            blockedTags: blockedOutOfRangeTags,
            blockedAccounts: blockedOutOfRangeAccounts,
          };
        }
      }

      const conflictingRows = await prisma.rosterSignup.findMany({
        where: {
          playerTag: { in: createdCandidates },
          rosterId: { not: roster.id },
          roster: {
            rosterType: roster.rosterType,
            rosterCategory: roster.rosterCategory,
            lifecycleState: { in: ROSTER_CONFLICT_LIFECYCLE_STATES.filter(isRosterConflictEligible) },
          },
        },
        select: {
          playerTag: true,
          rosterId: true,
        },
      });
      const conflictingTags = normalizeRosterPlayerTags(conflictingRows.map((row) => row.playerTag));
      if (conflictingTags.length > 0) {
        return {
          outcome: "roster_conflict",
          rosterId: roster.id,
          groupKey: group.key,
          groupName: group.name,
          requestedTags,
          linkedTags: selectedTags,
          createdTags: [],
          duplicateTags,
          missingLinkedTags,
          blockedTags: conflictingTags,
          conflictingRosterIds: [...new Set(conflictingRows.map((row) => row.rosterId))],
        };
      }
    }

    const createdTags = createdCandidates;

    if (createdTags.length > 0) {
      await prisma.rosterSignup.createMany({
        data: createdTags.map((playerTag) => {
          const linked = linkedByTag.get(playerTag) ?? null;
          return {
            rosterId: roster.id,
            groupId: group.id,
            playerTag,
            playerName: linked?.linkedName ?? null,
            discordUserId: normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId,
          };
        }),
        skipDuplicates: true,
      });
    }

    return {
      outcome: createdTags.length > 0 ? "created" : "already_signed_up",
      rosterId: roster.id,
      groupKey: group.key,
      groupName: group.name,
      requestedTags,
      linkedTags: selectedTags,
      createdTags,
      duplicateTags,
      missingLinkedTags,
    };
  }

  async removeRosterSignups(input: {
    rosterId: string;
    discordUserId: string;
    playerTags?: string[] | null;
  }): Promise<RemoveRosterSignupsResult> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: { id: true },
    });
    const selectedTags = [
      ...new Set(
        (Array.isArray(input.playerTags) && input.playerTags.length > 0 ? input.playerTags : [])
          .map((tag) => normalizePlayerTag(tag))
          .filter(Boolean),
      ),
    ];

    if (selectedTags.length <= 0) {
      return {
        outcome: "nothing_removed",
        rosterId: input.rosterId,
        removedTags: [],
        ignoredTags: [],
        notOwnedTags: [],
      };
    }

    if (!roster) {
      return {
        outcome: "roster_not_found",
        rosterId: input.rosterId,
        removedTags: [],
        ignoredTags: selectedTags,
        notOwnedTags: [],
      };
    }

    const normalizedDiscordUserId = normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId;
    const ownedEntries = await prisma.rosterSignup.findMany({
      where: {
        rosterId: roster.id,
        discordUserId: normalizedDiscordUserId,
        playerTag: selectedTags.length > 0 ? { in: selectedTags } : undefined,
      },
      select: {
        playerTag: true,
      },
    });
    const ownedTags = [...new Set(ownedEntries.map((entry) => normalizePlayerTag(entry.playerTag)).filter(Boolean))];
    const ownedTagSet = new Set(ownedTags);
    const notOwnedTags = selectedTags.filter((tag) => !ownedTagSet.has(tag));

    if (ownedTags.length <= 0) {
      return {
        outcome: "nothing_removed",
        rosterId: roster.id,
        removedTags: [],
        ignoredTags: selectedTags,
        notOwnedTags,
      };
    }

    const deleteResult = await prisma.rosterSignup.deleteMany({
      where: {
        rosterId: roster.id,
        discordUserId: normalizedDiscordUserId,
        playerTag: { in: ownedTags },
      },
    });

    return {
      outcome: deleteResult.count > 0 ? "removed" : "nothing_removed",
      rosterId: roster.id,
      removedTags: ownedTags,
      ignoredTags: selectedTags.filter((tag) => !ownedTagSet.has(tag)),
      notOwnedTags,
    };
  }
}

export const rosterService = new RosterService();
