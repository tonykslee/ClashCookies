import { normalizeFwaTag } from "./normalize";

/** Purpose: choose a bounded wrap-around chunk from an ordered clan list using a persistent cursor. */
export function selectDistributedSweepChunk(
  orderedTags: readonly string[],
  cursorTag: string | null,
  chunkSize: number,
): string[] {
  const tags = orderedTags.map((tag) => normalizeFwaTag(tag)).filter(Boolean);
  if (tags.length === 0) return [];
  const boundedChunkSize = Math.max(1, Math.trunc(chunkSize));
  const normalizedCursor = cursorTag ? normalizeFwaTag(cursorTag) : null;
  const startIndex =
    normalizedCursor && tags.includes(normalizedCursor)
      ? (tags.indexOf(normalizedCursor) + 1) % tags.length
      : 0;
  const selected: string[] = [];
  for (let i = 0; i < Math.min(boundedChunkSize, tags.length); i += 1) {
    selected.push(tags[(startIndex + i) % tags.length]);
  }
  return selected;
}
