import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { resolveCurrentCwlSeasonKey } from "../services/CwlRegistryService";
import { cwlRotationService } from "../services/CwlRotationService";
import { cwlStateService } from "../services/CwlStateService";
import { normalizeClanTag } from "../services/PlayerLinkService";

const CWL_EMBED_COLOR = 0xfee75c;
const DISCORD_DESCRIPTION_LIMIT = 4096;

function formatRelativeTimestamp(value: Date | null): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "unknown";
  }
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

function buildDescription(lines: string[]): string {
  const description = lines.join("\n");
  if (description.length <= DISCORD_DESCRIPTION_LIMIT) {
    return description;
  }
  return `${description.slice(0, DISCORD_DESCRIPTION_LIMIT - 13)}\n...truncated`;
}

function renderCurrentRoundSummary(input: {
  clanTag: string;
  clanName: string | null;
  roundDay: number;
  roundState: string;
  opponentTag: string | null;
  opponentName: string | null;
  phaseEndsAt: Date | null;
}): string {
  const clanLabel = input.clanName ? `${input.clanName} (${input.clanTag})` : input.clanTag;
  const opponentLabel =
    input.opponentName && input.opponentTag
      ? `${input.opponentName} (${input.opponentTag})`
      : input.opponentTag ?? input.opponentName ?? "unknown opponent";
  const state = input.roundState.toLowerCase().includes("preparation")
    ? "Preparation"
    : input.roundState.toLowerCase().includes("inwar")
      ? "In war"
      : input.roundState;
  return `${clanLabel} - Day ${input.roundDay} ${state} vs ${opponentLabel} - ${formatRelativeTimestamp(input.phaseEndsAt)}`;
}

function renderMembersListLines(input: {
  season: string;
  clanTag: string;
  clanName: string | null;
  entries: Awaited<ReturnType<typeof cwlStateService.listSeasonRosterForClan>>;
  inWarOnly: boolean;
}) {
  const lines: string[] = [
    `Season: ${input.season}`,
    `Clan: ${input.clanName ? `${input.clanName} (${input.clanTag})` : input.clanTag}`,
    "",
  ];
  for (const entry of input.entries) {
    const linkLabel = entry.linkedDiscordUserId
      ? `<@${entry.linkedDiscordUserId}>`
      : "unlinked";
    const currentLabel = entry.currentRound
      ? entry.currentRound.inCurrentLineup
        ? `${entry.currentRound.roundState} ${entry.currentRound.attacksUsed}/${entry.currentRound.attacksAvailable}`
        : "not in current lineup"
      : "no current round";
    lines.push(
      `${entry.playerName} \`${entry.playerTag}\` - days ${entry.daysParticipated} - ${linkLabel} - ${currentLabel}`,
    );
  }
  if (input.entries.length <= 0) {
    lines.push(
      input.inWarOnly
        ? "No persisted current/prep lineup is available for this CWL clan."
        : "No observed CWL roster members are available for this clan yet.",
    );
  }
  return lines;
}

function renderValidationSummary(input: {
  missingExpectedPlayerTags: string[];
  extraActualPlayerTags: string[];
  actualAvailable: boolean;
  complete: boolean;
}): string {
  if (!input.actualAvailable) return "actual lineup unavailable";
  if (input.complete) return "complete";
  const parts: string[] = [];
  if (input.missingExpectedPlayerTags.length > 0) {
    parts.push(`missing ${input.missingExpectedPlayerTags.join(", ")}`);
  }
  if (input.extraActualPlayerTags.length > 0) {
    parts.push(`extra ${input.extraActualPlayerTags.join(", ")}`);
  }
  return parts.join(" | ");
}

async function autocompleteCwlTrackedClan(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const season = resolveCurrentCwlSeasonKey();
  const query = String(interaction.options.getFocused(true).value ?? "")
    .trim()
    .toLowerCase();
  const rows = await prisma.cwlTrackedClan.findMany({
    where: { season },
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    select: { tag: true, name: true },
  });
  await interaction.respond(
    rows
      .map((row) => {
        const tag = normalizeClanTag(row.tag);
        const label = row.name?.trim() ? `${row.name.trim()} (${tag})` : tag;
        return {
          name: label.slice(0, 100),
          value: tag,
        };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) ||
          choice.value.toLowerCase().includes(query),
      )
      .slice(0, 25),
  );
}

async function handleMembersSubcommand(interaction: ChatInputCommandInteraction) {
  const season = resolveCurrentCwlSeasonKey();
  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  const inWarOnly = interaction.options.getBoolean("inwar", false) ?? false;
  if (!clanTag) {
    await interaction.editReply("Invalid CWL clan tag.");
    return;
  }

  const [trackedClan, roster, currentRound] = await Promise.all([
    prisma.cwlTrackedClan.findFirst({
      where: { season, tag: clanTag },
      select: { tag: true, name: true },
    }),
    cwlStateService.listSeasonRosterForClan({ clanTag, season }),
    cwlStateService.getCurrentRoundForClan({ clanTag, season }),
  ]);
  if (!trackedClan) {
    await interaction.editReply(`No tracked CWL clan found for ${clanTag} in season ${season}.`);
    return;
  }

  if (inWarOnly && !currentRound) {
    await interaction.editReply(`No active CWL round is persisted for ${clanTag}.`);
    return;
  }

  const entries = inWarOnly
    ? roster.filter((entry) => entry.currentRound?.inCurrentLineup)
    : roster;
  const lines = renderMembersListLines({
    season,
    clanTag,
    clanName: trackedClan.name,
    entries,
    inWarOnly,
  });
  if (currentRound) {
    lines.splice(
      2,
      0,
      renderCurrentRoundSummary({
        clanTag,
        clanName: currentRound.clanName,
        roundDay: currentRound.roundDay,
        roundState: currentRound.roundState,
        opponentTag: currentRound.opponentTag,
        opponentName: currentRound.opponentName,
        phaseEndsAt: currentRound.roundState.toLowerCase().includes("preparation")
          ? currentRound.startTime
          : currentRound.endTime,
      }),
      "",
    );
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(CWL_EMBED_COLOR)
        .setTitle(`/cwl members ${clanTag}`)
        .setDescription(buildDescription(lines)),
    ],
  });
}

async function handleRotationCreateSubcommand(interaction: ChatInputCommandInteraction) {
  const clanTag = interaction.options.getString("clan", true);
  const exclude = interaction.options.getString("exclude", false);
  const overwrite = interaction.options.getBoolean("overwrite", false) ?? false;
  const result = await cwlRotationService.createPlan({
    clanTag,
    excludeTagsRaw: exclude,
    overwrite,
  });

  if (result.outcome === "not_tracked") {
    await interaction.editReply(`No tracked CWL clan found for ${result.clanTag || clanTag}.`);
    return;
  }
  if (result.outcome === "not_preparation") {
    await interaction.editReply(
      `CWL rotations can only be created during persisted CWL preparation day for ${result.clanTag}.`,
    );
    return;
  }
  if (result.outcome === "blocked_existing") {
    await interaction.editReply(
      `An active CWL rotation plan already exists for ${result.clanTag} in ${result.season} (version ${result.existingVersion}). Re-run with overwrite:true to replace it.`,
    );
    return;
  }
  if (result.outcome === "invalid_excludes") {
    await interaction.editReply(
      `These exclude tags are not in the observed ${result.season} CWL roster for ${result.clanTag}: ${result.invalidTags.join(", ")}`,
    );
    return;
  }
  if (result.outcome === "not_enough_players") {
    await interaction.editReply(
      `Not enough CWL roster members remain after exclusions for ${result.clanTag}. Need ${result.lineupSize}, have ${result.availablePlayers}.`,
    );
    return;
  }

  const lines = [
    `Created CWL rotation plan for ${result.clanTag}.`,
    `Season: ${result.season}`,
    `Version: ${result.version}`,
    `Lineup size: ${result.lineupSize}`,
  ];
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(...result.warnings);
  }
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(CWL_EMBED_COLOR)
        .setTitle(`/cwl rotations create ${result.clanTag}`)
        .setDescription(buildDescription(lines)),
    ],
  });
}

async function handleRotationShowSubcommand(interaction: ChatInputCommandInteraction) {
  const season = resolveCurrentCwlSeasonKey();
  const clanTag = normalizeClanTag(interaction.options.getString("clan", false) ?? "");
  const day = interaction.options.getInteger("day", false);

  if (!clanTag) {
    const overview = await cwlRotationService.listOverview({ season });
    const lines = [
      `Season: ${season}`,
      "",
      ...overview.map((entry) => {
        const clanLabel = entry.clanName ? `${entry.clanName} (${entry.clanTag})` : entry.clanTag;
        if (entry.status === "complete") {
          return `${clanLabel} - day ${entry.roundDay} complete`;
        }
        if (entry.status === "mismatch") {
          return `${clanLabel} - day ${entry.roundDay} mismatch - missing ${entry.missingExpectedPlayerTags.join(", ") || "none"} - extra ${entry.extraActualPlayerTags.join(", ") || "none"}`;
        }
        if (entry.status === "no_plan_day") {
          return `${clanLabel} - no planned lineup for day ${entry.roundDay}`;
        }
        return `${clanLabel} - no active CWL round`;
      }),
    ];
    if (overview.length <= 0) {
      lines.push("No active CWL rotation plans found.");
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(CWL_EMBED_COLOR)
          .setTitle("/cwl rotations show")
          .setDescription(buildDescription(lines)),
      ],
    });
    return;
  }

  const planView = await cwlRotationService.getActivePlanView({ clanTag, season });
  if (!planView) {
    await interaction.editReply(`No active CWL rotation plan exists for ${clanTag} in ${season}.`);
    return;
  }

  const relevantDays = day
    ? planView.days.filter((entry) => entry.roundDay === day)
    : planView.days;
  if (day && relevantDays.length <= 0) {
    await interaction.editReply(`No planned CWL rotation day ${day} exists for ${clanTag}.`);
    return;
  }

  const lines = [
    `Season: ${planView.season}`,
    `Clan: ${planView.clanTag}`,
    `Version: ${planView.version}`,
  ];
  if (planView.warningSummary) {
    lines.push(`Warnings: ${planView.warningSummary}`);
  }
  if (planView.excludedPlayerTags.length > 0) {
    lines.push(`Excluded: ${planView.excludedPlayerTags.join(", ")}`);
  }
  lines.push("");

  for (const entry of relevantDays) {
    const validation = await cwlRotationService.validatePlanDay({
      clanTag: planView.clanTag,
      season: planView.season,
      roundDay: entry.roundDay,
    });
    lines.push(`Day ${entry.roundDay}`);
    lines.push(
      `Planned: ${entry.members.map((member) => `${member.playerName} (${member.playerTag})`).join(", ") || "none"}`,
    );
    lines.push(
      `Actual: ${
        entry.actual
          ? entry.actual.members
              .filter((member) => member.subbedIn)
              .map((member) => `${member.playerName} (${member.playerTag})`)
              .join(", ") || "none"
          : "unavailable"
      }`,
    );
    if (validation) {
      lines.push(
        `Status: ${renderValidationSummary({
          missingExpectedPlayerTags: validation.missingExpectedPlayerTags,
          extraActualPlayerTags: validation.extraActualPlayerTags,
          actualAvailable: validation.actualAvailable,
          complete: validation.complete,
        })}`,
      );
    }
    lines.push("");
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(CWL_EMBED_COLOR)
        .setTitle(`/cwl rotations show ${planView.clanTag}`)
        .setDescription(buildDescription(lines)),
    ],
  });
}

export const Cwl: Command = {
  name: "cwl",
  description: "Inspect persisted CWL rosters and rotation plans",
  options: [
    {
      name: "members",
      description: "Show the observed current-season CWL roster for one tracked clan",
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
          name: "inwar",
          description: "Only show the persisted current/prep lineup",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "rotations",
      description: "Show or create current-season CWL rotation plans",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "show",
          description: "Show active CWL rotation status or one clan plan",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "clan",
              description: "Tracked CWL clan tag",
              type: ApplicationCommandOptionType.String,
              required: false,
              autocomplete: true,
            },
            {
              name: "day",
              description: "Specific CWL day to inspect",
              type: ApplicationCommandOptionType.Integer,
              required: false,
              minValue: 1,
              maxValue: 7,
            },
          ],
        },
        {
          name: "create",
          description: "Create or replace the active CWL rotation plan for one tracked clan",
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
              name: "exclude",
              description: "Comma-separated player tags to exclude from planning",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "overwrite",
              description: "Replace the active current-season plan",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
          ],
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
  ) => {
    const visibility = interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    await interaction.deferReply({ ephemeral: !isPublic });

    try {
      const group = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand(true);
      if (!group && subcommand === "members") {
        await handleMembersSubcommand(interaction);
        return;
      }
      if (group === "rotations" && subcommand === "create") {
        await handleRotationCreateSubcommand(interaction);
        return;
      }
      if (group === "rotations" && subcommand === "show") {
        await handleRotationShowSubcommand(interaction);
        return;
      }
      await interaction.editReply("Unsupported CWL subcommand.");
    } catch (err) {
      console.error(`[cwl] command_failed error=${formatError(err)}`);
      await interaction.editReply("Failed to load CWL data.");
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "clan") {
      await autocompleteCwlTrackedClan(interaction);
      return;
    }
    await interaction.respond([]);
  },
};
