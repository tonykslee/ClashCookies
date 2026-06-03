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
import { CoCService } from "./CoCService";
import {
  buildFwaMatchChecklistContent,
  buildFwaMatchChecklistRowContextKey,
  trackedMessageService,
  resolveFwaMatchChecklistViewType,
  type FwaMatchChecklistTrackedRow,
} from "./TrackedMessageService";
import {
  buildFwaMatchChecklistRefreshCustomId,
  isFwaMatchChecklistRefreshButtonCustomId,
} from "./fwaCustomIds";
import {
  buildFwaMatchChecklistRenderStateForGuild,
} from "./FwaMatchChecklistStateService";

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
  const normalizedBadgeByTag = normalizeFwaMatchChecklistBadgeByTag(
    params.badgeByTag,
  );
  return params.orderedTags.flatMap((tag, index) => {
    const compactCopyLine = stripFwaMatchChecklistColumn(lines[index] ?? "");
    const normalizedTag = normalizeChecklistClanTag(tag);
    if (!compactCopyLine) return [];
    const badgeEmojiInline = normalizedBadgeByTag.get(normalizedTag)?.trim() ?? "";
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
  referenceId?: string | null;
  expiresAt?: Date | null;
  createdAtIso?: string;
}): Parameters<typeof trackedMessageService.createFwaMatchChecklistTrackedMessage>[0] {
  const createdAtIso = params.createdAtIso ?? new Date().toISOString();
  return {
    guildId: params.guildId,
    channelId: params.channelId,
    messageId: params.messageId,
    clanTag: params.clanTag,
    referenceId: params.referenceId ?? null,
    expiresAt: params.expiresAt ?? buildFwaMatchChecklistExpiresAt(),
    metadata: {
      kind: "mail_checklist",
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

/** Purpose: build the read-only bases checklist content. */
export function buildFwaMatchBasesMessageContent(input: {
  rows: Iterable<FwaMatchChecklistTrackedRow>;
}): string {
  const lines: string[] = ["# Clan Bases Checklist", ""];
  for (const row of input.rows) {
    lines.push(row.compactCopyLine);
  }
  return lines.join("\n").trimEnd();
}

/** Purpose: build checklist components for the public post. */
export function buildFwaMatchChecklistComponents(params?: {
  state?: "refresh" | "refreshing" | "expired";
  viewType?: "Mail" | "Bases";
}): Array<
  ActionRowBuilder<ButtonBuilder>
> {
  const state = params?.state ?? "refresh";
  const refreshing = state === "refreshing";
  const expired = state === "expired";
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildFwaMatchChecklistRefreshCustomId())
        .setLabel(refreshing ? "Refreshing..." : expired ? "Expired" : "Refresh")
        .setDisabled(refreshing || expired)
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

type FwaMatchChecklistPublicationInput = {
  guildId: string;
  channelId: string;
  message: {
    id: string;
    react: (emoji: string) => Promise<unknown>;
    pin: () => Promise<unknown>;
  };
  rows: FwaMatchChecklistTrackedRow[];
  clanTag: string | null;
  scopeKey: string | null;
  checkedClanTags: Iterable<string>;
  createdByUserId: string;
  referenceId?: string | null;
  expiresAt?: Date | null;
  viewType?: "Mail" | "Bases";
  onPinFailure?: (err: unknown) => void | Promise<void>;
};

/** Purpose: finalize a public checklist publication after the message has been created. */
export async function finalizeFwaMatchChecklistPublication(
  params: FwaMatchChecklistPublicationInput,
): Promise<void> {
  if ((params.viewType ?? "Mail") === "Bases") {
    await trackedMessageService.createFwaMatchChecklistTrackedMessage({
      guildId: params.guildId,
      channelId: params.channelId,
      messageId: params.message.id,
      clanTag: params.clanTag,
      referenceId: params.referenceId ?? null,
      expiresAt: params.expiresAt ?? buildFwaMatchChecklistExpiresAt(),
      metadata: {
        kind: "bases_checklist",
        createdByUserId: params.createdByUserId,
        createdAtIso: new Date().toISOString(),
        scopeKey: params.scopeKey ?? null,
        checkedClanTags: [],
        rows: params.rows.map((row) => ({ ...row })),
        guildId: params.guildId,
        channelId: params.channelId,
        messageId: params.message.id,
        clanTag: params.clanTag,
      } as any,
    });
  } else {
    await trackedMessageService.createFwaMatchChecklistTrackedMessage(
      buildFwaMatchChecklistTrackedMessageInput({
        guildId: params.guildId,
        channelId: params.channelId,
        messageId: params.message.id,
        clanTag: params.clanTag,
        createdByUserId: params.createdByUserId,
        rows: params.rows,
        scopeKey: params.scopeKey,
        checkedClanTags: params.checkedClanTags,
        referenceId: params.referenceId ?? null,
        expiresAt: params.expiresAt ?? null,
      }),
    );
  }
  await addFwaMatchChecklistReactions(params.message, params.rows);
  try {
    await params.message.pin();
  } catch (err) {
    console.error(
      `[fwa match checklist] pin failed message=${params.message.id} channel=${params.channelId} guild=${params.guildId} error=${formatError(err)}`,
    );
    await params.onPinFailure?.(err);
    return;
  }

  if ((params.viewType ?? "Mail") === "Bases") {
    const resolveMessageForCleanup = async ({
      channelId,
      messageId,
    }: {
      channelId: string;
      messageId: string;
    }) => {
      const messageAny = params.message as any;
      const channel = messageAny?.channel;
      if (channel && String(channel.id ?? "").trim() === String(channelId ?? "").trim()) {
        return channel.messages?.fetch?.(messageId).catch(() => null) ?? null;
      }
      const client = messageAny?.client;
      if (!client?.channels?.fetch) return null;
      const fetchedChannel = await client.channels.fetch(channelId).catch(() => null);
      return fetchedChannel?.messages?.fetch?.(messageId).catch(() => null) ?? null;
    };
    await trackedMessageService.replaceOlderFwaMatchChecklistMessages({
      guildId: params.guildId,
      channelId: params.channelId,
      messageId: params.message.id,
      resolveMessageForCleanup,
    });
  }
}

/** Purpose: publish or preview the clan mail checklist using the current tracked-message state. */
export async function postFwaMatchChecklistMessage(params: {
  interaction: ChatInputCommandInteraction;
  isPublic: boolean;
  viewType?: "Mail" | "Bases";
  rows: FwaMatchChecklistTrackedRow[];
  clanTag: string | null;
  scopeKey: string | null;
  checkedClanTags: Iterable<string>;
  referenceId?: string | null;
  expiresAt?: Date | null;
}): Promise<void> {
  const viewType = params.viewType ?? "Mail";
  const content =
    viewType === "Bases"
      ? buildFwaMatchBasesMessageContent({ rows: params.rows })
      : buildFwaMatchChecklistMessageContent({
          rows: params.rows,
          checkedClanTags: params.checkedClanTags,
        });
  await params.interaction.editReply({
    content: truncateDiscordContent(content),
    embeds: [],
    components: params.isPublic
      ? buildFwaMatchChecklistComponents({ viewType })
      : [],
  });
  if (!params.isPublic) return;

  const postedMessage = await params.interaction.fetchReply();
  await finalizeFwaMatchChecklistPublication({
    guildId: params.interaction.guildId ?? "",
    channelId: params.interaction.channelId,
    message: postedMessage as any,
    clanTag: params.clanTag,
    scopeKey: params.scopeKey,
    checkedClanTags: params.checkedClanTags,
    rows: params.rows,
    createdByUserId: params.interaction.user.id,
    referenceId: params.referenceId ?? null,
    expiresAt: params.expiresAt ?? null,
    viewType,
    onPinFailure: async (err) => {
      await params.interaction
        .followUp({
          ephemeral: true,
          content: summarizePinIssue(err),
        })
        .catch(() => undefined);
    },
  }).catch((err) => {
    console.error(
      `[fwa match checklist] publish failed message=${postedMessage.id} channel=${params.interaction.channelId} guild=${params.interaction.guildId ?? ""} error=${formatError(err)}`,
    );
  });
}

/** Purpose: publish a checklist directly to a channel for scheduled runs. */
export async function publishFwaMatchChecklistMessageToChannel(params: {
  viewType?: "Mail" | "Bases";
  channel: {
    send: (payload: {
      content: string;
      embeds: [];
      components: Array<ActionRowBuilder<ButtonBuilder>>;
    }) => Promise<unknown>;
  };
  guildId: string;
  channelId: string;
  rows: FwaMatchChecklistTrackedRow[];
  clanTag: string | null;
  scopeKey: string | null;
  checkedClanTags: Iterable<string>;
  createdByUserId: string;
  referenceId?: string | null;
  expiresAt?: Date | null;
}): Promise<string | null> {
  const viewType = params.viewType ?? "Mail";
  const content =
    viewType === "Bases"
      ? buildFwaMatchBasesMessageContent({ rows: params.rows })
      : buildFwaMatchChecklistMessageContent({
          rows: params.rows,
          checkedClanTags: params.checkedClanTags,
        });
  const postedMessage = (await params.channel.send({
    content: truncateDiscordContent(content),
    embeds: [],
    components: buildFwaMatchChecklistComponents({ viewType }),
  }).catch((err): any => {
    console.error(
      `[fwa match checklist] send failed guild=${params.guildId} channel=${params.channelId} error=${formatError(err)}`,
    );
    return null;
  })) as { id: string } | null;
  if (!postedMessage) return null;
  await finalizeFwaMatchChecklistPublication({
    guildId: params.guildId,
    channelId: params.channelId,
    message: postedMessage as any,
    clanTag: params.clanTag,
    scopeKey: params.scopeKey,
    checkedClanTags: params.checkedClanTags,
    rows: params.rows,
    createdByUserId: params.createdByUserId,
    referenceId: params.referenceId ?? null,
    expiresAt: params.expiresAt ?? null,
    viewType,
  }).catch((err) => {
    console.error(
      `[fwa match checklist] finalize failed message=${postedMessage.id} channel=${params.channelId} guild=${params.guildId} error=${formatError(err)}`,
    );
    return null;
  });
  return postedMessage.id;
}

/** Purpose: refresh a public checklist message in place without touching reactions. */
export async function handleFwaMatchChecklistRefreshButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isFwaMatchChecklistRefreshButtonCustomId(interaction.customId)) return;
  await interaction.deferUpdate();
  const guildId = interaction.guildId ?? null;
  const trackedBeforeRefresh = guildId
    ? await trackedMessageService
        .getActiveByMessageId(interaction.message.id)
        .catch(() => null)
    : null;
  if (trackedBeforeRefresh?.status !== "ACTIVE") {
    await interaction.message
      .edit({
        components: buildFwaMatchChecklistComponents({ state: "expired" }),
      })
      .catch(() => undefined);
    await interaction
      .followUp({
        ephemeral: true,
        content: "This checklist post can no longer be refreshed.",
      })
      .catch(() => undefined);
    return;
  }
  const disableRefreshButton = async (): Promise<void> => {
    await interaction.message
      .edit({
        components: buildFwaMatchChecklistComponents({ state: "refreshing" }),
      })
      .catch(() => undefined);
  };
  const restoreRefreshButton = async (state: "refresh" | "expired"): Promise<void> => {
    await interaction.message
      .edit({
        components: buildFwaMatchChecklistComponents({ state }),
      })
      .catch(() => undefined);
  };
  const refreshed = await (async () => {
    try {
      if (!guildId) return false;
      await disableRefreshButton();
      const trackedViewType = resolveFwaMatchChecklistViewType(trackedBeforeRefresh.metadata);
      const checklistState = await buildFwaMatchChecklistRenderStateForGuild({
        cocService: new CoCService(),
        guildId,
        warLookupCache: new Map(),
        client: interaction.client,
        viewType: trackedViewType === "Bases" ? "Bases" : "Mail",
        syncMessageId: trackedViewType === "Bases" ? trackedBeforeRefresh.referenceId ?? null : null,
      });
      const updated = await trackedMessageService
        .refreshFwaMatchChecklistMessage(
          interaction.message as any,
          null,
          {
            rows: checklistState.rows,
            scopeKey: checklistState.scopeKey,
            expiresAt: checklistState.expiresAt,
          },
        )
        .catch((err) => {
          console.error(
            `[fwa match checklist] refresh failed message=${interaction.message.id} error=${formatError(err)}`,
          );
          return false;
        });
      return updated;
    } catch (err) {
      console.error(
        `[fwa match checklist] refresh failed message=${interaction.message.id} error=${formatError(err)}`,
      );
      return false;
    }
  })();
  const trackedAfterRefresh = await trackedMessageService
    .getActiveByMessageId(interaction.message.id)
    .catch(() => null);
  if (trackedAfterRefresh?.status === "ACTIVE") {
    await restoreRefreshButton("refresh");
  } else {
    await restoreRefreshButton("expired");
  }
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

function normalizeFwaMatchChecklistBadgeByTag(
  badgeByTag: Map<string, string | null>,
): Map<string, string | null> {
  const normalizedBadgeByTag = new Map<string, string | null>();
  for (const [tag, badgeEmojiInline] of badgeByTag.entries()) {
    const normalizedTag = normalizeChecklistClanTag(tag);
    if (!normalizedTag) continue;
    normalizedBadgeByTag.set(normalizedTag, badgeEmojiInline);
  }
  return normalizedBadgeByTag;
}
