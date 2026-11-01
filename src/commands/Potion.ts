import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";
import {
  calculatePotionCompletion,
  calculatePotionRecommendation,
  formatPotionDuration,
  type PotionCalculationResult,
  type PotionRecommendationResult,
  type PotionType,
} from "../services/PotionCalculatorService";

function completionTimestamp(unixSeconds: number): string {
  return `<t:${unixSeconds}:F> (<t:${unixSeconds}:R>)`;
}

function potionCountLabel(numPots: number): string {
  return `${numPots} ${numPots === 1 ? "potion" : "potions"}`;
}

function addHelperField(
  embed: EmbedBuilder,
  helperLevel: number | undefined,
  helperNextInSeconds: number | undefined,
): void {
  if (helperLevel === undefined) return;
  embed.addFields({
    name: "Helper",
    value: `Level ${helperLevel}\nNext work session: ${formatPotionDuration(helperNextInSeconds ?? 0)}`,
    inline: true,
  });
}

function addActiveBoostField(
  embed: EmbedBuilder,
  boostRemainingSeconds: number | undefined,
  boostRemainingDisplay: string | undefined,
  effectiveBoostWindowSeconds: number | undefined,
): boolean {
  if (boostRemainingSeconds === undefined || effectiveBoostWindowSeconds === undefined) {
    return false;
  }
  embed.addFields({
    name: "Active boost",
    value: [
      `Remaining: ${boostRemainingDisplay ?? formatPotionDuration(boostRemainingSeconds)}`,
      `Total boosted window: ${formatPotionDuration(effectiveBoostWindowSeconds)}`,
    ].join("\n"),
    inline: true,
  });
  return true;
}

/** Purpose: render the explicit potion calculation as one compact embed. */
function buildPotionResultEmbed(
  result: Extract<PotionCalculationResult, { kind: "valid" }>,
): EmbedBuilder {
  const potionLabel = result.numPots === 1 ? "potion" : "potions";
  const embed = new EmbedBuilder()
    .setTitle(`${result.typeLabel} Calculator`)
    .setDescription(`**Finishes in ${result.completionDurationDisplay}**`)
    .addFields(
      { name: "Completion", value: completionTimestamp(result.completionUnixSeconds), inline: false },
      { name: "Time saved", value: result.timeSavedDisplay, inline: true },
      { name: "Original upgrade", value: result.originalTimeLeftDisplay, inline: true },
      {
        name: "Potions & boost",
        value: `${result.numPots} ${potionLabel} · ${result.speedMultiplier}x for ${formatPotionDuration(result.boostWindowSeconds)}`,
        inline: false,
      },
    );

  const hasActiveBoost = addActiveBoostField(
    embed,
    result.boostRemainingSeconds,
    result.boostRemainingDisplay,
    result.effectiveBoostWindowSeconds,
  );
  addHelperField(embed, result.helperLevel, result.helperNextInSeconds);
  embed.setFooter({
    text: hasActiveBoost
      ? "Estimate assumes immediate activation. Active boost countdowns may vary slightly in game."
      : "Estimate assumes immediate activation of the selected potions.",
  });
  return embed;
}

/** Purpose: render the minimum-pot recommendation and its boundary comparison. */
function buildPotionRecommendationEmbed(
  result: Extract<PotionRecommendationResult, { kind: "recommendation" }>,
): EmbedBuilder {
  const scenario = result.recommendedScenario;
  const embed = new EmbedBuilder()
    .setTitle(`${result.typeLabel} Calculator`)
    .setDescription(
      `**Recommended: ${result.recommendedNumPots} additional ${result.recommendedNumPots === 1 ? "potion" : "potions"}**`,
    )
    .addFields(
      { name: "Original upgrade", value: result.originalTimeLeftDisplay, inline: true },
      {
        name: "Potion boost",
        value: `${result.speedMultiplier}x · ${formatPotionDuration(result.boostSecondsPerPotion)} per potion`,
        inline: true,
      },
    );

  if (result.previousScenario) {
    const previous = result.previousScenario;
    embed.addFields({
      name: `${potionCountLabel(previous.numPots)} (N−1)`,
      value: [
        `Completion: ${previous.completionDurationDisplay}`,
        `At boost expiry: ${previous.upgradeTimeRemainingAtBoostExpiryDisplay} upgrade time remaining`,
        `Complete: ${completionTimestamp(previous.completionUnixSeconds)}`,
      ].join("\n"),
      inline: false,
    });
  }

  embed.addFields({
    name: `${potionCountLabel(scenario.numPots)} (recommended)`,
    value: [
      `Completion: ${scenario.completionDurationDisplay}`,
      `Unused boost at completion: ${scenario.potionBoostRemainingAtCompletionDisplay}`,
      `Complete: ${completionTimestamp(scenario.completionUnixSeconds)}`,
    ].join("\n"),
    inline: false,
  });

  const hasActiveBoost = addActiveBoostField(
    embed,
    result.boostRemainingSeconds,
    result.boostRemainingDisplay,
    scenario.effectiveBoostWindowSeconds,
  );
  addHelperField(embed, result.helperLevel, result.helperNextInSeconds);
  embed.setFooter({
    text: hasActiveBoost
      ? "Estimate assumes immediate activation. Active boost countdowns may vary slightly in game."
      : "Estimate assumes immediate activation of the recommended potions.",
  });
  return embed;
}

/** Purpose: normalize the potion type option into one of the fixed calculator keys. */
function parsePotionType(value: string | null | undefined): PotionType | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "builder" || normalized === "research" || normalized === "pet" || normalized === "clocktower") {
    return normalized;
  }
  return null;
}

export const Potion: Command = {
  name: "potion",
  description: "Calculate potion-boosted upgrade completion times",
  options: [
    {
      name: "calc",
      description: "Calculate when an upgrade finishes with immediate potion boosts",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "type",
          description: "Potion type",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "Builder Potion", value: "builder" },
            { name: "Research Potion", value: "research" },
            { name: "Pet Potion", value: "pet" },
            { name: "Clock Tower Potion", value: "clocktower" },
          ],
        },
        {
          name: "time-left",
          description: "Upgrade time left, like 3d12h45m or 12h30m",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "num-pots",
          description: "Number of potions to activate",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          minValue: 1,
          maxValue: 100,
        },
        {
          name: "boost-remaining",
          description: "Real-world time remaining on an active boost",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "helper-level",
          description: "Builder's Apprentice (1-8) or Lab Assistant (1-12)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          minValue: 1,
          maxValue: 12,
        },
        {
          name: "helper-next-in",
          description: "Time until the next helper work session, like 0m or 2h30m",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    try {
      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand !== "calc") {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Use /potion calc to calculate potion timing.",
        });
        return;
      }

      const potionType = parsePotionType(interaction.options.getString("type", true));
      if (!potionType) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Invalid potion type.",
        });
        return;
      }

      const timeLeft = interaction.options.getString("time-left", true);
      const numPots = interaction.options.getInteger("num-pots");
      const boostRemaining = interaction.options.getString("boost-remaining");
      const helperLevel = interaction.options.getInteger("helper-level");
      const helperNextIn = interaction.options.getString("helper-next-in");
      const now = new Date();
      const result = numPots === null
        ? calculatePotionRecommendation({
            type: potionType,
            timeLeft,
            boostRemaining,
            helperLevel,
            helperNextIn,
            now,
          })
        : calculatePotionCompletion({
            type: potionType,
            timeLeft,
            numPots,
            boostRemaining,
            helperLevel,
            helperNextIn,
            now,
          });

      if (result.kind === "invalid") {
        await safeReply(interaction, {
          ephemeral: true,
          content: result.message,
        });
        return;
      }

      await safeReply(interaction, {
        ephemeral: true,
        embeds: [
          result.kind === "recommendation"
            ? buildPotionRecommendationEmbed(result)
            : buildPotionResultEmbed(result),
        ],
      });
    } catch (err) {
      console.error(`potion command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: "Failed to calculate potion timing. Check the inputs and try again.",
      });
    }
  },
};
