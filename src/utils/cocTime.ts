/** Purpose: parse Clash API timestamps (`yyyyMMddTHHmmss.SSSZ`) into epoch ms. */
export function parseCocApiTime(
  input: string | null | undefined,
): number | null {
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
