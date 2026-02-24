import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import { formatError } from "../helper/formatError";

function normalizeClanTag(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

export const GetOpponentTag: Command = {
  name: "opponent",
  description: "Get current war opponent clan tag for a clan",
  options: [
    {
      name: "tag",
      description: "Your clan tag (with or without #)",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const rawTag = interaction.options.getString("tag", true);
    const clanTag = normalizeClanTag(rawTag);
    if (!clanTag) {
      await interaction.editReply("Please provide a valid clan tag.");
      return;
    }

    try {
      const war = await cocService.getCurrentWar(clanTag);
      const opponentTagRaw = String(war?.opponent?.tag ?? "").trim();
      if (!opponentTagRaw) {
        await interaction.editReply(
          `No active war opponent found for ${clanTag}.`
        );
        return;
      }

      const opponentTag = opponentTagRaw.replace(/^#/, "").toUpperCase();
      await interaction.editReply(
        `Opponent tag for ${clanTag}: \`${opponentTag}\``
      );
    } catch (err) {
      console.error(
        `[opponent] failed tag=${clanTag} error=${formatError(err)}`
      );
      await interaction.editReply(
        "Failed to fetch opponent tag from CoC API. Try again shortly."
      );
    }
  },
};
