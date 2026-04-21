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
import { normalizeClanTag, normalizePlayerTag } from "../services/PlayerLinkService";
import { autocompleteSyncTimeZones, normalizeSyncTimeZone } from "../services/syncTimeZone";
import {
  ROSTER_LIFECYCLE_STATE,
  rosterService,
  type RosterRecord,
  type RosterSummaryRecord,
} from "../services/RosterService";
import { autocompleteCwlTrackedClan } from "./Cwl";

export {
  handleRosterSignupButtonInteraction,
  handleRosterRemoveButtonInteraction,
  handleRosterSelectionMenuInteraction,
  handleRosterSelectionActionButtonInteraction,
} from "./Cwl";

type RosterMutationAction = "add" | "move" | "remove" | "open" | "close" | "archive";

function parseRosterPlayerTags(input: string): string[] {
  return [
    ...new Set(
      String(input ?? "")
        .split(/[\s,]+/g)
        .map((token) => normalizePlayerTag(token))
        .filter(Boolean),
    ),
  ];
}

function buildRosterStateLabel(state: RosterRecord["lifecycleState"]): string {
  if (state === ROSTER_LIFECYCLE_STATE.ACTIVE) return "Active";
  if (state === ROSTER_LIFECYCLE_STATE.CLOSED) return "Closed";
  if (state === ROSTER_LIFECYCLE_STATE.ARCHIVED) return "Archived";
  return "Open";
}

function buildRosterLifecycleSummary(roster: RosterRecord, lifecycleState: RosterRecord["lifecycleState"]): string {
  const label =
    lifecycleState === ROSTER_LIFECYCLE_STATE.OPEN
      ? "opened"
      : lifecycleState === ROSTER_LIFECYCLE_STATE.CLOSED
        ? "closed"
        : "archived";
  return `${roster.title} was ${label}.`;
}

function buildRosterSignupResultSummary(result: Awaited<ReturnType<typeof rosterService.addRosterSignupsForManager>>): string {
  if (result.outcome === "roster_not_found") {
    return "That roster is no longer available.";
  }
  if (result.outcome === "roster_archived") {
    return "That roster is archived and can no longer be modified.";
  }
  if (result.outcome === "group_not_found") {
    return "That roster group is no longer available.";
  }
  if (result.outcome === "no_linked_accounts") {
    return "No linked player accounts were found for those player tags.";
  }
  if (result.outcome === "already_signed_up" && result.createdTags.length <= 0) {
    return result.linkedTags.length > 0
      ? `Those linked accounts were already signed up for ${result.groupName}.`
      : "No linked player accounts were available for signup.";
  }

  const created = result.createdTags.length > 0 ? result.createdTags.join(", ") : "no accounts";
  const duplicateNote =
    result.duplicateTags.length > 0
      ? ` (${result.duplicateTags.length} already signed up)`
      : "";
  return `Signed up ${created} to ${result.groupName}${duplicateNote}.`;
}

function buildRosterMoveResultSummary(result: Awaited<ReturnType<typeof rosterService.moveRosterSignups>>): string {
  if (result.outcome === "roster_not_found") {
    return "That roster is no longer available.";
  }
  if (result.outcome === "roster_archived") {
    return "That roster is archived and can no longer be modified.";
  }
  if (result.outcome === "group_not_found") {
    return "That roster group is no longer available.";
  }
  if (result.outcome === "nothing_moved" && result.movedTags.length <= 0) {
    return result.missingTags.length > 0
      ? "None of the selected signups were found on that roster."
      : "No roster signups were moved.";
  }

  const moved = result.movedTags.length > 0 ? result.movedTags.join(", ") : "no signups";
  const duplicate =
    result.duplicateTags.length > 0 ? ` (${result.duplicateTags.length} already in ${result.groupKey})` : "";
  const missing =
    result.missingTags.length > 0 ? ` (${result.missingTags.length} not found on that roster)` : "";
  return `Moved ${moved} to ${result.groupKey}${duplicate}${missing}.`;
}

function buildRosterRemoveResultSummary(
  result: Awaited<ReturnType<typeof rosterService.removeRosterSignupsAsManager>>,
): string {
  if (result.outcome === "roster_not_found") {
    return "That roster is no longer available.";
  }
  if (result.outcome === "roster_archived") {
    return "That roster is archived and can no longer be modified.";
  }
  if (result.outcome === "nothing_removed" && result.removedTags.length <= 0) {
    return result.notOwnedTags.length > 0
      ? "None of the selected signups were found on that roster."
      : "No roster signups were removed.";
  }

  const removed = result.removedTags.length > 0 ? result.removedTags.join(", ") : "no signups";
  const ignored =
    result.notOwnedTags.length > 0
      ? ` (${result.notOwnedTags.length} not found on that roster)`
      : "";
  return `Removed ${removed}${ignored}.`;
}

function buildRosterListEmbed(rosters: RosterSummaryRecord[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("Guild Rosters")
    .setDescription(
      rosters.length > 0
        ? "Select a roster in `/roster post`, `/roster manage`, `/roster edit`, or `/roster delete`."
        : "No rosters have been created in this guild yet.",
    );

  for (const roster of rosters.slice(0, 25)) {
    embed.addFields({
      name: roster.title.slice(0, 100),
      value: [
        `Type: ${roster.rosterType}${roster.rosterCategory ? ` / ${roster.rosterCategory}` : ""}`,
        `Clan: ${roster.clanTag ?? "none"}`,
        `State: ${buildRosterStateLabel(roster.lifecycleState)}`,
        `Posted: ${roster.postedMessageId ? `yes${roster.postedChannelId ? ` in <#${roster.postedChannelId}>` : ""}` : "no"}`,
        `Groups: ${roster.groupCount} | Signups: ${roster.signupCount}`,
        `ID: \`${roster.id}\``,
      ].join("\n"),
      inline: false,
    });
  }

  if (rosters.length > 25) {
    embed.setFooter({ text: `Showing first 25 of ${rosters.length} rosters.` });
  }

  return embed;
}

function buildRosterReadinessEmbed(title: string, body: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`${title} roster readiness`)
    .setDescription(body);
}

async function refreshExistingRosterPost(
  interaction: ChatInputCommandInteraction,
  rosterId: string,
): Promise<boolean> {
  const rosterView = await rosterService.getRosterView(rosterId);
  if (!rosterView?.roster.postedChannelId || !rosterView.roster.postedMessageId) {
    return false;
  }

  const payload = await rosterService.buildRosterSignupPayload(rosterId);
  if (!payload) {
    return false;
  }

  const channel = await interaction.client.channels.fetch(rosterView.roster.postedChannelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) {
    return false;
  }

  const message = await channel.messages.fetch(rosterView.roster.postedMessageId).catch(() => null);
  if (!message) {
    return false;
  }

  await message.edit({
    embeds: [payload.embed],
    components: payload.components,
  });
  return true;
}

async function postRosterSignupMessage(
  interaction: ChatInputCommandInteraction,
  rosterId: string,
): Promise<"posted" | "refreshed" | "no_payload" | "no_channel" | "failed"> {
  const rosterView = await rosterService.getRosterView(rosterId);
  if (!rosterView) {
    return "failed";
  }

  const payload = await rosterService.buildRosterSignupPayload(rosterId);
  if (!payload) {
    return "no_payload";
  }

  if (rosterView.roster.postedChannelId && rosterView.roster.postedMessageId) {
    const refreshed = await refreshExistingRosterPost(interaction, rosterId);
    if (refreshed) {
      return "refreshed";
    }
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) {
    return "no_channel";
  }

  const postedMessage = await channel
    .send({
      embeds: [payload.embed],
      components: payload.components,
    })
    .catch((err) => {
      console.error(`[roster] post_failed error=${formatError(err)}`);
      return null;
    });
  if (!postedMessage) {
    return "failed";
  }

  await rosterService.recordRosterPostedMessage({
    rosterId,
    channelId: postedMessage.channelId,
    messageId: postedMessage.id,
    messageUrl: postedMessage.url,
    postedByDiscordUserId: interaction.user.id,
  });
  return "posted";
}

async function deletePostedRosterMessage(
  interaction: ChatInputCommandInteraction,
  roster: RosterRecord,
): Promise<boolean> {
  if (!roster.postedChannelId || !roster.postedMessageId) {
    return true;
  }

  const channel = await interaction.client.channels.fetch(roster.postedChannelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) {
    return false;
  }

  const message = await channel.messages.fetch(roster.postedMessageId).catch(() => null);
  if (!message) {
    return false;
  }

  try {
    await message.delete();
    return true;
  } catch {
    return false;
  }
}

async function resolveRosterForGuild(
  interaction: ChatInputCommandInteraction,
  rosterId: string,
): Promise<RosterRecord | null> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return null;
  }

  const roster = await rosterService.findGuildRosterById({
    guildId: interaction.guildId,
    rosterId,
  });
  if (!roster) {
    await interaction.editReply("That roster is no longer available.");
    return null;
  }
  return roster;
}

async function handleRosterCreateSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  if (!clanTag) {
    await interaction.editReply("Use a valid tracked CWL clan tag.");
    return;
  }

  const timezoneSeed = interaction.options.getString("timezone", false);
  const timezone = timezoneSeed ? normalizeSyncTimeZone(timezoneSeed) : "UTC";
  if (timezoneSeed && !timezone) {
    await interaction.editReply(
      "Invalid timezone. Use a valid IANA timezone like America/New_York, or a supported US alias like EST, EDT, PST, or PDT.",
    );
    return;
  }

  const season = resolveCurrentCwlSeasonKey();
  const trackedClan = await prisma.cwlTrackedClan.findFirst({
    where: {
      season,
      tag: clanTag,
    },
    select: {
      tag: true,
      name: true,
    },
  });
  if (!trackedClan) {
    await interaction.editReply(`No tracked CWL clan found for ${clanTag} in ${season}.`);
    return;
  }

  const roster = await rosterService.createRoster({
    guildId: interaction.guildId,
    rosterType: "CWL",
    rosterCategory: "signup",
    title: `${trackedClan.name?.trim() || trackedClan.tag} CWL Signup (${season})`,
    clanTag: trackedClan.tag,
    startsAt: new Date(),
    timezone,
    displayTimezone: timezone,
    lifecycleState: ROSTER_LIFECYCLE_STATE.OPEN,
    createdByDiscordUserId: interaction.user.id,
    updatedByDiscordUserId: interaction.user.id,
  });

  await interaction.editReply(
    `Created CWL signup roster for ${trackedClan.name?.trim() || trackedClan.tag}. Use /roster post roster:${roster.id} to publish it.`,
  );
}

async function handleRosterListSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const rosters = await rosterService.listGuildRosters({
    guildId: interaction.guildId,
  });
  await interaction.editReply({
    embeds: [buildRosterListEmbed(rosters)],
  });
}

async function handleRosterPostSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const rosterId = interaction.options.getString("roster", true);
  const roster = await resolveRosterForGuild(interaction, rosterId);
  if (!roster) {
    return;
  }

  const result = await postRosterSignupMessage(interaction, roster.id);
  if (result === "no_channel") {
    await interaction.editReply("This command can only post to a text channel.");
    return;
  }
  if (result === "no_payload") {
    await interaction.editReply("Failed to build that roster post.");
    return;
  }
  if (result === "failed") {
    await interaction.editReply("Failed to post that roster.");
    return;
  }

  await interaction.editReply(
    result === "posted"
      ? `Posted roster ${roster.title} in the current channel.`
      : `Refreshed roster ${roster.title}.`,
  );
}

async function handleRosterReportSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const reportText = await rosterService.buildRosterManagerReadinessText({ rosterId: roster.id });
  if (!reportText) {
    await interaction.editReply("Failed to build the roster readiness report.");
    return;
  }

  await interaction.editReply({
    embeds: [buildRosterReadinessEmbed(roster.title, reportText)],
  });
}

async function handleRosterReadinessSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await handleRosterReportSubcommand(interaction);
}

async function handleRosterRefreshSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const refreshed = await refreshExistingRosterPost(interaction, roster.id);
  if (!refreshed) {
    await interaction.editReply("That roster has not been posted yet.");
    return;
  }

  await interaction.editReply(`Refreshed the posted roster for ${roster.title}.`);
}

async function handleRosterManageSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const action = interaction.options.getString("action", true) as RosterMutationAction;
  const playersInput = interaction.options.getString("players", false) ?? "";
  const playerTags = parseRosterPlayerTags(playersInput);

  if (action === "open" || action === "close" || action === "archive") {
    const lifecycleState =
      action === "open"
        ? ROSTER_LIFECYCLE_STATE.OPEN
        : action === "close"
          ? ROSTER_LIFECYCLE_STATE.CLOSED
          : ROSTER_LIFECYCLE_STATE.ARCHIVED;
    const result = await rosterService.updateRosterLifecycleState({
      rosterId: roster.id,
      lifecycleState,
      updatedByDiscordUserId: interaction.user.id,
    });
    if (result.outcome === "roster_not_found") {
      await interaction.editReply("That roster is no longer available.");
      return;
    }
    await refreshExistingRosterPost(interaction, roster.id).catch(() => undefined);
    await interaction.editReply(buildRosterLifecycleSummary(roster, lifecycleState));
    return;
  }

  if (playerTags.length <= 0) {
    await interaction.editReply("Provide one or more player tags to update.");
    return;
  }

  if (action === "add" || action === "move") {
    const groupKey = interaction.options.getString("group", false);
    if (!groupKey) {
      await interaction.editReply("Provide a roster group for this action.");
      return;
    }

    if (action === "add") {
      const result = await rosterService.addRosterSignupsForManager({
        rosterId: roster.id,
        groupKey,
        playerTags,
        updatedByDiscordUserId: interaction.user.id,
      });
      await refreshExistingRosterPost(interaction, roster.id).catch(() => undefined);
      await interaction.editReply(buildRosterSignupResultSummary(result));
      return;
    }

    const result = await rosterService.moveRosterSignups({
      rosterId: roster.id,
      groupKey,
      playerTags,
      updatedByDiscordUserId: interaction.user.id,
    });
    if (result.outcome === "group_not_found") {
      await interaction.editReply("That roster group is no longer available.");
      return;
    }
    await refreshExistingRosterPost(interaction, roster.id).catch(() => undefined);
    await interaction.editReply(buildRosterMoveResultSummary(result));
    return;
  }

  if (action === "remove") {
    const result = await rosterService.removeRosterSignupsAsManager({
      rosterId: roster.id,
      playerTags,
      updatedByDiscordUserId: interaction.user.id,
    });
    await refreshExistingRosterPost(interaction, roster.id).catch(() => undefined);
    await interaction.editReply(buildRosterRemoveResultSummary(result));
    return;
  }

  await interaction.editReply("Unsupported roster manage action.");
}

async function handleRosterEditSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const title = interaction.options.getString("title", false);
  const clanSeed = interaction.options.getString("clan", false);
  const timezoneSeed = interaction.options.getString("timezone", false);
  const displayTimezoneSeed = interaction.options.getString("display-timezone", false);

  if (!title && !clanSeed && !timezoneSeed && !displayTimezoneSeed) {
    await interaction.editReply("Provide at least one roster field to edit.");
    return;
  }

  if (clanSeed) {
    const normalizedClan = normalizeClanTag(clanSeed);
    if (!normalizedClan) {
      await interaction.editReply("Use a valid tracked CWL clan tag.");
      return;
    }

    const season = resolveCurrentCwlSeasonKey();
    const trackedClan = await prisma.cwlTrackedClan.findFirst({
      where: {
        season,
        tag: normalizedClan,
      },
      select: {
        tag: true,
      },
    });
    if (!trackedClan) {
      await interaction.editReply(`No tracked CWL clan found for ${normalizedClan} in ${season}.`);
      return;
    }
  }

  const timezone = timezoneSeed ? normalizeSyncTimeZone(timezoneSeed) : null;
  if (timezoneSeed && !timezone) {
    await interaction.editReply(
      "Invalid timezone. Use a valid IANA timezone like America/New_York, or a supported US alias like EST, EDT, PST, or PDT.",
    );
    return;
  }
  const displayTimezone = displayTimezoneSeed
    ? normalizeSyncTimeZone(displayTimezoneSeed)
    : null;
  if (displayTimezoneSeed && !displayTimezone) {
    await interaction.editReply(
      "Invalid display timezone. Use a valid IANA timezone like America/New_York, or a supported US alias like EST, EDT, PST, or PDT.",
    );
    return;
  }

  const updated = await rosterService.updateRoster({
    rosterId: roster.id,
    title: title ?? undefined,
    clanTag: clanSeed ?? undefined,
    timezone: timezone ?? undefined,
    displayTimezone: displayTimezone ?? undefined,
    updatedByDiscordUserId: interaction.user.id,
  });
  if (!updated) {
    await interaction.editReply("That roster is no longer available.");
    return;
  }

  await refreshExistingRosterPost(interaction, roster.id).catch(() => undefined);
  await interaction.editReply(`Updated roster ${updated.title}.`);
}

async function handleRosterDeleteSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const postedMessageDeleted = await deletePostedRosterMessage(interaction, roster);
  if (!postedMessageDeleted) {
    await interaction.editReply(
      "I couldn't remove the posted Discord message, so the roster was left intact. Try the delete again once the message cleanup issue is resolved.",
    );
    return;
  }

  const deleted = await rosterService.deleteRoster({
    rosterId: roster.id,
  });
  if (deleted.outcome === "roster_not_found") {
    await interaction.editReply("That roster is no longer available.");
    return;
  }

  await interaction.editReply(
    deleted.roster.postedMessageId
      ? `Deleted roster ${deleted.roster.title} after removing its posted Discord message and persisted signup data.`
      : `Deleted roster ${deleted.roster.title} and its persisted signup data.`,
  );
}

async function autocompleteRosterOption(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = String(interaction.options.getFocused(true).value ?? "").trim();
  const rosters = await rosterService.listGuildRosters({
    guildId: interaction.guildId,
    query: focused,
  });

  await interaction.respond(
    rosters.slice(0, 25).map((roster) => ({
      name: `${roster.title} • ${roster.clanTag ?? "no clan"} • ${buildRosterStateLabel(roster.lifecycleState)}`.slice(0, 100),
      value: roster.id,
      description: `Type ${roster.rosterType}${roster.rosterCategory ? ` / ${roster.rosterCategory}` : ""} • ${roster.postedMessageId ? "posted" : "unposted"} • ${roster.signupCount} signups`.slice(0, 100),
    })),
  );
}

export const Roster: Command = {
  name: "roster",
  description: "Create, list, post, and manage persisted roster signups",
  options: [
    {
      name: "create",
      description: "Create a CWL signup roster from one tracked CWL clan",
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
          name: "timezone",
          description: "Timezone to show on the roster",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "list",
      description: "List guild rosters and their posting status",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "post",
      description: "Post or refresh the signup message for one roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to post",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "manage",
      description: "Mutate roster signups or lifecycle state",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to manage",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "action",
          description: "Action to perform",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "Add players", value: "add" },
            { name: "Move players", value: "move" },
            { name: "Remove players", value: "remove" },
            { name: "Open roster", value: "open" },
            { name: "Close roster", value: "close" },
            { name: "Archive roster", value: "archive" },
          ],
        },
        {
          name: "group",
          description: "Roster group key",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "players",
          description: "Comma or space separated player tags",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "edit",
      description: "Edit roster metadata",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to edit",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "title",
          description: "Roster title",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "timezone",
          description: "Storage/display timezone",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "display-timezone",
          description: "Display timezone override",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "delete",
      description: "Delete a roster and its persisted signup data",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to delete",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "report",
      description: "Show a manager readiness report for one roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to inspect",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "readiness",
      description: "Show the export-friendly readiness report for one roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to inspect",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "refresh",
      description: "Re-render the posted roster from DB truth",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to refresh",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    try {
      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === "create") {
        await handleRosterCreateSubcommand(interaction);
        return;
      }
      if (subcommand === "list") {
        await handleRosterListSubcommand(interaction);
        return;
      }
      if (subcommand === "post") {
        await handleRosterPostSubcommand(interaction);
        return;
      }
      if (subcommand === "manage") {
        await handleRosterManageSubcommand(interaction);
        return;
      }
      if (subcommand === "edit") {
        await handleRosterEditSubcommand(interaction);
        return;
      }
      if (subcommand === "delete") {
        await handleRosterDeleteSubcommand(interaction);
        return;
      }
      if (subcommand === "report") {
        await handleRosterReportSubcommand(interaction);
        return;
      }
      if (subcommand === "readiness") {
        await handleRosterReadinessSubcommand(interaction);
        return;
      }
      if (subcommand === "refresh") {
        await handleRosterRefreshSubcommand(interaction);
        return;
      }

      await interaction.editReply("Unsupported roster subcommand.");
    } catch (err) {
      console.error(`[roster] command_failed error=${formatError(err)}`);
      await interaction.editReply("Failed to load roster data.");
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "timezone" || focused.name === "display-timezone") {
      await interaction.respond(autocompleteSyncTimeZones(focused.value));
      return;
    }
    if (focused.name === "clan") {
      await autocompleteCwlTrackedClan(interaction);
      return;
    }
    if (focused.name === "roster") {
      await autocompleteRosterOption(interaction);
      return;
    }
    await interaction.respond([]);
  },
};
