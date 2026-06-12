import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import {
  buildRepWorkReportEmbed,
  parseRepWorkDuration,
  repWorkReportService,
} from "../services/RepWorkReportService";
import {
  resolveRepWorkRenderedClanBadgesByUserId,
} from "../services/RepWorkBadgeService";

const INVALID_DURATION_MESSAGE = "Use a duration like 7d, 4w, or 2mo.";

export const RepWork: Command = {
  name: "repwork",
  description: "Report FWA leader rep-work activity from persisted attribution data",
  options: [
    {
      name: "since",
      description: "Report window duration (for example: 7d, 4w, 2mo)",
      type: ApplicationCommandOptionType.String,
      required: true,
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
    client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const since = interaction.options.getString("since", true);
    if (!parseRepWorkDuration(since)) {
      await interaction.reply({
        content: INVALID_DURATION_MESSAGE,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();
    const report = await repWorkReportService.buildReport({
      guildId: interaction.guildId,
      since,
    });

    if (!report) {
      await interaction.editReply({
        content: INVALID_DURATION_MESSAGE,
      });
      return;
    }

    const renderedBadgesByUserId = await resolveRepWorkRenderedClanBadgesByUserId({
      client,
      userIds: report.users.map((row) => row.discordUserId),
    }).catch(() => new Map<string, string[]>());

    await interaction.editReply({
      embeds: [buildRepWorkReportEmbed(report, { renderedBadgesByUserId })],
      allowedMentions: { parse: [] },
    });
  },
};
