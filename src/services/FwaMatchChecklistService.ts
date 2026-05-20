import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  type ButtonInteraction,
} from "discord.js";
import { truncateDiscordContent } from "../helper/discordContent";
import { formatError } from "../helper/formatError";
import { normalizeClanTag } from "./PlayerLinkService";
import {
  buildFwaMatchChecklistContent,
  buildFwaMatchChecklistRowContextKey,
  trackedMessageService,
  type FwaMatchChecklistTrackedRow,
} from "./TrackedMessageService";
import {
  buildFwaMatchChecklistRefreshCustomId,
  isFwaMatchChecklistRefreshButtonCustomId,
} from "../commands/fwa/customIds";

const FWA_MATCH_CHECKLIST_CHECKED_EMOJI = "✅";
const FWA_MATCH_CHECKLIST_UNCHECKED_EMOJI = "☐";

/** Purpose: build one mobile-friendly compact copy row for the FWA mail checklist. */
export function buildFwaMatchChecklistRowsFromCopyView(params: {
  orderedTags: string[];
  copyText: string;
  badgeByTag: Map<string, string | null>;
  contextKeyByTag?: Map<string, string | null>;
}): FwaMatchChecklistTrackedRow[] {
  const lines = String(params.copyText ?? "")
    .split(/\r?\n/)
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  return params.orderedTags.flatMap((tag, index) => {
    const compactCopyLine = stripFwaMatchChecklistColumn(lines[index] ?? "");
    const normalizedTag = normalizeChecklistClanTag(tag);
    if (!compactCopyLine) return [];
    const badgeEmojiInline = params.badgeByTag.get(normalizedTag)?.trim() ?? "";
    return [
      {
        clanTag: normalizedTag,
        compactCopyLine,
        badgeEmojiId: badgeEmojiInline
          ? extractEmojiId(badgeEmojiInline)
          : null,
        badgeEmojiName: badgeEmojiInline
          ? extractEmojiName(badgeEmojiInline)
          : null,
        badgeEmojiInline: badgeEmojiInline ?? "",
        contextKey: params.contextKeyByTag?.get(normalizedTag) ?? null,
      },
    ];
  });
}

/** Purpose: build a stable identity fragment for a checklist row when a live match/sync context exists. */
export function buildFwaMatchChecklistContextKeyByTag(
  views: Record<
    string,
    {
      liveRevisionFields?: {
        warId?: string | number | null;
        opponentTag?: string | null;
      } | null;
    }
  >,
): Map<string, string | null> {
  const contextKeyByTag = new Map<string, string | null>();
  for (const [tag, view] of Object.entries(views)) {
    contextKeyByTag.set(
      normalizeChecklistClanTag(tag),
      buildFwaMatchChecklistRowContextKey({
        clanTag: tag,
        warId: view.liveRevisionFields?.warId ?? null,
        opponentTag: view.liveRevisionFields?.opponentTag ?? null,
      }),
    );
  }
  return contextKeyByTag;
}

/** Purpose: compute a checklist expiry timestamp with the current command default. */
export function buildFwaMatchChecklistExpiresAt(
  nowMs: number = Date.now(),
): Date {
  return new Date(nowMs + 30 * 60 * 1000);
}

/** Purpose: materialize checklist-tracked message input for persistence. */
export function buildFwaMatchChecklistTrackedMessageInput(params: {
  guildId: string;
  channelId: string;
  messageId: string;
  clanTag: string | null;
  createdByUserId: string;
  rows: FwaMatchChecklistTrackedRow[];
  scopeKey?: string | null;
  checkedClanTags?: Iterable<string>;
  createdAtIso?: string;
}): Parameters<typeof trackedMessageService.createFwaMatchChecklistTrackedMessage>[0] {
  const createdAtIso = params.createdAtIso ?? new Date().toISOString();
  return {
    guildId: params.guildId,
    channelId: params.channelId,
    messageId: params.messageId,
    clanTag: params.clanTag,
    expiresAt: buildFwaMatchChecklistExpiresAt(),
    metadata: {
      createdByUserId: params.createdByUserId,
      createdAtIso,
      scopeKey: params.scopeKey ?? null,
      checkedClanTags: params.checkedClanTags ? [...params.checkedClanTags] : [],
      rows: params.rows.map((row) => ({ ...row })),
    },
  };
}

/** Purpose: build the visible checklist post content. */
export function buildFwaMatchChecklistMessageContent(input: {
  rows: Iterable<FwaMatchChecklistTrackedRow>;
  checkedClanTags: Iterable<string>;
}): string {
  const checklistContent = buildFwaMatchChecklistContent(input);
  return [
    "# Clan Mail Checklist",
    "",
    "React with your clan's badge to indicate that the in-game mails have been sent.",
    "",
    checklistContent,
  ].join("\n");
}

/** Purpose: build checklist components for the public post. */
export function buildFwaMatchChecklistComponents(): Array<
  ActionRowBuilder<ButtonBuilder>
> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildFwaMatchChecklistRefreshCustomId())
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** Purpose: add clan badge reactions for a published checklist message. */
async function addFwaMatchChecklistReactions(
  message: { id: string; react: (emoji: string) => Promise<unknown> },
  rows: FwaMatchChecklistTrackedRow[],
): Promise<void> {
  for (const row of rows) {
    if (!row.badgeEmojiInline) continue;
    try {
      await message.react(row.badgeEmojiInline);
    } catch (err) {
      console.error(
        `[fwa match checklist] react failed message=${message.id} clan=${row.clanTag} emoji=${row.badgeEmojiInline} error=${formatError(err)}`,
      );
    }
  }
}

function summarizePinIssue(err: unknown): string {
  const code = (err as { code?: number } | null | undefined)?.code;
  if (code === 50013 || code === 50001) {
    return "Checklist pin failed due to missing bot permissions in this channel.";
  }
  if (code) {
    return `Checklist pin failed (Discord code: ${code}). Check bot permissions and logs.`;
  }
  return "Checklist pin failed. Check bot permissions and logs.";
}

/** Purpose: publish or preview the clan mail checklist using the current tracked-message state. */
export async function postFwaMatchChecklistMessage(params: {
  interaction: ChatInputCommandInteraction;
  isPublic: boolean;
  rows: FwaMatchChecklistTrackedRow[];
  clanTag: string | null;
  scopeKey: string | null;
  checkedClanTags: Iterable<string>;
}): Promise<void> {
  const content = buildFwaMatchChecklistMessageContent({
    rows: params.rows,
    checkedClanTags: params.checkedClanTags,
  });
  await params.interaction.editReply({
    content: truncateDiscordContent(content),
    embeds: [],
    components: params.isPublic ? buildFwaMatchChecklistComponents() : [],
  });
  if (!params.isPublic) return;

  const postedMessage = await params.interaction.fetchReply();
  await trackedMessageService.createFwaMatchChecklistTrackedMessage(
    buildFwaMatchChecklistTrackedMessageInput({
      guildId: params.interaction.guildId ?? "",
      channelId: params.interaction.channelId,
      messageId: postedMessage.id,
      clanTag: params.clanTag,
      createdByUserId: params.interaction.user.id,
      rows: params.rows,
      scopeKey: params.scopeKey,
      checkedClanTags: params.checkedClanTags,
    }),
  );
  await addFwaMatchChecklistReactions(postedMessage as any, params.rows);
  try {
    await postedMessage.pin();
  } catch (err) {
    console.error(
      `[fwa match checklist] pin failed message=${postedMessage.id} channel=${params.interaction.channelId} guild=${params.interaction.guildId ?? ""} error=${formatError(err)}`,
    );
    await params.interaction
      .followUp({
        ephemeral: true,
        content: summarizePinIssue(err),
      })
      .catch(() => undefined);
  }
}

/** Purpose: refresh a public checklist message in place without touching reactions. */
export async function handleFwaMatchChecklistRefreshButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isFwaMatchChecklistRefreshButtonCustomId(interaction.customId)) return;
  await interaction.deferUpdate();
  const refreshed = await trackedMessageService
    .refreshFwaMatchChecklistMessage(interaction.message as any)
    .catch((err) => {
      console.error(
        `[fwa match checklist] refresh failed message=${interaction.message.id} error=${formatError(err)}`,
      );
      return false;
    });
  if (!refreshed) {
    await interaction
      .followUp({
        ephemeral: true,
        content: "This checklist post can no longer be refreshed.",
      })
      .catch(() => undefined);
  }
}

/** Purpose: expose checklist reaction logic for regression tests. */
export const addFwaMatchChecklistReactionsForTest = addFwaMatchChecklistReactions;

function extractEmojiId(emoji: string): string | null {
  const match = /^<a?:[A-Za-z0-9_]{2,32}:(\d{1,22})>$/.exec(emoji);
  return match ? match[1] ?? null : null;
}

function extractEmojiName(emoji: string): string | null {
  const match = /^<a?:([A-Za-z0-9_]{2,32}):\d{1,22}>$/.exec(emoji);
  return match ? match[1] ?? null : null;
}

function stripFwaMatchChecklistColumn(line: string): string {
  const normalized = String(line ?? "").trim();
  if (!normalized) return normalized;
  const firstSeparator = normalized.indexOf(" | ");
  if (firstSeparator < 0) return normalized;
  const secondSeparator = normalized.indexOf(" | ", firstSeparator + 3);
  if (secondSeparator < 0) return normalized;
  const thirdSeparator = normalized.indexOf(" | ", secondSeparator + 3);
  if (thirdSeparator < 0) return normalized;
  const checklistValue = normalized.slice(secondSeparator + 3, thirdSeparator).trim();
  if (checklistValue !== FWA_MATCH_CHECKLIST_CHECKED_EMOJI && checklistValue !== FWA_MATCH_CHECKLIST_UNCHECKED_EMOJI) {
    return normalized;
  }
  return `${normalized.slice(0, secondSeparator + 3)}${normalized.slice(thirdSeparator + 3)}`;
}

function normalizeTagBare(tag: string): string {
  return String(tag ?? "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
}

function normalizeChecklistClanTag(tag: string): string {
  const normalized = normalizeClanTag(tag);
  return normalized || normalizeTagBare(tag);
}
