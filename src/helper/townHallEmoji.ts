import { Client } from "discord.js";
import { emojiResolverService } from "../services/emoji/EmojiResolverService";

export type TownHallEmojiMap = Map<number, string>;

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
  return renderedByTownHall;
}

/** Purpose: render one Town Hall icon with safe fallback text when no emoji exists. */
export function renderTownHallIcon(
  townHall: number | null | undefined,
  townHallEmojiByLevel: TownHallEmojiMap,
): string {
  const normalized = Number.isFinite(Number(townHall)) ? Math.trunc(Number(townHall)) : null;
  if (normalized === null || normalized <= 0) return "\u2754";
  return townHallEmojiByLevel.get(normalized) ?? "\u2754";
}
