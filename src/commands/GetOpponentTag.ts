import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
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
      autocomplete: true,
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
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
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
        const normalized = normalizeClanTag(c.tag).replace(/^#/, "");
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
