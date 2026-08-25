import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { LayoutRecord } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { parseClashLayoutLink } from "./ClashLayoutLinkService";
import {
  deriveLayoutFreshnessTimestamp,
  LayoutService,
  layoutService,
} from "./LayoutService";

const LAYOUT_POST_PREFIX = "layout";
const LAYOUT_POST_CUSTOM_ID_MAX_LENGTH = 100;
const DEFAULT_AUTO_COLLAPSE_DELAY_MS = 2 * 60 * 1000;

export const LAYOUT_POST_AUTO_COLLAPSE_DELAY_MS = DEFAULT_AUTO_COLLAPSE_DELAY_MS;

export type LayoutPostButtonAction = "link" | "confirm" | "close" | "info";

export type LayoutPostRenderMode = "collapsed" | "expanded";

export type LayoutPostPayload = {
  content?: string;
  embeds?: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: { parse: []; repliedUser: false };
};

export type LayoutPostImageSource = {
  attachmentName?: string | null;
  attachmentUrl?: string | null;
};

export type LayoutPostServiceOptions = {
  layoutService?: Pick<
    LayoutService,
    "findById" | "confirmSuccessfulOpening"
  >;
  autoCollapseDelayMs?: number;
};

export type ParsedLayoutPostCustomId = {
  action: LayoutPostButtonAction;
  layoutId: string;
};

/** Purpose: build one restart-safe persistent layout button custom ID. */
export function buildLayoutPostCustomId(
  action: LayoutPostButtonAction,
  layoutId: string,
): string {
  if (!isLayoutPostButtonAction(action)) {
    throw new Error(`Unsupported layout post action: ${action}`);
  }

  const normalizedLayoutId = String(layoutId ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalizedLayoutId)) {
    throw new Error("Layout post custom IDs require a safe layout record ID.");
  }

  const customId = `${LAYOUT_POST_PREFIX}:${action}:${normalizedLayoutId}`;
  if (customId.length > LAYOUT_POST_CUSTOM_ID_MAX_LENGTH) {
    throw new Error("Layout post custom ID exceeds Discord's length limit.");
  }
  return customId;
}

/** Purpose: parse a layout post custom ID without trusting its action or record ID. */
export function parseLayoutPostCustomId(
  customId: string,
): ParsedLayoutPostCustomId | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== LAYOUT_POST_PREFIX) return null;

  const action = parts[1] as LayoutPostButtonAction;
  const layoutId = parts[2] ?? "";
  if (!isLayoutPostButtonAction(action) || !/^[A-Za-z0-9_-]+$/.test(layoutId)) {
    return null;
  }
  return { action, layoutId };
}

/** Purpose: route persistent layout IDs while safely ignoring obsolete paginator IDs from the removed legacy command. */
export function isLayoutPostCustomId(customId: string): boolean {
  const normalized = String(customId ?? "");
  if (parseLayoutPostCustomId(normalized)) return true;

  const parts = normalized.split(":");
  if (
    parts.length === 3 &&
    parts[0] === LAYOUT_POST_PREFIX &&
    (parts[2] === "prev" || parts[2] === "next")
  ) {
    return false;
  }
  return normalized.startsWith(`${LAYOUT_POST_PREFIX}:`);
}

/** Purpose: identify a fully valid layout post button custom ID for focused routing/tests. */
export function isLayoutPostButtonCustomId(customId: string): boolean {
  return parseLayoutPostCustomId(customId) !== null;
}

/** Purpose: render the collapsed or temporarily expanded canonical public layout post. */
export function buildLayoutPostPayload(
  record: LayoutRecord,
  mode: LayoutPostRenderMode = "collapsed",
  imageSource: LayoutPostImageSource = {},
): LayoutPostPayload {
  const embed = new EmbedBuilder();
  const title = record.title?.trim();
  const imageUrl = resolveImageUrl(record, imageSource);

  if (title) embed.setTitle(title);
  if (imageUrl) embed.setImage(imageUrl);

  if (mode === "expanded") {
    embed.setDescription(
      `[Open Layout](<${record.layoutLink}>)\n\nDid the layout open successfully in Clash of Clans?`,
    );
  }

  const hasVisibleEmbedContent = Boolean(title || imageUrl || mode === "expanded");
  return {
    embeds: hasVisibleEmbedContent ? [embed] : [],
    components: [buildLayoutPostButtonRow(record.id, mode)],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** Purpose: render ephemeral layout metadata without exposing the layout URL. */
export function buildLayoutInfoPayload(record: LayoutRecord): {
  embeds?: EmbedBuilder[];
  content?: string;
  ephemeral: true;
  allowedMentions: { parse: []; repliedUser: false };
} {
  const embed = buildLayoutInfoEmbed(record);
  return {
    embeds: [embed],
    ephemeral: true,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** Purpose: build the metadata view while deliberately omitting the public title and layout URL. */
export function buildLayoutInfoEmbed(record: LayoutRecord): EmbedBuilder {
  const embed = new EmbedBuilder();
  const parsed = tryParseLayoutLink(record.layoutLink);
  const lines: string[] = [];

  if (parsed) {
    lines.push(`TH${parsed.townHall} • ${parsed.layoutKind}`);
  }
  if (record.description?.trim()) {
    lines.push(`Description\n${record.description.trim()}`);
  }
  if (record.postedByDiscordUserId?.trim()) {
    lines.push(`Posted by: <@${record.postedByDiscordUserId.trim()}>`);
  }
  if (record.submittedAt) {
    lines.push(`Submitted: ${formatRelativeDiscordTimestamp(record.submittedAt)}`);
  }
  if (record.lastConfirmedAt) {
    lines.push(
      `Last confirmed active: ${formatRelativeDiscordTimestamp(record.lastConfirmedAt)}`,
    );
  } else if (!deriveLayoutFreshnessTimestamp(record)) {
    lines.push("Freshness: unknown/not yet established");
  }
  if (record.lastConfirmedByDiscordUserId?.trim()) {
    lines.push(`Confirmed by: <@${record.lastConfirmedByDiscordUserId.trim()}>`);
  }

  embed.setDescription(lines.join("\n\n") || "No additional layout information is available.");
  return embed;
}

/** Purpose: format persisted lifecycle timestamps using Discord's relative timestamp rendering. */
export function formatRelativeDiscordTimestamp(value: Date): string {
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

/** Purpose: coordinate scoped layout interactions and best-effort in-memory auto-collapse timers. */
export class LayoutPostService {
  private readonly layoutService: Pick<
    LayoutService,
    "findById" | "confirmSuccessfulOpening"
  >;
  private readonly autoCollapseDelayMs: number;
  private readonly autoCollapseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: LayoutPostServiceOptions = {}) {
    this.layoutService = options.layoutService ?? layoutService;
    this.autoCollapseDelayMs = options.autoCollapseDelayMs ?? DEFAULT_AUTO_COLLAPSE_DELAY_MS;
  }

  /** Purpose: handle one persistent layout button after loading and validating canonical post scope. */
  async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseLayoutPostCustomId(interaction.customId);
    if (!parsed) {
      await replyLayoutPostError(interaction, "This layout action is no longer valid.");
      return;
    }

    try {
      const record = await this.layoutService.findById(parsed.layoutId);
      if (!record || !this.matchesCanonicalPostScope(interaction, record)) {
        this.logScopeMismatch(interaction, parsed.layoutId);
        await replyLayoutPostError(
          interaction,
          "This layout action no longer applies to this post.",
        );
        return;
      }

      const imageSource = getCurrentMessageImageSource(interaction);
      if (parsed.action === "info") {
        await interaction.reply(buildLayoutInfoPayload(record));
        return;
      }

      if (parsed.action === "link") {
        await interaction.update(
          buildLayoutPostPayload(record, "expanded", imageSource),
        );
        this.scheduleAutoCollapse(interaction, record.id, imageSource);
        return;
      }

      this.clearAutoCollapse(interaction.message.id);
      if (parsed.action === "close") {
        await interaction.update(
          buildLayoutPostPayload(record, "collapsed", imageSource),
        );
        return;
      }

      const confirmedRecord = await this.layoutService.confirmSuccessfulOpening({
        id: record.id,
        discordUserId: interaction.user.id,
      });
      await interaction.update(
        buildLayoutPostPayload(confirmedRecord, "collapsed", imageSource),
      );
      dozzleLog.info(
        `[layout-post] event=confirmation_succeeded layout_id=${record.id} guild_id=${interaction.guildId} channel_id=${interaction.channelId} message_id=${interaction.message.id} user_id=${interaction.user.id}`,
      );
    } catch (error) {
      dozzleLog.error(
        `[layout-post] event=interaction_failed layout_id=${parsed.layoutId} action=${parsed.action} guild_id=${interaction.guildId ?? "DM"} message_id=${interaction.message.id} error=${formatError(error)}`,
      );
      await replyLayoutPostError(
        interaction,
        "Failed to update this layout post. Please try again shortly.",
      );
    }
  }

  /** Purpose: cancel any pending presentation-only collapse for a canonical message. */
  clearAutoCollapse(messageId: string): void {
    const timer = this.autoCollapseTimers.get(messageId);
    if (!timer) return;
    clearTimeout(timer);
    this.autoCollapseTimers.delete(messageId);
  }

  /** Purpose: schedule one replaceable best-effort collapse without persisting presentation state. */
  private scheduleAutoCollapse(
    interaction: ButtonInteraction,
    layoutId: string,
    imageSource: LayoutPostImageSource,
  ): void {
    this.clearAutoCollapse(interaction.message.id);

    let timer: ReturnType<typeof setTimeout>;
    timer = setTimeout(async () => {
      if (this.autoCollapseTimers.get(interaction.message.id) !== timer) return;
      this.autoCollapseTimers.delete(interaction.message.id);

      try {
        const record = await this.layoutService.findById(layoutId);
        if (!record || !this.matchesCanonicalPostScope(interaction, record)) return;
        await interaction.message.edit(
          buildLayoutPostPayload(record, "collapsed", imageSource),
        );
      } catch (error) {
        dozzleLog.error(
          `[layout-post] event=auto_collapse_failed layout_id=${layoutId} message_id=${interaction.message.id} error=${formatError(error)}`,
        );
      }
    }, this.autoCollapseDelayMs);

    this.autoCollapseTimers.set(interaction.message.id, timer);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
  }

  /** Purpose: enforce the persisted guild/channel/message provenance boundary for every public interaction. */
  private matchesCanonicalPostScope(
    interaction: ButtonInteraction,
    record: LayoutRecord,
  ): boolean {
    return Boolean(
      interaction.guildId &&
        interaction.channelId &&
        record.discordGuildId === interaction.guildId &&
        record.discordChannelId === interaction.channelId &&
        record.discordMessageId === interaction.message.id,
    );
  }

  /** Purpose: log rejected forged, stale, or moved layout buttons without logging the raw layout link. */
  private logScopeMismatch(interaction: ButtonInteraction, layoutId: string): void {
    dozzleLog.warn(
      `[layout-post] event=scope_rejected layout_id=${layoutId} interaction_guild_id=${interaction.guildId ?? "DM"} interaction_channel_id=${interaction.channelId ?? "unknown"} interaction_message_id=${interaction.message.id}`,
    );
  }
}

/** Purpose: route the centralized persistent button dispatcher to the shared layout post service. */
export async function handleLayoutButtonInteraction(
  interaction: ButtonInteraction,
  service: LayoutPostService = layoutPostService,
): Promise<void> {
  await service.handleButtonInteraction(interaction);
}

/** Purpose: build the canonical collapsed/expanded button row for one layout record. */
function buildLayoutPostButtonRow(
  layoutId: string,
  mode: LayoutPostRenderMode,
): ActionRowBuilder<ButtonBuilder> {
  const buttons = mode === "expanded"
    ? [
        new ButtonBuilder()
          .setCustomId(buildLayoutPostCustomId("confirm", layoutId))
          .setLabel("Yes, It Opened")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildLayoutPostCustomId("close", layoutId))
          .setLabel("Close")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(buildLayoutPostCustomId("info", layoutId))
          .setLabel("Info")
          .setStyle(ButtonStyle.Secondary),
      ]
    : [
        new ButtonBuilder()
          .setCustomId(buildLayoutPostCustomId("link", layoutId))
          .setLabel("Layout Link")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(buildLayoutPostCustomId("info", layoutId))
          .setLabel("Info")
          .setStyle(ButtonStyle.Secondary),
      ];

  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** Purpose: keep the action union centralized for custom-ID construction and parsing. */
function isLayoutPostButtonAction(value: string): value is LayoutPostButtonAction {
  return value === "link" || value === "confirm" || value === "close" || value === "info";
}

/** Purpose: choose the persisted external image or a same-message attachment reference without re-uploading. */
function resolveImageUrl(
  record: LayoutRecord,
  imageSource: LayoutPostImageSource,
): string | null {
  const persistedImageUrl = record.imageUrl?.trim();
  if (persistedImageUrl) return persistedImageUrl;
  const attachmentName = imageSource.attachmentName?.trim();
  if (attachmentName) return `attachment://${attachmentName}`;
  const attachmentUrl = imageSource.attachmentUrl?.trim();
  if (attachmentUrl) return attachmentUrl;
  return null;
}

/** Purpose: extract the current canonical message attachment so button edits preserve it. */
function getCurrentMessageImageSource(
  interaction: ButtonInteraction,
): LayoutPostImageSource {
  const attachment = interaction.message.attachments?.first?.();
  return {
    attachmentName: attachment?.name ?? null,
    attachmentUrl: attachment?.url ?? null,
  };
}

/** Purpose: parse layout metadata for Info while tolerating legacy malformed links without exposing them. */
function tryParseLayoutLink(layoutLink: string): ReturnType<typeof parseClashLayoutLink> | null {
  try {
    return parseClashLayoutLink(layoutLink);
  } catch {
    return null;
  }
}

/** Purpose: respond safely to invalid, stale, or failed persistent layout interactions. */
async function replyLayoutPostError(
  interaction: ButtonInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) return;
  await interaction.reply({
    ephemeral: true,
    content,
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export const layoutPostService = new LayoutPostService();
