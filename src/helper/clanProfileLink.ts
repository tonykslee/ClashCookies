import { normalizeClanTag } from "../services/PlayerLinkService";

function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/** Purpose: render one in-game clan profile link with a safe fallback label. */
export function buildClanProfileMarkdownLink(
  clanName: string | null,
  clanTag: string | null,
): string {
  const normalizedClanTag = normalizeClanTag(clanTag ?? "");
  const label = sanitizeDisplayText(clanName) || normalizedClanTag || "Unknown Clan";
  if (!normalizedClanTag) return label;
  const encodedTag = normalizedClanTag.replace(/^#/, "");
  return `[${label}](<https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodedTag}>)`;
}
