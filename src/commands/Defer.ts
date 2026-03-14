import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import {
  addWeightInputDeferment,
  clearOpenWeightInputDeferments,
  formatPendingAge,
  listOpenWeightInputDeferments,
  normalizePlayerTag,
  parseDeferWeightInput,
  removeOpenWeightInputDeferment,
} from "../services/WeightInputDefermentService";

function renderScopeLabel(scope: { clanTag: string | null; scopeKey: string }): string {
  if (scope.clanTag) return scope.clanTag;
  return scope.scopeKey;
}

function parseRequiredPlayerTag(raw: string): string | null {
  const normalized = normalizePlayerTag(raw);
  if (!normalized) return null;
  return normalized;
}

export const Defer: Command = {
  name: "defer",
  description: "Manage deferred FWA weight-input tasks for prospective members",
  options: [
    {
      name: "add",
      description: "Add one deferred weight-input task",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "weight",
          description: "Deferred war weight (e.g. 145000, 145,000, 145k)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "list",
      description: "List open deferred weight-input tasks",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "remove",
      description: "Resolve one deferred task after weight is entered in FWAStats",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "clear",
      description: "Clear all open deferred tasks in the active scope",
      type: ApplicationCommandOptionType.Subcommand,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }
    const channelId = interaction.channelId ?? null;
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "add") {
      const playerInput = interaction.options.getString("player-tag", true);
      const weightInput = interaction.options.getString("weight", true);
      const playerTag = parseRequiredPlayerTag(playerInput);
      if (!playerTag) {
        await interaction.editReply(
          "not_found: invalid player tag. Use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }
      const deferredWeight = parseDeferWeightInput(weightInput);
      if (!deferredWeight) {
        await interaction.editReply(
          "not_found: invalid weight. Use `145000`, `145,000`, or `145k`."
        );
        return;
      }
      const result = await addWeightInputDeferment({
        guildId,
        channelId,
        playerTag,
        deferredWeight,
      });
      if (result.outcome === "already_exists") {
        await interaction.editReply(
          `already_exists: ${playerTag} is already open in ${renderScopeLabel(result.record)}.`
        );
        return;
      }
      await interaction.editReply(
        `created: ${playerTag} queued at ${deferredWeight} in ${renderScopeLabel(result.record)}.`
      );
      return;
    }

    if (subcommand === "list") {
      const listed = await listOpenWeightInputDeferments({ guildId, channelId });
      if (listed.rows.length === 0) {
        await interaction.editReply(
          `empty_list: no open deferments in ${renderScopeLabel(listed.scope)}.`
        );
        return;
      }
      const lines = listed.rows.map((row) => {
        const age = formatPendingAge(row.createdAt);
        return `- ${row.playerTag} | weight ${row.deferredWeight} | age ${age}`;
      });
      await interaction.editReply(
        [
          `open_deferments: ${listed.rows.length} in ${renderScopeLabel(listed.scope)}`,
          ...lines,
        ].join("\n")
      );
      return;
    }

    if (subcommand === "remove") {
      const playerInput = interaction.options.getString("player-tag", true);
      const playerTag = parseRequiredPlayerTag(playerInput);
      if (!playerTag) {
        await interaction.editReply(
          "not_found: invalid player tag. Use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }
      const result = await removeOpenWeightInputDeferment({
        guildId,
        channelId,
        playerTag,
      });
      if (!result.removed) {
        await interaction.editReply(
          `not_found: no open deferment for ${playerTag} in ${renderScopeLabel(result.scope)}.`
        );
        return;
      }
      await interaction.editReply(
        `removed: ${playerTag} resolved in ${renderScopeLabel(result.scope)}.`
      );
      return;
    }

    const cleared = await clearOpenWeightInputDeferments({ guildId, channelId });
    await interaction.editReply(
      `cleared_count: ${cleared.clearedCount} in ${renderScopeLabel(cleared.scope)}.`
    );
  },
};
