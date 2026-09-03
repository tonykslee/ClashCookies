const TIEBREAK_ORDER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Purpose: derive low/high sync mode from an absolute sync number. */
export function getSyncMode(syncNumber: number | null): "low" | "high" | null {
  if (syncNumber === null) return null;
  return syncNumber % 2 === 0 ? "high" : "low";
}

/** Purpose: rank tag characters using FWA sync tiebreak ordering. */
function rankChar(ch: string): number {
  const idx = TIEBREAK_ORDER.indexOf(ch);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

/** Purpose: compare clan tags using deterministic FWA tiebreak ordering. */
export function compareTagsForTiebreak(primaryTag: string, opponentTag: string): number {
  const normalizeTag = (input: string): string => input.trim().toUpperCase().replace(/^#/, "");
  const a = normalizeTag(primaryTag);
  const b = normalizeTag(opponentTag);
  const maxLen = Math.max(a.length, b.length);

  for (let i = 0; i < maxLen; i += 1) {
    const ra = rankChar(a[i] ?? "");
    const rb = rankChar(b[i] ?? "");
    if (ra === rb) continue;
    return ra - rb;
  }

  return 0;
}
