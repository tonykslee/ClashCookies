import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import {
  addWeightInputDefermentWithPlayerProfile,
  clearOpenWeightInputDeferments,
  formatPendingAge,
  listOpenWeightInputDeferments,
  normalizePlayerTag,
  parseDeferWeightInput,
  removeOpenWeightInputDeferment,
} from "../services/WeightInputDefermentService";
import { formatError } from "../helper/formatError";

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
    cocService: CoCService
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
      try {
        const result = await addWeightInputDefermentWithPlayerProfile({
          guildId,
          channelId,
          playerTag,
          deferredWeight,
          cocService,
        });
        switch (result.outcome) {
          case "player_profile_not_found":
            await interaction.editReply(
              `not_found: player profile for ${playerTag} could not be resolved.`
            );
            return;
          case "player_profile_lookup_failed":
            await interaction.editReply(
              `failed: player profile lookup failed for ${playerTag}. Check bot logs.`
            );
            return;
          case "player_current_upsert_failed":
          case "deferment_write_failed":
            await interaction.editReply(
              `failed: unable to save deferment for ${playerTag}. Check bot logs.`
            );
            return;
          case "created":
            await interaction.editReply(
              `created: ${playerTag} queued at ${deferredWeight} in ${renderScopeLabel(result.record)}.`
            );
            return;
          case "updated":
            await interaction.editReply(
              `updated: ${playerTag} queued at ${deferredWeight} in ${renderScopeLabel(result.record)}.`
            );
            return;
        }
      } catch (error) {
        console.error(
          `[defer] command=/defer add stage=run guild=${guildId} channel=${channelId ?? "none"} player=${playerTag} deferredWeight=${deferredWeight} error=${formatError(error)}`,
        );
        await interaction.editReply(
          `failed: unexpected deferment error for ${playerTag}. Check bot logs.`
        );
        return;
      }
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
