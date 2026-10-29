import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { dozzleLog } from "../../helper/dozzleLogger";
import {
  FWA_LAYOUT_TYPES,
  FwaCanonicalLayout,
  FwaLayoutService,
  isSupportedTownhall,
  normalizeLayoutType,
  fwaLayoutService,
} from "../../services/FwaLayoutService";
import {
  LayoutPostChannel,
  LayoutPostMessageResolver,
  LayoutPostPublicationService,
  UncertainLayoutRelocationError,
  createDiscordLayoutPostResolver,
  layoutPostPublicationService,
} from "../../services/LayoutPostPublicationService";

export const FWA_LAYOUT_MOVE_SUBCOMMAND = {
  name: "layout-move",
  description: "Relocate canonical FWA layout posts to a text channel or forum post",
  type: ApplicationCommandOptionType.Subcommand,
  options: [
    {
      name: "type",
      description: "One FWA layout type to relocate",
      type: ApplicationCommandOptionType.String,
      required: true,
      choices: FWA_LAYOUT_TYPES.map((type) => ({ name: type, value: type })),
    },
    {
      name: "target-channel",
      description: "Destination text channel or public forum post",
      type: ApplicationCommandOptionType.Channel,
      required: false,
      channel_types: [ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread],
    },
    {
      name: "min-th",
      description: "Minimum Town Hall (default TH8)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      min_value: 8,
      max_value: 18,
    },
    {
      name: "max-th",
      description: "Maximum Town Hall (default TH18)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      min_value: 8,
      max_value: 18,
    },
    {
      name: "order",
      description: "Town Hall posting order (default descending)",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "Ascending", value: "ascending" },
        { name: "Descending", value: "descending" },
      ],
    },
  ],
} as const;

type FwaLayoutMoveService = Pick<FwaLayoutService, "listCanonical">;
type FwaLayoutMovePublication = Pick<LayoutPostPublicationService, "relocate">;

type FwaLayoutMoveChannel = LayoutPostChannel & {
  guildId?: string | null;
  type?: number;
  parentId?: string | null;
  parent?: { id?: string | null; guildId?: string | null; type?: number | null } | null;
  archived?: boolean | null;
  locked?: boolean | null;
  isThread?: () => boolean;
  fetch?: () => Promise<unknown>;
  permissionsFor?: (member: unknown) => { has: (permission: bigint) => boolean } | null;
};

type FwaLayoutMoveOrder = "ascending" | "descending";

type LayoutMoveOutcome = { townhall: number; reason: string };

export type FwaLayoutMoveCommandDeps = {
  layoutService?: FwaLayoutMoveService;
  publicationService?: FwaLayoutMovePublication;
  messageResolver?: LayoutPostMessageResolver;
};

/** Purpose: relocate one bounded FWA type/range sequentially while retaining shared LayoutRecord ownership. */
export async function runFwaLayoutMoveCommand(
  interaction: ChatInputCommandInteraction,
  deps: FwaLayoutMoveCommandDeps = {},
): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyPrivate(interaction, "Only administrators can relocate FWA layouts.");
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await editPrivate(interaction, "FWA layout relocation requires a guild channel.");
    return;
  }

  const type = normalizeLayoutType(interaction.options.getString("type", true));
  const minTownhall = interaction.options.getInteger("min-th", false) ?? 8;
  const maxTownhall = interaction.options.getInteger("max-th", false) ?? 18;
  const requestedOrder = interaction.options.getString("order", false) ?? "descending";
  const order = parseLayoutMoveOrder(requestedOrder);
  if (!order) {
    await editPrivate(interaction, "`order` must be `ascending` or `descending`.");
    return;
  }
  if (!isSupportedTownhall(minTownhall) || !isSupportedTownhall(maxTownhall) || minTownhall > maxTownhall) {
    await editPrivate(interaction, "`min-th` and `max-th` must be an ordered range from TH8 through TH18.");
    return;
  }

  try {
    const destination = await resolveDestinationChannel(interaction);
    const permissionError = validateDestinationPermissions(interaction, destination);
    if (permissionError) {
      await editPrivate(interaction, permissionError);
      return;
    }

    const layoutService = deps.layoutService ?? fwaLayoutService;
    const publicationService = deps.publicationService ?? layoutPostPublicationService;
    const resolver =
      deps.messageResolver ??
      createDiscordLayoutPostResolver(interaction.client, {
        requireBotAuthored: true,
        requireEditable: false,
      });
    const rows = await layoutService.listCanonical({ type });
    const layouts = sortLayoutsByTownhall(
      dedupeLayoutsByRecordId(
        rows.filter(
          (row) =>
            row.Type === type &&
            row.Townhall >= minTownhall &&
            row.Townhall <= maxTownhall,
        ),
      ),
      order,
    );
    const summary = {
      moved: 0,
      skipped: 0,
      failed: 0,
      links: [] as string[],
      cleanupWarnings: 0,
      skippedLayouts: [] as LayoutMoveOutcome[],
      failedLayouts: [] as LayoutMoveOutcome[],
    };

    for (const canonical of layouts) {
      const record = canonical.layoutRecord;
      const layoutId = record?.id ?? canonical.layoutId ?? `TH${canonical.Townhall}`;
      if (!record || !hasCompleteProvenance(record)) {
        summary.skipped += 1;
        summary.skippedLayouts.push({ townhall: canonical.Townhall, reason: "unpublished" });
        logMove("skipped", { guildId, layoutId, reason: "unpublished" });
        continue;
      }
      if (record.discordGuildId !== guildId) {
        summary.failed += 1;
        summary.failedLayouts.push({ townhall: canonical.Townhall, reason: "source_guild_mismatch" });
        logMove("failed", { guildId, layoutId, reason: "source_guild_mismatch", oldMessageId: record.discordMessageId });
        continue;
      }
      if (record.discordChannelId === destination.id) {
        summary.skipped += 1;
        summary.skippedLayouts.push({ townhall: canonical.Townhall, reason: "already_in_destination" });
        logMove("skipped", { guildId, layoutId, reason: "already_in_destination", oldMessageId: record.discordMessageId });
        continue;
      }

      logMove("attempt", {
        guildId,
        layoutId,
        oldMessageId: record.discordMessageId,
        destinationChannelId: destination.id,
      });
      try {
        const result = await publicationService.relocate({
          layout: record,
          guildId,
          channel: destination,
          messageResolver: resolver,
          botUserId: interaction.client.user?.id ?? "",
        });
        summary.moved += 1;
        summary.links.push(`TH${canonical.Townhall} [new post](${result.jumpUrl})`);
        if (result.oldPostCleanupFailed) summary.cleanupWarnings += 1;
        logMove("succeeded", {
          guildId,
          layoutId,
          oldMessageId: record.discordMessageId,
          newMessageId: result.messageId,
          destinationChannelId: destination.id,
          cleanup: result.oldPostCleanupFailed ? "failed" : "succeeded",
        });
      } catch (error) {
        summary.failed += 1;
        summary.failedLayouts.push({ townhall: canonical.Townhall, reason: classifyMoveError(error) });
        logMove("failed", {
          guildId,
          layoutId,
          oldMessageId: record.discordMessageId,
          newMessageId: error instanceof UncertainLayoutRelocationError ? error.newMessageId : undefined,
          destinationChannelId: destination.id,
          reason: classifyMoveError(error),
        });
      }
    }

    await editPrivate(interaction, formatSummary(summary, type, minTownhall, maxTownhall, destination.id));
  } catch (error) {
    dozzleLog.error(
      `[layout-relocation] event=command_failed guild_id=${guildId} reason=${classifyMoveError(error)}`,
    );
    const detail = error instanceof Error && /target[- ]channel|same server|permissions|forum post|guildforum|writable|archived|locked|resolved|inaccessible/i.test(error.message)
      ? error.message
      : "Failed to process `/fwa layout-move`. No canonical ownership was changed by the command setup.";
    await editPrivate(interaction, detail);
  }
}

function dedupeLayoutsByRecordId(rows: readonly FwaCanonicalLayout[]): FwaCanonicalLayout[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = row.layoutRecord?.id ?? row.layoutId;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function hasCompleteProvenance(record: {
  discordGuildId: string | null;
  discordChannelId: string | null;
  discordMessageId: string | null;
}): boolean {
  return Boolean(record.discordGuildId && record.discordChannelId && record.discordMessageId);
}

async function resolveDestinationChannel(
  interaction: ChatInputCommandInteraction,
): Promise<FwaLayoutMoveChannel> {
  const selected = interaction.options.getChannel("target-channel", false) as unknown as FwaLayoutMoveChannel | null;
  const channel = selected
    ? await resolveChannelReference(interaction, selected.id, selected)
    : await resolveInvokingForumThread(interaction);
  return validateDestinationChannel(interaction, channel);
}

function validateDestinationPermissions(
  interaction: ChatInputCommandInteraction,
  channel: FwaLayoutMoveChannel,
): string | null {
  const subject = interaction.guild?.members?.me ?? interaction.client.user;
  let permissions: { has: (permission: bigint) => boolean } | null | undefined;
  try {
    permissions = channel.permissionsFor?.(subject);
  } catch {
    return "Could not verify the bot's permissions in the target channel.";
  }
  if (!permissions) return "Could not verify the bot's permissions in the target channel.";
  const isForumThread = channel.type === ChannelType.PublicThread;
  const required: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [
      isForumThread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
      isForumThread ? "Send Messages in Threads" : "Send Messages",
    ],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.AttachFiles, "Attach Files"],
  ];
  const missing = required.filter(([permission]) => !permissions.has(permission)).map(([, label]) => label);
  return missing.length > 0
    ? `The bot is missing target-channel permissions: ${missing.join(", ")}.`
    : null;
}

/** Purpose: parse the command's explicit order choice while keeping the default safe and deterministic. */
function parseLayoutMoveOrder(value: string): FwaLayoutMoveOrder | null {
  if (value === "ascending" || value === "descending") return value;
  return null;
}

/** Purpose: resolve a command-selected or invocation channel even when it is absent from the guild cache. */
async function resolveChannelReference(
  interaction: ChatInputCommandInteraction,
  channelId: string,
  fallback?: FwaLayoutMoveChannel | null,
): Promise<FwaLayoutMoveChannel> {
  const clientChannels = (interaction.client as unknown as {
    channels?: { fetch?: (id: string) => Promise<unknown> };
  }).channels;
  const fetchedByClient = clientChannels?.fetch
    ? await clientChannels.fetch(channelId).catch(() => null)
    : null;
  if (fetchedByClient) return fetchedByClient as FwaLayoutMoveChannel;
  const fetchedByGuild = interaction.guild?.channels?.fetch
    ? await interaction.guild.channels.fetch(channelId).catch(() => null)
    : null;
  return (fetchedByGuild ?? fallback) as FwaLayoutMoveChannel;
}

/** Purpose: use the invoking public forum post only when target-channel is omitted. */
async function resolveInvokingForumThread(
  interaction: ChatInputCommandInteraction,
): Promise<FwaLayoutMoveChannel> {
  const invokingChannel = (interaction as unknown as { channel?: FwaLayoutMoveChannel | null }).channel;
  const channelId = String((interaction as unknown as { channelId?: string | null }).channelId ?? invokingChannel?.id ?? "").trim();
  const resolved = channelId
    ? await resolveChannelReference(interaction, channelId, invokingChannel)
    : invokingChannel;
  if (resolved?.type !== ChannelType.PublicThread) {
    throw new Error("Omit `target-channel` only when running this command inside a public forum post.");
  }
  return resolved;
}

/** Purpose: reject unsupported parents, cross-guild channels, and non-writable forum posts before listing layouts. */
async function validateDestinationChannel(
  interaction: ChatInputCommandInteraction,
  channel: FwaLayoutMoveChannel,
): Promise<FwaLayoutMoveChannel> {
  if (!channel || typeof channel.id !== "string") {
    throw new Error("The target channel could not be resolved or is inaccessible.");
  }
  if (channel.guildId !== interaction.guildId) {
    throw new Error("The target channel must belong to the same server.");
  }
  if (channel.type === ChannelType.GuildForum) {
    throw new Error("Select an existing public forum post, not its GuildForum parent.");
  }
  if (channel.type === ChannelType.PublicThread) {
    const parentId = String(channel.parentId ?? channel.parent?.id ?? "").trim();
    if (!parentId) {
      throw new Error("The target must be a public thread belonging to a GuildForum parent.");
    }
    const parent = await resolveChannelReference(
      interaction,
      parentId,
      channel.parent as FwaLayoutMoveChannel | null,
    );
    if (!parent || parent.type !== ChannelType.GuildForum) {
      throw new Error("The target must be a public thread belonging to a GuildForum parent.");
    }
    if (parent.guildId !== interaction.guildId) {
      throw new Error("The target forum post must belong to the same server.");
    }
    if (channel.archived === true) {
      throw new Error("The target forum post is archived and cannot receive layout posts.");
    }
    if (channel.locked === true) {
      throw new Error("The target forum post is locked and cannot receive layout posts.");
    }
    if (typeof channel.send !== "function") {
      throw new Error("The target forum post is not writable.");
    }
    return channel;
  }
  if (channel.type !== ChannelType.GuildText || typeof channel.send !== "function") {
    throw new Error("The target must be a guild text channel or a public forum post.");
  }
  return channel;
}

/** Purpose: order only the selected catalog slice without changing FWA catalog service ordering. */
function sortLayoutsByTownhall(
  rows: readonly FwaCanonicalLayout[],
  order: FwaLayoutMoveOrder,
): FwaCanonicalLayout[] {
  return [...rows].sort((left, right) => {
    const townhallDelta = order === "ascending"
      ? left.Townhall - right.Townhall
      : right.Townhall - left.Townhall;
    if (townhallDelta !== 0) return townhallDelta;
    const leftId = left.layoutRecord?.id ?? left.layoutId ?? "";
    const rightId = right.layoutRecord?.id ?? right.layoutId ?? "";
    return leftId.localeCompare(rightId);
  });
}

function formatSummary(
  summary: {
    moved: number;
    skipped: number;
    failed: number;
    links: string[];
    cleanupWarnings: number;
    skippedLayouts?: LayoutMoveOutcome[];
    failedLayouts?: LayoutMoveOutcome[];
  },
  type: string,
  minTownhall: number,
  maxTownhall: number,
  destinationChannelId: string,
): string {
  const lines = [
    `FWA layout relocation (${type}, TH${minTownhall}-TH${maxTownhall}) complete.`,
    `Moved: ${summary.moved} · Skipped: ${summary.skipped} · Failed: ${summary.failed}`,
    `Destination: <#${destinationChannelId}>`,
  ];
  appendOutcomeLines(lines, "Skipped THs", summary.skippedLayouts ?? []);
  appendOutcomeLines(lines, "Failed THs", summary.failedLayouts ?? []);
  if (summary.cleanupWarnings > 0) {
    lines.push(`Old-post redirect cleanup warnings: ${summary.cleanupWarnings}; the new canonical posts remain active.`);
  }
  if (summary.links.length > 0) {
    lines.push("Moved posts:", ...summary.links);
  }
  const rendered = lines.join("\n");
  if (rendered.length <= 1900) return rendered;
  const visibleLines: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > 1850) break;
    visibleLines.push(line);
    length += line.length + 1;
  }
  const omitted = lines.length - visibleLines.length;
  return `${visibleLines.join("\n")}\n…and ${omitted} summary line(s) omitted; rerun with a narrower TH range for details.`;
}

function appendOutcomeLines(lines: string[], label: string, outcomes: LayoutMoveOutcome[]): void {
  if (outcomes.length === 0) return;
  const rendered = outcomes.map((outcome) => `TH${outcome.townhall} (${outcome.reason})`).join(", ");
  lines.push(`${label}: ${rendered}`);
}

function classifyMoveError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "unknown";
  if (message.includes("permission")) return "permission_denied";
  if (message.includes("not authored")) return "source_not_bot_authored";
  if (message.includes("could not be resolved")) return "source_missing_or_inaccessible";
  if (message.includes("not found")) return "layout_record_missing";
  if (message.includes("reconciliation")) return "reconciliation_required";
  if (message.includes("stale") || message.includes("concurrent")) return "cas_conflict";
  if (message.includes("attachment")) return "image_transfer_failed";
  if (message.includes("forum") || message.includes("thread")) return "destination_invalid";
  if (message.includes("guild")) return "guild_mismatch";
  return "relocation_failed";
}

function logMove(
  outcome: "attempt" | "succeeded" | "skipped" | "failed",
  input: {
    guildId: string;
    layoutId: string;
    oldMessageId?: string | null;
    newMessageId?: string;
    destinationChannelId?: string;
    reason?: string;
    cleanup?: string;
  },
): void {
  const line = `[layout-relocation] event=${outcome} guild_id=${input.guildId} layout_id=${input.layoutId} old_message_id=${input.oldMessageId ?? "unknown"} new_message_id=${input.newMessageId ?? "none"} destination_channel_id=${input.destinationChannelId ?? "unknown"} reason=${input.reason ?? "none"} cleanup=${input.cleanup ?? "none"}`;
  if (outcome === "failed") dozzleLog.warn(line);
  else if (outcome === "succeeded") dozzleLog.info(line);
  else dozzleLog.debug(line);
}

async function replyPrivate(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
}

async function editPrivate(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}

export const dedupeFwaLayoutsByRecordIdForTest = dedupeLayoutsByRecordId;
export const sortFwaLayoutsByTownhallForTest = sortLayoutsByTownhall;
export const formatFwaLayoutMoveSummaryForTest = formatSummary;
