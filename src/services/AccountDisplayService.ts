import { Client } from "discord.js";
import { normalizeClashTagInput } from "../helper/clashTag";
import { emojiResolverService } from "./emoji/EmojiResolverService";
import { buildAccountsRows, type AccountRow } from "./AccountRowsService";
import { listTrackedClanRepBadgesForPlayerTags } from "./TrackedClanRepService";

export type AccountDisplayEmojiMap = Map<number, string>;

export type AccountDisplayRow = AccountRow & {
  repBadgeTokens: string[];
};

export async function resolveTownHallEmojiMap(client: Client): Promise<AccountDisplayEmojiMap> {
  const inventory = await emojiResolverService.fetchApplicationEmojiInventory(client).catch(() => null);
  if (!inventory?.ok) return new Map();

  const renderedByTownHall = new Map<number, string>();
  for (let townHall = 1; townHall <= 18; townHall += 1) {
    const shortcode = `th${townHall}`;
    const exact = inventory.snapshot.exactByName.get(shortcode);
    const lower = inventory.snapshot.lowercaseByName.get(shortcode.toLowerCase());
    const rendered = exact?.rendered ?? lower?.rendered ?? null;
    if (rendered) {
      renderedByTownHall.set(townHall, rendered);
    }
  }
  return renderedByTownHall;
}

function normalizeTag(input: string): string {
  return normalizeClashTagInput(input);
}

function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePositiveInteger(input: unknown): number | null {
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatCompactWeightK(weight: number | null | undefined): string {
  const normalized = normalizePositiveInteger(weight);
  if (normalized === null) return "\u2014";
  if (normalized < 1000) return String(normalized);
  return `${Math.trunc(normalized / 1000)}k`;
}

function formatTownHallFallback(townHall: number | null | undefined): string {
  const normalized = normalizePositiveInteger(townHall);
  return normalized === null ? "TH?" : `TH${normalized}`;
}

function renderTownHallIcon(
  townHall: number | null,
  townHallEmojiByLevel: AccountDisplayEmojiMap,
): string {
  const normalized = normalizePositiveInteger(townHall);
  if (normalized === null) return "TH?";
  return townHallEmojiByLevel.get(normalized) ?? formatTownHallFallback(normalized);
}

function buildPlayerProfileMarkdownLink(playerName: string | null, playerTag: string): string {
  const normalizedPlayerTag = normalizeTag(playerTag);
  const label = sanitizeDisplayText(playerName) || normalizedPlayerTag || "Unknown Player";
  if (!normalizedPlayerTag) return label;
  const encodedTag = normalizedPlayerTag.replace(/^#/, "");
  return `[${label}](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=${encodedTag}>)`;
}

/** Purpose: render one account display row exactly as the /accounts command currently formats it. */
export function buildAccountDisplayRowText(
  entry: AccountDisplayRow,
  townHallEmojiByLevel: AccountDisplayEmojiMap,
): string {
  const crown = entry.clanRole ? " :crown:" : "";
  const playerLink = buildPlayerProfileMarkdownLink(entry.name, entry.tag);
  const badgePrefix =
    entry.repBadgeTokens.length > 0 ? `${entry.repBadgeTokens.join(" ")} ` : "";
  return `${badgePrefix}${renderTownHallIcon(entry.townHall, townHallEmojiByLevel)} ${playerLink}${crown} \`${entry.tag}\` - ${formatCompactWeightK(entry.weight)}`;
}

/** Purpose: combine canonical persisted account rows with display-only rep badge tokens. */
export async function buildAccountDisplayRows(input: {
  guildId: string;
  linkedNameByTag: Map<string, string>;
  tags: string[];
}): Promise<AccountDisplayRow[]> {
  const [accountRows, repBadgeTokensByTag] = await Promise.all([
    buildAccountsRows(input),
    listTrackedClanRepBadgesForPlayerTags(input.tags),
  ]);

  return accountRows.map((row) => ({
    ...row,
    repBadgeTokens: repBadgeTokensByTag.get(row.tag) ?? [],
  }));
}
