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
  buildActiveWarRemainingSamples,
  formatCurrentWarPhaseLabel,
  formatHumanDuration,
  formatMinutesSeconds,
  getCurrentWarPhase,
  getPhaseEndAtMs,
  normalizeClanTag,
  summarizeDominantRemainingCluster,
  type ActiveWarRemainingSample,
  type CurrentWarRemainingRow,
} from "../services/RemainingWarService";

/** Purpose: build a stable clan display label from tracked metadata. */
function formatClanDisplay(clanName: string | null | undefined, clanTag: string): string {
  const trimmed = String(clanName ?? "").trim();
  return trimmed ? `${trimmed} (${clanTag})` : clanTag;
}

/** Purpose: render one active-war sample line for cluster and outlier sections. */
function formatAggregateSampleLine(sample: ActiveWarRemainingSample): string {
  const label = formatClanDisplay(sample.clanName, sample.clanTag);
  const phaseEndUnix = Math.floor(sample.phaseEndAtMs / 1000);
  return `- ${label}: ${formatHumanDuration(sample.remainingSeconds)} remaining (${formatCurrentWarPhaseLabel(sample.phase)} | <t:${phaseEndUnix}:R>)`;
}

/** Purpose: build single-clan remaining-war response from persisted CurrentWar state. */
function buildSingleRemainingMessage(input: {
  clanTag: string;
  clanName: string | null;
  row: CurrentWarRemainingRow | null;
}): string {
  const clanDisplay = formatClanDisplay(input.clanName, input.clanTag);
  if (!input.row) {
    return `**${clanDisplay}** is currently **No War**.`;
  }
  const phase = getCurrentWarPhase(input.row.state);
  if (!phase) {
    return `**${clanDisplay}** is currently **No War**.`;
  }
  const phaseEndMs = getPhaseEndAtMs(input.row);
  if (phaseEndMs === null || !Number.isFinite(phaseEndMs)) {
    return `Could not resolve phase end time for **${clanDisplay}** from persisted war state.`;
  }
  const unix = Math.floor(phaseEndMs / 1000);
  return [
    `**${clanDisplay}**`,
    `Current phase: **${formatCurrentWarPhaseLabel(phase)}**`,
    `Phase ends: <t:${unix}:F>`,
    `Remaining: <t:${unix}:R>`,
  ].join("\n");
}

/** Purpose: build aggregate alliance response using deterministic cluster + outlier logic. */
function buildAggregateRemainingMessage(input: {
  samples: ActiveWarRemainingSample[];
  proximityMinutes?: number;
}): string {
  if (input.samples.length === 0) {
    return "No tracked clans are currently in active war.";
  }

  const summary = summarizeDominantRemainingCluster(
    input.samples,
    input.proximityMinutes ?? 10
  );
  if (!summary) {
    return "No tracked clans are currently in active war.";
  }

  const prepCount = input.samples.filter((sample) => sample.phase === "preparation").length;
  const battleCount = input.samples.filter((sample) => sample.phase === "inWar").length;
  const dominant = summary.dominantCluster;

  const lines: string[] = [
    "**Alliance Remaining War Summary**",
    `Dominant cluster mean remaining: **${formatHumanDuration(dominant.meanRemainingSeconds)}**`,
    `Cluster spread: **${formatMinutesSeconds(dominant.spreadSeconds)}** (max-min)`,
    `Cluster size: **${dominant.members.length}/${summary.totalActiveWarClans}** active-war tracked clans`,
    `Phase mix: **${prepCount} preparation / ${battleCount} battle day**`,
    "",
    "**Dominant Cluster**",
    ...dominant.members.map((sample) => formatAggregateSampleLine(sample)),
  ];

  if (summary.outliers.length > 0) {
    lines.push("", `**Outliers (${summary.outliers.length})**`);
    lines.push(...summary.outliers.map((sample) => formatAggregateSampleLine(sample)));
  }

  return lines.join("\n");
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
          required: false,
          autocomplete: true,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand(true);
    if (sub !== "war") {
      await interaction.editReply("Unknown /remaining option.");
      return;
    }

    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const requestedTag = interaction.options.getString("tag", false);
    if (requestedTag) {
      const tag = normalizeClanTag(requestedTag);
      if (!tag) {
        await interaction.editReply("Invalid clan tag.");
        return;
      }

      const [tracked, currentWar] = await Promise.all([
        prisma.trackedClan.findFirst({
          where: { tag: { equals: tag, mode: "insensitive" } },
          select: { tag: true, name: true },
        }),
        prisma.currentWar.findUnique({
          where: {
            clanTag_guildId: {
              guildId: interaction.guildId,
              clanTag: tag,
            },
          },
          select: { clanTag: true, state: true, startTime: true, endTime: true },
        }),
      ]);
      if (!tracked) {
        await interaction.editReply(`Clan ${tag} is not in tracked clans.`);
        return;
      }

      await interaction.editReply(
        buildSingleRemainingMessage({
          clanTag: normalizeClanTag(tracked.tag),
          clanName: tracked.name ?? null,
          row: currentWar,
        })
      );
      return;
    }

    const [trackedClans, activeCurrentWarRows] = await Promise.all([
      prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { tag: true, name: true },
      }),
      prisma.currentWar.findMany({
        where: {
          guildId: interaction.guildId,
          state: { in: ["preparation", "inWar"] },
        },
        select: {
          clanTag: true,
          state: true,
          startTime: true,
          endTime: true,
        },
      }),
    ]);

    const trackedNameByTag = new Map<string, string | null>();
    for (const clan of trackedClans) {
      trackedNameByTag.set(normalizeClanTag(clan.tag), clan.name ?? null);
    }
    const trackedTagSet = new Set(trackedNameByTag.keys());
    const trackedActiveRows = activeCurrentWarRows.filter((row) =>
      trackedTagSet.has(normalizeClanTag(row.clanTag))
    );
    const samples = buildActiveWarRemainingSamples(
      trackedActiveRows,
      trackedNameByTag,
      Date.now()
    );
    await interaction.editReply(
      buildAggregateRemainingMessage({
        samples,
        proximityMinutes: 10,
      })
    );
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const query = normalizeClanTag(String(focused.value ?? "")).replace(/^#/, "").toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((clan) => {
        const tag = normalizeClanTag(clan.tag).replace(/^#/, "");
        const label = clan.name?.trim() ? `${clan.name.trim()} (#${tag})` : `#${tag}`;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter((c) => c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query))
      .slice(0, 25);

    await interaction.respond(choices);
  },
};

export const buildSingleRemainingMessageForTest = buildSingleRemainingMessage;
export const buildAggregateRemainingMessageForTest = buildAggregateRemainingMessage;

