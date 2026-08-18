import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import type { Prisma } from "@prisma/client";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import {
  ClanHealthSnapshotService,
  type ClanHealthExternalSnapshot,
  type ClanHealthSnapshot,
  type ClanHealthTrackedSnapshot,
} from "../services/ClanHealthSnapshotService";
import { normalizeClashTagInput } from "../helper/clashTag";
import { buildClanHealthNavigationRow } from "./ClanHealthNavigation";

const clanHealthSnapshotService = new ClanHealthSnapshotService();

/** Purpose: normalize clan tags to uppercase with optional leading '#'. */
function normalizeClanTag(input: string): string {
  return normalizeClashTagInput(input);
}

/** Purpose: render rates with percentage + numerator/denominator for leadership readability. */
function formatRate(numerator: number, denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) return "n/a (0/0)";
  const pct = (numerator / denominator) * 100;
  return `${pct.toFixed(1)}% (${numerator}/${denominator})`;
}

/** Purpose: render a percentage-only rate while preserving n/a for empty denominators. */
function formatPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** Purpose: pluralize player account labels for the compliance summary. */
function formatPlayerAccountLabel(count: number): string {
  return count === 1 ? "player account" : "player accounts";
}

/** Purpose: render a compact freshness label for persisted composition data. */
function formatCompositionSourceAge(ageMs: number | null): string {
  if (ageMs === null) return "n/a";

  const totalMinutes = Math.max(0, Math.floor(ageMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/** Purpose: render the compact deviation label used by clan-health composition. */
function formatCompositionDeviation(input: {
  healthy: boolean;
  deviationScore: number | null;
  selectedHeatMapRefAvailable: boolean;
}): string {
  const prefix = input.healthy ? "✅" : "⚠️";
  if (input.deviationScore === null || !input.selectedHeatMapRefAvailable) {
    return `${prefix} n/a`;
  }
  return Number.isInteger(input.deviationScore)
    ? `${prefix} ${input.deviationScore}`
    : `${prefix} ${input.deviationScore.toFixed(1)}`;
}

/** Purpose: render the current persisted composition spread for tracked clans. */
function buildTrackedCurrentCompositionLines(snapshot: ClanHealthTrackedSnapshot): string[] {
  const composition = snapshot.composition;
  return [
    `TH18: **${composition.displayCounts.TH18}** | TH17: **${composition.displayCounts.TH17}** | TH16: **${composition.displayCounts.TH16}** | TH15: **${composition.displayCounts.TH15}** | TH14: **${composition.displayCounts.TH14}** | <=TH13: **${composition.displayCounts["<=TH13"]}**`,
    `Members: **${composition.memberCount}/50** | Unresolved: **${composition.unresolvedWeightCount}**`,
    `Deviation: **${formatCompositionDeviation(composition)}**`,
    `Source age: **${formatCompositionSourceAge(composition.sourceAgeMs)}**`,
  ];
}

/** Purpose: render the current persisted catalog-backed composition spread for external clans. */
function buildExternalCurrentCompositionLines(snapshot: ClanHealthExternalSnapshot): string[] {
  const composition = snapshot.composition;
  const count = (value: number | null): string => (value === null ? "?" : String(value));
  return [
    `TH18: **${count(composition.displayCounts.TH18)}** | TH17: **${count(composition.displayCounts.TH17)}** | TH16: **${count(composition.displayCounts.TH16)}** | TH15: **${count(composition.displayCounts.TH15)}** | TH14: **${count(composition.displayCounts.TH14)}** | <=TH13: **${count(composition.displayCounts["<=TH13"])}**`,
    `Members: **${composition.memberCount === null ? "?" : composition.memberCount}/50** | Unresolved: **${composition.unresolvedWeightCount}**`,
    `Deviation: **${formatCompositionDeviation(composition)}**`,
    `Source age: **${formatCompositionSourceAge(composition.sourceAgeMs)}**`,
  ];
}

/** Purpose: render the compact recent-war summary used by external clan-health. */
function buildExternalWarPerformanceLines(snapshot: ClanHealthExternalSnapshot): string[] {
  if (!snapshot.warPerformance) {
    return [];
  }

  return [
    `Match rate (last 30 available ended wars): **${formatRate(
      snapshot.warPerformance.fwaMatchCount,
      snapshot.warPerformance.endedWarSampleSize,
    )}**`,
    `:green_circle: ${snapshot.warPerformance.fwaWinCount} | :red_circle: ${snapshot.warPerformance.fwaLossCount} | :black_circle: ${snapshot.warPerformance.blMatchCount} | :white_circle: ${snapshot.warPerformance.mmMatchCount}`,
    `Match rate (including BL): **${formatPercent(
      snapshot.warPerformance.blInclusiveMatchCount,
      snapshot.warPerformance.endedWarSampleSize,
    )}**`,
    `Win rate (same window): **${formatRate(
      snapshot.warPerformance.winCount,
      snapshot.warPerformance.endedWarSampleSize,
    )}**`,
  ];
}

/** Purpose: render the selected historical war-plan compliance summary for clan-health. */
function buildWarPlanComplianceLines(snapshot: ClanHealthSnapshot): string[] {
  if (snapshot.viewType !== "tracked") {
    return ["No completed FWA war-plan evaluations are available yet."];
  }
  if (!snapshot.warPlanCompliance.hasCompletedEvaluations) {
    return ["No completed FWA war-plan evaluations are available yet."];
  }

  return [
    `Violations: **${snapshot.warPlanCompliance.violationCount}** across **${snapshot.warPlanCompliance.distinctPlayerCount}** ${formatPlayerAccountLabel(
      snapshot.warPlanCompliance.distinctPlayerCount,
    )}`,
    `Linked Discord users involved: **${snapshot.warPlanCompliance.distinctCurrentDiscordUserCount}**`,
    `Affected wars: **${snapshot.warPlanCompliance.affectedWarCount}/${snapshot.warPlanCompliance.evaluatedWarCount}** evaluated FWA wars`,
  ];
}

/** Purpose: build response embed for a clan-health snapshot. */
function buildClanHealthEmbed(snapshot: ClanHealthSnapshot): EmbedBuilder {
  if (snapshot.viewType === "external") {
    const fields: Array<{ name: string; value: string; inline: boolean }> = [];
    const warPerformanceLines = buildExternalWarPerformanceLines(snapshot);
    if (warPerformanceLines.length > 0) {
      fields.push({
        name: "War Performance",
        value: warPerformanceLines.join("\n"),
        inline: false,
      });
    }
    fields.push({
      name: "Current Composition",
      value: buildExternalCurrentCompositionLines(snapshot).join("\n"),
      inline: false,
    });

    return new EmbedBuilder()
      .setTitle(`Clan Health: ${snapshot.clanName} — External Clan View`)
      .setDescription("External FWA clan snapshot from available persisted FWAStats data.")
      .addFields(fields)
      .setFooter({ text: `${snapshot.clanTag} • External FWAStats snapshot` });
  }

  return new EmbedBuilder()
    .setTitle(`Clan Health: ${snapshot.clanName}`)
    .setDescription(
      "Leadership snapshot: current composition, persisted war-plan compliance, inactivity, and missing Discord links.",
    )
    .addFields(
      {
        name: "War Performance",
        value: [
          `Match rate (last ${snapshot.historicalWindowDays} days; ${snapshot.warMetrics.endedWarSampleSize} ended wars): **${formatRate(
            snapshot.warMetrics.fwaMatchCount,
            snapshot.warMetrics.endedWarSampleSize,
          )}**`,
          `:green_circle: ${snapshot.warMetrics.fwaWinCount} | :red_circle: ${snapshot.warMetrics.fwaLossCount} | :black_circle: ${snapshot.warMetrics.blMatchCount} | :white_circle: ${snapshot.warMetrics.mmMatchCount}`,
          `Match rate (including BL): **${formatPercent(
            snapshot.warMetrics.blInclusiveMatchCount,
            snapshot.warMetrics.endedWarSampleSize,
          )}**`,
          `Win rate (same window): **${formatRate(
            snapshot.warMetrics.winCount,
            snapshot.warMetrics.endedWarSampleSize,
          )}**`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Current Composition",
        value: buildTrackedCurrentCompositionLines(snapshot).join("\n"),
        inline: false,
      },
      {
        name: `War Plan Compliance \u2014 Last ${snapshot.historicalWindowDays} Days`,
        value: buildWarPlanComplianceLines(snapshot).join("\n"),
        inline: false,
      },
      {
        name: "Inactivity",
        value: [
          `Missed both attacks (distinct players, >=1 eligible FWA war in last ${snapshot.historicalWindowDays} days): **${snapshot.inactiveWars.inactivePlayerCount}**`,
          `Eligible ended FWA wars in window: **${snapshot.inactiveWars.warsSampled}**`,
          `Inactive (days, >=${snapshot.inactiveDays.thresholdDays}d): **${snapshot.inactiveDays.inactivePlayerCount}**`,
          `Observed members (updated in last ${snapshot.inactiveDays.staleHours}h): **${snapshot.inactiveDays.observedMemberCount}**`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Discord Links",
        value: `Missing links: **${snapshot.missingLinks.missingMemberCount}/${snapshot.missingLinks.observedMemberCount}** observed member(s)`,
        inline: false,
      },
    )
    .setFooter({ text: `${snapshot.clanTag} • Deterministic DB snapshot` });
}

function buildTrackedClanAutocompleteChoices(input: { nameQuery: string; tagQuery: string }) {
  return prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { name: true, tag: true },
  }).then((tracked) => {
    const choices = tracked
      .map((clan) => {
        const normalized = normalizeClanTag(clan.tag);
        const bare = normalized.replace(/^#/, "");
        const label = clan.name?.trim() ? `${clan.name.trim()} (${normalized})` : normalized;
        return { name: label.slice(0, 100), value: bare };
      })
      .filter((choice) => {
        const name = choice.name.toLowerCase();
        const value = choice.value.toLowerCase();
        const hasQuery = input.nameQuery.length > 0 || input.tagQuery.length > 0;
        if (!hasQuery) return true;
        const nameMatches = input.nameQuery.length > 0 && name.includes(input.nameQuery);
        const tagMatches = input.tagQuery.length > 0 && value.includes(input.tagQuery);
        return nameMatches || tagMatches;
      });

    return { tracked, choices };
  });
}

export const ClanHealth: Command = {
  name: "clan-health",
  description:
    "Leadership snapshot: composition, war performance, compliance, inactivity, and Discord links",
  options: [
    {
      name: "tag",
      description: "FWA clan tag (with or without #)",
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: true,
    },
    {
      name: "window",
      description: "Tracked metrics history window in days",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      min_value: 7,
      max_value: 180,
    },
    {
      name: "visibility",
      description: "Response visibility",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "private", value: "private" },
        { name: "public", value: "public" },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    await interaction.deferReply({ ephemeral: true });

    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const tagInput = interaction.options.getString("tag", true);
    const historicalWindowDays = interaction.options.getInteger("window", false);
    const normalizedTag = normalizeClanTag(tagInput);
    if (!normalizedTag) {
      await interaction.editReply("Invalid clan tag.");
      return;
    }

    const snapshot = await clanHealthSnapshotService.getSnapshot({
      guildId: interaction.guildId,
      clanTag: normalizedTag,
      historicalWindowDays: historicalWindowDays ?? undefined,
    });

    if (!snapshot) {
      await interaction.editReply(`No persisted FWA data was found for clan ${normalizedTag}.`);
      return;
    }

    await interaction.editReply({
      embeds: [buildClanHealthEmbed(snapshot)],
      ...(snapshot.viewType === "tracked"
        ? {
            components: [
              buildClanHealthNavigationRow(
                snapshot.clanTag,
                snapshot.historicalWindowDays,
              ),
            ],
          }
        : {}),
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const rawQuery = String(focused.value ?? "").trim().toLowerCase();
    const tagQuery = normalizeClanTag(String(focused.value ?? "")).replace(/^#/, "").toLowerCase();
    const { tracked, choices } = await buildTrackedClanAutocompleteChoices({
      nameQuery: rawQuery,
      tagQuery,
    });
    if (rawQuery.length === 0 && tagQuery.length === 0) {
      await interaction.respond(choices.slice(0, 25));
      return;
    }

    const trackedTags = new Set(
      tracked
        .map((clan) => normalizeClanTag(clan.tag))
        .filter((tag): tag is string => Boolean(tag)),
    );
    const remaining = Math.max(0, 25 - choices.length);
    const externalQueryClauses: Prisma.FwaClanCatalogWhereInput[] = [];
    if (rawQuery.length > 0) {
      externalQueryClauses.push({ name: { contains: rawQuery, mode: "insensitive" } });
    }
    if (tagQuery.length > 0) {
      externalQueryClauses.push({ clanTag: { contains: tagQuery, mode: "insensitive" } });
    }
    const externalRows =
      remaining > 0
        ? await prisma.fwaClanCatalog.findMany({
            where: {
              NOT: { clanTag: { in: [...trackedTags] } },
              ...(externalQueryClauses.length > 0 ? { OR: externalQueryClauses } : {}),
            },
            orderBy: [{ lastSyncedAt: "desc" }, { clanTag: "asc" }],
            take: remaining,
            select: { clanTag: true, name: true },
          })
        : [];
    const seen = new Set(choices.map((choice) => choice.value.toLowerCase()));
    const externalChoices = (externalRows ?? [])
      .map((clan) => {
        const normalized = normalizeClanTag(clan.clanTag);
        const bare = normalized.replace(/^#/, "");
        const label = clan.name?.trim()
          ? `${clan.name.trim()} (${normalized}) - External`
          : `${normalized} - External`;
        return { name: label.slice(0, 100), value: bare };
      })
      .filter((choice) => {
        const value = choice.value.toLowerCase();
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });

    await interaction.respond([...choices, ...externalChoices].slice(0, 25));
  },
};

export const buildClanHealthEmbedForTest = buildClanHealthEmbed;
