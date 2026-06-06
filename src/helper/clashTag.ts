const CLASH_TAG_BODY_REGEX = /^[PYLQGRJCUV0289]{4,15}$/;

/** Purpose: canonicalize raw Clash tag input by trimming, uppercasing, and folding O into 0. */
export function normalizeClashTagInput(input: string | null | undefined): string {
  const raw = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/O/g, "0");
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

/** Purpose: canonicalize raw Clash tag input to bare form without a leading hash. */
export function normalizeClashTagBareInput(input: string | null | undefined): string {
  return normalizeClashTagInput(input).replace(/^#/, "");
}

/** Purpose: validate and format a Clash player/clan tag in canonical #TAG form. */
export function normalizeClashTagWithHash(input: string | null | undefined): string {
  const normalized = normalizeClashTagInput(input);
  if (!normalized) return "";
  const bare = normalized.replace(/^#/, "");
  return CLASH_TAG_BODY_REGEX.test(bare) ? normalized : "";
}

/** Purpose: validate and format a Clash player/clan tag in canonical bare TAG form. */
export function normalizeClashTagBare(input: string | null | undefined): string {
  const normalized = normalizeClashTagBareInput(input);
  return CLASH_TAG_BODY_REGEX.test(normalized) ? normalized : "";
}
