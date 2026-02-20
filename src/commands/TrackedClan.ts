import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { prisma } from "../prisma";
import { ActivityService } from "../services/ActivityService";
import { CoCService } from "../services/CoCService";

function normalizeClanTag(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/^#/, "");
  return `#${cleaned}`;
}

export const TrackedClan: Command = {
  name: "tracked-clan",
  description: "Add, remove, or list tracked clans",
  options: [
    {
      name: "add",
      description: "Add a clan to tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Clan tag (example: #2QG2C08UP)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a clan from tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Clan tag to remove",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "list",
      description: "List tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    try {
      const subcommand = interaction.options.getSubcommand(true);

      if (subcommand === "list") {
        const tracked = await prisma.trackedClan.findMany({
          orderBy: { createdAt: "asc" },
        });

        if (tracked.length === 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content:
              "No tracked clans in the database. You can still set TRACKED_CLANS in .env as fallback.",
          });
          return;
        }

        const lines = tracked.map((clan) =>
          clan.name ? `- ${clan.tag} (${clan.name})` : `- ${clan.tag}`
        );
        await safeReply(interaction, {
          ephemeral: true,
          content: `Tracked clans (${tracked.length}):\n${lines.join("\n")}`,
        });
        return;
      }

      const tagInput = interaction.options.getString("tag", true);
      const tag = normalizeClanTag(tagInput);

      if (subcommand === "add") {
        const clan = await cocService.getClan(tag);
        const activityService = new ActivityService(cocService);

        const created = await prisma.trackedClan.upsert({
          where: { tag },
          update: { name: clan.name ?? null },
          create: { tag, name: clan.name ?? null },
        });

        try {
          await activityService.observeClan(tag);
        } catch (observeErr) {
          console.error(
            `tracked-clan add observe failed for ${tag}: ${formatError(observeErr)}`
          );
        }

        await safeReply(interaction, {
          ephemeral: true,
          content: `Added tracked clan ${created.tag}${created.name ? ` (${created.name})` : ""}.`,
        });
        return;
      }

      if (subcommand === "remove") {
        const deleted = await prisma.trackedClan.deleteMany({
          where: { tag },
        });

        if (deleted.count === 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content: `${tag} is not currently tracked.`,
          });
          return;
        }

        await safeReply(interaction, {
          ephemeral: true,
          content: `Removed tracked clan ${tag}.`,
        });
      }
    } catch (err) {
      console.error(`tracked-clan command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: "Failed to update tracked clans. Check the clan tag and try again.",
      });
    }
  },
};
