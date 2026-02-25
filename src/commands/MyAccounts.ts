import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { truncateDiscordContent } from "../helper/discordContent";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { PlayerLinkSyncService } from "../services/PlayerLinkSyncService";

type AccountRow = {
  tag: string;
  name: string;
  clanTag: string | null;
  clanName: string | null;
};

function normalizeTag(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function buildMessage(rows: AccountRow[]): string {
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

  const groups = [...grouped.entries()]
    .sort((a, b) => {
      if (a[0] === "__NO_CLAN__") return 1;
      if (b[0] === "__NO_CLAN__") return -1;
      return a[1].title.localeCompare(b[1].title);
    })
    .map(([, value]) => value);

  for (const group of groups) {
    group.entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  const lines: string[] = [];
  lines.push(`Your linked accounts by clan (${rows.length})`);
  lines.push("");

  for (const group of groups) {
    lines.push(`**${group.title}**`);
    for (const entry of group.entries) {
      lines.push(`- ${entry.name} (${entry.tag})`);
    }
    lines.push("");
  }

  const raw = lines.join("\n").trim();
  if (raw.length <= 2000) return raw;

  const compact: string[] = [];
  compact.push(`Your linked accounts by clan (${rows.length})`);
  compact.push("");
  let included = 0;

  for (const group of groups) {
    const header = `**${group.title}**`;
    const candidateHeader = [...compact, header].join("\n");
    if (candidateHeader.length > 1900) break;
    compact.push(header);

    for (const entry of group.entries) {
      const line = `- ${entry.name} (${entry.tag})`;
      const candidateLine = [...compact, line].join("\n");
      if (candidateLine.length > 1900) {
        break;
      }
      compact.push(line);
      included += 1;
    }
    compact.push("");
  }

  const omitted = rows.length - included;
  if (omitted > 0) {
    compact.push(`...and ${omitted} more account(s).`);
  }
  return truncateDiscordContent(compact.join("\n").trim());
}

export const MyAccounts: Command = {
  name: "my-accounts",
  description: "List your linked accounts grouped by current clan",
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
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    let links = await prisma.playerLink.findMany({
      where: { discordUserId: interaction.user.id },
      orderBy: { createdAt: "asc" },
      select: { playerTag: true },
    });

    if (links.length === 0) {
      const syncService = new PlayerLinkSyncService();
      await syncService.syncByDiscordUserId(interaction.user.id);
      links = await prisma.playerLink.findMany({
        where: { discordUserId: interaction.user.id },
        orderBy: { createdAt: "asc" },
        select: { playerTag: true },
      });
    }

    if (links.length === 0) {
      await interaction.editReply(
        "No linked player tags were found for your Discord account."
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

    await interaction.editReply(buildMessage(rows));
  },
};
