import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import {
  runForceSyncWarIdCommand,
  runForceMailUpdateCommand,
  runForceSyncDataCommand,
  runForceSyncMailCommand,
} from "./Fwa";

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

export const Force: Command = {
  name: "force",
  description: "Manual force-sync utilities",
  options: [
    {
      name: "sync",
      description: "Force sync data and message references",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "data",
          description: "Force-refresh points and sync number for a tracked clan",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "tag",
              description: "Tracked clan tag (with or without #)",
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true,
            },
            {
              name: "datapoint",
              description: "Choose which value to overwrite",
              type: ApplicationCommandOptionType.String,
              required: false,
              choices: [
                { name: "points", value: "points" },
                { name: "syncNum", value: "syncNum" },
              ],
            },
          ],
        },
        {
          name: "warid",
          description: "Backfill or repair warId values in one table at a time",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "table",
              description: "Table to update",
              type: ApplicationCommandOptionType.String,
              required: true,
              choices: [
                { name: "CurrentWar", value: "currentwar" },
                { name: "ClanWarHistory", value: "clanwarhistory" },
                { name: "WarAttacks", value: "warattacks" },
              ],
            },
            {
              name: "tag",
              description: "Filter: clan tag (with or without #)",
              type: ApplicationCommandOptionType.String,
              required: false,
              autocomplete: true,
            },
            {
              name: "confirm",
              description: "Set true to execute writes. Default is preview-only.",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
            {
              name: "overwrite",
              description: "Allow updating non-null warId rows",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
            {
              name: "set_war_id",
              description: "Set this explicit warId instead of deriving",
              type: ApplicationCommandOptionType.Integer,
              required: false,
            },
            {
              name: "filter_war_id",
              description: "Filter by existing warId",
              type: ApplicationCommandOptionType.Integer,
              required: false,
            },
            {
              name: "war_start_time",
              description: "Filter: war start time (ISO 8601, UTC)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "sync_number",
              description: "Filter: sync number",
              type: ApplicationCommandOptionType.Integer,
              required: false,
            },
            {
              name: "opponent_tag",
              description: "Filter: opponent tag (with or without #)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "player_tag",
              description: "Filter: player tag (WarAttacks only)",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "attack_number",
              description: "Filter: attack number (WarAttacks only)",
              type: ApplicationCommandOptionType.Integer,
              required: false,
            },
          ],
        },
        {
          name: "mail",
          description: "Upsert MailConfig for a tracked clan message",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "tag",
              description: "Tracked clan tag (with or without #)",
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true,
            },
            {
              name: "message_type",
              description: "Message type to record in MailConfig",
              type: ApplicationCommandOptionType.String,
              required: true,
              choices: [
                { name: "mail", value: "mail" },
                { name: "notify:war start", value: "notify:war_start" },
                { name: "notify:battle start", value: "notify:battle_start" },
                { name: "notify:war end", value: "notify:war_end" },
              ],
            },
            {
              name: "message_id",
              description: "Discord message ID to store",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: "mail",
      description: "Force operations for posted war mail",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "update",
          description: "Refresh existing sent mail embed in place and resume tracking",
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
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    const subcommandGroup = interaction.options.getSubcommandGroup(true);
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommandGroup === "sync" && subcommand === "data") {
      await runForceSyncDataCommand(interaction, cocService);
      return;
    }
    if (subcommandGroup === "sync" && subcommand === "mail") {
      await runForceSyncMailCommand(interaction, cocService);
      return;
    }
    if (subcommandGroup === "sync" && subcommand === "warid") {
      await runForceSyncWarIdCommand(interaction);
      return;
    }
    if (subcommandGroup === "mail" && subcommand === "update") {
      await runForceMailUpdateCommand(interaction);
      return;
    }

    await interaction.reply({
      ephemeral: true,
      content: "Unsupported /force command usage.",
    });
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
        const normalized = normalizeTag(c.tag);
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

