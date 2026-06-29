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
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  normalizeClashTagBareInput,
  normalizeClashTagInput,
  normalizeClashTagWithHash,
} from "../helper/clashTag";
import { listPlayerLinksForDiscordUser } from "../services/PlayerLinkService";
import { playerCurrentService } from "../services/PlayerCurrentService";
import { runWithCoCQueueContext } from "../services/CoCQueueContext";
import {
  buildAccountDisplayRowText,
  buildAccountDisplayRows,
  resolveTownHallEmojiMap,
  type AccountDisplayEmojiMap,
  type AccountDisplayRow,
} from "../services/AccountDisplayService";
import { toFailureTelemetry } from "../services/telemetry/ingest";

type ClanGroup = {
  key: string;
  clanTag: string | null;
  clanName: string | null;
  clanState: "known" | "no_clan" | "unknown";
  isTrackedFwaClan: boolean;
  trackedClanSortOrder: number | null;
  entries: AccountDisplayRow[];
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

const ACCOUNTS_DESCRIPTION_LIMIT = 4096;
const ACCOUNTS_DESCRIPTION_RESERVE = 100;
const ACCOUNTS_USABLE_DESCRIPTION_LIMIT = ACCOUNTS_DESCRIPTION_LIMIT - ACCOUNTS_DESCRIPTION_RESERVE;
const ACCOUNTS_TRUNCATION_LINE = "\u2026and more accounts not shown.";
const ACCOUNTS_REFRESH_QUEUE_SOURCE = "accounts:list:refresh";

function normalizeTag(input: string): string {
  return normalizeClashTagInput(input);
}

function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAutocompleteQuery(input: string): string {
  return normalizeClashTagBareInput(input).toLowerCase();
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

function buildAccountGroupBlockLines(
  group: ClanGroup,
  townHallEmojiByLevel: AccountDisplayEmojiMap,
): string[] {
  const lines: string[] = [
    `**${
      group.clanState === "known" && group.clanTag
        ? buildClanHeadingMarkdown(group)
        : group.clanState === "unknown"
          ? "Unknown Clan"
          : "No Clan"
    }**`,
  ];

  for (const entry of group.entries) {
    lines.push(buildAccountDisplayRowText(entry, townHallEmojiByLevel));
  }

  return lines;
}

function renderAccountPageText(lines: string[], linkedDiscordLine: string | null): string {
  const body = lines.join("\n").trim();
  if (!body) return linkedDiscordLine ? linkedDiscordLine : "";
  return linkedDiscordLine ? `${linkedDiscordLine}\n\n${body}` : body;
}

function appendBlockIfFits(
  currentLines: string[],
  blockLines: string[],
  linkedDiscordLine: string | null,
): string[] | null {
  const nextLines = currentLines.length > 0 ? [...currentLines, "", ...blockLines] : [...blockLines];
  return renderAccountPageText(nextLines, linkedDiscordLine).length <= ACCOUNTS_USABLE_DESCRIPTION_LIMIT
    ? nextLines
    : null;
}

function truncateGroupBlockToFit(
  blockLines: string[],
  linkedDiscordLine: string | null,
): string[] {
  const truncated: string[] = [];
  for (const line of blockLines) {
    const nextLines = [...truncated, line];
    if (renderAccountPageText(nextLines, linkedDiscordLine).length > ACCOUNTS_USABLE_DESCRIPTION_LIMIT) {
      break;
    }
    truncated.push(line);
  }

  if (truncated.length < blockLines.length) {
    while (
      truncated.length > 0 &&
      renderAccountPageText([...truncated, ACCOUNTS_TRUNCATION_LINE], linkedDiscordLine).length >
        ACCOUNTS_USABLE_DESCRIPTION_LIMIT
    ) {
      truncated.pop();
    }
    if (
      renderAccountPageText([...truncated, ACCOUNTS_TRUNCATION_LINE], linkedDiscordLine).length <=
      ACCOUNTS_USABLE_DESCRIPTION_LIMIT
    ) {
      truncated.push(ACCOUNTS_TRUNCATION_LINE);
    }
  }

  return truncated;
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

function buildGroups(rows: AccountDisplayRow[]): ClanGroup[] {
  const grouped = new Map<string, ClanGroup>();

  for (const row of rows) {
    const clanName = sanitizeDisplayText(row.clanName);
    const clanTag = row.clanTag ? normalizeTag(row.clanTag) : null;
    const key = clanTag ?? (row.clanState === "unknown" ? "__UNKNOWN_CLAN__" : "__NO_CLAN__");

    const bucket = grouped.get(key);
    if (!bucket) {
      grouped.set(key, {
        key,
        clanTag,
        clanName,
        clanState: row.clanState,
        isTrackedFwaClan: row.isTrackedFwaClan,
        trackedClanSortOrder: row.trackedClanSortOrder,
        entries: [row],
      });
    } else {
      if (clanName && !bucket.clanName) bucket.clanName = clanName;
      if (bucket.clanState === "unknown" && row.clanState !== "unknown") {
        bucket.clanState = row.clanState;
      }
      if (!bucket.isTrackedFwaClan && row.isTrackedFwaClan) {
        bucket.isTrackedFwaClan = true;
      }
      if (
        bucket.trackedClanSortOrder === null &&
        row.trackedClanSortOrder !== null &&
        row.trackedClanSortOrder !== undefined
      ) {
        bucket.trackedClanSortOrder = row.trackedClanSortOrder;
      }
      bucket.entries.push(row);
    }
  }

  const groups: ClanGroup[] = [...grouped.entries()]
    .sort((a, b) => {
      const rank = (group: ClanGroup) => {
        if (group.clanState !== "known") {
          return group.clanState === "unknown" ? 2 : 3;
        }
        return group.isTrackedFwaClan ? 0 : 1;
      };
      const rankDelta = rank(a[1]) - rank(b[1]);
      if (rankDelta !== 0) return rankDelta;
      if (a[1].clanState === "known" && b[1].clanState === "known") {
        if (a[1].isTrackedFwaClan !== b[1].isTrackedFwaClan) {
          return a[1].isTrackedFwaClan ? -1 : 1;
        }
        if (a[1].isTrackedFwaClan) {
          const leftSort = a[1].trackedClanSortOrder ?? Number.MAX_SAFE_INTEGER;
          const rightSort = b[1].trackedClanSortOrder ?? Number.MAX_SAFE_INTEGER;
          if (leftSort !== rightSort) return leftSort - rightSort;
        }
      }
      const byLabel = buildClanHeadingLabel(a[1]).localeCompare(buildClanHeadingLabel(b[1]), undefined, {
        sensitivity: "base",
      });
      if (byLabel !== 0) return byLabel;
      return (a[1].clanTag ?? "").localeCompare(b[1].clanTag ?? "", undefined, {
        sensitivity: "base",
      });
    })
    .map(([, value]) => value);

  for (const group of groups) {
    group.entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  return groups;
}

function buildPages(input: {
  groups: ClanGroup[];
  townHallEmojiByLevel: AccountDisplayEmojiMap;
  linkedDiscordLine: string | null;
}): string[] {
  const { groups, townHallEmojiByLevel, linkedDiscordLine } = input;
  const pages: string[] = [];
  let lines: string[] = [];

  for (const group of groups) {
    const groupLines = buildAccountGroupBlockLines(group, townHallEmojiByLevel);
    const appended = appendBlockIfFits(lines, groupLines, linkedDiscordLine);
    if (appended !== null) {
      lines = appended;
      continue;
    }

    if (lines.length > 0) {
      pages.push(renderAccountPageText(lines, linkedDiscordLine));
      lines = [];
    }

    if (renderAccountPageText(groupLines, linkedDiscordLine).length <= ACCOUNTS_USABLE_DESCRIPTION_LIMIT) {
      lines = groupLines;
      continue;
    }

    const truncatedLines = truncateGroupBlockToFit(groupLines, linkedDiscordLine);
    if (truncatedLines.length > 0) {
      lines = truncatedLines;
    }
  }

  if (lines.length > 0) {
    pages.push(renderAccountPageText(lines, linkedDiscordLine));
  }

  if (pages.length > 0) return pages;
  return linkedDiscordLine
    ? [renderAccountPageText(["No accounts found."], linkedDiscordLine)]
    : ["No accounts found."];
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

function buildEmbeds(
  rows: AccountDisplayRow[],
  townHallEmojiByLevel: AccountDisplayEmojiMap,
  linkedDiscordUserId?: string | null,
): EmbedBuilder[] {
  const groups = buildGroups(rows);
  const linkedDiscordLine = linkedDiscordUserId
    ? `Linked Discord: <@${linkedDiscordUserId}>`
    : null;
  const pages = buildPages({ groups, townHallEmojiByLevel, linkedDiscordLine });
  return pages.map((description, index) =>
    new EmbedBuilder()
      .setTitle(`My Accounts by Clan (${rows.length})`)
      .setDescription(description)
      .setFooter({ text: `Page ${index + 1}/${pages.length}` }),
  );
}

async function refreshAccountsPlayerCurrentData(input: {
  cocService: unknown;
  tags: string[];
  guildId: string;
  userId: string;
}): Promise<void> {
  const coc = input.cocService as { getPlayerRaw?: (tag: string) => Promise<any> } | null;
  const getPlayerRaw = coc?.getPlayerRaw?.bind(coc) ?? null;
  if (!getPlayerRaw) return;

  const existingByTag = await playerCurrentService.listPlayerCurrentByTags(input.tags);
  await Promise.all(
    input.tags.map(async (tag) => {
      let livePlayer: any = null;
      try {
        livePlayer = await getPlayerRaw(tag);
      } catch (err) {
        const failure = toFailureTelemetry(err);
        console.error(
          `[accounts] command=/accounts source=${ACCOUNTS_REFRESH_QUEUE_SOURCE} stage=fetch guild=${input.guildId} user=${input.userId} tag=${tag} errorCategory=${failure.errorCategory} errorCode=${failure.errorCode} error=${formatError(err)}`,
        );
        return;
      }

      if (!livePlayer) return;

      try {
        await playerCurrentService.upsertPlayerCurrentFromLivePlayer({
          playerTag: tag,
          livePlayer,
          existing: existingByTag.get(tag) ?? null,
          source: "accounts-refresh",
        });
      } catch (err) {
        const failure = toFailureTelemetry(err);
        console.error(
          `[accounts] command=/accounts source=${ACCOUNTS_REFRESH_QUEUE_SOURCE} stage=upsert guild=${input.guildId} user=${input.userId} tag=${tag} errorCategory=${failure.errorCategory} errorCode=${failure.errorCode} error=${formatError(err)}`,
        );
      }
    }),
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
    client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: unknown,
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
    let linkedDiscordHeaderId: string | null = null;
    let sourceLabel = "your Discord account";
    if (selectedDiscordUser) {
      targetDiscordUserId = selectedDiscordUser.id;
      linkedDiscordHeaderId = selectedDiscordUser.id;
      sourceLabel = `Discord user <@${selectedDiscordUser.id}>`;
    } else if (rawTag) {
      const tag = normalizeClashTagWithHash(rawTag);
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
      linkedDiscordHeaderId = linkedDiscordId;
      sourceLabel = `player tag \`${tag}\` (linked Discord ID \`${linkedDiscordId}\`)`;
    }

    const links = await listPlayerLinksForDiscordUser({
      discordUserId: targetDiscordUserId,
    });

    if (links.length === 0) {
      await interaction.editReply(
        `No linked player tags were found for ${sourceLabel}.`,
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
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const townHallEmojiByLevel = await resolveTownHallEmojiMap(client);
    const rows = await buildAccountDisplayRows({
      guildId,
      linkedNameByTag,
      tags: uniqueTags,
    });
    const embeds = buildEmbeds(rows, townHallEmojiByLevel, linkedDiscordHeaderId);
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
            await runWithCoCQueueContext(
              {
                priority: "interactive",
                source: ACCOUNTS_REFRESH_QUEUE_SOURCE,
              },
              () =>
                refreshAccountsPlayerCurrentData({
                  cocService,
                  tags: uniqueTags,
                  guildId,
                  userId: interaction.user.id,
                }),
            );
            const refreshedRows = await buildAccountDisplayRows({
              guildId,
              linkedNameByTag,
              tags: uniqueTags,
            });
            const refreshedEmbeds = buildEmbeds(
              refreshedRows,
              townHallEmojiByLevel,
              linkedDiscordHeaderId,
            );
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

export { resolveTownHallEmojiMap };
