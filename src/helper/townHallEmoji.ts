import { Client } from "discord.js";
import { emojiResolverService } from "../services/emoji/EmojiResolverService";

export type TownHallEmojiMap = Map<number, string>;

let cachedTownHallEmojiMap: TownHallEmojiMap = new Map();

/** Purpose: normalize any likely Town Hall field to a positive integer or null. */
export function normalizeTownHallLevel(input: unknown): number | null {
  const numeric = Number(input);
  if (!Number.isFinite(numeric)) return null;
  const normalized = Math.trunc(numeric);
  return normalized > 0 ? normalized : null;
}

/** Purpose: load rendered Town Hall application emojis once for display-only command rendering. */
export async function resolveTownHallEmojiMap(client: Client): Promise<TownHallEmojiMap> {
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
  cachedTownHallEmojiMap = new Map(renderedByTownHall);
  return renderedByTownHall;
}

/** Purpose: read the last cached Town Hall emoji map without triggering any live fetch. */
export function getCachedTownHallEmojiMap(): TownHallEmojiMap {
  return new Map(cachedTownHallEmojiMap);
}

/** Purpose: render one Town Hall icon with safe fallback text when no emoji exists. */
export function renderTownHallIcon(
  townHall: number | null | undefined,
  townHallEmojiByLevel: TownHallEmojiMap,
): string {
  const normalized = normalizeTownHallLevel(townHall);
  if (normalized === null) return "\u2754";
  return townHallEmojiByLevel.get(normalized) ?? "\u2754";
}
