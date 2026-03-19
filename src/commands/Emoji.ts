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
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import {
  emojiResolverService,
  normalizeEmojiLookupName,
  type EmojiInventoryFetchResult,
  type EmojiResolverFailureCode,
  type EmojiResolverService,
  type ResolvedApplicationEmoji,
} from "../services/emoji/EmojiResolverService";
import { CoCService } from "../services/CoCService";

type EmojiResolverPort = Pick<
  EmojiResolverService,
  "fetchApplicationEmojiInventory"
>;

const EMOJI_PAGE_SIZE = 20;
const EMOJI_PAGINATOR_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MESSAGE_ID_PATTERN = /^\d{17,22}$/;

let activeEmojiResolver: EmojiResolverPort = emojiResolverService;

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
  mode: "list" | "resolve" | "react" | "autocomplete";
  guildId: string | null;
  channelId: string | null;
  userId: string;
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

export const applyEmojiPageActionForTest = applyEmojiPageAction;
export const paginateEmojiLinesForTest = paginateEmojiLines;
export const buildEmojiListEmbedForTest = buildEmojiListEmbed;
export const buildEmojiListRowForTest = buildEmojiListRow;
export const normalizeEmojiLookupNameInputForTest = normalizeEmojiLookupName;
export const buildEmojiAutocompleteChoicesForTest = buildEmojiAutocompleteChoices;
export const isValidMessageIdForTest = isValidMessageId;

export const Emoji: Command = {
  name: "emoji",
  description: "Resolve and browse bot application emojis",
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
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const rawName = interaction.options.getString("name", false);
    const rawReact = interaction.options.getString("react", false);
    const hasNameInput = rawName !== null;
    const requestedName = String(rawName ?? "");
    const normalizedName = normalizeEmojiLookupName(requestedName);
    const targetMessageId = String(rawReact ?? "").trim();

    const mode: "list" | "resolve" | "react" = !hasNameInput
      ? "list"
      : targetMessageId
        ? "react"
        : "resolve";

    if (hasNameInput && !normalizedName) {
      logEmojiEvent({
        command: "emoji",
        mode,
        guild_id: interaction.guildId ?? "dm",
        channel_id: interaction.channelId ?? "none",
        user_id: interaction.user.id,
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
      const inventory = await activeEmojiResolver.fetchApplicationEmojiInventory(
        interaction.client,
        { forceRefresh: true },
      );
      logEmojiInventoryResult({
        mode,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
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
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "inventory_unavailable",
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
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          target_message_id: targetMessageId,
          resolve_result: "not_found",
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
        logEmojiEvent({
          command: "emoji",
          mode,
          guild_id: interaction.guildId ?? "dm",
          channel_id: interaction.channelId ?? "none",
          user_id: interaction.user.id,
          requested_emoji_name: requestedName,
          normalized_emoji_name: normalizedName,
          resolve_result: "found",
          failure_code: "none",
        });
        await interaction.editReply({
          embeds: [buildEmojiResolveEmbed(resolved)],
          components: [],
        });
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
