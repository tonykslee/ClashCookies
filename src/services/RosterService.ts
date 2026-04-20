import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { prisma } from "../prisma";
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

export type RosterSignupPayload = {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
};

export type RosterSignupView = {
  roster: RosterRecord;
  groups: Array<
    RosterGroupRecord & {
      signupCount: number;
    }
  >;
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

function buildRosterGroupSummaryLine(group: {
  name: string;
  description: string | null;
  signupCount: number;
}): string {
  const countLabel = `${group.signupCount} signup${group.signupCount === 1 ? "" : "s"}`;
  const description = group.description ? ` - ${group.description}` : "";
  return `- ${group.name}: ${countLabel}${description}`;
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
    ...view.groups.map((group) =>
      buildRosterGroupSummaryLine({
        name: group.name,
        description: group.description,
        signupCount: group.signupCount,
      }),
    ),
  );
  descriptionLines.push("");
  descriptionLines.push("Click a group button to sign up all of your linked player accounts for that group.");

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(title)
    .setDescription(descriptionLines.join("\n"));

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

export function isRosterSignupButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_SIGNUP_BUTTON_PREFIX}:`);
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
        (Array.isArray(input.playerTags) && input.playerTags.length > 0
          ? input.playerTags
          : [])
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
}

export const rosterService = new RosterService();
