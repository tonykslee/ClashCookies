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

/** Purpose: map resolver failure code to the most accurate user-facing /emoji error response. */
function buildEmojiFailureMessage(code: EmojiResolverFailureCode): string {
  if (code === "application_missing" || code === "application_emoji_manager_unavailable") {
    return "Could not load bot application emojis in this runtime. Please contact an admin.";
  }
  return "Could not fetch bot application emojis right now. Please try again later.";
}

/** Purpose: emit concise structured diagnostics for one /emoji resolver run. */
function logEmojiFetchResult(input: {
  interaction: ChatInputCommandInteraction;
  result: EmojiInventoryFetchResult;
}): void {
  const { diagnostics } = input.result;
  const fields = [
    "command=emoji",
    `guild_id=${input.interaction.guildId ?? "dm"}`,
    `user_id=${input.interaction.user.id}`,
    `application_present_pre_fetch=${diagnostics.applicationExistedBeforeFetch}`,
    `application_fetch_attempted=${diagnostics.applicationFetchAttempted}`,
    `application_emoji_fetch_available=${diagnostics.applicationEmojiFetchAvailable}`,
    `emoji_fetch_succeeded=${diagnostics.emojiFetchSucceeded}`,
    `fetched_emoji_count=${diagnostics.fetchedEmojiCount}`,
    `failure_code=${input.result.ok ? "none" : input.result.code}`,
  ];
  const message = `[emoji] fetch ${fields.join(" ")}`;
  if (input.result.ok) {
    console.log(message);
    return;
  }
  console.warn(message);
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

export const Emoji: Command = {
  name: "emoji",
  description: "Resolve and browse bot application emojis",
  options: [
    {
      name: "name",
      description: "Emoji name or shortcode (for example: arrow_arrow or :arrow_arrow:)",
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
    const requestedName = normalizeEmojiLookupName(rawName ?? "");

    try {
      const inventory = await activeEmojiResolver.fetchApplicationEmojiInventory(
        interaction.client,
        { forceRefresh: true },
      );
      logEmojiFetchResult({ interaction, result: inventory });
      if (!inventory.ok) {
        await interaction.editReply({
          content: buildEmojiFailureMessage(inventory.code),
          embeds: [],
          components: [],
        });
        return;
      }

      const { snapshot } = inventory;
      const emojis = snapshot.entries;
      if (requestedName) {
        const resolved =
          snapshot.exactByName.get(requestedName) ??
          snapshot.lowercaseByName.get(requestedName.toLowerCase()) ??
          null;
        if (resolved) {
          await interaction.editReply({
            embeds: [buildEmojiResolveEmbed(resolved)],
          });
          return;
        }

        const suggestions = buildEmojiNameSuggestions(requestedName, emojis);
        const suggestionText = suggestions.length
          ? `\nDid you mean: ${suggestions.join(", ")}`
          : "";
        await interaction.editReply({
          content: `No application emoji found for \`:${requestedName}:\`.${suggestionText}`,
          embeds: [],
          components: [],
        });
        return;
      }

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
    } catch (error) {
      console.error(`[emoji] command failed: ${formatError(error)}`);
      await interaction.editReply({
        content:
          "Could not load bot application emojis right now. Please try again later.",
        embeds: [],
        components: [],
      });
    }
  },
};
