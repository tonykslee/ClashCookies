import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { FwaLayoutType, FwaLayouts } from "@prisma/client";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";
import {
  FWA_LAYOUT_LINK_PREFIX,
  FWA_LAYOUT_TYPES,
  getAllFwaLayouts,
  getFwaLayout,
  isSupportedTownhall,
  isValidFwaLayoutLink,
  isValidImageUrl,
  normalizeLayoutType,
  upsertFwaLayout,
  wrapDiscordLink,
} from "../services/FwaLayoutService";

const PAGINATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Purpose: render one layout row with wrapped link and optional image line. */
function renderLayoutRow(row: FwaLayouts): string {
  const base = `TH${row.Townhall} - ${wrapDiscordLink(row.LayoutLink)}`;
  if (!row.ImageUrl) return base;
  return `${base}\nImage: ${row.ImageUrl}`;
}

/** Purpose: build fixed-order paginated embeds for RISINGDAWN, BASIC, and ICE layout views. */
export function buildLayoutListEmbeds(rows: FwaLayouts[]): EmbedBuilder[] {
  return FWA_LAYOUT_TYPES.map((type, index) => {
    const typeRows = rows
      .filter((row) => row.Type === type)
      .sort((left, right) => left.Townhall - right.Townhall);

    const description =
      typeRows.length === 0
        ? "No layouts saved for this type yet."
        : typeRows.map((row) => renderLayoutRow(row)).join("\n\n");

    return new EmbedBuilder()
      .setTitle(`FWA Layouts - ${type}`)
      .setDescription(description)
      .setColor(0x5865f2)
      .setFooter({ text: `Page ${index + 1}/${FWA_LAYOUT_TYPES.length}` });
  });
}

/** Purpose: build Prev/Next controls for layout page navigation. */
function buildLayoutPaginationRow(customIdPrefix: string, page: number, pageCount: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:prev`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1)
  );
}

/** Purpose: reply with a deterministic ephemeral validation/permission error payload. */
async function replyLayoutError(
  interaction: ChatInputCommandInteraction,
  message: string
): Promise<void> {
  await interaction.reply({
    content: message,
    ephemeral: true,
  });
}

/** Purpose: enforce runtime admin gating for edit flows on an otherwise public command. */
function canEditLayouts(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

/** Purpose: build one fetch/edit success response with optional preview image line. */
function buildSingleLayoutMessage(input: {
  townhall: number;
  type: FwaLayoutType;
  layoutLink: string;
  imageUrl: string | null;
  action: "fetch" | "save";
}): string {
  const header =
    input.action === "save"
      ? `Saved TH${input.townhall} ${input.type} layout:`
      : `TH${input.townhall} ${input.type} layout:`;
  const lines = [header, wrapDiscordLink(input.layoutLink)];
  if (input.imageUrl) {
    lines.push(`Image: ${input.imageUrl}`);
  }
  return lines.join("\n");
}

/** Purpose: send paginated list response and wire button handlers for command requester only. */
async function handleListMode(
  interaction: ChatInputCommandInteraction,
  isPublic: boolean,
  rows: FwaLayouts[]
): Promise<void> {
  const embeds = buildLayoutListEmbeds(rows);
  const customIdPrefix = `layout:${interaction.id}`;
  let page = 0;

  await interaction.reply({
    embeds: [embeds[page]],
    components:
      embeds.length > 1 ? [buildLayoutPaginationRow(customIdPrefix, page, embeds.length)] : [],
    ephemeral: !isPublic,
  });

  if (embeds.length <= 1) return;

  const message = await interaction.fetchReply();
  if (!("createMessageComponentCollector" in message)) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PAGINATION_TIMEOUT_MS,
  });

  collector.on("collect", async (button: ButtonInteraction) => {
    try {
      if (button.user.id !== interaction.user.id) {
        await button.reply({
          ephemeral: true,
          content: "Only the command requester can use this button.",
        });
        return;
      }

      if (button.customId === `${customIdPrefix}:prev`) {
        page = Math.max(0, page - 1);
      } else if (button.customId === `${customIdPrefix}:next`) {
        page = Math.min(embeds.length - 1, page + 1);
      }

      await button.update({
        embeds: [embeds[page]],
        components: [buildLayoutPaginationRow(customIdPrefix, page, embeds.length)],
      });
    } catch (error) {
      console.error(`layout paginator failed: ${formatError(error)}`);
      if (!button.replied && !button.deferred) {
        await button.reply({
          ephemeral: true,
          content: "Failed to update layout page.",
        });
      }
    }
  });

  collector.on("end", async () => {
    try {
      await interaction.editReply({ components: [] });
    } catch {
      // no-op
    }
  });
}

export const Layout: Command = {
  name: "layout",
  description: "Get or update FWA base layouts by Town Hall",
  options: [
    {
      name: "th",
      description: "Town Hall level (TH8-TH18)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
    },
    {
      name: "type",
      description: "Layout type",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: FWA_LAYOUT_TYPES.map((type) => ({ name: type, value: type })),
    },
    {
      name: "edit",
      description: "New Clash layout link (admin only)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "img-url",
      description: "Optional preview image URL to save for this layout",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    const isPublic = interaction.options.getString("visibility", false) === "public";
    const townhall = interaction.options.getInteger("th", false);
    const typeInput = interaction.options.getString("type", false);
    const editInput = interaction.options.getString("edit", false);
    const imageUrlInput = interaction.options.getString("img-url", false);
    const type = normalizeLayoutType(typeInput);

    try {
      if (imageUrlInput !== null && !editInput) {
        await replyLayoutError(interaction, "You must provide `edit` when using `img-url`.");
        return;
      }

      if (editInput) {
        if (!canEditLayouts(interaction)) {
          await replyLayoutError(interaction, "You do not have permission to edit layouts.");
          return;
        }

        if (townhall === null) {
          await replyLayoutError(interaction, "You must provide `th` when using `edit`.");
          return;
        }

        if (!isSupportedTownhall(townhall)) {
          await replyLayoutError(interaction, "Unsupported Town Hall. Allowed values: TH8-TH18.");
          return;
        }

        if (!isValidFwaLayoutLink(editInput)) {
          await replyLayoutError(
            interaction,
            `Invalid layout link. Expected a Clash of Clans layout URL starting with ${FWA_LAYOUT_LINK_PREFIX}`
          );
          return;
        }

        if (imageUrlInput !== null && !isValidImageUrl(imageUrlInput)) {
          await replyLayoutError(
            interaction,
            "Invalid image URL. Expected a valid http(s) URL."
          );
          return;
        }

        const saved = await upsertFwaLayout({
          townhall,
          type,
          layoutLink: editInput,
          ...(imageUrlInput !== null ? { imageUrl: imageUrlInput } : {}),
        });

        await interaction.reply({
          content: buildSingleLayoutMessage({
            townhall,
            type,
            layoutLink: saved.LayoutLink,
            imageUrl: saved.ImageUrl,
            action: "save",
          }),
          ephemeral: !isPublic,
        });
        return;
      }

      if (townhall === null) {
        if (typeInput) {
          await replyLayoutError(interaction, "You must provide `th` when using `type`.");
          return;
        }

        const rows = await getAllFwaLayouts();
        await handleListMode(interaction, isPublic, rows);
        return;
      }

      if (!isSupportedTownhall(townhall)) {
        await replyLayoutError(interaction, "Unsupported Town Hall. Allowed values: TH8-TH18.");
        return;
      }

      const row = await getFwaLayout(townhall, type);
      if (!row) {
        await replyLayoutError(interaction, `No layout saved for TH${townhall} (${type}).`);
        return;
      }

      await interaction.reply({
        content: buildSingleLayoutMessage({
          townhall,
          type,
          layoutLink: row.LayoutLink,
          imageUrl: row.ImageUrl,
          action: "fetch",
        }),
        ephemeral: !isPublic,
      });
    } catch (error) {
      console.error(`layout command failed: ${formatError(error)}`);
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply("Failed to process `/layout`. Try again shortly.");
        return;
      }
      await replyLayoutError(interaction, "Failed to process `/layout`. Try again shortly.");
    }
  },
};

export const buildLayoutListEmbedsForTest = buildLayoutListEmbeds;
