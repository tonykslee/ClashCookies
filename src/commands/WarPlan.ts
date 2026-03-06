import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { WarEventHistoryService } from "../services/war-events/history";
import { MatchType, normalizeTag } from "../services/war-events/core";

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function normalizeClanTag(input: string): string {
  const normalized = normalizeClanTagInput(input);
  return normalized ? `#${normalized}` : "";
}

function normalizeMatchType(value: string | null | undefined): MatchType {
  const upper = String(value ?? "").toUpperCase();
  if (upper === "BL" || upper === "MM" || upper === "FWA") return upper;
  return "FWA";
}

function normalizeOutcome(value: string | null | undefined): "WIN" | "LOSE" | null {
  const upper = String(value ?? "").toUpperCase();
  if (upper === "WIN" || upper === "LOSE") return upper;
  return null;
}

function buildFallbackPlanText(
  matchType: MatchType,
  opponentName: string,
  phase: "prep" | "battle"
): string {
  if (matchType === "BL") {
    if (phase === "prep") {
      return [
        `BLACKLIST WAR vs ${opponentName}`,
        "Everyone switch to WAR BASES!",
        "This is an opportunity to gain extra FWA points.",
      ].join("\n");
    }
    return [
      `**⚫️ BLACKLIST WAR 🆚 ${opponentName} 🏴‍☠️**`,
      "Everyone switch to WAR BASES!!",
      "This is our opportunity to gain some extra FWA points!",
      "➕ 30+ people switch to war base = +1 point",
      "➕ 60% total destruction = +1 point",
      "➕ win war = +1 point",
      "---",
      "If you need war base, check https://clashofclans-layouts.com/ or ⁠bases",
    ].join("\n");
  }

  if (matchType === "MM") {
    return phase === "prep"
      ? [`MISMATCHED WAR vs ${opponentName}`, "Keep war base active and attack what you can."].join(
          "\n"
        )
      : [`⚪️ MISMATCHED WAR 🆚 ${opponentName} :sob:`, "Keep WA base active, attack what you can!"].join(
          "\n"
        );
  }

  return "FWA plan unavailable (expected outcome unknown).";
}

async function resolveDisplayedPlan(params: {
  history: WarEventHistoryService;
  guildId: string;
  clanTag: string;
  currentWar: {
    matchType: string | null;
    outcome: string | null;
    opponentName: string | null;
  } | null;
  customPlan: string | null | undefined;
  phase: "prep" | "battle";
}): Promise<{ text: string; source: "custom" | "default" }> {
  if (params.customPlan && params.customPlan.trim().length > 0) {
    return { text: params.customPlan, source: "custom" };
  }

  const matchType = normalizeMatchType(params.currentWar?.matchType);
  const outcome = normalizeOutcome(params.currentWar?.outcome) ?? "LOSE";
  const opponentName = String(params.currentWar?.opponentName ?? "").trim() || "Unknown";
  const defaultPlan =
    (await params.history.buildWarPlanText(
      params.guildId,
      matchType,
      outcome,
      normalizeTag(params.clanTag),
      opponentName,
      params.phase
    )) ?? buildFallbackPlanText(matchType, opponentName, params.phase);

  return { text: defaultPlan, source: "default" };
}

export const WarPlan: Command = {
  name: "warplan",
  description: "Set, show, or reset custom war plans for tracked clans",
  options: [
    {
      name: "set",
      description: "Set a custom prep or battle plan for a tracked clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "phase",
          description: "Plan phase to customize",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "prep", value: "prep" },
            { name: "battle", value: "battle" },
          ],
        },
        {
          name: "plan-text",
          description: "Custom plan text (max 1500 chars)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "show",
      description: "Show the stored custom war plans for a tracked clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "reset",
      description: "Delete all custom war plans for a tracked clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
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

    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    const clanTag = normalizeClanTag(interaction.options.getString("clan-tag", true));

    const trackedClan = await prisma.trackedClan.findUnique({
      where: { tag: clanTag },
      select: { name: true, tag: true },
    });
    if (!trackedClan) {
      await interaction.editReply(`Tracked clan ${clanTag} was not found.`);
      return;
    }

    if (subcommand === "set") {
      const phase = interaction.options.getString("phase", true) as "prep" | "battle";
      const planTextInput = interaction.options.getString("plan-text", true);
      if (!planTextInput.length) {
        await interaction.editReply("Plan text cannot be empty.");
        return;
      }
      if (planTextInput.length > 1500) {
        await interaction.editReply("Plan text must be 1500 characters or fewer.");
        return;
      }
      const planText = planTextInput;

      const row = await prisma.clanWarPlan.upsert({
        where: {
          guildId_clanTag: {
            guildId: interaction.guildId,
            clanTag,
          },
        },
        update: phase === "prep" ? { prepPlan: planText } : { battlePlan: planText },
        create: {
          guildId: interaction.guildId,
          clanTag,
          prepPlan: phase === "prep" ? planText : null,
          battlePlan: phase === "battle" ? planText : null,
        },
      });

      await interaction.editReply(
        `Saved ${phase} plan for **${trackedClan.name ?? clanTag}** (${clanTag}).\nLength: ${phase === "prep" ? row.prepPlan?.length ?? 0 : row.battlePlan?.length ?? 0} chars`
      );
      return;
    }

    if (subcommand === "show") {
      const history = new WarEventHistoryService(cocService);
      const row = await prisma.clanWarPlan.findUnique({
        where: {
          guildId_clanTag: {
            guildId: interaction.guildId,
            clanTag,
          },
        },
        select: {
          prepPlan: true,
          battlePlan: true,
        },
      });
      const currentWar = await prisma.currentWar.findUnique({
        where: {
          clanTag_guildId: {
            clanTag,
            guildId: interaction.guildId,
          },
        },
        select: {
          matchType: true,
          outcome: true,
          opponentName: true,
        },
      });
      const prep = await resolveDisplayedPlan({
        history,
        guildId: interaction.guildId,
        clanTag,
        currentWar,
        customPlan: row?.prepPlan,
        phase: "prep",
      });
      const battle = await resolveDisplayedPlan({
        history,
        guildId: interaction.guildId,
        clanTag,
        currentWar,
        customPlan: row?.battlePlan,
        phase: "battle",
      });

      const embed = new EmbedBuilder()
        .setTitle(`War Plan - ${trackedClan.name ?? clanTag}`)
        .setDescription(`Clan: ${clanTag}`)
        .addFields(
          {
            name: `Prep Plan (${prep.source === "custom" ? "Custom" : "Default"})`,
            value: prep.text,
            inline: false,
          },
          {
            name: `Battle Plan (${battle.source === "custom" ? "Custom" : "Default"})`,
            value: battle.text,
            inline: false,
          }
        )
        .setColor(0x3498db)
        .setTimestamp(new Date());

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === "reset") {
      await prisma.clanWarPlan.deleteMany({
        where: {
          guildId: interaction.guildId,
          clanTag,
        },
      });
      await interaction.editReply(`Reset custom war plans for **${trackedClan.name ?? clanTag}** (${clanTag}).`);
      return;
    }

    await interaction.editReply("Unsupported /warplan usage.");
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan-tag") {
      await interaction.respond([]);
      return;
    }

    const query = normalizeClanTagInput(String(focused.value ?? "")).toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((clan) => {
        const tag = normalizeClanTagInput(clan.tag);
        const label = clan.name?.trim() ? `${clan.name.trim()} (#${tag})` : `#${tag}`;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter((choice) =>
        choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
