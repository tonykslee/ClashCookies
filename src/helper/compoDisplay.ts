const ACTUAL_SUFFIX = "-actual";

/**
 * Normalize sheet naming suffixes for user-facing /compo output only.
 * This intentionally strips only one trailing "-actual" suffix.
 */
export function normalizeCompoClanDisplayName(value: string): string {
  const trimmedRight = value.trimEnd();
  if (!trimmedRight.endsWith(ACTUAL_SUFFIX)) {
    return trimmedRight;
  }

  return trimmedRight.slice(0, -ACTUAL_SUFFIX.length).trimEnd();
}
