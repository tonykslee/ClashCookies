import type { ButtonInteraction } from "discord.js";
import { lookupClanLeadershipForPairs } from "./ClanLeadershipLookupService";
import {
  parseSyncTimeMetadata,
  trackedMessageService,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
} from "./TrackedMessageService";
import {
  buildSyncLeaderAccountsEmbed,
  buildSyncLeaderAccountsPaginationComponents,
  buildSyncLeaderAccountsPages,
  dedupeSyncLeaderAccountClans,
  parseSyncLeaderAccountsButtonCustomId,
  SYNC_LEADER_ACCOUNTS_FALLBACK_CLAN_BADGE,
} from "./SyncLeaderAccountsViewService";

export { isSyncLeaderAccountsButtonCustomId } from "./SyncLeaderAccountsViewService";

/** Purpose: emit bounded flow diagnostics without exposing account details or response content. */
function logSyncLeaderAccounts(event: "STARTED" | "SUCCESS" | "FAILURE" | "INVALID_CONTEXT", fields: string): void {
  const method = event === "FAILURE" ? console.error : console.info;
  method(`[sync-leader-accounts] event=${event} ${fields}`.trim());
}

/** Purpose: reduce thrown failures to a bounded non-sensitive diagnostic category. */
function failureCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
  return "unknown_error";
}

/** Purpose: recognize a finite future expiry for tracked source validation. */
function hasFutureExpiry(value: unknown, nowMs: number): boolean {
  const expiresAt = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > nowMs;
}

/** Purpose: resolve and render one user's current persisted leader accounts from a persistent button. */
export async function handleSyncLeaderAccountsButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const startedAt = Date.now();
  const parsed = parseSyncLeaderAccountsButtonCustomId(interaction.customId);
  logSyncLeaderAccounts("STARTED", `page=${parsed?.page ?? "invalid"}`);

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (error) {
    logSyncLeaderAccounts("FAILURE", `reason=defer_failed duration_ms=${Date.now() - startedAt} error=${failureCode(error)}`);
    return;
  }

  /** Purpose: fail closed for stale, forged, expired, or mismatched references. */
  const invalid = async (reason: string): Promise<void> => {
    logSyncLeaderAccounts("INVALID_CONTEXT", `reason=${reason} duration_ms=${Date.now() - startedAt}`);
    await interaction.editReply({
      content: "This sync status button is no longer available.",
      allowedMentions: { parse: [] },
    }).catch(() => undefined);
  };

  if (!parsed) return invalid("custom_id");
  if (!interaction.guildId || !interaction.guild || interaction.guild.id !== interaction.guildId) {
    return invalid("guild_missing");
  }

  let tracked: Awaited<ReturnType<typeof trackedMessageService.fetchSyncTrackedMessageWithClaims>>;
  try {
    tracked = await trackedMessageService.fetchSyncTrackedMessageWithClaims(parsed.trackedMessageId);
  } catch (error) {
    logSyncLeaderAccounts("FAILURE", `reason=tracked_message_read_failed duration_ms=${Date.now() - startedAt} error=${failureCode(error)}`);
    await interaction.editReply({
      content: "Could not load your leader accounts right now.",
      allowedMentions: { parse: [] },
    }).catch(() => undefined);
    return;
  }

  if (!tracked || tracked.guildId !== interaction.guildId) return invalid("guild_mismatch");
  if (tracked.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return invalid("tracked_message_inactive");
  if (tracked.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST) return invalid("feature_mismatch");
  if (!hasFutureExpiry(tracked.expiresAt, Date.now())) return invalid("expired");

  if (tracked.referenceId) {
    let sourceSync;
    try {
      sourceSync = await trackedMessageService.fetchSyncTrackedMessageWithClaims(tracked.referenceId);
    } catch (error) {
      logSyncLeaderAccounts("FAILURE", `reason=source_sync_read_failed duration_ms=${Date.now() - startedAt} error=${failureCode(error)}`);
      await interaction.editReply({
        content: "Could not load your leader accounts right now.",
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
      return;
    }
    if (!sourceSync || sourceSync.guildId !== tracked.guildId) return invalid("source_sync_guild_mismatch");
    if (sourceSync.referenceId) return invalid("source_sync_not_root");
    if (sourceSync.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return invalid("source_sync_inactive");
    if (sourceSync.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST) {
      return invalid("source_sync_feature_mismatch");
    }
    if (!hasFutureExpiry(sourceSync.expiresAt, Date.now())) return invalid("source_sync_expired");
  }

  const metadata = parseSyncTimeMetadata(tracked.metadata, {
    fallbackEmojiInline: SYNC_LEADER_ACCOUNTS_FALLBACK_CLAN_BADGE,
  });
  if (!metadata) return invalid("metadata_invalid");
  const clans = dedupeSyncLeaderAccountClans(metadata);
  if (clans.length === 0) return invalid("clans_missing");

  try {
    const lookup = await lookupClanLeadershipForPairs(
      clans.map((clan) => ({ clanTag: clan.clanTag, discordUserId: interaction.user.id })),
    );
    const pages = buildSyncLeaderAccountsPages({ metadata: { ...metadata, clans }, lookup, discordUserId: interaction.user.id });
    if (parsed.page >= pages.length) return invalid("page_out_of_range");
    const matchedAccountCount = lookup.entries.reduce((count, entry) => count + entry.accounts.length, 0);
    await interaction.editReply({
      embeds: [buildSyncLeaderAccountsEmbed(pages[parsed.page] ?? pages[0])],
      components: buildSyncLeaderAccountsPaginationComponents({
        trackedMessageId: parsed.trackedMessageId,
        page: parsed.page,
        totalPages: pages.length,
      }),
      allowedMentions: { parse: [] },
    });
    logSyncLeaderAccounts("SUCCESS", `clan_count=${clans.length} matched_account_count=${matchedAccountCount} page=${parsed.page} total_pages=${pages.length} duration_ms=${Date.now() - startedAt}`);
  } catch (error) {
    logSyncLeaderAccounts("FAILURE", `reason=lookup_or_render_failed duration_ms=${Date.now() - startedAt} error=${failureCode(error)}`);
    await interaction.editReply({
      content: "Could not load your leader accounts right now.",
      allowedMentions: { parse: [] },
    }).catch(() => undefined);
  }
}
