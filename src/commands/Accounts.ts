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
import { CoCService } from "../services/CoCService";
import { ClashKingService } from "../services/ClashKingService";
import { PlayerLinkSyncService } from "../services/PlayerLinkSyncService";

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

const MAX_ACCOUNTS_PER_PAGE = 18;

function normalizeTag(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
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
      description: "Player tag. Resolves linked Discord ID first.",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
    {
      name: "discord-id",
      description: "Discord user ID to inspect linked accounts",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
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
    let forceHydrateFromClashKingByDiscordId = false;
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

      let linkedDiscordId = local?.discordUserId ?? null;
      if (!linkedDiscordId) {
        const clashKing = new ClashKingService();
        linkedDiscordId = await clashKing.getLinkedDiscordUserId(tag);
        if (linkedDiscordId) forceHydrateFromClashKingByDiscordId = true;
      }

      if (!linkedDiscordId) {
        await interaction.editReply(`No Discord link found for player tag \`${tag}\`.`);
        return;
      }
      targetDiscordUserId = linkedDiscordId;
      sourceLabel = `player tag \`${tag}\` (linked Discord ID \`${linkedDiscordId}\`)`;
    }

    if (forceHydrateFromClashKingByDiscordId) {
      const syncService = new PlayerLinkSyncService();
      await syncService.syncByDiscordUserId(targetDiscordUserId);
    }

    let links = await prisma.playerLink.findMany({
      where: { discordUserId: targetDiscordUserId },
      orderBy: { createdAt: "asc" },
      select: { playerTag: true },
    });

    if (links.length === 0) {
      const syncService = new PlayerLinkSyncService();
      await syncService.syncByDiscordUserId(targetDiscordUserId);
      links = await prisma.playerLink.findMany({
        where: { discordUserId: targetDiscordUserId },
        orderBy: { createdAt: "asc" },
        select: { playerTag: true },
      });
    }

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
    const activity = await prisma.playerActivity.findMany({
      where: { tag: { in: uniqueTags } },
      select: { tag: true, name: true, clanTag: true },
    });
    const activityByTag = new Map(
      activity.map((a) => [normalizeTag(a.tag), a])
    );

    const fetched = await Promise.allSettled(
      uniqueTags.map((tag) => cocService.getPlayerRaw(tag))
    );

    const rows: AccountRow[] = uniqueTags.map((tag, idx) => {
      const result = fetched[idx];
      const fallback = activityByTag.get(tag);
      if (result.status === "fulfilled") {
        const player = result.value;
        return {
          tag,
          name: String(player?.name ?? fallback?.name ?? tag),
          clanTag: player?.clan?.tag ?? fallback?.clanTag ?? null,
          clanName: player?.clan?.name ?? null,
        };
      }

      return {
        tag,
        name: fallback?.name ?? tag,
        clanTag: fallback?.clanTag ?? null,
        clanName: null,
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
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const query = normalizeTag(String(focused.value ?? "")).replace(/^#/, "").toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((clan) => {
        const tag = normalizeTag(clan.tag).replace(/^#/, "");
        const name = clan.name?.trim() ? `${clan.name.trim()} (#${tag})` : `#${tag}`;
        return { name: name.slice(0, 100), value: tag };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
