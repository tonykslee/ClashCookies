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
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import { emojiResolverService } from "../services/emoji/EmojiResolverService";
import { listOpenDeferredWeightsByPlayerTags } from "../services/WeightInputDefermentService";
import {
  createPlayerLink,
  createPlayerLinkFromEmbed,
  deletePlayerLink,
  listCurrentWeightsForClanMembers,
  listPlayerLinksForClanMembers,
  type PlayerLinkCreateResult,
  normalizeClanTag,
  normalizePersistedDiscordUsername,
  normalizePlayerTag,
} from "../services/PlayerLinkService";
import { PlayerLinkSyncService } from "../services/PlayerLinkSyncService";

const permissionService = new CommandPermissionService();
const LINK_LIST_SELECT_PREFIX = "link-list-select";
const LINK_LIST_SORT_BUTTON_PREFIX = "link-list-sort-cycle";
const LINK_EMBED_SETUP_MODAL_PREFIX = "link-embed-setup";
const LINK_EMBED_TAG_MODAL_PREFIX = "link-embed-tag";
const LINK_EMBED_BUTTON_PREFIX = "link-embed-account";
const LINK_EMBED_TITLE_FIELD = "embed_title";
const LINK_EMBED_DESCRIPTION_FIELD = "embed_description";
const LINK_EMBED_IMAGE_URL_FIELD = "embed_image_url";
const LINK_EMBED_THUMBNAIL_URL_FIELD = "embed_thumbnail_url";
const LINK_EMBED_PLAYER_TAG_FIELD = "player_tag";
const LINK_EMBED_SUPPORTED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
] as const;

const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_MESSAGE_LIMIT = 10;
const LINK_LIST_EMBED_COLOR = 0x5865f2;
const LINK_EMBED_POST_COLOR = 0x5865f2;
const EMBED_TITLE_LIMIT = 256;
const LINK_EMBED_SETUP_MODAL_TITLE = "Link Account Embed";
const LINK_EMBED_TAG_MODAL_TITLE = "Link Account";
const LINK_EMBED_MODAL_DESCRIPTION_MAX = 4000;

const MAX_PLAYER_NAME_CHARS = 28;
const MAX_IDENTITY_CHARS = 30;
const LINK_LIST_LINKED_EMOJI_NAME = "yes";
const LINK_LIST_UNLINKED_EMOJI_NAME = "no";
const LINK_LIST_LINKED_FALLBACK_EMOJI = "✅";
const LINK_LIST_UNLINKED_FALLBACK_EMOJI = "❌";
const WEIGHT_PLACEHOLDER = "—";
const LINK_LIST_DEFERRED_WEIGHT_FALLBACK_EMOJI = "⏳";
const LINK_LIST_SORT_MODE_CYCLE = [
  "discord",
  "weight",
  "player-tags",
  "player",
] as const;

type LinkListSortMode = (typeof LINK_LIST_SORT_MODE_CYCLE)[number];
const LINK_LIST_DEFAULT_SORT_MODE: LinkListSortMode = "discord";

type ClanMemberRow = {
  playerTag: string;
  playerName: string;
  townHallText: string;
  mapPosition: number | null;
  index: number;
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

type LinkListInteraction =
  | ChatInputCommandInteraction
  | StringSelectMenuInteraction
  | ButtonInteraction;

function sanitizeTableText(input: string): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateWithEllipsis(input: string, maxLength: number): string {
  const normalized = sanitizeTableText(input);
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 3) return normalized.slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeLinkListSortMode(
  input: string | null | undefined,
): LinkListSortMode {
  const value = String(input ?? "").trim().toLowerCase();
  if (
    value === "discord" ||
    value === "weight" ||
    value === "player-tags" ||
    value === "player"
  ) {
    return value;
  }
  return LINK_LIST_DEFAULT_SORT_MODE;
}

function getLinkListSortModeLabel(mode: LinkListSortMode): string {
  if (mode === "weight") return "Weight Desc";
  if (mode === "player-tags") return "Player Tags";
  if (mode === "player") return "Player Name";
  return "Discord Name";
}

function getNextLinkListSortMode(mode: LinkListSortMode): LinkListSortMode {
  const currentIndex = LINK_LIST_SORT_MODE_CYCLE.indexOf(mode);
  const nextIndex =
    currentIndex >= 0
      ? (currentIndex + 1) % LINK_LIST_SORT_MODE_CYCLE.length
      : 0;
  return LINK_LIST_SORT_MODE_CYCLE[nextIndex];
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

function buildTitleWithBadge(input: {
  clanName: string;
  clanTag: string;
  badge: string | null;
}): string {
  const pieces = [
    input.badge?.trim() ?? "",
    input.clanName.trim(),
    input.clanTag.trim(),
  ].filter((piece) => piece.length > 0);
  return pieces.join(" ");
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

function normalizeClanMembers(rawMembers: unknown[]): ClanMemberRow[] {
  const mapped = rawMembers
    .map((member, index) => {
      const row = member as {
        tag?: string;
        name?: string;
        townHallLevel?: number | string | null;
        mapPosition?: number | null;
      } | null;
      const playerTag = normalizePlayerTag(String(row?.tag ?? ""));
      if (!playerTag) return null;

      const name = sanitizeTableText(String(row?.name ?? "")) || playerTag;
      const mapPositionRaw = tryParseFiniteNumber(row?.mapPosition);
      const townHallRaw = tryParseFiniteNumber(row?.townHallLevel);
      const townHallText =
        townHallRaw !== null && townHallRaw >= 1
          ? String(Math.floor(townHallRaw))
          : "?";

      return {
        playerTag,
        playerName: name,
        townHallText,
        mapPosition:
          mapPositionRaw !== null ? Math.floor(mapPositionRaw) : null,
        index,
      } as ClanMemberRow;
    })
    .filter((row): row is ClanMemberRow => row !== null);

  mapped.sort((a, b) => {
    if (
      a.mapPosition !== null &&
      b.mapPosition !== null &&
      a.mapPosition !== b.mapPosition
    ) {
      return a.mapPosition - b.mapPosition;
    }
    if (a.mapPosition !== null && b.mapPosition === null) return -1;
    if (a.mapPosition === null && b.mapPosition !== null) return 1;
    return a.index - b.index;
  });

  const deduped: ClanMemberRow[] = [];
  const seen = new Set<string>();
  for (const row of mapped) {
    if (seen.has(row.playerTag)) continue;
    seen.add(row.playerTag);
    deduped.push(row);
  }
  return deduped;
}

type DescriptionChunk = {
  text: string;
  lineCount: number;
};

function chunkDescriptionLines(lines: string[]): DescriptionChunk[] {
  const chunks: DescriptionChunk[] = [];
  let current = "";
  let currentCount = 0;

  for (const rawLine of lines) {
    const line =
      rawLine.length <= EMBED_DESCRIPTION_LIMIT
        ? rawLine
        : `${rawLine.slice(0, EMBED_DESCRIPTION_LIMIT - 12)}...truncated`;
    const candidate = current.length > 0 ? `${current}\n${line}` : line;

    if (candidate.length <= EMBED_DESCRIPTION_LIMIT) {
      current = candidate;
      currentCount += 1;
      continue;
    }

    if (current.length > 0) {
      chunks.push({ text: current, lineCount: currentCount });
    }
    current = line;
    currentCount = 1;
  }

  if (current.length > 0) {
    chunks.push({ text: current, lineCount: currentCount });
  }

  return chunks;
}

function appendDroppedSuffix(chunkText: string, droppedCount: number): string {
  const suffix = `\n...and ${droppedCount} more`;
  if (chunkText.length + suffix.length <= EMBED_DESCRIPTION_LIMIT) {
    return `${chunkText}${suffix}`;
  }
  const keepLength = Math.max(0, EMBED_DESCRIPTION_LIMIT - suffix.length);
  return `${chunkText.slice(0, keepLength)}${suffix}`;
}

function buildDescriptionEmbeds(
  title: string,
  lines: string[],
  sortMode: LinkListSortMode,
): EmbedBuilder[] {
  const sortLabel = getLinkListSortModeLabel(sortMode);
  const chunks = chunkDescriptionLines(lines);
  if (chunks.length === 0) {
    return [
      new EmbedBuilder()
        .setColor(LINK_LIST_EMBED_COLOR)
        .setTitle(title)
        .setFooter({ text: `Sort: ${sortLabel}` })
        .setDescription("empty_list: no rows to render."),
    ];
  }

  let workingChunks = [...chunks];
  if (workingChunks.length > EMBED_MESSAGE_LIMIT) {
    const kept = workingChunks.slice(0, EMBED_MESSAGE_LIMIT);
    const droppedLineCount = workingChunks
      .slice(EMBED_MESSAGE_LIMIT)
      .reduce((sum, chunk) => sum + chunk.lineCount, 0);
    kept[kept.length - 1] = {
      text: appendDroppedSuffix(kept[kept.length - 1].text, droppedLineCount),
      lineCount: kept[kept.length - 1].lineCount,
    };
    workingChunks = kept;
  }

  return workingChunks.map((chunk, index) => {
    const embedTitle = index === 0 ? title : `${title} (cont. ${index + 1})`;
    return new EmbedBuilder()
      .setColor(LINK_LIST_EMBED_COLOR)
      .setTitle(embedTitle)
      .setFooter({ text: `Sort: ${sortLabel}` })
      .setDescription(chunk.text);
  });
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
      buildLinkListSelectCustomId(input.commandUserId, input.sortMode),
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
}): ActionRowBuilder<ButtonBuilder> {
  const sortLabel = getLinkListSortModeLabel(input.sortMode);
  const button = new ButtonBuilder()
    .setCustomId(
      buildLinkListSortButtonCustomId(
        input.commandUserId,
        input.currentClanTag,
        input.sortMode,
      ),
    )
    .setLabel(`Sort: ${sortLabel}`)
    .setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

function buildLinkListControlRows(input: {
  trackedClans: GuildTrackedClanOption[];
  currentClanTag: string;
  commandUserId: string;
  sortMode: LinkListSortMode;
}): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    buildLinkListSortRow(input),
  ];
  const selectRows = buildClanSelectRows(input);
  rows.push(...selectRows);
  return rows;
}

function resolveLinkedUserDisplayName(
  interaction: LinkListInteraction,
  discordUserId: string,
  persistedDiscordUsername: string | null,
): string {
  const member = interaction.guild?.members?.cache.get(discordUserId) ?? null;

  console.log("link-list identity", {
    discordUserId,
    memberDisplay: member?.displayName,
    username: member?.user?.username,
    persistedDiscordUsername,
  });

  const username = sanitizeTableText(member?.user?.username ?? "");
  if (username.length > 0) return username;

  const persisted = sanitizeTableText(persistedDiscordUsername ?? "");
  if (persisted.length > 0) return persisted;

  const memberDisplay = sanitizeTableText(member?.displayName ?? "");
  if (memberDisplay.length > 0) return memberDisplay;

  return "Unknown User";
}

function rightAlign(value: string, width: number): string {
  if (value.length >= width) return value;
  return `${" ".repeat(width - value.length)}${value}`;
}

type LinkListRowInput = {
  th: string;
  weight: string;
  playerName: string;
  third: string;
  rightMarker?: string | null;
};

type LinkListResolvedMemberRow = {
  isLinked: boolean;
  playerTag: string;
  defaultIndex: number;
  weightValue: number | null;
  playerSort: string;
  discordSort: string;
  row: LinkListRowInput;
};

type LinkListStatusIcons = {
  linked: string;
  unlinked: string;
};

async function resolveLinkListStatusIcons(
  client: LinkListInteraction["client"],
): Promise<LinkListStatusIcons> {
  const fallback: LinkListStatusIcons = {
    linked: LINK_LIST_LINKED_FALLBACK_EMOJI,
    unlinked: LINK_LIST_UNLINKED_FALLBACK_EMOJI,
  };

  const inventory = await emojiResolverService
    .fetchApplicationEmojiInventory(client as Client)
    .catch(() => null);
  if (!inventory?.ok) return fallback;

  const resolveByName = (name: string): string | null => {
    const exact = inventory.snapshot.exactByName.get(name);
    if (exact?.rendered) return exact.rendered;
    const lower = inventory.snapshot.lowercaseByName.get(name.toLowerCase());
    if (lower?.rendered) return lower.rendered;
    return null;
  };

  return {
    linked: resolveByName(LINK_LIST_LINKED_EMOJI_NAME) ?? fallback.linked,
    unlinked: resolveByName(LINK_LIST_UNLINKED_EMOJI_NAME) ?? fallback.unlinked,
  };
}

function compareSortText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function sortLinkListRows(
  rows: LinkListResolvedMemberRow[],
  sortMode: LinkListSortMode,
): LinkListResolvedMemberRow[] {
  return [...rows].sort((a, b) => {
    if (sortMode === "weight" || sortMode === "player-tags") {
      const aHasWeight = a.weightValue !== null;
      const bHasWeight = b.weightValue !== null;
      if (aHasWeight !== bHasWeight) return aHasWeight ? -1 : 1;
      if (
        a.weightValue !== null &&
        b.weightValue !== null &&
        a.weightValue !== b.weightValue
      ) {
        return b.weightValue - a.weightValue;
      }
      const byDiscord = compareSortText(a.discordSort, b.discordSort);
      if (byDiscord !== 0) return byDiscord;
      const byPlayer = compareSortText(a.playerSort, b.playerSort);
      if (byPlayer !== 0) return byPlayer;
      if (a.playerTag !== b.playerTag) {
        return compareSortText(a.playerTag, b.playerTag);
      }
      return a.defaultIndex - b.defaultIndex;
    }

    if (sortMode === "player") {
      const byPlayer = compareSortText(a.playerSort, b.playerSort);
      if (byPlayer !== 0) return byPlayer;
      const byDiscord = compareSortText(a.discordSort, b.discordSort);
      if (byDiscord !== 0) return byDiscord;
      if (a.playerTag !== b.playerTag) {
        return compareSortText(a.playerTag, b.playerTag);
      }
      return a.defaultIndex - b.defaultIndex;
    }

    const byDiscord = compareSortText(a.discordSort, b.discordSort);
    if (byDiscord !== 0) return byDiscord;
    const byPlayer = compareSortText(a.playerSort, b.playerSort);
    if (byPlayer !== 0) return byPlayer;
    if (a.playerTag !== b.playerTag) {
      return compareSortText(a.playerTag, b.playerTag);
    }
    return a.defaultIndex - b.defaultIndex;
  });
}

function formatCompactWeightK(weight: number | null | undefined): string {
  if (weight === null || weight === undefined || !Number.isFinite(weight)) {
    return WEIGHT_PLACEHOLDER;
  }
  const normalized = Math.max(0, Math.trunc(weight));
  return `${Math.trunc(normalized / 1000)}k`;
}

function formatAlignedInlineRow(
  row: LinkListRowInput,
  widths: { player: number; third: number; weight: number },
  statusPrefix: string,
): string {
  const weight = rightAlign(row.weight, widths.weight);
  const playerName = rightAlign(row.playerName, widths.player);
  const discordName = rightAlign(row.third, widths.third);
  const base = `${statusPrefix} \`${row.th}  ${discordName}  ${playerName}  ${weight}\``;
  if (!row.rightMarker) return base;
  return `${base} ${row.rightMarker}`;
}

function computeColumnWidths(
  linkedRows: LinkListRowInput[],
  unlinkedRows: LinkListRowInput[],
): {
  player: number;
  linkedThird: number;
  unlinkedThird: number;
  weight: number;
} {
  const allRows = [...linkedRows, ...unlinkedRows];
  const player = Math.max(
    6,
    ...allRows
      .map((row) => row.playerName.length)
      .filter((value) => Number.isFinite(value)),
  );

  const linkedThird = Math.max(
    3,
    ...linkedRows
      .map((row) => row.third.length)
      .filter((value) => Number.isFinite(value)),
  );
  const unlinkedThird = Math.max(
    3,
    ...unlinkedRows
      .map((row) => row.third.length)
      .filter((value) => Number.isFinite(value)),
  );
  const weight = Math.max(
    WEIGHT_PLACEHOLDER.length,
    ...allRows
      .map((row) => row.weight.length)
      .filter((value) => Number.isFinite(value)),
  );

  return { player, linkedThird, unlinkedThird, weight };
}

function buildLinkListDescriptionLines(input: {
  linkedRows: LinkListRowInput[];
  unlinkedRows: LinkListRowInput[];
  statusIcons: LinkListStatusIcons;
}): string[] {
  const { linkedRows, unlinkedRows } = input;
  const widths = computeColumnWidths(linkedRows, unlinkedRows);
  const lines: string[] = [];

  if (linkedRows.length > 0) {
    lines.push(`Linked Users: ${linkedRows.length}`);

    lines.push(
      ...linkedRows.map((row) =>
        formatAlignedInlineRow(row, {
          player: widths.player,
          weight: widths.weight,
          third: widths.linkedThird,
        }, input.statusIcons.linked),
      ),
    );
  }

  if (unlinkedRows.length > 0) {
    lines.push(`Unlinked users: ${unlinkedRows.length}`);
    lines.push(
      ...unlinkedRows.map((row) =>
        formatAlignedInlineRow(row, {
          player: widths.player,
          weight: widths.weight,
          third: widths.unlinkedThird,
        }, input.statusIcons.unlinked),
      ),
    );
  }

  return lines;
}

async function buildLinkListView(input: {
  interaction: LinkListInteraction;
  cocService: CoCService;
  clanTag: string;
  commandUserId: string;
  sortMode?: LinkListSortMode;
}): Promise<LinkListRenderResult> {
  const sortMode = normalizeLinkListSortMode(input.sortMode);

  if (!input.interaction.guildId) {
    return { ok: false, message: "This command can only be used in a server." };
  }

  let clan: Awaited<ReturnType<CoCService["getClan"]>>;
  try {
    clan = await input.cocService.getClan(input.clanTag);
  } catch {
    return {
      ok: false,
      message: `not_found: clan ${input.clanTag} could not be resolved.`,
    };
  }

  const members = normalizeClanMembers(
    Array.isArray(clan?.members) ? clan.members : [],
  );
  if (members.length === 0) {
    return {
      ok: false,
      message: `empty_list: no current clan members for ${input.clanTag}.`,
    };
  }

  const links = await listPlayerLinksForClanMembers({
    memberTagsInOrder: members.map((row) => row.playerTag),
  });
  const weightByTag = await listCurrentWeightsForClanMembers({
    memberTagsInOrder: members.map((row) => row.playerTag),
  });
  const deferredWeightByTag = await listOpenDeferredWeightsByPlayerTags({
    guildId: input.interaction.guildId,
    clanTag: input.clanTag,
    playerTags: members.map((row) => row.playerTag),
  });

  const linkByTag = new Map(links.map((row) => [row.playerTag, row]));
  const resolvedRows: LinkListResolvedMemberRow[] = [];

  members.forEach((member, index) => {
    const playerName = truncateWithEllipsis(
      member.playerName,
      MAX_PLAYER_NAME_CHARS,
    );
    const rawWeight = weightByTag.get(member.playerTag);
    const normalWeightValue =
      typeof rawWeight === "number" && Number.isFinite(rawWeight)
        ? Math.trunc(rawWeight)
        : null;
    const deferredWeightRaw = deferredWeightByTag.get(member.playerTag);
    const deferredWeightValue =
      typeof deferredWeightRaw === "number" &&
      Number.isFinite(deferredWeightRaw)
        ? Math.max(0, Math.trunc(deferredWeightRaw))
        : null;
    const shouldUseDeferredWeight =
      normalWeightValue === 0 &&
      deferredWeightValue !== null &&
      deferredWeightValue > 0;
    const weightValue = shouldUseDeferredWeight
      ? deferredWeightValue
      : normalWeightValue;
    const weight = formatCompactWeightK(weightValue);
    const link = linkByTag.get(member.playerTag);
    const third = truncateWithEllipsis(
      sortMode === "player-tags"
        ? member.playerTag
        : link
          ? resolveLinkedUserDisplayName(
              input.interaction,
              link.discordUserId,
              link.discordUsername,
            )
          : member.playerTag,
      MAX_IDENTITY_CHARS,
    );

    resolvedRows.push({
      isLinked: Boolean(link),
      playerTag: member.playerTag,
      defaultIndex: index,
      weightValue,
      playerSort: sanitizeTableText(playerName),
      discordSort: sanitizeTableText(third),
      row: {
        th: member.townHallText,
        weight,
        playerName,
        third,
        rightMarker: shouldUseDeferredWeight
          ? LINK_LIST_DEFERRED_WEIGHT_FALLBACK_EMOJI
          : null,
      },
    });
  });

  const sortedRows = sortLinkListRows(resolvedRows, sortMode);
  const linkedRows: LinkListRowInput[] = [];
  const unlinkedRows: LinkListRowInput[] = [];

  for (const row of sortedRows) {
    if (row.isLinked) {
      linkedRows.push(row.row);
      continue;
    }
    unlinkedRows.push(row.row);
  }

  const statusIcons = await resolveLinkListStatusIcons(input.interaction.client);
  const lines = buildLinkListDescriptionLines({
    linkedRows,
    unlinkedRows,
    statusIcons,
  });

  if (lines.length === 0) {
    return {
      ok: false,
      message: `empty_list: no linked players found for ${input.clanTag}.`,
    };
  }

  const tracked = await prisma.trackedClan.findUnique({
    where: { tag: input.clanTag },
    select: { clanBadge: true, name: true },
  });
  const clanName =
    sanitizeTableText(String(clan?.name ?? "")) ||
    sanitizeTableText(tracked?.name ?? "") ||
    input.clanTag;
  const title = buildTitleWithBadge({
    clanName,
    clanTag: input.clanTag,
    badge: tracked?.clanBadge?.trim() ?? null,
  });

  const embeds = buildDescriptionEmbeds(title, lines, sortMode);

  const trackedClans = await getTrackedClansForGuild(input.interaction.guildId);
  const components = buildLinkListControlRows({
    trackedClans,
    currentClanTag: input.clanTag,
    commandUserId: input.commandUserId,
    sortMode,
  });

  return {
    ok: true,
    payload: { embeds, components },
  };
}

async function updateDeferredLinkListInteraction(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  result: LinkListRenderResult,
): Promise<void> {
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
}

export function buildLinkListSelectCustomId(
  userId: string,
  sortMode: LinkListSortMode = LINK_LIST_DEFAULT_SORT_MODE,
): string {
  const normalizedSort = normalizeLinkListSortMode(sortMode);
  return `${LINK_LIST_SELECT_PREFIX}:${userId}:${normalizedSort}`;
}

export function isLinkListSelectCustomId(customId: string): boolean {
  return customId.startsWith(`${LINK_LIST_SELECT_PREFIX}:`);
}

function parseLinkListSelectCustomId(
  customId: string,
): { userId: string; sortMode: LinkListSortMode } | null {
  const parts = customId.split(":");
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts[0] !== LINK_LIST_SELECT_PREFIX
  ) {
    return null;
  }
  const userId = parts[1]?.trim() ?? "";
  if (!userId) return null;
  return {
    userId,
    sortMode: normalizeLinkListSortMode(parts[2]),
  };
}

export function buildLinkListSortButtonCustomId(
  userId: string,
  clanTag: string,
  sortMode: LinkListSortMode,
): string {
  return `${LINK_LIST_SORT_BUTTON_PREFIX}:${userId}:${clanTag}:${normalizeLinkListSortMode(sortMode)}`;
}

export function isLinkListSortButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${LINK_LIST_SORT_BUTTON_PREFIX}:`);
}

function parseLinkListSortButtonCustomId(
  customId: string,
): { userId: string; clanTag: string; sortMode: LinkListSortMode } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== LINK_LIST_SORT_BUTTON_PREFIX) {
    return null;
  }
  const userId = parts[1]?.trim() ?? "";
  const clanTag = normalizeClanTag(parts[2] ?? "");
  if (!userId || !clanTag) return null;
  return {
    userId,
    clanTag,
    sortMode: normalizeLinkListSortMode(parts[3]),
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
  cocService: CoCService,
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
    cocService,
    clanTag: selectedTag,
    commandUserId: parsed.userId,
    sortMode: parsed.sortMode,
  });
  await updateDeferredLinkListInteraction(interaction, result);
}

export async function handleLinkListSortButton(
  interaction: ButtonInteraction,
  cocService: CoCService,
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
  await interaction.deferUpdate();
  const result = await buildLinkListView({
    interaction,
    cocService,
    clanTag: parsed.clanTag,
    commandUserId: parsed.userId,
    sortMode: nextSortMode,
  });
  await updateDeferredLinkListInteraction(interaction, result);
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
      description: "Delete a local player-tag link",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
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
      const normalizedTag = normalizePlayerTag(rawTag);
      if (!normalizedTag) {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
        );
        return;
      }

      const canDeleteAny = await canUseAdminDeleteOverride(interaction);
      const result = await deletePlayerLink({
        playerTag: normalizedTag,
        requestingDiscordUserId: interaction.user.id,
        allowAdminDelete: canDeleteAny,
      });

      if (result.outcome === "deleted") {
        await interaction.editReply(`deleted: ${result.playerTag}.`);
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
      await interaction.editReply(
        "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
      );
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
      cocService,
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
