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
import { playerCurrentService } from "../services/PlayerCurrentService";
import { listPlayerLinksForDiscordUser } from "../services/PlayerLinkService";

type AccountRow = {
  tag: string;
  name: string;
  clanTag: string | null;
  clanName: string | null;
  clanRole: "leader" | "coleader" | null;
  clanState: "known" | "no_clan" | "unknown";
};

type ClanGroup = {
  key: string;
  clanTag: string | null;
  clanName: string | null;
  clanState: "known" | "no_clan" | "unknown";
  entries: AccountRow[];
};

type AccountAutocompleteRow = {
  playerTag: string;
  playerName: string | null;
  discordUserId: string | null;
};

type AccountAutocompleteChoice = {
  name: string;
  value: string;
};

type PlayerCurrentSnapshot = Awaited<
  ReturnType<typeof playerCurrentService.listPlayerCurrentByTags>
> extends Map<string, infer T>
  ? T
  : never;

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

function normalizeClanMemberRole(input: unknown): "leader" | "coleader" | null {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (normalized === "leader") return "leader";
  if (normalized === "coleader") return "coleader";
  return null;
}

function normalizeAutocompleteQuery(input: string): string {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#+/, "");
}

function buildClanProfileMarkdownLink(
  clanName: string | null,
  clanTag: string | null,
): string {
  const normalizedClanTag = normalizeTag(clanTag ?? "");
  const label = sanitizeDisplayText(clanName) || normalizedClanTag || "Unknown Clan";
  if (!normalizedClanTag) return label;
  const encodedTag = normalizedClanTag.replace(/^#/, "");
  return `[${label}](https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodedTag})`;
}

function buildClanHeadingLabel(group: Pick<ClanGroup, "clanName" | "clanTag">): string {
  const fallbackTag = sanitizeDisplayText(group.clanTag) ?? "Unknown Clan";
  return sanitizeDisplayText(group.clanName) ?? fallbackTag;
}

function buildClanHeadingMarkdown(group: Pick<ClanGroup, "clanName" | "clanTag">): string {
  const label = buildClanHeadingLabel(group);
  const clanTag = normalizeTag(group.clanTag ?? "");
  return clanTag ? buildClanProfileMarkdownLink(label, clanTag) : label;
}

function resolveAccountClanState(input: {
  playerCurrent: PlayerCurrentSnapshot | null;
  playerActivity: { clanTag: string | null; clanName: string | null } | null;
}): "known" | "no_clan" | "unknown" {
  const currentClanTag = sanitizeDisplayText(input.playerCurrent?.currentClanTag);
  const activityClanTag = sanitizeDisplayText(input.playerActivity?.clanTag);
  if (currentClanTag || activityClanTag) return "known";
  if (input.playerCurrent || input.playerActivity) return "no_clan";
  return "unknown";
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

async function buildAccountsRows(input: {
  guildId: string;
  linkedNameByTag: Map<string, string>;
  tags: string[];
}): Promise<AccountRow[]> {
  const playerCurrentByTag = await playerCurrentService.listPlayerCurrentByTags(
    input.tags,
  );
  const activity = await prisma.playerActivity.findMany({
    where: { guildId: input.guildId, tag: { in: input.tags } },
    select: { tag: true, name: true, clanTag: true, clanName: true },
  });
  const activityByTag = new Map(activity.map((a) => [normalizeTag(a.tag), a]));
  const candidateClanTags = [...new Set([
    ...input.tags
      .map((tag) => {
        const current = playerCurrentByTag.get(tag) ?? null;
        return current?.currentClanTag ? normalizeTag(current.currentClanTag) : "";
      })
      .filter(Boolean),
    ...activity
      .map((row) => (row.clanTag ? normalizeTag(row.clanTag) : ""))
      .filter(Boolean),
  ])];
  const trackedClanRows =
    candidateClanTags.length > 0
      ? await prisma.trackedClan.findMany({
          where: { tag: { in: candidateClanTags } },
          select: { tag: true, name: true },
        })
      : [];
  const trackedClanNameByTag = new Map(
    trackedClanRows.map((row) => [
      normalizeTag(row.tag),
      sanitizeDisplayText(row.name),
    ] as const)
  );

  return input.tags.map((tag) => {
    const playerCurrent = playerCurrentByTag.get(tag) ?? null;
    const fallback = activityByTag.get(tag) ?? null;
    const linkedName = input.linkedNameByTag.get(tag) ?? null;
    const currentClanTag = playerCurrent?.currentClanTag
      ? normalizeTag(playerCurrent.currentClanTag)
      : null;
    const fallbackClanTag = fallback?.clanTag ? normalizeTag(fallback.clanTag) : null;
    const clanTag = currentClanTag ?? fallbackClanTag ?? null;
    const currentClanName = sanitizeDisplayText(playerCurrent?.currentClanName);
    const fallbackClanName = sanitizeDisplayText(fallback?.clanName);
    const clanName =
      currentClanName ??
      fallbackClanName ??
      (clanTag ? trackedClanNameByTag.get(clanTag) ?? null : null);
    const clanState = resolveAccountClanState({
      playerCurrent,
      playerActivity: fallback
        ? {
            clanTag: fallback.clanTag ?? null,
            clanName: fallback.clanName ?? null,
          }
        : null,
    });

    return {
      tag,
      name:
        sanitizeDisplayText(playerCurrent?.playerName) ??
        linkedName ??
        sanitizeDisplayText(fallback?.name) ??
        tag,
      clanTag: clanState === "known" ? clanTag : null,
      clanName: clanState === "known" ? clanName : null,
      clanRole: normalizeClanMemberRole(playerCurrent?.role),
      clanState,
    };
  });
}

async function refreshAccountsPlayerCurrentData(input: {
  cocService: unknown;
  tags: string[];
}): Promise<void> {
  const coc = input.cocService as { getPlayerRaw?: (tag: string) => Promise<any> } | null;
  const getPlayerRaw = coc?.getPlayerRaw ?? null;
  if (!getPlayerRaw) return;

  const existingByTag = await playerCurrentService.listPlayerCurrentByTags(input.tags);
  await Promise.all(
    input.tags.map(async (tag) => {
      const livePlayer = await getPlayerRaw(tag).catch(() => null);
      if (!livePlayer) return;
      await playerCurrentService
        .upsertPlayerCurrentFromLivePlayer({
          playerTag: tag,
          livePlayer,
          existing: existingByTag.get(tag) ?? null,
          source: "accounts-refresh",
        })
        .catch(() => undefined);
    }),
  );
}

function buildGroups(rows: AccountRow[]): ClanGroup[] {
  const grouped = new Map<string, ClanGroup>();

  for (const row of rows) {
    const clanName = sanitizeDisplayText(row.clanName);
    const clanTag = row.clanTag ? normalizeTag(row.clanTag) : null;
    const key =
      clanTag ?? (row.clanState === "unknown" ? "__UNKNOWN_CLAN__" : "__NO_CLAN__");

    const bucket = grouped.get(key);
    if (!bucket) {
      grouped.set(key, {
        key,
        clanTag,
        clanName,
        clanState: row.clanState,
        entries: [row],
      });
    } else {
      if (clanName && !bucket.clanName) bucket.clanName = clanName;
      if (bucket.clanState === "unknown" && row.clanState !== "unknown") {
        bucket.clanState = row.clanState;
      }
      bucket.entries.push(row);
    }
  }

  const groups: ClanGroup[] = [...grouped.entries()]
    .sort((a, b) => {
      const rank = (group: ClanGroup) => {
        if (group.clanState === "unknown") return 1;
        if (group.clanState === "no_clan") return 2;
        return 0;
      };
      const rankDelta = rank(a[1]) - rank(b[1]);
      if (rankDelta !== 0) return rankDelta;
      return buildClanHeadingLabel(a[1]).localeCompare(buildClanHeadingLabel(b[1]), undefined, {
        sensitivity: "base",
      });
    })
    .map(([, value]) => value);

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
    groupLines.push(
      `**${
        group.clanState === "known" && group.clanTag
          ? buildClanHeadingMarkdown(group)
          : group.clanState === "unknown"
            ? "Unknown Clan"
            : "No Clan"
      }**`,
    );
    for (const entry of group.entries) {
      const marker = entry.clanRole === "coleader" ? ":crown:" : "-";
      groupLines.push(`${marker} ${entry.name} \`${entry.tag}\``);
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

function buildAccountsControlsRow(
  prefix: string,
  page: number,
  totalPages: number,
  refreshing: boolean,
) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (totalPages > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}:prev`)
        .setLabel("Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`${prefix}:next`)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:refresh`)
      .setLabel(refreshing ? "Refreshing..." : "Refresh")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(refreshing),
  );
  return [row];
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
      description: "Discord user to inspect linked accounts",
      required: false,
      type: ApplicationCommandOptionType.User,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: unknown
  ) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
      return;
    }
    const visibility = interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    await interaction.deferReply({ ephemeral: !isPublic });

    const rawTag = interaction.options.getString("tag", false)?.trim() ?? "";
    const selectedDiscordUser = interaction.options.getUser("discord-id", false);
    if (rawTag && selectedDiscordUser) {
      await interaction.editReply("Use only one of `tag` or `discord-id`.");
      return;
    }

    let targetDiscordUserId = interaction.user.id;
    let sourceLabel = "your Discord account";
    if (selectedDiscordUser) {
      targetDiscordUserId = selectedDiscordUser.id;
      sourceLabel = `Discord user <@${selectedDiscordUser.id}>`;
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
    const rows = await buildAccountsRows({
      guildId,
      linkedNameByTag,
      tags: uniqueTags,
    });
    const embeds = buildEmbeds(rows);
    for (const embed of embeds) {
      embed.setTitle(`Accounts by Clan (${rows.length})`);
    }
    const prefix = `accounts:${interaction.id}`;
    let page = 0;
    let refreshing = false;

    const reply = await interaction.editReply({
      embeds: [embeds[page]],
      components: buildAccountsControlsRow(prefix, page, embeds.length, refreshing),
    });

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: (btn) =>
        btn.user.id === interaction.user.id &&
        (
          btn.customId === `${prefix}:prev` ||
          btn.customId === `${prefix}:next` ||
          btn.customId === `${prefix}:refresh`
        ),
    });

    collector.on("collect", async (btn) => {
      if (btn.customId === `${prefix}:refresh`) {
        if (refreshing) return;
        refreshing = true;
        try {
          await btn.update({
            embeds: [embeds[page]],
            components: buildAccountsControlsRow(prefix, page, embeds.length, true),
          });
          try {
            await refreshAccountsPlayerCurrentData({
              cocService,
              tags: uniqueTags,
            });
            const refreshedRows = await buildAccountsRows({
              guildId,
              linkedNameByTag,
              tags: uniqueTags,
            });
            const refreshedEmbeds = buildEmbeds(refreshedRows);
            for (const embed of refreshedEmbeds) {
              embed.setTitle(`Accounts by Clan (${refreshedRows.length})`);
            }
            rows.splice(0, rows.length, ...refreshedRows);
            embeds.splice(0, embeds.length, ...refreshedEmbeds);
            if (page >= embeds.length) page = Math.max(0, embeds.length - 1);
          } finally {
            await interaction.editReply({
              embeds: [embeds[page]],
              components: buildAccountsControlsRow(prefix, page, embeds.length, false),
            }).catch(() => undefined);
          }
        } finally {
          refreshing = false;
        }
        return;
      }

      if (btn.customId.endsWith(":prev")) page = Math.max(0, page - 1);
      if (btn.customId.endsWith(":next")) page = Math.min(embeds.length - 1, page + 1);
      await btn.update({
        embeds: [embeds[page]],
        components: buildAccountsControlsRow(prefix, page, embeds.length, false),
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
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "");
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
  },
};
