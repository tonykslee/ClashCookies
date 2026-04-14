import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { listPlayerLinksForDiscordUser } from "../services/PlayerLinkService";

type AccountRow = {
  tag: string;
  name: string;
  clanTag: string | null;
  clanName: string | null;
};

type ClanGroup = {
  key: string;
  title: string;
  entries: AccountRow[];
};

type AccountAutocompleteRow = {
  playerTag: string;
  playerName: string | null;
  discordUserId: string | null;
};

type DiscordIdAutocompleteRow = {
  discordUserId: string;
  discordUsername: string | null;
};

type AccountAutocompleteChoice = {
  name: string;
  value: string;
};

const MAX_ACCOUNTS_PER_PAGE = 18;

function normalizeTag(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAutocompleteQuery(input: string): string {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#+/, "");
}

function normalizeDiscordIdAutocompleteQuery(input: string): string {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

export function resolveDiscordIdAutocompleteLabel(
  discordUserId: string,
  persistedUsername: string | null,
): string {
  const rawDiscordId = sanitizeDisplayText(discordUserId);
  if (rawDiscordId) return rawDiscordId;

  const resolvedUsername = sanitizeDisplayText(persistedUsername);
  return resolvedUsername ? `@${resolvedUsername}` : "";
}

function buildAccountsTagAutocompleteChoices(
  rows: AccountAutocompleteRow[],
  query: string,
): AccountAutocompleteChoice[] {
  const normalizedQuery = normalizeAutocompleteQuery(query);
  const deduped = new Map<
    string,
    { tag: string; linkedName: string | null; hasDiscordUserId: boolean }
  >();

  for (const row of rows) {
    const tag = normalizeTag(row.playerTag);
    if (!tag) continue;
    const linkedName = sanitizeDisplayText(row.playerName);
    const hasDiscordUserId = Boolean(String(row.discordUserId ?? "").trim());
    const existing = deduped.get(tag);
    if (!existing) {
      deduped.set(tag, { tag, linkedName, hasDiscordUserId });
      continue;
    }

    if (hasDiscordUserId && !existing.hasDiscordUserId) {
      deduped.set(tag, { tag, linkedName, hasDiscordUserId });
      continue;
    }
    if (hasDiscordUserId === existing.hasDiscordUserId && linkedName && !existing.linkedName) {
      deduped.set(tag, { tag, linkedName, hasDiscordUserId });
    }
  }

  const ranked = [...deduped.values()]
    .map((row) => {
      const tagNoHash = row.tag.replace(/^#/, "").toLowerCase();
      const linkedNameLower = row.linkedName?.toLowerCase() ?? "";
      const exactTagMatch = normalizedQuery.length > 0 && tagNoHash === normalizedQuery;
      const prefixTagMatch =
        normalizedQuery.length > 0 &&
        tagNoHash.startsWith(normalizedQuery) &&
        !exactTagMatch;
      const nameMatch =
        normalizedQuery.length > 0 &&
        row.linkedName !== null &&
        linkedNameLower.includes(normalizedQuery);
      const matchRank =
        normalizedQuery.length === 0
          ? 3
          : exactTagMatch
            ? 0
            : prefixTagMatch
              ? 1
              : nameMatch
                ? 2
                : 99;
      return {
        ...row,
        matchRank,
        sortName: row.linkedName?.toLowerCase() ?? "\uffff",
        sortTag: tagNoHash,
      };
    })
    .filter((row) => row.matchRank !== 99)
    .sort((a, b) => {
      if (a.matchRank !== b.matchRank) return a.matchRank - b.matchRank;
      const byName = a.sortName.localeCompare(b.sortName, undefined, {
        sensitivity: "base",
      });
      if (byName !== 0) return byName;
      return a.sortTag.localeCompare(b.sortTag, undefined, { sensitivity: "base" });
    })
    .slice(0, 25);

  return ranked.map((row) => ({
    name: (row.linkedName ? `${row.linkedName} (${row.tag})` : row.tag).slice(0, 100),
    value: row.tag,
  }));
}

function buildAccountsDiscordIdAutocompleteChoices(
  rows: DiscordIdAutocompleteRow[],
  query: string,
): AccountAutocompleteChoice[] {
  const normalizedQuery = normalizeDiscordIdAutocompleteQuery(query);
  const deduped = new Map<
    string,
    { discordUserId: string; discordUsername: string | null }
  >();

  for (const row of rows) {
    const discordUserId = String(row.discordUserId ?? "").trim();
    if (!discordUserId) continue;
    const discordUsername = sanitizeDisplayText(row.discordUsername);
    const existing = deduped.get(discordUserId);
    if (!existing) {
      deduped.set(discordUserId, { discordUserId, discordUsername });
      continue;
    }

    if (discordUsername && !existing.discordUsername) {
      deduped.set(discordUserId, { discordUserId, discordUsername });
    }
  }

  const ranked = [...deduped.values()]
    .map((row) => {
      const usernameLower = row.discordUsername?.toLowerCase() ?? "";
      const exactIdMatch = normalizedQuery.length > 0 && row.discordUserId === normalizedQuery;
      const prefixIdMatch =
        normalizedQuery.length > 0 &&
        row.discordUserId.startsWith(normalizedQuery) &&
        !exactIdMatch;
      const usernameMatch =
        normalizedQuery.length > 0 &&
        row.discordUsername !== null &&
        usernameLower.includes(normalizedQuery);
      const matchRank =
        normalizedQuery.length === 0
          ? 3
          : exactIdMatch
            ? 0
            : prefixIdMatch
              ? 1
              : usernameMatch
                ? 2
                : 99;

      return {
        ...row,
        matchRank,
        sortName: row.discordUsername?.toLowerCase() ?? "\uffff",
      };
    })
    .filter((row) => row.matchRank !== 99)
    .sort((a, b) => {
      if (a.matchRank !== b.matchRank) return a.matchRank - b.matchRank;
      const byName = a.sortName.localeCompare(b.sortName, undefined, {
        sensitivity: "base",
      });
      if (byName !== 0) return byName;
      return a.discordUserId.localeCompare(b.discordUserId, undefined, {
        sensitivity: "base",
      });
    })
    .slice(0, 25);

  return ranked.map((row) => ({
    name: resolveDiscordIdAutocompleteLabel(row.discordUserId, row.discordUsername).slice(0, 100),
    value: row.discordUserId,
  }));
}

function buildGroups(rows: AccountRow[]): ClanGroup[] {
  const grouped = new Map<string, { title: string; entries: AccountRow[] }>();

  for (const row of rows) {
    const clanName = row.clanName?.trim() || null;
    const clanTag = row.clanTag ? normalizeTag(row.clanTag) : null;
    const key = clanTag ?? "__NO_CLAN__";
    const title = clanTag ? `${clanName ?? "Unknown Clan"} (${clanTag})` : "No Clan";

    const bucket = grouped.get(key);
    if (!bucket) {
      grouped.set(key, { title, entries: [row] });
    } else {
      bucket.entries.push(row);
    }
  }

  const groups: ClanGroup[] = [...grouped.entries()]
    .sort((a, b) => {
      if (a[0] === "__NO_CLAN__") return 1;
      if (b[0] === "__NO_CLAN__") return -1;
      return a[1].title.localeCompare(b[1].title);
    })
    .map(([key, value]) => ({ key, ...value }));

  for (const group of groups) {
    group.entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  return groups;
}

function buildPages(groups: ClanGroup[]): string[] {
  const pages: string[] = [];
  let lines: string[] = [];
  let accountCount = 0;

  for (const group of groups) {
    const groupLines: string[] = [];
    groupLines.push(`**${group.title}**`);
    for (const entry of group.entries) {
      groupLines.push(`- ${entry.name} \`${entry.tag}\``);
    }

    const groupAccountCount = group.entries.length;
    const wouldOverflow = accountCount + groupAccountCount > MAX_ACCOUNTS_PER_PAGE;
    if (wouldOverflow && lines.length > 0) {
      pages.push(lines.join("\n"));
      lines = [];
      accountCount = 0;
    }

    lines.push(...groupLines, "");
    accountCount += groupAccountCount;

    if (accountCount >= MAX_ACCOUNTS_PER_PAGE) {
      pages.push(lines.join("\n").trim());
      lines = [];
      accountCount = 0;
    }
  }

  if (lines.length > 0) {
    pages.push(lines.join("\n").trim());
  }

  return pages.length > 0 ? pages : ["No accounts found."];
}

function buildPaginationRow(prefix: string, page: number, totalPages: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );
}

function buildEmbeds(rows: AccountRow[]): EmbedBuilder[] {
  const groups = buildGroups(rows);
  const pages = buildPages(groups);
  return pages.map((description, index) =>
    new EmbedBuilder()
      .setTitle(`My Accounts by Clan (${rows.length})`)
      .setDescription(description)
      .setFooter({ text: `Page ${index + 1}/${pages.length}` })
  );
}

export const Accounts: Command = {
  name: "accounts",
  description: "List linked accounts grouped by current clan",
  options: [
    {
      name: "visibility",
      description: "Response visibility",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "private", value: "private" },
        { name: "public", value: "public" },
      ],
    },
    {
      name: "tag",
      description: "Player tag. Resolves linked Discord ID from local PlayerLink.",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
    {
      name: "discord-id",
      description: "Discord user ID to inspect linked accounts",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: unknown
  ) => {
    if (!interaction.guildId) {
      await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
      return;
    }
    const visibility = interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    await interaction.deferReply({ ephemeral: !isPublic });

    const rawTag = interaction.options.getString("tag", false)?.trim() ?? "";
    const rawDiscordId = interaction.options.getString("discord-id", false)?.trim() ?? "";
    if (rawTag && rawDiscordId) {
      await interaction.editReply("Use only one of `tag` or `discord-id`.");
      return;
    }

    const normalizeDiscordUserId = (input: string): string | null =>
      /^\d{15,22}$/.test(input) ? input : null;

    let targetDiscordUserId = interaction.user.id;
    let sourceLabel = "your Discord account";
    if (rawDiscordId) {
      const normalized = normalizeDiscordUserId(rawDiscordId);
      if (!normalized) {
        await interaction.editReply("Invalid `discord-id`. Expected a Discord snowflake.");
        return;
      }
      targetDiscordUserId = normalized;
      sourceLabel = `Discord user \`${normalized}\``;
    } else if (rawTag) {
      const tag = normalizeTag(rawTag);
      if (!tag) {
        await interaction.editReply("Invalid `tag`.");
        return;
      }

      const local = await prisma.playerLink.findUnique({
        where: { playerTag: tag },
        select: { discordUserId: true },
      });

      const linkedDiscordId = local?.discordUserId ?? null;

      if (!linkedDiscordId) {
        await interaction.editReply(`No Discord link found for player tag \`${tag}\`.`);
        return;
      }
      targetDiscordUserId = linkedDiscordId;
      sourceLabel = `player tag \`${tag}\` (linked Discord ID \`${linkedDiscordId}\`)`;
    }

    const links = await listPlayerLinksForDiscordUser({
      discordUserId: targetDiscordUserId,
    });

    if (links.length === 0) {
      await interaction.editReply(
        `No linked player tags were found for ${sourceLabel}.`
      );
      return;
    }

    const tags = links
      .map((l) => normalizeTag(l.playerTag))
      .filter((t) => Boolean(t));
    const uniqueTags = [...new Set(tags)];
    const linkedNameByTag = new Map(
      links
        .map((link) => [normalizeTag(link.playerTag), sanitizeDisplayText(link.linkedName)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
    );
    const activity = await prisma.playerActivity.findMany({
      where: { guildId: interaction.guildId, tag: { in: uniqueTags } },
      select: { tag: true, name: true, clanTag: true, clanName: true },
    });
    const activityByTag = new Map(
      activity.map((a) => [normalizeTag(a.tag), a])
    );
    const candidateClanTags = [...new Set(
      activity
        .map((row) => (row.clanTag ? normalizeTag(row.clanTag) : ""))
        .filter(Boolean)
    )];
    const trackedClanRows =
      candidateClanTags.length > 0
        ? await prisma.trackedClan.findMany({
            where: { tag: { in: candidateClanTags } },
            select: { tag: true, name: true },
          })
        : [];
    const trackedClanNameByTag = new Map(
      trackedClanRows
        .map((row) => [normalizeTag(row.tag), sanitizeDisplayText(row.name)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
    );
    const rows: AccountRow[] = uniqueTags.map((tag) => {
      const linkedName = linkedNameByTag.get(tag) ?? null;
      const fallback = activityByTag.get(tag);
      const fallbackClanTag = fallback?.clanTag ? normalizeTag(fallback.clanTag) : null;
      const clanTag = fallbackClanTag ?? "";
      const activityName = sanitizeDisplayText(fallback?.name);
      const clanName =
        sanitizeDisplayText(fallback?.clanName) ??
        (clanTag ? trackedClanNameByTag.get(clanTag) ?? null : null);

      return {
        tag,
        name: linkedName ?? activityName ?? tag,
        clanTag: clanTag || null,
        clanName,
      };
    });

    const embeds = buildEmbeds(rows);
    for (const embed of embeds) {
      embed.setTitle(`Accounts by Clan (${rows.length})`);
    }
    const prefix = `accounts:${interaction.id}`;
    let page = 0;

    const reply = await interaction.editReply({
      embeds: [embeds[page]],
      components:
        embeds.length > 1 ? [buildPaginationRow(prefix, page, embeds.length)] : [],
    });

    if (embeds.length <= 1) return;

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: (btn) =>
        btn.user.id === interaction.user.id &&
        (btn.customId === `${prefix}:prev` || btn.customId === `${prefix}:next`),
    });

    collector.on("collect", async (btn) => {
      if (btn.customId.endsWith(":prev")) page = Math.max(0, page - 1);
      if (btn.customId.endsWith(":next")) page = Math.min(embeds.length - 1, page + 1);
      await btn.update({
        embeds: [embeds[page]],
        components: [buildPaginationRow(prefix, page, embeds.length)],
      });
    });

    collector.on("end", async () => {
      await interaction
        .editReply({ embeds: [embeds[page]], components: [] })
        .catch(() => undefined);
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag" && focused.name !== "discord-id") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "");
    if (focused.name === "tag") {
      const rows = await prisma.playerLink.findMany({
        select: {
          discordUserId: true,
          playerName: true,
          playerTag: true,
        },
      });

      const choices = buildAccountsTagAutocompleteChoices(
        rows as AccountAutocompleteRow[],
        query,
      );

      await interaction.respond(choices);
      return;
    }

    const rows = await prisma.playerLink.findMany({
      select: {
        discordUserId: true,
        discordUsername: true,
      },
    });

    const choices = buildAccountsDiscordIdAutocompleteChoices(
      rows as DiscordIdAutocompleteRow[],
      query,
    );

    await interaction.respond(choices);
  },
};
