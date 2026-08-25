import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { formatError } from "../../helper/formatError";
import {
  FWA_LAYOUT_TYPES,
  FwaCanonicalLayout,
  FwaLayoutService,
  FwaLayoutTownhallMismatchError,
  isSupportedTownhall,
  isValidImageUrl,
  normalizeLayoutType,
  UnsupportedFwaLayoutTownhallError,
  fwaLayoutService,
} from "../../services/FwaLayoutService";
import { InvalidClashLayoutLinkError } from "../../services/ClashLayoutLinkService";
import {
  LayoutPostPublicationService,
  LayoutPostChannel,
  LayoutPostMessageResolver,
  buildDiscordJumpUrl,
  createDiscordLayoutPostResolver,
  layoutPostPublicationService,
} from "../../services/LayoutPostPublicationService";

export const FWA_LAYOUT_SUBCOMMAND = {
  name: "layout",
  description: "View or manage canonical FWA layouts",
  type: ApplicationCommandOptionType.Subcommand,
  options: [
    {
      name: "th",
      description: "Town Hall lookup (TH8-TH18); derived from link during updates",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      min_value: 8,
      max_value: 18,
    },
    {
      name: "type",
      description: "FWA layout type",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: FWA_LAYOUT_TYPES.map((type) => ({ name: type, value: type })),
    },
    {
      name: "link",
      description: "Clash layout link to set as canonical",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "title",
      description: "Optional public layout title",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "description",
      description: "Optional layout description shown in Info",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "img-url",
      description: "Optional public layout image URL",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ],
} as const;

export type FwaLayoutCommandDeps = {
  layoutService?: FwaLayoutService;
  publicationService?: LayoutPostPublicationService;
  messageResolver?: LayoutPostMessageResolver;
};

/** Purpose: execute the modular canonical FWA layout command without putting layout policy in Fwa.ts. */
export async function runFwaLayoutCommand(
  interaction: ChatInputCommandInteraction,
  deps: FwaLayoutCommandDeps = {},
): Promise<void> {
  const layoutService = deps.layoutService ?? fwaLayoutService;
  const publicationService =
    deps.publicationService ?? layoutPostPublicationService;
  const messageResolver =
    deps.messageResolver ??
    (interaction.client
      ? createDiscordLayoutPostResolver(interaction.client)
      : undefined);
  const townhall = interaction.options.getInteger("th", false);
  const typeInput = interaction.options.getString("type", false);
  const type = normalizeLayoutType(typeInput);
  const link = interaction.options.getString("link", false)?.trim() || null;
  const imageUrlInput = interaction.options.getString("img-url", false);
  const title = interaction.options.getString("title", false);
  const description = interaction.options.getString("description", false);

  try {
    if (link) {
      await runUpdateMode({
        interaction,
        layoutService,
        publicationService,
        townhall,
        type,
        link,
        title,
        description,
        imageUrlInput,
        messageResolver,
      });
      return;
    }

    if (townhall !== null) {
      await runLookupMode({
        interaction,
        layoutService,
        publicationService,
        townhall,
        type,
        messageResolver,
      });
      return;
    }

    if (title !== null || description !== null || imageUrlInput !== null) {
      await replyPrivate(
        interaction,
        "`title`, `description`, and `img-url` require `link`.",
      );
      return;
    }

    await runListMode({ interaction, layoutService, type: typeInput ? type : null });
  } catch (error) {
    const safeError =
      error instanceof InvalidClashLayoutLinkError
        ? "invalid_clash_layout_link"
        : formatError(error);
    console.error(
      `[fwa-layout] event=command_failed guild_id=${interaction.guildId ?? "dm"} user_id=${interaction.user.id} error=${safeError}`,
    );
    if (error instanceof FwaLayoutTownhallMismatchError) {
      await replyPrivate(interaction, error.message);
      return;
    }
    if (error instanceof UnsupportedFwaLayoutTownhallError) {
      await replyPrivate(interaction, error.message);
      return;
    }
    if (error instanceof InvalidClashLayoutLinkError) {
      await replyPrivate(interaction, "Invalid Clash layout link.");
      return;
    }
    await replyPrivate(
      interaction,
      "Failed to process `/fwa layout`. Please try again shortly.",
    );
  }
}

async function runUpdateMode(input: {
  interaction: ChatInputCommandInteraction;
  layoutService: FwaLayoutService;
  publicationService: LayoutPostPublicationService;
  townhall: number | null;
  type: ReturnType<typeof normalizeLayoutType>;
  link: string;
  title: string | null;
  description: string | null;
  imageUrlInput: string | null;
  messageResolver?: LayoutPostMessageResolver;
}): Promise<void> {
  if (!input.interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyPrivate(input.interaction, "Only administrators can update FWA layouts.");
    return;
  }
  if (input.imageUrlInput !== null && !isValidImageUrl(input.imageUrlInput)) {
    await replyPrivate(
      input.interaction,
      "Invalid image URL. Expected a valid http(s) URL.",
    );
    return;
  }
  const canonical = await input.layoutService.setCanonicalLayout({
    townhall: input.townhall,
    type: input.type,
    layoutLink: input.link,
    ...(input.title !== null ? { title: input.title } : {}),
    ...(input.description !== null ? { description: input.description } : {}),
    ...(input.imageUrlInput !== null ? { imageUrl: input.imageUrlInput } : {}),
    postedByDiscordUserId: input.interaction.user.id,
  });
  const published = await publishCanonicalLayout({
    interaction: input.interaction,
    canonical,
    publicationService: input.publicationService,
    messageResolver: input.messageResolver,
  });
  await replyPrivate(
    input.interaction,
    `Saved canonical TH${canonical.Townhall} ${canonical.Type} layout. [View post](${published.jumpUrl})`,
  );
}

async function runLookupMode(input: {
  interaction: ChatInputCommandInteraction;
  layoutService: FwaLayoutService;
  publicationService: LayoutPostPublicationService;
  townhall: number;
  type: ReturnType<typeof normalizeLayoutType>;
  messageResolver?: LayoutPostMessageResolver;
}): Promise<void> {
  if (!isSupportedTownhall(input.townhall)) {
    throw new UnsupportedFwaLayoutTownhallError(input.townhall);
  }
  const canonical = await input.layoutService.findCanonical({
    townhall: input.townhall,
    type: input.type,
  });
  if (!canonical?.layoutRecord) {
    await replyPrivate(
      input.interaction,
      `No canonical layout is available for TH${input.townhall} (${input.type}).`,
    );
    return;
  }
  const published = await publishCanonicalLayout({
    interaction: input.interaction,
    canonical,
    publicationService: input.publicationService,
    messageResolver: input.messageResolver,
  });
  await replyPrivate(
    input.interaction,
    `TH${input.townhall} ${input.type} canonical layout: [View post](${published.jumpUrl})`,
  );
}

async function runListMode(input: {
  interaction: ChatInputCommandInteraction;
  layoutService: FwaLayoutService;
  type: ReturnType<typeof normalizeLayoutType> | null;
}): Promise<void> {
  const rows = await input.layoutService.listCanonical({ type: input.type });
  const sections = (input.type ? [input.type] : FWA_LAYOUT_TYPES).map((type) => {
    const typeRows = rows.filter((row) => row.Type === type);
    const lines = typeRows.length
      ? typeRows.map((row) => formatListRow(row))
      : ["No layouts saved for this type yet."];
    return `**${type}**\n${lines.join("\n")}`;
  });
  await input.interaction.reply({
    embeds: [
      {
        title: "FWA Layout Catalog",
        description: sections.join("\n\n"),
        color: 0x5865f2,
      },
    ],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

function formatListRow(row: FwaCanonicalLayout): string {
  const record = row.layoutRecord;
  const freshness = record?.lastConfirmedAt
    ? `confirmed <t:${Math.floor(record.lastConfirmedAt.getTime() / 1000)}:R>`
    : record?.submittedAt
      ? `submitted <t:${Math.floor(record.submittedAt.getTime() / 1000)}:R>`
      : "freshness unknown";
  const post = record?.discordMessageId ? "post available" : "not posted";
  return `TH${row.Townhall} — ${freshness} · ${post}`;
}

async function publishCanonicalLayout(input: {
  interaction: ChatInputCommandInteraction;
  canonical: FwaCanonicalLayout;
  publicationService: LayoutPostPublicationService;
  messageResolver?: LayoutPostMessageResolver;
}) {
  if (!input.interaction.guildId || !input.interaction.channelId) {
    throw new Error("FWA layout posts require a guild text channel.");
  }
  const channel = input.interaction.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function") {
    throw new Error("The invoking channel cannot publish a layout post.");
  }
  if (!input.canonical.layoutRecord) {
    throw new Error("The canonical layout has no shared LayoutRecord.");
  }
  return input.publicationService.publish({
    layout: input.canonical.layoutRecord,
    guildId: input.interaction.guildId,
    channel: channel as unknown as LayoutPostChannel,
    messageResolver: input.messageResolver,
  });
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({
    content,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

export const buildFwaLayoutListRowForTest = formatListRow;
export const buildFwaLayoutJumpUrlForTest = buildDiscordJumpUrl;
