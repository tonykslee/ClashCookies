import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import axios from "axios";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import {
  emojiResolverService,
  isValidEmojiShortcodeName,
  normalizeEmojiLookupName,
  normalizeEmojiShortcodeName,
  parseEmojiImageSource,
  type EmojiInputSourceType,
  type EmojiInventoryFetchResult,
  type EmojiResolverFailureCode,
  type EmojiResolverService,
  type ResolvedApplicationEmoji,
} from "../services/emoji/EmojiResolverService";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService } from "../services/CommandPermissionService";

type EmojiResolverPort = Pick<
  EmojiResolverService,
  "fetchApplicationEmojiInventory" | "refresh" | "invalidateCache"
>;

type CommandPermissionPort = Pick<CommandPermissionService, "canUseAnyTarget">;

type EmojiAttachmentDownloadResult =
  | { ok: true; attachment: Buffer }
  | {
      ok: false;
      code: "invalid_emoji_input" | "image_download_failed";
      statusCode?: number;
    };

const EMOJI_PAGE_SIZE = 20;
const EMOJI_PAGINATOR_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MESSAGE_ID_PATTERN = /^\d{17,22}$/;
const INVENTORY_FULL_ERROR_CODES = new Set<number>([30008, 30018, 30056]);

let activeEmojiResolver: EmojiResolverPort = emojiResolverService;
let activeCommandPermissionService: CommandPermissionPort =
  new CommandPermissionService();

/** Purpose: convert one resolved emoji into compact list-display text. */
function formatEmojiListLine(emoji: ResolvedApplicationEmoji): string {
  return `${emoji.rendered} \`${emoji.shortcode}\``;
}

/** Purpose: split emoji list output into deterministic page chunks for embed display. */
function paginateEmojiLines(
  emojis: ResolvedApplicationEmoji[],
  pageSize: number = EMOJI_PAGE_SIZE,
): string[] {
  if (emojis.length === 0) return [];
  const pages: string[] = [];
  for (let i = 0; i < emojis.length; i += pageSize) {
    const slice = emojis.slice(i, i + pageSize);
    pages.push(slice.map(formatEmojiListLine).join("\n"));
  }
  return pages;
}

/** Purpose: apply previous/next pagination input while keeping page index bounded. */
function applyEmojiPageAction(params: {
  action: "prev" | "next";
  page: number;
  totalPages: number;
}): number {
  if (params.totalPages <= 0) return 0;
  if (params.action === "prev") return Math.max(0, params.page - 1);
  return Math.min(params.totalPages - 1, params.page + 1);
}

/** Purpose: build paginated list embed for current bot application emoji inventory. */
function buildEmojiListEmbed(params: {
  emojis: ResolvedApplicationEmoji[];
  pages: string[];
  page: number;
}): EmbedBuilder {
  if (params.emojis.length === 0) {
    return new EmbedBuilder()
      .setTitle("Bot Application Emojis")
      .setDescription("No application emojis are currently available for this bot.")
      .setFooter({ text: "Total 0 emojis" })
      .setColor(0x5865f2);
  }
  return new EmbedBuilder()
    .setTitle("Bot Application Emojis")
    .setDescription(params.pages[params.page] ?? "")
    .setFooter({
      text: `Page ${params.page + 1}/${params.pages.length} | Total ${params.emojis.length} emojis`,
    })
    .setColor(0x5865f2);
}

/** Purpose: build prev/next paginator buttons with proper boundary and timeout disabled states. */
function buildEmojiListRow(params: {
  prefix: string;
  page: number;
  totalPages: number;
  forceDisabled?: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const disabled = Boolean(params.forceDisabled);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${params.prefix}:prev`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || params.page <= 0),
    new ButtonBuilder()
      .setCustomId(`${params.prefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || params.page >= params.totalPages - 1),
  );
}

/** Purpose: build resolve-mode embed for one shortcode-to-rendered-emoji mapping. */
function buildEmojiResolveEmbed(emoji: ResolvedApplicationEmoji): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Emoji Resolved")
    .setDescription(`${emoji.rendered}  ${emoji.shortcode}`)
    .addFields({ name: "Raw token", value: `\`${emoji.rendered}\`` })
    .setColor(0x57f287);
}

/** Purpose: derive lightweight same-command suggestions for close emoji-name misses. */
function buildEmojiNameSuggestions(
  input: string,
  emojis: ResolvedApplicationEmoji[],
): string[] {
  const query = input.toLowerCase();
  if (!query) return [];
  return emojis
    .filter((emoji) => emoji.name.toLowerCase().includes(query))
    .slice(0, 5)
    .map((emoji) => emoji.shortcode);
}

/** Purpose: cap text safely for Discord autocomplete option labels. */
function truncateAutocompleteLabel(value: string): string {
  const text = String(value ?? "");
  if (text.length <= 100) return text;
  return `${text.slice(0, 97)}...`;
}

/** Purpose: build deterministic emoji autocomplete options with exact/prefix/contains ranking. */
function buildEmojiAutocompleteChoices(
  emojis: ResolvedApplicationEmoji[],
  focusedValue: string,
): Array<{ name: string; value: string }> {
  const queryRaw = normalizeEmojiLookupName(focusedValue);
  const queryLower = queryRaw.toLowerCase();
  const deduped = new Map<string, ResolvedApplicationEmoji>();
  for (const emoji of emojis) {
    const key = emoji.name.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, emoji);
    }
  }

  const ranked = [...deduped.values()]
    .map((emoji) => {
      const nameLower = emoji.name.toLowerCase();
      let rank = 3;
      if (!queryLower) {
        rank = 3;
      } else if (nameLower === queryLower) {
        rank = 0;
      } else if (nameLower.startsWith(queryLower)) {
        rank = 1;
      } else if (nameLower.includes(queryLower)) {
        rank = 2;
      } else {
        return null;
      }
      return { emoji, rank, nameLower };
    })
    .filter((entry): entry is { emoji: ResolvedApplicationEmoji; rank: number; nameLower: string } =>
      entry !== null,
    )
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const byLower = a.nameLower.localeCompare(b.nameLower);
      if (byLower !== 0) return byLower;
      return a.emoji.name.localeCompare(b.emoji.name);
    })
    .slice(0, MAX_AUTOCOMPLETE_CHOICES);

  return ranked.map(({ emoji }) => ({
    name: truncateAutocompleteLabel(`${emoji.rendered} ${emoji.shortcode}`),
    value: emoji.name,
  }));
}

/** Purpose: classify whether a string is a plausible Discord message snowflake id. */
function isValidMessageId(value: string): boolean {
  return MESSAGE_ID_PATTERN.test(String(value ?? "").trim());
}

/** Purpose: classify a Discord/HTTP error payload as application emoji inventory-full for clear user feedback. */
function isApplicationEmojiInventoryFullError(error: unknown): boolean {
  const code = getDiscordErrorCode(error);
  if (code !== null && INVENTORY_FULL_ERROR_CODES.has(code)) return true;
  const message = String((error as { message?: string } | null)?.message ?? "").toLowerCase();
  return (
    message.includes("maximum number of emojis") ||
    message.includes("maximum number of application emojis") ||
    message.includes("emoji slots")
  );
}

/** Purpose: fetch one image attachment buffer from a parsed input source before emoji create calls. */
async function downloadEmojiAttachment(
  sourceUrl: string,
): Promise<EmojiAttachmentDownloadResult> {
  let response;
  try {
    response = await axios.get(sourceUrl, {
      responseType: "arraybuffer",
      timeout: 15_000,
      validateStatus: () => true,
    });
  } catch {
    return {
      ok: false,
      code: "image_download_failed",
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      code: "image_download_failed",
      statusCode: response.status,
    };
  }

  const contentType = String(response.headers?.["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    return {
      ok: false,
      code: "invalid_emoji_input",
      statusCode: response.status,
    };
  }

  const bytes = Buffer.isBuffer(response.data)
    ? response.data
    : Buffer.from(response.data ?? "");
  if (bytes.length === 0) {
    return {
      ok: false,
      code: "invalid_emoji_input",
      statusCode: response.status,
    };
  }

  return {
    ok: true,
    attachment: bytes,
  };
}

/** Purpose: read the shared command visibility value injected by framework registration plumbing. */
function resolveInteractionVisibility(
  interaction: ChatInputCommandInteraction,
): "private" | "public" {
  const visibility = interaction.options.getString("visibility", false);
  return visibility === "private" ? "private" : "public";
}

/** Purpose: map resolver failure code to the most accurate user-facing /emoji error response. */
function buildEmojiFailureMessage(code: EmojiResolverFailureCode): string {
  if (code === "application_missing" || code === "application_emoji_manager_unavailable") {
    return "Could not load application emojis right now.";
  }
  return "Could not fetch application emojis right now. Please try again later.";
}

/** Purpose: emit concise structured diagnostics for /emoji execution and autocomplete paths. */
function logEmojiEvent(fields: Record<string, string | number | boolean | null | undefined>): void {
  const serialized = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value ?? "")}`)
    .join(" ");
  const failureCode = String(fields.failure_code ?? "").trim();
  if (failureCode && failureCode !== "none") {
    console.warn(`[emoji] ${serialized}`);
    return;
  }
  console.log(`[emoji] ${serialized}`);
}

/** Purpose: emit structured resolver diagnostics tied to command mode and caller identity. */
function logEmojiInventoryResult(input: {
  mode: "list" | "resolve" | "react" | "autocomplete" | "add";
  guildId: string | null;
  channelId: string | null;
  userId: string;
  visibilityState?: "private" | "public";
  requestedName?: string;
  normalizedName?: string;
  focusedText?: string;
  targetMessageId?: string;
  result: EmojiInventoryFetchResult;
}): void {
  const diagnostics = input.result.diagnostics;
  logEmojiEvent({
    command: "emoji",
    mode: input.mode,
    guild_id: input.guildId ?? "dm",
    channel_id: input.channelId ?? "none",
    user_id: input.userId,
    visibility_state: input.visibilityState ?? "",
    requested_emoji_name: input.requestedName ?? "",
    normalized_emoji_name: input.normalizedName ?? "",
    focused_text: input.focusedText ?? "",
    target_message_id: input.targetMessageId ?? "",
    application_present_pre_fetch: diagnostics.applicationExistedBeforeFetch,
    application_fetch_attempted: diagnostics.applicationFetchAttempted,
    application_emoji_fetch_available: diagnostics.applicationEmojiFetchAvailable,
    emoji_fetch_succeeded: diagnostics.emojiFetchSucceeded,
    fetched_emoji_count: diagnostics.fetchedEmojiCount,
    failure_code: input.result.ok ? "none" : input.result.code,
  });
}

/** Purpose: provide a tiny guard for Discord API-style numeric error code extraction. */
function getDiscordErrorCode(error: unknown): number | null {
  const code = (error as { code?: number } | null | undefined)?.code;
  return typeof code === "number" ? code : null;
}

/** Purpose: allow tests to inject a resolver and assert command behavior deterministically. */
export function setEmojiResolverForTest(resolver: EmojiResolverPort): void {
  activeEmojiResolver = resolver;
}

/** Purpose: restore production resolver after test injection. */
export function resetEmojiResolverForTest(): void {
  activeEmojiResolver = emojiResolverService;
}

/** Purpose: allow tests to inject command-permission behavior for add-path authorization checks. */
export function setEmojiCommandPermissionServiceForTest(
  service: CommandPermissionPort,
): void {
  activeCommandPermissionService = service;
}

/** Purpose: restore production command-permission service after test injection. */
export function resetEmojiCommandPermissionServiceForTest(): void {
  activeCommandPermissionService = new CommandPermissionService();
}

export const applyEmojiPageActionForTest = applyEmojiPageAction;
export const paginateEmojiLinesForTest = paginateEmojiLines;
export const buildEmojiListEmbedForTest = buildEmojiListEmbed;
export const buildEmojiListRowForTest = buildEmojiListRow;
export const normalizeEmojiLookupNameInputForTest = normalizeEmojiLookupName;
export const buildEmojiAutocompleteChoicesForTest = buildEmojiAutocompleteChoices;
export const isValidMessageIdForTest = isValidMessageId;
export const normalizeEmojiShortcodeNameForTest = normalizeEmojiShortcodeName;
export const downloadEmojiAttachmentForTest = downloadEmojiAttachment;

export const Emoji: Command = {
  name: "emoji",
  description: "Resolve, browse, react with, and add bot application emojis",
  options: [
    {
      name: "name",
      description: "Application emoji name or shortcode",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
    {
      name: "react",
      description: "Message ID to react to with the named emoji",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "emoji",
      description: "Custom emoji token or direct image URL for add flow",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "short-code",
      description: "Shortcode name for a new bot application emoji",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const rawName = interaction.options.getString("name", false);
    const rawReact = interaction.options.getString("react", false);
    const rawEmojiInput = interaction.options.getString("emoji", false);
    const rawShortCode = interaction.options.getString("short-code", false);
    const hasNameInput = rawName !== null;
    const hasEmojiInput = rawEmojiInput !== null;
    const hasShortCodeInput = rawShortCode !== null;
    const hasAddInputs = hasEmojiInput || hasShortCodeInput;
    const requestedName = String(rawName ?? "");
    const normalizedName = normalizeEmojiLookupName(requestedName);
    const targetMessageId = String(rawReact ?? "").trim();
    const requestedEmojiInput = String(rawEmojiInput ?? "").trim();
    const requestedShortCode = String(rawShortCode ?? "");
    const normalizedShortCode = normalizeEmojiShortcodeName(requestedShortCode);
    const visibilityState = resolveInteractionVisibility(interaction);

    const mode: "list" | "resolve" | "react" | "add" = hasAddInputs
      ? "add"
      : !hasNameInput
        ? "list"
        : targetMessageId
          ? "react"
          : "resolve";

    if (hasAddInputs && (!hasEmojiInput || !hasShortCodeInput)) {
      logEmojiEvent({
        command: "emoji",
        mode,
        guild_id: interaction.guildId ?? "dm",
        channel_id: interaction.channelId ?? "none",
        user_id: interaction.user.id,
        requested_emoji_input: requestedEmojiInput,
        requested_shortcode: requestedShortCode,
        normalized_shortcode: normalizedShortCode,
        create_attempted: false,
        create_result: "validation_failed",
        failure_code: "invalid_emoji_input",
      });
      await interaction.editReply({
        content:
          "To add an application emoji, provide both `emoji` and `short-code`.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (hasAddInputs && (hasNameInput || targetMessageId)) {
      logEmojiEvent({
        command: "emoji",
        mode,
        guild_id: interaction.guildId ?? "dm",
        channel_id: interaction.channelId ?? "none",
        user_id: interaction.user.id,
        requested_emoji_name: requestedName,
        target_message_id: targetMessageId,
        requested_emoji_input: requestedEmojiInput,
        requested_shortcode: requestedShortCode,
        normalized_shortcode: normalizedShortCode,
        create_attempted: false,
        create_result: "validation_failed",
        failure_code: "invalid_emoji_input",
      });
      await interaction.editReply({
        content:
          "Use either add options (`emoji` + `short-code`) or resolve/react options (`name`/`react`), not both.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (mode !== "add" && hasNameInput && !normalizedName) {
      logEmojiEvent({
        command: "emoji",
        mode,
        guild_id: interaction.guildId ?? "dm",
        channel_id: interaction.channelId ?? "none",
        user_id: interaction.user.id,
        visibility_state: visibilityState,
        requested_emoji_name: requestedName,
        normalized_emoji_name: normalizedName,
        target_message_id: targetMessageId,
        resolve_result: "invalid_name",
        failure_code: "invalid_emoji_name",
      });
      await interaction.editReply({
        content: "Please provide a valid emoji name.",
        embeds: [],
        components: [],
      });
      return;
    }

    try {
      if (mode === "add") {
        const allowed = await activeCommandPermissionService.canUseAnyTarget(
          ["emoji:add", "emoji"],
          interaction,
        );
        if (!allowed) {
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: false,
            create_result: "permission_denied",
            failure_code: "permission_denied",
          });
          await interaction.editReply({
            content: "You do not have permission to use /emoji add.",
            embeds: [],
            components: [],
          });
          return;
        }

        if (!normalizedShortCode || !isValidEmojiShortcodeName(normalizedShortCode)) {
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: false,
            create_result: "validation_failed",
            failure_code: "invalid_shortcode",
          });
          await interaction.editReply({
            content:
              "Please provide a valid shortcode using letters, numbers, or underscores (2-32 chars).",
            embeds: [],
            components: [],
          });
          return;
        }

        const parsedSource = parseEmojiImageSource(requestedEmojiInput);
        if (!parsedSource.ok) {
          const failureCode = parsedSource.code;
          const sourceType: EmojiInputSourceType = parsedSource.sourceType;
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            parsed_source_type: sourceType,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: false,
            create_result: "validation_failed",
            failure_code: failureCode,
          });
          await interaction.editReply({
            content:
              failureCode === "unsupported_unicode_emoji"
                ? "Unicode emoji input is not supported for `/emoji add` yet. Use a custom emoji token like `<:name:id>` or a direct image URL."
                : "Invalid emoji input. Use a custom emoji token like `<:name:id>` or a direct image URL.",
            embeds: [],
            components: [],
          });
          return;
        }

        const inventory = await activeEmojiResolver.fetchApplicationEmojiInventory(
          interaction.client,
          { forceRefresh: true },
        );
        logEmojiInventoryResult({
          mode,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          requestedName: requestedShortCode,
          normalizedName: normalizedShortCode,
          result: inventory,
        });
        if (!inventory.ok) {
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            parsed_source_type: parsedSource.sourceType,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: false,
            create_result: "inventory_unavailable",
            failure_code: "emoji_inventory_unavailable",
          });
          await interaction.editReply({
            content: buildEmojiFailureMessage(inventory.code),
            embeds: [],
            components: [],
          });
          return;
        }

        const existingByName =
          inventory.snapshot.exactByName.get(normalizedShortCode) ??
          inventory.snapshot.lowercaseByName.get(normalizedShortCode.toLowerCase()) ??
          null;
        if (existingByName) {
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            parsed_source_type: parsedSource.sourceType,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: false,
            create_result: "duplicate_shortcode",
            failure_code: "duplicate_shortcode",
          });
          await interaction.editReply({
            content: `Shortcode \`${normalizedShortCode}\` already exists as ${existingByName.rendered}.`,
            embeds: [],
            components: [],
          });
          return;
        }

        const download = await downloadEmojiAttachment(parsedSource.imageUrl);
        if (!download.ok) {
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            parsed_source_type: parsedSource.sourceType,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: false,
            create_result: "image_source_failed",
            failure_code: download.code,
          });
          await interaction.editReply({
            content:
              download.code === "image_download_failed"
                ? "Could not download the emoji image from that source."
                : "That source did not resolve to a valid image.",
            embeds: [],
            components: [],
          });
          return;
        }

        const application = interaction.client.application;
        if (!application) {
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            parsed_source_type: parsedSource.sourceType,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: false,
            create_result: "application_unavailable",
            failure_code: "application_unavailable",
          });
          await interaction.editReply({
            content: "Could not load bot application state right now.",
            embeds: [],
            components: [],
          });
          return;
        }

        if (!application.emojis || typeof application.emojis.create !== "function") {
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            parsed_source_type: parsedSource.sourceType,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: false,
            create_result: "application_emoji_manager_unavailable",
            failure_code: "application_emoji_manager_unavailable",
          });
          await interaction.editReply({
            content: "Application emoji manager is unavailable in this runtime.",
            embeds: [],
            components: [],
          });
          return;
        }

        let createdEmoji;
        try {
          createdEmoji = await application.emojis.create({
            attachment: download.attachment,
            name: normalizedShortCode,
          });
        } catch (error) {
          const failureCode = isApplicationEmojiInventoryFullError(error)
            ? "application_emoji_inventory_full"
            : "application_emoji_create_failed";
          logEmojiEvent({
            command: "emoji",
            mode,
            guild_id: interaction.guildId ?? "dm",
            channel_id: interaction.channelId ?? "none",
            user_id: interaction.user.id,
            requested_emoji_input: requestedEmojiInput,
            parsed_source_type: parsedSource.sourceType,
            requested_shortcode: requestedShortCode,
            normalized_shortcode: normalizedShortCode,
            create_attempted: true,
            create_result: "failed",
            failure_code: failureCode,
          });
          await interaction.editReply({
            content:
              failureCode === "application_emoji_inventory_full"
                ? "Could not add emoji because this application emoji inventory is full."
                : "Discord rejected the emoji create request. Verify the image and try again.",
            embeds: [],
            components: [],
          });
          return;
        }

        activeEmojiResolver.invalidateCache();
        try {
          await activeEmojiResolver.refresh(interaction.client);
        } catch (error) {
          console.warn(
            `[emoji] cache refresh failed after add: ${formatError(error)}`,
          );
        }

        const createdRendered = String(createdEmoji.toString?.() ?? "").trim();
        const createdName = String(createdEmoji.name ?? normalizedShortCode).trim();

        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          requested_emoji_input: requestedEmojiInput,
          parsed_source_type: parsedSource.sourceType,
          requested_shortcode: requestedShortCode,
          normalized_shortcode: normalizedShortCode,
          create_attempted: true,
          create_result: "success",
          created_emoji_id: createdEmoji.id,
          created_emoji_name: createdName,
          failure_code: "none",
        });

        await interaction.editReply({
          content: `Added application emoji ${createdRendered} with shortcode \`${createdName}\`.`,
          embeds: [],
          components: [],
        });
        return;
      }

      const inventory = await activeEmojiResolver.fetchApplicationEmojiInventory(
        interaction.client,
        { forceRefresh: true },
      );
      logEmojiInventoryResult({
        mode,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        visibilityState,
        requestedName,
        normalizedName,
        targetMessageId,
        result: inventory,
      });

      if (!inventory.ok) {
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          visibility_state: visibilityState,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "inventory_unavailable",
          result_type: mode === "resolve" ? "emoji_inventory_unavailable" : "",
          failure_code: "emoji_inventory_unavailable",
        });
        await interaction.editReply({
          content: buildEmojiFailureMessage(inventory.code),
          embeds: [],
          components: [],
        });
        return;
      }

      const emojis = inventory.snapshot.entries;
      if (mode === "list") {
        const pages = paginateEmojiLines(emojis);
        let page = 0;
        const paginatorPrefix = `emoji-list:${interaction.id}`;

        await interaction.editReply({
          embeds: [
            buildEmojiListEmbed({
              emojis,
              pages,
              page,
            }),
          ],
          components:
            pages.length > 1
              ? [
                  buildEmojiListRow({
                    prefix: paginatorPrefix,
                    page,
                    totalPages: pages.length,
                  }),
                ]
              : [],
        });

        if (pages.length <= 1) return;

        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: EMOJI_PAGINATOR_TIMEOUT_MS,
        });

        collector.on("collect", async (button: ButtonInteraction) => {
          if (button.user.id !== interaction.user.id) {
            await button.reply({
              ephemeral: true,
              content: "Only the command user can control this paginator.",
            });
            return;
          }
          if (
            button.customId !== `${paginatorPrefix}:prev` &&
            button.customId !== `${paginatorPrefix}:next`
          ) {
            return;
          }
          page = applyEmojiPageAction({
            action: button.customId.endsWith(":prev") ? "prev" : "next",
            page,
            totalPages: pages.length,
          });
          await button.update({
            embeds: [
              buildEmojiListEmbed({
                emojis,
                pages,
                page,
              }),
            ],
            components: [
              buildEmojiListRow({
                prefix: paginatorPrefix,
                page,
                totalPages: pages.length,
              }),
            ],
          });
        });

        collector.on("end", async () => {
          await interaction
            .editReply({
              embeds: [
                buildEmojiListEmbed({
                  emojis,
                  pages,
                  page,
                }),
              ],
              components: [
                buildEmojiListRow({
                  prefix: paginatorPrefix,
                  page,
                  totalPages: pages.length,
                  forceDisabled: true,
                }),
              ],
            })
            .catch(() => undefined);
        });

        return;
      }

      const resolved =
        inventory.snapshot.exactByName.get(normalizedName) ??
        inventory.snapshot.lowercaseByName.get(normalizedName.toLowerCase()) ??
        null;

      if (!resolved) {
        const suggestions = buildEmojiNameSuggestions(normalizedName, emojis);
        const suggestionText = suggestions.length
          ? `\nDid you mean: ${suggestions.join(", ")}`
          : "";
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          visibility_state: visibilityState,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "not_found",
          result_type: mode === "resolve" ? "emoji_not_found" : "",
          failure_code: "emoji_not_found",
        });
        await interaction.editReply({
          content: `Could not find an application emoji named \`${normalizedName}\`.${suggestionText}`,
          embeds: [],
          components: [],
        });
        return;
      }

      if (mode === "resolve") {
        const isVisibleOnly = visibilityState === "public";
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          visibility_state: visibilityState,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          resolve_result: "found",
          result_type: isVisibleOnly ? "success_visible_only" : "success_detailed",
          failure_code: "none",
        });
        if (isVisibleOnly) {
          await interaction.editReply({
            content: resolved.rendered,
            embeds: [],
            components: [],
          });
        } else {
          await interaction.editReply({
            embeds: [buildEmojiResolveEmbed(resolved)],
            components: [],
          });
        }
        return;
      }

      if (!isValidMessageId(targetMessageId)) {
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "found",
          reaction_result: "validation_failed",
          failure_code: "invalid_message_id",
        });
        await interaction.editReply({
          content: "Please provide a valid message ID.",
          embeds: [],
          components: [],
        });
        return;
      }

      const channel = interaction.channel;
      if (
        !channel ||
        !channel.isTextBased() ||
        !("messages" in channel) ||
        !channel.messages ||
        typeof channel.messages.fetch !== "function"
      ) {
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "found",
          reaction_result: "channel_unavailable",
          failure_code: "message_fetch_failed",
        });
        await interaction.editReply({
          content: "Could not find that message in this channel.",
          embeds: [],
          components: [],
        });
        return;
      }

      const appPermissions = interaction.appPermissions;
      if (
        appPermissions &&
        (!appPermissions.has(PermissionFlagsBits.ViewChannel) ||
          !appPermissions.has(PermissionFlagsBits.ReadMessageHistory) ||
          !appPermissions.has(PermissionFlagsBits.AddReactions))
      ) {
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "found",
          reaction_result: "permission_denied",
          failure_code: "react_permission_denied",
        });
        await interaction.editReply({
          content: "I do not have permission to add that reaction.",
          embeds: [],
          components: [],
        });
        return;
      }

      let targetMessage;
      try {
        targetMessage = await channel.messages.fetch(targetMessageId);
      } catch (error) {
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "found",
          reaction_result: "message_fetch_failed",
          failure_code: "message_fetch_failed",
        });
        await interaction.editReply({
          content: `Could not find message \`${targetMessageId}\` in this channel.`,
          embeds: [],
          components: [],
        });
        return;
      }

      try {
        await targetMessage.react(resolved.rendered);
      } catch (error) {
        const code = getDiscordErrorCode(error);
        const failureCode = code === 50013 || code === 50001
          ? "react_permission_denied"
          : "reaction_api_failed";
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "found",
          reaction_result: "failed",
          failure_code: failureCode,
        });
        await interaction.editReply({
          content:
            failureCode === "react_permission_denied"
              ? "I do not have permission to add that reaction."
              : "Discord rejected that reaction. Please try again.",
          embeds: [],
          components: [],
        });
        return;
      }

      logEmojiEvent({
        command: "emoji",
        mode,
        guild_id: interaction.guildId ?? "dm",
        channel_id: interaction.channelId ?? "none",
        user_id: interaction.user.id,
        requested_emoji_name: requestedName,
        normalized_emoji_name: normalizedName,
        target_message_id: targetMessageId,
        resolve_result: "found",
        reaction_result: "success",
        failure_code: "none",
      });
      await interaction.editReply({
        content: `Reacted to message \`${targetMessageId}\` with ${resolved.rendered}.`,
        embeds: [],
        components: [],
      });
    } catch (error) {
      console.error(`[emoji] command failed: ${formatError(error)}`);
      await interaction.editReply({
        content:
          "Could not load application emojis right now. Please try again later.",
        embeds: [],
        components: [],
      });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "name") {
      await interaction.respond([]);
      return;
    }

    const focusedText = String(focused.value ?? "");
    const normalizedName = normalizeEmojiLookupName(focusedText);

    try {
      const inventory = await activeEmojiResolver.fetchApplicationEmojiInventory(
        interaction.client,
      );
      logEmojiInventoryResult({
        mode: "autocomplete",
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        focusedText,
        normalizedName,
        result: inventory,
      });
      if (!inventory.ok) {
        logEmojiEvent({
          command: "emoji",
          mode: "autocomplete",
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          focused_text: focusedText,
          normalized_emoji_name: normalizedName,
          autocomplete_suggestion_count: 0,
          failure_code: "autocomplete_inventory_unavailable",
        });
        await interaction.respond([]);
        return;
      }

      const choices = buildEmojiAutocompleteChoices(
        inventory.snapshot.entries,
        focusedText,
      );
      logEmojiEvent({
        command: "emoji",
        mode: "autocomplete",
        guild_id: interaction.guildId ?? "dm",
        channel_id: interaction.channelId ?? "none",
        user_id: interaction.user.id,
        focused_text: focusedText,
        normalized_emoji_name: normalizedName,
        autocomplete_suggestion_count: choices.length,
        failure_code: "none",
      });
      await interaction.respond(choices);
    } catch (error) {
      console.error(`[emoji] autocomplete failed: ${formatError(error)}`);
      await interaction.respond([]).catch(() => undefined);
    }
  },
};
