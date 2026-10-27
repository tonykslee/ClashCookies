import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
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

/** Purpose: render the potion calculator result into a compact Discord reply. */
function buildPotionResultContent(result: Extract<PotionCalculationResult, { kind: "valid" }>): string {
  const potionLabel = result.numPots === 1 ? "potion" : "potions";
  const boostWindowDisplay = formatPotionDuration(result.boostWindowSeconds);
  const content = [
    "**Potion Calculator**",
    `Type: **${result.typeLabel}**`,
    `Original time left: **${result.originalTimeLeftDisplay}**`,
    `Boost applied: **${result.numPots} ${potionLabel} · ${result.speedMultiplier}x for ${boostWindowDisplay}**`,
    `Completes in: **${result.completionDurationDisplay}**`,
    `Completion time: <t:${result.completionUnixSeconds}:F> (<t:${result.completionUnixSeconds}:R>)`,
    `Time saved: **${result.timeSavedDisplay}**`,
    "Assumes all selected potions are activated immediately.",
  ];

  if (result.helperLevel !== undefined) {
    content.push(
      `Helper assumption: **level ${result.helperLevel} · next work session in ${formatPotionDuration(result.helperNextInSeconds ?? 0)}**`,
      "Helper contribution repeats for 1 hour every 23 hours and is added to, rather than multiplied by, potion speed.",
    );
  }

  if (result.boostRemainingSeconds !== undefined && result.effectiveBoostWindowSeconds !== undefined) {
    content.splice(
      4,
      0,
      `Current boost remaining: **${result.boostRemainingDisplay ?? formatPotionDuration(result.boostRemainingSeconds)}**`,
      `Total boosted window: **${formatPotionDuration(result.effectiveBoostWindowSeconds)}**`,
    );
    content.push(
      "Approximation: in-game time-left decreases rapidly while boosted, so the estimate may differ slightly depending on when these values were read/submitted.",
    );
  }

  return content.join("\n");
}

/** Purpose: render the minimum-pot recommendation and its boundary comparison. */
function buildPotionRecommendationContent(
  result: Extract<PotionRecommendationResult, { kind: "recommendation" }>,
): string {
  const potionLabel = result.recommendedNumPots === 1 ? "potion" : "potions";
  const lines = [
    "**Potion Calculator**",
    `Type: **${result.typeLabel}**`,
    `Original time left: **${result.originalTimeLeftDisplay}**`,
    `Recommendation: **${result.recommendedNumPots} additional ${potionLabel}**`,
  ];

  if (result.boostRemainingSeconds !== undefined) {
    lines.push(`Current boost remaining: **${result.boostRemainingDisplay}**`);
  }
  if (result.helperLevel !== undefined) {
    lines.push(
      `Helper assumption: **level ${result.helperLevel} · next work session in ${formatPotionDuration(result.helperNextInSeconds ?? 0)}**`,
      "Helper contribution repeats for 1 hour every 23 hours and is added to, rather than multiplied by, potion speed.",
    );
  }

  if (result.previousScenario) {
    const previousLabel = result.previousScenario.numPots === 1 ? "potion" : "potions";
    lines.push(
      `With **${result.previousScenario.numPots} ${previousLabel}**: **${result.previousScenario.upgradeTimeRemainingAtBoostExpiryDisplay}** upgrade time remains when boosts expire; estimated completion in **${result.previousScenario.completionDurationDisplay}** at <t:${result.previousScenario.completionUnixSeconds}:F> (<t:${result.previousScenario.completionUnixSeconds}:R>).`,
    );
  }

  const scenario = result.recommendedScenario;
  lines.push(
    `With **${scenario.numPots} ${potionLabel}**: estimated completion in **${scenario.completionDurationDisplay}** at <t:${scenario.completionUnixSeconds}:F> (<t:${scenario.completionUnixSeconds}:R>).`,
    `Potion boost remaining at completion: **${scenario.potionBoostRemainingAtCompletionDisplay}**`,
    "Assumes all recommended potions are activated immediately; results are estimates based on the supplied time and boost values.",
  );

  return lines.join("\n");
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
        content:
          result.kind === "recommendation"
            ? buildPotionRecommendationContent(result)
            : buildPotionResultContent(result),
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
