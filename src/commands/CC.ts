import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";
import { prisma } from "../prisma";

function normalizeTag(input: string): string {
  return input.trim().replace(/^#/, "");
}

export const CC: Command = {
  name: "cc",
  description: "Build ClashChamps URLs for player or clan tags",
  options: [
    {
      name: "player",
      description: "Build player URL by tag",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "clan",
      description: "Build clan URL by tag",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
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
    _cocService: CoCService
  ) => {
    try {
      const subcommand = interaction.options.getSubcommand(true);
      const rawTag = interaction.options.getString("tag", true);
      const tag = normalizeTag(rawTag);

      if (!tag) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Please provide a valid tag.",
        });
        return;
      }

      const url =
        subcommand === "player"
          ? `https://cc.fwafarm.com/cc_n/member.php?tag=${tag}`
          : `https://cc.fwafarm.com/cc_n/clan.php?tag=${tag}`;

      await safeReply(interaction, {
        ephemeral: true,
        content: url,
      });
    } catch (err) {
      console.error(`cc command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: "Failed to build CC URL. Check the tag and try again.",
      });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    let subcommand = "";
    try {
      subcommand = interaction.options.getSubcommand(true);
    } catch {
      await interaction.respond([]);
      return;
    }

    if (subcommand !== "clan") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((c) => {
        const normalized = c.tag.trim().replace(/^#/, "");
        const label = c.name?.trim() ? `${c.name.trim()} (#${normalized})` : `#${normalized}`;
        return { name: label.slice(0, 100), value: normalized };
      })
      .filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
