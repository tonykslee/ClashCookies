import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import { formatError } from "../helper/formatError";
import {
  InvalidClashLayoutLinkError,
  parseClashLayoutLink,
} from "../services/ClashLayoutLinkService";
import {
  LayoutPostAttachmentSource,
  LayoutPostChannel,
  LayoutPostPublicationService,
  isLayoutAttachmentSizeSupported,
  createDiscordLayoutPostResolver,
  buildDiscordJumpUrl,
  layoutPostPublicationService,
} from "../services/LayoutPostPublicationService";
import {
  ConcurrentLayoutReplacementError,
  DuplicateLayoutLinkError,
  LayoutReplacementKindMismatchError,
  LayoutReplacementTownHallMismatchError,
  LayoutRecordNotFoundError,
  LayoutService,
  layoutService,
} from "../services/LayoutService";
import { isValidImageUrl } from "../services/FwaLayoutService";
import {
  LAYOUT_ALERT_TYPE_CHOICES,
  LayoutAlertConfigService,
  LayoutAlertPolicyValidationError,
  layoutAlertConfigService,
  layoutAlertModeForType,
  parseLayoutAlertType,
  getCompleteLayoutDiscordGuildId,
  resolveLayoutAlertGuildId,
  validateLayoutAlertCommandOptions,
} from "../services/LayoutAlertConfigService";
import { BotLogChannelService, botLogChannelService } from "../services/BotLogChannelService";

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export const LAYOUT_POST_OPTIONS = [
  {
    name: "link",
    description: "Clash layout link",
    type: ApplicationCommandOptionType.String,
    required: true,
  },
  {
    name: "title",
    description: "Optional public layout title",
    type: ApplicationCommandOptionType.String,
    required: false,
  },
  {
    name: "description",
    description: "Optional description shown through Info",
    type: ApplicationCommandOptionType.String,
    required: false,
  },
  {
    name: "image",
    description: "Optional image attachment",
    type: ApplicationCommandOptionType.Attachment,
    required: false,
  },
  {
    name: "img-url",
    description: "Optional public image URL",
    type: ApplicationCommandOptionType.String,
    required: false,
  },
  {
    name: "alert-type",
    description: "Expiration alert policy",
    type: ApplicationCommandOptionType.String,
    required: false,
    choices: LAYOUT_ALERT_TYPE_CHOICES.map((choice) => ({ ...choice })),
  },
  {
    name: "alert-channel",
    description: "Custom expiration alert channel",
    type: ApplicationCommandOptionType.Channel,
    required: false,
    channel_types: [
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
    ],
  },
] as const;

export const LAYOUT_UPDATE_OPTIONS = [
  {
    name: "message-id",
    description: "Original Discord message ID or full message URL",
    type: ApplicationCommandOptionType.String,
    required: true,
  },
  {
    name: "link",
    description: "Replacement Clash layout link",
    type: ApplicationCommandOptionType.String,
    required: true,
  },
] as const;

/** Backward-compatible export for callers that inspect the create/post option set. */
export const LAYOUT_COMMAND_OPTIONS = LAYOUT_POST_OPTIONS;

export type LayoutCommandDeps = {
  layoutService?: Partial<Pick<
    LayoutService,
    "getOrCreate" | "findByLayoutLink" | "findByDiscordMessage" | "replaceLink"
  >>;
  publicationService?: LayoutPostPublicationService;
  alertConfigService?: Pick<LayoutAlertConfigService, "setPolicy" | "disablePolicy">;
  botLogChannelService?: Pick<BotLogChannelService, "getChannelIdForType">;
};

/** Purpose: create or reuse one generic tracked layout and publish its canonical public post. */
async function runLayoutPostCommand(
  interaction: ChatInputCommandInteraction,
  deps: LayoutCommandDeps = {},
): Promise<void> {
  const service = deps.layoutService ?? layoutService;
  const publication = deps.publicationService ?? layoutPostPublicationService;
  const alertService = deps.alertConfigService ?? layoutAlertConfigService;
  const routingService = deps.botLogChannelService ?? botLogChannelService;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyPrivate(interaction, "Only administrators can create or update tracked layouts.");
    return;
  }

  const link = interaction.options.getString("link", false)?.trim() ?? "";
  const title = interaction.options.getString("title", false);
  const description = interaction.options.getString("description", false);
  const imageUrl = interaction.options.getString("img-url", false);
  const attachment = interaction.options.getAttachment("image", false);
  const alertTypeInput = interaction.options.getString("alert-type", false);
  const alertChannel = interaction.options.getChannel("alert-channel", false) as {
    id: string;
    guildId?: string | null;
    type?: number;
  } | null;

  try {
    const alertType = parseLayoutAlertType(alertTypeInput);
    const parsedLink = parseClashLayoutLink(link);
    const existingLayout = alertType
      ? await service.findByLayoutLink!(parsedLink.layoutLink)
      : null;
    const targetAlertGuildId = resolveLayoutAlertGuildId(
      existingLayout,
      interaction.guildId ?? "",
    );
    const defaultChannelId =
      alertType === "default-channel" || alertType === "both"
        ? await routingService.getChannelIdForType(targetAlertGuildId, "layout-alerts")
        : null;
    validateLayoutAlertCommandOptions({
      type: alertType,
      channel: alertChannel,
      guildId: targetAlertGuildId,
      defaultChannelId,
    });
    if (attachment && imageUrl !== null) {
      await replyPrivate(interaction, "Choose either `image` or `img-url`, not both.");
      return;
    }
    if (imageUrl !== null && !isValidImageUrl(imageUrl)) {
      await replyPrivate(interaction, "Invalid image URL. Expected a valid http(s) URL.");
      return;
    }
    const upload = attachment ? validateImageAttachment(attachment) : null;
    if (attachment && !upload) {
      await replyPrivate(interaction, "The `image` attachment must be an image file.");
      return;
    }
    if (upload && !isLayoutAttachmentSizeSupported(upload.size)) {
      await replyPrivate(interaction, "The `image` attachment is too large.");
      return;
    }
    if (!interaction.guildId || !interaction.channelId) {
      await replyPrivate(interaction, "Tracked layout posts require a guild text channel.");
      return;
    }
    const channel = interaction.channel;
    if (!channel || !("send" in channel) || typeof channel.send !== "function") {
      await replyPrivate(interaction, "The invoking channel cannot publish a layout post.");
      return;
    }

    const layout = await service.getOrCreate!({
      layoutLink: parsedLink.layoutLink,
      ...(title !== null ? { title } : {}),
      ...(description !== null ? { description } : {}),
      ...(imageUrl !== null ? { imageUrl } : {}),
      postedByDiscordUserId: interaction.user.id,
    });
    const published = await publication.publish({
      layout,
      guildId: interaction.guildId,
      channel: channel as unknown as LayoutPostChannel,
      messageResolver: createDiscordLayoutPostResolver(interaction.client),
      ...(upload ? { attachment: upload } : {}),
    });
    if (alertType) {
      try {
        const finalAlertGuildId = getCompleteLayoutDiscordGuildId(published.layout);
        if (!finalAlertGuildId) {
          throw new LayoutAlertPolicyValidationError(
            "A canonical Discord layout post is required before enabling expiration alerts.",
          );
        }
        const finalDefaultChannelId =
          alertType === "default-channel" || alertType === "both"
            ? await routingService.getChannelIdForType(finalAlertGuildId, "layout-alerts")
            : null;
        validateLayoutAlertCommandOptions({
          type: alertType,
          channel: alertChannel,
          guildId: finalAlertGuildId,
          defaultChannelId: finalDefaultChannelId,
        });
        if (alertType === "none") {
          await alertService.disablePolicy(published.layout.id);
        } else {
          await alertService.setPolicy({
            layoutId: published.layout.id,
            mode: layoutAlertModeForType(alertType),
            customChannelId: alertType === "custom-channel" ? alertChannel?.id : null,
          });
        }
      } catch (error) {
        console.error(
          `[layout] event=alert_policy_failed guild_id=${interaction.guildId ?? "dm"} layout_id=${published.layout.id} error=${formatError(error)}`,
        );
        await replyPrivate(
          interaction,
          `Layout posted: [View post](${published.jumpUrl}) Alert configuration failed; the layout was saved, but the alert policy could not be updated.`,
        );
        return;
      }
    }
    await replyPrivate(interaction, `Layout posted: [View post](${published.jumpUrl})`);
  } catch (error) {
    console.error(
      `[layout] event=command_failed guild_id=${interaction.guildId ?? "dm"} user_id=${interaction.user.id} error=${formatError(error)}`,
    );
    if (error instanceof InvalidClashLayoutLinkError) {
      await replyPrivate(interaction, "Invalid Clash layout link.");
      return;
    }
    if (error instanceof LayoutAlertPolicyValidationError) {
      await replyPrivate(interaction, error.message);
      return;
    }
    await replyPrivate(interaction, "Failed to process `/layout`. Please try again shortly.");
  }
}

type DiscordMessageReference = {
  guildId: string;
  channelId?: string;
  messageId: string;
  isFullUrl: boolean;
};

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

class LayoutUpdateInputError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "LayoutUpdateInputError";
  }
}

/** Purpose: route the structured /layout subcommands without changing the existing post flow. */
export async function runLayoutCommand(
  interaction: ChatInputCommandInteraction,
  deps: LayoutCommandDeps = {},
): Promise<void> {
  let subcommand = "post";
  try {
    subcommand = interaction.options.getSubcommand(false) ?? "post";
  } catch {
    // Unit callers and legacy direct invocations have no subcommand accessor; treat them as /layout post.
  }
  if (subcommand === "update") {
    await runLayoutUpdateCommand(interaction, deps);
    return;
  }
  await runLayoutPostCommand(interaction, deps);
}

/** Purpose: replace the link behind one existing bot-authored canonical post without publishing a second message. */
export async function runLayoutUpdateCommand(
  interaction: ChatInputCommandInteraction,
  deps: LayoutCommandDeps = {},
): Promise<void> {
  const service = deps.layoutService ?? layoutService;
  const publication = deps.publicationService ?? layoutPostPublicationService;
  const guildId = interaction.guildId ?? "";
  const logContext = {
    guildId: guildId || "DM",
    channelId: interaction.channelId ?? "unknown",
  };

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyPrivate(interaction, "Only administrators can update tracked layouts.");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  if (!guildId) {
    await replyUpdate(interaction, "Layout updates require a guild channel.");
    return;
  }
  let reference: DiscordMessageReference | null = null;
  let layoutId = "unknown";
  let outcome = "failure";
  let reason = "command_failure";
  try {
    const rawReference = interaction.options.getString("message-id", true)?.trim() ?? "";
    const replacementRaw = interaction.options.getString("link", true)?.trim() ?? "";
    reference = parseDiscordMessageReference(rawReference, guildId);
    const replacement = parseClashLayoutLink(replacementRaw);
    if (!service.findByDiscordMessage || !service.findByLayoutLink || !service.replaceLink) {
      throw new Error("The layout update dependencies are incomplete.");
    }

    const layout = await service.findByDiscordMessage({
      guildId,
      ...(reference.channelId ? { channelId: reference.channelId } : {}),
      messageId: reference.messageId,
    });
    if (!layout) {
      if (reference.channelId) {
        const sameMessageDifferentChannel = await service.findByDiscordMessage({
          guildId,
          messageId: reference.messageId,
        });
        if (sameMessageDifferentChannel) {
          throw new LayoutUpdateInputError(
            "wrong_channel",
            "The Discord message URL does not match the canonical layout post channel.",
          );
        }
      }
      throw new LayoutUpdateInputError(
        "missing_post",
        "The original layout post could not be found in this server.",
      );
    }
    layoutId = layout.id;
    if (
      !layout.discordGuildId ||
      !layout.discordChannelId ||
      !layout.discordMessageId ||
      layout.discordGuildId !== guildId ||
      layout.discordMessageId !== reference.messageId ||
      (reference.channelId !== undefined && layout.discordChannelId !== reference.channelId)
    ) {
      throw new LayoutUpdateInputError("wrong_channel", "The Discord message reference does not match the canonical layout post.");
    }

    const current = parseClashLayoutLink(layout.layoutLink);
    if (current.townHall !== replacement.townHall) {
      throw new LayoutUpdateInputError("townhall_mismatch", "The replacement link must use the same Town Hall.");
    }
    if (current.layoutKind !== replacement.layoutKind) {
      throw new LayoutUpdateInputError("layout_kind_mismatch", "The replacement link must use the same layout kind.");
    }

    const resolver = createDiscordLayoutPostResolver(interaction.client);
    const message = await resolver.resolve({
      guildId,
      channelId: layout.discordChannelId,
      messageId: layout.discordMessageId,
    });
    if (!message) {
      throw new LayoutUpdateInputError("missing_post", "The original layout post could not be fetched or edited.");
    }
    const botUserId = interaction.client.user?.id;
    if (!botUserId || message.author?.id !== botUserId) {
      throw new LayoutUpdateInputError("non_bot_post", "The original layout post was not authored by this bot.");
    }
    if (message.editable === false) {
      throw new LayoutUpdateInputError("not_editable", "The original layout post is not editable by this bot.");
    }

    if (current.layoutId === replacement.layoutId) {
      outcome = "success";
      reason = "unchanged_layout_id";
      await replyUpdate(interaction, `Layout link unchanged: [View original post](${buildDiscordJumpUrl(layout.discordGuildId, layout.discordChannelId, layout.discordMessageId)})`);
      return;
    }

    const duplicate = await service.findByLayoutLink(replacement.layoutLink);
    if (duplicate && duplicate.id !== layout.id) {
      throw new DuplicateLayoutLinkError(replacement.layoutLink);
    }

    await publication.collapseBeforeLinkReplacement({ layout, message });
    const updated = await service.replaceLink({
      id: layout.id,
      expectedOldLayoutLink: layout.layoutLink,
      replacementLink: replacement.layoutLink,
    });
    outcome = "success";
    reason = "replaced";
    await replyUpdate(interaction, `Layout link updated: [View original post](${buildDiscordJumpUrl(updated.discordGuildId!, updated.discordChannelId!, updated.discordMessageId!)})`);
  } catch (error) {
    if (error instanceof LayoutUpdateInputError) {
      reason = error.reason;
      await replyUpdate(interaction, error.message);
    } else if (error instanceof DuplicateLayoutLinkError) {
      reason = "duplicate_link";
      await replyUpdate(interaction, "That replacement layout link is already owned by another tracked layout.");
    } else if (error instanceof ConcurrentLayoutReplacementError) {
      reason = "concurrent_update";
      await replyUpdate(interaction, "The layout was updated concurrently. No link was overwritten; please retry with the current post.");
    } else if (error instanceof LayoutRecordNotFoundError) {
      reason = "missing_record";
      await replyUpdate(interaction, "The original tracked layout no longer exists.");
    } else if (error instanceof LayoutReplacementTownHallMismatchError) {
      reason = "townhall_mismatch";
      await replyUpdate(interaction, "The replacement link must use the same Town Hall.");
    } else if (error instanceof LayoutReplacementKindMismatchError) {
      reason = "layout_kind_mismatch";
      await replyUpdate(interaction, "The replacement link must use the same layout kind.");
    } else if (error instanceof InvalidClashLayoutLinkError) {
      reason = "invalid_link";
      await replyUpdate(interaction, "Invalid Clash layout link.");
    } else {
      reason = "update_failed";
      await replyUpdate(interaction, "Layout update failed; the existing link remains authoritative. Please try again shortly.");
    }
  } finally {
    console.info(
      `[layout-update] event=completed outcome=${outcome} reason=${reason} layout_id=${layoutId} guild_id=${logContext.guildId} channel_id=${logContext.channelId} message_id=${reference?.messageId ?? "unknown"}`,
    );
  }
}

function parseDiscordMessageReference(raw: string, invokingGuildId: string): DiscordMessageReference {
  if (DISCORD_SNOWFLAKE.test(raw)) {
    return { guildId: invokingGuildId, messageId: raw, isFullUrl: false };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LayoutUpdateInputError("invalid_message_reference", "Invalid Discord message ID or URL.");
  }
  if (
    url.protocol !== "https:" ||
    !["discord.com", "discordapp.com"].includes(url.hostname) ||
    url.search ||
    url.hash
  ) {
    throw new LayoutUpdateInputError("invalid_message_reference", "Invalid Discord message ID or URL.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "channels") {
    throw new LayoutUpdateInputError("invalid_message_reference", "Invalid Discord message ID or URL.");
  }
  const [_, guildId, channelId, messageId] = parts;
  if (!DISCORD_SNOWFLAKE.test(guildId) || !DISCORD_SNOWFLAKE.test(channelId) || !DISCORD_SNOWFLAKE.test(messageId)) {
    throw new LayoutUpdateInputError("invalid_message_reference", "Invalid Discord message ID or URL.");
  }
  if (guildId !== invokingGuildId) {
    throw new LayoutUpdateInputError("wrong_guild", "The Discord message URL must point to this server.");
  }
  return { guildId, channelId, messageId, isFullUrl: true };
}

async function replyUpdate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && typeof interaction.editReply === "function") {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }
  await replyPrivate(interaction, content);
}

function validateImageAttachment(attachment: {
  url?: string | null;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
}): LayoutPostAttachmentSource | null {
  const contentType = attachment.contentType?.trim().toLowerCase() ?? "";
  const filename = attachment.name?.trim() ?? "";
  const extension = filename.includes(".")
    ? `.${filename.split(".").pop()!.toLowerCase()}`
    : "";
  if (contentType && !contentType.startsWith("image/")) return null;
  if (!contentType && !IMAGE_EXTENSIONS.has(extension)) return null;
  if (!attachment.url?.trim()) return null;
  return {
    url: attachment.url,
    filename,
    contentType: contentType || null,
    size: attachment.size,
  };
}

/** Purpose: keep every command acknowledgement private and suppress raw layout-link output. */
async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
}

export const Layout: Command = {
  name: "layout",
  description: "Create or update a tracked Clash layout post",
  options: [
    {
      name: "post",
      description: "Create or reuse a tracked Clash layout post",
      type: ApplicationCommandOptionType.Subcommand,
      options: [...LAYOUT_POST_OPTIONS],
    },
    {
      name: "update",
      description: "Replace the link in an existing tracked layout post",
      type: ApplicationCommandOptionType.Subcommand,
      options: [...LAYOUT_UPDATE_OPTIONS],
    },
  ],
  suppressVisibilityOption: true,
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => runLayoutCommand(interaction),
};

export const validateLayoutImageAttachmentForTest = validateImageAttachment;
