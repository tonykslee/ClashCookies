import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Command } from "../Command";
import { toPositiveCompoWeight } from "../helper/compoActualWeight";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import { InactiveWarService, type InactiveWarMetricRow } from "../services/InactiveWarService";
import { listFillerAccountTagsForGuild } from "../services/FillerAccountService";
import { resolveLinkListDisplayWeightsByPlayerTags } from "../services/LinkListWeightService";
import {
  createPlayerLink,
  createPlayerLinkFromEmbed,
  deletePlayerLink,
  formatLinkedAtUtc,
  listPlayerLinksForClanMembers,
  getPlayerLinkTrustTier,
  getPlayerLinksForDiscordUserWithTrust,
  isPlayerLinkTrustedForAutorole,
  isPlayerLinkVerifiedForAutorole,
  type PlayerLinkTrustTier,
  type PlayerLinkWithTrust,
  type PlayerLinkCreateResult,
  normalizeClanTag,
  normalizePersistedDiscordUsername,
  normalizePlayerTag,
} from "../services/PlayerLinkService";
import { PlayerLinkVerificationService } from "../services/PlayerLinkVerificationService";
import { PlayerLinkSyncService } from "../services/PlayerLinkSyncService";
import { FwaClanMembersSyncService } from "../services/fwa-feeds/FwaClanMembersSyncService";
import {
  buildReminderLinkCancelCustomId,
  buildReminderLinkConfirmCustomId,
  parseReminderLinkButtonCustomId,
  parseReminderLinkCancelCustomId,
  parseReminderLinkConfirmCustomId,
} from "../services/reminders/ReminderLinkActions";
import {
  buildLinkListDescriptionLines,
  buildLinkListOrderedColumnsFromSelection,
  buildDescriptionEmbeds,
  buildTitleWithBadge,
  encodeLinkListColumns,
  formatCompactWeightK,
  formatInactivityMetricLabel,
  formatLinkListClanRole,
  formatLinkListTownHallLabel,
  getLinkListClanRoleSortScore,
  getLinkListColumnLabel,
  getLinkListDefaultColumnsForSortMode,
  getLinkListSelectableColumns,
  getLinkListSortModeLabel,
  getNextLinkListSortMode,
  isLinkListDefaultColumnsForSortMode,
  normalizeLinkListColumns,
  normalizeLinkListSortMode,
  parseLinkListColumnsField,
  resolveLinkListStatusIcons,
  resolveLinkListTownHall,
  sanitizeInlineCodeCell,
  sanitizeTableText,
  sortLinkListRows,
  truncateWithEllipsis,
  LINK_LIST_DEFAULT_SORT_MODE,
  MAX_IDENTITY_CHARS,
  MAX_LINK_LIST_DISPLAY_NAME_CHARS,
  MAX_PLAYER_NAME_CHARS,
  WEIGHT_PLACEHOLDER,
  type LinkListColumnId,
  type LinkListRowViewModel,
  type LinkListSortMode,
} from "./link/LinkListRender";

type LinkListResolvedMemberRow = {
  isLinked: boolean;
  playerTag: string;
  defaultIndex: number;
  weightValue: number | null;
  inactivityDays: number | null;
  inactivityMissedWars: number | null;
  inactivityParticipationWars: number | null;
  clanRoleSortScore: number;
  playerSort: string;
  discordSort: string;
  row: LinkListRowViewModel;
};

const permissionService = new CommandPermissionService();
const inactiveWarService = new InactiveWarService();
const linkListMembersSyncService = new FwaClanMembersSyncService();
const LINK_LIST_SELECT_PREFIX = "link-list-select";
const LINK_LIST_SORT_BUTTON_PREFIX = "link-list-sort-cycle";
const LINK_LIST_REFRESH_BUTTON_PREFIX = "link-list-refresh";
const LINK_LIST_COLUMNS_SELECT_PREFIX = "link-list-columns";
const LINK_EMBED_SETUP_MODAL_PREFIX = "link-embed-setup";
const LINK_EMBED_TAG_MODAL_PREFIX = "link-embed-tag";
const LINK_EMBED_BUTTON_PREFIX = "link-embed-account";
const LINK_EMBED_TITLE_FIELD = "embed_title";
const LINK_EMBED_DESCRIPTION_FIELD = "embed_description";
const LINK_EMBED_IMAGE_URL_FIELD = "embed_image_url";
const LINK_EMBED_THUMBNAIL_URL_FIELD = "embed_thumbnail_url";
const LINK_EMBED_PLAYER_TAG_FIELD = "player_tag";
const LINK_STATUS_PLAYER_TAG_FIELD = "player-tag";
const LINK_VERIFY_TOKEN_FIELD = "token";
const LINK_EMBED_SUPPORTED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
] as const;

const EMBED_DESCRIPTION_LIMIT = 4096;
const LINK_LIST_MAX_EMBEDS = 2;
const LINK_LIST_MAX_TOTAL_DESCRIPTION_CHARS = 5200;
const LINK_LIST_EMBED_DESCRIPTION_SAFE_LIMIT = 1500;
const LINK_LIST_TRIM_SUFFIX_TEMPLATE =
  "...and {hiddenRows} more rows hidden. Use another sort/filter or Refresh Data.";
const LINK_LIST_EMBED_COLOR = 0x5865f2;
const LINK_LIST_INACTIVITY_WARS_WINDOW = 3;
const LINK_EMBED_POST_COLOR = 0x5865f2;
const EMBED_TITLE_LIMIT = 256;
const LINK_EMBED_SETUP_MODAL_TITLE = "Link Account Embed";
const LINK_EMBED_TAG_MODAL_TITLE = "Link Account";
const LINK_EMBED_MODAL_DESCRIPTION_MAX = 4000;

type LinkListCurrentMemberRow = {
  playerTag: string;
  playerName: string;
  townHall: number | null;
  role: string | null;
  sourceSyncedAt: Date;
};

type LinkListTownHallRow = {
  playerTag: string;
  townHall: number | null;
};

type LinkListPlayerActivityRow = {
  tag: string;
  lastSeenAt: Date | null;
};

type LinkListTownHallCatalogRow = {
  playerTag: string;
  latestTownHall: number | null;
};

type GuildTrackedClanOption = {
  tag: string;
  name: string;
  badge: string | null;
  displayOrder: number | null;
};

type LinkListRenderResult =
  | {
      ok: true;
      payload: {
        embeds: EmbedBuilder[];
        components: ActionRowBuilder<
          StringSelectMenuBuilder | ButtonBuilder
        >[];
      };
    }
  | { ok: false; message: string };

type LinkListRenderContext = {
  guildId: string;
  clanTag: string;
  sortMode: LinkListSortMode;
};

type LinkListInteraction =
  | ChatInputCommandInteraction
  | StringSelectMenuInteraction
  | ButtonInteraction;

function normalizeUrlInput(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isValidHttpUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

type LinkCreateTagInput = {
  raw: string;
  normalized: string;
};

function splitLinkCreateTags(rawInput: string): {
  entries: LinkCreateTagInput[];
  hadComma: boolean;
} {
  const parts = String(rawInput ?? "").split(",");
  return {
    hadComma: parts.length > 1,
    entries: parts.map((part) => {
      const raw = part.trim();
      return {
        raw,
        normalized: normalizePlayerTag(raw),
      };
    }),
  };
}

type LinkDeleteTagInput = {
  raw: string;
  normalized: string | null;
};

/** Purpose: split a free-form delete request into normalized unique player-tag candidates. */
function splitLinkDeleteTags(rawInput: string): LinkDeleteTagInput[] {
  return String(rawInput ?? "")
    .split(/[\s,]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((raw) => ({
      raw,
      normalized: normalizePlayerTag(raw),
    }));
}

function buildLinkDeleteSummaryLines(input: {
  deleted: string[];
  notLinked: string[];
  invalid: string[];
  unauthorized: string[];
}): string[] {
  const lines: string[] = [];
  if (input.deleted.length > 0) {
    lines.push(`deleted: ${input.deleted.join(", ")}.`);
  }
  if (input.notLinked.length > 0) {
    lines.push(`not linked: ${input.notLinked.join(", ")}.`);
  }
  if (input.invalid.length > 0) {
    lines.push(`invalid: ${input.invalid.join(", ")}.`);
  }
  if (input.unauthorized.length > 0) {
    lines.push(`unauthorized: ${input.unauthorized.join(", ")}.`);
  }
  if (lines.length === 0) {
    lines.push("invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.");
  }
  return lines;
}

function formatLinkCreateResultMessage(input: {
  outcome: PlayerLinkCreateResult["outcome"];
  playerTag: string;
  existingDiscordUserId?: string | null;
  targetDiscordUserId: string;
  isSelfCreate: boolean;
}): string {
  if (input.outcome === "created") {
    const owner = input.isSelfCreate ? "you" : `<@${input.targetDiscordUserId}>`;
    return `created: ${input.playerTag} linked to ${owner}.`;
  }
  if (input.outcome === "already_linked_to_you") {
    return `already_linked_to_you: ${input.playerTag}.`;
  }
  if (input.outcome === "already_linked_to_target_user") {
    return `already_linked_to_target_user: ${input.playerTag} -> <@${input.targetDiscordUserId}>.`;
  }
  if (input.outcome === "already_linked_to_other_user") {
    return `already_linked_to_other_user: ${input.playerTag} is linked to <@${input.existingDiscordUserId}>. delete-first is required.`;
  }
  if (input.outcome === "invalid_user") {
    return "invalid_user: expected a Discord user.";
  }
  return "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.";
}

function formatPlayerLinkTrustTierLabel(tier: PlayerLinkTrustTier): string {
  if (tier === "verified") return "Verified";
  if (tier === "trusted") return "Trusted";
  if (tier === "legacy") return "Legacy";
  if (tier === "revoked") return "Revoked";
  return "Untrusted";
}

function formatPlayerLinkSourceLabel(source: string): string {
  return source.replace(/_/g, " ").toLowerCase();
}

function buildPlayerLinkStatusLines(link: PlayerLinkWithTrust): string[] {
  const lines = [
    `- ${link.playerTag}${link.playerName ? ` (${link.playerName})` : ""}`,
    `  source: ${formatPlayerLinkSourceLabel(link.linkSource)}`,
    `  verification: ${link.verificationStatus.toLowerCase()}`,
    `  verification method: ${link.verificationMethod ?? "none"}`,
    `  trusted for autorole: ${isPlayerLinkTrustedForAutorole(link) ? "yes" : "no"}`,
    `  verified for autorole: ${isPlayerLinkVerifiedForAutorole(link) ? "yes" : "no"}`,
    `  trust tier: ${formatPlayerLinkTrustTierLabel(getPlayerLinkTrustTier(link))}`,
    `  verified at: ${link.verifiedAt ? formatLinkedAtUtc(link.verifiedAt) : "never"}`,
    `  last verified at: ${link.lastVerifiedAt ? formatLinkedAtUtc(link.lastVerifiedAt) : "never"}`,
  ];
  if (link.verificationFailureReason) {
    lines.push(`  verification failure: ${link.verificationFailureReason}`);
  }
  if (link.importBatchKey) {
    lines.push(`  import batch: ${link.importBatchKey}`);
  }
  return lines;
}

function tryParseFiniteNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string" && input.trim().length > 0) {
    const parsed = Number(input.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractDisplayOrderFromMailConfig(mailConfig: unknown): number | null {
  if (!mailConfig || typeof mailConfig !== "object") return null;
  const obj = mailConfig as Record<string, unknown>;
  const direct =
    tryParseFiniteNumber(obj.displayOrder) ??
    tryParseFiniteNumber(obj.sortOrder) ??
    tryParseFiniteNumber(obj.order);
  if (direct !== null) return direct;

  const nested = obj.display;
  if (nested && typeof nested === "object") {
    const nestedObj = nested as Record<string, unknown>;
    return (
      tryParseFiniteNumber(nestedObj.order) ??
      tryParseFiniteNumber(nestedObj.displayOrder) ??
      null
    );
  }

  return null;
}

function sortTrackedClanOptions(
  a: GuildTrackedClanOption,
  b: GuildTrackedClanOption,
): number {
  if (
    a.displayOrder !== null &&
    b.displayOrder !== null &&
    a.displayOrder !== b.displayOrder
  ) {
    return a.displayOrder - b.displayOrder;
  }
  if (a.displayOrder !== null && b.displayOrder === null) return -1;
  if (a.displayOrder === null && b.displayOrder !== null) return 1;

  const byName = a.name.localeCompare(b.name, undefined, {
    sensitivity: "accent",
  });
  if (byName !== 0) return byName;
  return a.tag.localeCompare(b.tag, undefined, { sensitivity: "accent" });
}

function selectTrackedClanMenuOptions(
  ordered: GuildTrackedClanOption[],
  currentClanTag: string,
): GuildTrackedClanOption[] {
  if (ordered.length <= 25) return ordered;
  const first25 = ordered.slice(0, 25);
  if (first25.some((row) => row.tag === currentClanTag)) return first25;

  const current = ordered.find((row) => row.tag === currentClanTag);
  if (!current) return first25;
  const remainder = ordered
    .filter((row) => row.tag !== currentClanTag)
    .slice(0, 24);
  return [current, ...remainder];
}

async function getTrackedClansForGuild(
  guildId: string,
): Promise<GuildTrackedClanOption[]> {
  const guildWarRows = await prisma.currentWar.findMany({
    where: { guildId },
    select: { clanTag: true },
  });
  const tags = [
    ...new Set(
      guildWarRows.map((row) => normalizeClanTag(row.clanTag)).filter(Boolean),
    ),
  ];
  if (tags.length === 0) return [];

  const tracked = await prisma.trackedClan.findMany({
    where: { tag: { in: tags } },
    select: {
      tag: true,
      name: true,
      clanBadge: true,
      mailConfig: true,
    },
  });

  return tracked
    .map((row) => {
      const tag = normalizeClanTag(row.tag);
      if (!tag) return null;
      return {
        tag,
        name: sanitizeTableText(row.name ?? "") || tag,
        badge: row.clanBadge?.trim() || null,
        displayOrder: extractDisplayOrderFromMailConfig(row.mailConfig),
      } as GuildTrackedClanOption;
    })
    .filter((row): row is GuildTrackedClanOption => row !== null)
    .sort(sortTrackedClanOptions);
}

function buildClanSelectRows(input: {
  trackedClans: GuildTrackedClanOption[];
  currentClanTag: string;
  commandUserId: string;
  sortMode: LinkListSortMode;
  columns: LinkListColumnId[];
}): ActionRowBuilder<StringSelectMenuBuilder>[] {
  if (input.trackedClans.length === 0) return [];
  const selectedSet = selectTrackedClanMenuOptions(
    input.trackedClans,
    input.currentClanTag,
  );

  const options = selectedSet.map((row) => {
    const label = `${row.name} ${row.tag}`.trim().slice(0, 100);
    const description = row.badge
      ? `badge: ${sanitizeTableText(row.badge)}`.slice(0, 100)
      : undefined;
    return {
      label,
      value: row.tag,
      default: row.tag === input.currentClanTag,
      ...(description ? { description } : {}),
    };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(
      buildLinkListSelectCustomId(
        input.commandUserId,
        input.sortMode,
        input.columns,
      ),
    )
    .setPlaceholder("Select tracked clan")
    .addOptions(options);

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  ];
}

function buildLinkListSortRow(input: {
  commandUserId: string;
  currentClanTag: string;
  sortMode: LinkListSortMode;
  columns: LinkListColumnId[];
}): ActionRowBuilder<ButtonBuilder> {
  const sortLabel = getLinkListSortModeLabel(input.sortMode);
  const button = new ButtonBuilder()
    .setCustomId(
      buildLinkListSortButtonCustomId(
        input.commandUserId,
        input.currentClanTag,
        input.sortMode,
        input.columns,
      ),
    )
    .setLabel(`Sort: ${sortLabel}`)
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

function buildLinkListRefreshRow(input: {
  commandUserId: string;
  currentClanTag: string;
  sortMode: LinkListSortMode;
  columns: LinkListColumnId[];
}): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(
      buildLinkListRefreshButtonCustomId(
        input.commandUserId,
        input.currentClanTag,
        input.sortMode,
        input.columns,
      ),
    )
    .setLabel("Refresh Data")
    .setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

function buildLinkListColumnsRow(input: {
  commandUserId: string;
  currentClanTag: string;
  sortMode: LinkListSortMode;
  columns: LinkListColumnId[];
}): ActionRowBuilder<StringSelectMenuBuilder> {
  const selectedSet = new Set(input.columns);
  const select = new StringSelectMenuBuilder()
    .setCustomId(
      buildLinkListColumnsSelectCustomId(
        input.commandUserId,
        input.currentClanTag,
        input.sortMode,
        input.columns,
      ),
    )
    .setPlaceholder("Columns")
    .setMinValues(1)
    .setMaxValues(5)
    .addOptions(
      getLinkListSelectableColumns().map((columnId) => ({
        label: getLinkListColumnLabel(columnId),
        value: columnId,
        default: selectedSet.has(columnId),
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildLinkListControlRows(input: {
  trackedClans: GuildTrackedClanOption[];
  currentClanTag: string;
  commandUserId: string;
  sortMode: LinkListSortMode;
  columns: LinkListColumnId[];
  includeSortButton?: boolean;
}): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    buildLinkListRefreshRow(input),
  ];
  if (input.includeSortButton !== false) {
    rows.push(buildLinkListSortRow(input));
  }
  rows.push(buildLinkListColumnsRow(input));
  const selectRows = buildClanSelectRows(input);
  rows.push(...selectRows);
  return rows;
}

function resolveLinkedDiscordDisplayName(
  interaction: LinkListInteraction,
  discordUserId: string,
  persistedDiscordUsername: string | null,
): string {
  const member = interaction.guild?.members?.cache.get(discordUserId) ?? null;
  const memberDisplay = sanitizeTableText(member?.displayName ?? "");
  if (memberDisplay.length > 0) return memberDisplay;

  const globalName = sanitizeTableText(member?.user?.globalName ?? "");
  if (globalName.length > 0) return globalName;

  const username = sanitizeTableText(member?.user?.username ?? "");
  if (username.length > 0) return username;

  const persisted = sanitizeTableText(persistedDiscordUsername ?? "");
  if (persisted.length > 0) return persisted;

  return "Unknown User";
}

function resolveLinkedDiscordUsername(
  interaction: LinkListInteraction,
  discordUserId: string,
  persistedDiscordUsername: string | null,
): string {
  const member = interaction.guild?.members?.cache.get(discordUserId) ?? null;
  const username = sanitizeTableText(member?.user?.username ?? "");
  if (username.length > 0) return username;

  const persisted = sanitizeTableText(
    normalizePersistedDiscordUsername(persistedDiscordUsername) ?? "",
  );
  if (persisted.length > 0) return persisted;

  return "—";
}

function calculateLinkListDaysInactive(lastSeenAt: Date | null): number | null {
  if (!lastSeenAt) return null;
  const diffMs = Date.now() - lastSeenAt.getTime();
  return Math.max(0, Math.floor(diffMs / 86400000));
}

function rightAlign(value: string, width: number): string {
  if (value.length >= width) return value;
  return `${" ".repeat(width - value.length)}${value}`;
}

type LinkListRowInput = LinkListRowViewModel;

export const buildLinkListDescriptionLinesForTest = buildLinkListDescriptionLines;
export const getLinkListDefaultColumnsForSortModeForTest = getLinkListDefaultColumnsForSortMode;
export const getLinkListSelectableColumnsForTest = getLinkListSelectableColumns;
export const getLinkListColumnLabelForTest = getLinkListColumnLabel;
export const buildLinkListColumnsSelectCustomIdForTest = buildLinkListColumnsSelectCustomId;
export const parseLinkListColumnsSelectCustomIdForTest = parseLinkListColumnsSelectCustomId;

async function buildLinkListView(input: {
  interaction: LinkListInteraction;
  clanTag: string;
  commandUserId: string;
  sortMode?: LinkListSortMode;
  columns?: LinkListColumnId[];
}): Promise<LinkListRenderResult> {
  const sortMode = normalizeLinkListSortMode(input.sortMode);
  const activeColumns = normalizeLinkListColumns(input.columns, sortMode);

  if (!input.interaction.guildId) {
    return { ok: false, message: "This command can only be used in a server." };
  }

  const [currentMembers, tracked] = await Promise.all([
    prisma.fwaClanMemberCurrent.findMany({
      where: { clanTag: input.clanTag },
      orderBy: [{ rank: "asc" }, { playerTag: "asc" }],
      select: {
        playerTag: true,
        playerName: true,
        townHall: true,
        role: true,
        sourceSyncedAt: true,
      },
    }),
    prisma.trackedClan.findUnique({
      where: { tag: input.clanTag },
      select: { clanBadge: true, name: true },
    }),
  ]) as [LinkListCurrentMemberRow[], { clanBadge: string | null; name: string | null } | null];

  if (currentMembers.length === 0) {
    const trackedClans = await getTrackedClansForGuild(input.interaction.guildId);
    const components = buildLinkListControlRows({
      trackedClans,
      currentClanTag: input.clanTag,
      commandUserId: input.commandUserId,
      sortMode,
      columns: activeColumns,
      includeSortButton: false,
    });
    const clanName = sanitizeTableText(String(tracked?.name ?? "")) || input.clanTag;
    const title = buildTitleWithBadge({
      clanName,
      clanTag: input.clanTag,
      badge: tracked?.clanBadge?.trim() ?? null,
    });
    return {
      ok: true,
      payload: {
        embeds: buildDescriptionEmbeds(
          title,
          [
            `empty_list: no saved current clan members for ${input.clanTag}. Use Refresh Data or wait for sync.`,
          ],
          sortMode,
        ).embeds,
        components,
      },
    };
  }

  const memberTags = currentMembers
    .map((row) => normalizePlayerTag(row.playerTag))
    .filter((tag): tag is string => Boolean(tag));
  const inactivityNeeded = sortMode === "inactivity" || activeColumns.includes("inactivity");
  const [catalogRows, playerCurrentRows, playerActivityRows, inactivityMetricRows] = await Promise.all([
    prisma.fwaPlayerCatalog.findMany({
      where: { playerTag: { in: memberTags } },
      select: { playerTag: true, latestTownHall: true },
    }),
    prisma.playerCurrent.findMany({
      where: { playerTag: { in: memberTags } },
      select: { playerTag: true, townHall: true },
    }),
    inactivityNeeded
      ? prisma.playerActivity.findMany({
        where: {
          guildId: input.interaction.guildId,
          tag: { in: memberTags },
        },
        select: { tag: true, lastSeenAt: true },
      })
      : Promise.resolve([]),
    inactivityNeeded
      ? inactiveWarService.buildInactiveWarMetricByPlayerTag({
          guildId: input.interaction.guildId,
          wars: LINK_LIST_INACTIVITY_WARS_WINDOW,
          clanTag: input.clanTag,
        }).then((result) => result.metricsByPlayerTag)
      : Promise.resolve(new Map<string, InactiveWarMetricRow>()),
  ]) as [
    LinkListTownHallCatalogRow[],
    LinkListTownHallRow[],
    LinkListPlayerActivityRow[],
    Map<string, InactiveWarMetricRow>,
  ];
  const townHallByTag = new Map<string, number | null>();
  for (const row of currentMembers) {
    const normalizedTag = normalizePlayerTag(row.playerTag);
    if (!normalizedTag) continue;
    const catalogTownHall =
      catalogRows.find((entry) => entry.playerTag === normalizedTag)?.latestTownHall ?? null;
    const playerCurrentTownHall =
      playerCurrentRows.find((entry) => entry.playerTag === normalizedTag)?.townHall ?? null;
    townHallByTag.set(
      normalizedTag,
      resolveLinkListTownHall({
        memberTownHall: row.townHall,
        catalogTownHall,
        playerCurrentTownHall,
      }),
    );
  }
  const links = await listPlayerLinksForClanMembers({
    memberTagsInOrder: memberTags,
  });
  const weightByTag = await resolveLinkListDisplayWeightsByPlayerTags({
    playerTagsInOrder: memberTags,
    guildId: input.interaction.guildId,
    clanTag: input.clanTag,
  });
  const fillerTags = input.interaction.guildId
    ? await listFillerAccountTagsForGuild({
        guildId: input.interaction.guildId,
      }).catch(() => [])
    : [];
  const fillerTagSet = new Set(fillerTags);
  const inactivityDaysByTag = new Map<string, number | null>();
  for (const row of playerActivityRows) {
    const normalizedTag = normalizePlayerTag(row.tag);
    if (!normalizedTag) continue;
    inactivityDaysByTag.set(
      normalizedTag,
      calculateLinkListDaysInactive(row.lastSeenAt),
    );
  }
  const inactivityByTag = inactivityMetricRows;

  const linkByTag = new Map(links.map((row) => [row.playerTag, row]));
  const resolvedRows: LinkListResolvedMemberRow[] = [];

  currentMembers.forEach((member, index) => {
    const playerTag = normalizePlayerTag(member.playerTag);
    if (!playerTag) return;
    const playerName = sanitizeInlineCodeCell(
      truncateWithEllipsis(
        sanitizeInlineCodeCell(member.playerName) || "Unknown",
        MAX_PLAYER_NAME_CHARS,
      ),
    );
    const weightValue = weightByTag.get(playerTag) ?? null;
    const inactivityRow = inactivityByTag.get(playerTag) ?? null;
    const inactivityDays = inactivityDaysByTag.get(playerTag) ?? null;
    const inactivityMissedWars = inactivityRow?.missedWars ?? null;
    const inactivityParticipationWars = inactivityRow?.participationWars ?? null;
    const link = linkByTag.get(playerTag);
    const discordDisplayName = link
      ? sanitizeInlineCodeCell(
          truncateWithEllipsis(
            sanitizeInlineCodeCell(
              resolveLinkedDiscordDisplayName(
                input.interaction,
                link.discordUserId,
                link.discordUsername,
              ),
            ),
            MAX_IDENTITY_CHARS,
          ),
        )
      : sanitizeInlineCodeCell(WEIGHT_PLACEHOLDER);
    const discordUsername = link
      ? sanitizeInlineCodeCell(
          truncateWithEllipsis(
            sanitizeInlineCodeCell(
              resolveLinkedDiscordUsername(
                input.interaction,
                link.discordUserId,
                link.discordUsername,
              ) ?? WEIGHT_PLACEHOLDER,
            ),
            MAX_IDENTITY_CHARS,
          ),
        )
      : sanitizeInlineCodeCell(WEIGHT_PLACEHOLDER);
    const weightLabel = sanitizeInlineCodeCell(formatCompactWeightK(weightValue));
    const inactivityLabel = sanitizeInlineCodeCell(
      formatInactivityMetricLabel({
        daysInactive: inactivityDays,
        missedWars: inactivityMissedWars,
      }),
    );
    const clanRoleLabel = sanitizeInlineCodeCell(formatLinkListClanRole(member.role));
    const discordSort =
      sortMode === "player-tags"
        ? playerTag
        : link
          ? discordDisplayName
          : playerTag;

    resolvedRows.push({
      isLinked: Boolean(link),
      playerTag,
      defaultIndex: index,
      weightValue,
      inactivityDays,
      inactivityMissedWars,
      inactivityParticipationWars,
      clanRoleSortScore: getLinkListClanRoleSortScore(member.role),
      playerSort: sanitizeTableText(member.playerName) || "Unknown",
      discordSort: sanitizeTableText(discordSort),
      row: {
        townHallLabel: formatLinkListTownHallLabel(
          townHallByTag.get(playerTag) ?? member.townHall ?? null,
        ),
        playerName,
        displayValue: null,
        discordDisplayName,
        discordUsername,
        weightLabel,
        inactivityLabel,
        clanRoleLabel,
        playerTag,
        rightMarker: fillerTagSet.has(playerTag) ? "\u{1F9CD}" : null,
        isLinked: Boolean(link),
      },
    });
  });

  const sortedRows = sortLinkListRows(resolvedRows, sortMode);
  const linkedRows: LinkListRowInput[] = [];
  const unlinkedRows: LinkListRowInput[] = [];
  const columns = activeColumns;

  for (const row of sortedRows) {
    if (row.isLinked) {
      linkedRows.push(row.row);
      continue;
    }
    unlinkedRows.push(row.row);
  }

  const statusIcons = resolveLinkListStatusIcons();
  const lines = buildLinkListDescriptionLines({
    linkedRows,
    unlinkedRows,
    statusIcons,
    sortMode,
    columns,
  });

  if (lines.length === 0) {
    return {
      ok: false,
      message: `empty_list: no linked players found for ${input.clanTag}.`,
    };
  }

  const clanName = sanitizeTableText(String(tracked?.name ?? "")) || input.clanTag;
  const title = buildTitleWithBadge({
    clanName,
    clanTag: input.clanTag,
    badge: tracked?.clanBadge?.trim() ?? null,
  });

  const descriptionRender = buildDescriptionEmbeds(title, lines, sortMode);
  if (descriptionRender.trimmed) {
    console.info(
      `[link-list] event=link_list_payload_trimmed guildId=${input.interaction.guildId} clanTag=${input.clanTag} sortMode=${sortMode} renderedRows=${descriptionRender.renderedRows} hiddenRows=${descriptionRender.hiddenRows} embedCount=${descriptionRender.embedCount} totalDescriptionChars=${descriptionRender.totalDescriptionChars}`,
    );
  }

  const trackedClans = await getTrackedClansForGuild(input.interaction.guildId);
  const components = buildLinkListControlRows({
    trackedClans,
    currentClanTag: input.clanTag,
    commandUserId: input.commandUserId,
    sortMode,
    columns: activeColumns,
    includeSortButton: true,
  });

  return {
    ok: true,
    payload: { embeds: descriptionRender.embeds, components },
  };
}

async function buildLinkStatusMessage(input: {
  discordUserId: string;
  playerTag?: string | null;
}): Promise<string> {
  const normalizedPlayerTag = input.playerTag
    ? normalizePlayerTag(input.playerTag)
    : null;
  if (input.playerTag && !normalizedPlayerTag) {
    return "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.";
  }

  const links = await getPlayerLinksForDiscordUserWithTrust({
    discordUserId: input.discordUserId,
  });
  const filtered = normalizedPlayerTag
    ? links.filter((link) => link.playerTag === normalizedPlayerTag)
    : links;

  if (normalizedPlayerTag && filtered.length === 0) {
    return `not_found: ${normalizedPlayerTag} is not linked to your Discord account.`;
  }

  if (filtered.length === 0) {
    return "No linked player tags found.";
  }

  return [
    "Link trust state:",
    ...filtered.flatMap((link) => buildPlayerLinkStatusLines(link)),
  ].join("\n");
}

async function updateDeferredLinkListInteraction(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  result: LinkListRenderResult,
  context: LinkListRenderContext,
): Promise<void> {
  try {
    if (!result.ok) {
      await interaction.editReply({
        content: result.message,
        embeds: [],
        components: [],
      });
      return;
    }

    await interaction.editReply({
      content: null,
      ...result.payload,
    });
  } catch (err) {
    const code =
      (err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null)?.code ??
      (err as { status?: unknown } | null)?.status ??
      (err as { response?: { status?: unknown } } | null)?.response?.status ??
      "unknown";
    const message = String((err as { message?: unknown })?.message ?? err).slice(0, 200);
    console.warn(
      `[link-list] event=link_list_edit_failed guildId=${context.guildId} clanTag=${context.clanTag} sortMode=${context.sortMode} code=${code} message=${message}`,
    );
    await interaction.followUp({
      ephemeral: true,
      content:
        "link_list_too_large: this view was too large to render. Trimmed output will be used after rerun.",
    });
  }
}

export function buildLinkListSelectCustomId(
  userId: string,
  sortMode: LinkListSortMode = LINK_LIST_DEFAULT_SORT_MODE,
  columns?: LinkListColumnId[],
): string {
  const normalizedSort = normalizeLinkListSortMode(sortMode);
  const encodedColumns = encodeLinkListColumns(
    columns ?? getLinkListDefaultColumnsForSortMode(normalizedSort),
  );
  return `${LINK_LIST_SELECT_PREFIX}:${userId}:${normalizedSort}:${encodedColumns}`;
}

export function isLinkListSelectCustomId(customId: string): boolean {
  return customId.startsWith(`${LINK_LIST_SELECT_PREFIX}:`);
}

function parseLinkListSelectCustomId(
  customId: string,
): { userId: string; sortMode: LinkListSortMode; columns: LinkListColumnId[] } | null {
  const parts = customId.split(":");
  if ((parts.length !== 4 && parts.length !== 3) || parts[0] !== LINK_LIST_SELECT_PREFIX) {
    return null;
  }
  const userId = parts[1]?.trim() ?? "";
  if (!userId) return null;
  const sortMode = normalizeLinkListSortMode(parts[2]);
  return {
    userId,
    sortMode,
    columns: parseLinkListColumnsField(parts[3], sortMode),
  };
}

export function buildLinkListSortButtonCustomId(
  userId: string,
  clanTag: string,
  sortMode: LinkListSortMode,
  columns?: LinkListColumnId[],
): string {
  const normalizedSort = normalizeLinkListSortMode(sortMode);
  const encodedColumns = encodeLinkListColumns(
    columns ?? getLinkListDefaultColumnsForSortMode(normalizedSort),
  );
  return `${LINK_LIST_SORT_BUTTON_PREFIX}:${userId}:${clanTag}:${normalizedSort}:${encodedColumns}`;
}

export function isLinkListSortButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${LINK_LIST_SORT_BUTTON_PREFIX}:`);
}

function parseLinkListSortButtonCustomId(
  customId: string,
): { userId: string; clanTag: string; sortMode: LinkListSortMode; columns: LinkListColumnId[] } | null {
  const parts = String(customId ?? "").split(":");
  if ((parts.length !== 5 && parts.length !== 4) || parts[0] !== LINK_LIST_SORT_BUTTON_PREFIX) {
    return null;
  }
  const userId = parts[1]?.trim() ?? "";
  const clanTag = normalizeClanTag(parts[2] ?? "");
  if (!userId || !clanTag) return null;
  const sortMode = normalizeLinkListSortMode(parts[3]);
  return {
    userId,
    clanTag,
    sortMode,
    columns: parseLinkListColumnsField(parts[4], sortMode),
  };
}

export function buildLinkListRefreshButtonCustomId(
  userId: string,
  clanTag: string,
  sortMode: LinkListSortMode,
  columns?: LinkListColumnId[],
): string {
  const normalizedSort = normalizeLinkListSortMode(sortMode);
  const encodedColumns = encodeLinkListColumns(
    columns ?? getLinkListDefaultColumnsForSortMode(normalizedSort),
  );
  return `${LINK_LIST_REFRESH_BUTTON_PREFIX}:${userId}:${clanTag}:${normalizedSort}:${encodedColumns}`;
}

export function isLinkListRefreshButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${LINK_LIST_REFRESH_BUTTON_PREFIX}:`);
}

function parseLinkListRefreshButtonCustomId(
  customId: string,
): { userId: string; clanTag: string; sortMode: LinkListSortMode; columns: LinkListColumnId[] } | null {
  const parts = String(customId ?? "").split(":");
  if ((parts.length !== 5 && parts.length !== 4) || parts[0] !== LINK_LIST_REFRESH_BUTTON_PREFIX) {
    return null;
  }
  const userId = parts[1]?.trim() ?? "";
  const clanTag = normalizeClanTag(parts[2] ?? "");
  if (!userId || !clanTag) return null;
  const sortMode = normalizeLinkListSortMode(parts[3]);
  return {
    userId,
    clanTag,
    sortMode,
    columns: parseLinkListColumnsField(parts[4], sortMode),
  };
}

export function buildLinkListColumnsSelectCustomId(
  userId: string,
  clanTag: string,
  sortMode: LinkListSortMode,
  columns?: LinkListColumnId[],
): string {
  const normalizedSort = normalizeLinkListSortMode(sortMode);
  const encodedColumns = encodeLinkListColumns(
    columns ?? getLinkListDefaultColumnsForSortMode(normalizedSort),
  );
  return `${LINK_LIST_COLUMNS_SELECT_PREFIX}:${userId}:${clanTag}:${normalizedSort}:${encodedColumns}`;
}

export function isLinkListColumnsSelectCustomId(customId: string): boolean {
  return customId.startsWith(`${LINK_LIST_COLUMNS_SELECT_PREFIX}:`);
}

function parseLinkListColumnsSelectCustomId(
  customId: string,
): {
  userId: string;
  clanTag: string;
  sortMode: LinkListSortMode;
  columns: LinkListColumnId[];
} | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 5 || parts[0] !== LINK_LIST_COLUMNS_SELECT_PREFIX) {
    return null;
  }
  const userId = parts[1]?.trim() ?? "";
  const clanTag = normalizeClanTag(parts[2] ?? "");
  if (!userId || !clanTag) return null;
  const sortMode = normalizeLinkListSortMode(parts[3]);
  return {
    userId,
    clanTag,
    sortMode,
    columns: parseLinkListColumnsField(parts[4], sortMode),
  };
}

export function buildLinkEmbedSetupModalCustomId(
  userId: string,
  channelId: string,
): string {
  return `${LINK_EMBED_SETUP_MODAL_PREFIX}:${userId}:${channelId}`;
}

function parseLinkEmbedSetupModalCustomId(
  customId: string,
): { userId: string; channelId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== LINK_EMBED_SETUP_MODAL_PREFIX)
    return null;
  const userId = parts[1]?.trim() ?? "";
  const channelId = parts[2]?.trim() ?? "";
  if (!userId || !channelId) return null;
  return { userId, channelId };
}

export function buildLinkEmbedTagModalCustomId(guildId: string): string {
  return `${LINK_EMBED_TAG_MODAL_PREFIX}:${guildId}`;
}

function parseLinkEmbedTagModalCustomId(
  customId: string,
): { guildId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 2 || parts[0] !== LINK_EMBED_TAG_MODAL_PREFIX)
    return null;
  const guildId = parts[1]?.trim() ?? "";
  if (!guildId) return null;
  return { guildId };
}

export function buildLinkEmbedAccountButtonCustomId(guildId: string): string {
  return `${LINK_EMBED_BUTTON_PREFIX}:${guildId}`;
}

function parseLinkEmbedAccountButtonCustomId(
  customId: string,
): { guildId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 2 || parts[0] !== LINK_EMBED_BUTTON_PREFIX) return null;
  const guildId = parts[1]?.trim() ?? "";
  if (!guildId) return null;
  return { guildId };
}

export function isLinkEmbedAccountButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${LINK_EMBED_BUTTON_PREFIX}:`);
}

function buildReminderLinkConfirmationRows(input: {
  channelId: string;
  messageId: string;
  playerTag: string;
}): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildReminderLinkConfirmCustomId({
            channelId: input.channelId,
            messageId: input.messageId,
            playerTag: input.playerTag,
          }),
        )
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(
          buildReminderLinkCancelCustomId({
            channelId: input.channelId,
            messageId: input.messageId,
            playerTag: input.playerTag,
          }),
        )
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function resolveReminderLinkPlayerDisplayName(input: {
  messageContent: string;
  playerTag: string;
}): string {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  const firstLine = sanitizeTableText(String(input.messageContent ?? "").split("\n")[0] ?? "");
  if (!normalizedTag || !firstLine) return normalizedTag || "";

  const backtickedTag = `\`${normalizedTag}\``;
  const backtickedIndex = firstLine.indexOf(backtickedTag);
  if (backtickedIndex >= 0) {
    const beforeTag = firstLine.slice(0, backtickedIndex);
    const displayName = sanitizeTableText(
      beforeTag.replace(/^(?:#\d+\s*-\s*)?(?:❌|âŒ|:no:)\s+/, ""),
    );
    if (displayName) return displayName;
  }

  const rowMatch = firstLine.match(
    /^(?:#\d+\s*-\s*)?(?:❌|âŒ|:no:)\s+(.+?)\s+-\s+\d+\s+\/\s+\d+$/,
  );
  if (rowMatch?.[1]) {
    const displayName = sanitizeTableText(rowMatch[1]);
    if (displayName) return displayName;
  }

  return normalizedTag;
}

export function isReminderLinkButtonCustomId(customId: string): boolean {
  return parseReminderLinkButtonCustomId(customId) !== null;
}

export function isReminderLinkConfirmButtonCustomId(customId: string): boolean {
  return parseReminderLinkConfirmCustomId(customId) !== null;
}

export function isReminderLinkCancelButtonCustomId(customId: string): boolean {
  return parseReminderLinkCancelCustomId(customId) !== null;
}

function buildReminderLinkRejectedMessage(input: {
  playerTag: string;
  existingDiscordUserId?: string | null;
  outcome: PlayerLinkCreateResult["outcome"];
  targetDiscordUserId: string;
}): string {
  return formatLinkCreateResultMessage({
    outcome: input.outcome,
    playerTag: input.playerTag,
    existingDiscordUserId: input.existingDiscordUserId ?? null,
    targetDiscordUserId: input.targetDiscordUserId,
    isSelfCreate: true,
  });
}

export function isLinkEmbedModalCustomId(customId: string): boolean {
  const input = String(customId ?? "");
  return (
    input.startsWith(`${LINK_EMBED_SETUP_MODAL_PREFIX}:`) ||
    input.startsWith(`${LINK_EMBED_TAG_MODAL_PREFIX}:`)
  );
}

function isSupportedLinkEmbedChannel(
  channel: { type?: number } | null | undefined,
): boolean {
  if (!channel || typeof channel.type !== "number") return false;
  return LINK_EMBED_SUPPORTED_CHANNEL_TYPES.includes(
    channel.type as (typeof LINK_EMBED_SUPPORTED_CHANNEL_TYPES)[number],
  );
}

async function resolveGuildMemberMe(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
) {
  if (!interaction.guild) return null;
  if (interaction.guild.members.me) return interaction.guild.members.me;
  try {
    return await interaction.guild.members.fetchMe();
  } catch {
    return null;
  }
}

async function validateLinkEmbedTargetChannel(input: {
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction;
  channel: any;
}): Promise<string | null> {
  const { interaction, channel } = input;
  if (!interaction.guildId || !interaction.guild) {
    return "This command can only be used in a server.";
  }

  const channelGuildId = String(channel?.guildId ?? "");
  if (!channelGuildId || channelGuildId !== interaction.guildId) {
    return "invalid_channel: channel must belong to this server.";
  }

  if (!isSupportedLinkEmbedChannel(channel)) {
    return "invalid_channel_type: use a server text or announcement channel.";
  }

  if (!channel || typeof channel.send !== "function") {
    return "invalid_channel_type: selected channel cannot accept messages.";
  }

  const me = await resolveGuildMemberMe(interaction);
  const permissions =
    me && typeof channel.permissionsFor === "function"
      ? channel.permissionsFor(me)
      : null;
  const missing: string[] = [];
  if (!permissions?.has(PermissionFlagsBits.ViewChannel))
    missing.push("ViewChannel");
  if (!permissions?.has(PermissionFlagsBits.SendMessages))
    missing.push("SendMessages");
  if (!permissions?.has(PermissionFlagsBits.EmbedLinks))
    missing.push("EmbedLinks");

  if (missing.length > 0) {
    return `missing_bot_permissions: ${missing.join(", ")}`;
  }

  return null;
}

export async function handleLinkListSelectMenu(
  interaction: StringSelectMenuInteraction,
  _cocService: CoCService,
): Promise<void> {
  const parsed = parseLinkListSelectCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this menu.",
    });
    return;
  }

  const selectedTagRaw = interaction.values[0] ?? "";
  const selectedTag = normalizeClanTag(selectedTagRaw);
  if (!selectedTag) {
    await interaction.reply({
      ephemeral: true,
      content: "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
    });
    return;
  }

  await interaction.deferUpdate();
  const result = await buildLinkListView({
    interaction,
    clanTag: selectedTag,
    commandUserId: parsed.userId,
    sortMode: parsed.sortMode,
    columns: parsed.columns,
  });
  await updateDeferredLinkListInteraction(interaction, result, {
    guildId: interaction.guildId ?? "",
    clanTag: selectedTag,
    sortMode: parsed.sortMode,
  });
}

export async function handleLinkListColumnsSelectMenu(
  interaction: StringSelectMenuInteraction,
  _cocService: CoCService,
): Promise<void> {
  const parsed = parseLinkListColumnsSelectCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this menu.",
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This command can only be used in a server.",
    });
    return;
  }

  const selectedColumns = buildLinkListOrderedColumnsFromSelection({
    previousColumns: parsed.columns,
    selectedColumns: interaction.values,
    sortMode: parsed.sortMode,
  });

  await interaction.deferUpdate();
  const result = await buildLinkListView({
    interaction,
    clanTag: parsed.clanTag,
    commandUserId: parsed.userId,
    sortMode: parsed.sortMode,
    columns: selectedColumns,
  });
  await updateDeferredLinkListInteraction(interaction, result, {
    guildId: interaction.guildId,
    clanTag: parsed.clanTag,
    sortMode: parsed.sortMode,
  });
}

export async function handleLinkListSortButton(
  interaction: ButtonInteraction,
  _cocService: CoCService,
): Promise<void> {
  const parsed = parseLinkListSortButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  const nextSortMode = getNextLinkListSortMode(parsed.sortMode);
  const nextColumns = isLinkListDefaultColumnsForSortMode(parsed.columns, parsed.sortMode)
    ? getLinkListDefaultColumnsForSortMode(nextSortMode)
    : parsed.columns;
  await interaction.deferUpdate();
  const result = await buildLinkListView({
    interaction,
    clanTag: parsed.clanTag,
    commandUserId: parsed.userId,
    sortMode: nextSortMode,
    columns: nextColumns,
  });
  await updateDeferredLinkListInteraction(interaction, result, {
    guildId: interaction.guildId ?? "",
    clanTag: parsed.clanTag,
    sortMode: nextSortMode,
  });
}

export async function handleLinkListRefreshButton(
  interaction: ButtonInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseLinkListRefreshButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This button can only be used in a server.",
    });
    return;
  }

  await interaction.deferUpdate();

  const clanTag = parsed.clanTag;
  let clan: Awaited<ReturnType<CoCService["getClan"]>> | null = null;
  try {
    clan = await cocService.getClan(clanTag);
  } catch (err) {
    const status =
      (err as { status?: unknown; response?: { status?: unknown } } | null)?.status ??
      (err as { response?: { status?: unknown } } | null)?.response?.status ??
      null;
    const code =
      (err as { code?: unknown } | null)?.code ?? null;
    console.warn(
      `[link-list] event=refresh_failed guild_id=${interaction.guildId} clan_tag=${clanTag} command_user_id=${parsed.userId} status=${status ?? "unknown"} code=${code ?? "unknown"} error=${String((err as { message?: unknown })?.message ?? err).slice(0, 200)}`,
    );
    await interaction.followUp({
      ephemeral: true,
      content: `refresh_failed: CoC API failed for ${clanTag}. Showing last saved roster.`,
    });
    return;
  }

  try {
    const members = Array.isArray(clan?.members) ? clan.members : [];
    const refreshResult = await linkListMembersSyncService.refreshCurrentClanMembersForClanTags(
      [clanTag],
      {
        cocService: {
          getClan: async () => clan,
        } as unknown as CoCService,
      },
    );
    if (refreshResult.failedClans.includes(clanTag)) {
      console.warn(
        `[link-list] event=refresh_failed guild_id=${interaction.guildId} clan_tag=${clanTag} command_user_id=${parsed.userId} status=sync_failed code=sync_failed error=selected clan refresh failed`,
      );
      await interaction.followUp({
        ephemeral: true,
        content: `refresh_failed: CoC API failed for ${clanTag}. Showing last saved roster.`,
      });
      return;
    }
    console.info(
      `[link-list] event=refresh_success guild_id=${interaction.guildId} clan_tag=${clanTag} command_user_id=${parsed.userId} member_count=${members.length}`,
    );
  } catch (err) {
    const errorCode =
      (err as { code?: unknown } | null)?.code ?? "unknown";
    console.warn(
      `[link-list] event=refresh_failed guild_id=${interaction.guildId} clan_tag=${clanTag} command_user_id=${parsed.userId} status=sync_failed code=${errorCode} error=${String((err as { message?: unknown })?.message ?? err).slice(0, 200)}`,
    );
    await interaction.followUp({
      ephemeral: true,
      content: `refresh_failed: CoC API failed for ${clanTag}. Showing last saved roster.`,
    });
    return;
  }

  const result = await buildLinkListView({
    interaction,
    clanTag,
    commandUserId: parsed.userId,
    sortMode: parsed.sortMode,
    columns: parsed.columns,
  });
  await updateDeferredLinkListInteraction(interaction, result, {
    guildId: interaction.guildId ?? "",
    clanTag,
    sortMode: parsed.sortMode,
  });
}

export async function handleLinkEmbedButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseLinkEmbedAccountButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (!interaction.guildId || interaction.guildId !== parsed.guildId) {
    await interaction.reply({
      ephemeral: true,
      content:
        "invalid_context: this link button can only be used in its original server.",
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(buildLinkEmbedTagModalCustomId(interaction.guildId))
    .setTitle(LINK_EMBED_TAG_MODAL_TITLE)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(LINK_EMBED_PLAYER_TAG_FIELD)
          .setLabel("Player Tag")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(16),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleReminderLinkButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseReminderLinkButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (!interaction.guildId || interaction.guildId !== parsed.guildId) {
    await interaction.reply({
      ephemeral: true,
      content:
        "invalid_context: this reminder link button can only be used in its original server.",
    });
    return;
  }

  if (!interaction.channelId) {
    await interaction.reply({
      ephemeral: true,
      content: "invalid_context: unable to open reminder link confirmation.",
    });
    return;
  }

  const playerName = resolveReminderLinkPlayerDisplayName({
    messageContent: interaction.message?.content ?? "",
    playerTag: parsed.playerTag,
  });
  const confirmationIdentity =
    playerName && playerName !== parsed.playerTag
      ? `${playerName} ${parsed.playerTag}`
      : parsed.playerTag;

  await interaction.reply({
    ephemeral: true,
    content: `Link ${confirmationIdentity} to your Discord account?`,
    components: buildReminderLinkConfirmationRows({
      channelId: interaction.channelId,
      messageId: interaction.message.id,
      playerTag: parsed.playerTag,
    }),
  });
}

export async function handleReminderLinkConfirmButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseReminderLinkConfirmCustomId(interaction.customId);
  if (!parsed) return;

  if (!interaction.guildId || interaction.channelId !== parsed.channelId) {
    await interaction.reply({
      ephemeral: true,
      content:
        "invalid_context: this reminder link confirmation can only be used in its original channel.",
    });
    return;
  }

  await interaction.deferUpdate();

  const result = await createPlayerLink({
    playerTag: parsed.playerTag,
    targetDiscordUserId: interaction.user.id,
    selfService: true,
  });

  if (result.outcome === "created") {
    await disableReminderLinkButtonOnOriginalMessage({
      interaction,
      channelId: parsed.channelId,
      messageId: parsed.messageId,
      playerTag: parsed.playerTag,
    });
  }

  await interaction.editReply(
    buildReminderLinkRejectedMessage({
      outcome: result.outcome,
      playerTag: result.playerTag,
      existingDiscordUserId: result.existingDiscordUserId,
      targetDiscordUserId: interaction.user.id,
    }),
  );
}

export async function handleReminderLinkCancelButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseReminderLinkCancelCustomId(interaction.customId);
  if (!parsed) return;

  if (!interaction.guildId || interaction.channelId !== parsed.channelId) {
    await interaction.reply({
      ephemeral: true,
      content:
        "invalid_context: this reminder link cancellation can only be used in its original channel.",
    });
    return;
  }

  await interaction.update({
    content: "Canceled.",
    components: [],
  });
}

function disableReminderLinkButtonOnOriginalMessage(input: {
  interaction: ButtonInteraction;
  channelId: string;
  messageId: string;
  playerTag: string;
}): Promise<void> {
  return (async () => {
    const channel = await input.interaction.client.channels.fetch(input.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      return;
    }

    const message = await channel.messages.fetch(input.messageId).catch(() => null);
    if (!message) return;

    const updatedComponents = message.components.map((row) => {
      const rowJson = row.toJSON() as {
        type?: number;
        components?: Array<Record<string, unknown>>;
      };
      return {
        ...rowJson,
        components: Array.isArray(rowJson.components)
          ? rowJson.components.map((component) => {
              const customId = String(component.custom_id ?? component.customId ?? "");
              if (
                customId.startsWith("reminder-link:claim:") &&
                customId.endsWith(`:${input.playerTag}`)
              ) {
                return {
                  ...component,
                  disabled: true,
                };
              }
              return component;
            })
          : [],
      };
    });

    await message.edit({ components: updatedComponents as any }).catch(() => undefined);
  })();
}

export async function handleLinkEmbedModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const setupParsed = parseLinkEmbedSetupModalCustomId(interaction.customId);
  if (setupParsed) {
    const canUse = await permissionService.canUseAnyTarget(
      ["link:embed"],
      interaction,
    );
    if (!canUse) {
      await interaction.reply({
        ephemeral: true,
        content: "You do not have permission to use /link embed.",
      });
      return;
    }

    if (interaction.user.id !== setupParsed.userId) {
      await interaction.reply({
        ephemeral: true,
        content: "Only the user who opened this modal can submit it.",
      });
      return;
    }

    if (!interaction.guild) {
      await interaction.reply({
        ephemeral: true,
        content: "This action can only be used in a server.",
      });
      return;
    }

    const targetChannel =
      interaction.guild.channels.cache.get(setupParsed.channelId) ??
      (await interaction.guild.channels
        .fetch(setupParsed.channelId)
        .catch(() => null));

    const channelError = await validateLinkEmbedTargetChannel({
      interaction,
      channel: targetChannel,
    });
    if (channelError) {
      await interaction.reply({ ephemeral: true, content: channelError });
      return;
    }

    const rawTitle = interaction.fields.getTextInputValue(
      LINK_EMBED_TITLE_FIELD,
    );
    const rawDescription = interaction.fields.getTextInputValue(
      LINK_EMBED_DESCRIPTION_FIELD,
    );
    const title = String(rawTitle ?? "").trim();
    const description = String(rawDescription ?? "").trim();
    if (!title || !description) {
      await interaction.reply({
        ephemeral: true,
        content: "invalid_embed_fields: title and description are required.",
      });
      return;
    }
    if (title.length > EMBED_TITLE_LIMIT) {
      await interaction.reply({
        ephemeral: true,
        content: `invalid_embed_title_length: max ${EMBED_TITLE_LIMIT} characters.`,
      });
      return;
    }
    if (description.length > EMBED_DESCRIPTION_LIMIT) {
      await interaction.reply({
        ephemeral: true,
        content: `invalid_embed_description_length: max ${EMBED_DESCRIPTION_LIMIT} characters.`,
      });
      return;
    }

    const imageUrl = normalizeUrlInput(
      interaction.fields.getTextInputValue(LINK_EMBED_IMAGE_URL_FIELD),
    );
    if (imageUrl && !isValidHttpUrl(imageUrl)) {
      await interaction.reply({
        ephemeral: true,
        content:
          "invalid_image_url: provide an absolute http:// or https:// URL.",
      });
      return;
    }

    const thumbnailUrl = normalizeUrlInput(
      interaction.fields.getTextInputValue(LINK_EMBED_THUMBNAIL_URL_FIELD),
    );
    if (thumbnailUrl && !isValidHttpUrl(thumbnailUrl)) {
      await interaction.reply({
        ephemeral: true,
        content:
          "invalid_thumbnail_url: provide an absolute http:// or https:// URL.",
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(LINK_EMBED_POST_COLOR)
      .setTitle(title)
      .setDescription(description);
    if (imageUrl) embed.setImage(imageUrl);
    if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);

    const guildId = interaction.guildId ?? interaction.guild.id;
    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildLinkEmbedAccountButtonCustomId(guildId))
        .setLabel("Link Account")
        .setStyle(ButtonStyle.Primary),
    );

    try {
      const sendableChannel = targetChannel as {
        id: string;
        send: (payload: unknown) => Promise<{ url?: string }>;
      };
      const sent = await sendableChannel.send({
        embeds: [embed],
        components: [buttonRow],
      });
      const location = sent?.url ? ` ${sent.url}` : "";
      await interaction.reply({
        ephemeral: true,
        content: `link_embed_posted: posted to <#${sendableChannel.id}>.${location}`,
      });
    } catch {
      await interaction.reply({
        ephemeral: true,
        content: "send_failed: unable to post link embed in that channel.",
      });
    }
    return;
  }

  const tagParsed = parseLinkEmbedTagModalCustomId(interaction.customId);
  if (!tagParsed) return;

  if (!interaction.guildId || interaction.guildId !== tagParsed.guildId) {
    await interaction.reply({
      ephemeral: true,
      content:
        "invalid_context: this link action can only be used in its original server.",
    });
    return;
  }

  const rawTag = interaction.fields.getTextInputValue(
    LINK_EMBED_PLAYER_TAG_FIELD,
  );
  const normalizedTag = normalizePlayerTag(rawTag);
  if (!normalizedTag) {
    await interaction.reply({
      ephemeral: true,
      content: "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
    });
    return;
  }

  try {
    const result = await createPlayerLinkFromEmbed({
      playerTag: normalizedTag,
      submittingDiscordUserId: interaction.user.id,
      submittingDiscordUsername:
        normalizePersistedDiscordUsername(interaction.user.username) ??
        "unknown",
    });
    if (result.outcome === "created") {
      await interaction.reply({
        ephemeral: true,
        content: `created: ${result.playerTag} linked to you.`,
      });
      return;
    }
    if (result.outcome === "already_linked") {
      await interaction.reply({
        ephemeral: true,
        content: `already_linked: ${result.playerTag} already has a link. run \`/link delete player-tag:${result.playerTag}\` first.`,
      });
      return;
    }
    if (result.outcome === "invalid_tag") {
      await interaction.reply({
        ephemeral: true,
        content:
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
      });
      return;
    }
    await interaction.reply({
      ephemeral: true,
      content: "invalid_user: expected a valid Discord user.",
    });
  } catch {
    await interaction.reply({
      ephemeral: true,
      content: "db_error: unable to persist this link right now.",
    });
  }
}

function canAdminBypass(interaction: ChatInputCommandInteraction): boolean {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
    false
  );
}

async function canUseAdminCreateOverride(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (canAdminBypass(interaction)) return true;
  return permissionService.canUseAnyTarget(
    ["link:create:other-user"],
    interaction,
  );
}

async function canUseAdminDeleteOverride(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (canAdminBypass(interaction)) return true;
  return permissionService.canUseAnyTarget(["link:delete:admin"], interaction);
}

async function canUseLinkEmbed(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (canAdminBypass(interaction)) return true;
  return permissionService.canUseAnyTarget(["link:embed"], interaction);
}

async function canUseLinkSyncClashperk(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (canAdminBypass(interaction)) return true;
  return permissionService.canUseAnyTarget(
    ["link:sync-clashperk"],
    interaction,
  );
}

export const Link: Command = {
  name: "link",
  description: "Manage local Discord-player links",
  options: [
    {
      name: "create",
      description: "Create a local player-tag link",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag(s), comma-separated, with or without #",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "user",
          description: "Selected Discord user override (FWA Leader/Admin)",
          type: ApplicationCommandOptionType.User,
          required: false,
        },
      ],
    },
    {
      name: "delete",
      description: "Delete one or more local player-tag links",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag(s), comma-separated, space-separated, or mixed-separated; with or without #",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "verify",
      description: "Verify ownership of one of your linked player tags",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: LINK_STATUS_PLAYER_TAG_FIELD,
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: LINK_VERIFY_TOKEN_FIELD,
          description: "Player API token from the in-game settings",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "status",
      description: "Show link trust state for one of your linked player tags",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: LINK_STATUS_PLAYER_TAG_FIELD,
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "list",
      description: "List linked players for a clan's current roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "embed",
      description:
        "Post a reusable Link Account embed with self-service button",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "channel",
          description: "Target text channel for the Link Account embed",
          type: ApplicationCommandOptionType.Channel,
          required: true,
          channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        },
      ],
    },
    {
      name: "sync-clashperk",
      description:
        "Import missing PlayerLink rows from a public ClashPerk Google Sheet",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "sheet-url",
          description: "Public Google Sheet URL (or sheet ID)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService,
  ) => {
    if (!interaction.guildId) {
      await interaction.reply({
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "embed") {
      const allowed = await canUseLinkEmbed(interaction);
      if (!allowed) {
        await interaction.reply({
          ephemeral: true,
          content: "not_allowed: only admins can use /link embed.",
        });
        return;
      }

      const channel = interaction.options.getChannel("channel", true);
      const channelError = await validateLinkEmbedTargetChannel({
        interaction,
        channel,
      });
      if (channelError) {
        await interaction.reply({
          ephemeral: true,
          content: channelError,
        });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(
          buildLinkEmbedSetupModalCustomId(interaction.user.id, channel.id),
        )
        .setTitle(LINK_EMBED_SETUP_MODAL_TITLE)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(LINK_EMBED_TITLE_FIELD)
              .setLabel("Embed Title")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(EMBED_TITLE_LIMIT),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(LINK_EMBED_DESCRIPTION_FIELD)
              .setLabel("Embed Description")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(LINK_EMBED_MODAL_DESCRIPTION_MAX),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(LINK_EMBED_IMAGE_URL_FIELD)
              .setLabel("Image URL")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(512),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(LINK_EMBED_THUMBNAIL_URL_FIELD)
              .setLabel("Thumbnail URL")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(512),
          ),
        );

      await interaction.showModal(modal);
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (subcommand === "create") {
      const rawTag = interaction.options.getString("player-tag", true);
      const parsedTags = splitLinkCreateTags(rawTag);
      const firstValidTag = parsedTags.entries.find((entry) => entry.normalized);
      if (!parsedTags.hadComma && !firstValidTag?.normalized) {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
        );
        return;
      }

      const requestedUser = interaction.options.getUser("user", false);
      const targetDiscordUserId = requestedUser?.id ?? interaction.user.id;
      const isSelfCreate = targetDiscordUserId === interaction.user.id;
      if (!isSelfCreate) {
        const allowed = await canUseAdminCreateOverride(interaction);
        if (!allowed) {
          await interaction.editReply(
            "not_allowed: only admins or FWA Leaders can create links for another Discord user.",
          );
          return;
        }
      }

      if (!parsedTags.hadComma && firstValidTag?.normalized) {
        const result = await createPlayerLink({
          playerTag: firstValidTag.normalized,
          targetDiscordUserId,
          selfService: isSelfCreate,
        });

        await interaction.editReply(
          formatLinkCreateResultMessage({
            outcome: result.outcome,
            playerTag: result.playerTag,
            existingDiscordUserId: result.existingDiscordUserId,
            targetDiscordUserId,
            isSelfCreate,
          }),
        );
        return;
      }

      const resultLines: string[] = [];
      for (const entry of parsedTags.entries) {
        if (!entry.normalized) {
          resultLines.push(
            entry.raw
              ? `invalid_tag: ${entry.raw} is not a valid Clash tag.`
              : "invalid_tag: empty entry.",
          );
          continue;
        }

        const result = await createPlayerLink({
          playerTag: entry.normalized,
          targetDiscordUserId,
          selfService: isSelfCreate,
        });
        resultLines.push(
          formatLinkCreateResultMessage({
            outcome: result.outcome,
            playerTag: result.playerTag,
            existingDiscordUserId: result.existingDiscordUserId,
            targetDiscordUserId,
            isSelfCreate,
          }),
        );
      }

      await interaction.editReply(resultLines.join("\n"));
      return;
    }

    if (subcommand === "delete") {
      const rawTag = interaction.options.getString("player-tag", true);
      const parsedTags = splitLinkDeleteTags(rawTag);
      const validTags = [
        ...new Set(
          parsedTags
            .map((entry) => entry.normalized)
            .filter((tag): tag is string => Boolean(tag)),
        ),
      ];
      const invalidTags = [
        ...new Set(
          parsedTags
            .filter((entry) => !entry.normalized)
            .map((entry) => entry.raw),
        ),
      ];
      if (validTags.length === 0 && invalidTags.length === 0) {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
        );
        return;
      }

      const canDeleteAny = await canUseAdminDeleteOverride(interaction);
      const deleted: string[] = [];
      const notLinked: string[] = [];
      const unauthorized: string[] = [];

      for (const playerTag of validTags) {
        const result = await deletePlayerLink({
          playerTag,
          requestingDiscordUserId: interaction.user.id,
          allowAdminDelete: canDeleteAny,
        });

        if (result.outcome === "deleted") {
          deleted.push(result.playerTag);
          continue;
        }
        if (result.outcome === "not_found") {
          notLinked.push(result.playerTag);
          continue;
        }
        if (result.outcome === "not_owner") {
          unauthorized.push(result.playerTag);
          continue;
        }
        invalidTags.push(result.playerTag);
      }

      await interaction.editReply(
        buildLinkDeleteSummaryLines({
          deleted,
          notLinked,
          invalid: invalidTags,
          unauthorized,
        }).join("\n"),
      );
      return;
    }

    if (subcommand === "verify") {
      const rawTag = interaction.options.getString(LINK_STATUS_PLAYER_TAG_FIELD, true);
      const token = interaction.options.getString(LINK_VERIFY_TOKEN_FIELD, true);
      const verificationService = new PlayerLinkVerificationService(cocService);
      const result = await verificationService.verifyPlayerToken({
        playerTag: rawTag,
        discordUserId: interaction.user.id,
        token,
      });

      if (result.outcome === "verified") {
        await interaction.editReply(
          `verified: ${result.playerTag} now has verified ownership state.`,
        );
        return;
      }
      if (result.outcome === "invalid_tag") {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
        );
        return;
      }
      if (result.outcome === "invalid_user") {
        await interaction.editReply(
          "invalid_user: expected a Discord user.",
        );
        return;
      }
      if (result.outcome === "not_found") {
        await interaction.editReply(
          `not_found: no active link for ${result.playerTag}.`,
        );
        return;
      }
      if (result.outcome === "not_owner") {
        await interaction.editReply(
          `not_owner: ${result.playerTag} is linked to another Discord user.`,
        );
        return;
      }
      if (result.outcome === "service_error") {
        await interaction.editReply(
          `verification_failed: ${result.playerTag} could not be verified right now.`,
        );
        return;
      }
      await interaction.editReply(
        `invalid_token: ${result.playerTag} could not be verified.`,
      );
      return;
    }

    if (subcommand === "status") {
      const rawTag = interaction.options.getString(LINK_STATUS_PLAYER_TAG_FIELD, false);
      const result = await buildLinkStatusMessage({
        discordUserId: interaction.user.id,
        playerTag: rawTag,
      });
      await interaction.editReply(result);
      return;
    }

    if (subcommand === "sync-clashperk") {
      const allowed = await canUseLinkSyncClashperk(interaction);
      if (!allowed) {
        await interaction.editReply(
          "not_allowed: only admins can use /link sync-clashperk.",
        );
        return;
      }

      const sheetUrl = interaction.options.getString("sheet-url", true);
      const syncService = new PlayerLinkSyncService();
      const result = await syncService.syncFromPublicGoogleSheet(sheetUrl);

      await interaction.editReply(
        [
          `sync_complete: inserted ${result.insertedCount} new link(s).`,
          `updated existing links: ${result.updatedCount}`,
          `unchanged existing links skipped: ${result.unchangedCount}`,
          `eligible rows: ${result.eligibleRowCount}`,
          `duplicate sheet tags skipped: ${result.duplicateTagCount}`,
          `rows missing Tag, ID, or Username skipped: ${result.missingRequiredCount}`,
          `invalid tags skipped: ${result.invalidTagCount}`,
          `invalid discord ids skipped: ${result.invalidDiscordUserIdCount}`,
        ].join("\n"),
      );
      return;
    }

    const rawClanTag = interaction.options.getString("clan-tag", true);
    const normalizedClanTag = normalizeClanTag(rawClanTag);
    if (!normalizedClanTag) {
      await interaction.editReply(
        "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
      );
      return;
    }

    const result = await buildLinkListView({
      interaction,
      clanTag: normalizedClanTag,
      commandUserId: interaction.user.id,
      sortMode: LINK_LIST_DEFAULT_SORT_MODE,
    });
    if (!result.ok) {
      await interaction.editReply(result.message);
      return;
    }

    await interaction.editReply(result.payload);
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan-tag") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "")
      .trim()
      .toUpperCase()
      .replace(/^#/, "");
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((row) => {
        const normalized = normalizeClanTag(row.tag).replace(/^#/, "");
        const title = row.name?.trim()
          ? `${row.name.trim()} (#${normalized})`
          : `#${normalized}`;
        return { name: title.slice(0, 100), value: normalized };
      })
      .filter(
        (choice) =>
          choice.value.toLowerCase().includes(query.toLowerCase()) ||
          choice.name.toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 25);
    await interaction.respond(choices);
  },
};



