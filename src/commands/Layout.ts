import {
  ApplicationCommandOptionType,
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
] as const;

export type LayoutCommandDeps = {
  layoutService?: Pick<LayoutService, "getOrCreate">;
  publicationService?: LayoutPostPublicationService;
};

/** Purpose: create or reuse one generic tracked layout and publish its canonical public post. */
export async function runLayoutCommand(
  interaction: ChatInputCommandInteraction,
  deps: LayoutCommandDeps = {},
): Promise<void> {
  const service = deps.layoutService ?? layoutService;
  const publication = deps.publicationService ?? layoutPostPublicationService;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyPrivate(interaction, "Only administrators can create or update tracked layouts.");
    return;
  }

  const link = interaction.options.getString("link", false)?.trim() ?? "";
  const title = interaction.options.getString("title", false);
  const description = interaction.options.getString("description", false);
  const imageUrl = interaction.options.getString("img-url", false);
  const attachment = interaction.options.getAttachment("image", false);

  try {
    const parsedLink = parseClashLayoutLink(link);
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
    await replyPrivate(interaction, `Layout posted: [View post](${published.jumpUrl})`);
  } catch (error) {
    console.error(
      `[layout] event=command_failed guild_id=${interaction.guildId ?? "dm"} user_id=${interaction.user.id} error=${formatError(error)}`,
    );
    if (error instanceof InvalidClashLayoutLinkError) {
      await replyPrivate(interaction, "Invalid Clash layout link.");
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
