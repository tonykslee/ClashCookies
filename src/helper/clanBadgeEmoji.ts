/** Purpose: normalize one tracked-clan badge emoji for display-only rendering. */
export function formatClanBadgeEmoji(input: string | null | undefined): string | null {
  const normalized = String(input ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}
