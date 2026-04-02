import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { resolveCurrentCwlSeasonKey } from "../services/CwlRegistryService";
import { SettingsService } from "../services/SettingsService";
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
import {
  remainingCwlService,
  type RemainingCwlClanView,
} from "../services/RemainingCwlService";

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

const settingsService = new SettingsService();

/** Purpose: persist per-user last-viewed remaining-war clan selection. */
function buildRemainingWarLastClanKey(guildId: string, userId: string): string {
  return `remaining:war:last-clan:${guildId}:${userId}`;
}

/** Purpose: persist per-user last-viewed remaining-CWL clan selection. */
function buildRemainingCwlLastClanKey(guildId: string, userId: string): string {
  return `remaining:cwl:last-clan:${guildId}:${userId}`;
}

/** Purpose: format one date as a Discord absolute timestamp token. */
function formatAbsoluteTimestamp(input: Date): string {
  return `<t:${Math.floor(input.getTime() / 1000)}:F>`;
}

/** Purpose: format one date as a Discord relative timestamp token. */
function formatRelativeTimestamp(input: Date): string {
  return `<t:${Math.floor(input.getTime() / 1000)}:R>`;
}

/** Purpose: render one persisted CWL remaining section from DB-backed round state only. */
function buildCwlRemainingSection(view: RemainingCwlClanView): string[] {
  const clanDisplay = formatClanDisplay(view.clanName, view.clanTag);
  const stateLabel = (view.roundState ?? "unknown").trim() || "unknown";
  const state = stateLabel.toLowerCase();
  const lines: string[] = [`**${clanDisplay}**`, `Current state: **${stateLabel}**`];

  if (state.includes("preparation")) {
    lines.push(
      view.battleDayStartsAt
        ? `Battle day starts: ${formatAbsoluteTimestamp(view.battleDayStartsAt)}`
        : "Battle day starts: Unknown",
      view.battleDayStartsAt
        ? `Time until battle day starts: ${formatRelativeTimestamp(view.battleDayStartsAt)}`
        : "Time until battle day starts: Unknown",
    );
    return lines;
  }

  if (state.includes("inwar")) {
    lines.push(
      view.battleDayEndsAt
        ? `Battle day ends: ${formatAbsoluteTimestamp(view.battleDayEndsAt)}`
        : "Battle day ends: Unknown",
      view.battleDayEndsAt
        ? `Battle day remaining: ${formatRelativeTimestamp(view.battleDayEndsAt)}`
        : "Battle day remaining: Unknown",
      view.nextWarAt
        ? `Next war: ${formatRelativeTimestamp(view.nextWarAt)}`
        : "Next war: Unknown",
    );
    return lines;
  }

  lines.push("Battle day remaining: Unknown", "Next war: Unknown");
  return lines;
}

/** Purpose: build a public multi-clan CWL remaining view from persisted tracked-clan round state. */
function buildCwlRemainingAggregateMessage(views: RemainingCwlClanView[]): string {
  if (views.length <= 0) {
    return "No tracked CWL clans are configured for this season.";
  }
  const lines: string[] = ["**CWL Remaining**"];
  for (const view of views) {
    lines.push("", ...buildCwlRemainingSection(view));
  }
  if (lines.at(-1) === "") {
    lines.pop();
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
        {
          name: "all",
          description: "Show all tracked clans currently in active war",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "cwl",
      description: "Show CWL remaining time from persisted CWL tables",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Tracked CWL clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "all",
          description: "Show all tracked CWL clans",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    const sub = interaction.options.getSubcommand(true);
    await interaction.deferReply({ ephemeral: sub !== "cwl" });

    if (sub === "war") {
      if (!interaction.guildId) {
        await interaction.editReply("This command can only be used in a server.");
        return;
      }

      const requestedTag = interaction.options.getString("tag", false);
      const allRequested = interaction.options.getBoolean("all", false) === true;
      let resolvedTag: string | null = null;

      if (requestedTag) {
        resolvedTag = normalizeClanTag(requestedTag);
        if (!resolvedTag) {
          await interaction.editReply("Invalid clan tag.");
          return;
        }
      }

      if (!resolvedTag && !allRequested) {
        const lastViewedTag = await settingsService.get(
          buildRemainingWarLastClanKey(interaction.guildId, interaction.user.id)
        );
        if (lastViewedTag) {
          resolvedTag = normalizeClanTag(lastViewedTag);
        }
      }

      if (resolvedTag) {
        const [tracked, currentWar] = await Promise.all([
          prisma.trackedClan.findFirst({
            where: { tag: { equals: resolvedTag, mode: "insensitive" } },
            select: { tag: true, name: true },
          }),
          prisma.currentWar.findUnique({
            where: {
              clanTag_guildId: {
                guildId: interaction.guildId,
                clanTag: resolvedTag,
              },
            },
            select: { clanTag: true, state: true, startTime: true, endTime: true },
          }),
        ]);
        if (!tracked) {
          if (!requestedTag) {
            await interaction.editReply(
              "No last viewed clan found for `/remaining war`. Use `/remaining war tag:<tag>` first or `/remaining war all`."
            );
            return;
          }
          await interaction.editReply(`Clan ${resolvedTag} is not in tracked clans.`);
          return;
        }

        await settingsService.set(
          buildRemainingWarLastClanKey(interaction.guildId, interaction.user.id),
          normalizeClanTag(tracked.tag)
        );
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
      return;
    }

    if (sub !== "cwl") {
      await interaction.editReply("Unknown /remaining option.");
      return;
    }

    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const requestedTag = interaction.options.getString("tag", false);
    const allRequested = interaction.options.getBoolean("all", false) === true;
    let resolvedTag: string | null = null;

    if (requestedTag) {
      resolvedTag = normalizeClanTag(requestedTag);
      if (!resolvedTag) {
        await interaction.editReply("Invalid clan tag.");
        return;
      }
    }

    if (!resolvedTag && !allRequested) {
      const lastViewedTag = await settingsService.get(
        buildRemainingCwlLastClanKey(interaction.guildId, interaction.user.id)
      );
      if (lastViewedTag) {
        resolvedTag = normalizeClanTag(lastViewedTag);
      }
    }

    if (resolvedTag) {
      const view = await remainingCwlService.getClanView({ clanTag: resolvedTag });
      if (!view) {
        if (!requestedTag) {
          await interaction.editReply(
            "No last viewed clan found for `/remaining cwl`. Use `/remaining cwl tag:<tag>` first or `/remaining cwl all:true`."
          );
          return;
        }
        await interaction.editReply(`Clan ${resolvedTag} is not in tracked CWL clans.`);
        return;
      }

      await settingsService.set(
        buildRemainingCwlLastClanKey(interaction.guildId, interaction.user.id),
        normalizeClanTag(view.clanTag)
      );
      await interaction.editReply(buildCwlRemainingAggregateMessage([view]));
      return;
    }

    if (!allRequested) {
      await interaction.editReply(
        "No last viewed clan found for `/remaining cwl`. Use `/remaining cwl tag:<tag>` first or `/remaining cwl all:true`."
      );
      return;
    }

    const views = await remainingCwlService.listClanViews();
    await interaction.editReply(buildCwlRemainingAggregateMessage(views));
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const sub = interaction.options.getSubcommand(false);
    const rawQuery = String(focused.value ?? "").trim().toLowerCase();
    const normalizedQuery = normalizeClanTag(rawQuery).replace(/^#/, "").toLowerCase();
    const query = normalizedQuery.length > 0 ? normalizedQuery : rawQuery;
    const tracked =
      sub === "cwl"
        ? await prisma.cwlTrackedClan.findMany({
            where: { season: resolveCurrentCwlSeasonKey() },
            orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
            select: { name: true, tag: true },
          })
        : await prisma.trackedClan.findMany({
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

