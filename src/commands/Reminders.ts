import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { ReminderTargetClanType, ReminderType } from "@prisma/client";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { normalizeClanTag } from "../services/PlayerLinkService";
import {
  decodeReminderClanTargetValue,
  formatReminderOffsetSeconds,
  getReminderOffsetPresetSeconds,
  parseReminderOffsetsInputList,
  reminderService,
  type ReminderClanOption,
  type ReminderWithDetails,
} from "../services/reminders/ReminderService";

const PANEL_TIMEOUT_MS = 10 * 60 * 1000;
const REMINDER_CREATE_MODE = "create";
const REMINDER_EDIT_MODE = "edit";

/** Purpose: determine whether reminder type is explicitly selected (exclude internal EVENT placeholder for create drafts). */
function hasSelectedReminderType(type: ReminderType): boolean {
  return type === ReminderType.WAR_CWL || type === ReminderType.RAIDS || type === ReminderType.GAMES;
}

/** Purpose: determine whether reminder channel is a valid Discord channel id for save checks + display. */
function hasSelectedReminderChannel(channelId: string): boolean {
  return /^\d+$/.test(String(channelId ?? "").trim());
}

/** Purpose: send one ephemeral component message safely before or after a deferred component ack. */
async function sendComponentEphemeralMessage(
  component:
    | ButtonInteraction
    | StringSelectMenuInteraction,
  content: string,
): Promise<void> {
  if (component.deferred || component.replied) {
    await component.followUp({
      ephemeral: true,
      content,
    });
    return;
  }
  await component.reply({
    ephemeral: true,
    content,
  });
}

/** Purpose: format reminder offsets for compact human-readable embed/list sections. */
function formatOffsetList(offsetsSeconds: number[]): string {
  if (offsetsSeconds.length <= 0) return "not set";
  return offsetsSeconds.map((offset) => formatReminderOffsetSeconds(offset)).join(", ");
}

/** Purpose: build selected clan lines for preview embeds with safe row limits. */
function buildTargetLines(targets: ReminderWithDetails["targets"]): string[] {
  if (targets.length <= 0) return ["none selected"];
  const lines = targets.slice(0, 20).map((target) => `- ${target.label}`);
  if (targets.length > 20) {
    lines.push(`- ...and ${targets.length - 20} more`);
  }
  return lines;
}

/** Purpose: render the main reminder preview/config embed used by create/edit interaction flows. */
function buildReminderPanelEmbed(input: {
  reminder: ReminderWithDetails;
  mode: "create" | "edit";
}): EmbedBuilder {
  const modeLabel = input.mode === REMINDER_CREATE_MODE ? "Create" : "Edit";
  const typeLabel = hasSelectedReminderType(input.reminder.type)
    ? input.reminder.type
    : "_not set_";
  const channelLabel = hasSelectedReminderChannel(input.reminder.channelId)
    ? `<#${input.reminder.channelId}>`
    : "_not set_";
  return new EmbedBuilder()
    .setTitle(`Reminders - ${modeLabel}`)
    .setColor(input.mode === REMINDER_CREATE_MODE ? 0x5865f2 : 0x57f287)
    .setDescription(
      [
        `Type: ${typeLabel}`,
        `Times: **${formatOffsetList(input.reminder.offsetsSeconds)}**`,
        `Channel: ${channelLabel}`,
        `Enabled: **${input.reminder.isEnabled ? "yes" : "no"}**`,
        "",
        "Selected clans:",
        ...buildTargetLines(input.reminder.targets),
      ].join("\n"),
    )
    .setFooter({
      text: `Reminder ID: ${input.reminder.id}`,
    });
}

/** Purpose: build stable clan-select options while preserving currently selected values in bounded menus. */
function buildClanSelectOptions(
  allOptions: ReminderClanOption[],
  selectedValues: Set<string>,
): Array<{ label: string; value: string; description: string; default?: boolean }> {
  const mapped = allOptions.map((option) => ({
    label: `${option.name ?? option.clanTag} (${option.clanTag})`.slice(0, 100),
    value: option.value,
    description: option.description.slice(0, 100),
    default: selectedValues.has(option.value),
  }));

  const selectedFirst = [
    ...mapped.filter((option) => option.default),
    ...mapped.filter((option) => !option.default),
  ];
  return selectedFirst.slice(0, 25);
}

/** Purpose: render all panel components (clans, offsets, type, actions) for create/edit reminder flows. */
function buildReminderPanelComponents(input: {
  reminder: ReminderWithDetails;
  mode: "create" | "edit";
  clanOptions: ReminderClanOption[];
}): Array<
  ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
> {
  const selectedTargetValues = new Set(
    input.reminder.targets.map((target) => `${target.clanType}|${target.clanTag}`),
  );
  const clanOptions = buildClanSelectOptions(input.clanOptions, selectedTargetValues);
  const clansMenu = new StringSelectMenuBuilder()
    .setCustomId(`reminders:clans:${input.reminder.id}`)
    .setPlaceholder(
      clanOptions.length > 0
        ? "Select target clans (FWA + CWL)"
        : "No tracked clans available",
    )
    .setMinValues(0)
    .setMaxValues(Math.max(1, Math.min(25, clanOptions.length || 1)))
    .setDisabled(clanOptions.length <= 0);
  if (clanOptions.length > 0) {
    clansMenu.addOptions(clanOptions);
  } else {
    clansMenu.addOptions([
      {
        label: "No tracked clans",
        value: "none",
        description: "Configure /tracked-clan first",
      },
    ]);
  }

  const selectedOffsets = new Set(input.reminder.offsetsSeconds.map((offset) => String(offset)));
  const presetOffsets = [
    ...new Set([...getReminderOffsetPresetSeconds(), ...input.reminder.offsetsSeconds]),
  ].sort((a, b) => a - b);
  const offsetsMenu = new StringSelectMenuBuilder()
    .setCustomId(`reminders:offsets:${input.reminder.id}`)
    .setPlaceholder("Select one or more time offsets")
    .setMinValues(1)
    .setMaxValues(Math.max(1, Math.min(10, presetOffsets.length)))
    .addOptions(
      presetOffsets.slice(0, 25).map((offset) => ({
        label: formatReminderOffsetSeconds(offset).slice(0, 100),
        value: String(offset),
        description: `${offset}s`.slice(0, 100),
        default: selectedOffsets.has(String(offset)),
      })),
    );

  const typeMenu = new StringSelectMenuBuilder()
    .setCustomId(`reminders:type:${input.reminder.id}`)
    .setPlaceholder("Select reminder type")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      (["WAR_CWL", "RAIDS", "GAMES"] as ReminderType[]).map((type) => ({
        label: type,
        value: type,
        description: `Reminder type ${type}`.slice(0, 100),
        default: input.reminder.type === type,
      })),
    );

  const primaryButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`reminders:toggle:${input.reminder.id}`)
      .setLabel(input.reminder.isEnabled ? "Disable" : "Enable")
      .setStyle(input.reminder.isEnabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reminders:channel-here:${input.reminder.id}`)
      .setLabel("Set Channel = Here")
      .setStyle(ButtonStyle.Secondary),
  );

  if (input.mode === REMINDER_CREATE_MODE) {
    primaryButtons.addComponents(
      new ButtonBuilder()
        .setCustomId(`reminders:save:${input.reminder.id}`)
        .setLabel("Save")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`reminders:cancel:${input.reminder.id}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );
  } else {
    primaryButtons.addComponents(
      new ButtonBuilder()
        .setCustomId(`reminders:done:${input.reminder.id}`)
        .setLabel("Done")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`reminders:delete:${input.reminder.id}`)
        .setLabel("Delete")
        .setStyle(ButtonStyle.Danger),
    );
  }

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(clansMenu),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(offsetsMenu),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(typeMenu),
    primaryButtons,
  ];
}

/** Purpose: enforce per-panel interaction ownership so only invoking admin can mutate reminder drafts. */
async function guardPanelInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  ownerUserId: string,
): Promise<boolean> {
  if (interaction.user.id === ownerUserId) return true;
  await interaction.reply({
    ephemeral: true,
    content: "Only the command requester can use this reminder panel.",
  });
  return false;
}

/** Purpose: render one reminder panel and handle select/button mutation flows with collector scoping. */
async function openReminderPanel(input: {
  interaction: ChatInputCommandInteraction;
  reminderId: string;
  mode: "create" | "edit";
  ownerUserId: string;
}): Promise<void> {
  let reminder = await reminderService.getReminderWithDetails({
    reminderId: input.reminderId,
    guildId: input.interaction.guildId!,
  });
  let clanOptions = await reminderService.listSelectableClanOptions(input.interaction.guildId!);
  let savedReminder: ReminderWithDetails | null = null;

  await input.interaction.editReply({
    embeds: [buildReminderPanelEmbed({ reminder, mode: input.mode })],
    components: buildReminderPanelComponents({
      reminder,
      mode: input.mode,
      clanOptions,
    }),
  });

  const message = await input.interaction.fetchReply();
  let createSaved = false;
  let createClanAutofillAttemptConsumed = false;
  const collector = message.createMessageComponentCollector({
    time: PANEL_TIMEOUT_MS,
  });

  collector.on("collect", async (component) => {
    const isButton = component.isButton();
    const isSelect = component.isStringSelectMenu();
    if (!isButton && !isSelect) return;
    if (!(await guardPanelInteraction(component, input.ownerUserId))) return;

    try {
      if (isSelect && component.customId === `reminders:clans:${input.reminderId}`) {
        await component.deferUpdate();
        const selectedEncodedValues = component.values.filter((value) => value !== "none");
        await reminderService.replaceReminderTargetsFromEncodedValues({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
          encodedValues: selectedEncodedValues,
          actorUserId: input.ownerUserId,
        });
        if (
          input.mode === REMINDER_CREATE_MODE &&
          !createClanAutofillAttemptConsumed &&
          selectedEncodedValues.length > 0
        ) {
          createClanAutofillAttemptConsumed = true;
          const firstSelectedClan = selectedEncodedValues
            .map((value) => decodeReminderClanTargetValue(value))
            .find(
              (
                decoded,
              ): decoded is {
                clanType: ReminderTargetClanType;
                clanTag: string;
              } => Boolean(decoded),
            );
          if (firstSelectedClan?.clanTag) {
            await reminderService.tryPrefillReminderChannelFromTrackedClanLog({
              reminderId: input.reminderId,
              guildId: input.interaction.guildId!,
              clanTag: firstSelectedClan.clanTag,
              actorUserId: input.ownerUserId,
            });
          }
        }
      } else if (isSelect && component.customId === `reminders:offsets:${input.reminderId}`) {
        await component.deferUpdate();
        const selectedOffsets = component.values
          .map((value) => Math.trunc(Number(value)))
          .filter((value) => Number.isFinite(value) && value > 0);
        if (selectedOffsets.length > 0) {
          await reminderService.replaceReminderOffsets({
            reminderId: input.reminderId,
            guildId: input.interaction.guildId!,
            offsetsSeconds: selectedOffsets,
            actorUserId: input.ownerUserId,
          });
        }
      } else if (isSelect && component.customId === `reminders:type:${input.reminderId}`) {
        await component.deferUpdate();
        const nextType = component.values[0];
        if (
          nextType === ReminderType.WAR_CWL ||
          nextType === ReminderType.RAIDS ||
          nextType === ReminderType.GAMES
        ) {
          await reminderService.setReminderType({
            reminderId: input.reminderId,
            guildId: input.interaction.guildId!,
            type: nextType,
            actorUserId: input.ownerUserId,
          });
        }
      } else if (isButton && component.customId === `reminders:toggle:${input.reminderId}`) {
        await component.deferUpdate();
        reminder = await reminderService.getReminderWithDetails({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
        });
        await reminderService.setReminderEnabled({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
          isEnabled: !reminder.isEnabled,
          actorUserId: input.ownerUserId,
        });
      } else if (isButton && component.customId === `reminders:channel-here:${input.reminderId}`) {
        await component.deferUpdate();
        await reminderService.setReminderChannel({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
          channelId: component.channelId,
          actorUserId: input.ownerUserId,
        });
      } else if (
        isButton &&
        input.mode === REMINDER_CREATE_MODE &&
        component.customId === `reminders:save:${input.reminderId}`
      ) {
        await component.deferUpdate();
        reminder = await reminderService.getReminderWithDetails({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
        });
        if (!hasSelectedReminderType(reminder.type)) {
          await sendComponentEphemeralMessage(
            component,
            "Select a reminder type before saving this reminder.",
          );
          return;
        }
        if (reminder.offsetsSeconds.length <= 0) {
          await sendComponentEphemeralMessage(
            component,
            "Select at least one reminder time before saving this reminder.",
          );
          return;
        }
        if (!hasSelectedReminderChannel(reminder.channelId)) {
          await sendComponentEphemeralMessage(
            component,
            "Set a reminder channel before saving this reminder.",
          );
          return;
        }
        if (reminder.targets.length <= 0) {
          await sendComponentEphemeralMessage(
            component,
            "Select at least one clan before saving this reminder.",
          );
          return;
        }
        savedReminder = await reminderService.saveDraftReminder({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
          actorUserId: input.ownerUserId,
        });
        createSaved = true;
        collector.stop("saved");
      } else if (
        isButton &&
        input.mode === REMINDER_CREATE_MODE &&
        component.customId === `reminders:cancel:${input.reminderId}`
      ) {
        await component.deferUpdate();
        await reminderService.deleteReminder({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
          actorUserId: input.ownerUserId,
        });
        collector.stop("cancelled");
        return;
      } else if (
        isButton &&
        input.mode === REMINDER_EDIT_MODE &&
        component.customId === `reminders:done:${input.reminderId}`
      ) {
        await component.deferUpdate();
        collector.stop("done");
        return;
      } else if (
        isButton &&
        input.mode === REMINDER_EDIT_MODE &&
        component.customId === `reminders:delete:${input.reminderId}`
      ) {
        await component.deferUpdate();
        await reminderService.deleteReminder({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
          actorUserId: input.ownerUserId,
        });
        collector.stop("deleted");
        return;
      } else {
        return;
      }

      reminder = await reminderService.getReminderWithDetails({
        reminderId: input.reminderId,
        guildId: input.interaction.guildId!,
      });
      clanOptions = await reminderService.listSelectableClanOptions(input.interaction.guildId!);
      await input.interaction.editReply({
        embeds: [buildReminderPanelEmbed({ reminder, mode: input.mode })],
        components: buildReminderPanelComponents({
          reminder,
          mode: input.mode,
          clanOptions,
        }),
      });
    } catch (error) {
      const code = formatError(error);
      if (code === "REMINDER_NOT_FOUND") {
        collector.stop("not_found");
        await input.interaction.editReply({
          content: "This reminder no longer exists.",
          embeds: [],
          components: [],
        });
        return;
      }
      console.error(`[reminders] panel interaction failed: ${code}`);
      await sendComponentEphemeralMessage(
        component,
        "Failed to update reminder settings.",
      );
    }
  });

  collector.on("end", async (_collected, reason) => {
    try {
      if (reason === "saved" && createSaved) {
        const finalReminder =
          savedReminder ??
          (await reminderService.getReminderWithDetails({
            reminderId: input.reminderId,
            guildId: input.interaction.guildId!,
          }));
        await input.interaction.editReply({
          content: `Reminder saved (${finalReminder.isEnabled ? "enabled" : "disabled"}): ${finalReminder.id}`,
          embeds: [buildReminderPanelEmbed({ reminder: finalReminder, mode: input.mode })],
          components: [],
        });
        return;
      }
      if (reason === "cancelled") {
        await input.interaction.editReply({
          content: "Reminder draft cancelled.",
          embeds: [],
          components: [],
        });
        return;
      }
      if (reason === "deleted") {
        await input.interaction.editReply({
          content: "Reminder deleted.",
          embeds: [],
          components: [],
        });
        return;
      }
      if (reason === "done") {
        const finalReminder = await reminderService.getReminderWithDetails({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
        });
        await input.interaction.editReply({
          embeds: [buildReminderPanelEmbed({ reminder: finalReminder, mode: input.mode })],
          components: [],
        });
        return;
      }
      if (input.mode === REMINDER_CREATE_MODE && !createSaved) {
        await reminderService.deleteReminder({
          reminderId: input.reminderId,
          guildId: input.interaction.guildId!,
          actorUserId: input.ownerUserId,
        });
        await input.interaction.editReply({
          content: "Reminder draft timed out and was deleted.",
          embeds: [],
          components: [],
        });
        return;
      }
      await input.interaction.editReply({
        components: [],
      });
    } catch {
      // no-op
    }
  });
}

/** Purpose: build concise admin list pages for guild reminder overview command output. */
function buildReminderListPages(rows: Array<{
  id: string;
  type: ReminderType;
  channelId: string;
  isEnabled: boolean;
  offsetsSeconds: number[];
  targetCount: number;
}>): string[] {
  const lines = rows.map((row) =>
    [
      `- \`${row.id.slice(0, 8)}\` **${row.type}**`,
      `  channel: <#${row.channelId}>`,
      `  offsets: ${formatOffsetList(row.offsetsSeconds)}`,
      `  targets: ${row.targetCount}`,
      `  enabled: ${row.isEnabled ? "yes" : "no"}`,
    ].join("\n"),
  );
  if (lines.length <= 0) return [];

  const pages: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n\n${line}` : line;
    if (next.length > 3900) {
      pages.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) pages.push(current);
  return pages;
}

/** Purpose: render one reminder list embed page with consistent metadata/footer. */
function buildReminderListEmbed(total: number, pageText: string, page: number, pages: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Reminders (${total})`)
    .setDescription(pageText)
    .setColor(0x5865f2)
    .setFooter({ text: `Page ${page + 1}/${pages}` });
}

/** Purpose: reuse compact previous/next paginator row pattern for reminder list browsing. */
function buildReminderListRow(prefix: string, page: number, totalPages: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

/** Purpose: compose and register `/reminders` command with create/list/edit admin flows. */
export const Reminders: Command = {
  name: "reminders",
  description: "Manage scheduled reminders for WAR/CWL, raids, and games",
  options: [
    {
      name: "create",
      description: "Create one reminder config",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "type",
          description: "Reminder category",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WAR_CWL", value: ReminderType.WAR_CWL },
            { name: "RAIDS", value: ReminderType.RAIDS },
            { name: "GAMES", value: ReminderType.GAMES },
          ],
        },
        {
          name: "time_left",
          description: "Offset before event end (examples: 1h, 30m, 1h30m)",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "channel",
          description: "Channel to post reminder messages",
          type: ApplicationCommandOptionType.Channel,
          required: false,
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        },
        {
          name: "clan",
          description: "Clan tag to preselect in the create panel (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "list",
      description: "List guild reminder configs",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "edit",
      description: "Edit reminder configs targeting a clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction) => {
    try {
      await interaction.deferReply({ ephemeral: true });
      if (!interaction.guildId) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "This command can only be used in a server.",
        });
        return;
      }
      const subcommand = interaction.options.getSubcommand(true);

      if (subcommand === "create") {
        const typeRaw = interaction.options.getString("type", false);
        const reminderType =
          typeRaw === ReminderType.WAR_CWL ||
          typeRaw === ReminderType.RAIDS ||
          typeRaw === ReminderType.GAMES
            ? typeRaw
            : null;
        const timeLeftInput = interaction.options.getString("time_left", false);
        const seededOffsets =
          timeLeftInput === null ? [] : parseReminderOffsetsInputList(timeLeftInput);
        const channel = interaction.options.getChannel("channel", false);
        const clanInput = interaction.options.getString("clan", false);
        const normalizedSeedClan = clanInput === null ? "" : normalizeClanTag(clanInput);
        let seededClan: ReminderClanOption | null = null;
        if (typeRaw !== null && !reminderType) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid reminder type.",
          });
          return;
        }
        if (timeLeftInput !== null && seededOffsets.length <= 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content:
              "Invalid `time_left`. Use positive `HhMm` input, for example `1h`, `45m`, or `1h30m`.",
          });
          return;
        }
        if (channel && !("id" in channel)) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Reminder channel must be a text-based channel.",
          });
          return;
        }
        if (clanInput !== null && !normalizedSeedClan) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid clan tag format.",
          });
          return;
        }
        if (normalizedSeedClan) {
          seededClan = await reminderService.findSelectableClanOptionByTag({
            guildId: interaction.guildId,
            clanTag: normalizedSeedClan,
          });
          if (!seededClan) {
            await safeReply(interaction, {
              ephemeral: true,
              content: `Clan ${normalizedSeedClan} is not in tracked clans.`,
            });
            return;
          }
        }

        const created = await reminderService.createReminderDraft({
          guildId: interaction.guildId,
          type: reminderType,
          channelId: channel?.id ?? null,
          offsetsSeconds: seededOffsets,
          actorUserId: interaction.user.id,
        });
        if (seededClan) {
          await reminderService.replaceReminderTargetsFromEncodedValues({
            reminderId: created.id,
            guildId: interaction.guildId,
            encodedValues: [seededClan.value],
            actorUserId: interaction.user.id,
          });
          if (!channel?.id) {
            await reminderService.tryPrefillReminderChannelFromTrackedClanLog({
              reminderId: created.id,
              guildId: interaction.guildId,
              clanTag: seededClan.clanTag,
              actorUserId: interaction.user.id,
            });
          }
        }
        await openReminderPanel({
          interaction,
          reminderId: created.id,
          mode: REMINDER_CREATE_MODE,
          ownerUserId: interaction.user.id,
        });
        return;
      }

      if (subcommand === "list") {
        const rows = await reminderService.listReminderSummariesForGuild(interaction.guildId);
        if (rows.length <= 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "No reminder configs found for this server.",
          });
          return;
        }

        const pages = buildReminderListPages(rows);
        let page = 0;
        const prefix = `reminders-list:${interaction.id}`;
        await interaction.editReply({
          embeds: [buildReminderListEmbed(rows.length, pages[page], page, pages.length)],
          components: pages.length > 1 ? [buildReminderListRow(prefix, page, pages.length)] : [],
        });

        if (pages.length <= 1) {
          return;
        }

        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: PANEL_TIMEOUT_MS,
        });
        collector.on("collect", async (button: ButtonInteraction) => {
          if (!(await guardPanelInteraction(button, interaction.user.id))) return;
          if (button.customId !== `${prefix}:prev` && button.customId !== `${prefix}:next`) return;
          if (button.customId.endsWith(":prev")) page = Math.max(0, page - 1);
          if (button.customId.endsWith(":next")) page = Math.min(pages.length - 1, page + 1);
          await button.update({
            embeds: [buildReminderListEmbed(rows.length, pages[page], page, pages.length)],
            components: [buildReminderListRow(prefix, page, pages.length)],
          });
        });
        collector.on("end", async () => {
          try {
            await interaction.editReply({
              embeds: [buildReminderListEmbed(rows.length, pages[page], page, pages.length)],
              components: [],
            });
          } catch {
            // no-op
          }
        });
        return;
      }

      const clanInput = interaction.options.getString("clan", true);
      const normalizedClan = normalizeClanTag(clanInput);
      if (!normalizedClan) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Invalid clan tag format.",
        });
        return;
      }
      const matches = await reminderService.findReminderSummariesByClan({
        guildId: interaction.guildId,
        clanTag: normalizedClan,
      });
      if (matches.length <= 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content: `No reminders found targeting ${normalizedClan}.`,
        });
        return;
      }

      let selectedReminderId = matches[0].id;
      if (matches.length > 1) {
        const select = new StringSelectMenuBuilder()
          .setCustomId(`reminders:pick:${interaction.id}`)
          .setPlaceholder("Select reminder to edit")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            matches.slice(0, 25).map((row) => ({
              label: `${row.type} (${row.id.slice(0, 8)})`.slice(0, 100),
              value: row.id,
              description: `offsets: ${formatOffsetList(row.offsetsSeconds)} | channel: #${row.channelId}`.slice(
                0,
                100,
              ),
            })),
          );
        await interaction.editReply({
          content: `Multiple reminders target ${normalizedClan}. Select one to edit:`,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        });

        const message = await interaction.fetchReply();
        try {
          const picked = await message.awaitMessageComponent({
            componentType: ComponentType.StringSelect,
            time: PANEL_TIMEOUT_MS,
            filter: (itx) =>
              itx.user.id === interaction.user.id &&
              itx.customId === `reminders:pick:${interaction.id}`,
          });
          selectedReminderId = picked.values[0];
          await picked.deferUpdate();
        } catch {
          await interaction.editReply({
            content: "Reminder selection timed out.",
            components: [],
          });
          return;
        }
      }

      await openReminderPanel({
        interaction,
        reminderId: selectedReminderId,
        mode: REMINDER_EDIT_MODE,
        ownerUserId: interaction.user.id,
      });
    } catch (error) {
      console.error(`[reminders] command failed: ${formatError(error)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: "Failed to process reminders command.",
      });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }
    if (!interaction.guildId) {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const options = await reminderService.listSelectableClanOptions(interaction.guildId);
    const uniqueByTag = new Map<
      string,
      { clanTag: string; name: string | null; sources: Set<string> }
    >();
    for (const option of options) {
      const existing = uniqueByTag.get(option.clanTag);
      if (existing) {
        existing.sources.add(option.clanType);
        if (!existing.name && option.name) {
          existing.name = option.name;
        }
        continue;
      }
      uniqueByTag.set(option.clanTag, {
        clanTag: option.clanTag,
        name: option.name,
        sources: new Set([option.clanType]),
      });
    }

    const choices = [...uniqueByTag.values()]
      .map((entry) => {
        const sourceLabel = [...entry.sources].sort().join("+");
        const label = entry.name
          ? `${entry.name} (${entry.clanTag}) [${sourceLabel}]`
          : `${entry.clanTag} [${sourceLabel}]`;
        return {
          name: label.slice(0, 100),
          value: entry.clanTag,
        };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query),
      )
      .slice(0, 25);
    await interaction.respond(choices);
  },
};

/** Purpose: expose command-local parser for tests validating offset input normalization behavior. */
export const parseReminderOffsetsInputListForTest = parseReminderOffsetsInputList;
