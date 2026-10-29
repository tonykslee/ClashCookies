import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { createHash } from "node:crypto";
import type { LayoutRecord } from "@prisma/client";
import { LayoutAlertMode } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { parseClashLayoutLink } from "./ClashLayoutLinkService";
import {
  deriveLayoutFreshnessTimestamp,
  LayoutService,
  layoutService,
} from "./LayoutService";
import {
  formatLayoutAlertPolicyLine,
  LayoutAlertConfigService,
  layoutAlertConfigService,
} from "./LayoutAlertConfigService";
import { BotLogChannelService, botLogChannelService } from "./BotLogChannelService";

const LAYOUT_POST_PREFIX = "layout";
// Private panel IDs use a compact namespace so UUID layout IDs plus two Discord snowflakes
// remain within Discord's 100-character component custom-ID limit.
const LAYOUT_POST_PANEL_PREFIX = "l";
const LAYOUT_POST_PANEL_MARKER = "p";
const LAYOUT_POST_CUSTOM_ID_MAX_LENGTH = 100;
const DEFAULT_AUTO_COLLAPSE_DELAY_MS = 2 * 60 * 1000;

export const LAYOUT_POST_AUTO_COLLAPSE_DELAY_MS = DEFAULT_AUTO_COLLAPSE_DELAY_MS;

export type LayoutPostButtonAction = "link" | "confirm" | "close" | "info";

export type LayoutPostRenderMode = "collapsed" | "link" | "info";

export type LayoutPostPayload = {
  content?: string;
  embeds?: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  attachments?: [];
  ephemeral?: boolean;
  allowedMentions: { parse: []; repliedUser: false };
};

export type LayoutPostImageSource = {
  attachmentName?: string | null;
  attachmentUrl?: string | null;
};

export type LayoutPostImageSourceKind =
  | "attachment_collection"
  | "embedded_attachment"
  | "embedded_url"
  | "none"
  | "metadata_unavailable";

export type LayoutPostImageSourceResolution = {
  source: LayoutPostImageSource;
  kind: LayoutPostImageSourceKind;
};

type LayoutPostImageMessageLike = {
  attachments?: {
    first?: () => {
      name?: string | null;
      url?: string | null;
      contentType?: string | null;
      size?: number | null;
    } | undefined;
  };
  embeds?: Array<{
    image?: { url?: string | null } | null;
  } | null>;
};

export type LayoutPostServiceOptions = {
  layoutService?: Pick<
    LayoutService,
    "findById" | "confirmSuccessfulOpening"
  >;
  autoCollapseDelayMs?: number;
  alertConfigService?: Pick<LayoutAlertConfigService, "getPolicy">;
  botLogChannelService?: Pick<BotLogChannelService, "getChannelIdForType">;
};

export type ParsedLayoutPostCustomId = {
  action: LayoutPostButtonAction;
  layoutId: string;
  /** Missing/null identifies a legacy confirmation control that predates episode tokens. */
  versionToken?: string | null;
};

export type ParsedLayoutPostPanelCustomId = {
  action: "confirm" | "close";
  layoutId: string;
  canonicalMessageId: string;
  ownerDiscordUserId: string;
  versionToken?: string;
};

const LAYOUT_POST_VERSION_TOKEN_LENGTH = 16;

/** Purpose: derive a deterministic, restart-safe token for the exact link episode rendered to a user. */
export function buildLayoutPostVersionToken(
  layoutLink: string,
  submittedAt: Date | null | undefined,
): string {
  const submittedAtIso = submittedAt?.toISOString() ?? null;
  return createHash("sha256")
    .update(JSON.stringify([String(layoutLink ?? "").trim(), submittedAtIso]))
    .digest("hex")
    .slice(0, LAYOUT_POST_VERSION_TOKEN_LENGTH);
}

/** Purpose: build one restart-safe persistent layout button custom ID. */
export function buildLayoutPostCustomId(
  action: LayoutPostButtonAction,
  layoutId: string,
  versionToken?: string,
): string {
  if (!isLayoutPostButtonAction(action)) {
    throw new Error(`Unsupported layout post action: ${action}`);
  }

  const normalizedLayoutId = String(layoutId ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalizedLayoutId)) {
    throw new Error("Layout post custom IDs require a safe layout record ID.");
  }

  const normalizedVersionToken = versionToken?.trim() ?? "";
  if (normalizedVersionToken && action !== "confirm") {
    throw new Error("Layout post version tokens are only valid for confirmations.");
  }
  if (normalizedVersionToken && !isLayoutPostVersionToken(normalizedVersionToken)) {
    throw new Error("Layout post confirmation version token is invalid.");
  }

  const customId = normalizedVersionToken
    ? `${LAYOUT_POST_PREFIX}:${action}:${normalizedLayoutId}:${normalizedVersionToken}`
    : `${LAYOUT_POST_PREFIX}:${action}:${normalizedLayoutId}`;
  if (customId.length > LAYOUT_POST_CUSTOM_ID_MAX_LENGTH) {
    throw new Error("Layout post custom ID exceeds Discord's length limit.");
  }
  return customId;
}

/** Purpose: bind private panel actions to the user, canonical message, and exact link episode. */
export function buildLayoutPostPanelCustomId(
  action: "confirm" | "close",
  layoutId: string,
  canonicalMessageId: string,
  ownerDiscordUserId: string,
  versionToken?: string,
): string {
  const normalizedLayoutId = normalizeLayoutPostId(layoutId, "layout record");
  const normalizedMessageId = normalizeLayoutPostId(canonicalMessageId, "canonical message");
  const normalizedOwnerId = normalizeLayoutPostId(ownerDiscordUserId, "Discord user");
  const normalizedVersionToken = versionToken?.trim() ?? "";
  if (action === "close" && normalizedVersionToken) {
    throw new Error("Layout panel version tokens are only valid for confirmations.");
  }
  if (action === "confirm" && !isLayoutPostVersionToken(normalizedVersionToken)) {
    throw new Error("Layout panel confirmation version token is invalid.");
  }

  const customId = [
    LAYOUT_POST_PANEL_PREFIX,
    LAYOUT_POST_PANEL_MARKER,
    action === "confirm" ? "c" : "x",
    normalizedLayoutId,
    normalizedMessageId,
    normalizedOwnerId,
    ...(normalizedVersionToken ? [normalizedVersionToken] : []),
  ].join(":");
  if (customId.length > LAYOUT_POST_CUSTOM_ID_MAX_LENGTH) {
    throw new Error("Layout panel custom ID exceeds Discord's length limit.");
  }
  return customId;
}

/** Purpose: parse a layout post custom ID without trusting its action or record ID. */
export function parseLayoutPostCustomId(
  customId: string,
): ParsedLayoutPostCustomId | null {
  const parts = String(customId ?? "").split(":");
  if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== LAYOUT_POST_PREFIX) return null;

  const action = parts[1] as LayoutPostButtonAction;
  const layoutId = parts[2] ?? "";
  if (!isLayoutPostButtonAction(action) || !/^[A-Za-z0-9_-]+$/.test(layoutId)) {
    return null;
  }
  const versionToken = parts.length === 4 ? parts[3] ?? "" : null;
  if (parts.length === 4 && (action !== "confirm" || !versionToken || !isLayoutPostVersionToken(versionToken))) {
    return null;
  }
  return parts.length === 4
    ? { action, layoutId, versionToken }
    : { action, layoutId };
}

/** Purpose: parse a user-owned ephemeral panel action without trusting its embedded scope. */
export function parseLayoutPostPanelCustomId(
  customId: string,
): ParsedLayoutPostPanelCustomId | null {
  const parts = String(customId ?? "").split(":");
  if ((parts.length !== 6 && parts.length !== 7) || parts[0] !== LAYOUT_POST_PANEL_PREFIX || parts[1] !== LAYOUT_POST_PANEL_MARKER) {
    return null;
  }
  const actionMarker = parts[2];
  if (actionMarker !== "c" && actionMarker !== "x") return null;
  const action = actionMarker === "c" ? "confirm" : "close";
  const layoutId = parts[3] ?? "";
  const canonicalMessageId = parts[4] ?? "";
  const ownerDiscordUserId = parts[5] ?? "";
  if (!isSafeLayoutPostId(layoutId) || !isSafeLayoutPostId(canonicalMessageId) || !isSafeLayoutPostId(ownerDiscordUserId)) {
    return null;
  }
  const versionToken = parts.length === 7 ? parts[6] ?? "" : undefined;
  if (action === "confirm" && (!versionToken || !isLayoutPostVersionToken(versionToken))) return null;
  if (action === "close" && parts.length !== 6) return null;
  return {
    action,
    layoutId,
    canonicalMessageId,
    ownerDiscordUserId,
    ...(versionToken ? { versionToken } : {}),
  };
}

/** Purpose: route persistent layout IDs while safely ignoring obsolete paginator IDs from the removed legacy command. */
export function isLayoutPostCustomId(customId: string): boolean {
  const normalized = String(customId ?? "");
  if (parseLayoutPostCustomId(normalized) || parseLayoutPostPanelCustomId(normalized)) return true;

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
  return parseLayoutPostCustomId(customId) !== null || parseLayoutPostPanelCustomId(customId) !== null;
}

function normalizeLayoutPostId(value: string, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!isSafeLayoutPostId(normalized)) {
    throw new Error(`Layout panel custom IDs require a safe ${label} ID.`);
  }
  return normalized;
}

function isSafeLayoutPostId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/** Purpose: render one edit-safe presentation of the canonical public layout post. */
export function buildLayoutPostPayload(
  record: LayoutRecord,
  mode: LayoutPostRenderMode = "collapsed",
  imageSource: LayoutPostImageSource = {},
  alertLine?: string,
): LayoutPostPayload {
  const embed = new EmbedBuilder();
  const title = record.title?.trim();
  const imageUrl = resolveImageUrl(record, imageSource);
  const versionToken = mode === "link"
    ? buildLayoutPostVersionToken(record.layoutLink, record.submittedAt)
    : undefined;

  if (title) embed.setTitle(title);
  if (imageUrl) embed.setImage(imageUrl);

  if (mode === "link") {
    embed.setDescription(
      `[Open Layout](<${record.layoutLink}>)\n\nDid the layout open successfully in Clash of Clans?`,
    );
  } else if (mode === "info") {
    embed.setDescription(buildLayoutInfoDescription(record, alertLine));
  }

  const hasVisibleEmbedContent = Boolean(title || imageUrl || mode !== "collapsed");
  return {
    embeds: hasVisibleEmbedContent ? [embed] : [],
    components: [buildLayoutPostButtonRow(record.id, mode, versionToken)],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** Purpose: turn a superseded canonical message into a link-only redirect with no active controls. */
export function buildLayoutPostRedirectPayload(jumpUrl: string): LayoutPostPayload {
  return {
    content: `This canonical layout moved to [the new post](${jumpUrl}).`,
    embeds: [],
    components: [],
    attachments: [],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** Purpose: render a private link or metadata panel without rebuilding the canonical public embed. */
export function buildLayoutPostPanelPayload(
  record: LayoutRecord,
  mode: "link" | "info",
  ownerDiscordUserId: string,
  canonicalMessageId: string,
  alertLine?: string,
): LayoutPostPayload {
  const embed = new EmbedBuilder();
  const title = record.title?.trim();
  if (title) embed.setTitle(title);
  if (mode === "link") {
    embed.setDescription(
      `[Open Layout](<${record.layoutLink}>)\n\nDid the layout open successfully in Clash of Clans?`,
    );
  } else {
    embed.setDescription(buildLayoutInfoDescription(record, alertLine));
  }

  const versionToken = mode === "link"
    ? buildLayoutPostVersionToken(record.layoutLink, record.submittedAt)
    : undefined;
  const buttons = mode === "link"
    ? [
        new ButtonBuilder()
          .setCustomId(buildLayoutPostPanelCustomId(
            "confirm",
            record.id,
            canonicalMessageId,
            ownerDiscordUserId,
            versionToken,
          ))
          .setLabel("Yes, It Opened")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildLayoutPostPanelCustomId(
            "close",
            record.id,
            canonicalMessageId,
            ownerDiscordUserId,
          ))
          .setLabel("Close")
          .setStyle(ButtonStyle.Secondary),
      ]
    : [
        new ButtonBuilder()
          .setCustomId(buildLayoutPostPanelCustomId(
            "close",
            record.id,
            canonicalMessageId,
            ownerDiscordUserId,
          ))
          .setLabel("Close")
          .setStyle(ButtonStyle.Secondary),
      ];

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
    ephemeral: true,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** Purpose: close or acknowledge a private panel without touching the canonical message. */
export function buildLayoutPostPanelClosedPayload(
  content: string,
  ephemeral = true,
): LayoutPostPayload {
  return {
    content,
    embeds: [],
    components: [],
    ...(ephemeral ? { ephemeral: true } : {}),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/** Purpose: acknowledge a confirmation privately and keep all public layout presentation static. */
export function buildLayoutPostConfirmationPayload(
  _record?: LayoutRecord,
  ephemeral = true,
): LayoutPostPayload {
  return buildLayoutPostPanelClosedPayload(
    "Thanks — this layout was marked as confirmed.",
    ephemeral,
  );
}

/** Purpose: handle obsolete public link-view controls without editing the canonical message. */
async function replyLegacyPanelControl(interaction: ButtonInteraction): Promise<void> {
  await interaction.reply(
    buildLayoutPostPanelClosedPayload(
      "This older layout control is no longer active. Use Layout Link to open a private panel.",
    ),
  );
}

/** Purpose: build the public Info description without exposing the layout URL. */
export function buildLayoutInfoDescription(record: LayoutRecord, alertLine?: string): string {
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
  if (alertLine) lines.push(alertLine);

  return lines.join("\n\n") || "No additional layout information is available.";
}

/** Purpose: format persisted lifecycle timestamps using Discord's relative timestamp rendering. */
export function formatRelativeDiscordTimestamp(value: Date): string {
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

/** Purpose: coordinate scoped layout interactions while keeping the canonical post immutable. */
export class LayoutPostService {
  private readonly layoutService: Pick<
    LayoutService,
    "findById" | "confirmSuccessfulOpening"
  >;
  private readonly alertConfigService?: Pick<LayoutAlertConfigService, "getPolicy">;
  private readonly botLogChannelService?: Pick<BotLogChannelService, "getChannelIdForType">;

  constructor(options: LayoutPostServiceOptions = {}) {
    this.layoutService = options.layoutService ?? layoutService;
    this.alertConfigService = options.alertConfigService;
    this.botLogChannelService = options.botLogChannelService;
  }

  /** Purpose: handle one persistent or user-owned panel action without editing the canonical post. */
  async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const panel = parseLayoutPostPanelCustomId(interaction.customId);
    if (panel) {
      await this.handlePanelInteraction(interaction, panel);
      return;
    }

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

      if (parsed.action === "confirm") {
        const currentVersionToken = buildLayoutPostVersionToken(record.layoutLink, record.submittedAt);
        if (!parsed.versionToken) {
          this.logConfirmationRejection(interaction, record.id, "legacy_control");
          await replyLayoutPostError(
            interaction,
            "This confirmation control is from an older layout link and can no longer confirm it.",
          );
          return;
        }
        if (parsed.versionToken !== currentVersionToken) {
          this.logConfirmationRejection(interaction, record.id, "stale_link_version");
          await replyLayoutPostError(
            interaction,
            "This confirmation belongs to an older layout link and was not applied.",
          );
          return;
        }
      }

      if (parsed.action === "info") {
        const alertPolicy = this.alertConfigService
          ? await this.alertConfigService.getPolicy(record.id)
          : null;
        const defaultChannelId =
          alertPolicy &&
          (alertPolicy.mode === LayoutAlertMode.DEFAULT_CHANNEL ||
            alertPolicy.mode === LayoutAlertMode.BOTH) &&
          this.botLogChannelService &&
          record.discordGuildId
            ? await this.botLogChannelService.getChannelIdForType(
                record.discordGuildId,
                "layout-alerts",
              )
            : null;
        await interaction.reply(
          buildLayoutPostPanelPayload(
            record,
            "info",
            interaction.user.id,
            record.discordMessageId ?? "",
            formatLayoutAlertPolicyLine(alertPolicy, defaultChannelId) ?? undefined,
          ),
        );
        return;
      }

      if (parsed.action === "link") {
        await interaction.reply(
          buildLayoutPostPanelPayload(
            record,
            "link",
            interaction.user.id,
            record.discordMessageId ?? "",
          ),
        );
        return;
      }

      if (parsed.action === "close") {
        await replyLegacyPanelControl(interaction);
        return;
      }

      const confirmedRecord = await this.layoutService.confirmSuccessfulOpening({
        id: record.id,
        discordUserId: interaction.user.id,
        expectedLayoutLink: record.layoutLink,
        expectedSubmittedAt: record.submittedAt,
      });
      await interaction.reply(buildLayoutPostConfirmationPayload(confirmedRecord));
      dozzleLog.info(
        `[layout-post] event=confirmation_succeeded layout_id=${record.id} guild_id=${interaction.guildId} channel_id=${interaction.channelId} canonical_message_id=${interaction.message.id} user_id=${interaction.user.id} source=legacy_public_control`,
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

  /** Purpose: retain compatibility for callers that used to cancel public presentation timers. */
  clearAutoCollapse(messageId: string): void {
    void messageId;
  }

  private async handlePanelInteraction(
    interaction: ButtonInteraction,
    panel: ParsedLayoutPostPanelCustomId,
  ): Promise<void> {
    try {
      const record = await this.layoutService.findById(panel.layoutId);
      if (!record || !this.matchesPanelScope(interaction, record, panel)) {
        this.logPanelRejection(interaction, panel, "scope_mismatch");
        await replyLayoutPostError(interaction, "This private layout panel is no longer valid.");
        return;
      }

      if (panel.action === "close") {
        await interaction.update(buildLayoutPostPanelClosedPayload("Layout panel closed.", false));
        return;
      }

      const currentVersionToken = buildLayoutPostVersionToken(record.layoutLink, record.submittedAt);
      if (!panel.versionToken || panel.versionToken !== currentVersionToken) {
        this.logPanelRejection(interaction, panel, "stale_link_version");
        await replyLayoutPostError(
          interaction,
          "This confirmation belongs to an older layout link and was not applied.",
        );
        return;
      }

      const confirmedRecord = await this.layoutService.confirmSuccessfulOpening({
        id: record.id,
        discordUserId: interaction.user.id,
        expectedLayoutLink: record.layoutLink,
        expectedSubmittedAt: record.submittedAt,
      });
      await interaction.update(buildLayoutPostConfirmationPayload(confirmedRecord, false));
      dozzleLog.info(
        `[layout-post] event=confirmation_succeeded layout_id=${record.id} guild_id=${interaction.guildId} channel_id=${interaction.channelId} canonical_message_id=${record.discordMessageId} panel_message_id=${interaction.message.id} user_id=${interaction.user.id} source=ephemeral_panel`,
      );
    } catch (error) {
      dozzleLog.error(
        `[layout-post] event=panel_interaction_failed layout_id=${panel.layoutId} action=${panel.action} guild_id=${interaction.guildId ?? "DM"} channel_id=${interaction.channelId ?? "unknown"} panel_message_id=${interaction.message.id} error=${formatError(error)}`,
      );
      await replyLayoutPostError(
        interaction,
        "Failed to update this private layout panel. Please try again shortly.",
      );
    }
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

  /** Purpose: validate private panel ownership and its canonical provenance boundary. */
  private matchesPanelScope(
    interaction: ButtonInteraction,
    record: LayoutRecord,
    panel: ParsedLayoutPostPanelCustomId,
  ): boolean {
    return Boolean(
      interaction.guildId &&
        interaction.channelId &&
        interaction.user.id === panel.ownerDiscordUserId &&
        record.id === panel.layoutId &&
        record.discordGuildId === interaction.guildId &&
        record.discordChannelId === interaction.channelId &&
        record.discordMessageId === panel.canonicalMessageId,
    );
  }

  /** Purpose: log rejected forged, stale, or moved layout buttons without logging the raw layout link. */
  private logScopeMismatch(interaction: ButtonInteraction, layoutId: string): void {
    dozzleLog.warn(
      `[layout-post] event=scope_rejected layout_id=${layoutId} interaction_guild_id=${interaction.guildId ?? "DM"} interaction_channel_id=${interaction.channelId ?? "unknown"} interaction_message_id=${interaction.message.id}`,
    );
  }

  /** Purpose: make stale and legacy confirmation rejection observable without logging the layout URL. */
  private logConfirmationRejection(
    interaction: ButtonInteraction,
    layoutId: string,
    reason: "legacy_control" | "stale_link_version",
  ): void {
    dozzleLog.warn(
      `[layout-post] event=confirmation_rejected layout_id=${layoutId} reason=${reason} interaction_guild_id=${interaction.guildId ?? "DM"} interaction_channel_id=${interaction.channelId ?? "unknown"} interaction_message_id=${interaction.message.id} user_id=${interaction.user.id}`,
    );
  }

  /** Purpose: make forged or cross-user private panel actions diagnosable without logging layout URLs. */
  private logPanelRejection(
    interaction: ButtonInteraction,
    panel: ParsedLayoutPostPanelCustomId,
    reason: "scope_mismatch" | "stale_link_version",
  ): void {
    dozzleLog.warn(
      `[layout-post] event=panel_action_rejected layout_id=${panel.layoutId} action=${panel.action} reason=${reason} guild_id=${interaction.guildId ?? "DM"} channel_id=${interaction.channelId ?? "unknown"} panel_message_id=${interaction.message.id} canonical_message_id=${panel.canonicalMessageId} owner_user_id=${panel.ownerDiscordUserId} user_id=${interaction.user.id}`,
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

/** Purpose: build the button row for one canonical layout post presentation. */
function buildLayoutPostButtonRow(
  layoutId: string,
  mode: LayoutPostRenderMode,
  versionToken?: string,
): ActionRowBuilder<ButtonBuilder> {
  const buttons = mode === "collapsed"
    ? [
        new ButtonBuilder()
          .setCustomId(buildLayoutPostCustomId("link", layoutId))
          .setLabel("Layout Link")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(buildLayoutPostCustomId("info", layoutId))
          .setLabel("Info")
          .setStyle(ButtonStyle.Secondary),
      ]
    : mode === "link"
      ? [
          new ButtonBuilder()
            .setCustomId(buildLayoutPostCustomId("confirm", layoutId, versionToken))
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
            .setCustomId(buildLayoutPostCustomId("close", layoutId))
            .setLabel("Close")
            .setStyle(ButtonStyle.Secondary),
        ];

  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** Purpose: keep the action union centralized for custom-ID construction and parsing. */
function isLayoutPostButtonAction(value: string): value is LayoutPostButtonAction {
  return value === "link" || value === "confirm" || value === "close" || value === "info";
}

/** Purpose: validate the bounded hash token carried by a version-aware confirmation custom ID. */
function isLayoutPostVersionToken(value: string): boolean {
  return new RegExp(`^[a-f0-9]{${LAYOUT_POST_VERSION_TOKEN_LENGTH}}$`).test(value);
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

/** Purpose: recover only image metadata needed to rebuild a presentation without copying stale embeds. */
export function resolveLayoutPostImageSource(
  message: LayoutPostImageMessageLike,
): LayoutPostImageSourceResolution {
  const attachment = message.attachments?.first?.();
  if (attachment?.name?.trim() || attachment?.url?.trim()) {
    return {
      source: {
        attachmentName: attachment.name ?? null,
        attachmentUrl: attachment.url ?? null,
      },
      kind: "attachment_collection",
    };
  }

  const embeddedImageUrl = message.embeds?.find((embed) => embed?.image?.url)?.image?.url?.trim();
  if (!embeddedImageUrl) {
    return {
      source: { attachmentName: null, attachmentUrl: null },
      kind: message.embeds?.some((embed) => embed?.image) ? "metadata_unavailable" : "none",
    };
  }

  if (embeddedImageUrl.toLowerCase().startsWith("attachment://")) {
    const attachmentName = decodeAttachmentName(embeddedImageUrl.slice("attachment://".length));
    if (attachmentName) {
      return {
        source: { attachmentName, attachmentUrl: null },
        kind: "embedded_attachment",
      };
    }
    return {
      source: { attachmentName: null, attachmentUrl: null },
      kind: "metadata_unavailable",
    };
  }

  if (/^https?:\/\//i.test(embeddedImageUrl)) {
    return {
      // This is presentation-only metadata. It is never persisted as LayoutRecord.imageUrl.
      source: { attachmentName: null, attachmentUrl: embeddedImageUrl },
      kind: "embedded_url",
    };
  }

  return {
    source: { attachmentName: null, attachmentUrl: null },
    kind: "metadata_unavailable",
  };
}

function decodeAttachmentName(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    return decodeURIComponent(normalized) || null;
  } catch {
    return normalized;
  }
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

export const layoutPostService = new LayoutPostService({
  alertConfigService: layoutAlertConfigService,
  botLogChannelService,
});
