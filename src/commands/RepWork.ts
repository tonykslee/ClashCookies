import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";
import {
  buildRepWorkReportEmbeds,
  parseRepWorkDuration,
  repWorkReportService,
} from "../services/RepWorkReportService";
import {
  resolveRepWorkRenderedClanBadgesByUserId,
} from "../services/RepWorkBadgeService";

const INVALID_DURATION_MESSAGE = "Use a duration like 7d, 4w, or 2mo.";
const REPWORK_PAGINATION_TIMEOUT_MS = 10 * 60 * 1000;

function buildRepWorkPaginationRow(
  customIdPrefix: string,
  page: number,
  pageCount: number,
) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:prev`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
  );
}

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

    const embeds = buildRepWorkReportEmbeds(report, { renderedBadgesByUserId });
    let page = 0;
    const customIdPrefix = `repwork:${interaction.id}`;

    await interaction.editReply({
      embeds: [embeds[page]],
      components:
        embeds.length > 1
          ? [buildRepWorkPaginationRow(customIdPrefix, page, embeds.length)]
          : [],
      allowedMentions: { parse: [] },
    });

    if (embeds.length <= 1) {
      return;
    }

    const message = await interaction.fetchReply();
    if (!("createMessageComponentCollector" in message)) {
      return;
    }

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: REPWORK_PAGINATION_TIMEOUT_MS,
      filter: (button) =>
        button.customId === `${customIdPrefix}:prev` ||
        button.customId === `${customIdPrefix}:next`,
    });

    collector.on("collect", async (button: ButtonInteraction) => {
      try {
        if (button.user.id !== interaction.user.id) {
          await button.reply({
            content: "This pagination belongs to another user.",
            ephemeral: true,
          });
          return;
        }

        if (button.customId === `${customIdPrefix}:prev`) {
          page = Math.max(0, page - 1);
        } else if (button.customId === `${customIdPrefix}:next`) {
          page = Math.min(embeds.length - 1, page + 1);
        }

        await button.update({
          embeds: [embeds[page]],
          components: [buildRepWorkPaginationRow(customIdPrefix, page, embeds.length)],
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        console.error(
          `[repwork paginator] failed guildId=${interaction.guildId ?? "unknown"} userId=${interaction.user.id} page=${page} error=${formatError(error)}`,
        );
        try {
          if (!button.replied && !button.deferred) {
            await button.reply({
              content: "Failed to update repwork page.",
              ephemeral: true,
            });
          }
        } catch {
          // no-op
        }
      }
    });

    collector.on("end", async () => {
      await interaction.editReply({ components: [] }).catch(() => undefined);
    });
  },
};
