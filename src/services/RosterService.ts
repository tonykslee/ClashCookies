import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { randomUUID } from "crypto";
import { CoCService } from "./CoCService";
import { prisma } from "../prisma";
import { truncateDiscordContent } from "../helper/discordContent";
import { emojiResolverService } from "./emoji/EmojiResolverService";
import {
  listPlayerLinksForClanMembers,
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";
import {
  ensureAndHydrateCwlTrackedClanMetadataForSeason,
  resolveCurrentCwlSeasonKey,
} from "./CwlRegistryService";
import { cwlStateService } from "./CwlStateService";
import {
  formatRosterWeightAge,
  resolveRosterCurrentWeightRecords,
  type RosterWeightSource,
} from "./RosterWeightService";
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
export const ROSTER_POST_USERS_PREFIX = "roster-post-users";
const ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT = 3;
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
  displayColumns: string[] | null;
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
  trophies: number | null;
  weight: number | null;
  weightSource: RosterWeightSource;
  weightMeasuredAt: Date | null;
  discordDisplayName: string | null;
  discordUsername: string | null;
  clanTag: string | null;
  clanName: string | null;
};

export type RosterSignupPayload = {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
};

export type RosterSelectionMode = "signup" | "remove" | "add_user" | "remove_user";

type RosterPostButtonMode = "standard" | "hidden" | "archived";

type RosterSignupPayloadBuildOptions = RosterViewLoadOptions & {
  emojiClient?: Client | null;
  refreshButtonDisabled?: boolean;
};

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
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder | UserSelectMenuBuilder>[];
  selectedTags: string[];
};

export type RosterSelectionOpenResult =
  | { outcome: "ready"; panel: RosterSelectionPanel }
  | { outcome: "roster_not_found"; rosterId: string }
  | { outcome: "roster_closed"; rosterId: string }
  | { outcome: "roster_archived"; rosterId: string }
  | { outcome: "group_not_found"; rosterId: string; groupKey: string }
  | { outcome: "no_linked_accounts"; rosterId: string }
  | { outcome: "no_owned_entries"; rosterId: string };

type RosterSelectionLoadErrorResult =
  | { outcome: "roster_not_found"; rosterId: string }
  | { outcome: "roster_closed"; rosterId: string }
  | { outcome: "roster_archived"; rosterId: string }
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
  | { outcome: "add_user"; result: SignupLinkedAccountsResult }
  | { outcome: "remove_user"; result: RemoveRosterSignupsResult }
  | { outcome: "missing_user" }
  | { outcome: "missing_players" }
  | { outcome: "missing_group" }
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
  displayColumns: true,
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
  displayColumns?: string[] | null;
  importMembers?: boolean | null;
  lifecycleState?: RosterLifecycleState;
  createdByDiscordUserId?: string | null;
  updatedByDiscordUserId?: string | null;
  groups?: RosterGroupSeed[];
  cocService?: CoCService | null;
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
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
      createdAccounts: RosterAccountIdentity[];
      duplicateTags: string[];
      missingLinkedTags: string[];
    };

export type RemoveRosterSignupsResult =
  | {
      outcome: "removed";
      rosterId: string;
      removedTags: string[];
      removedAccounts: RosterAccountIdentity[];
      ignoredTags: string[];
      notOwnedTags: string[];
    }
  | {
      outcome: "nothing_removed";
      rosterId: string;
      removedTags: string[];
      removedAccounts: RosterAccountIdentity[];
      ignoredTags: string[];
      notOwnedTags: string[];
    }
  | {
      outcome: "roster_not_found";
      rosterId: string;
      removedTags: string[];
      removedAccounts: RosterAccountIdentity[];
      ignoredTags: string[];
      notOwnedTags: string[];
    }
  | {
      outcome: "roster_archived";
      rosterId: string;
      removedTags: string[];
      removedAccounts: RosterAccountIdentity[];
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
  DISCORD_NAME: "discord_name",
  DISCORD_USERNAME: "discord_username",
  TOWNHALL: "townhall",
  TOWNHALL_LEVEL: "townhall_level",
  WEIGHT: "weight",
  CLAN_NAME: "clan_name",
  TROPHIES: "trophies",
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
    normalized === ROSTER_SORT_BY.DISCORD_NAME ||
    normalized === ROSTER_SORT_BY.DISCORD_USERNAME ||
    normalized === ROSTER_SORT_BY.TOWNHALL ||
    normalized === ROSTER_SORT_BY.TOWNHALL_LEVEL ||
    normalized === ROSTER_SORT_BY.WEIGHT ||
    normalized === ROSTER_SORT_BY.CLAN_NAME ||
    normalized === ROSTER_SORT_BY.TROPHIES
  ) {
    return normalized;
  }
  return null;
}

export const ROSTER_DISPLAY_COLUMNS = {
  TH_LEVEL: "th_level",
  TOWNHALL_ICONS: "townhall_icons",
  INDEX: "index",
  DISCORD_NAME: "discord_name",
  DISCORD_USERNAME: "discord_username",
  DISCORD_USER_ID: "discord_user_id",
  PLAYER_NAME: "player_name",
  PLAYER_TAG: "player_tag",
  CLAN_NAME: "clan_name",
  TROPHIES: "trophies",
  WEIGHT: "weight",
  WEIGHT_SOURCE: "weight_source",
  WEIGHT_AGE: "weight_age",
} as const;

export type RosterDisplayColumn = (typeof ROSTER_DISPLAY_COLUMNS)[keyof typeof ROSTER_DISPLAY_COLUMNS];

export const ROSTER_DISPLAY_COLUMN_ORDER: readonly RosterDisplayColumn[] = [
  ROSTER_DISPLAY_COLUMNS.TH_LEVEL,
  ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS,
  ROSTER_DISPLAY_COLUMNS.INDEX,
  ROSTER_DISPLAY_COLUMNS.DISCORD_NAME,
  ROSTER_DISPLAY_COLUMNS.DISCORD_USERNAME,
  ROSTER_DISPLAY_COLUMNS.DISCORD_USER_ID,
  ROSTER_DISPLAY_COLUMNS.PLAYER_NAME,
  ROSTER_DISPLAY_COLUMNS.PLAYER_TAG,
  ROSTER_DISPLAY_COLUMNS.CLAN_NAME,
  ROSTER_DISPLAY_COLUMNS.TROPHIES,
  ROSTER_DISPLAY_COLUMNS.WEIGHT,
  ROSTER_DISPLAY_COLUMNS.WEIGHT_SOURCE,
  ROSTER_DISPLAY_COLUMNS.WEIGHT_AGE,
] as const;

const ROSTER_DEFAULT_DISPLAY_COLUMNS: readonly RosterDisplayColumn[] = [
  ROSTER_DISPLAY_COLUMNS.TH_LEVEL,
  ROSTER_DISPLAY_COLUMNS.PLAYER_NAME,
  ROSTER_DISPLAY_COLUMNS.DISCORD_USERNAME,
  ROSTER_DISPLAY_COLUMNS.CLAN_NAME,
];

function normalizeRosterDisplayColumn(input: string | null | undefined): RosterDisplayColumn | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const values = Object.values(ROSTER_DISPLAY_COLUMNS) as RosterDisplayColumn[];
  return values.includes(normalized as RosterDisplayColumn) ? (normalized as RosterDisplayColumn) : null;
}

function normalizeRosterDisplayColumns(input: string[] | null | undefined): RosterDisplayColumn[] | null {
  const normalized = (Array.isArray(input) ? input : [])
    .map((value) => normalizeRosterDisplayColumn(value))
    .filter((value): value is RosterDisplayColumn => Boolean(value));
  const uniqueOrdered = [...new Set(normalized)];
  if (uniqueOrdered.length <= 0) {
    return null;
  }
  if (
    uniqueOrdered.length === ROSTER_DEFAULT_DISPLAY_COLUMNS.length &&
    uniqueOrdered.every((value, index) => value === ROSTER_DEFAULT_DISPLAY_COLUMNS[index])
  ) {
    return null;
  }
  return uniqueOrdered;
}

function parseRosterDisplayColumns(input: string | null | undefined): RosterDisplayColumn[] | null {
  const raw = normalizeRosterText(input ?? null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return normalizeRosterDisplayColumns(parsed.map((value) => String(value ?? "")));
  } catch {
    return null;
  }
}

function serializeRosterDisplayColumns(input: string[] | null | undefined): string | null {
  const normalized = normalizeRosterDisplayColumns(input);
  return normalized ? JSON.stringify(normalized) : null;
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
    if (normalizedSortBy === ROSTER_SORT_BY.DISCORD_NAME) {
      return (
        String(left.discordDisplayName ?? left.discordUsername ?? left.discordUserId ?? "").localeCompare(
          String(right.discordDisplayName ?? right.discordUsername ?? right.discordUserId ?? ""),
        ) || left.playerTag.localeCompare(right.playerTag)
      );
    }
    if (normalizedSortBy === ROSTER_SORT_BY.DISCORD_USERNAME) {
      return (
        String(left.discordUsername ?? left.discordUserId ?? "").localeCompare(
          String(right.discordUsername ?? right.discordUserId ?? ""),
        ) || left.playerTag.localeCompare(right.playerTag)
      );
    }
    if (normalizedSortBy === ROSTER_SORT_BY.TOWNHALL || normalizedSortBy === ROSTER_SORT_BY.TOWNHALL_LEVEL) {
      const leftTownHall = Number(left.townHall ?? 0);
      const rightTownHall = Number(right.townHall ?? 0);
      return rightTownHall - leftTownHall || left.playerTag.localeCompare(right.playerTag);
    }
    if (normalizedSortBy === ROSTER_SORT_BY.WEIGHT) {
      const leftWeight = Number(left.weight ?? -1);
      const rightWeight = Number(right.weight ?? -1);
      return rightWeight - leftWeight || left.playerTag.localeCompare(right.playerTag);
    }
    if (normalizedSortBy === ROSTER_SORT_BY.CLAN_NAME) {
      return (
        String(left.clanName ?? left.clanTag ?? "").localeCompare(String(right.clanName ?? right.clanTag ?? "")) ||
        left.playerTag.localeCompare(right.playerTag)
      );
    }
    if (normalizedSortBy === ROSTER_SORT_BY.TROPHIES) {
      const leftTrophies = Number(left.trophies ?? -1);
      const rightTrophies = Number(right.trophies ?? -1);
      return rightTrophies - leftTrophies || left.playerTag.localeCompare(right.playerTag);
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
  displayColumns: string | null;
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
    displayColumns: parseRosterDisplayColumns(row.displayColumns),
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

function buildRosterPostUsersUserSelectMenuCustomId(sessionId: string): string {
  return `${ROSTER_POST_USERS_PREFIX}:user:${String(sessionId ?? "").trim()}`;
}

function buildRosterPostUsersPlayerSelectMenuCustomId(sessionId: string, pageIndex: number): string {
  return `${ROSTER_POST_USERS_PREFIX}:players:${Math.max(0, Math.trunc(Number(pageIndex) || 0))}:${String(sessionId ?? "").trim()}`;
}

function buildRosterPostUsersGroupSelectMenuCustomId(sessionId: string): string {
  return `${ROSTER_POST_USERS_PREFIX}:group:${String(sessionId ?? "").trim()}`;
}

function buildRosterPostUsersActionButtonCustomId(
  action: "confirm" | "cancel" | "select_group" | "previous_page" | "next_page",
  sessionId: string,
): string {
  return `${ROSTER_POST_USERS_PREFIX}:action:${action}:${String(sessionId ?? "").trim()}`;
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
  selectedDiscordUserId: string | null;
  selectedDiscordUserLabel: string | null;
  groupPickerVisible: boolean;
  playerPageWindowStart: number;
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

function buildRosterManagerSelectionDescription(session: RosterSelectionSession): string[] {
  const lines: string[] = [];
  const isAddMode = session.mode === "add_user";
  const totalPlayerChunks = Math.max(1, Math.ceil(session.options.length / 25));
  const maxWindowStart = Math.max(0, totalPlayerChunks - ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT);
  const windowStart = Math.max(0, Math.min(Math.trunc(session.playerPageWindowStart || 0), maxWindowStart));
  const windowEnd = Math.min(totalPlayerChunks, windowStart + ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT);
  lines.push(
    isAddMode ? `Adding Roster Users to ${session.rosterTitle}.` : `Removing Roster Users from ${session.rosterTitle}.`,
  );
  lines.push("1. Select a Discord user.");
  lines.push(
    isAddMode
      ? "2. Select one or more linked players, then choose a roster group."
      : "2. Select one or more linked players to remove.",
  );
  lines.push("3. Confirm when the selection looks right.");
  lines.push("");
  if (session.options.length > 0) {
    const startPlayerIndex = windowStart * 25 + 1;
    const endPlayerIndex = Math.min(session.options.length, windowEnd * 25);
    lines.push(`Showing players ${startPlayerIndex} - ${endPlayerIndex} of ${session.options.length}.`);
    if (totalPlayerChunks > ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT) {
      lines.push("Use Previous and Next to page through linked players.");
    }
  }
  if (session.groupPickerVisible && isAddMode) {
    lines.push("Select a roster group to continue.");
    lines.push(`Selected group: ${session.groupName ?? "none"}`);
    return lines;
  }

  lines.push(`Selected user: ${session.selectedDiscordUserLabel ?? "none"}`);
  lines.push(`Selected group: ${isAddMode ? session.groupName ?? "none" : "n/a"}`);
  lines.push(`Selected players: ${session.selectedTags.length}`);
  if (session.selectedDiscordUserId && session.options.length <= 0) {
    lines.push("No linked player accounts were found for that Discord user.");
    return lines;
  }

  const selectedOptions = session.options.filter((option) => session.selectedTags.includes(option.value));
  if (selectedOptions.length > 0) {
    lines.push("Selected player identities:");
    const visibleSelected = selectedOptions.slice(0, 5);
    for (const option of visibleSelected) {
      lines.push(`- ${option.label}`);
    }
    if (selectedOptions.length > visibleSelected.length) {
      lines.push(`- ...and ${selectedOptions.length - visibleSelected.length} more`);
    }
  } else {
    lines.push("Selected player identities: none");
  }

  if (isAddMode && session.groupOptions.length <= 0) {
    lines.push("No roster groups are available for this roster.");
  }

  return lines;
}

function buildRosterManagerSelectionPlayerSelectRows(session: RosterSelectionSession): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const chunks: Array<RosterSelectionOption[]> = [];
  for (let index = 0; index < session.options.length; index += 25) {
    chunks.push(session.options.slice(index, index + 25));
  }
  const totalChunks = chunks.length;
  const maxWindowStart = Math.max(0, totalChunks - ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT);
  const windowStart = Math.max(0, Math.min(Math.trunc(session.playerPageWindowStart || 0), maxWindowStart));
  const visibleChunks = chunks.slice(windowStart, windowStart + ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT);
  const selectedTags = new Set(session.selectedTags);
  if (visibleChunks.length <= 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(buildRosterPostUsersPlayerSelectMenuCustomId(session.sessionId, 0))
      .setPlaceholder("No linked players found")
      .setMinValues(0)
      .setMaxValues(1)
      .setDisabled(true)
      .addOptions([
        {
          label: "No linked players found",
          value: "none",
          description: "Select a different Discord user",
        },
      ]);
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
  }

  return visibleChunks.map((chunk, pageIndex) => {
    const actualPageIndex = windowStart + pageIndex;
    const start = actualPageIndex * 25 + 1;
    const end = start + chunk.length - 1;
    const select = new StringSelectMenuBuilder()
      .setCustomId(buildRosterPostUsersPlayerSelectMenuCustomId(session.sessionId, actualPageIndex))
      .setPlaceholder(`Select Players [${start} - ${end}]`)
      .setMinValues(0)
      .setMaxValues(Math.max(1, chunk.length))
      .addOptions(
        chunk.map((option) => ({
          label: option.label.slice(0, 100),
          value: option.value,
          description: option.description ? option.description.slice(0, 100) : undefined,
          default: selectedTags.has(option.value),
        })),
      );
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  });
}

function buildRosterManagerSelectionGroupSelectRow(
  session: RosterSelectionSession,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const groups = session.groupOptions.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(buildRosterPostUsersGroupSelectMenuCustomId(session.sessionId))
    .setPlaceholder("Select roster group")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(groups.length <= 0)
    .addOptions(
      groups.length > 0
        ? groups.map((option) => ({
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
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildRosterManagerSelectionPagingButtons(session: RosterSelectionSession): ButtonBuilder[] {
  const totalChunks = Math.max(1, Math.ceil(session.options.length / 25));
  const maxWindowStart = Math.max(0, totalChunks - ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT);
  const windowStart = Math.max(0, Math.min(Math.trunc(session.playerPageWindowStart || 0), maxWindowStart));
  return [
    new ButtonBuilder()
      .setCustomId(buildRosterPostUsersActionButtonCustomId("previous_page", session.sessionId))
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(windowStart <= 0),
    new ButtonBuilder()
      .setCustomId(buildRosterPostUsersActionButtonCustomId("next_page", session.sessionId))
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(windowStart >= maxWindowStart),
  ];
}

function buildRosterManagerSelectionPayload(session: RosterSelectionSession): RosterSelectionPanel {
  const isAddMode = session.mode === "add_user";
  const selectedTags = [...new Set(session.selectedTags)];
  const userSelect = new UserSelectMenuBuilder()
    .setCustomId(buildRosterPostUsersUserSelectMenuCustomId(session.sessionId))
    .setPlaceholder("Select Discord user")
    .setMinValues(1)
    .setMaxValues(1);

  const embed = new EmbedBuilder()
    .setColor(isAddMode ? 0xfee75c : 0xed4245)
    .setTitle(isAddMode ? "Adding Roster Users" : "Removing Roster Users")
    .setDescription(
      buildRosterManagerSelectionDescription({
        ...session,
        selectedTags,
      }).join("\n"),
    );

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder | UserSelectMenuBuilder>[] = [];

    if (session.groupPickerVisible && isAddMode) {
      components.push(buildRosterManagerSelectionGroupSelectRow(session));
      return {
        sessionId: session.sessionId,
        mode: session.mode,
      embed,
      components,
      selectedTags,
    };
  }

  components.push(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect));
  components.push(...buildRosterManagerSelectionPlayerSelectRows(session));

  if (isAddMode) {
    const actionButtons = [
      ...buildRosterManagerSelectionPagingButtons(session),
      new ButtonBuilder()
        .setCustomId(buildRosterPostUsersActionButtonCustomId("select_group", session.sessionId))
        .setLabel("Select Group")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(session.groupOptions.length <= 0),
      new ButtonBuilder()
        .setCustomId(buildRosterPostUsersActionButtonCustomId("confirm", session.sessionId))
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Success)
        .setDisabled(
          !session.selectedDiscordUserId ||
            selectedTags.length <= 0 ||
            session.groupOptions.length <= 0 ||
            !session.selectedGroupKey,
        ),
      new ButtonBuilder()
        .setCustomId(buildRosterPostUsersActionButtonCustomId("cancel", session.sessionId))
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ];
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...actionButtons,
      ),
    );
  } else {
    const actionButtons = [
      ...buildRosterManagerSelectionPagingButtons(session),
      new ButtonBuilder()
        .setCustomId(buildRosterPostUsersActionButtonCustomId("confirm", session.sessionId))
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!session.selectedDiscordUserId || selectedTags.length <= 0),
      new ButtonBuilder()
        .setCustomId(buildRosterPostUsersActionButtonCustomId("cancel", session.sessionId))
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ];
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...actionButtons,
      ),
    );
  }

  return {
    sessionId: session.sessionId,
    mode: session.mode,
    embed,
    components,
    selectedTags,
  };
}

function buildRosterSelectionPayload(session: RosterSelectionSession): RosterSelectionPanel {
  if (session.mode === "add_user" || session.mode === "remove_user") {
    return buildRosterManagerSelectionPayload(session);
  }
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
  const mappedRoster = mapRosterRecord(roster);

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
      roster: mappedRoster,
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
    roster: mappedRoster,
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

type RosterTownHallSource =
  | "cwl_season_roster"
  | "fwa_player_catalog"
  | "todo_snapshot"
  | "live_refresh"
  | "missing";

type RosterTownHallResolutionDetail = {
  source: RosterTownHallSource;
  townHall: number | null;
  primarySourceHit: boolean;
  snapshotSourceHit: boolean;
  liveRefreshInvoked: boolean;
};

type RosterTownHallLookupResult = {
  townHallByTag: Map<string, number>;
  detailByTag: Map<string, RosterTownHallResolutionDetail>;
  liveRefreshInvoked: boolean;
};

type RosterTownHallResolution = RosterTownHallLookupResult & {
  missingTags: string[];
};

function getRosterTownHallPrimarySourceLabel(rosterType: string): RosterTownHallSource {
  const normalizedRosterType = normalizeRosterType(rosterType);
  if (normalizedRosterType === "CWL") return "cwl_season_roster";
  if (normalizedRosterType === "FWA") return "fwa_player_catalog";
  return "missing";
}

async function loadLiveRosterPlayerTownHallMap(input: {
  playerTags: string[];
  cocService?: CoCService | null;
}): Promise<Map<string, number>> {
  const normalizedTags = [...new Set(input.playerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  if (normalizedTags.length <= 0) {
    return new Map();
  }
  const cocService = input.cocService ?? null;
  if (!cocService || typeof cocService.getPlayerRaw !== "function") {
    return new Map();
  }

  const entries = await Promise.all(
    normalizedTags.map(async (playerTag) => {
      const player = await cocService.getPlayerRaw(playerTag, { suppressTelemetry: true }).catch(() => null);
      const townHall = normalizeRosterInt(player?.townHallLevel ?? player?.townHall ?? null);
      return [playerTag, townHall] as const;
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, number] => entry[1] !== null));
}

async function loadRosterPlayerTownHallMap(input: {
  rosterType: string;
  clanTag: string | null;
  playerTags: string[];
  allowLiveFetch?: boolean;
  cocService?: CoCService | null;
}): Promise<RosterTownHallLookupResult> {
  const normalizedTags = [...new Set(input.playerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  if (normalizedTags.length <= 0) {
    return {
      townHallByTag: new Map(),
      detailByTag: new Map(),
      liveRefreshInvoked: false,
    };
  }

  const normalizedRosterType = normalizeRosterType(input.rosterType);
  const result = new Map<string, number>();
  const missingAfterPrimary = new Set(normalizedTags);
  const detailByTag = new Map<string, RosterTownHallResolutionDetail>(
    normalizedTags.map((tag) => [
      tag,
      {
        source: getRosterTownHallPrimarySourceLabel(normalizedRosterType),
        townHall: null,
        primarySourceHit: false,
        snapshotSourceHit: false,
        liveRefreshInvoked: false,
      },
    ] as const),
  );

  if (normalizedRosterType === "CWL" && input.clanTag) {
    const rosterEntries = await cwlStateService.listSeasonRosterForClan({ clanTag: input.clanTag });
    for (const entry of rosterEntries) {
      const playerTag = normalizePlayerTag(entry.playerTag);
      const townHall = normalizeRosterInt(entry.townHall);
      if (!playerTag || townHall === null || !missingAfterPrimary.has(playerTag)) continue;
      result.set(playerTag, townHall);
      const detail = detailByTag.get(playerTag);
      if (detail) {
        detail.source = "cwl_season_roster";
        detail.townHall = townHall;
        detail.primarySourceHit = true;
      }
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
      const detail = detailByTag.get(playerTag);
      if (detail) {
        detail.source = "fwa_player_catalog";
        detail.townHall = townHall;
        detail.primarySourceHit = true;
      }
      missingAfterPrimary.delete(playerTag);
    }
  }

  if (missingAfterPrimary.size <= 0) {
    return {
      townHallByTag: result,
      detailByTag,
      liveRefreshInvoked: false,
    };
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
    const detail = detailByTag.get(playerTag);
    if (detail) {
      detail.source = "todo_snapshot";
      detail.townHall = townHall;
      detail.snapshotSourceHit = true;
    }
    missingAfterPrimary.delete(playerTag);
  }

  let liveRefreshInvoked = false;
  if (!input.allowLiveFetch || missingAfterPrimary.size <= 0) {
    for (const playerTag of missingAfterPrimary) {
      const detail = detailByTag.get(playerTag);
      if (detail) {
        detail.source = "missing";
        detail.liveRefreshInvoked = liveRefreshInvoked;
      }
    }
    return {
      townHallByTag: result,
      detailByTag,
      liveRefreshInvoked,
    };
  }

  const cocService = input.cocService ?? null;
  if (!cocService) {
    for (const playerTag of missingAfterPrimary) {
      const detail = detailByTag.get(playerTag);
      if (detail) {
        detail.source = "missing";
        detail.liveRefreshInvoked = liveRefreshInvoked;
      }
    }
    return {
      townHallByTag: result,
      detailByTag,
      liveRefreshInvoked,
    };
  }

  liveRefreshInvoked = true;
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
    const detail = detailByTag.get(playerTag);
    if (detail) {
      detail.source = "live_refresh";
      detail.townHall = townHall;
      detail.liveRefreshInvoked = true;
    }
    missingAfterPrimary.delete(playerTag);
  }

  if (missingAfterPrimary.size > 0) {
    const liveRefreshRows = await loadLiveRosterPlayerTownHallMap({
      playerTags: [...missingAfterPrimary],
      cocService,
    });
    for (const [playerTag, townHall] of liveRefreshRows.entries()) {
      if (!missingAfterPrimary.has(playerTag)) continue;
      result.set(playerTag, townHall);
      const detail = detailByTag.get(playerTag);
      if (detail) {
        detail.source = "live_refresh";
        detail.townHall = townHall;
        detail.liveRefreshInvoked = true;
      }
      missingAfterPrimary.delete(playerTag);
    }
  }

  for (const playerTag of missingAfterPrimary) {
    const detail = detailByTag.get(playerTag);
    if (detail) {
      detail.source = "missing";
      detail.liveRefreshInvoked = liveRefreshInvoked;
    }
  }

  return {
    townHallByTag: result,
    detailByTag,
    liveRefreshInvoked,
  };
}

async function resolveRosterPlayerTownHallMap(input: {
  rosterType: string;
  clanTag: string | null;
  playerTags: string[];
  allowLiveFetch?: boolean;
  cocService?: CoCService | null;
}): Promise<RosterTownHallResolution> {
  const normalizedTags = [...new Set(input.playerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  if (normalizedTags.length <= 0) {
    return {
      townHallByTag: new Map(),
      missingTags: [],
      detailByTag: new Map(),
      liveRefreshInvoked: false,
    };
  }

  const lookup = await loadRosterPlayerTownHallMap({
    rosterType: input.rosterType,
    clanTag: input.clanTag,
    playerTags: normalizedTags,
    allowLiveFetch: Boolean(input.allowLiveFetch ?? input.cocService),
    cocService: input.cocService ?? null,
  });
  const missingTags = normalizedTags.filter((tag) => !lookup.townHallByTag.has(tag));
  return {
    townHallByTag: lookup.townHallByTag,
    missingTags,
    detailByTag: lookup.detailByTag,
    liveRefreshInvoked: lookup.liveRefreshInvoked,
  };
}

function logRosterTownHallResolutionDiagnostics(input: {
  rosterId: string;
  rosterType: string;
  clanTag: string | null;
  requestedTags: string[];
  linkedTags: string[];
  resolution: RosterTownHallResolution;
  blockedUnavailableTags: string[];
  blockedOutOfRangeTags: string[];
  cocServicePresent: boolean;
}): void {
  const effectiveRequestedTags = input.requestedTags.length > 0 ? input.requestedTags : input.linkedTags;
  const resolutionEntries = [...new Set(effectiveRequestedTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))].map(
    (playerTag) => {
      const detail =
        input.resolution.detailByTag.get(playerTag) ?? {
          source: "missing" as const,
          townHall: null,
          primarySourceHit: false,
          snapshotSourceHit: false,
          liveRefreshInvoked: input.resolution.liveRefreshInvoked,
        };
      return {
        player_tag: playerTag,
        source: detail.source,
        town_hall: detail.townHall,
        primary_source_hit: detail.primarySourceHit,
        snapshot_hit: detail.snapshotSourceHit,
        live_refresh_invoked: detail.liveRefreshInvoked,
      };
    },
  );
  const blockedTags = [...new Set([...input.blockedUnavailableTags, ...input.blockedOutOfRangeTags])];
  console.info(
    `[roster-townhall] ${JSON.stringify({
      roster_id: input.rosterId,
      roster_type: input.rosterType,
      roster_clan_tag: input.clanTag,
      requested_player_tags: effectiveRequestedTags,
      linked_tags: input.linkedTags,
      coc_service_present: input.cocServicePresent,
      live_refresh_invoked: input.resolution.liveRefreshInvoked,
      resolution: resolutionEntries,
      blocked_unavailable_tags: input.blockedUnavailableTags,
      blocked_out_of_range_tags: input.blockedOutOfRangeTags,
      blocked_tags: blockedTags,
    })}`,
  );
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
    source: "clanTag",
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

const ROSTER_BOARD_COLUMN_LIMITS: Record<RosterDisplayColumn, number> = {
  [ROSTER_DISPLAY_COLUMNS.TH_LEVEL]: 2,
  [ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS]: 8,
  [ROSTER_DISPLAY_COLUMNS.INDEX]: 5,
  [ROSTER_DISPLAY_COLUMNS.DISCORD_NAME]: 12,
  [ROSTER_DISPLAY_COLUMNS.DISCORD_USERNAME]: 16,
  [ROSTER_DISPLAY_COLUMNS.DISCORD_USER_ID]: 18,
  [ROSTER_DISPLAY_COLUMNS.PLAYER_NAME]: 12,
  [ROSTER_DISPLAY_COLUMNS.PLAYER_TAG]: 12,
  [ROSTER_DISPLAY_COLUMNS.CLAN_NAME]: 12,
  [ROSTER_DISPLAY_COLUMNS.TROPHIES]: 8,
  [ROSTER_DISPLAY_COLUMNS.WEIGHT]: 6,
  [ROSTER_DISPLAY_COLUMNS.WEIGHT_SOURCE]: 7,
  [ROSTER_DISPLAY_COLUMNS.WEIGHT_AGE]: 8,
};

const ROSTER_BOARD_COLUMN_HEADERS: Record<RosterDisplayColumn, string> = {
  [ROSTER_DISPLAY_COLUMNS.TH_LEVEL]: "TH",
  [ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS]: ":house:",
  [ROSTER_DISPLAY_COLUMNS.INDEX]: "INDEX",
  [ROSTER_DISPLAY_COLUMNS.DISCORD_NAME]: "DISCORD",
  [ROSTER_DISPLAY_COLUMNS.DISCORD_USERNAME]: "USERNAME",
  [ROSTER_DISPLAY_COLUMNS.DISCORD_USER_ID]: "ID",
  [ROSTER_DISPLAY_COLUMNS.PLAYER_NAME]: "PLAYER",
  [ROSTER_DISPLAY_COLUMNS.PLAYER_TAG]: "Player tag",
  [ROSTER_DISPLAY_COLUMNS.CLAN_NAME]: "CLAN",
  [ROSTER_DISPLAY_COLUMNS.TROPHIES]: "Trophies",
  [ROSTER_DISPLAY_COLUMNS.WEIGHT]: "Weight",
  [ROSTER_DISPLAY_COLUMNS.WEIGHT_SOURCE]: "SOURCE",
  [ROSTER_DISPLAY_COLUMNS.WEIGHT_AGE]: "AGE",
};

function sanitizeRosterBoardText(input: string | null | undefined): string {
  return (normalizeRosterText(input ?? null) ?? "").replace(/`/g, "'");
}

function formatRosterBoardCell(input: string | null | undefined, width: number): string {
  const value = sanitizeRosterBoardText(input) || "-";
  const trimmed = value.length > width ? value.slice(0, width) : value;
  return trimmed.padEnd(width, " ");
}

function formatRosterBoardWeightValue(weight: number | null | undefined): string | null {
  if (weight === null || weight === undefined || !Number.isFinite(weight)) {
    return null;
  }
  const normalized = Math.max(0, Math.trunc(weight));
  if (normalized < 1000) {
    return String(normalized);
  }
  return `${Math.trunc(normalized / 1000)}k`;
}

function buildClanProfileMarkdownLink(clanName: string | null, clanTag: string | null): string {
  const normalizedClanTag = normalizeClanTag(clanTag ?? "");
  const label = sanitizeRosterBoardText(clanName) || normalizedClanTag || "Unknown Clan";
  if (!normalizedClanTag) return label;
  const encodedTag = normalizedClanTag.replace(/^#/, "");
  return `[${label}](https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodedTag})`;
}

function getRosterDisplayColumnHeader(column: RosterDisplayColumn): string {
  return ROSTER_BOARD_COLUMN_HEADERS[column];
}

function formatRosterTownhallIconsValue(townHall: number | null | undefined): string | null {
  if (townHall === null || townHall === undefined || !Number.isFinite(townHall)) {
    return null;
  }
  const normalized = Math.max(0, Math.trunc(townHall));
  if (normalized <= 0) {
    return null;
  }
  if (normalized <= 8) {
    return String(normalized);
  }
  if (normalized >= 9 && normalized <= 18) {
    return `:th${normalized}:`;
  }
  return String(normalized);
}

function getRosterDisplayColumnValue(
  signup: RosterSignupViewRecord,
  column: RosterDisplayColumn,
  rowIndex?: number,
): string | null {
  if (column === ROSTER_DISPLAY_COLUMNS.TH_LEVEL) {
    return signup.townHall === null ? null : String(signup.townHall);
  }
  if (column === ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS) {
    return formatRosterTownhallIconsValue(signup.townHall);
  }
  if (column === ROSTER_DISPLAY_COLUMNS.INDEX) {
    return rowIndex === null || rowIndex === undefined ? null : String(rowIndex);
  }
  if (column === ROSTER_DISPLAY_COLUMNS.DISCORD_NAME) {
    return signup.discordDisplayName ?? signup.discordUsername ?? signup.discordUserId ?? null;
  }
  if (column === ROSTER_DISPLAY_COLUMNS.DISCORD_USERNAME) {
    return signup.discordUsername ?? null;
  }
  if (column === ROSTER_DISPLAY_COLUMNS.DISCORD_USER_ID) {
    return signup.discordUserId;
  }
  if (column === ROSTER_DISPLAY_COLUMNS.PLAYER_NAME) {
    return signup.playerName ?? signup.playerTag;
  }
  if (column === ROSTER_DISPLAY_COLUMNS.PLAYER_TAG) {
    return signup.playerTag;
  }
  if (column === ROSTER_DISPLAY_COLUMNS.CLAN_NAME) {
    return signup.clanName ?? signup.clanTag ?? null;
  }
  if (column === ROSTER_DISPLAY_COLUMNS.TROPHIES) {
    return signup.trophies === null ? null : String(signup.trophies);
  }
  if (column === ROSTER_DISPLAY_COLUMNS.WEIGHT) {
    return formatRosterBoardWeightValue(signup.weight);
  }
  if (column === ROSTER_DISPLAY_COLUMNS.WEIGHT_SOURCE) {
    return signup.weightSource;
  }
  if (column === ROSTER_DISPLAY_COLUMNS.WEIGHT_AGE) {
    return formatRosterWeightAge(signup.weightMeasuredAt);
  }
  return null;
}

function measureRosterBoardColumnWidths(
  signups: RosterSignupViewRecord[],
  columns: readonly RosterDisplayColumn[],
): Record<RosterDisplayColumn, number> {
  const widths = Object.fromEntries(
    columns.map((column) => [column, getRosterDisplayColumnHeader(column).length] as const),
  ) as Record<RosterDisplayColumn, number>;
  for (const [rowIndex, signup] of signups.entries()) {
    for (const column of columns) {
      const value = sanitizeRosterBoardText(getRosterDisplayColumnValue(signup, column, rowIndex + 1));
      widths[column] = Math.min(
        Math.max(widths[column], value.length),
        ROSTER_BOARD_COLUMN_LIMITS[column],
      );
    }
  }
  return widths;
}

function buildRosterBoardLine(
  columns: readonly RosterDisplayColumn[],
  values: Record<RosterDisplayColumn, string | null>,
  widths: Record<RosterDisplayColumn, number>,
): string {
  return columns
    .map((column) => formatRosterBoardCell(values[column], widths[column]))
    .join(" ");
}

function buildRosterBoardDisplayLine(
  columns: readonly RosterDisplayColumn[],
  values: Record<RosterDisplayColumn, string | null>,
  widths: Record<RosterDisplayColumn, number>,
): string {
  const townhallIconColumnIndex = columns.indexOf(ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS);
  if (townhallIconColumnIndex < 0) {
    return `\`${buildRosterBoardLine(columns, values, widths)}\``;
  }

  const parts: string[] = [];
  const prefixColumns = columns.slice(0, townhallIconColumnIndex);
  const suffixColumns = columns.slice(townhallIconColumnIndex + 1);

  if (prefixColumns.length > 0) {
    parts.push(`\`${buildRosterBoardLine(prefixColumns, values, widths)}\``);
  }

  parts.push(formatRosterBoardCell(values[ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS], widths[ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS]));

  if (suffixColumns.length > 0) {
    parts.push(`\`${buildRosterBoardLine(suffixColumns, values, widths)}\``);
  }

  return parts.join(" ");
}

function buildRosterBoardHeaderLine(
  columns: readonly RosterDisplayColumn[],
  widths: Record<RosterDisplayColumn, number>,
): string {
  const values = Object.fromEntries(columns.map((column) => [column, getRosterDisplayColumnHeader(column)] as const)) as Record<
    RosterDisplayColumn,
    string | null
  >;
  return buildRosterBoardDisplayLine(columns, values, widths);
}

function buildRosterBoardRowLine(
  signup: RosterSignupViewRecord,
  columns: readonly RosterDisplayColumn[],
  widths: Record<RosterDisplayColumn, number>,
  rowIndex: number,
): string {
  const values = Object.fromEntries(
    columns.map((column) => [column, getRosterDisplayColumnValue(signup, column, rowIndex)] as const),
  ) as Record<RosterDisplayColumn, string | null>;
  return buildRosterBoardDisplayLine(columns, values, widths);
}

function buildRosterBoardRowLines(
  signups: RosterSignupViewRecord[],
  columns: readonly RosterDisplayColumn[],
  widths: Record<RosterDisplayColumn, number>,
  startIndex = 1,
): { lines: string[]; nextIndex: number } {
  if (signups.length <= 0) {
    return { lines: ["`- None`"], nextIndex: startIndex };
  }
  let rowIndex = startIndex;
  const lines = signups.map((signup) => {
    const line = buildRosterBoardRowLine(signup, columns, widths, rowIndex);
    rowIndex += 1;
    return line;
  });
  return { lines, nextIndex: rowIndex };
}

async function renderRosterBoardShortcodes(text: string, client?: Client | null): Promise<string> {
  if (!client) return text;
  return emojiResolverService.replaceShortcodes(client, text).catch(() => text);
}

async function buildRosterSignupPayloadFromView(
  view: RosterSignupView,
  options?: RosterSignupPayloadBuildOptions,
): Promise<RosterSignupPayload> {
  const title = normalizeRosterText(view.clanDisplayName ?? null) ?? normalizeClanTag(view.roster.clanTag ?? "") ?? "Roster";
  const groups = buildRosterGroupsWithSignups(view);
  const columns =
    normalizeRosterDisplayColumns(view.roster.displayColumns) ?? [...ROSTER_DEFAULT_DISPLAY_COLUMNS];
  const widths = measureRosterBoardColumnWidths(groups.flatMap((group) => group.signups), columns);
  const rosterLabel = `**${buildClanProfileMarkdownLink(view.roster.title || "Roster Signup", view.roster.clanTag)}** ${
    view.clanLeagueLabel ?? view.roster.rosterType
  }`.trim();
  const maxMembersLabel = view.roster.maxMembers === null || view.roster.maxMembers === undefined ? "-" : String(view.roster.maxMembers);
  const minTownHallLabel = view.roster.minTownhall === null || view.roster.minTownhall === undefined ? "-" : String(view.roster.minTownhall);
  const lines: string[] = [
    rosterLabel,
    "",
    buildRosterBoardHeaderLine(columns, widths),
  ];

  let rowIndex = 1;
  for (const group of groups) {
    lines.push(`**${group.name} - ${group.signupCount}**`);
    const renderedRows = buildRosterBoardRowLines(group.signups, columns, widths, rowIndex);
    lines.push(...renderedRows.lines);
    rowIndex = renderedRows.nextIndex;
    lines.push("");
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }
  lines.push("");
  lines.push(`Total ${view.totalSignupCount}/${maxMembersLabel} | Min. TH ${minTownHallLabel}`);

  const renderedDescription = await renderRosterBoardShortcodes(lines.join("\n"), options?.emojiClient ?? null);
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(title)
    .setDescription(truncateDiscordContent(renderedDescription, 4096));

  const buttonMode = normalizeRosterPostButtonMode(view.roster.postButtonMode);
  const refreshButtonDisabled = options?.refreshButtonDisabled ?? false;
  const buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (buttonMode !== "archived") {
    const rowButtons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId(buildRosterPostActionButtonCustomId("refresh", view.roster.id))
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary),
    ];
    rowButtons[0].setDisabled(refreshButtonDisabled);
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

type RosterViewLoadOptions = {
  discordDisplayNamesByUserId?: Map<string, string | null>;
};

async function loadRosterView(rosterId: string, options?: RosterViewLoadOptions): Promise<RosterSignupView | null> {
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
      displayColumns: true,
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
  const signupTags = signups.map((signup) => normalizePlayerTag(signup.playerTag)).filter(Boolean);
  const townHallResolution = await loadRosterPlayerTownHallMap({
    rosterType: roster.rosterType,
    clanTag: roster.clanTag,
    playerTags: signupTags,
    allowLiveFetch: false,
  });
  const townHallByTag = townHallResolution.townHallByTag;
  const [snapshotRows, linkedPlayerRows, resolvedWeightRows] = await Promise.all([
    todoSnapshotService.listSnapshotsByPlayerTags({
      playerTags: signupTags,
    }),
    prisma.playerLink.findMany({
      where: {
        playerTag: { in: signupTags },
      },
      select: {
        playerTag: true,
        discordUsername: true,
      },
    }),
    resolveRosterCurrentWeightRecords({
      playerTags: signupTags,
    }),
  ]);
  const currentClanRows =
    roster.clanTag
      ? await todoSnapshotService.listSnapshotsByClanTag({
          clanTag: roster.clanTag,
          source: "clanTag",
        })
      : [];
  const discordUsernameByTag = new Map(
    linkedPlayerRows
      .map((row) => [normalizePlayerTag(row.playerTag), normalizeRosterText(row.discordUsername ?? null)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0])),
  );
  const discordDisplayNameByUserId = options?.discordDisplayNamesByUserId ?? new Map<string, string | null>();
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
            leagueLabel: true,
          },
        })
      : null;
  const signupsWithTownHall = signups.map((signup) => {
    const playerTag = normalizePlayerTag(signup.playerTag);
    const weightRecord = resolvedWeightRows.get(playerTag) ?? null;
    return {
      ...signup,
      townHall: townHallByTag.get(playerTag) ?? null,
      trophies: weightRecord?.trophies ?? null,
      weight: weightRecord?.weight ?? null,
      weightSource: weightRecord?.weightSource ?? "Unknown",
      weightMeasuredAt: weightRecord?.weightMeasuredAt ?? null,
      discordDisplayName: discordDisplayNameByUserId.get(signup.discordUserId) ?? null,
      discordUsername: discordUsernameByTag.get(playerTag) ?? null,
      clanTag: snapshotByTag.get(playerTag)?.clanTag ?? null,
      clanName: snapshotByTag.get(playerTag)?.clanName ?? null,
    };
  });
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
  const mappedRoster = mapRosterRecord(roster);

  return {
    roster: mappedRoster,
    clanDisplayName,
    clanLeagueLabel: normalizeRosterText(trackedClan?.leagueLabel ?? null) ?? null,
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
      trophies: signup.trophies,
      weight: signup.weight,
      weightSource: signup.weightSource,
      weightMeasuredAt: signup.weightMeasuredAt,
      discordDisplayName: signup.discordDisplayName,
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

export function isRosterPostUsersUserSelectMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_USERS_PREFIX}:user:`);
}

export function isRosterPostUsersPlayerSelectMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_USERS_PREFIX}:players:`);
}

export function isRosterPostUsersGroupSelectMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_USERS_PREFIX}:group:`);
}

export function isRosterPostUsersActionButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_USERS_PREFIX}:action:`);
}

export function parseRosterPostUsersUserSelectMenuCustomId(customId: string): { sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_POST_USERS_PREFIX || parts[1] !== "user") {
    return null;
  }
  const sessionId = parts[2]?.trim() ?? "";
  return sessionId ? { sessionId } : null;
}

export function parseRosterPostUsersPlayerSelectMenuCustomId(
  customId: string,
): { sessionId: string; pageIndex: number } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== ROSTER_POST_USERS_PREFIX || parts[1] !== "players") {
    return null;
  }
  const pageIndex = Math.trunc(Number(parts[2] ?? ""));
  const sessionId = parts[3]?.trim() ?? "";
  return Number.isFinite(pageIndex) && pageIndex >= 0 && sessionId ? { sessionId, pageIndex } : null;
}

export function parseRosterPostUsersGroupSelectMenuCustomId(customId: string): { sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_POST_USERS_PREFIX || parts[1] !== "group") {
    return null;
  }
  const sessionId = parts[2]?.trim() ?? "";
  return sessionId ? { sessionId } : null;
}

export function parseRosterPostUsersActionButtonCustomId(
  customId: string,
): { action: "confirm" | "cancel" | "select_group" | "previous_page" | "next_page"; sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== ROSTER_POST_USERS_PREFIX || parts[1] !== "action") {
    return null;
  }
  const action = parts[2];
  if (action !== "confirm" && action !== "cancel" && action !== "select_group" && action !== "previous_page" && action !== "next_page") {
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
    const displayColumns = serializeRosterDisplayColumns(input.displayColumns);
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
          displayColumns,
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
    if (roster.rosterType === "CWL" && roster.clanTag && input.cocService) {
      await ensureAndHydrateCwlTrackedClanMetadataForSeason({
        clanTags: [roster.clanTag],
        season: resolveCurrentCwlSeasonKey(),
        cocService: input.cocService,
      }).catch((err) => {
        console.error(
          `[roster] stage=cwl_metadata_hydration_failed roster_id=${roster.id} clan_tag=${roster.clanTag} error=${String((err as Error)?.message ?? err)}`,
        );
      });
    }
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

  async buildRosterSignupPayload(
    rosterId: string,
    _cocService?: CoCService | null,
    options?: RosterSignupPayloadBuildOptions,
  ): Promise<RosterSignupPayload | null> {
    const view = await loadRosterView(rosterId, options);
    if (!view) return null;
    return buildRosterSignupPayloadFromView(view, options);
  }

  async refreshRosterSignupPayload(
    rosterId: string,
    cocService?: CoCService | null,
    options?: RosterSignupPayloadBuildOptions,
  ): Promise<RosterSignupPayload | null> {
    const roster = await prisma.roster.findUnique({
      where: { id: rosterId },
      select: {
        id: true,
        rosterType: true,
        clanTag: true,
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

    if (cocService && roster.rosterType === "CWL" && roster.clanTag) {
      await ensureAndHydrateCwlTrackedClanMetadataForSeason({
        clanTags: [roster.clanTag],
        season: resolveCurrentCwlSeasonKey(),
        cocService,
      }).catch((err) => {
        console.error(
          `[roster] stage=cwl_metadata_refresh_failed roster_id=${roster.id} clan_tag=${roster.clanTag} error=${String((err as Error)?.message ?? err)}`,
        );
      });
    }

    return this.buildRosterSignupPayload(rosterId, cocService ?? null, options);
  }

  async getRosterView(
    rosterId: string,
    _cocService?: CoCService | null,
    options?: RosterViewLoadOptions,
  ): Promise<RosterSignupView | null> {
    return loadRosterView(rosterId, options);
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
  displayColumns?: string[] | null;
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
    if (input.displayColumns !== undefined) {
      data.displayColumns = serializeRosterDisplayColumns(input.displayColumns);
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
        createdAccounts: [],
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
        createdAccounts: [],
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
        createdAccounts: [],
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
        createdAccounts: [],
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
      logRosterTownHallResolutionDiagnostics({
        rosterId: roster.id,
        rosterType: roster.rosterType,
        clanTag: roster.clanTag,
        requestedTags,
        linkedTags,
        resolution: playerTownHallResolution,
        blockedUnavailableTags,
        blockedOutOfRangeTags,
        cocServicePresent: Boolean(input.cocService),
      });
      if (blockedUnavailableTags.length > 0) {
        return {
          outcome: "townhall_unavailable",
          rosterId: roster.id,
          groupKey: group.key,
          groupName: group.name,
          requestedTags,
          linkedTags,
          createdTags: [],
          createdAccounts: [],
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
          createdAccounts: [],
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
    const createdAccounts = createdTags.map((playerTag) => {
      const linked = linkedByTag.get(playerTag) ?? null;
      return {
        playerTag,
        playerName: normalizeRosterText(linked?.playerName ?? null),
      };
    });

    return {
      outcome: createdTags.length > 0 ? "created" : "already_signed_up",
      rosterId: roster.id,
      groupKey: group.key,
      groupName: group.name,
      requestedTags,
      linkedTags,
      createdTags,
      createdAccounts,
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
        removedAccounts: [],
        ignoredTags: [],
        notOwnedTags: [],
      };
    }

    if (!roster) {
      return {
        outcome: "roster_not_found",
        rosterId: input.rosterId,
        removedTags: [],
        removedAccounts: [],
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
      selectedDiscordUserId: null,
      selectedDiscordUserLabel: null,
      groupPickerVisible: false,
      playerPageWindowStart: 0,
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
      selectedDiscordUserId: null,
      selectedDiscordUserLabel: null,
      groupPickerVisible: false,
      playerPageWindowStart: 0,
    });
    return {
      outcome: "ready",
      panel: buildRosterSelectionPayload(session),
    };
  }

  async createRosterManagerUserSelectionPanel(input: {
    rosterId: string;
    discordUserId: string;
    mode: "add_user" | "remove_user";
  }): Promise<RosterSelectionOpenResult> {
    const view = await loadRosterView(input.rosterId);
    if (!view) {
      return { outcome: "roster_not_found", rosterId: input.rosterId };
    }
    if (!canManagerMutateRoster(view.roster.lifecycleState)) {
      return { outcome: "roster_archived", rosterId: view.roster.id };
    }

    const defaultGroup =
      input.mode === "add_user"
        ? view.groups.find((group) => group.key === normalizeRosterGroupKey("confirmed")) ?? view.groups[0] ?? null
        : null;
    const groupOptions = view.groups.map((group) => ({
      value: group.key,
      label: group.name,
      description: group.description,
    }));

    const session = createRosterSelectionSession({
      mode: input.mode,
      rosterId: view.roster.id,
      rosterTitle: view.roster.title,
      groupKey: defaultGroup?.key ?? null,
      groupName: defaultGroup?.name ?? null,
      selectedGroupKey: defaultGroup?.key ?? null,
      groupOptions,
      ownerDiscordUserId: normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId,
      options: [],
      selectedTags: [],
      selectedDiscordUserId: null,
      selectedDiscordUserLabel: null,
      groupPickerVisible: false,
      playerPageWindowStart: 0,
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
    selectedDiscordUserId?: string | null;
    selectedDiscordUserLabel?: string | null;
    selectedPlayerTags?: string[];
    playerPageIndex?: number | null;
    groupPickerVisible?: boolean;
    playerPageWindowDelta?: number | null;
  }): Promise<RosterSelectionUpdateResult> {
    const session = getRosterSelectionSession(input.sessionId);
    if (!session) {
      return { outcome: "session_not_found" };
    }
    const normalizedDiscordUserId = normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId;
    if (session.ownerDiscordUserId !== normalizedDiscordUserId) {
      return { outcome: "forbidden" };
    }

    if ((session.mode === "add_user" || session.mode === "remove_user") && input.selectedDiscordUserId !== undefined) {
      const normalizedSelectedUserId = normalizeDiscordUserId(input.selectedDiscordUserId ?? "") ?? null;
      const previousUserId = session.selectedDiscordUserId;
      session.selectedDiscordUserId = normalizedSelectedUserId;
      session.selectedDiscordUserLabel = normalizeRosterText(input.selectedDiscordUserLabel ?? null);
      session.groupPickerVisible = false;

      if (normalizedSelectedUserId) {
        const linkedAccounts = await listPlayerLinksForDiscordUser({ discordUserId: normalizedSelectedUserId });
        session.options = linkedAccounts.map((account) => ({
          value: account.playerTag,
          label: account.linkedName ? `${account.linkedName} (${account.playerTag})` : account.playerTag,
          description: account.linkedName ? "Linked player account" : "Linked player account",
        }));
      } else {
        session.options = [];
      }

      if (previousUserId !== normalizedSelectedUserId) {
        session.selectedTags = [];
        session.playerPageWindowStart = 0;
      } else {
        session.selectedTags = normalizeRosterSelectionTags(session.selectedTags, session.options.map((option) => option.value));
      }
    }

    if (Array.isArray(input.selectedTags)) {
      session.selectedTags = normalizeRosterSelectionTags(
        input.selectedTags,
        session.options.map((option) => option.value),
      );
    }
    if (Array.isArray(input.selectedPlayerTags)) {
      const pageIndex = Math.max(0, Math.trunc(Number(input.playerPageIndex ?? 0)));
      const pageStart = pageIndex * 25;
      const pageOptions = session.options.slice(pageStart, pageStart + 25).map((option) => option.value);
      const remaining = session.selectedTags.filter((tag) => !pageOptions.includes(tag));
      session.selectedTags = normalizeRosterSelectionTags(
        [...remaining, ...input.selectedPlayerTags],
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
        session.groupPickerVisible = false;
      }
    }
    if (input.groupPickerVisible !== undefined) {
      session.groupPickerVisible = input.groupPickerVisible && session.mode === "add_user";
    }
    if (input.playerPageWindowDelta !== undefined) {
      const totalChunks = Math.max(1, Math.ceil(session.options.length / 25));
      const maxWindowStart = Math.max(0, totalChunks - ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT);
      const delta = Math.trunc(Number(input.playerPageWindowDelta ?? 0)) || 0;
      const nextWindowStart = Math.max(0, Math.min(Math.trunc(session.playerPageWindowStart || 0) + delta * ROSTER_MANAGER_PLAYER_PAGE_ROW_COUNT, maxWindowStart));
      session.playerPageWindowStart = nextWindowStart;
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

      if (session.mode === "remove") {
        const result = await this.removeRosterSignups({
          rosterId: session.rosterId,
          discordUserId: session.ownerDiscordUserId,
          playerTags: session.selectedTags,
        });
        deleteRosterSelectionSession(session.sessionId);
        return { outcome: "remove", result };
      }

      if (!session.selectedDiscordUserId) {
        return { outcome: "missing_user" };
      }
      if (session.selectedTags.length <= 0) {
        return { outcome: "missing_players" };
      }
      if (session.mode === "add_user") {
        if (!session.selectedGroupKey) {
          return { outcome: "missing_group" };
        }
        const result = await this.addRosterSignupsForManager({
          rosterId: session.rosterId,
          groupKey: session.selectedGroupKey,
          playerTags: session.selectedTags,
          updatedByDiscordUserId: session.ownerDiscordUserId,
          cocService: input.cocService ?? null,
        });
        deleteRosterSelectionSession(session.sessionId);
        return { outcome: "add_user", result };
      }

      const result = await this.removeRosterSignupsAsManager({
        rosterId: session.rosterId,
        playerTags: session.selectedTags,
        updatedByDiscordUserId: session.ownerDiscordUserId,
      });
      deleteRosterSelectionSession(session.sessionId);
      return { outcome: "remove_user", result };
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
        createdAccounts: [],
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
        createdAccounts: [],
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
        createdAccounts: [],
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
        createdAccounts: [],
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
          createdAccounts: [],
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
            createdAccounts: [],
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
        logRosterTownHallResolutionDiagnostics({
          rosterId: roster.id,
          rosterType: roster.rosterType,
          clanTag: roster.clanTag,
          requestedTags,
          linkedTags: selectedTags,
          resolution: playerTownHallResolution,
          blockedUnavailableTags,
          blockedOutOfRangeTags,
          cocServicePresent: Boolean(input.cocService),
        });
        if (blockedUnavailableTags.length > 0) {
          return {
            outcome: "townhall_unavailable",
            rosterId: roster.id,
            groupKey: group.key,
            groupName: group.name,
            requestedTags,
            linkedTags: selectedTags,
            createdTags: [],
            createdAccounts: [],
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
            createdAccounts: [],
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
          createdAccounts: [],
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
        playerName: true,
      },
    });
    const ownedTags = [...new Set(ownedEntries.map((entry) => normalizePlayerTag(entry.playerTag)).filter(Boolean))];
    const ownedTagSet = new Set(ownedTags);
    const notOwnedTags = selectedTags.filter((tag) => !ownedTagSet.has(tag));
    const ownedAccounts = ownedTags.map((playerTag) => {
      const ownedEntry = ownedEntries.find((entry) => normalizePlayerTag(entry.playerTag) === playerTag) ?? null;
      return {
        playerTag,
        playerName: normalizeRosterText(ownedEntry?.playerName ?? null),
      };
    });

    if (ownedTags.length <= 0) {
      return {
        outcome: "nothing_removed",
        rosterId: roster.id,
        removedTags: [],
        removedAccounts: [],
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
      removedAccounts: ownedAccounts,
      ignoredTags: selectedTags.filter((tag) => !ownedTagSet.has(tag)),
      notOwnedTags,
    };
  }
}

export const rosterService = new RosterService();
