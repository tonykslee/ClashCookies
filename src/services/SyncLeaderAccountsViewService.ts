import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { normalizeClanTag } from "./PlayerLinkService";
import type {
  ClanLeadershipLookupAccount,
  ClanLeadershipLookupResult,
} from "./ClanLeadershipLookupService";
import type { SyncTimeTrackedMetadata } from "./TrackedMessageService";

export const SYNC_LEADER_ACCOUNTS_BUTTON_PREFIX = "sync-leaders";
export const SYNC_LEADER_ACCOUNTS_BUTTON_LABEL = "My Leader Accounts";

const SYNC_LEADER_ACCOUNTS_BUTTON_VERSION = "v1";
const SYNC_LEADER_ACCOUNTS_PAGE_LIMIT = 3900;
const FALLBACK_CLAN_BADGE = "🏷️";

/** Purpose: create the bounded custom ID shared by public and manual sync-status buttons. */
export function buildSyncLeaderAccountsButtonCustomId(
  trackedMessageId: string,
  page = 0,
): string {
  return `${SYNC_LEADER_ACCOUNTS_BUTTON_PREFIX}:${SYNC_LEADER_ACCOUNTS_BUTTON_VERSION}:${String(trackedMessageId ?? "").trim()}:${Math.max(0, Math.trunc(page))}`;
}

/** Purpose: build the persistent public button used by every Sync Spin Status renderer. */
export function buildSyncLeaderAccountsButton(trackedMessageId: string): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildSyncLeaderAccountsButtonCustomId(trackedMessageId))
    .setLabel(SYNC_LEADER_ACCOUNTS_BUTTON_LABEL)
    .setStyle(ButtonStyle.Secondary);
}

/** Purpose: place the shared public button in a Discord action row. */
export function buildSyncLeaderAccountsButtonComponents(
  trackedMessageId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buildSyncLeaderAccountsButton(trackedMessageId))];
}

/** Purpose: parse only this feature's versioned, bounded button references. */
export function parseSyncLeaderAccountsButtonCustomId(
  customId: string,
): { trackedMessageId: string; page: number } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 4) return null;
  if (parts[0] !== SYNC_LEADER_ACCOUNTS_BUTTON_PREFIX || parts[1] !== SYNC_LEADER_ACCOUNTS_BUTTON_VERSION) {
    return null;
  }
  const trackedMessageId = parts[2]?.trim() ?? "";
  const page = Number(parts[3]);
  if (!/^\d{17,22}$/.test(trackedMessageId)) return null;
  if (!Number.isSafeInteger(page) || page < 0 || page > 999) return null;
  return { trackedMessageId, page };
}

/** Purpose: identify button interactions owned by this persistent sync-status feature. */
export function isSyncLeaderAccountsButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${SYNC_LEADER_ACCOUNTS_BUTTON_PREFIX}:`);
}

/** Purpose: escape persisted player-controlled names without allowing Markdown or mentions. */
export function escapeSyncLeaderAccountName(input: string): string {
  return [...String(input ?? "")]
    .map((character) => {
      if (/[[\]\\`*_{}()#+\-.!|>~<@]/.test(character)) return `\\${character}`;
      if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) return "�";
      return character;
    })
    .join("");
}

/** Purpose: create the normalized lookup key used to isolate one clan/user pair. */
function accountPairKey(clanTag: string, discordUserId: string): string {
  return `${normalizeClanTag(clanTag)}:${discordUserId}`;
}

/** Purpose: keep Leaders ahead of Co-Leaders with deterministic name ordering. */
function compareLeadershipAccounts(left: ClanLeadershipLookupAccount, right: ClanLeadershipLookupAccount): number {
  return (
    (left.role === right.role ? 0 : left.role === "leader" ? -1 : 1) ||
    left.playerName.localeCompare(right.playerName) ||
    left.playerTag.localeCompare(right.playerTag)
  );
}

/** Purpose: preserve announcement order while removing duplicate clan tags safely. */
function uniqueSyncClans(metadata: SyncTimeTrackedMetadata): SyncTimeTrackedMetadata["clans"] {
  const seen = new Set<string>();
  return metadata.clans.filter((clan) => {
    const key = normalizeClanTag(clan.clanTag);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Purpose: render one viewer-specific line per sync clan in metadata order. */
export function buildSyncLeaderAccountsLines(input: {
  metadata: SyncTimeTrackedMetadata;
  lookup: ClanLeadershipLookupResult;
  discordUserId: string;
}): string[] {
  const entries = new Map(
    input.lookup.entries.map((entry) => [accountPairKey(entry.clanTag, entry.discordUserId), entry]),
  );

  return uniqueSyncClans(input.metadata).map((clan) => {
    const entry = entries.get(accountPairKey(clan.clanTag, input.discordUserId));
    const badge = clan.emojiInline.trim() || FALLBACK_CLAN_BADGE;
    const abbreviation = escapeSyncLeaderAccountName(clan.code.trim() || "?");
    let accountText = "(Roster unavailable)";
    if (entry?.rosterAvailable) {
      const accounts = [...entry.accounts].sort(compareLeadershipAccounts);
      accountText = accounts.length === 0
        ? "(—)"
        : `(${accounts
            .map((account) => `${account.role === "leader" ? "👑 " : ""}${escapeSyncLeaderAccountName(account.playerName)}`)
            .join(", ")})`;
    }
    return `${badge} **${abbreviation}** ${accountText}`;
  });
}

/** Purpose: paginate complete clan lines without silently dropping a clan or account. */
export function buildSyncLeaderAccountsPages(input: {
  metadata: SyncTimeTrackedMetadata;
  lookup: ClanLeadershipLookupResult;
  discordUserId: string;
}): string[] {
  const lines = buildSyncLeaderAccountsLines(input);
  const pages: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const candidate = [...current, line].join("\n");
    if (current.length > 0 && candidate.length > SYNC_LEADER_ACCOUNTS_PAGE_LIMIT) {
      pages.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) pages.push(current.join("\n"));
  return pages.length > 0 ? pages : ["🏷️ **?** (Roster unavailable)"];
}

/** Purpose: build restart-safe ephemeral pagination controls from the tracked-message reference. */
export function buildSyncLeaderAccountsPaginationComponents(input: {
  trackedMessageId: string;
  page: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  if (input.totalPages <= 1) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildSyncLeaderAccountsButtonCustomId(input.trackedMessageId, input.page - 1))
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(input.page <= 0),
      new ButtonBuilder()
        .setCustomId(buildSyncLeaderAccountsButtonCustomId(input.trackedMessageId, input.page + 1))
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(input.page >= input.totalPages - 1),
    ),
  ];
}

/** Purpose: build the private response while keeping mention parsing disabled. */
export function buildSyncLeaderAccountsEmbed(description: string): EmbedBuilder {
  return new EmbedBuilder().setTitle("My Leader Accounts").setDescription(description);
}
