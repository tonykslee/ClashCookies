import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import {
  autocompleteCwlTrackedClan,
  handleRosterManagerSubcommand,
  handleRosterSignupSubcommand,
} from "./Cwl";
import { autocompleteSyncTimeZones } from "../services/syncTimeZone";

export { handleRosterSignupButtonInteraction, handleRosterRemoveButtonInteraction, handleRosterSelectionMenuInteraction, handleRosterSelectionActionButtonInteraction } from "./Cwl";

export const Roster: Command = {
  name: "roster",
  description: "Create and manage persisted roster signups",
  options: [
    {
      name: "create",
      description: "Post a CWL signup roster with account-aware signup buttons",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "timezone",
          description: "Timezone to show on the signup roster",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "report",
      description: "Show a manager-readable signup readiness report",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "readiness",
      description: "Show an export-friendly roster readiness view",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "refresh",
      description: "Re-render the posted CWL signup roster from DB truth",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "open",
      description: "Open roster signups for the tracked CWL clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "close",
      description: "Close roster signups for the tracked CWL clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "archive",
      description: "Archive the tracked CWL roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "add",
      description: "Manually add one or more linked player accounts to a roster group",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "group",
          description: "Roster group key",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "players",
          description: "Comma or space separated player tags",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "move",
      description: "Move one or more signup entries to another roster group",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "group",
          description: "Destination roster group key",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "players",
          description: "Comma or space separated player tags",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove one or more signup entries from the roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "players",
          description: "Comma or space separated player tags",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    try {
      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === "create") {
        await handleRosterSignupSubcommand(interaction);
        return;
      }
      await handleRosterManagerSubcommand(interaction);
    } catch {
      await interaction.editReply("Failed to load roster data.");
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "timezone") {
      await interaction.respond(autocompleteSyncTimeZones(focused.value));
      return;
    }
    if (focused.name === "clan") {
      await autocompleteCwlTrackedClan(interaction);
      return;
    }
    await interaction.respond([]);
  },
};
