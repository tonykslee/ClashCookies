import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { ClanHealthSnapshotService, type ClanHealthSnapshot } from "../services/ClanHealthSnapshotService";

const clanHealthSnapshotService = new ClanHealthSnapshotService();

/** Purpose: normalize clan tags to uppercase with optional leading '#'. */
function normalizeClanTag(input: string): string {
  const bare = String(input ?? "").trim().toUpperCase().replace(/^#/, "");
  return bare ? `#${bare}` : "";
}

/** Purpose: render rates with percentage + numerator/denominator for leadership readability. */
function formatRate(numerator: number, denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) return "n/a (0/0)";
  const pct = (numerator / denominator) * 100;
  return `${pct.toFixed(1)}% (${numerator}/${denominator})`;
}

/** Purpose: build response embed for a clan-health snapshot. */
function buildClanHealthEmbed(snapshot: ClanHealthSnapshot): EmbedBuilder {
  const warSampleSuffix =
    snapshot.warMetrics.endedWarSampleSize < snapshot.warMetrics.windowSize
      ? ` (sample ${snapshot.warMetrics.endedWarSampleSize}/${snapshot.warMetrics.windowSize} ended wars)`
      : "";
  const inactiveWarSampleSuffix =
    snapshot.inactiveWars.warsAvailable < snapshot.inactiveWars.windowSize
      ? ` (sample ${snapshot.inactiveWars.warsSampled}/${snapshot.inactiveWars.windowSize} wars)`
      : "";

  return new EmbedBuilder()
    .setTitle(`Clan Health: ${snapshot.clanName}`)
    .setDescription("Leadership snapshot from persisted data only (no live API calls in command path).")
    .addFields(
      {
        name: "War Performance",
        value: [
          `Match rate (last ${snapshot.warMetrics.windowSize} ended wars): **${formatRate(
            snapshot.warMetrics.fwaMatchCount,
            snapshot.warMetrics.endedWarSampleSize
          )}**${warSampleSuffix}`,
          `Win rate (same window): **${formatRate(
            snapshot.warMetrics.winCount,
            snapshot.warMetrics.endedWarSampleSize
          )}**`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Inactivity",
        value: [
          `Inactive (wars, last ${snapshot.inactiveWars.windowSize} ended FWA wars): **${snapshot.inactiveWars.inactivePlayerCount}**${inactiveWarSampleSuffix}`,
          `Inactive (days, >=${snapshot.inactiveDays.thresholdDays}d): **${snapshot.inactiveDays.inactivePlayerCount}**`,
          `Observed members (updated in last ${snapshot.inactiveDays.staleHours}h): **${snapshot.inactiveDays.observedMemberCount}**`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Discord Links",
        value: `Missing links: **${snapshot.missingLinks.missingMemberCount}/${snapshot.missingLinks.observedMemberCount}** observed member(s)`,
        inline: false,
      }
    )
    .setFooter({ text: `${snapshot.clanTag} • Deterministic DB snapshot` });
}

export const ClanHealth: Command = {
  name: "clan-health",
  description: "Leadership snapshot: rates, inactivity, and missing Discord links",
  options: [
    {
      name: "tag",
      description: "Tracked clan tag (with or without #)",
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: true,
    },
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
    _cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const tagInput = interaction.options.getString("tag", true);
    const normalizedTag = normalizeClanTag(tagInput);
    if (!normalizedTag) {
      await interaction.editReply("Invalid clan tag.");
      return;
    }

    const snapshot = await clanHealthSnapshotService.getSnapshot({
      guildId: interaction.guildId,
      clanTag: normalizedTag,
    });

    if (!snapshot) {
      await interaction.editReply(`Clan ${normalizedTag} is not in tracked clans.`);
      return;
    }

    await interaction.editReply({
      embeds: [buildClanHealthEmbed(snapshot)],
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const query = normalizeClanTag(String(focused.value ?? "")).replace(/^#/, "").toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((clan) => {
        const normalized = normalizeClanTag(clan.tag);
        const bare = normalized.replace(/^#/, "");
        const label = clan.name?.trim() ? `${clan.name.trim()} (${normalized})` : normalized;
        return { name: label.slice(0, 100), value: bare };
      })
      .filter((choice) => {
        const name = choice.name.toLowerCase();
        const value = choice.value.toLowerCase();
        return name.includes(query) || value.includes(query);
      })
      .slice(0, 25);

    await interaction.respond(choices);
  },
};

export const buildClanHealthEmbedForTest = buildClanHealthEmbed;
