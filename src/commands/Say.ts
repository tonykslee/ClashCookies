import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";

const SAY_MODAL_PREFIX = "say-modal";
const SAY_LONG_TEXT_TYPE = "LONG_TEXT";
const SAY_EMBED_TYPE = "EMBED";
const SAY_TEXT_OPTION = "text";
const SAY_TYPE_OPTION = "type";
const SAY_SHOW_FROM_OPTION = "show-from";
const SAY_LONG_TEXT_INPUT_ID = "say-long-text-body";
const SAY_EMBED_TITLE_INPUT_ID = "say-embed-title";
const SAY_EMBED_BODY_INPUT_ID = "say-embed-body";
const SAY_EMBED_IMAGE_URL_INPUT_ID = "say-embed-image-url";
const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_EMBED_TITLE_LIMIT = 256;
const DISCORD_EMBED_BODY_LIMIT = 4000;
const DISCORD_URL_LIMIT = 512;

type SayType = typeof SAY_LONG_TEXT_TYPE | typeof SAY_EMBED_TYPE;
type SayPayload = { content?: string; embeds?: EmbedBuilder[] };

function normalizeOptionalText(input: string | null | undefined): string | null {
  const normalized = String(input ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function isValidHttpUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function hasAdministratorPermission(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction
): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function buildSayModalCustomId(type: SayType, userId: string, showFrom: boolean): string {
  return `${SAY_MODAL_PREFIX}:${type}:${userId}:${showFrom ? "1" : "0"}`;
}

function parseSayModalCustomId(
  customId: string
): { type: SayType; userId: string; showFrom: boolean } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [prefix, type, userId, showFromValue] = parts;
  if (prefix !== SAY_MODAL_PREFIX) return null;
  if (!userId) return null;
  if (type !== SAY_LONG_TEXT_TYPE && type !== SAY_EMBED_TYPE) return null;
  if (showFromValue !== undefined && showFromValue !== "0" && showFromValue !== "1") {
    return null;
  }
  return {
    type,
    userId,
    showFrom: showFromValue === undefined ? true : showFromValue === "1",
  };
}

function parseSayType(value: string | null): SayType | null {
  if (value === SAY_LONG_TEXT_TYPE || value === SAY_EMBED_TYPE) {
    return value;
  }
  return null;
}

async function sendToChannel(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  payload: SayPayload
): Promise<{ ok: true } | { ok: false; message: string }> {
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) {
    return {
      ok: false,
      message: "This command can only post in text channels.",
    };
  }

  try {
    await channel.send(payload);
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "Failed to post in this channel. Check bot permissions and retry.",
    };
  }
}

async function sendSayPayload(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  payload: SayPayload,
  showFrom: boolean
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (showFrom) {
    try {
      await interaction.reply(payload);
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: "Failed to post via interaction response. Please retry.",
      };
    }
  }

  const sent = await sendToChannel(interaction, payload);
  if (!sent.ok) return sent;

  try {
    await interaction.reply({
      ephemeral: true,
      content: "Posted message to channel.",
    });
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "Posted message to channel, but failed to send confirmation.",
    };
  }
}

function buildLongTextModal(
  interaction: ChatInputCommandInteraction,
  seedText: string | null,
  showFrom: boolean
) {
  const bodyInput = new TextInputBuilder()
    .setCustomId(SAY_LONG_TEXT_INPUT_ID)
    .setLabel("Message Body")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(DISCORD_MESSAGE_LIMIT);

  if (seedText) {
    bodyInput.setValue(seedText.slice(0, DISCORD_MESSAGE_LIMIT));
  }

  return new ModalBuilder()
    .setCustomId(buildSayModalCustomId(SAY_LONG_TEXT_TYPE, interaction.user.id, showFrom))
    .setTitle("Say Long Text")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(bodyInput));
}

function buildEmbedModal(
  interaction: ChatInputCommandInteraction,
  seedText: string | null,
  showFrom: boolean
) {
  const titleInput = new TextInputBuilder()
    .setCustomId(SAY_EMBED_TITLE_INPUT_ID)
    .setLabel("Embed Title (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(DISCORD_EMBED_TITLE_LIMIT);

  const bodyInput = new TextInputBuilder()
    .setCustomId(SAY_EMBED_BODY_INPUT_ID)
    .setLabel("Embed Body")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(DISCORD_EMBED_BODY_LIMIT);

  if (seedText) {
    bodyInput.setValue(seedText.slice(0, DISCORD_EMBED_BODY_LIMIT));
  }

  const imageUrlInput = new TextInputBuilder()
    .setCustomId(SAY_EMBED_IMAGE_URL_INPUT_ID)
    .setLabel("Image URL (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(DISCORD_URL_LIMIT);

  return new ModalBuilder()
    .setCustomId(buildSayModalCustomId(SAY_EMBED_TYPE, interaction.user.id, showFrom))
    .setTitle("Say Embed")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(bodyInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(imageUrlInput)
    );
}

export function isSayModalCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${SAY_MODAL_PREFIX}:`);
}

export async function handleSayModalSubmit(
  interaction: ModalSubmitInteraction
): Promise<void> {
  const parsed = parseSayModalCustomId(interaction.customId);
  if (!parsed) return;

  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the user who opened this modal can submit it.",
    });
    return;
  }

  if (!parsed.showFrom && !hasAdministratorPermission(interaction)) {
    await interaction.reply({
      ephemeral: true,
      content: "Only administrators can set `show-from:false`.",
    });
    return;
  }

  if (parsed.type === SAY_LONG_TEXT_TYPE) {
    const body = interaction.fields.getTextInputValue(SAY_LONG_TEXT_INPUT_ID).trim();
    if (!body) {
      await interaction.reply({
        ephemeral: true,
        content: "Message body cannot be empty.",
      });
      return;
    }
    if (body.length > DISCORD_MESSAGE_LIMIT) {
      await interaction.reply({
        ephemeral: true,
        content: `Message body is too long. Max ${DISCORD_MESSAGE_LIMIT} characters.`,
      });
      return;
    }

    const sent = await sendSayPayload(interaction, { content: body }, parsed.showFrom);
    if (!sent.ok && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        ephemeral: true,
        content: sent.message,
      });
    }
    return;
  }

  const title = normalizeOptionalText(
    interaction.fields.getTextInputValue(SAY_EMBED_TITLE_INPUT_ID)
  );
  const body = interaction.fields.getTextInputValue(SAY_EMBED_BODY_INPUT_ID).trim();
  const imageUrl = normalizeOptionalText(
    interaction.fields.getTextInputValue(SAY_EMBED_IMAGE_URL_INPUT_ID)
  );

  if (!body) {
    await interaction.reply({
      ephemeral: true,
      content: "Embed body cannot be empty.",
    });
    return;
  }
  if (body.length > DISCORD_EMBED_BODY_LIMIT) {
    await interaction.reply({
      ephemeral: true,
      content: `Embed body is too long. Max ${DISCORD_EMBED_BODY_LIMIT} characters.`,
    });
    return;
  }
  if (title && title.length > DISCORD_EMBED_TITLE_LIMIT) {
    await interaction.reply({
      ephemeral: true,
      content: `Embed title is too long. Max ${DISCORD_EMBED_TITLE_LIMIT} characters.`,
    });
    return;
  }
  if (imageUrl && !isValidHttpUrl(imageUrl)) {
    await interaction.reply({
      ephemeral: true,
      content: "Invalid image URL. Provide an absolute http:// or https:// URL.",
    });
    return;
  }

  const embed = new EmbedBuilder().setDescription(body);
  if (title) embed.setTitle(title);
  if (imageUrl) embed.setImage(imageUrl);

  const sent = await sendSayPayload(interaction, { embeds: [embed] }, parsed.showFrom);
  if (!sent.ok && !interaction.replied && !interaction.deferred) {
    await interaction.reply({
      ephemeral: true,
      content: sent.message,
    });
  }
}

export const Say: Command = {
  name: "say",
  description: "Post plain text or an embed in this channel",
  options: [
    {
      name: SAY_TEXT_OPTION,
      description: "Text to post immediately or prefill modal content",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: SAY_TYPE_OPTION,
      description: "Choose modal type for long text or embed",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: SAY_LONG_TEXT_TYPE, value: SAY_LONG_TEXT_TYPE },
        { name: SAY_EMBED_TYPE, value: SAY_EMBED_TYPE },
      ],
    },
    {
      name: SAY_SHOW_FROM_OPTION,
      description: "Show native command attribution header (only admins can set false)",
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    if (!interaction.inGuild()) {
      await interaction.reply({
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    const text = normalizeOptionalText(interaction.options.getString(SAY_TEXT_OPTION, false));
    const type = parseSayType(interaction.options.getString(SAY_TYPE_OPTION, false));
    const showFrom = interaction.options.getBoolean(SAY_SHOW_FROM_OPTION, false) ?? true;

    if (!showFrom && !hasAdministratorPermission(interaction)) {
      await interaction.reply({
        ephemeral: true,
        content: "Only administrators can set `show-from:false`.",
      });
      return;
    }

    if (!type) {
      if (!text) {
        await interaction.reply({
          ephemeral: true,
          content: "Provide `text` for a plain message, or choose a `type` modal.",
        });
        return;
      }

      if (text.length > DISCORD_MESSAGE_LIMIT) {
        await interaction.reply({
          ephemeral: true,
          content: `Text is too long. Max ${DISCORD_MESSAGE_LIMIT} characters.`,
        });
        return;
      }

      const sent = await sendSayPayload(interaction, { content: text }, showFrom);
      if (!sent.ok && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: sent.message,
        });
      }
      return;
    }

    if (type === SAY_LONG_TEXT_TYPE) {
      await interaction.showModal(buildLongTextModal(interaction, text, showFrom));
      return;
    }

    await interaction.showModal(buildEmbedModal(interaction, text, showFrom));
  },
};
