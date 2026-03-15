import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import {
  createPlayerLink,
  deletePlayerLink,
  listPlayerLinksForClanMembers,
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "../services/PlayerLinkService";

const permissionService = new CommandPermissionService();
const LINK_LIST_SELECT_PREFIX = "link-list-select";

const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_FIELD_COUNT_LIMIT = 25;
const EMBED_TOTAL_CHARS_LIMIT = 6000;
const EMBED_MESSAGE_LIMIT = 10;
const LINK_LIST_EMBED_COLOR = 0x5865f2;

const TH_WIDTH = 2;
const PLAYER_WIDTH = 18;
const DISCORD_WIDTH = 30;
const TAG_WIDTH = 15;

type ClanMemberRow = {
  playerTag: string;
  playerName: string;
  townHallText: string;
  mapPosition: number | null;
  index: number;
};

type LinkedRosterRow = {
  townHallText: string;
  playerName: string;
  discordLabel: string;
};

type UnlinkedRosterRow = {
  townHallText: string;
  playerName: string;
  playerTag: string;
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
        components: ActionRowBuilder<StringSelectMenuBuilder>[];
      };
    }
  | { ok: false; message: string };

function sanitizeTableText(input: string): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function formatTableCell(value: string, width: number): string {
  const safe = sanitizeTableText(value);
  if (safe.length <= width) return safe.padEnd(width, " ");
  if (width <= 3) return safe.slice(0, width);
  return `${safe.slice(0, width - 3)}...`;
}

function toCodeBlock(lines: string[]): string {
  return ["```text", ...lines, "```"].join("\n");
}

function buildTitleWithBadge(input: { clanName: string; clanTag: string; badge: string | null }): string {
  const pieces = [input.badge?.trim() ?? "", input.clanName.trim(), input.clanTag.trim()].filter(
    (piece) => piece.length > 0
  );
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

function sortTrackedClanOptions(a: GuildTrackedClanOption, b: GuildTrackedClanOption): number {
  if (a.displayOrder !== null && b.displayOrder !== null && a.displayOrder !== b.displayOrder) {
    return a.displayOrder - b.displayOrder;
  }
  if (a.displayOrder !== null && b.displayOrder === null) return -1;
  if (a.displayOrder === null && b.displayOrder !== null) return 1;

  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "accent" });
  if (byName !== 0) return byName;
  return a.tag.localeCompare(b.tag, undefined, { sensitivity: "accent" });
}

function selectTrackedClanMenuOptions(
  ordered: GuildTrackedClanOption[],
  currentClanTag: string
): GuildTrackedClanOption[] {
  if (ordered.length <= 25) return ordered;
  const first25 = ordered.slice(0, 25);
  if (first25.some((row) => row.tag === currentClanTag)) return first25;

  const current = ordered.find((row) => row.tag === currentClanTag);
  if (!current) return first25;
  const remainder = ordered.filter((row) => row.tag !== currentClanTag).slice(0, 24);
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
        townHallRaw !== null && townHallRaw >= 1 ? String(Math.floor(townHallRaw)) : "?";

      return {
        playerTag,
        playerName: name,
        townHallText,
        mapPosition: mapPositionRaw !== null ? Math.floor(mapPositionRaw) : null,
        index,
      } as ClanMemberRow;
    })
    .filter((row): row is ClanMemberRow => row !== null);

  mapped.sort((a, b) => {
    if (a.mapPosition !== null && b.mapPosition !== null && a.mapPosition !== b.mapPosition) {
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

function resolveDiscordLabel(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  discordUserId: string
): string {
  const member = interaction.guild?.members?.cache.get(discordUserId);
  if (member?.displayName) {
    return `${member.displayName} (${discordUserId})`;
  }

  const user = interaction.client.users.cache.get(discordUserId);
  if (user?.username) {
    return `${user.username} (${discordUserId})`;
  }

  return discordUserId;
}

function buildLinkedTableRows(rows: LinkedRosterRow[], droppedCount: number): string[] {
  const dataRows = rows.map(
    (row) =>
      `${formatTableCell(row.townHallText, TH_WIDTH)} | ${formatTableCell(row.playerName, PLAYER_WIDTH)} | ${formatTableCell(row.discordLabel, DISCORD_WIDTH)}`
  );

  if (dataRows.length === 0) {
    dataRows.push(
      `${formatTableCell("--", TH_WIDTH)} | ${formatTableCell("-- none --", PLAYER_WIDTH)} | ${formatTableCell("--", DISCORD_WIDTH)}`
    );
  }

  if (droppedCount > 0) {
    dataRows.push(
      `${formatTableCell("--", TH_WIDTH)} | ${formatTableCell(`...and ${droppedCount} more`, PLAYER_WIDTH)} | ${formatTableCell("--", DISCORD_WIDTH)}`
    );
  }
  return dataRows;
}

function buildUnlinkedTableRows(rows: UnlinkedRosterRow[], droppedCount: number): string[] {
  const dataRows = rows.map(
    (row) =>
      `${formatTableCell(row.townHallText, TH_WIDTH)} | ${formatTableCell(row.playerName, PLAYER_WIDTH)} | ${formatTableCell(row.playerTag, TAG_WIDTH)}`
  );

  if (dataRows.length === 0) {
    dataRows.push(
      `${formatTableCell("--", TH_WIDTH)} | ${formatTableCell("-- none --", PLAYER_WIDTH)} | ${formatTableCell("--", TAG_WIDTH)}`
    );
  }

  if (droppedCount > 0) {
    dataRows.push(
      `${formatTableCell("--", TH_WIDTH)} | ${formatTableCell(`...and ${droppedCount} more`, PLAYER_WIDTH)} | ${formatTableCell("--", TAG_WIDTH)}`
    );
  }
  return dataRows;
}

function splitSectionIntoFieldValues(input: {
  header: string;
  separator: string;
  rows: string[];
}): string[] {
  const values: string[] = [];
  const mandatory = [input.header, input.separator];
  const rows = input.rows.length > 0 ? input.rows : [formatTableCell("-- none --", PLAYER_WIDTH)];
  let cursor = 0;

  while (cursor < rows.length) {
    const chunk = [...mandatory];
    while (cursor < rows.length) {
      const candidate = toCodeBlock([...chunk, rows[cursor]]);
      if (candidate.length > EMBED_FIELD_VALUE_LIMIT && chunk.length > mandatory.length) {
        break;
      }
      if (candidate.length > EMBED_FIELD_VALUE_LIMIT) {
        const base = toCodeBlock(chunk);
        const remaining = Math.max(8, EMBED_FIELD_VALUE_LIMIT - base.length - 4);
        chunk.push(formatTableCell(rows[cursor], remaining));
        cursor += 1;
        break;
      }
      chunk.push(rows[cursor]);
      cursor += 1;
    }
    values.push(toCodeBlock(chunk));
  }

  if (values.length === 0) {
    values.push(toCodeBlock([...mandatory, formatTableCell("-- none --", PLAYER_WIDTH)]));
  }
  return values;
}

function buildSectionFieldEntries(
  sectionName: "Players linked" | "Unlinked Players",
  values: string[]
): Array<{ name: string; value: string }> {
  return values.map((value, index) => ({
    name: index === 0 ? sectionName : `${sectionName} (cont. ${index + 1})`,
    value,
  }));
}

function packFieldsIntoEmbeds(title: string, fields: Array<{ name: string; value: string }>): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];
  let currentFields: Array<{ name: string; value: string }> = [];
  let currentTitle = title;
  let currentChars = currentTitle.length;

  const flush = () => {
    const embed = new EmbedBuilder().setColor(LINK_LIST_EMBED_COLOR).setTitle(currentTitle);
    if (currentFields.length > 0) {
      embed.addFields(
        currentFields.map((field) => ({
          name: field.name.slice(0, 256),
          value: field.value.slice(0, EMBED_FIELD_VALUE_LIMIT),
          inline: false,
        }))
      );
    }
    embeds.push(embed);
    currentTitle = `${title} (cont. ${embeds.length + 1})`;
    currentFields = [];
    currentChars = currentTitle.length;
  };

  for (const field of fields) {
    const normalizedField = {
      name: field.name.slice(0, 256),
      value: field.value.slice(0, EMBED_FIELD_VALUE_LIMIT),
    };
    const fieldChars = normalizedField.name.length + normalizedField.value.length;
    const overflowFieldCount = currentFields.length >= EMBED_FIELD_COUNT_LIMIT;
    const overflowChars = currentChars + fieldChars > EMBED_TOTAL_CHARS_LIMIT;

    if ((overflowFieldCount || overflowChars) && currentFields.length > 0) {
      flush();
    }

    if (currentFields.length >= EMBED_FIELD_COUNT_LIMIT) {
      flush();
    }

    currentFields.push(normalizedField);
    currentChars += fieldChars;
  }

  if (currentFields.length > 0 || embeds.length === 0) {
    flush();
  }
  return embeds;
}

function buildRosterEmbeds(input: {
  title: string;
  linkedRows: LinkedRosterRow[];
  unlinkedRows: UnlinkedRosterRow[];
}): EmbedBuilder[] {
  let linkedRows = [...input.linkedRows];
  let unlinkedRows = [...input.unlinkedRows];
  let linkedDropped = 0;
  let unlinkedDropped = 0;

  let keepPacking = true;
  while (keepPacking) {
    const linkedTableRows = buildLinkedTableRows(linkedRows, linkedDropped);
    const unlinkedTableRows = buildUnlinkedTableRows(unlinkedRows, unlinkedDropped);

    const linkedHeader = `${formatTableCell("TH", TH_WIDTH)} | ${formatTableCell("Player", PLAYER_WIDTH)} | ${formatTableCell("Discord", DISCORD_WIDTH)}`;
    const linkedSeparator = `${"-".repeat(TH_WIDTH)}-+-${"-".repeat(PLAYER_WIDTH)}-+-${"-".repeat(DISCORD_WIDTH)}`;
    const unlinkedHeader = `${formatTableCell("TH", TH_WIDTH)} | ${formatTableCell("Player", PLAYER_WIDTH)} | ${formatTableCell("Player Tag", TAG_WIDTH)}`;
    const unlinkedSeparator = `${"-".repeat(TH_WIDTH)}-+-${"-".repeat(PLAYER_WIDTH)}-+-${"-".repeat(TAG_WIDTH)}`;

    const linkedValues = splitSectionIntoFieldValues({
      header: linkedHeader,
      separator: linkedSeparator,
      rows: linkedTableRows,
    });
    const unlinkedValues = splitSectionIntoFieldValues({
      header: unlinkedHeader,
      separator: unlinkedSeparator,
      rows: unlinkedTableRows,
    });

    const fields = [
      ...buildSectionFieldEntries("Players linked", linkedValues),
      ...buildSectionFieldEntries("Unlinked Players", unlinkedValues),
    ];
    const embeds = packFieldsIntoEmbeds(input.title, fields);
    if (embeds.length <= EMBED_MESSAGE_LIMIT) {
      return embeds;
    }

    if (unlinkedRows.length >= linkedRows.length && unlinkedRows.length > 0) {
      unlinkedRows.pop();
      unlinkedDropped += 1;
      continue;
    }
    if (linkedRows.length > 0) {
      linkedRows.pop();
      linkedDropped += 1;
      continue;
    }
    keepPacking = false;
    return embeds.slice(0, EMBED_MESSAGE_LIMIT);
  }

  return [];
}

async function getTrackedClansForGuild(guildId: string): Promise<GuildTrackedClanOption[]> {
  const guildWarRows = await prisma.currentWar.findMany({
    where: { guildId },
    select: { clanTag: true },
  });
  const tags = [...new Set(guildWarRows.map((row) => normalizeClanTag(row.clanTag)).filter(Boolean))];
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
}): ActionRowBuilder<StringSelectMenuBuilder>[] {
  if (input.trackedClans.length === 0) return [];
  const selectedSet = selectTrackedClanMenuOptions(input.trackedClans, input.currentClanTag);

  const options = selectedSet.map((row) => {
    const label = `${row.name} ${row.tag}`.trim().slice(0, 100);
    const description = row.badge ? `badge: ${sanitizeTableText(row.badge)}`.slice(0, 100) : undefined;
    return {
      label,
      value: row.tag,
      default: row.tag === input.currentClanTag,
      ...(description ? { description } : {}),
    };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(buildLinkListSelectCustomId(input.commandUserId))
    .setPlaceholder("Select tracked clan")
    .addOptions(options);

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
}

async function buildLinkListView(input: {
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction;
  cocService: CoCService;
  clanTag: string;
  commandUserId: string;
}): Promise<LinkListRenderResult> {
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

  const members = normalizeClanMembers(Array.isArray(clan?.members) ? clan.members : []);
  if (members.length === 0) {
    return {
      ok: false,
      message: `empty_list: no current clan members for ${input.clanTag}.`,
    };
  }

  const links = await listPlayerLinksForClanMembers({
    memberTagsInOrder: members.map((row) => row.playerTag),
  });
  const linkByTag = new Map(links.map((row) => [row.playerTag, row]));

  const linkedRows: LinkedRosterRow[] = [];
  const unlinkedRows: UnlinkedRosterRow[] = [];
  for (const member of members) {
    const link = linkByTag.get(member.playerTag);
    if (link) {
      linkedRows.push({
        townHallText: member.townHallText,
        playerName: member.playerName,
        discordLabel: resolveDiscordLabel(input.interaction, link.discordUserId),
      });
      continue;
    }
    unlinkedRows.push({
      townHallText: member.townHallText,
      playerName: member.playerName,
      playerTag: member.playerTag,
    });
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

  const embeds = buildRosterEmbeds({
    title,
    linkedRows,
    unlinkedRows,
  });

  const trackedClans = await getTrackedClansForGuild(input.interaction.guildId);
  const components = buildClanSelectRows({
    trackedClans,
    currentClanTag: input.clanTag,
    commandUserId: input.commandUserId,
  });

  return {
    ok: true,
    payload: { embeds, components },
  };
}

export function buildLinkListSelectCustomId(userId: string): string {
  return `${LINK_LIST_SELECT_PREFIX}:${userId}`;
}

export function isLinkListSelectCustomId(customId: string): boolean {
  return customId.startsWith(`${LINK_LIST_SELECT_PREFIX}:`);
}

function parseLinkListSelectCustomId(customId: string): { userId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 2 || parts[0] !== LINK_LIST_SELECT_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  if (!userId) return null;
  return { userId };
}

export async function handleLinkListSelectMenu(
  interaction: StringSelectMenuInteraction,
  cocService: CoCService
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

  const result = await buildLinkListView({
    interaction,
    cocService,
    clanTag: selectedTag,
    commandUserId: parsed.userId,
  });

  if (!result.ok) {
    await interaction.update({
      content: result.message,
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update({
    content: null,
    ...result.payload,
  });
}

function canAdminBypass(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

async function canUseAdminCreateOverride(
  interaction: ChatInputCommandInteraction
): Promise<boolean> {
  if (canAdminBypass(interaction)) return true;
  return permissionService.canUseAnyTarget(["link:create:admin"], interaction);
}

async function canUseAdminDeleteOverride(
  interaction: ChatInputCommandInteraction
): Promise<boolean> {
  if (canAdminBypass(interaction)) return true;
  return permissionService.canUseAnyTarget(["link:delete:admin"], interaction);
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
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "user",
          description: "Discord user ID override (admin-only)",
          type: ApplicationCommandOptionType.String,
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
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    if (!interaction.guildId) {
      await interaction.reply({
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "create") {
      const rawTag = interaction.options.getString("player-tag", true);
      const normalizedTag = normalizePlayerTag(rawTag);
      if (!normalizedTag) {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }

      const requestedUserInput = interaction.options.getString("user", false)?.trim() ?? "";
      const requestedUserId = requestedUserInput
        ? normalizeDiscordUserId(requestedUserInput)
        : null;
      if (requestedUserInput && !requestedUserId) {
        await interaction.editReply("invalid_user: expected a Discord snowflake user ID.");
        return;
      }

      const targetDiscordUserId = requestedUserId ?? interaction.user.id;
      const isSelfCreate = targetDiscordUserId === interaction.user.id;
      if (!isSelfCreate) {
        const allowed = await canUseAdminCreateOverride(interaction);
        if (!allowed) {
          await interaction.editReply(
            "not_allowed: only admins can create links for another Discord user."
          );
          return;
        }
      }

      const result = await createPlayerLink({
        playerTag: normalizedTag,
        targetDiscordUserId,
        selfService: isSelfCreate,
      });

      if (result.outcome === "created") {
        const owner = isSelfCreate ? "you" : `<@${targetDiscordUserId}>`;
        await interaction.editReply(`created: ${result.playerTag} linked to ${owner}.`);
        return;
      }
      if (result.outcome === "already_linked_to_you") {
        await interaction.editReply(`already_linked_to_you: ${result.playerTag}.`);
        return;
      }
      if (result.outcome === "already_linked_to_target_user") {
        await interaction.editReply(
          `already_linked_to_target_user: ${result.playerTag} -> <@${targetDiscordUserId}>.`
        );
        return;
      }
      if (result.outcome === "already_linked_to_other_user") {
        await interaction.editReply(
          `already_linked_to_other_user: ${result.playerTag} is linked to <@${result.existingDiscordUserId}>. delete-first is required.`
        );
        return;
      }
      if (result.outcome === "invalid_tag") {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }
      await interaction.editReply("invalid_user: expected a Discord snowflake user ID.");
      return;
    }

    if (subcommand === "delete") {
      const rawTag = interaction.options.getString("player-tag", true);
      const normalizedTag = normalizePlayerTag(rawTag);
      if (!normalizedTag) {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
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
        await interaction.editReply(`not_found: no active link for ${result.playerTag}.`);
        return;
      }
      if (result.outcome === "not_owner") {
        await interaction.editReply(
          `not_owner: ${result.playerTag} is linked to another Discord user.`
        );
        return;
      }
      await interaction.editReply(
        "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
      );
      return;
    }

    const rawClanTag = interaction.options.getString("clan-tag", true);
    const normalizedClanTag = normalizeClanTag(rawClanTag);
    if (!normalizedClanTag) {
      await interaction.editReply(
        "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
      );
      return;
    }

    const result = await buildLinkListView({
      interaction,
      cocService,
      clanTag: normalizedClanTag,
      commandUserId: interaction.user.id,
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
        const title = row.name?.trim() ? `${row.name.trim()} (#${normalized})` : `#${normalized}`;
        return { name: title.slice(0, 100), value: normalized };
      })
      .filter(
        (choice) =>
          choice.value.toLowerCase().includes(query.toLowerCase()) ||
          choice.name.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, 25);
    await interaction.respond(choices);
  },
};
