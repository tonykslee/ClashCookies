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
  layoutPostPublicationService,
} from "../services/LayoutPostPublicationService";
import { LayoutService, layoutService } from "../services/LayoutService";
import { isValidImageUrl } from "../services/FwaLayoutService";
import {
  LAYOUT_ALERT_TYPE_CHOICES,
  LayoutAlertConfigService,
  LayoutAlertPolicyValidationError,
  layoutAlertConfigService,
  layoutAlertModeForType,
  parseLayoutAlertType,
  validateLayoutAlertCommandOptions,
} from "../services/LayoutAlertConfigService";
import { BotLogChannelService, botLogChannelService } from "../services/BotLogChannelService";

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export const LAYOUT_COMMAND_OPTIONS = [
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

export type LayoutCommandDeps = {
  layoutService?: Pick<LayoutService, "getOrCreate">;
  publicationService?: LayoutPostPublicationService;
  alertConfigService?: Pick<LayoutAlertConfigService, "setPolicy" | "disablePolicy">;
  botLogChannelService?: Pick<BotLogChannelService, "getChannelIdForType">;
};

/** Purpose: create or reuse one generic tracked layout and publish its canonical public post. */
export async function runLayoutCommand(
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
    const defaultChannelId =
      alertType === "default-channel" || alertType === "both"
        ? await routingService.getChannelIdForType(interaction.guildId ?? "", "layout-alerts")
        : null;
    validateLayoutAlertCommandOptions({
      type: alertType,
      channel: alertChannel,
      guildId: interaction.guildId ?? "",
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

    const layout = await service.getOrCreate({
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
          `Layout posted: [View post](${published.jumpUrl}) Alert configuration failed; expiration alerts are not enabled.`,
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
  description: "Create or reuse a tracked Clash layout post",
  options: [...LAYOUT_COMMAND_OPTIONS],
  suppressVisibilityOption: true,
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => runLayoutCommand(interaction),
};

export const validateLayoutImageAttachmentForTest = validateImageAttachment;
