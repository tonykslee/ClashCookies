/** Purpose: sanitize scraped clan names to avoid noisy/invalid labels in output. */
export function sanitizeClanName(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > 80) return null;
  if (/Clan Tag|Point Balance|Sync #|Winner|War State/i.test(trimmed)) return null;
  return trimmed;
}

/** Purpose: parse Clash API timestamp format (`yyyyMMddTHHmmss.SSSZ`) into epoch ms. */
export function parseCocApiTime(input: string | null | undefined): number | null {
  if (!input) return null;
  const match = input.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/,
  );
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  return Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
  );
}
