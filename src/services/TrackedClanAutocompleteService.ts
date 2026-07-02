import { prisma } from "../prisma";
import { normalizeClashTagBareInput, normalizeClashTagWithHash } from "../helper/clashTag";

export type TrackedClanAutocompleteChoice = {
  name: string;
  value: string;
};

function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAutocompleteNameQuery(input: string): string {
  return sanitizeDisplayText(input)?.toLowerCase() ?? "";
}

function normalizeAutocompleteTagQuery(input: string): string {
  return normalizeClashTagBareInput(input).toLowerCase();
}

/** Purpose: build canonical tracked-clan autocomplete choices without live API calls. */
export async function getTrackedClanAutocompleteChoices(input: {
  focusedText?: string | null;
  limit?: number;
}): Promise<TrackedClanAutocompleteChoice[]> {
  const normalizedQuery = normalizeAutocompleteNameQuery(String(input.focusedText ?? ""));
  const normalizedTagQuery = normalizeAutocompleteTagQuery(String(input.focusedText ?? ""));
  const rawLimit = Math.trunc(Number(input.limit ?? 25));
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(25, rawLimit)) : 25;

  const trackedClans = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { name: true, tag: true },
  });

  return trackedClans
    .map((clan) => {
      const tag = normalizeClashTagWithHash(clan.tag);
      if (!tag) return null;

      const name = sanitizeDisplayText(clan.name);
      const tagBody = tag.replace(/^#/, "").toLowerCase();
      const nameLower = name?.toLowerCase() ?? "";
      const exactTagMatch = normalizedTagQuery.length > 0 && tagBody === normalizedTagQuery;
      const prefixTagMatch =
        normalizedTagQuery.length > 0 && tagBody.startsWith(normalizedTagQuery) && !exactTagMatch;
      const nameMatch =
        normalizedQuery.length > 0 && name !== null && nameLower.includes(normalizedQuery);
      const matchRank =
        normalizedTagQuery.length === 0 && normalizedQuery.length === 0
          ? 3
          : exactTagMatch
            ? 0
            : prefixTagMatch
              ? 1
              : nameMatch
                ? 2
                : 99;
      const label = name ? `${name} (${tag})` : tag;
      return {
        name: label.slice(0, 100),
        value: tag,
        matchRank,
        sortName: nameLower || "\uffff",
        sortTag: tagBody,
      };
    })
    .filter(
      (
        row,
      ): row is {
        name: string;
        value: string;
        matchRank: number;
        sortName: string;
        sortTag: string;
      } => Boolean(row),
    )
    .filter((row) => row.matchRank !== 99)
    .sort((a, b) => {
      if (a.matchRank !== b.matchRank) return a.matchRank - b.matchRank;
      const byName = a.sortName.localeCompare(b.sortName, undefined, { sensitivity: "base" });
      if (byName !== 0) return byName;
      return a.sortTag.localeCompare(b.sortTag, undefined, { sensitivity: "base" });
    })
    .slice(0, limit)
    .map(({ name, value }) => ({ name, value }));
}
