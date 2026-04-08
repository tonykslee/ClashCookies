import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  UserActivityReminderMethod,
  UserActivityReminderType,
} from "@prisma/client";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import {
  createUserActivityReminderRules,
  formatOffsetMinutes,
  getReminderMaxOffsetMinutes,
  listLinkedPlayerTagOptionsForRemindme,
  listUserActivityReminderRuleGroups,
  removeUserActivityReminderRulesByIds,
  type UserActivityReminderRuleGroup,
} from "../services/remindme/UserActivityReminderService";
import {
  listRecruitmentReminderRulesForUser,
  removeRecruitmentReminderRulesByIds,
} from "../services/RecruitmentReminderService";

const REMINDME_PANEL_TIMEOUT_MS = 10 * 60 * 1000;

/** Purpose: build one deterministic method label for embeds and responses. */
function formatReminderMethodLabel(method: UserActivityReminderMethod): string {
  return method === UserActivityReminderMethod.PING_HERE ? "ping-me-here" : "DM";
}

/** Purpose: render one grouped reminder row in a concise scan-friendly format. */
function formatReminderGroupLine(group: UserActivityReminderRuleGroup): string {
  const playerLabel = group.playerName
    ? `${group.playerName} ${group.playerTag}`
    : group.playerTag;
  const offsets = group.offsetMinutes.map((offset) => formatOffsetMinutes(offset)).join(", ");
  return `- **${group.type}** | ${playerLabel} | ${formatReminderMethodLabel(group.method)} | ${offsets}`;
}

/** Purpose: build a deterministic remindme list embed body for user-owned reminder groups. */
function buildReminderListEmbed(input: {
  discordUserId: string;
  groups: UserActivityReminderRuleGroup[];
  title: string;
}): EmbedBuilder {
  const lines =
    input.groups.length > 0
      ? input.groups.map((group) => formatReminderGroupLine(group))
      : ["No active reminders configured."];
  return new EmbedBuilder()
    .setTitle(input.title)
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setFooter({
      text: `User: ${input.discordUserId} | Rules: ${input.groups.reduce((sum, group) => sum + group.ruleIds.length, 0)}`,
    });
}

/** Purpose: build remove-flow select menu options in deterministic grouped order. */
function buildRemoveSelectOptions(groups: UserActivityReminderRuleGroup[]): Array<{
  label: string;
  value: string;
  description: string;
}> {
  return groups.slice(0, 25).map((group) => {
    const playerLabel = group.playerName ?? group.playerTag;
    const offsets = group.offsetMinutes.map((offset) => formatOffsetMinutes(offset)).join(", ");
    return {
      label: `${group.type} ${playerLabel}`.slice(0, 100),
      value: group.key,
      description: `${group.playerTag} | ${formatReminderMethodLabel(group.method)} | ${offsets}`.slice(
        0,
        100,
      ),
    };
  });
}

/** Purpose: render remove-flow components with multiselect + confirm/cancel controls. */
function buildRemoveComponents(input: {
  groups: UserActivityReminderRuleGroup[];
  selectedGroupKeys: Set<string>;
  interactionId: string;
}) {
  const options = buildRemoveSelectOptions(input.groups);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`remindme:remove:select:${input.interactionId}`)
    .setPlaceholder(
      options.length > 0 ? "Select reminders to remove" : "No reminders available",
    )
    .setMinValues(0)
    .setMaxValues(Math.max(1, options.length))
    .setDisabled(options.length <= 0)
    .addOptions(
      options.length > 0
        ? options.map((option) => ({
            ...option,
            default: input.selectedGroupKeys.has(option.value),
          }))
        : [
            {
              label: "No reminders",
              value: "none",
              description: "Nothing to remove",
            },
          ],
    );

  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`remindme:remove:confirm:${input.interactionId}`)
      .setLabel("Confirm Remove")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(options.length <= 0),
    new ButtonBuilder()
      .setCustomId(`remindme:remove:cancel:${input.interactionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), actions];
}

type RecruitmentReminderListRow = Awaited<
  ReturnType<typeof listRecruitmentReminderRulesForUser>
>[number];

function formatRecruitmentReminderLine(row: RecruitmentReminderListRow): string {
  const unix = Math.floor(row.nextReminderAt.getTime() / 1000);
  const clanLabel = row.clanNameSnapshot
    ? `${row.clanNameSnapshot} ${row.clanTag}`
    : row.clanTag;
  return `- **Recruitment** | ${clanLabel} | ${row.platform} | ${row.timezone} | <t:${unix}:R>`;
}

function buildRecruitmentReminderListSection(rows: RecruitmentReminderListRow[]): string[] {
  if (rows.length <= 0) return ["No active recruitment reminders."];
  return rows.map((row) => formatRecruitmentReminderLine(row));
}

function buildCombinedReminderRemovalOptions(input: {
  activityGroups: UserActivityReminderRuleGroup[];
  recruitmentRows: RecruitmentReminderListRow[];
}): Array<{
  label: string;
  value: string;
  description: string;
}> {
  const activityOptions = input.activityGroups.map((group) => {
    const playerLabel = group.playerName ?? group.playerTag;
    const offsets = group.offsetMinutes.map((offset) => formatOffsetMinutes(offset)).join(", ");
    return {
      label: `Activity ${group.type} ${playerLabel}`.slice(0, 100),
      value: `activity|${group.key}`,
      description: `${group.playerTag} | ${formatReminderMethodLabel(group.method)} | ${offsets}`.slice(
        0,
        100,
      ),
    };
  });

  const recruitmentOptions = input.recruitmentRows.map((row) => {
    const clanLabel = row.clanNameSnapshot ? `${row.clanNameSnapshot} (${row.clanTag})` : row.clanTag;
    return {
      label: `Recruitment ${clanLabel}`.slice(0, 100),
      value: `recruitment|${row.id}`,
      description: `${row.platform} | ${row.timezone} | <t:${Math.floor(row.nextReminderAt.getTime() / 1000)}:R>`.slice(
        0,
        100,
      ),
    };
  });

  return [...activityOptions, ...recruitmentOptions].slice(0, 25);
}

function buildCombinedRemoveComponents(input: {
  activityGroups: UserActivityReminderRuleGroup[];
  recruitmentRows: RecruitmentReminderListRow[];
  selectedGroupKeys: Set<string>;
  interactionId: string;
}) {
  const options = buildCombinedReminderRemovalOptions({
    activityGroups: input.activityGroups,
    recruitmentRows: input.recruitmentRows,
  });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`remindme:remove:select:${input.interactionId}`)
    .setPlaceholder(options.length > 0 ? "Select reminders to remove" : "No reminders available")
    .setMinValues(0)
    .setMaxValues(Math.max(1, options.length))
    .setDisabled(options.length <= 0)
    .addOptions(
        options.length > 0
          ? options.map((option) => ({
              ...option,
              default: input.selectedGroupKeys.has(option.value),
            }))
        : [
            {
              label: "No reminders",
              value: "none",
              description: "Nothing to remove",
            },
          ],
    );

  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`remindme:remove:confirm:${input.interactionId}`)
      .setLabel("Confirm Remove")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(options.length <= 0),
    new ButtonBuilder()
      .setCustomId(`remindme:remove:cancel:${input.interactionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), actions];
}

function buildCombinedReminderListEmbed(input: {
  discordUserId: string;
  activityGroups: UserActivityReminderRuleGroup[];
  recruitmentRows: RecruitmentReminderListRow[];
  title: string;
}): EmbedBuilder {
  const activityLines =
    input.activityGroups.length > 0
      ? input.activityGroups.map((group) => formatReminderGroupLine(group))
      : ["No active activity reminders."];
  const recruitmentLines = buildRecruitmentReminderListSection(input.recruitmentRows);
  const lines = [
    "Activity reminders:",
    ...activityLines,
    "",
    "Recruitment reminders:",
    ...recruitmentLines,
  ];
  return new EmbedBuilder()
    .setTitle(input.title)
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setFooter({
      text: `User: ${input.discordUserId} | Activity Rules: ${input.activityGroups.reduce(
        (sum, group) => sum + group.ruleIds.length,
        0,
      )} | Recruitment Rules: ${input.recruitmentRows.length}`,
    });
}

/** Purpose: compose and register `/remindme` user-scoped reminder command flows. */
export const RemindMe: Command = {
  name: "remindme",
  description: "Configure recurring reminders for your linked player activity",
  options: [
    {
      name: "set",
      description: "Create one or more reminders for your linked player tags",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "type",
          description: "Reminder category",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "WAR", value: UserActivityReminderType.WAR },
            { name: "CWL", value: UserActivityReminderType.CWL },
            { name: "RAIDS", value: UserActivityReminderType.RAIDS },
            { name: "GAMES", value: UserActivityReminderType.GAMES },
          ],
        },
        {
          name: "player_tags",
          description: "One or more linked player tags (comma-separated)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "time_left",
          description: "Reminder offsets in HhMm format (comma-separated), e.g. 12h,2h,30m",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "method",
          description: "Reminder delivery method",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "DM", value: UserActivityReminderMethod.DM },
            { name: "ping-me-here", value: UserActivityReminderMethod.PING_HERE },
          ],
        },
      ],
    },
    {
      name: "list",
      description: "List your active reminders",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "remove",
      description: "Remove one or more of your active reminders",
      type: ApplicationCommandOptionType.Subcommand,
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "set") {
      const typeRaw = interaction.options.getString("type", true);
      const type =
        typeRaw === UserActivityReminderType.WAR ||
        typeRaw === UserActivityReminderType.CWL ||
        typeRaw === UserActivityReminderType.RAIDS ||
        typeRaw === UserActivityReminderType.GAMES
          ? typeRaw
          : null;
      const rawPlayerTags = interaction.options.getString("player_tags", true);
      const rawOffsets = interaction.options.getString("time_left", true);
      const methodRaw = interaction.options.getString("method", false);
      const method =
        methodRaw === UserActivityReminderMethod.PING_HERE
          ? UserActivityReminderMethod.PING_HERE
          : UserActivityReminderMethod.DM;

      if (!type) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Invalid reminder type.",
        });
        return;
      }

      const result = await createUserActivityReminderRules({
        discordUserId: interaction.user.id,
        type,
        rawPlayerTags,
        rawOffsets,
        method,
        surfaceGuildId: interaction.guildId ?? null,
        surfaceChannelId:
          method === UserActivityReminderMethod.PING_HERE ? interaction.channelId : null,
      });

      if (result.outcome === "invalid_offsets") {
        const maxLabel = formatOffsetMinutes(getReminderMaxOffsetMinutes(type));
        await safeReply(interaction, {
          ephemeral: true,
          content: [
            "Invalid `time_left` input.",
            "Use positive `HhMm` offsets separated by commas (example: `12h,2h,30m`).",
            result.parsed.invalidTokens.length > 0
              ? `Invalid tokens: ${result.parsed.invalidTokens.join(", ")}`
              : "",
            result.parsed.outOfWindowTokens.length > 0
              ? `Out-of-window tokens (max ${maxLabel} for ${type}): ${result.parsed.outOfWindowTokens.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        return;
      }

      if (result.outcome === "no_linked_tags") {
        await safeReply(interaction, {
          ephemeral: true,
          content:
            "No linked player tags found for your account. Use `/link create player-tag:<tag>` first.",
        });
        return;
      }

      if (result.outcome === "non_linked_tags") {
        const nonLinked = result.rejectedNonLinkedTags;
        await safeReply(interaction, {
          ephemeral: true,
          content: nonLinked.length > 0
            ? `Only your linked tags are allowed. Non-linked tags rejected: ${nonLinked.join(", ")}`
            : "No valid linked player tags were provided.",
        });
        return;
      }

      const summary = [
        `Created: **${result.result.createdRuleCount}** rule(s)`,
        `Already existed: **${result.result.existingRuleCount}**`,
        `Method: **${formatReminderMethodLabel(method)}**`,
      ].join("\n");

      await interaction.editReply({
        content: summary,
        embeds: [
          buildReminderListEmbed({
            discordUserId: interaction.user.id,
            groups: result.result.groups,
            title: "/remindme set - Applied Rules",
          }),
        ],
      });
      return;
    }

    if (subcommand === "list") {
      const guildId = interaction.guildId;
      if (!guildId) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "This command can only be used in a server.",
        });
        return;
      }
      const activityGroups = await listUserActivityReminderRuleGroups({
        discordUserId: interaction.user.id,
      });
      const recruitmentRows = await listRecruitmentReminderRulesForUser({
        guildId,
        discordUserId: interaction.user.id,
      });
      if (activityGroups.length <= 0 && recruitmentRows.length <= 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "You do not have any active reminders yet.",
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          buildCombinedReminderListEmbed({
            discordUserId: interaction.user.id,
            activityGroups,
            recruitmentRows,
            title: "Your Reminders",
          }),
        ],
      });
      return;
    }

    const guildId = interaction.guildId;
    if (!guildId) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    let activityGroups = await listUserActivityReminderRuleGroups({
      discordUserId: interaction.user.id,
    });
    let recruitmentRows = await listRecruitmentReminderRulesForUser({
      guildId,
      discordUserId: interaction.user.id,
    });
    if (activityGroups.length <= 0 && recruitmentRows.length <= 0) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "You do not have any active reminders to remove.",
      });
      return;
    }

    const selectedGroupKeys = new Set<string>();
    await interaction.editReply({
      content:
        activityGroups.length + recruitmentRows.length > 25
          ? "Only the first 25 grouped reminders are selectable in one remove action."
          : null,
      embeds: [
        buildCombinedReminderListEmbed({
          discordUserId: interaction.user.id,
          activityGroups,
          recruitmentRows,
          title: "Remove Reminders",
        }),
      ],
      components: buildCombinedRemoveComponents({
        activityGroups,
        recruitmentRows,
        selectedGroupKeys,
        interactionId: interaction.id,
      }),
    });

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      time: REMINDME_PANEL_TIMEOUT_MS,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        await component.reply({
          ephemeral: true,
          content: "Only the command requester can use this reminder panel.",
        });
        return;
      }

      const selectId = `remindme:remove:select:${interaction.id}`;
      const confirmId = `remindme:remove:confirm:${interaction.id}`;
      const cancelId = `remindme:remove:cancel:${interaction.id}`;

      if (component.isStringSelectMenu() && component.customId === selectId) {
        selectedGroupKeys.clear();
        for (const value of component.values) {
          if (value !== "none") {
            selectedGroupKeys.add(value);
          }
        }
        await component.update({
          embeds: [
            buildCombinedReminderListEmbed({
              discordUserId: interaction.user.id,
              activityGroups,
              recruitmentRows,
              title: `Remove Reminders (selected ${selectedGroupKeys.size})`,
            }),
          ],
          components: buildCombinedRemoveComponents({
            activityGroups,
            recruitmentRows,
            selectedGroupKeys,
            interactionId: interaction.id,
          }),
        });
        return;
      }

      if (component.isButton() && component.customId === cancelId) {
        await component.update({
          content: "Reminder remove flow cancelled.",
          embeds: [],
          components: [],
        });
        collector.stop("cancelled");
        return;
      }

      if (component.isButton() && component.customId === confirmId) {
        if (selectedGroupKeys.size <= 0) {
          await component.reply({
            ephemeral: true,
            content: "Select at least one reminder group before confirming removal.",
          });
          return;
        }

        const selectedActivityRuleIds = activityGroups
          .filter((group) => selectedGroupKeys.has(`activity|${group.key}`))
          .flatMap((group) => group.ruleIds);
        const selectedRecruitmentRuleIds = recruitmentRows
          .filter((row) => selectedGroupKeys.has(`recruitment|${row.id}`))
          .map((row) => row.id);
        const removedActivityCount = await removeUserActivityReminderRulesByIds({
          discordUserId: interaction.user.id,
          ruleIds: selectedActivityRuleIds,
        });
        const removedRecruitmentCount = await removeRecruitmentReminderRulesByIds({
          guildId,
          discordUserId: interaction.user.id,
          ruleIds: selectedRecruitmentRuleIds,
        });

        activityGroups = await listUserActivityReminderRuleGroups({
          discordUserId: interaction.user.id,
        });
        recruitmentRows = await listRecruitmentReminderRulesForUser({
          guildId,
          discordUserId: interaction.user.id,
        });
        selectedGroupKeys.clear();

        await component.update({
          content:
            activityGroups.length + recruitmentRows.length > 0
              ? `Removed **${removedActivityCount + removedRecruitmentCount}** reminder rule(s).`
              : `Removed **${removedActivityCount + removedRecruitmentCount}** reminder rule(s). No reminders remain.`,
          embeds:
            activityGroups.length + recruitmentRows.length > 0
              ? [
                  buildCombinedReminderListEmbed({
                    discordUserId: interaction.user.id,
                    activityGroups,
                    recruitmentRows,
                    title: "Remove Reminders",
                  }),
                ]
              : [],
          components:
            activityGroups.length + recruitmentRows.length > 0
              ? buildCombinedRemoveComponents({
                  activityGroups,
                  recruitmentRows,
                  selectedGroupKeys,
                  interactionId: interaction.id,
                })
              : [],
        });

        if (activityGroups.length + recruitmentRows.length <= 0) {
          collector.stop("completed_empty");
        }
      }
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "cancelled" || reason === "completed_empty") return;
      try {
        await interaction.editReply({
          components: [],
        });
      } catch {
        // no-op
      }
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "player_tags") {
      await interaction.respond([]);
      return;
    }

    const raw = String(focused.value ?? "");
    const lastComma = raw.lastIndexOf(",");
    const prefix = lastComma >= 0 ? `${raw.slice(0, lastComma + 1).trimEnd()} ` : "";
    const query = lastComma >= 0 ? raw.slice(lastComma + 1) : raw;

    const linkedOptions = await listLinkedPlayerTagOptionsForRemindme({
      discordUserId: interaction.user.id,
      query,
      limit: 25,
    });

    const choices = linkedOptions
      .map((option) => ({
        name: option.name,
        value: `${prefix}${option.value}`.trim(),
      }))
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
