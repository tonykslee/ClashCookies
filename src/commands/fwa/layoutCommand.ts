import {
  ApplicationCommandOptionType,
  ChannelType,
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
import {
  InvalidClashLayoutLinkError,
  parseClashLayoutLink,
} from "../../services/ClashLayoutLinkService";
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
} from "../../services/LayoutAlertConfigService";
import { BotLogChannelService, botLogChannelService } from "../../services/BotLogChannelService";
import {
  LayoutPostPublicationService,
  LayoutPostChannel,
  LayoutPostMessageResolver,
  buildDiscordJumpUrl,
  createDiscordLayoutPostResolver,
  layoutPostPublicationService,
} from "../../services/LayoutPostPublicationService";
import { deriveLayoutFreshnessTimestamp } from "../../services/LayoutService";

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
  ],
} as const;

export type FwaLayoutCommandDeps = {
  layoutService?: FwaLayoutService;
  publicationService?: LayoutPostPublicationService;
  messageResolver?: LayoutPostMessageResolver;
  alertConfigService?: Pick<LayoutAlertConfigService, "setPolicy" | "disablePolicy">;
  botLogChannelService?: Pick<BotLogChannelService, "getChannelIdForType">;
  now?: () => Date;
};

/** Purpose: execute the modular canonical FWA layout command without putting layout policy in Fwa.ts. */
export async function runFwaLayoutCommand(
  interaction: ChatInputCommandInteraction,
  deps: FwaLayoutCommandDeps = {},
): Promise<void> {
  const invocationNow = deps.now?.() ?? new Date();
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
  const alertTypeInput = interaction.options.getString("alert-type", false);
  const alertChannel = interaction.options.getChannel("alert-channel", false) as {
    id: string;
    guildId?: string | null;
    type?: number;
  } | null;

  try {
    if (link) {
      const alertType = parseLayoutAlertType(alertTypeInput);
      const parsedLink = parseClashLayoutLink(link);
      const existingLayout = alertType
        ? await layoutService.findByLayoutLink(parsedLink.layoutLink)
        : null;
      const targetAlertGuildId = resolveLayoutAlertGuildId(
        existingLayout,
        interaction.guildId ?? "",
      );
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
        alertType,
        alertChannel,
        targetAlertGuildId,
        alertConfigService: deps.alertConfigService ?? layoutAlertConfigService,
        botLogChannelService: deps.botLogChannelService ?? botLogChannelService,
      });
      return;
    }

    if (
      title !== null ||
      description !== null ||
      imageUrlInput !== null ||
      alertTypeInput !== null ||
      alertChannel
    ) {
      await replyPrivate(
        interaction,
        "`title`, `description`, `img-url`, `alert-type`, and `alert-channel` require `link`.",
      );
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

    await runListMode({
      interaction,
      layoutService,
      type: typeInput ? type : null,
      now: invocationNow,
    });
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
    if (error instanceof LayoutAlertPolicyValidationError) {
      await replyPrivate(interaction, error.message);
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
  alertType: ReturnType<typeof parseLayoutAlertType>;
  alertChannel: { id: string; guildId?: string | null; type?: number } | null;
  targetAlertGuildId: string;
  alertConfigService: Pick<LayoutAlertConfigService, "setPolicy" | "disablePolicy">;
  botLogChannelService: Pick<BotLogChannelService, "getChannelIdForType">;
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
  const defaultChannelId =
    input.alertType === "default-channel" || input.alertType === "both"
      ? await input.botLogChannelService.getChannelIdForType(
          input.targetAlertGuildId,
          "layout-alerts",
        )
      : null;
  validateLayoutAlertCommandOptions({
    type: input.alertType,
    channel: input.alertChannel,
    guildId: input.targetAlertGuildId,
    defaultChannelId,
  });
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
  if (input.alertType) {
    try {
      const finalAlertGuildId = getCompleteLayoutDiscordGuildId(published.layout);
      if (!finalAlertGuildId) {
        throw new LayoutAlertPolicyValidationError(
          "A canonical Discord layout post is required before enabling expiration alerts.",
        );
      }
      const finalDefaultChannelId =
        input.alertType === "default-channel" || input.alertType === "both"
          ? await input.botLogChannelService.getChannelIdForType(
              finalAlertGuildId,
              "layout-alerts",
            )
          : null;
      validateLayoutAlertCommandOptions({
        type: input.alertType,
        channel: input.alertChannel,
        guildId: finalAlertGuildId,
        defaultChannelId: finalDefaultChannelId,
      });
      if (input.alertType === "none") {
        await input.alertConfigService.disablePolicy(published.layout.id);
      } else {
        await input.alertConfigService.setPolicy({
          layoutId: published.layout.id,
          mode: layoutAlertModeForType(input.alertType),
          customChannelId:
            input.alertType === "custom-channel" ? input.alertChannel?.id : null,
        });
      }
    } catch (error) {
      console.error(
        `[fwa-layout] event=alert_policy_failed guild_id=${input.interaction.guildId ?? "dm"} layout_id=${published.layout.id} error=${formatError(error)}`,
      );
      await replyPrivate(
        input.interaction,
        `Saved canonical TH${canonical.Townhall} ${canonical.Type} layout. [View post](${published.jumpUrl}) Alert configuration failed; the layout was saved, but the alert policy could not be updated.`,
      );
      return;
    }
  }
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
  now: Date;
}): Promise<void> {
  const rows = await input.layoutService.listCanonical({ type: input.type });
  const sections = (input.type ? [input.type] : FWA_LAYOUT_TYPES).map((type) => ({
    type,
    lines: rows.filter((row) => row.Type === type).map((row) => formatListRow(row, input.now)),
  }));
  const embeds = buildCatalogEmbeds(sections);
  await input.interaction.reply({
    embeds,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

function formatListRow(row: FwaCanonicalLayout, now = new Date()): string {
  const record = row.layoutRecord;
  const freshness = formatFreshness(record, now);
  const post = hasCompleteProvenance(record)
    ? `[View Post](${buildDiscordJumpUrl(record.discordGuildId, record.discordChannelId, record.discordMessageId)})`
    : "Not posted";
  return `TH${row.Townhall} — ${freshness} · ${post}`;
}

function formatFreshness(
  record: FwaCanonicalLayout["layoutRecord"],
  now: Date,
): string {
  if (!record) return "⚪ freshness unknown";
  const timestamp = deriveLayoutFreshnessTimestamp(record);
  const timestampMs = timestamp instanceof Date ? timestamp.getTime() : Number.NaN;
  const nowMs = now.getTime();
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs) || timestampMs > nowMs) {
    return "⚪ freshness unknown";
  }

  const ageMs = nowMs - timestampMs;
  const grade = ageMs < 15 * 24 * 60 * 60 * 1000
    ? "🟢"
    : ageMs < 27 * 24 * 60 * 60 * 1000
      ? "🟡"
      : "🔴";
  const label = record.lastConfirmedAt ? "confirmed" : "submitted";
  return `${grade} ${label} <t:${Math.floor(timestampMs / 1000)}:R>`;
}

function hasCompleteProvenance(
  record: FwaCanonicalLayout["layoutRecord"],
): record is NonNullable<FwaCanonicalLayout["layoutRecord"]> & {
  discordGuildId: string;
  discordChannelId: string;
  discordMessageId: string;
} {
  return Boolean(
    record?.discordGuildId &&
    record.discordChannelId &&
    record.discordMessageId,
  );
}

const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const DISCORD_COMBINED_EMBED_LIMIT = 6000;
const DISCORD_MAX_EMBEDS = 10;

function buildCatalogEmbeds(
  sections: readonly { type: string; lines: readonly string[] }[],
): Array<{ title: string; description: string; color: number }> {
  const candidates = sections.flatMap((section) => {
    const lines = section.lines.length ? section.lines : ["No layouts saved for this type yet."];
    const chunks = splitCatalogLines(lines, DISCORD_EMBED_DESCRIPTION_LIMIT);
    return chunks.map((description, index) => ({
      title: `FWA Layout Catalog — ${section.type}${index > 0 ? " (continued)" : ""}`,
      description,
      color: 0x5865f2,
    }));
  });

  const embeds: Array<{ title: string; description: string; color: number }> = [];
  let usedCharacters = 0;
  for (const candidate of candidates) {
    if (embeds.length >= DISCORD_MAX_EMBEDS) break;
    const remaining = DISCORD_COMBINED_EMBED_LIMIT - usedCharacters - candidate.title.length;
    if (remaining <= 0) break;
    const description = candidate.description.slice(0, Math.min(candidate.description.length, remaining));
    if (!description) break;
    embeds.push({ ...candidate, description });
    usedCharacters += candidate.title.length + description.length;
  }
  return embeds.length ? embeds : [{
    title: "FWA Layout Catalog",
    description: "No layouts saved for this type yet.",
    color: 0x5865f2,
  }];
}

function splitCatalogLines(lines: readonly string[], limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const rawLine of lines) {
    const line = rawLine.length <= limit ? rawLine : `${rawLine.slice(0, limit - 1)}…`;
    if (current && current.length + 1 + line.length > limit) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ["No layouts saved for this type yet."];
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

export const buildFwaLayoutListRowForTest = (row: FwaCanonicalLayout, now?: Date) =>
  formatListRow(row, now ?? new Date());
export const buildFwaLayoutCatalogEmbedsForTest = buildCatalogEmbeds;
export const buildFwaLayoutJumpUrlForTest = buildDiscordJumpUrl;
