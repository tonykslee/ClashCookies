import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { WarEventHistoryService } from "../services/war-events/history";

type PlanMatchType = "FWA" | "BL" | "MM";
type PlanOutcome = "WIN" | "LOSE" | "ANY";

function normalizeMatchType(value: string | null): PlanMatchType {
  const upper = String(value ?? "").toUpperCase();
  if (upper === "BL" || upper === "MM" || upper === "FWA") return upper;
  return "FWA";
}

function normalizeOutcome(value: string | null): PlanOutcome | null {
  const upper = String(value ?? "").toUpperCase();
  if (upper === "WIN" || upper === "LOSE" || upper === "ANY") return upper;
  return null;
}

function labelFor(matchType: PlanMatchType, outcome: PlanOutcome): string {
  if (matchType === "FWA" && (outcome === "WIN" || outcome === "LOSE")) {
    return `FWA-${outcome}`;
  }
  return matchType;
}

async function getDefaultPlanText(
  history: WarEventHistoryService,
  guildId: string,
  matchType: PlanMatchType,
  outcome: PlanOutcome
): Promise<string> {
  if (matchType === "FWA" && (outcome === "WIN" || outcome === "LOSE")) {
    return (
      (await history.buildWarPlanText(
        guildId,
        "FWA",
        outcome,
        "#UNKNOWN",
        "Unknown",
        "battle"
      )) ?? "FWA plan unavailable."
    );
  }
  if (matchType === "BL") {
    return [
      "**BLACKLIST WAR PLAN**",
      "Everyone switch to WAR BASES.",
      "Hit mirror first, then follow leadership instructions.",
    ].join("\n");
  }
  return [
    "**MISMATCHED WAR PLAN**",
    "Keep war base active.",
    "Attack what you can and follow leadership instructions.",
  ].join("\n");
}

export const WarPlan: Command = {
  name: "warplan",
  description: "Set, show, or reset war plans by match type and outcome",
  options: [
    {
      name: "set",
      description: "Set war plan text for match type (or FWA outcome)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "match-type",
          description: "War match type",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "plan-text",
          description: "Custom plan text (max 1500 chars)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "outcome",
          description: "FWA outcome (optional; omit to set both WIN and LOSE)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
          ],
        },
      ],
    },
    {
      name: "show",
      description: "Show war plans by match type and outcome",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "match-type",
          description: "War match type (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "outcome",
          description: "FWA outcome (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
          ],
        },
      ],
    },
    {
      name: "reset",
      description: "Reset war plans to defaults",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "match-type",
          description: "War match type (optional; omit to reset all)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "outcome",
          description: "FWA outcome (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
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
    await interaction.deferReply({ ephemeral: true });

    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand(true);
    const history = new WarEventHistoryService(cocService);

    if (subcommand === "set") {
      const matchType = normalizeMatchType(interaction.options.getString("match-type", true));
      const outcome = normalizeOutcome(interaction.options.getString("outcome", false));
      const planText = interaction.options.getString("plan-text", true);

      if (!planText.length) {
        await interaction.editReply("Plan text cannot be empty.");
        return;
      }
      if (planText.length > 1500) {
        await interaction.editReply("Plan text must be 1500 characters or fewer.");
        return;
      }
      if (matchType !== "FWA" && outcome) {
        await interaction.editReply("`outcome` can only be used when `match-type` is FWA.");
        return;
      }

      if (matchType === "FWA" && !outcome) {
        await prisma.$transaction([
          prisma.clanWarPlan.upsert({
            where: { guildId_matchType_outcome: { guildId, matchType: "FWA", outcome: "WIN" } },
            update: { planText },
            create: { guildId, matchType: "FWA", outcome: "WIN", planText },
          }),
          prisma.clanWarPlan.upsert({
            where: { guildId_matchType_outcome: { guildId, matchType: "FWA", outcome: "LOSE" } },
            update: { planText },
            create: { guildId, matchType: "FWA", outcome: "LOSE", planText },
          }),
        ]);
        await interaction.editReply(`Saved war plan for **FWA-WIN** and **FWA-LOSE**.\nLength: ${planText.length} chars each`);
        return;
      }

      const rowOutcome: PlanOutcome = matchType === "FWA" ? (outcome as "WIN" | "LOSE") : "ANY";
      await prisma.clanWarPlan.upsert({
        where: { guildId_matchType_outcome: { guildId, matchType, outcome: rowOutcome } },
        update: { planText },
        create: { guildId, matchType, outcome: rowOutcome, planText },
      });

      await interaction.editReply(`Saved war plan for **${labelFor(matchType, rowOutcome)}**.\nLength: ${planText.length} chars`);
      return;
    }

    if (subcommand === "show") {
      const requestedMatchType = interaction.options.getString("match-type", false);
      const requestedOutcome = normalizeOutcome(interaction.options.getString("outcome", false));
      const matchType = requestedMatchType ? normalizeMatchType(requestedMatchType) : null;

      if (matchType !== "FWA" && requestedOutcome) {
        await interaction.editReply("`outcome` can only be used when `match-type` is FWA.");
        return;
      }

      const targets: Array<{ matchType: PlanMatchType; outcome: PlanOutcome }> = [];
      if (!matchType) {
        targets.push(
          { matchType: "BL", outcome: "ANY" },
          { matchType: "MM", outcome: "ANY" },
          { matchType: "FWA", outcome: "WIN" },
          { matchType: "FWA", outcome: "LOSE" }
        );
      } else if (matchType === "FWA" && !requestedOutcome) {
        targets.push({ matchType: "FWA", outcome: "WIN" }, { matchType: "FWA", outcome: "LOSE" });
      } else {
        targets.push({
          matchType,
          outcome: matchType === "FWA" ? (requestedOutcome as "WIN" | "LOSE") : "ANY",
        });
      }

      const rows = await prisma.clanWarPlan.findMany({
        where: {
          guildId,
          OR: targets.map((target) => ({ matchType: target.matchType, outcome: target.outcome })),
        },
        select: {
          matchType: true,
          outcome: true,
          planText: true,
        },
      });

      const rowByKey = new Map<string, string>();
      for (const row of rows) {
        rowByKey.set(`${row.matchType}:${row.outcome}`, row.planText);
      }

      const fields = [];
      for (const target of targets) {
        const key = `${target.matchType}:${target.outcome}`;
        const custom = rowByKey.get(key);
        const text = custom ?? (await getDefaultPlanText(history, guildId, target.matchType, target.outcome));
        fields.push({
          name: `${labelFor(target.matchType, target.outcome)} (${custom ? "Custom" : "Default"})`,
          value: text,
          inline: false,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("War Plans")
        .setDescription("Plans by match type and outcome")
        .addFields(fields)
        .setColor(0x3498db)
        .setTimestamp(new Date());

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === "reset") {
      const requestedMatchType = interaction.options.getString("match-type", false);
      const requestedOutcome = normalizeOutcome(interaction.options.getString("outcome", false));
      const matchType = requestedMatchType ? normalizeMatchType(requestedMatchType) : null;

      if (matchType !== "FWA" && requestedOutcome) {
        await interaction.editReply("`outcome` can only be used when `match-type` is FWA.");
        return;
      }

      if (!matchType) {
        const result = await prisma.clanWarPlan.deleteMany({ where: { guildId } });
        await interaction.editReply(`Reset all war plans to defaults.\nRemoved entries: ${result.count}`);
        return;
      }

      if (matchType !== "FWA") {
        const result = await prisma.clanWarPlan.deleteMany({ where: { guildId, matchType, outcome: "ANY" } });
        await interaction.editReply(`Reset **${matchType}** war plan to default.\nRemoved entries: ${result.count}`);
        return;
      }

      if (!requestedOutcome) {
        const result = await prisma.clanWarPlan.deleteMany({
          where: { guildId, matchType: "FWA", outcome: { in: ["WIN", "LOSE"] } },
        });
        await interaction.editReply(`Reset **FWA-WIN** and **FWA-LOSE** plans to defaults.\nRemoved entries: ${result.count}`);
        return;
      }

      const result = await prisma.clanWarPlan.deleteMany({
        where: { guildId, matchType: "FWA", outcome: requestedOutcome },
      });
      await interaction.editReply(`Reset **FWA-${requestedOutcome}** plan to default.\nRemoved entries: ${result.count}`);
      return;
    }

    await interaction.editReply("Unsupported /warplan usage.");
  },
};
