import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { deriveWarState } from "./fwa/matchState";

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function parseCocApiTime(input: string | null | undefined): number | null {
  if (!input) return null;
  const match = input.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
}

function formatPhaseLabel(state: "preparation" | "inWar" | "notInWar"): string {
  if (state === "preparation") return "Preparation Day";
  if (state === "inWar") return "Battle Day";
  return "No War";
}

export const Remaining: Command = {
  name: "remaining",
  description: "Time remaining helpers",
  options: [
    {
      name: "war",
      description: "Show remaining time until current war phase ends",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Tracked clan tag (with or without #)",
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
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand(true);
    if (sub !== "war") {
      await interaction.editReply("Unknown /remaining option.");
      return;
    }

    const tagBare = normalizeTag(interaction.options.getString("tag", true));
    if (!tagBare) {
      await interaction.editReply("Invalid clan tag.");
      return;
    }

    const tracked = await prisma.trackedClan.findFirst({
      where: { tag: { equals: `#${tagBare}`, mode: "insensitive" } },
      select: { tag: true, name: true },
    });
    if (!tracked) {
      await interaction.editReply(`Clan #${tagBare} is not in tracked clans.`);
      return;
    }

    const war = await cocService.getCurrentWar(`#${tagBare}`).catch(() => null);
    const state = deriveWarState(war?.state);
    if (state === "notInWar") {
      await interaction.editReply(
        `**${tracked.name?.trim() || `#${tagBare}`}** (#${tagBare}) is currently **No War**.`
      );
      return;
    }

    const phaseEndMs =
      state === "preparation" ? parseCocApiTime(war?.startTime) : parseCocApiTime(war?.endTime);
    if (phaseEndMs === null || !Number.isFinite(phaseEndMs)) {
      await interaction.editReply(
        `Could not resolve phase end time for **${tracked.name?.trim() || `#${tagBare}`}** (#${tagBare}).`
      );
      return;
    }

    const unix = Math.floor(phaseEndMs / 1000);
    const label = formatPhaseLabel(state);
    await interaction.editReply(
      [
        `**${tracked.name?.trim() || `#${tagBare}`}** (#${tagBare})`,
        `Current phase: **${label}**`,
        `Phase ends: <t:${unix}:F>`,
        `Remaining: <t:${unix}:R>`,
      ].join("\n")
    );
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const query = normalizeTag(String(focused.value ?? "")).toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((clan) => {
        const tag = normalizeTag(clan.tag);
        const label = clan.name?.trim() ? `${clan.name.trim()} (#${tag})` : `#${tag}`;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter((c) => c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query))
      .slice(0, 25);

    await interaction.respond(choices);
  },
};

