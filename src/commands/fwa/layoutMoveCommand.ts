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
  createDiscordLayoutPostResolver,
  layoutPostPublicationService,
} from "../../services/LayoutPostPublicationService";

export const FWA_LAYOUT_MOVE_SUBCOMMAND = {
  name: "layout-move",
  description: "Relocate canonical FWA layout posts to another text channel",
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
      description: "Destination guild text channel",
      type: ApplicationCommandOptionType.Channel,
      required: true,
      channel_types: [ChannelType.GuildText],
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
  ],
} as const;

type FwaLayoutMoveService = Pick<FwaLayoutService, "listCanonical">;
type FwaLayoutMovePublication = Pick<LayoutPostPublicationService, "relocate">;

type FwaLayoutMoveChannel = LayoutPostChannel & {
  guildId?: string | null;
  type?: number;
  permissionsFor?: (member: unknown) => { has: (permission: bigint) => boolean } | null;
};

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
    const layouts = dedupeLayoutsByRecordId(
      rows.filter(
        (row) =>
          row.Type === type &&
          row.Townhall >= minTownhall &&
          row.Townhall <= maxTownhall,
      ),
    );
    const summary = {
      moved: 0,
      skipped: 0,
      failed: 0,
      links: [] as string[],
      cleanupWarnings: 0,
    };

    for (const canonical of layouts) {
      const record = canonical.layoutRecord;
      const layoutId = record?.id ?? canonical.layoutId ?? `TH${canonical.Townhall}`;
      if (!record || !hasCompleteProvenance(record)) {
        summary.skipped += 1;
        logMove("skipped", { guildId, layoutId, reason: "unpublished" });
        continue;
      }
      if (record.discordGuildId !== guildId) {
        summary.failed += 1;
        logMove("failed", { guildId, layoutId, reason: "source_guild_mismatch", oldMessageId: record.discordMessageId });
        continue;
      }
      if (record.discordChannelId === destination.id) {
        summary.skipped += 1;
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
        logMove("failed", {
          guildId,
          layoutId,
          oldMessageId: record.discordMessageId,
          reason: classifyMoveError(error),
        });
      }
    }

    await editPrivate(interaction, formatSummary(summary, type, minTownhall, maxTownhall, destination.id));
  } catch (error) {
    dozzleLog.error(
      `[layout-relocation] event=command_failed guild_id=${guildId} reason=${classifyMoveError(error)}`,
    );
    const detail = error instanceof Error && /target channel|same server|permissions/i.test(error.message)
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
  const selected = interaction.options.getChannel("target-channel", true) as unknown as FwaLayoutMoveChannel;
  const fetched = interaction.guild?.channels?.fetch
    ? await interaction.guild.channels.fetch(selected.id).catch(() => null)
    : null;
  const channel = (fetched ?? selected) as FwaLayoutMoveChannel;
  if (!channel || channel.type !== ChannelType.GuildText || typeof channel.send !== "function") {
    throw new Error("The target channel must be a guild text channel.");
  }
  if (channel.guildId !== interaction.guildId) {
    throw new Error("The target channel must belong to the same server.");
  }
  return channel;
}

function validateDestinationPermissions(
  interaction: ChatInputCommandInteraction,
  channel: FwaLayoutMoveChannel,
): string | null {
  const subject = interaction.guild?.members?.me ?? interaction.client.user;
  const permissions = channel.permissionsFor?.(subject);
  if (!permissions) return "Could not verify the bot's permissions in the target channel.";
  const required: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.AttachFiles, "Attach Files"],
  ];
  const missing = required.filter(([permission]) => !permissions.has(permission)).map(([, label]) => label);
  return missing.length > 0
    ? `The bot is missing target-channel permissions: ${missing.join(", ")}.`
    : null;
}

function formatSummary(
  summary: { moved: number; skipped: number; failed: number; links: string[]; cleanupWarnings: number },
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
  if (summary.cleanupWarnings > 0) {
    lines.push(`Old-post redirect cleanup warnings: ${summary.cleanupWarnings}; the new canonical posts remain active.`);
  }
  if (summary.links.length > 0) {
    lines.push("Moved posts:", ...summary.links);
  }
  const rendered = lines.join("\n");
  if (rendered.length <= 1900) return rendered;
  const movedPostsIndex = lines.indexOf("Moved posts:");
  const header = lines.slice(0, movedPostsIndex + 1).join("\n");
  const visibleLinks: string[] = [];
  let length = header.length;
  for (const link of summary.links) {
    if (length + link.length + 1 > 1840) break;
    visibleLinks.push(link);
    length += link.length + 1;
  }
  const omitted = summary.links.length - visibleLinks.length;
  return `${header}\n${visibleLinks.join("\n")}\n…and ${omitted} destination link(s) omitted from the summary.`;
}

function classifyMoveError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "unknown";
  if (message.includes("permission")) return "permission_denied";
  if (message.includes("not authored")) return "source_not_bot_authored";
  if (message.includes("could not be resolved")) return "source_missing_or_inaccessible";
  if (message.includes("stale") || message.includes("concurrent")) return "cas_conflict";
  if (message.includes("attachment")) return "image_transfer_failed";
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
export const formatFwaLayoutMoveSummaryForTest = formatSummary;
