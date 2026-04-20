import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { randomUUID } from "crypto";
import { prisma } from "../prisma";
import { truncateDiscordContent } from "../helper/discordContent";
import {
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";
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
const ROSTER_SELECTION_SESSION_TTL_MS = 15 * 60 * 1000;

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
};

export type RosterSignupPayload = {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
};

export type RosterSelectionMode = "signup" | "remove";

export type RosterSelectionOption = {
  value: string;
  label: string;
  description: string | null;
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
  groups: Array<
    RosterGroupRecord & {
      signupCount: number;
    }
  >;
  signups: RosterSignupViewRecord[];
  totalSignupCount: number;
};

export type CreateRosterInput = {
  guildId: string;
  rosterType: string;
  title: string;
  clanTag?: string | null;
  rosterCategory?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  displayTimezone?: string | null;
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
    };

function normalizeRosterType(input: string): string {
  return String(input ?? "")
    .trim()
    .toUpperCase();
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

function formatRosterTimestamp(input: Date | null): string | null {
  if (!(input instanceof Date) || Number.isNaN(input.getTime())) {
    return null;
  }
  return `<t:${Math.floor(input.getTime() / 1000)}:F>`;
}

function formatRosterRelativeTimestamp(input: Date | null): string | null {
  if (!(input instanceof Date) || Number.isNaN(input.getTime())) {
    return null;
  }
  return `<t:${Math.floor(input.getTime() / 1000)}:R>`;
}

function buildRosterStateLabel(state: RosterLifecycleState): string {
  if (state === ROSTER_LIFECYCLE_STATE.ACTIVE) return "Active";
  if (state === ROSTER_LIFECYCLE_STATE.CLOSED) return "Closed";
  if (state === ROSTER_LIFECYCLE_STATE.ARCHIVED) return "Archived";
  return "Open";
}

function buildRosterGroupButtonStyle(key: string): ButtonStyle {
  if (key === "confirmed") return ButtonStyle.Primary;
  if (key === "substitute") return ButtonStyle.Secondary;
  return ButtonStyle.Secondary;
}

function chunkButtons<T>(input: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < input.length; index += size) {
    chunks.push(input.slice(index, index + size));
  }
  return chunks;
}

function buildRosterSignupEntryLine(signup: {
  playerName: string | null;
  playerTag: string;
  discordUserId: string | null;
}): string {
  const playerLabel = signup.playerName ? `${signup.playerName} \`${signup.playerTag}\`` : `\`${signup.playerTag}\``;
  const userLabel = signup.discordUserId ? ` <@${signup.discordUserId}>` : "";
  return `- ${playerLabel}${userLabel}`;
}

function buildRosterSelectionMenuCustomId(sessionId: string): string {
  return `${ROSTER_SELECTION_PREFIX}:menu:${String(sessionId ?? "").trim()}`;
}

function buildRosterSelectionActionButtonCustomId(action: "confirm" | "cancel", sessionId: string): string {
  return `${ROSTER_SELECTION_PREFIX}:${action}:${String(sessionId ?? "").trim()}`;
}

export function isRosterSelectionMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_SELECTION_PREFIX}:menu:`);
}

export function isRosterSelectionActionButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_SELECTION_PREFIX}:`);
}

export function parseRosterSelectionMenuCustomId(customId: string): { sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_SELECTION_PREFIX || parts[1] !== "menu") {
    return null;
  }
  const sessionId = parts[2]?.trim() ?? "";
  return sessionId ? { sessionId } : null;
}

export function parseRosterSelectionActionButtonCustomId(
  customId: string,
): { action: "confirm" | "cancel"; sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_SELECTION_PREFIX) {
    return null;
  }
  const action = parts[1];
  if (action !== "confirm" && action !== "cancel") {
    return null;
  }
  const sessionId = parts[2]?.trim() ?? "";
  return sessionId ? { action, sessionId } : null;
}

type RosterSelectionSession = {
  sessionId: string;
  mode: RosterSelectionMode;
  rosterId: string;
  groupKey: string | null;
  groupName: string | null;
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
    lines.push(`Select linked accounts to sign up for ${input.groupName ?? input.rosterTitle}.`);
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
  const select = new StringSelectMenuBuilder()
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
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
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
  mode: RosterSelectionMode;
  groupKey?: string | null;
}): Promise<
  | { outcome: "ready"; roster: RosterRecord; group: RosterGroupRecord | null; options: RosterSelectionOption[] }
  | { outcome: "roster_not_found" }
  | { outcome: "roster_closed"; roster: RosterRecord }
  | { outcome: "group_not_found"; roster: RosterRecord; groupKey: string }
  | { outcome: "no_linked_accounts"; roster: RosterRecord }
  | { outcome: "no_owned_entries"; roster: RosterRecord }
> {
  const roster = await prisma.roster.findUnique({
    where: { id: input.rosterId },
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
  if (!roster) return { outcome: "roster_not_found" };
  if (
    input.mode === "signup" &&
    roster.lifecycleState !== ROSTER_LIFECYCLE_STATE.OPEN &&
    roster.lifecycleState !== ROSTER_LIFECYCLE_STATE.ACTIVE
  ) {
    return { outcome: "roster_closed", roster };
  }

  if (input.mode === "signup") {
    const group = input.groupKey ? await getRosterGroupByKey({ rosterId: roster.id, groupKey: input.groupKey }) : null;
    if (!group) {
      return { outcome: "group_not_found", roster, groupKey: normalizeRosterGroupKey(input.groupKey ?? "") };
    }
    const linkedAccounts = await listPlayerLinksForDiscordUser({ discordUserId: input.discordUserId });
    if (linkedAccounts.length <= 0) {
      return { outcome: "no_linked_accounts", roster };
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
      group,
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
    return { outcome: "no_owned_entries", roster };
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

function buildRosterGroupSectionLines(input: {
  group: RosterGroupRecord & {
    signupCount: number;
    signups: RosterSignupViewRecord[];
  };
}): string[] {
  const lines: string[] = [`${input.group.name} (${input.group.signupCount})`];
  if (input.group.description) {
    lines.push(`- ${input.group.description}`);
  }
  if (input.group.signups.length <= 0) {
    lines.push("- None yet");
    return lines;
  }
  lines.push(...input.group.signups.map((signup) => buildRosterSignupEntryLine(signup)));
  return lines;
}
function buildRosterSignupPayloadFromView(view: RosterSignupView): RosterSignupPayload {
  const title = view.roster.title || "Roster Signup";
  const descriptionLines: string[] = [
    `Type: ${view.roster.rosterType}`,
  ];
  if (view.roster.rosterCategory) {
    descriptionLines.push(`Category: ${view.roster.rosterCategory}`);
  }
  if (view.roster.clanTag) {
    descriptionLines.push(`Clan: ${view.roster.clanTag}`);
  }
  if (view.roster.timezone) {
    descriptionLines.push(`Timezone: ${view.roster.displayTimezone ?? view.roster.timezone}`);
  }

  const startLabel = formatRosterTimestamp(view.roster.startsAt);
  const endLabel = formatRosterTimestamp(view.roster.endsAt);
  const relativeEndLabel = formatRosterRelativeTimestamp(view.roster.endsAt);
  if (startLabel) {
    descriptionLines.push(`Starts: ${startLabel}`);
  }
  if (endLabel) {
    descriptionLines.push(`Ends: ${endLabel}${relativeEndLabel ? ` (${relativeEndLabel})` : ""}`);
  }
  descriptionLines.push(`State: ${buildRosterStateLabel(view.roster.lifecycleState)}`);
  descriptionLines.push(`Total signups: ${view.totalSignupCount}`);
  descriptionLines.push("");
  descriptionLines.push("Groups:");
  descriptionLines.push(
    ...buildRosterGroupsWithSignups(view).flatMap((group) => [
      ...buildRosterGroupSectionLines({ group }),
      "",
    ]),
  );
  if (descriptionLines.at(-1) === "") {
    descriptionLines.pop();
  }
  descriptionLines.push("");
  descriptionLines.push("Use the group buttons to choose accounts, and Remove signup to opt out.");

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(title)
    .setDescription(truncateDiscordContent(descriptionLines.join("\n"), 4096));

  const buttonRows = chunkButtons(
    view.groups.map((group) =>
      new ButtonBuilder()
        .setCustomId(buildRosterSignupButtonCustomId(view.roster.id, group.key))
        .setLabel(`${group.name} (${group.signupCount})`)
        .setStyle(buildRosterGroupButtonStyle(group.key))
        .setDisabled(
          view.roster.lifecycleState === ROSTER_LIFECYCLE_STATE.CLOSED ||
            view.roster.lifecycleState === ROSTER_LIFECYCLE_STATE.ARCHIVED,
        ),
    ),
    5,
  ).map((buttons) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
  buttonRows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildRosterRemoveButtonCustomId(view.roster.id))
        .setLabel("Remove signup")
        .setStyle(ButtonStyle.Danger),
    ),
  );

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
  const signupCountByGroupId = new Map<string, number>();
  for (const signup of signups) {
    if (!signup.groupId) continue;
    signupCountByGroupId.set(signup.groupId, (signupCountByGroupId.get(signup.groupId) ?? 0) + 1);
  }

  return {
    roster,
    groups: groups.map((group) => ({
      ...group,
      signupCount: signupCountByGroupId.get(group.id) ?? 0,
    })),
    signups: signups.map((signup) => ({
      id: signup.id,
      rosterId: signup.rosterId,
      groupId: signup.groupId,
      playerTag: signup.playerTag,
      playerName: signup.playerName,
      discordUserId: signup.discordUserId,
      signedUpAt: signup.signedUpAt,
      createdAt: signup.createdAt,
      updatedAt: signup.updatedAt,
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
    totalSignupCount: signups.length,
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

export function buildRosterSignupButtonCustomId(rosterId: string, groupKey: string): string {
  return `${ROSTER_SIGNUP_BUTTON_PREFIX}:${String(rosterId ?? "").trim()}:${normalizeRosterGroupKey(
    groupKey,
  )}`;
}

export function buildRosterRemoveButtonCustomId(rosterId: string): string {
  return `${ROSTER_REMOVE_BUTTON_PREFIX}:${String(rosterId ?? "").trim()}`;
}

export function isRosterSignupButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_SIGNUP_BUTTON_PREFIX}:`);
}

export function isRosterRemoveButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_REMOVE_BUTTON_PREFIX}:`);
}

export function parseRosterSignupButtonCustomId(
  customId: string,
): { rosterId: string; groupKey: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_SIGNUP_BUTTON_PREFIX) {
    return null;
  }
  const rosterId = parts[1]?.trim() ?? "";
  const groupKey = normalizeRosterGroupKey(parts[2] ?? "");
  if (!rosterId || !groupKey) return null;
  return { rosterId, groupKey };
}

export function parseRosterRemoveButtonCustomId(customId: string): { rosterId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 2 || parts[0] !== ROSTER_REMOVE_BUTTON_PREFIX) {
    return null;
  }
  const rosterId = parts[1]?.trim() ?? "";
  return rosterId ? { rosterId } : null;
}

export class RosterService {
  async createRoster(input: CreateRosterInput): Promise<RosterRecord> {
    const guildId = String(input.guildId ?? "").trim();
    const rosterType = normalizeRosterType(input.rosterType);
    const title = normalizeRosterTitle(input.title);
    const timezone = normalizeRosterDisplayTimezone(input.timezone) ?? "UTC";
    const displayTimezone =
      normalizeRosterDisplayTimezone(input.displayTimezone) ?? timezone;
    const clanTag = input.clanTag ? normalizeClanTag(input.clanTag) : null;
    const rosterCategory = normalizeRosterCategory(input.rosterCategory);
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

    return {
      id: created.id,
      guildId: created.guildId,
      rosterType: created.rosterType,
      rosterCategory: created.rosterCategory,
      title: created.title,
      clanTag: created.clanTag,
      startsAt: created.startsAt,
      endsAt: created.endsAt,
      timezone: created.timezone,
      displayTimezone: created.displayTimezone,
      lifecycleState: created.lifecycleState as RosterLifecycleState,
      postedChannelId: created.postedChannelId,
      postedMessageId: created.postedMessageId,
      postedMessageUrl: created.postedMessageUrl,
      postedAt: created.postedAt,
      createdByDiscordUserId: created.createdByDiscordUserId,
      updatedByDiscordUserId: created.updatedByDiscordUserId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
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

  async buildRosterSignupPayload(rosterId: string): Promise<RosterSignupPayload | null> {
    const view = await loadRosterView(rosterId);
    if (!view) return null;
    return buildRosterSignupPayloadFromView(view);
  }

  async getRosterView(rosterId: string): Promise<RosterSignupView | null> {
    return loadRosterView(rosterId);
  }

  async createRosterSignupSelectionPanel(input: {
    rosterId: string;
    groupKey: string;
    discordUserId: string;
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

    const session = createRosterSelectionSession({
      mode: "signup",
      rosterId: loaded.roster.id,
      groupKey: loaded.group.key,
      groupName: loaded.group.name,
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
      groupKey: null,
      groupName: null,
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
    selectedTags: string[];
  }): Promise<RosterSelectionUpdateResult> {
    const session = getRosterSelectionSession(input.sessionId);
    if (!session) {
      return { outcome: "session_not_found" };
    }
    const normalizedDiscordUserId = normalizeDiscordUserId(input.discordUserId) ?? input.discordUserId;
    if (session.ownerDiscordUserId !== normalizedDiscordUserId) {
      return { outcome: "forbidden" };
    }

    session.selectedTags = normalizeRosterSelectionTags(
      input.selectedTags,
      session.options.map((option) => option.value),
    );
    rosterSelectionSessions.set(session.sessionId, session);
    return {
      outcome: "updated",
      panel: buildRosterSelectionPayload(session),
    };
  }

  async confirmRosterSelectionPanel(input: {
    sessionId: string;
    discordUserId: string;
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
  }): Promise<SignupLinkedAccountsResult> {
    const roster = await prisma.roster.findUnique({
      where: { id: input.rosterId },
      select: {
        id: true,
        lifecycleState: true,
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

    if (
      roster.lifecycleState !== ROSTER_LIFECYCLE_STATE.OPEN &&
      roster.lifecycleState !== ROSTER_LIFECYCLE_STATE.ACTIVE
    ) {
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
    const createdTags = selectedTags.filter((tag) => !existingTags.has(tag));
    const duplicateTags = selectedTags.filter((tag) => existingTags.has(tag));

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
